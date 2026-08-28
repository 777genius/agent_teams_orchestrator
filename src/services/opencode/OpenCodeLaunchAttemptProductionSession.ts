import { createHash } from 'node:crypto'
import path from 'node:path'

import type { OpenCodeLaunchOwnedResources } from './OpenCodeLaunchAttempt.js'
import type { OpenCodeLaunchMutationClaimRecord } from './OpenCodeLaunchMutationLedger.js'
import type { OpenCodeLaunchMemberLinkage, OpenCodeOpaqueIdentity } from './OpenCodeBridgeContractV2.js'
import type { OpenCodeMessage, OpenCodeSessionRecord, OpenCodeSessionSummary } from './types.js'
import { openCodeMonotonicNow } from './OpenCodeRuntimeDeadline.js'
import { OpenCodeSafePublicationDirectory } from './OpenCodeSafePublication.js'
import { hasExactOpenCodeMessageOwnership } from './OpenCodeMessageOwnership.js'

function opaque(value: unknown): OpenCodeOpaqueIdentity {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function sessionIdentity(id: string): OpenCodeOpaqueIdentity {
  return opaque({ kind: 'opencode-session', id })
}

function isAbsent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
    || (error instanceof Error && error.message.includes('(404 '))
}

export type OpenCodeOwnedSessionReconciliation = 'absent' | 'deleted' | 'foreign' | 'unresolved'

export type OpenCodeProofSessionGenerationRecord = {
  generation: number
  requestGeneration: number
  hostKeyIdentity: OpenCodeOpaqueIdentity
  authoritativeSessionId: string
  ownershipTitle: string
  state: 'registered' | 'owned' | OpenCodeOwnedSessionReconciliation
  /** Non-secret remote handle required to re-observe the accepted proof after restart. */
  observationMessageId?: string
  updatedAt: string
}

export type OpenCodeProofSessionCleanupRecord = OpenCodeProofSessionGenerationRecord & {
  version: 2
  attemptId: string
}

type ProofLedgerFile = {
  version: 2
  attemptId: string
  active: OpenCodeProofSessionGenerationRecord | null
  retired: OpenCodeProofSessionGenerationRecord[]
}

export type OpenCodeProofLedgerContext = Readonly<{
  deadlineAtMs: number
  signal: AbortSignal
}>

type OpenCodeProofLedgerDirectory = Pick<OpenCodeSafePublicationDirectory,
  'readBoundedRegularFile' | 'writeFileAtomic' | 'close' | 'physicalSettlement'>

type OpenCodeProofLedgerDirectoryOpen = (
  directoryPath: string,
  options: Readonly<{ abortSignal?: AbortSignal; deadline?: number }>,
) => Promise<OpenCodeProofLedgerDirectory>

/**
 * Durable proof-generation ledger.  Every create is preceded by an active
 * generation record.  A later nonce can be registered only after the prior
 * exact id/title/host has been reconciled and atomically moved to `retired`.
 */
export class OpenCodeProofSessionCleanupLedger {
  #tail: Promise<void> = Promise.resolve()
  constructor(
    private readonly filePath: string,
    private readonly openDirectory: OpenCodeProofLedgerDirectoryOpen = (directoryPath, options) =>
      OpenCodeSafePublicationDirectory.open(directoryPath, options),
  ) {}

  async read(context?: OpenCodeProofLedgerContext): Promise<OpenCodeProofSessionCleanupRecord | null> {
    return this.exclusive(context, async directory => {
      const ledger = await this.readFile(directory, context?.signal)
      return ledger?.active ? { version: 2, attemptId: ledger.attemptId, ...ledger.active } : null
    })
  }

  async readGenerations(context?: OpenCodeProofLedgerContext): Promise<ProofLedgerFile | null> {
    return this.exclusive(context, directory => this.readFile(directory, context?.signal))
  }

