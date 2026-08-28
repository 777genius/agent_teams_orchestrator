import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  isOpenCodeLaunchAttemptId,
  isOpenCodeLaunchPayloadHash,
  isOpenCodeOpaqueIdentity,
  type OpenCodeLaunchMemberLinkage,
  type OpenCodeOpaqueIdentity,
} from './OpenCodeBridgeContractV2.js'
import {
  OpenCodeLaunchFileJournalPersistence,
  OpenCodeLaunchJournalError,
  type OpenCodeLaunchStoreContext,
} from './OpenCodeLaunchAttemptStore.js'
import type { OpenCodeSessionRecord } from './types.js'
import {
  assertOpenCodeLogicalMemberIdentity,
  openCodeLogicalMemberKey,
  type OpenCodeLogicalMemberIdentity,
} from './OpenCodeLogicalMemberKey.js'

export type OpenCodeLaunchMemberRecovery = {
  ownershipTitle: string
  sessionRecord: OpenCodeSessionRecord
}

export type OpenCodeLaunchMutationIdentity = {
  attemptId: string
  payloadHash: string
  inputDigest: string
  immutableDigest: string
  generation: number
  fence: number
  acquisitionToken: string
  claimToken: string
  memberIdentity: OpenCodeOpaqueIdentity
  logicalMember: OpenCodeLogicalMemberIdentity
}

export type OpenCodeLaunchMutationClaimRecord = OpenCodeLaunchMutationIdentity & {
  version: 2
  targetDigest: string
  logicalMemberKey: string
  idempotencyIdentity: string
  state: 'claimed' | 'known_failure' | 'unknown' | 'committed'
  /** Present only on a record migrated from the memberIdentity-keyed predecessor format. */
  legacyTargetDigest?: string
  linkage?: OpenCodeLaunchMemberLinkage
  recovery?: OpenCodeLaunchMemberRecovery
}
type ClaimRecord = OpenCodeLaunchMutationClaimRecord

const MAX_CLAIM_BYTES = 8_192
const TOKEN = /^[A-Za-z0-9._:-]{1,256}$/
const DIGEST = /^[a-f0-9]{64}$/
const LEGACY_CLAIM_NAME = /^([a-f0-9]{64})\.claim$/
const INDEX_FILE = '.logical-member-index-v2'

type LegacyClaimRecord = Omit<OpenCodeLaunchMutationClaimRecord,
  'version' | 'logicalMemberKey' | 'logicalMember' | 'legacyTargetDigest'> & { version: 1 }

type MigrationIndex = {
  version: 2
  entries: Record<string, {
    recordDigest: string
    state: 'claimed' | 'known_failure' | 'unknown' | 'committed' | 'unclassifiable'
    logicalMemberKey: string | null
    migrated: boolean
  }>
}

/**
 * Global durable member-mutation authority. Unlike an attempt journal this is
 * keyed by the canonical target, so two different attempt journals cannot both
 * authorize creation of the same team/lane/member session.
 */
export class OpenCodeLaunchMutationLedger {
  constructor(
    private readonly directory: string,
    private readonly persistenceFactory: (filePath: string) => OpenCodeLaunchFileJournalPersistence =
      filePath => new OpenCodeLaunchFileJournalPersistence(filePath),
  ) {}

  static targetDigest(input: {
    teamId: string; laneId: string; projectIdentity: string; memberName: string
  }): string {
    return openCodeLogicalMemberKey(input)
  }

  static idempotencyIdentity(targetDigest: string): string {
    if (!DIGEST.test(targetDigest)) throw new TypeError('invalid launch mutation target digest')
    // OpenCode accepts caller supplied session ids; this stable id is the remote
    // reconciliation key for the create-before-local-commit crash window.
    return `ses_${targetDigest.slice(0, 26)}`
  }

  async read(targetDigest: string, context: OpenCodeLaunchStoreContext): Promise<ClaimRecord | null> {
    return this.withDirectoryLock(context, async () => {
      const migration = await this.migrateLegacyClaims(context)
      return this.readCanonicalOrFence(targetDigest, context, migration)
    })
  }

