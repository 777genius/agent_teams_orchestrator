import { createHash } from 'node:crypto'
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
}

export type OpenCodeLaunchMutationClaimRecord = OpenCodeLaunchMutationIdentity & {
  version: 1
  targetDigest: string
  idempotencyIdentity: string
  state: 'claimed' | 'known_failure' | 'unknown' | 'committed'
  linkage?: OpenCodeLaunchMemberLinkage
  recovery?: OpenCodeLaunchMemberRecovery
}
type ClaimRecord = OpenCodeLaunchMutationClaimRecord

const MAX_CLAIM_BYTES = 8_192
const TOKEN = /^[A-Za-z0-9._:-]{1,256}$/
const DIGEST = /^[a-f0-9]{64}$/

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
    teamId: string; laneId: string; projectIdentity: string; memberIdentity: OpenCodeOpaqueIdentity
  }): string {
    return sha256(JSON.stringify(input))
  }

  static idempotencyIdentity(targetDigest: string): string {
    if (!DIGEST.test(targetDigest)) throw new TypeError('invalid launch mutation target digest')
    // OpenCode accepts caller supplied session ids; this stable id is the remote
    // reconciliation key for the create-before-local-commit crash window.
    return `ses_${targetDigest.slice(0, 26)}`
  }

  async read(targetDigest: string, context: OpenCodeLaunchStoreContext): Promise<ClaimRecord | null> {
    return this.withLock(targetDigest, context, async persistence => this.readUnlocked(persistence, targetDigest, context))
  }

  async claim(targetDigest: string, identity: OpenCodeLaunchMutationIdentity, context: OpenCodeLaunchStoreContext):
  Promise<'claimed' | 'already_committed' | 'unknown' | 'reconciliation_required'> {
    return this.withLock(targetDigest, context, async persistence => {
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
        version: 1, targetDigest, idempotencyIdentity: OpenCodeLaunchMutationLedger.idempotencyIdentity(targetDigest),
        state: 'claimed', ...identity,
      }
      validateClaimRecord(record)
      await persistence.replaceAndSync(new TextEncoder().encode(JSON.stringify(record)), context)
      return 'claimed'
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
    return this.withLock(targetDigest, context, async persistence => {
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
  }

  private persistence(targetDigest: string): OpenCodeLaunchFileJournalPersistence {
    if (!DIGEST.test(targetDigest)) throw new TypeError('invalid launch mutation target digest')
    return this.persistenceFactory(join(this.directory, `${targetDigest}.claim`))
  }

  private async withLock<T>(targetDigest: string, context: OpenCodeLaunchStoreContext,
    operation: (persistence: OpenCodeLaunchFileJournalPersistence) => Promise<T>): Promise<T> {
    const persistence = this.persistence(targetDigest)
    const release = await persistence.acquireExclusive(context)
    try { return await operation(persistence) } finally { await release(context) }
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
    'inputDigest', 'immutableDigest', 'generation', 'fence', 'acquisitionToken', 'claimToken', 'memberIdentity', 'linkage', 'recovery'])
  if (Object.keys(record).some(key => !allowed.has(key)) || record.version !== 1
    || !DIGEST.test(String(record.targetDigest)) || !TOKEN.test(String(record.idempotencyIdentity))
    || !['claimed', 'known_failure', 'unknown', 'committed'].includes(String(record.state))
    || !isOpenCodeLaunchAttemptId(record.attemptId) || !isOpenCodeLaunchPayloadHash(record.payloadHash)
    || !DIGEST.test(String(record.inputDigest)) || !DIGEST.test(String(record.immutableDigest))
    || typeof record.generation !== 'number'
    || !Number.isSafeInteger(record.generation) || typeof record.fence !== 'number'
    || !Number.isSafeInteger(record.fence) || !TOKEN.test(String(record.acquisitionToken))
    || !TOKEN.test(String(record.claimToken)) || !isOpenCodeOpaqueIdentity(record.memberIdentity)) throw corrupt()
  if (record.state === 'committed') {
    if (!record.linkage || !sameLinkageShape(record.linkage, record.memberIdentity as string)
      || (record.recovery !== undefined && !sameRecoveryShape(record.recovery))) throw corrupt()
  } else if (record.linkage !== undefined || record.recovery !== undefined) throw corrupt()
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
}

function sameImmutableAuthority(left: ClaimRecord, right: OpenCodeLaunchMutationIdentity): boolean {
  return left.attemptId === right.attemptId && left.payloadHash === right.payloadHash
    && left.immutableDigest === right.immutableDigest && left.memberIdentity === right.memberIdentity
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

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex') }