  async reconcileAndRegister(input: {
    attemptId: string
    requestGeneration: number
    hostKeyIdentity: OpenCodeOpaqueIdentity
    ownership(generation: number): { authoritativeSessionId: string; ownershipTitle: string }
    reconcile(record: OpenCodeProofSessionCleanupRecord): Promise<OpenCodeOwnedSessionReconciliation>
  }, context?: OpenCodeProofLedgerContext): Promise<{ record: OpenCodeProofSessionCleanupRecord; created: boolean; priorOutcome?: OpenCodeOwnedSessionReconciliation }> {
    return this.exclusive(context, async directory => {
    let ledger = await this.readFile(directory, context?.signal)
    let persistedLedger = ledger
    if (ledger && ledger.attemptId !== input.attemptId) {
      throw new Error('OpenCode proof cleanup ledger ownership mismatch')
    }
    ledger ??= { version: 2, attemptId: input.attemptId, active: null, retired: [] }
    let priorOutcome: OpenCodeOwnedSessionReconciliation | undefined
    if (ledger.active) {
      const prior = { version: 2 as const, attemptId: ledger.attemptId, ...ledger.active }
      priorOutcome = prior.hostKeyIdentity !== input.hostKeyIdentity
        ? 'unresolved'
        : prior.state === 'foreign'
        ? 'foreign'
        : prior.state === 'absent' || prior.state === 'deleted'
        ? prior.state
        : await input.reconcile(prior)
      const settled = { ...ledger.active, state: priorOutcome, updatedAt: new Date().toISOString() }
      ledger = { ...ledger, active: settled }
      await this.write(directory, ledger, context?.signal, persistedLedger)
      persistedLedger = ledger
      if (priorOutcome !== 'absent' && priorOutcome !== 'deleted') {
        return { record: { version: 2, attemptId: ledger.attemptId, ...settled }, created: false, priorOutcome }
      }
      ledger = { ...ledger, active: null, retired: [...ledger.retired, settled] }
    }
    const generation = (ledger.retired.at(-1)?.generation ?? 0) + 1
    const ownership = input.ownership(generation)
    const active: OpenCodeProofSessionGenerationRecord = {
      generation, requestGeneration: input.requestGeneration,
      hostKeyIdentity: input.hostKeyIdentity, ...ownership,
      state: 'registered', updatedAt: new Date().toISOString(),
    }
    ledger = { ...ledger, active }
    await this.write(directory, ledger, context?.signal, persistedLedger)
    return { record: { version: 2, attemptId: ledger.attemptId, ...active }, created: true,
      ...(priorOutcome ? { priorOutcome } : {}) }
    })
  }

  async recordState(
    expected: Pick<OpenCodeProofSessionCleanupRecord,
      'attemptId' | 'generation' | 'hostKeyIdentity' | 'authoritativeSessionId' | 'ownershipTitle'>,
    state: Exclude<OpenCodeProofSessionGenerationRecord['state'], 'registered'>,
    context?: OpenCodeProofLedgerContext,
  ): Promise<OpenCodeProofSessionCleanupRecord> {
    return this.exclusive(context, async directory => {
    const ledger = await this.readFile(directory, context?.signal)
    const current = ledger?.active
    if (!ledger || !current || ledger.attemptId !== expected.attemptId
      || current.generation !== expected.generation
      || current.hostKeyIdentity !== expected.hostKeyIdentity
      || current.authoritativeSessionId !== expected.authoritativeSessionId
      || current.ownershipTitle !== expected.ownershipTitle) {
      throw new Error('OpenCode proof cleanup ledger ownership mismatch')
    }
    const active = { ...current, state, updatedAt: new Date().toISOString() }
    await this.write(directory, { ...ledger, active }, context?.signal, ledger)
    return { version: 2, attemptId: ledger.attemptId, ...active }
    })
  }