  async claim(targetDigest: string, identity: OpenCodeLaunchMutationIdentity, context: OpenCodeLaunchStoreContext):
  Promise<'claimed' | 'already_committed' | 'unknown' | 'reconciliation_required'> {
    if (openCodeLogicalMemberKey(identity.logicalMember) !== targetDigest) {
      throw new TypeError('OpenCode launch mutation logical member claim mismatch')
    }
    return this.withDirectoryLock(context, async () => {
      const migration = await this.migrateLegacyClaims(context, identity)
      return this.withClaimLock(targetDigest, context, async persistence => {
      const unresolved = unresolvedPredecessors(migration)
      if (unresolved.some(entry => entry.state === 'unknown')) return 'unknown'
      if (unresolved.length > 0) return 'reconciliation_required'
      const current = await this.readUnlocked(persistence, targetDigest, context)
      if (current) {
        if (current.state === 'committed') return 'already_committed'
        if (current.state === 'known_failure') {
          if (sameImmutableAuthority(current, identity)
            && ((identity.generation === current.generation + 1
                && identity.fence === current.fence + 1)
              || (identity.generation === current.generation
                && identity.fence === current.fence
                && identity.inputDigest === current.inputDigest))) {
            const reclaimed: ClaimRecord = { ...current, ...identity, state: 'claimed' }
            validateClaimRecord(reclaimed)
            await persistence.replaceAndSync(new TextEncoder().encode(JSON.stringify(reclaimed)), context)
            return 'claimed'
          }
          return 'reconciliation_required'
        }
        // A live or crashed authority is never stolen. The exact same caller may
        // resume only through reconciliation, not by issuing create again.
        return current.state === 'unknown' ? 'unknown' : 'reconciliation_required'
      }
      const record: ClaimRecord = {
        version: 2, targetDigest, logicalMemberKey: openCodeLogicalMemberKey(identity.logicalMember),
        idempotencyIdentity: OpenCodeLaunchMutationLedger.idempotencyIdentity(targetDigest),
        state: 'claimed', ...identity,
      }
      validateClaimRecord(record)
      await persistence.replaceAndSync(new TextEncoder().encode(JSON.stringify(record)), context)
      return 'claimed'
      })
    })
  }

  async transition(
    targetDigest: string,
    identity: OpenCodeLaunchMutationIdentity,
    transition: 'known_failure' | 'unknown' | 'commit',
    linkage: OpenCodeLaunchMemberLinkage | undefined,
    context: OpenCodeLaunchStoreContext,
    recovery?: OpenCodeLaunchMemberRecovery,
  ): Promise<'committed' | 'cancelled' | 'fenced' | 'unknown'> {
    return this.withDirectoryLock(context, async () => {
      const migration = await this.migrateLegacyClaims(context, identity)
      if (unresolvedPredecessors(migration).length > 0) return 'fenced'
      return this.withClaimLock(targetDigest, context, async persistence => {
      const current = await this.readUnlocked(persistence, targetDigest, context)
      if (!current || !sameAuthority(current, identity)) return 'fenced'
      if (current.state === 'committed') {
        return linkage && current.linkage && sameLinkage(current.linkage, linkage) ? 'committed' : 'fenced'
      }
      if (current.state === 'unknown' && transition === 'commit') return 'fenced'
      if (transition === 'commit' && !recovery) throw new TypeError('launch mutation recovery metadata is required')
      const next: ClaimRecord = transition === 'commit'
        ? { ...current, state: 'committed', linkage, recovery }
        : { ...current, state: transition }
      validateClaimRecord(next)
      await persistence.replaceAndSync(new TextEncoder().encode(JSON.stringify(next)), context)
      return transition === 'commit' ? 'committed' : 'cancelled'
      })
    })
  }

  private persistence(targetDigest: string): OpenCodeLaunchFileJournalPersistence {
    if (!DIGEST.test(targetDigest)) throw new TypeError('invalid launch mutation target digest')
    return this.persistenceFactory(join(this.directory, `${targetDigest}.claim`))
  }

  private async withClaimLock<T>(targetDigest: string, context: OpenCodeLaunchStoreContext,
    operation: (persistence: OpenCodeLaunchFileJournalPersistence) => Promise<T>): Promise<T> {
    const persistence = this.persistence(targetDigest)
    const release = await persistence.acquireExclusive(context)
    try { return await operation(persistence) } finally { await release(context) }
  }

