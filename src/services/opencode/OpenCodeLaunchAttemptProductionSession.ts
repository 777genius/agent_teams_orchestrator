import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'

import type { OpenCodeLaunchOwnedResources } from './OpenCodeLaunchAttempt.js'
import type { OpenCodeLaunchMutationClaimRecord } from './OpenCodeLaunchMutationLedger.js'
import type { OpenCodeLaunchMemberLinkage, OpenCodeOpaqueIdentity } from './OpenCodeBridgeContractV2.js'
import type { OpenCodeMessage, OpenCodeSessionRecord, OpenCodeSessionSummary } from './types.js'

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

/**
 * Durable proof-generation ledger.  Every create is preceded by an active
 * generation record.  A later nonce can be registered only after the prior
 * exact id/title/host has been reconciled and atomically moved to `retired`.
 */
export class OpenCodeProofSessionCleanupLedger {
  constructor(private readonly filePath: string) {}

  async read(): Promise<OpenCodeProofSessionCleanupRecord | null> {
    const ledger = await this.readFile()
    return ledger?.active ? { version: 2, attemptId: ledger.attemptId, ...ledger.active } : null
  }

  async readGenerations(): Promise<ProofLedgerFile | null> { return this.readFile() }

  async reconcileAndRegister(input: {
    attemptId: string
    requestGeneration: number
    hostKeyIdentity: OpenCodeOpaqueIdentity
    ownership(generation: number): { authoritativeSessionId: string; ownershipTitle: string }
    reconcile(record: OpenCodeProofSessionCleanupRecord): Promise<OpenCodeOwnedSessionReconciliation>
  }): Promise<{ record: OpenCodeProofSessionCleanupRecord; created: boolean; priorOutcome?: OpenCodeOwnedSessionReconciliation }> {
    let ledger = await this.readFile()
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
      await this.write(ledger)
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
    await this.write(ledger)
    return { record: { version: 2, attemptId: ledger.attemptId, ...active }, created: true,
      ...(priorOutcome ? { priorOutcome } : {}) }
  }

  async recordState(
    expected: Pick<OpenCodeProofSessionCleanupRecord,
      'attemptId' | 'generation' | 'hostKeyIdentity' | 'authoritativeSessionId' | 'ownershipTitle'>,
    state: Exclude<OpenCodeProofSessionGenerationRecord['state'], 'registered'>,
  ): Promise<OpenCodeProofSessionCleanupRecord> {
    const ledger = await this.readFile()
    const current = ledger?.active
    if (!ledger || !current || ledger.attemptId !== expected.attemptId
      || current.generation !== expected.generation
      || current.hostKeyIdentity !== expected.hostKeyIdentity
      || current.authoritativeSessionId !== expected.authoritativeSessionId
      || current.ownershipTitle !== expected.ownershipTitle) {
      throw new Error('OpenCode proof cleanup ledger ownership mismatch')
    }
    const active = { ...current, state, updatedAt: new Date().toISOString() }
    await this.write({ ...ledger, active })
    return { version: 2, attemptId: ledger.attemptId, ...active }
  }

  private async readFile(): Promise<ProofLedgerFile | null> {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      if (isLegacyProofRecord(value)) {
        return { version: 2, attemptId: value.attemptId, active: {
          generation: 1, requestGeneration: 1, hostKeyIdentity: value.hostKeyIdentity,
          authoritativeSessionId: value.authoritativeSessionId, ownershipTitle: value.ownershipTitle,
          state: value.state, updatedAt: value.updatedAt,
        }, retired: [] }
      }
      validateProofLedger(value)
      return value
    } catch (error) {
      if (isAbsent(error)) return null
      throw error
    }
  }

  private async write(record: ProofLedgerFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`
    const temporary = await open(temporaryPath, 'wx', 0o600)
    try {
      try { await temporary.writeFile(`${JSON.stringify(record)}\n`, 'utf8'); await temporary.sync() }
      finally { await temporary.close() }
      await rename(temporaryPath, this.filePath)
    } catch (error) {
      await temporary.close().catch(() => undefined)
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
    let directory: Awaited<ReturnType<typeof open>> | undefined
    try { directory = await open(path.dirname(this.filePath), 'r'); await directory.sync() }
    catch (error) {
      if (!['EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM']
        .includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    } finally { await directory?.close().catch(() => undefined) }
  }
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
    && ['registered', 'owned', 'absent', 'deleted', 'foreign', 'unresolved'].includes(String(record.state))
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

/** Verify an exact committed claim before repairing its non-authoritative session projection. */
export async function recoverOpenCodeCommittedMemberProjection(input: {
  claim: OpenCodeLaunchMutationClaimRecord
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
  const expectedTitle = `agent-teams-launch:${input.claim.attemptId}:${input.claim.memberIdentity}:${
    createHash('sha256').update(input.claim.claimToken).digest('hex')}`
  const bootstrap = record.appManagedBootstrap
  if (recovery.ownershipTitle !== expectedTitle || record.teamId !== input.teamId
    || (record.laneId ?? 'primary') !== input.laneId || record.memberName !== input.memberName
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
  if (!message || info.id !== bootstrap.messageID || readMessageText(message) !== input.expectedBootstrapText
    || (info.providerID ?? info.providerId) !== providerId
    || (info.modelID ?? info.modelId) !== modelId) {
    return { status: 'unresolved', reason: 'remote_mismatch' }
  }
  const linkage: OpenCodeLaunchMemberLinkage = {
    memberIdentity: input.claim.memberIdentity,
    sessionIdentity: sessionIdentity(record.opencodeSessionId),
    bootstrapMessageIdentity: opaque({ kind: 'opencode-bootstrap', id: bootstrap.messageID }),
    commitIdentity: opaque({ kind: 'opencode-session-commit', teamId: record.teamId,
      laneId: record.laneId ?? 'primary', memberName: record.memberName,
      sessionId: record.opencodeSessionId, messageID: bootstrap.messageID,
      contextHash: bootstrap.contextHash, briefingHash: bootstrap.briefingHash }),
  }
  if (JSON.stringify(linkage) !== JSON.stringify(input.claim.linkage)) {
    return { status: 'unresolved', reason: 'claim_metadata' }
  }
  await input.upsert(record)
  return { status: 'recovered', linkage, record }
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