  async recordObservationMessage(
    expected: Pick<OpenCodeProofSessionCleanupRecord,
      'attemptId' | 'generation' | 'hostKeyIdentity' | 'authoritativeSessionId' | 'ownershipTitle'>,
    observationMessageId: string,
    context?: OpenCodeProofLedgerContext,
  ): Promise<OpenCodeProofSessionCleanupRecord> {
    if (!validObservationMessageId(observationMessageId)) {
      throw new Error('OpenCode proof observation message identity is invalid')
    }
    return this.exclusive(context, async directory => {
      const ledger = await this.readFile(directory, context?.signal)
      const current = ledger?.active
      if (!ledger || !current || current.state !== 'owned'
        || ledger.attemptId !== expected.attemptId
        || current.generation !== expected.generation
        || current.hostKeyIdentity !== expected.hostKeyIdentity
        || current.authoritativeSessionId !== expected.authoritativeSessionId
        || current.ownershipTitle !== expected.ownershipTitle) {
        throw new Error('OpenCode proof cleanup ledger ownership mismatch')
      }
      if (current.observationMessageId !== undefined
        && current.observationMessageId !== observationMessageId) {
        throw new Error('OpenCode proof observation message identity changed')
      }
      const active = { ...current, observationMessageId, updatedAt: new Date().toISOString() }
      await this.write(directory, { ...ledger, active }, context?.signal, ledger)
      return { version: 2, attemptId: ledger.attemptId, ...active }
    })
  }

  private async readFile(directory: OpenCodeProofLedgerDirectory, signal?: AbortSignal): Promise<ProofLedgerFile | null> {
    try {
      const text = await directory.readBoundedRegularFile(path.basename(this.filePath), 1_048_576, signal)
      if (text === null) return null
      return normalizeProofLedger(JSON.parse(text))
    } catch (error) {
      if (isAbsent(error)) return null
      throw error
    }
  }

  private async write(directory: OpenCodeProofLedgerDirectory, record: ProofLedgerFile, signal?: AbortSignal,
    expected?: ProofLedgerFile | null): Promise<void> {
    const currentText = await directory.readBoundedRegularFile(path.basename(this.filePath), 1_048_576, signal)
    const current = currentText === null ? null : normalizeProofLedger(JSON.parse(currentText))
    if (expected !== undefined && JSON.stringify(current) !== JSON.stringify(expected)) {
      throw new Error('OpenCode proof cleanup ledger ownership mismatch')
    }
    await directory.writeFileAtomic(path.basename(this.filePath), `${JSON.stringify(record)}\n`, 0o600, signal, {
      expectedPriorSha256: currentText === null
        ? null
        : createHash('sha256').update(currentText).digest('hex'),
    })
  }

  private async exclusive<T>(context: OpenCodeProofLedgerContext | undefined,
    operation: (directory: OpenCodeProofLedgerDirectory) => Promise<T>): Promise<T> {
    const previous = this.#tail
    let release!: () => void
    const released = new Promise<void>(resolve => { release = resolve })
    // A waiter that times out still remains chained behind the physical owner;
    // it can relinquish only its own place, never bypass the predecessor.
    this.#tail = previous.then(() => released, () => released)
    try { await awaitProofLedgerContext(previous, context) }
    catch (error) { release(); throw error }
    let directory: OpenCodeProofLedgerDirectory | undefined
    const foreground = (async () => {
      directory = await this.openDirectory(path.dirname(this.filePath), {
        abortSignal: context?.signal, deadline: context?.deadlineAtMs,
      })
      try { return await operation(directory) }
      finally { await directory.close() }
    })()
    const physicalSettlement = foreground.then(
      async () => { await directory?.physicalSettlement },
      async () => { await directory?.physicalSettlement },
    )
    // close() may be only the caller-visible protocol boundary on Windows.
    // Keep the successor lease until child exit closes the retained OS handles.
    void physicalSettlement.then(release, release)
    return await awaitProofLedgerContext(foreground, context)
  }
}