  private async readCanonicalOrFence(targetDigest: string, context: OpenCodeLaunchStoreContext,
    migration: MigrationIndex): Promise<ClaimRecord | null> {
    if (unresolvedPredecessors(migration).length > 0) {
      throw new OpenCodeLaunchJournalError('fenced',
        'unresolved predecessor launch mutation authority requires reconciliation')
    }
    const current = await this.withClaimLock(targetDigest, context,
      async persistence => this.readUnlocked(persistence, targetDigest, context))
    if (current) return current
    return null
  }

  private async withDirectoryLock<T>(context: OpenCodeLaunchStoreContext,
    operation: () => Promise<T>): Promise<T> {
    const persistence = this.persistenceFactory(join(this.directory, INDEX_FILE))
    const release = await persistence.acquireExclusive(context)
    try { return await operation() } finally { await release(context) }
  }

  /**
   * V1 used a digest containing opaque memberIdentity and did not persist the
   * logical member. Scan while holding the directory authority so migration and
   * a new logical claim are one serialized decision. Committed records carry a
   * recoverable session projection; other records can be mapped only when the
   * current claimant has the exact predecessor memberIdentity. Everything else
   * remains a durable fence in the index.
   */
  private async migrateLegacyClaims(context: OpenCodeLaunchStoreContext,
    identity?: OpenCodeLaunchMutationIdentity): Promise<MigrationIndex> {
    const names = (await readdir(this.directory)).filter(name => LEGACY_CLAIM_NAME.test(name)).sort()
    const indexPersistence = this.persistenceFactory(join(this.directory, INDEX_FILE))
    const previous = await readMigrationIndex(indexPersistence, context)
    const entries = { ...previous.entries }
    for (const name of names) {
      const match = LEGACY_CLAIM_NAME.exec(name)
      if (!match) continue
      const legacyTargetDigest = match[1]!
      const legacyPersistence = this.persistence(legacyTargetDigest)
      const bytes = await legacyPersistence.read(context)
      if (!bytes || bytes.byteLength > MAX_CLAIM_BYTES) {
        entries[legacyTargetDigest] = { recordDigest: bytes ? digest(bytes) : 'absent',
          state: 'unclassifiable', logicalMemberKey: null, migrated: false }
        continue
      }
      const recordDigest = digest(bytes)
      let parsed: unknown
      try { parsed = JSON.parse(new TextDecoder().decode(bytes)) } catch {
        entries[legacyTargetDigest] = { recordDigest, state: 'unclassifiable',
          logicalMemberKey: null, migrated: false }
        continue
      }
      // Current V2 claims share the extension and are not migration inputs.
      if ((parsed as { version?: unknown } | null)?.version === 2) continue
      let legacy: LegacyClaimRecord
      try { validateLegacyClaimRecord(parsed); legacy = parsed } catch {
        entries[legacyTargetDigest] = { recordDigest, state: 'unclassifiable',
          logicalMemberKey: null, migrated: false }
        continue
      }
      if (legacy.targetDigest !== legacyTargetDigest) {
        entries[legacyTargetDigest] = { recordDigest, state: 'unclassifiable',
          logicalMemberKey: null, migrated: false }
        continue
      }
      const previousEntry = previous.entries[legacyTargetDigest]
      if (previousEntry?.migrated === true && previousEntry.recordDigest === recordDigest
        && previousEntry.logicalMemberKey) {
        const canonicalPersistence = this.persistence(previousEntry.logicalMemberKey)
        const release = await canonicalPersistence.acquireExclusive(context)
        let reconciled = false
        try {
          const existing = await this.readUnlocked(
            canonicalPersistence, previousEntry.logicalMemberKey, context)
          reconciled = existing?.legacyTargetDigest === legacyTargetDigest
            && existing.logicalMemberKey === previousEntry.logicalMemberKey
        } finally { await release(context) }
        entries[legacyTargetDigest] = { recordDigest, state: legacy.state,
          logicalMemberKey: previousEntry.logicalMemberKey, migrated: reconciled }
        continue
      }
      const logicalMember = logicalMemberForLegacy(legacy, identity, legacyTargetDigest)
      if (!logicalMember) {
        entries[legacyTargetDigest] = { recordDigest, state: legacy.state,
          logicalMemberKey: null, migrated: false }
        continue
      }
      const logicalMemberKey = openCodeLogicalMemberKey(logicalMember)
      const migrated: ClaimRecord = { ...legacy, version: 2, targetDigest: logicalMemberKey,
        logicalMemberKey, logicalMember, legacyTargetDigest }
      validateClaimRecord(migrated)
      const canonicalPersistence = this.persistence(logicalMemberKey)
      const release = await canonicalPersistence.acquireExclusive(context)
      let installed = false
      try {
        const existing = await this.readUnlocked(canonicalPersistence, logicalMemberKey, context)
        if (!existing) {
          await canonicalPersistence.replaceAndSync(
            new TextEncoder().encode(JSON.stringify(migrated)), context)
          installed = true
        } else {
          installed = existing.legacyTargetDigest === legacyTargetDigest
            && existing.logicalMemberKey === logicalMemberKey
            && sameMigratedAuthority(existing, migrated)
        }
      } finally { await release(context) }
      entries[legacyTargetDigest] = { recordDigest, state: legacy.state,
        logicalMemberKey, migrated: installed }
    }
    const next: MigrationIndex = { version: 2, entries }
    if (JSON.stringify(next) !== JSON.stringify(previous)) {
      await indexPersistence.replaceAndSync(new TextEncoder().encode(JSON.stringify(next)), context)
    }
    return next
  }