async function awaitProofLedgerContext<T>(operation: Promise<T>, context?: OpenCodeProofLedgerContext): Promise<T> {
  if (!context) return operation
  if (context.signal.aborted) throw context.signal.reason ?? new Error('OpenCode proof cleanup cancelled')
  const remaining = context.deadlineAtMs - openCodeMonotonicNow()
  if (remaining <= 0) throw new Error('OpenCode proof cleanup deadline expired')
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(context.signal.reason ?? new Error('OpenCode proof cleanup cancelled'))
    context.signal.addEventListener('abort', abort, { once: true })
  })
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('OpenCode proof cleanup deadline expired')), remaining)
    timer.unref?.()
  })
  try { return await Promise.race([operation, cancelled, expired]) }
  finally {
    if (timer) clearTimeout(timer)
    context.signal.removeEventListener('abort', abort)
  }
}

function normalizeProofLedger(value: unknown): ProofLedgerFile {
  if (isLegacyProofRecord(value)) {
    return { version: 2, attemptId: value.attemptId, active: {
      generation: 1, requestGeneration: 1, hostKeyIdentity: value.hostKeyIdentity,
      authoritativeSessionId: value.authoritativeSessionId, ownershipTitle: value.ownershipTitle,
      state: value.state, updatedAt: value.updatedAt,
    }, retired: [] }
  }
  validateProofLedger(value)
  return value
}

function validateProofLedger(value: unknown): asserts value is ProofLedgerFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidProofLedger()
  const ledger = value as Record<string, unknown>
  if (ledger.version !== 2 || typeof ledger.attemptId !== 'string'
    || (ledger.active !== null && !validGeneration(ledger.active))
    || !Array.isArray(ledger.retired) || !ledger.retired.every(validGeneration)) throw invalidProofLedger()
  const generations = [...ledger.retired, ...(ledger.active ? [ledger.active] : [])]
    .map(record => (record as OpenCodeProofSessionGenerationRecord).generation)
  if (generations.some((generation, index) => generation !== index + 1)) throw invalidProofLedger()
  if (ledger.retired.some(record => !['absent', 'deleted'].includes(String((record as { state?: unknown }).state)))) {
    throw invalidProofLedger()
  }
}

function validGeneration(value: unknown): value is OpenCodeProofSessionGenerationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Number.isSafeInteger(record.generation) && Number(record.generation) > 0
    && Number.isSafeInteger(record.requestGeneration) && Number(record.requestGeneration) > 0
    && typeof record.hostKeyIdentity === 'string' && typeof record.authoritativeSessionId === 'string'
    && typeof record.ownershipTitle === 'string' && typeof record.updatedAt === 'string'
    && (record.observationMessageId === undefined || validObservationMessageId(record.observationMessageId))
    && ['registered', 'owned', 'absent', 'deleted', 'foreign', 'unresolved'].includes(String(record.state))
}

function validObservationMessageId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function isLegacyProofRecord(value: unknown): value is {
  version: 1; attemptId: string; hostKeyIdentity: OpenCodeOpaqueIdentity
  authoritativeSessionId: string; ownershipTitle: string
  state: OpenCodeProofSessionGenerationRecord['state']; updatedAt: string
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.version === 1 && typeof record.attemptId === 'string'
    && typeof record.hostKeyIdentity === 'string' && typeof record.authoritativeSessionId === 'string'
    && typeof record.ownershipTitle === 'string' && typeof record.updatedAt === 'string'
    && ['registered', 'owned', 'absent', 'deleted', 'foreign', 'unresolved'].includes(String(record.state))
}

function invalidProofLedger(): Error { return new Error('OpenCode proof cleanup ledger is invalid') }

/** Reconcile one exact owned id. Never delete a foreign title and never retry DELETE. */
export async function reconcileOpenCodeOwnedMemberSession(input: {
  authoritativeSessionId: string
  ownershipTitle: string
  getSession(id: string): Promise<OpenCodeSessionSummary>
  deleteSession(id: string): Promise<boolean>
}): Promise<OpenCodeOwnedSessionReconciliation> {
  let observed: OpenCodeSessionSummary
  try { observed = await input.getSession(input.authoritativeSessionId) }
  catch (error) { return isAbsent(error) ? 'absent' : 'unresolved' }
  if (observed.id !== input.authoritativeSessionId || observed.title !== input.ownershipTitle) return 'foreign'
  try { await input.deleteSession(input.authoritativeSessionId) } catch {}
  try { await input.getSession(input.authoritativeSessionId); return 'unresolved' }
  catch (error) { return isAbsent(error) ? 'deleted' : 'unresolved' }
}

export type OpenCodeCommittedProjectionRecoveryResult =
  | { status: 'recovered'; linkage: OpenCodeLaunchMemberLinkage; record: OpenCodeSessionRecord }
  | { status: 'unresolved'; reason: 'claim_metadata' | 'local_metadata' | 'remote_absent' | 'remote_foreign' | 'remote_mismatch' | 'transport' }

export type OpenCodeLaunchProjectionFailpoint = 'after_commit' | 'before_projection' | 'after_projection'

export type OpenCodeCommittedMemberLinkageRecoveryInput = {
  claim: OpenCodeLaunchMutationClaimRecord | null
  attemptId: string
  payloadHash: string
  inputDigest: string
  immutableDigest: string
  generation: number
  fence: number
  claimToken: string
  memberIdentity: OpenCodeOpaqueIdentity
  teamId: string
  laneId: string
  memberName: string
  selectedModel: string
  expectedBootstrapText: string
  record: OpenCodeSessionRecord | null
}

/** The authoritative claim is committed first; every later point is recoverable projection work. */
export async function commitOpenCodeMemberProjection(input: {
  commit(): Promise<'committed' | 'fenced' | 'unknown'>
  onCommitted?(): void
  upsert(): Promise<unknown>
  failpoint?(point: OpenCodeLaunchProjectionFailpoint): void | Promise<void>
}): Promise<'committed' | 'fenced' | 'unknown'> {
  const outcome = await input.commit()
  if (outcome !== 'committed') return outcome
  input.onCommitted?.()
  await input.failpoint?.('after_commit')
  await input.failpoint?.('before_projection')
  await input.upsert()
  await input.failpoint?.('after_projection')
  return 'committed'
}

/**
 * Recover a session-store projection only from the exact committed global
 * mutation authority for the journaled member intent. Session-store presence
 * is projection evidence, never mutation authority by itself.
 */
export function recoverOpenCodeCommittedMemberLinkage(
  input: OpenCodeCommittedMemberLinkageRecoveryInput,
): OpenCodeLaunchMemberLinkage | null {
  const claim = input.claim
  const record = input.record
  if (!claim || !record || claim.state !== 'committed' || !claim.linkage || !claim.recovery
    || claim.attemptId !== input.attemptId || claim.payloadHash !== input.payloadHash
    || claim.inputDigest !== input.inputDigest || claim.immutableDigest !== input.immutableDigest
    || claim.generation !== input.generation || claim.fence !== input.fence
    || claim.claimToken !== input.claimToken || claim.memberIdentity !== input.memberIdentity
    || !claim.claimToken.startsWith(`${claim.acquisitionToken}.`)
    || claim.idempotencyIdentity !== deterministicSessionId(claim.legacyTargetDigest ?? claim.targetDigest)) return null

  const expectedTitle = deterministicOwnershipTitle(claim)
  const committedRecord = claim.recovery.sessionRecord
  if (claim.recovery.ownershipTitle !== expectedTitle
    || !hasExactCommittedRecordBinding(committedRecord, input, claim.idempotencyIdentity)
    || !hasExactCommittedRecordBinding(record, input, claim.idempotencyIdentity)
    || !sameBootstrapBinding(record, committedRecord)) return null

  const committedLinkage = linkageForRecord(input.memberIdentity, committedRecord)
  const projectedLinkage = linkageForRecord(input.memberIdentity, record)
  if (!committedLinkage || !projectedLinkage
    || !sameLinkage(committedLinkage, claim.linkage)
    || !sameLinkage(projectedLinkage, claim.linkage)) return null
  return claim.linkage
}