  private async readUnlocked(persistence: OpenCodeLaunchFileJournalPersistence, targetDigest: string,
    context: OpenCodeLaunchStoreContext): Promise<ClaimRecord | null> {
    const bytes = await persistence.read(context)
    if (!bytes) return null
    if (bytes.byteLength > MAX_CLAIM_BYTES) throw new OpenCodeLaunchJournalError('corrupt', 'claim exceeds size limit')
    let parsed: unknown
    try { parsed = JSON.parse(new TextDecoder().decode(bytes)) } catch {
      throw new OpenCodeLaunchJournalError('corrupt', 'claim is invalid JSON')
    }
    validateClaimRecord(parsed)
    if (parsed.targetDigest !== targetDigest) throw new OpenCodeLaunchJournalError('foreign', 'foreign claim target')
    return parsed
  }
}

function validateClaimRecord(value: unknown): asserts value is ClaimRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt()
  const record = value as Record<string, unknown>
    const allowed = new Set(['version', 'targetDigest', 'idempotencyIdentity', 'state', 'attemptId', 'payloadHash',
    'logicalMemberKey', 'logicalMember', 'inputDigest', 'immutableDigest', 'generation', 'fence', 'acquisitionToken',
    'claimToken', 'memberIdentity', 'linkage', 'recovery', 'legacyTargetDigest'])
  if (Object.keys(record).some(key => !allowed.has(key)) || record.version !== 2
    || !DIGEST.test(String(record.targetDigest)) || !DIGEST.test(String(record.logicalMemberKey))
    || record.targetDigest !== record.logicalMemberKey || !TOKEN.test(String(record.idempotencyIdentity))
    || record.idempotencyIdentity !== OpenCodeLaunchMutationLedger.idempotencyIdentity(
      String(record.legacyTargetDigest ?? record.targetDigest))
    || !['claimed', 'known_failure', 'unknown', 'committed'].includes(String(record.state))
    || !isOpenCodeLaunchAttemptId(record.attemptId) || !isOpenCodeLaunchPayloadHash(record.payloadHash)
    || !DIGEST.test(String(record.inputDigest)) || !DIGEST.test(String(record.immutableDigest))
    || typeof record.generation !== 'number'
    || !Number.isSafeInteger(record.generation) || typeof record.fence !== 'number'
    || !Number.isSafeInteger(record.fence) || !TOKEN.test(String(record.acquisitionToken))
    || !TOKEN.test(String(record.claimToken)) || !isOpenCodeOpaqueIdentity(record.memberIdentity)
    || (record.legacyTargetDigest !== undefined && !DIGEST.test(String(record.legacyTargetDigest)))
    || !record.logicalMember || typeof record.logicalMember !== 'object'
    || Array.isArray(record.logicalMember)) throw corrupt()
  try {
    const logicalMember = record.logicalMember as OpenCodeLogicalMemberIdentity
    const normalized = assertOpenCodeLogicalMemberIdentity(logicalMember, String(record.logicalMemberKey))
    if (JSON.stringify(normalized) !== JSON.stringify(logicalMember)) throw corrupt()
  } catch { throw corrupt() }
  if (record.state === 'committed') {
    if (!record.linkage || !sameLinkageShape(record.linkage, record.memberIdentity as string)
      || (record.recovery !== undefined && !sameRecoveryShape(record.recovery))) throw corrupt()
  } else if (record.linkage !== undefined || record.recovery !== undefined) throw corrupt()
}