/** Verify an exact committed claim before repairing its non-authoritative session projection. */
export async function recoverOpenCodeCommittedMemberProjection(input: {
  claim: OpenCodeLaunchMutationClaimRecord
  attemptId: string
  payloadHash: string
  inputDigest: string
  immutableDigest: string
  generation: number
  fence: number
  claimToken: string
  memberIdentity: OpenCodeOpaqueIdentity
  teamId: string
  laneId: string
  memberName: string
  selectedModel: string
  expectedBootstrapText: string
  getSession(id: string): Promise<OpenCodeSessionSummary>
  getSessionMessage(id: string, messageId: string): Promise<OpenCodeMessage | null>
  upsert(record: OpenCodeSessionRecord): Promise<unknown>
}): Promise<OpenCodeCommittedProjectionRecoveryResult> {
  const recovery = input.claim.recovery
  if (input.claim.state !== 'committed' || !input.claim.linkage || !recovery) {
    return { status: 'unresolved', reason: 'claim_metadata' }
  }
  const record = recovery.sessionRecord
  const exactLinkage = recoverOpenCodeCommittedMemberLinkage({
    claim: input.claim, record,
    attemptId: input.attemptId, payloadHash: input.payloadHash,
    inputDigest: input.inputDigest, immutableDigest: input.immutableDigest,
    generation: input.generation, fence: input.fence, claimToken: input.claimToken,
    memberIdentity: input.memberIdentity,
    teamId: input.teamId, laneId: input.laneId, memberName: input.memberName,
    selectedModel: input.selectedModel, expectedBootstrapText: input.expectedBootstrapText,
  })
  if (!exactLinkage) return { status: 'unresolved', reason: 'claim_metadata' }
  const expectedTitle = deterministicOwnershipTitle(input.claim)
  const bootstrap = record.appManagedBootstrap
  if (recovery.ownershipTitle !== expectedTitle || record.teamId !== input.teamId
    || record.laneId !== input.laneId || record.memberName !== input.memberName
    || record.selectedModel !== input.selectedModel || record.providerId !== 'opencode'
    || record.opencodeSessionId !== input.claim.idempotencyIdentity || record.staleReason !== null || !bootstrap
    || bootstrap.model !== input.selectedModel || bootstrap.agent !== 'teammate-bootstrap'
    || bootstrap.contextHash !== createHash('sha256').update(input.expectedBootstrapText).digest('hex')) {
    return { status: 'unresolved', reason: 'local_metadata' }
  }
  let remote: OpenCodeSessionSummary
  let message: OpenCodeMessage | null
  try {
    remote = await input.getSession(record.opencodeSessionId)
    message = await input.getSessionMessage(record.opencodeSessionId, bootstrap.messageID)
  } catch (error) {
    return { status: 'unresolved', reason: isAbsent(error) ? 'remote_absent' : 'transport' }
  }
  if (remote.id !== record.opencodeSessionId || remote.title !== recovery.ownershipTitle) {
    return { status: 'unresolved', reason: 'remote_foreign' }
  }
  const info = message?.info ?? {}
  const separator = input.selectedModel.indexOf('/')
  const providerId = input.selectedModel.slice(0, separator)
  const modelId = input.selectedModel.slice(separator + 1)
  if (!hasExactOpenCodeMessageOwnership(message, bootstrap.messageID, record.opencodeSessionId)
    || readMessageText(message) !== input.expectedBootstrapText
    || (info.providerID ?? info.providerId) !== providerId
    || (info.modelID ?? info.modelId) !== modelId) {
    return { status: 'unresolved', reason: 'remote_mismatch' }
  }
  await input.upsert(record)
  return { status: 'recovered', linkage: exactLinkage, record }
}

function deterministicSessionId(targetDigest: string): string {
  return `ses_${targetDigest.slice(0, 26)}`
}

function deterministicOwnershipTitle(claim: OpenCodeLaunchMutationClaimRecord): string {
  return `agent-teams-launch:${claim.attemptId}:${claim.memberIdentity}:${
    createHash('sha256').update(claim.claimToken).digest('hex')}`
}

function hasExactCommittedRecordBinding(
  record: OpenCodeSessionRecord,
  input: Pick<OpenCodeCommittedMemberLinkageRecoveryInput,
    'teamId' | 'laneId' | 'memberName' | 'selectedModel' | 'expectedBootstrapText'>,
  sessionId: string,
): boolean {
  const bootstrap = record.appManagedBootstrap
  return record.teamId === input.teamId && record.laneId === input.laneId
    && record.memberName === input.memberName && record.providerId === 'opencode'
    && record.selectedModel === input.selectedModel && record.opencodeSessionId === sessionId
    && record.staleReason === null && record.bootstrapMode === 'app_managed_context'
    && record.bootstrapEvidenceSource === 'app_managed_bootstrap'
    && bootstrap?.schemaVersion === 1 && bootstrap.model === input.selectedModel
    && bootstrap.agent === 'teammate-bootstrap'
    && bootstrap.contextHash === createHash('sha256').update(input.expectedBootstrapText).digest('hex')
}

function sameBootstrapBinding(left: OpenCodeSessionRecord, right: OpenCodeSessionRecord): boolean {
  const leftBootstrap = left.appManagedBootstrap
  const rightBootstrap = right.appManagedBootstrap
  return !!leftBootstrap && !!rightBootstrap
    && leftBootstrap.schemaVersion === rightBootstrap.schemaVersion
    && leftBootstrap.messageID === rightBootstrap.messageID
    && leftBootstrap.contextHash === rightBootstrap.contextHash
    && leftBootstrap.briefingHash === rightBootstrap.briefingHash
    && leftBootstrap.model === rightBootstrap.model
    && leftBootstrap.agent === rightBootstrap.agent
}

function linkageForRecord(
  memberIdentity: OpenCodeOpaqueIdentity,
  record: OpenCodeSessionRecord,
): OpenCodeLaunchMemberLinkage | null {
  const bootstrap = record.appManagedBootstrap
  if (!bootstrap) return null
  return {
    memberIdentity,
    sessionIdentity: sessionIdentity(record.opencodeSessionId),
    bootstrapMessageIdentity: opaque({ kind: 'opencode-bootstrap', id: bootstrap.messageID }),
    commitIdentity: opaque({ kind: 'opencode-session-commit', teamId: record.teamId,
      laneId: record.laneId, memberName: record.memberName, sessionId: record.opencodeSessionId,
      messageID: bootstrap.messageID, contextHash: bootstrap.contextHash,
      briefingHash: bootstrap.briefingHash }),
  }
}

function sameLinkage(left: OpenCodeLaunchMemberLinkage, right: OpenCodeLaunchMemberLinkage): boolean {
  return left.memberIdentity === right.memberIdentity && left.sessionIdentity === right.sessionIdentity
    && left.bootstrapMessageIdentity === right.bootstrapMessageIdentity
    && left.commitIdentity === right.commitIdentity
}

function readMessageText(message: OpenCodeMessage): string {
  return (message.parts ?? []).filter(part => part.type === 'text')
    .map(part => typeof part.text === 'string' ? part.text : '').join('')
}

export async function createOpenCodeOwnedMemberSession<T>(input: {
  memberIdentity: OpenCodeOpaqueIdentity
  authoritativeSessionId: string
  registerRecord(): void
  registerOwned(resources: OpenCodeLaunchOwnedResources): void
  createSession(): Promise<T>
}): Promise<{ session: T; owned: OpenCodeLaunchOwnedResources }> {
  const owned = { memberIdentity: input.memberIdentity,
    sessionIdentity: sessionIdentity(input.authoritativeSessionId) }
  input.registerRecord(); input.registerOwned(owned)
  return { session: await input.createSession(), owned }
}