function validateLegacyClaimRecord(value: unknown): asserts value is LegacyClaimRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt()
  const record = value as Record<string, unknown>
  const allowed = new Set(['version', 'targetDigest', 'idempotencyIdentity', 'state', 'attemptId', 'payloadHash',
    'inputDigest', 'immutableDigest', 'generation', 'fence', 'acquisitionToken', 'claimToken', 'memberIdentity',
    'linkage', 'recovery'])
  if (Object.keys(record).some(key => !allowed.has(key)) || record.version !== 1
    || !DIGEST.test(String(record.targetDigest)) || !TOKEN.test(String(record.idempotencyIdentity))
    || record.idempotencyIdentity !== OpenCodeLaunchMutationLedger.idempotencyIdentity(String(record.targetDigest))
    || !['claimed', 'known_failure', 'unknown', 'committed'].includes(String(record.state))
    || !isOpenCodeLaunchAttemptId(record.attemptId) || !isOpenCodeLaunchPayloadHash(record.payloadHash)
    || !DIGEST.test(String(record.inputDigest)) || !DIGEST.test(String(record.immutableDigest))
    || !Number.isSafeInteger(record.generation) || !Number.isSafeInteger(record.fence)
    || !TOKEN.test(String(record.acquisitionToken)) || !TOKEN.test(String(record.claimToken))
    || !isOpenCodeOpaqueIdentity(record.memberIdentity)) throw corrupt()
  if (record.state === 'committed') {
    if (!record.linkage || !sameLinkageShape(record.linkage, record.memberIdentity as string)
      || (record.recovery !== undefined && !sameRecoveryShape(record.recovery))) throw corrupt()
  } else if (record.linkage !== undefined || record.recovery !== undefined) throw corrupt()
}

function logicalMemberForLegacy(record: LegacyClaimRecord, identity: OpenCodeLaunchMutationIdentity | undefined,
  legacyTargetDigest: string): OpenCodeLogicalMemberIdentity | null {
  if (identity && identity.memberIdentity === record.memberIdentity
    && legacyDigest(identity.logicalMember, record.memberIdentity) === legacyTargetDigest) {
    return normalizeLogical(identity.logicalMember)
  }
  if (record.state !== 'committed' || !record.recovery) return null
  const session = record.recovery.sessionRecord
  try {
    const logical = normalizeLogical({ teamId: session.teamId, laneId: session.laneId ?? 'primary',
      projectIdentity: session.projectPath, memberName: session.memberName })
    return legacyDigest(logical, record.memberIdentity) === legacyTargetDigest ? logical : null
  } catch { return null }
}

function normalizeLogical(value: OpenCodeLogicalMemberIdentity): OpenCodeLogicalMemberIdentity {
  const key = openCodeLogicalMemberKey(value)
  return assertOpenCodeLogicalMemberIdentity(
    // assert returns the normalized value while also binding it to the digest.
    { ...value }, key)
}

function legacyDigest(logicalMember: OpenCodeLogicalMemberIdentity, memberIdentity: OpenCodeOpaqueIdentity): string {
  return createHash('sha256').update(JSON.stringify({ teamId: logicalMember.teamId,
    laneId: logicalMember.laneId, projectIdentity: logicalMember.projectIdentity, memberIdentity })).digest('hex')
}

async function readMigrationIndex(persistence: OpenCodeLaunchFileJournalPersistence,
  context: OpenCodeLaunchStoreContext): Promise<MigrationIndex> {
  const bytes = await persistence.read(context)
  if (!bytes) return { version: 2, entries: {} }
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)) } catch { throw corrupt() }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw corrupt()
  const candidate = parsed as { version?: unknown; entries?: unknown }
  if (candidate.version !== 2 || !candidate.entries || typeof candidate.entries !== 'object'
    || Array.isArray(candidate.entries)) throw corrupt()
  for (const [key, value] of Object.entries(candidate.entries)) {
    if (!DIGEST.test(key) || !value || typeof value !== 'object' || Array.isArray(value)) throw corrupt()
    const entry = value as Record<string, unknown>
    if (Object.keys(entry).sort().join(',') !== 'logicalMemberKey,migrated,recordDigest,state'
      || !(entry.recordDigest === 'absent' || DIGEST.test(String(entry.recordDigest)))
      || !['claimed', 'known_failure', 'unknown', 'committed', 'unclassifiable'].includes(String(entry.state))
      || !(entry.logicalMemberKey === null || DIGEST.test(String(entry.logicalMemberKey)))
      || typeof entry.migrated !== 'boolean') throw corrupt()
  }
  return candidate as MigrationIndex
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sameRecoveryShape(value: unknown): value is OpenCodeLaunchMemberRecovery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const recovery = value as Record<string, unknown>
  if (Object.keys(recovery).length !== 2 || typeof recovery.ownershipTitle !== 'string'
    || !recovery.sessionRecord || typeof recovery.sessionRecord !== 'object'
    || Array.isArray(recovery.sessionRecord)) return false
  const record = recovery.sessionRecord as Record<string, unknown>
  return typeof record.teamId === 'string' && typeof record.memberName === 'string'
    && record.providerId === 'opencode' && typeof record.selectedModel === 'string'
    && typeof record.projectPath === 'string' && typeof record.profileRootKey === 'string'
    && typeof record.hostKey === 'string' && typeof record.opencodeSessionId === 'string'
    && record.appManagedBootstrap !== null && typeof record.appManagedBootstrap === 'object'
}

function sameAuthority(left: ClaimRecord, right: OpenCodeLaunchMutationIdentity): boolean {
  return left.attemptId === right.attemptId && left.payloadHash === right.payloadHash
    && left.inputDigest === right.inputDigest && left.generation === right.generation
    && left.fence === right.fence && left.acquisitionToken === right.acquisitionToken
    && left.claimToken === right.claimToken && left.memberIdentity === right.memberIdentity
    && left.logicalMemberKey === openCodeLogicalMemberKey(right.logicalMember)
}

function sameMigratedAuthority(left: ClaimRecord, right: ClaimRecord): boolean {
  return left.targetDigest === right.targetDigest
    && left.legacyTargetDigest === right.legacyTargetDigest
    && left.idempotencyIdentity === right.idempotencyIdentity
    && left.state === right.state
    && left.immutableDigest === right.immutableDigest
    && sameAuthority(left, right)
    && (left.linkage === undefined
      ? right.linkage === undefined
      : right.linkage !== undefined && sameLinkage(left.linkage, right.linkage))
    && JSON.stringify(left.recovery) === JSON.stringify(right.recovery)
}

function unresolvedPredecessors(migration: MigrationIndex): MigrationIndex['entries'][string][] {
  return Object.values(migration.entries).filter(entry => !entry.migrated
    && entry.state !== 'known_failure')
}

function sameImmutableAuthority(left: ClaimRecord, right: OpenCodeLaunchMutationIdentity): boolean {
  return left.attemptId === right.attemptId && left.payloadHash === right.payloadHash
    && left.immutableDigest === right.immutableDigest && left.memberIdentity === right.memberIdentity
    && left.logicalMemberKey === openCodeLogicalMemberKey(right.logicalMember)
}

function sameLinkageShape(value: unknown, memberIdentity: string): value is OpenCodeLaunchMemberLinkage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 4 && record.memberIdentity === memberIdentity
    && ['memberIdentity', 'sessionIdentity', 'bootstrapMessageIdentity', 'commitIdentity']
      .every(key => /^sha256:[a-f0-9]{64}$/.test(String(record[key])))
}

function sameLinkage(left: OpenCodeLaunchMemberLinkage, right: OpenCodeLaunchMemberLinkage): boolean {
  return left.memberIdentity === right.memberIdentity && left.sessionIdentity === right.sessionIdentity
    && left.bootstrapMessageIdentity === right.bootstrapMessageIdentity && left.commitIdentity === right.commitIdentity
}

function corrupt(): OpenCodeLaunchJournalError {
  return new OpenCodeLaunchJournalError('corrupt', 'invalid launch mutation claim')
}
