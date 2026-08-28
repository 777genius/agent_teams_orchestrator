import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'

import { openCodeClientFactory as globalThisOpenCodeClientFactory } from './OpenCodeClientFactory.js'
import { openCodeHostManager as globalThisOpenCodeHostManager } from './OpenCodeHostManager.js'
import { OPEN_CODE_APP_MCP_SERVER_NAME,
  openCodeMcpManager as globalThisOpenCodeMcpManager } from './OpenCodeMcpManager.js'
import { resolveClaudeMultimodelPaths } from './OpenCodeManagedPaths.js'
import { openCodeProfileManager as globalThisOpenCodeProfileManager } from './OpenCodeProfileManager.js'
import { openCodeSessionStore as globalThisOpenCodeSessionStore } from './OpenCodeSessionStore.js'
import {
  OpenCodeLaunchAttempt,
  DeadlineError,
  OpenCodeOperationHostAcquisitionCleanupError,
  OpenCodeOperationHostAcquisitionSettledError,
  computeOpenCodeLaunchAttemptInputDigest,
  computeOpenCodeLaunchAttemptImmutableDigest,
  createOpenCodeLaunchAttemptResult,
  createOpenCodeLaunchDesktopResponse,
  validateOpenCodeDurableFinalResponse,
  validateOpenCodeLaunchContinuation,
  type OpenCodeLaunchAttemptPorts,
  type OpenCodeLaunchAttemptResult,
  type OpenCodeLaunchProfile,
} from './OpenCodeLaunchAttempt.js'
import { createOpenCodeLaunchAttemptProductionBridge } from './OpenCodeLaunchAttemptProductionComposition.js'
import type { OpenCodeLaunchAttemptBridgePort, OpenCodeBridgeCommandHandlerPorts } from './OpenCodeLaunchAttemptBridge.js'
import {
  computeOpenCodeLaunchCommandInputDigest,
  computeOpenCodeLaunchCommandImmutableDigest,
  getOpenCodeLaunchAttemptProductionPorts,
  installOpenCodeLaunchAttemptPortsForProduction,
} from './OpenCodeLaunchAttemptBridge.js'
import {
  OpenCodeLaunchAttemptStore,
  OpenCodeLaunchFileJournalPersistence,
  type OpenCodeLaunchJournal,
  type OpenCodeLaunchStoreContext,
  type OpenCodeMemberCleanupObligation,
  type OpenCodeMemberCleanupPhase,
} from './OpenCodeLaunchAttemptStore.js'
import type {
  OpenCodeLaunchAttemptResponse,
  OpenCodeLaunchMemberLinkage,
  OpenCodeOpaqueIdentity,
  OpenCodeRetainedHostIdentity,
} from './OpenCodeBridgeContractV2.js'
import type {
  OpenCodeHostHandle,
  OpenCodeMessage,
  OpenCodeProvisioningSnapshot,
  OpenCodeScopedPreparedProfile,
  OpenCodeSessionRecord,
} from './types.js'
import type { OpenCodeHostReferenceCapability } from './OpenCodeHostManager.js'
import { computeOpenCodeHostReleaseObligationIdentityDigest } from './OpenCodeHostManager.js'
import { openCodeMonotonicNow } from './OpenCodeRuntimeDeadline.js'
import {
  OpenCodeLaunchMutationLedger,
  type OpenCodeLaunchMutationClaimRecord,
  type OpenCodeLaunchMutationIdentity,
} from './OpenCodeLaunchMutationLedger.js'
import { normalizeOpenCodeLogicalMemberIdentity } from './OpenCodeLogicalMemberKey.js'
import {
  hydrateOpenCodeRecoveredSessionLease,
  OpenCodeLaunchRetainedHostLeases,
  readOpenCodeExactMessageText,
} from './OpenCodeLaunchProductionGuards.js'
import {
  createOpenCodeOwnedMemberSession,
  commitOpenCodeMemberProjection,
  OpenCodeProofSessionCleanupLedger,
  recoverOpenCodeCommittedMemberLinkage,
  recoverOpenCodeCommittedMemberProjection,
  reconcileOpenCodeOwnedMemberSession,
  type OpenCodeOwnedSessionReconciliation,
  type OpenCodeProofSessionCleanupRecord,
} from './OpenCodeLaunchAttemptProductionSession.js'
import {
  authorizeOpenCodeLaunchScopedProfile,
  prepareAuthorizedOpenCodeLaunchScopedProfile,
  type OpenCodeAuthorizedScopedProfilePlan,
  type OpenCodePlanScopedProfileManagerPort,
} from './OpenCodePlanScopedProfile.js'
import { runOpenCodeMutationWithFreshProof } from './OpenCodeLaunchProofMutationPolicy.js'
import { hasExactOpenCodeMessageOwnership } from './OpenCodeMessageOwnership.js'
import {
  OpenCodeLaunchHostReleaseLedger,
  type OpenCodeLaunchHostAcquisitionObligation,
  type OpenCodeLaunchHostCleanupRecord,
  type OpenCodeLaunchHostLedgerContext,
  type OpenCodeLaunchHostReleaseRecord,
} from './OpenCodeLaunchHostReleaseLedger.js'

export { OpenCodeLaunchHostReleaseLedger } from './OpenCodeLaunchHostReleaseLedger.js'

type Command = Parameters<OpenCodeLaunchAttemptBridgePort['execute']>[0]

function isOpenCodeLaunchHostAcquisitionObligation(
  record: OpenCodeLaunchHostCleanupRecord,
): record is OpenCodeLaunchHostAcquisitionObligation {
  return record.receipt === null && record.receiptIdentityDigest === null
    && record.disposition === 'unknown' && record.releaseState === 'pending'
}

export function assertOpenCodeProductionBootstrapOwnership(input: Readonly<{
  message: OpenCodeMessage | null | undefined
  messageId: string
  sessionId: string
  phase: 'returned' | 'persisted'
}>): OpenCodeMessage {
  if (!hasExactOpenCodeMessageOwnership(input.message, input.messageId, input.sessionId)) {
    throw new Error(`OpenCode noReply bootstrap ${input.phase} ownership verification failed`)
  }
  return input.message
}

export async function resolveOpenCodeProductionRetainedProofRecord(input: Readonly<{
  cached?: OpenCodeProofSessionCleanupRecord
  ledger: Pick<OpenCodeProofSessionCleanupLedger, 'read'>
  attemptId: string
  requestGeneration: number
  hostKeyIdentity: OpenCodeOpaqueIdentity
  deadlineAtMs: number
  signal: AbortSignal
}>): Promise<OpenCodeProofSessionCleanupRecord> {
  const retainedProof = input.cached ?? await input.ledger.read({
    deadlineAtMs: input.deadlineAtMs, signal: input.signal,
  })
  if (!retainedProof || retainedProof.attemptId !== input.attemptId
    || retainedProof.requestGeneration !== input.requestGeneration
    || retainedProof.hostKeyIdentity !== input.hostKeyIdentity
    || !retainedProof.observationMessageId || retainedProof.state !== 'owned') {
    throw new Error('OpenCode retained proof is unavailable')
  }
  return retainedProof
}

export function deriveOpenCodeProductionProofOwnership(input: Readonly<{
  attemptId: string
  requestGeneration: number
  proofGeneration: number
  hostKeyIdentity: OpenCodeOpaqueIdentity
}>): Readonly<{ authoritativeSessionId: string; ownershipTitle: string }> {
  const marker = createHash('sha256').update(JSON.stringify({
    kind: 'launch-proof-ownership-v2',
    attemptId: input.attemptId,
    requestGeneration: input.requestGeneration,
    proofGeneration: input.proofGeneration,
    hostKeyIdentity: input.hostKeyIdentity,
  })).digest('hex')
  return {
    authoritativeSessionId: `ses_${marker.slice(0, 26)}`,
    ownershipTitle: `agent-teams-proof:${input.attemptId}:${input.proofGeneration}:${marker}`,
  }
}

/** Re-observe the exact persisted proof owner and message before retained proof can authorize work. */
export async function reobserveOpenCodeProductionRetainedProof(input: Readonly<{
  retainedProof: OpenCodeProofSessionCleanupRecord
  getSession(id: string): Promise<{ id: string; title?: string }>
  getSessionMessage(id: string, messageId: string): Promise<OpenCodeMessage | null>
}>): Promise<OpenCodeMessage> {
  const retained = input.retainedProof
  const expectedOwnership = deriveOpenCodeProductionProofOwnership({
    attemptId: retained.attemptId,
    requestGeneration: retained.requestGeneration,
    proofGeneration: retained.generation,
    hostKeyIdentity: retained.hostKeyIdentity,
  })
  if (retained.state !== 'owned' || !retained.observationMessageId
    || retained.authoritativeSessionId !== expectedOwnership.authoritativeSessionId
    || retained.ownershipTitle !== expectedOwnership.ownershipTitle) {
    throw new Error('OpenCode retained proof ownership marker mismatched')
  }
  const observedSession = await input.getSession(retained.authoritativeSessionId)
  if (observedSession.id !== retained.authoritativeSessionId
    || observedSession.title !== retained.ownershipTitle) {
    throw new Error('OpenCode retained proof session ownership changed')
  }
  const observedMessage = await input.getSessionMessage(
    retained.authoritativeSessionId, retained.observationMessageId)
  const info = observedMessage?.info ?? {}
  if (!observedMessage || info.id !== retained.observationMessageId) {
    throw new Error('OpenCode retained proof message identity changed')
  }
  if (!hasExactOpenCodeMessageOwnership(observedMessage, retained.observationMessageId,
    retained.authoritativeSessionId)) {
    throw new Error('OpenCode retained proof message session changed')
  }
  return observedMessage
}

/** Pure Desktop V1 projection used by production and fake-only contract tests. */
export function projectOpenCodeLaunchAttemptResponse(
  result: OpenCodeLaunchAttemptResult,
): OpenCodeLaunchAttemptResponse | undefined {
  return createOpenCodeLaunchDesktopResponse(result)
}

export function createOpenCodeLaunchPreflightResult(input: {
  attemptId: string
  payloadHash: string
  immutableDigest: string
  generation: number
  reconciliationRequired: boolean
  committed: OpenCodeLaunchMemberLinkage[]
  pending: OpenCodeOpaqueIdentity[]
  deadlineAtMs: number
}): OpenCodeLaunchAttemptResult {
  return createOpenCodeLaunchAttemptResult({
    attemptId: input.attemptId,
    payloadHash: input.payloadHash,
    immutableDigest: input.immutableDigest,
    inputDigest: input.payloadHash,
    generation: input.generation,
    status: input.reconciliationRequired ? 'reconciliation_required' : 'succeeded',
    committed: input.committed,
    failed: [],
    pending: input.pending,
    cleanupPending: [],
    cleanup: 'complete',
    absoluteDeadlineAtMs: input.deadlineAtMs,
    workDeadlineAtMs: input.deadlineAtMs,
  })
}

/** Exact production mapping from core cancellation evidence to the global mutation authority. */
export function transitionOpenCodeProductionMemberClaim(
  ledger: OpenCodeLaunchMutationLedger,
  targetDigest: string,
  input: OpenCodeLaunchMutationIdentity & (
    | { transition: 'cancel'; provenNoExternalEffect?: true }
    | { transition: 'commit'; linkage: OpenCodeLaunchMemberLinkage; recovery?: Parameters<OpenCodeLaunchMutationLedger['transition']>[5] }
  ),
  context: OpenCodeLaunchStoreContext,
): ReturnType<OpenCodeLaunchMutationLedger['transition']> {
  return ledger.transition(targetDigest, input,
    input.transition === 'commit' ? 'commit'
      : input.provenNoExternalEffect ? 'known_failure' : 'unknown',
    input.transition === 'commit' ? input.linkage : undefined,
    context,
    input.transition === 'commit' ? input.recovery : undefined)
}

/** Resolve external-effect identity only from the exact durable claim installed by the ledger. */
export async function readOpenCodeProductionMemberClaim(
  ledger: OpenCodeLaunchMutationLedger,
  targetDigest: string,
  input: OpenCodeLaunchMutationIdentity,
  context: OpenCodeLaunchStoreContext,
): Promise<OpenCodeLaunchMutationClaimRecord | null> {
  const claim = await ledger.read(targetDigest, context)
  if (!claim || claim.state !== 'claimed'
    || claim.attemptId !== input.attemptId || claim.payloadHash !== input.payloadHash
    || claim.inputDigest !== input.inputDigest || claim.immutableDigest !== input.immutableDigest
    || claim.generation !== input.generation || claim.fence !== input.fence
    || claim.acquisitionToken !== input.acquisitionToken || claim.claimToken !== input.claimToken
    || claim.memberIdentity !== input.memberIdentity
    || OpenCodeLaunchMutationLedger.targetDigest(input.logicalMember) !== targetDigest) return null
  return claim
}

export function inspectOpenCodeProductionGeneration(
  journal: Pick<NonNullable<Awaited<ReturnType<OpenCodeLaunchAttemptStore['inspect']>>>,
    'generation' | 'inputDigest' | 'continuation' | 'consumedContinuationToken'>,
  request: Readonly<{
    generation: number
    inputDigest: string
    continuation: boolean
    continuationToken?: string
  }>,
): 'replay' | 'continue' {
  if (request.generation === journal.generation) {
    if (request.inputDigest !== journal.inputDigest) {
      throw new Error('OpenCode durable command ledger generation input mismatch')
    }
    if (journal.generation === 1) {
      if (request.continuation || request.continuationToken !== undefined) {
        throw new Error('OpenCode durable command ledger continuation mode mismatch')
      }
    } else if (!journal.consumedContinuationToken
      || !request.continuation
      || request.continuationToken !== journal.consumedContinuationToken) {
      throw new Error('OpenCode durable command ledger consumed continuation mismatch')
    }
    return 'replay'
  }
  if (request.generation === journal.generation + 1
    && request.continuation
    && journal.continuation
    && journal.continuation.issuedGeneration === journal.generation
    && request.continuationToken === journal.continuation.token) return 'continue'
  throw new Error('OpenCode durable command ledger generation mismatch')
}

/** A remote cleanup is authorized only by the exact, latest journaled mutation intent. */
export function hasExactOpenCodeClaimReconciliationAuthority(
  journal: Pick<OpenCodeLaunchJournal,
    'acceptedProofResponse' | 'generation' | 'fence' | 'inputDigest' | 'immutableDigest' | 'events'> | null,
  exactCurrentGeneration: boolean,
  claim: OpenCodeLaunchMutationClaimRecord,
): boolean {
  if (!journal?.acceptedProofResponse || !exactCurrentGeneration
    || claim.generation !== journal.generation
    || claim.fence !== journal.fence
    || claim.inputDigest !== journal.inputDigest
    || claim.immutableDigest !== journal.immutableDigest
    || !claim.claimToken.startsWith(`${claim.acquisitionToken}.`)) return false
  const latest = journal.events.findLast(event => event.memberIdentity === claim.memberIdentity)
  return latest?.type === 'member_intent'
    && latest.generation === claim.generation
    && latest.fence === claim.fence
    && latest.inputDigest === claim.inputDigest
    && latest.claimToken === claim.claimToken
}

function opaque(value: unknown): OpenCodeOpaqueIdentity {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
    || (error instanceof Error && error.message.includes('(404 '))
}

async function fileFingerprint(filePath: string): Promise<string | null> {
  try { return createHash('sha256').update(await readFile(filePath)).digest('hex') }
  catch { return null }
}

async function pathIdentity(targetPath: string): Promise<string | null> {
  try {
    const [canonicalPath, stat] = await Promise.all([realpath(targetPath), lstat(targetPath)])
    return createHash('sha256').update(JSON.stringify({ canonicalPath, dev: stat.dev,
      ino: stat.ino, mode: stat.mode, kind: stat.isDirectory() ? 'directory' : 'file' })).digest('hex')
  } catch { return null }
}

async function immutableTreeFingerprint(root: string): Promise<string | null> {
  try {
    const hash = createHash('sha256')
    let count = 0
    const visit = async (directory: string, relative: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        if (++count > 10_000) throw new Error('immutable artifact tree is too large')
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name
        const child = path.join(directory, entry.name)
        hash.update(JSON.stringify([childRelative, entry.isDirectory(), entry.isFile(), entry.isSymbolicLink()]))
        if (entry.isDirectory()) await visit(child, childRelative)
        else if (entry.isFile()) hash.update(await readFile(child))
        else throw new Error('immutable artifact tree contains a non-file entry')
      }
    }
    await visit(root, '')
    return hash.digest('hex')
  } catch { return null }
}

function modelParts(selectedModel: string): { providerID: string; modelID: string } {
  const separator = selectedModel.indexOf('/')
  if (separator <= 0 || separator === selectedModel.length - 1) {
    throw new Error('OpenCode launch-attempt model must be provider-scoped')
  }
  return { providerID: selectedModel.slice(0, separator), modelID: selectedModel.slice(separator + 1) }
}

function messageIdentity(message: { info?: Record<string, unknown> }): OpenCodeOpaqueIdentity {
  const id = message.info?.id
  if (typeof id !== 'string' || !id) throw new Error('OpenCode proof response has no message identity')
  return opaque({ kind: 'opencode-message', id })
}

function bootstrapText(command: Command, memberName: string, sessionId: string, prompt?: string): string {
  return [
    '<agent_teams_app_managed_bootstrap>',
    'AGENT_TEAMS_APP_MANAGED_BOOTSTRAP_V1',
    JSON.stringify({ teamName: command.teamId, memberName, runtimeProvider: 'opencode',
      runtimeSessionId: sessionId, runId: command.runId, laneId: command.laneId }),
    prompt ?? `Join OpenCode team ${command.teamId} as ${memberName}. Wait for app MCP task delivery.`,
    '</agent_teams_app_managed_bootstrap>',
  ].join('\n')
}

function launchMonotonicNow(): number {
  return openCodeMonotonicNow()
}

/**
 * Durable order: prove/delete the exact owned remote session; tombstone only
 * its exact local projection; release the exact session lease; delete only
 * that projection; then complete the obligation. The journal advances after
 * each successful phase, so a crash retains the host/session capability and
 * replay repeats at most the one effect whose outcome was not durably recorded.
 */
export async function reconcileOpenCodeMemberCleanupObligations(input: Readonly<{
  obligations: readonly OpenCodeMemberCleanupObligation[]
  deadlineAtMs: number
  signal: AbortSignal
  monotonicNow(): number
  reconcileRemote(obligation: OpenCodeMemberCleanupObligation):
    Promise<OpenCodeOwnedSessionReconciliation>
  readProjection(obligation: OpenCodeMemberCleanupObligation):
    Promise<{ sessionId: string; runId: string | null } | null>
  markProjectionStale(obligation: OpenCodeMemberCleanupObligation): Promise<'satisfied' | 'foreign'>
  releaseLease(obligation: OpenCodeMemberCleanupObligation): Promise<void>
  deleteProjection(obligation: OpenCodeMemberCleanupObligation): Promise<'satisfied' | 'foreign'>
  advance(obligation: OpenCodeMemberCleanupObligation, phase: OpenCodeMemberCleanupPhase): Promise<void>
  completed(obligation: OpenCodeMemberCleanupObligation): void
}>): Promise<'complete' | 'timed_out'> {
  for (const initial of input.obligations) {
    let obligation = initial
    const advance = async (phase: OpenCodeMemberCleanupPhase): Promise<void> => {
      await input.advance(obligation, phase)
      obligation = { ...obligation, phase }
    }
    try {
      // A legacy obligation without the run half of the owner capability is
      // not safe to replay. Session ids are deterministic, so every cleanup
      // effect (including remote deletion) must remain pending until the exact
      // run is known rather than acting on a replacement run's session.
      if (!obligation.runId) return 'timed_out'
      while (obligation.phase !== 'complete') {
        if (input.signal.aborted || input.monotonicNow() >= input.deadlineAtMs) return 'timed_out'
        if (obligation.phase === 'remote') {
          const remote = await input.reconcileRemote(obligation)
          if (remote === 'foreign' || remote === 'unresolved') return 'timed_out'
          await advance('projection_stale')
        } else if (obligation.phase === 'projection_stale') {
          const projection = await input.readProjection(obligation)
          if (projection?.sessionId === obligation.sessionId) await input.markProjectionStale(obligation)
          await advance('lease_release')
        } else if (obligation.phase === 'lease_release') {
          await input.releaseLease(obligation)
          await advance('projection_delete')
        } else if (obligation.phase === 'projection_delete') {
          const projection = await input.readProjection(obligation)
          if (projection?.sessionId === obligation.sessionId) {
            const disposition = await input.deleteProjection(obligation)
            if (disposition === 'satisfied') {
              const retained = await input.readProjection(obligation)
              if (retained?.sessionId === obligation.sessionId
                && retained.runId === obligation.runId) return 'timed_out'
            }
          }
          await advance('obligation_complete')
        } else {
          await advance('complete')
        }
      }
      input.completed(obligation)
    } catch {
      return 'timed_out'
    }
  }
  return input.monotonicNow() <= input.deadlineAtMs ? 'complete' : 'timed_out'
}

async function bounded<T>(operation: Promise<T>, deadlineAtMs: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted || launchMonotonicNow() >= deadlineAtMs) throw new DeadlineError('OpenCode launch deadline expired')
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const boundary = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError('OpenCode launch deadline expired')),
      Math.max(0, deadlineAtMs - launchMonotonicNow()))
    onAbort = () => reject(signal.reason ?? new DeadlineError('OpenCode launch cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([operation, boundary]) }
  finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

function absoluteCleanupContext(deadlineAtMs: number): Readonly<{
  context: OpenCodeLaunchHostLedgerContext
  close: () => void
}> {
  const controller = new AbortController()
  const remainingMs = Math.max(0, deadlineAtMs - launchMonotonicNow())
  let timer: ReturnType<typeof setTimeout> | undefined
  if (remainingMs === 0) {
    controller.abort(new DeadlineError('OpenCode launch cleanup deadline expired'))
  } else {
    timer = setTimeout(() => {
      controller.abort(new DeadlineError('OpenCode launch cleanup deadline expired'))
    }, remainingMs)
    timer.unref?.()
  }
  return {
    context: { deadlineAtMs, signal: controller.signal },
    close: () => { if (timer) clearTimeout(timer) },
  }
}

/** Concrete production adapter. */
export type OpenCodeProductionLaunchRuntimeTestDependencies = Readonly<{
  clientFactory?: typeof globalThisOpenCodeClientFactory
  hostManager?: typeof globalThisOpenCodeHostManager
  mcpManager?: typeof globalThisOpenCodeMcpManager
  profileManager?: typeof globalThisOpenCodeProfileManager
  sessionStore?: typeof globalThisOpenCodeSessionStore
  dataDirectory?: string
  crashBoundary?: (boundary: 'after_host_receipt_publication' | 'before_host_disposition_publication') => void
}>

class OpenCodeProductionLaunchRuntime {
  private readonly authorizedPlans = new WeakMap<object, OpenCodeAuthorizedScopedProfilePlan>()
  private readonly completedResults = new WeakMap<object, OpenCodeLaunchAttemptResult>()

  constructor(private readonly dependencies: OpenCodeProductionLaunchRuntimeTestDependencies = {}) {}

  async preflightAuthorization(command: Command, controls: Readonly<{
    signal: AbortSignal; deadlineAtMs: number; remainingMs(): number
  }>): Promise<void> {
    const projectIdentity = command.projectIdentity
    if (!projectIdentity) throw new Error('OpenCode canonical launch project identity is absent')
    const launchDirectory = path.join(this.dependencies.dataDirectory ?? resolveClaudeMultimodelPaths().data,
      'opencode', 'launch-attempts')
    const journalPath = path.join(launchDirectory, `${command.request.launchAttempt.attemptId}.journal`)
    const attemptPersistence = new OpenCodeLaunchFileJournalPersistence(journalPath)
    const attemptStore = new OpenCodeLaunchAttemptStore(attemptPersistence)
    const hostReleaseLedger = OpenCodeLaunchHostReleaseLedger.production(
      attemptPersistence.createRelativePersistence(path.join(launchDirectory,
        `${command.request.launchAttempt.attemptId}.host-release.json`)),
    )
    const identity = {
      attemptId: command.request.launchAttempt.attemptId,
      payloadHash: command.request.launchAttempt.payloadHash,
    }
    const context = { deadlineAtMs: controls.deadlineAtMs, signal: controls.signal,
      monotonicNow: launchMonotonicNow }
    const firstJournal = await attemptStore.snapshotReadOnly(identity, context)
    const obligations = await hostReleaseLedger.snapshotAll({ ...identity,
      currentGeneration: command.request.launchAttempt.generation }, context)
    const secondJournal = await attemptStore.snapshotReadOnly(identity, context)
    if (JSON.stringify(secondJournal) !== JSON.stringify(firstJournal)) {
      throw new Error('OpenCode launch journal changed during pre-authorization cleanup snapshot')
    }

    const records = obligations.filter(
      (record): record is OpenCodeLaunchHostReleaseRecord => record.receipt !== null)
    const bindings = firstJournal?.hostCleanupObligations
    const exactBoundSet = bindings !== undefined
      && obligations.length === bindings.length
      && obligations.every(record => {
        if (!record.receipt || record.receiptIdentityDigest === null
          || record.generation !== firstJournal!.generation) return false
        const binding = bindings.find(item => item.obligationId === record.obligationId)
        return binding?.reservationDigest === record.reservationDigest
          && binding.receiptIdentityDigest === record.receiptIdentityDigest
      })
    const exactCurrentMode = firstJournal !== null
      && command.request.launchAttempt.generation === firstJournal.generation
      && (firstJournal.generation === 1
        ? !command.continuation && command.request.launchAttempt.continuationToken === undefined
        : command.continuation
          && command.request.launchAttempt.continuationToken === firstJournal.consumedContinuationToken)
    const hostManager = this.dependencies.hostManager ?? globalThisOpenCodeHostManager
    const unsafe = records.some(record => {
      if (record.releaseState !== 'pending' || record.receipt.schemaVersion !== 1) return false
      const binding = bindings?.find(item => item.obligationId === record.obligationId)
      return !(firstJournal?.finalResponse
        && exactCurrentMode
        && firstJournal.cleanupState === 'incomplete'
        && firstJournal.finalResponse.members.cleanupPending.length === 0
        && exactBoundSet
        && record.generation === firstJournal.generation
        && binding?.reservationDigest === record.reservationDigest
        && binding.receiptIdentityDigest === record.receiptIdentityDigest
        && hostManager.hasExactRetainedHostReleaseCapability(record.receipt))
    })
    if (unsafe) {
      throw new Error('OpenCode launch host cleanup requires exact retained generation authority')
    }
  }

  async authorize(command: Command, controls: Readonly<{
    signal: AbortSignal; deadlineAtMs: number; remainingMs(): number
  }>): Promise<Command> {
    const profileManager = (this.dependencies.profileManager ?? globalThisOpenCodeProfileManager) as unknown as OpenCodePlanScopedProfileManagerPort
    const authorization = await authorizeOpenCodeLaunchScopedProfile(
      profileManager,
      {
        purpose: 'launch', providerId: command.request.launchAttempt.providerId,
        modelId: command.selectedModel, runtimeInstanceId: command.request.launchAttempt.attemptId,
        projectPath: command.projectPath, abortSignal: controls.signal,
      },
    )
    if (authorization.input.evidence.projectBehaviorFingerprint
      !== command.preconditions.expectedBehaviorFingerprint) {
      throw new Error('OpenCode launch expected behavior fingerprint is stale')
    }
    const authorized = { ...command, effectiveProfilePlanDigest: authorization.effectivePlanDigest }
    this.authorizedPlans.set(authorized, authorization)
    return authorized
  }

  async inspect(command: Command, identity: Readonly<{
    attemptId: string; payloadHash: string; generation: number; inputDigest: string
  }>): Promise<Awaited<ReturnType<OpenCodeLaunchAttemptBridgePort['execute']>> | null> {
    if (identity.attemptId !== command.request.launchAttempt.attemptId
      || identity.payloadHash !== command.request.launchAttempt.payloadHash
      || identity.generation !== command.request.launchAttempt.generation
      || identity.inputDigest !== computeOpenCodeLaunchCommandInputDigest(command)) {
      throw new Error('OpenCode durable command ledger inspection identity mismatch')
    }
    return this.run(command, false, true)
  }

  async executeAfterPreflight(command: Command): Promise<{
    output: Awaited<ReturnType<OpenCodeLaunchAttemptBridgePort['execute']>>
    result: OpenCodeLaunchAttemptResult
  }> {
    const output = await this.run(command, true, false)
    if (!output) throw new Error('OpenCode production launch result projection is absent')
    const result = this.completedResults.get(command)
    if (!result) throw new Error('OpenCode production launch result projection is absent')
    return { output, result }
  }

  private async run(command: Command, skipPreflight: boolean, inspectionOnly: boolean):
  Promise<Awaited<ReturnType<OpenCodeLaunchAttemptBridgePort['execute']>> | null> {
    const openCodeClientFactory = this.dependencies.clientFactory ?? globalThisOpenCodeClientFactory
    const openCodeHostManager = this.dependencies.hostManager ?? globalThisOpenCodeHostManager
    const openCodeMcpManager = this.dependencies.mcpManager ?? globalThisOpenCodeMcpManager
    const openCodeProfileManager = this.dependencies.profileManager ?? globalThisOpenCodeProfileManager
    const openCodeSessionStore = this.dependencies.sessionStore ?? globalThisOpenCodeSessionStore
    const projectIdentity = command.projectIdentity
    if (!projectIdentity) throw new Error('OpenCode canonical launch project identity is absent')
    const profiles = new Map<OpenCodeOpaqueIdentity, OpenCodeScopedPreparedProfile>()
    const hosts = new Map<OpenCodeOpaqueIdentity, OpenCodeHostHandle>()
    const hostReferences = new Map<OpenCodeOpaqueIdentity, OpenCodeHostReferenceCapability>()
    const hostAcquisitionObligations = new Map<string, OpenCodeLaunchHostCleanupRecord>()
    const records = new Map<OpenCodeOpaqueIdentity, OpenCodeSessionRecord>()
    const memberOwnershipTitles = new Map<OpenCodeOpaqueIdentity, string>()
    const proofSessions = new Map<OpenCodeOpaqueIdentity, OpenCodeProofSessionCleanupRecord>()
    let currentSnapshot: OpenCodeProvisioningSnapshot | null = null
    const launchDirectory = path.join(this.dependencies.dataDirectory ?? resolveClaudeMultimodelPaths().data,
      'opencode', 'launch-attempts')
    const journalPath = path.join(launchDirectory, `${command.request.launchAttempt.attemptId}.journal`)
    const attemptPersistence = new OpenCodeLaunchFileJournalPersistence(journalPath)
    const mutationLedger = new OpenCodeLaunchMutationLedger(path.join(launchDirectory, 'member-claims'),
      filePath => attemptPersistence.createRelativePersistence(filePath))
    const proofCleanupLedger = new OpenCodeProofSessionCleanupLedger(
      path.join(launchDirectory, `${command.request.launchAttempt.attemptId}.proof-cleanup.json`),
    )
    const hostReleaseLedger = OpenCodeLaunchHostReleaseLedger.production(
      attemptPersistence.createRelativePersistence(path.join(launchDirectory,
        `${command.request.launchAttempt.attemptId}.host-release.json`)),
    )
    const attemptStore = new OpenCodeLaunchAttemptStore(attemptPersistence)
    const requestedBudgetMs = command.deadlineAtMs === undefined
      ? command.outerRemainingBudgetMs ?? command.requestedBudgetMs : command.requestedBudgetMs
    const effectiveBudgetMs = Math.min(requestedBudgetMs, 300_000)
    const productionDeadlineAtMs = command.deadlineAtMs
      ?? (launchMonotonicNow() + (command.outerRemainingBudgetMs ?? effectiveBudgetMs))
    const commandInputDigest = computeOpenCodeLaunchCommandInputDigest(command)
    const inputDigest = computeOpenCodeLaunchAttemptInputDigest(command.request,
      command.members.map(member => member.memberIdentity), command.continuation ? 'continue' : 'begin',
      requestedBudgetMs, effectiveBudgetMs, commandInputDigest)
    const immutableDigest = computeOpenCodeLaunchAttemptImmutableDigest(command.request,
      command.members.map(member => member.memberIdentity), requestedBudgetMs,
      effectiveBudgetMs,
      computeOpenCodeLaunchCommandImmutableDigest(command))
    validateOpenCodeLaunchContinuation({
      attemptId: command.request.launchAttempt.attemptId,
      payloadHash: command.request.launchAttempt.payloadHash,
      generation: command.request.launchAttempt.generation,
      immutableDigest,
      continuation: command.continuation,
      continuationToken: command.request.launchAttempt.continuationToken,
    })
    const logicalMemberByIdentity = new Map(command.members.map(member => [member.memberIdentity,
      normalizeOpenCodeLogicalMemberIdentity({
        teamId: command.teamId, laneId: command.laneId, projectIdentity, memberName: member.name,
      })]))
    const targetByMember = new Map(command.members.map(member => [member.memberIdentity,
      OpenCodeLaunchMutationLedger.targetDigest(logicalMemberByIdentity.get(member.memberIdentity)!)]))
    // Recovery populates this set before any incomplete host receipt is
    // reconciled. A restart must not dispose a persistent host which already
    // serves a committed durable member.
    const retainedSessionLeases = new OpenCodeLaunchRetainedHostLeases()
    const linkageFor = (memberIdentity: OpenCodeOpaqueIdentity, record: OpenCodeSessionRecord):
    OpenCodeLaunchMemberLinkage | null => {
      const messageID = record.appManagedBootstrap?.messageID
      if (!messageID || record.staleReason) return null
      return {
        memberIdentity,
        sessionIdentity: opaque({ kind: 'opencode-session', id: record.opencodeSessionId }),
        bootstrapMessageIdentity: opaque({ kind: 'opencode-bootstrap', id: messageID }),
        commitIdentity: opaque({ kind: 'opencode-session-commit', teamId: record.teamId,
          laneId: record.laneId ?? 'primary', memberName: record.memberName,
          sessionId: record.opencodeSessionId, messageID,
          contextHash: record.appManagedBootstrap?.contextHash,
          briefingHash: record.appManagedBootstrap?.briefingHash }),
      }
    }
    if (!skipPreflight) {
    // Global mutation authority is consulted before profile preparation (which
    // writes scoped files), host acquisition, proof, or member effects.  A
    // claimed/unknown remote effect is reconciliation-only; an exact completed
    // command is projected from the authoritative session store.
    const preflightDeadlineAtMs = productionDeadlineAtMs
    const preflightSignal = command.signal ?? new AbortController().signal
    const preflightLedgerContext = { deadlineAtMs: preflightDeadlineAtMs, signal: preflightSignal,
      monotonicNow: launchMonotonicNow }
    const readOnlyIdentity = {
      attemptId: command.request.launchAttempt.attemptId,
      payloadHash: command.request.launchAttempt.payloadHash,
      immutableDigest,
    }
    const readOnlyContext = { deadlineAtMs: preflightDeadlineAtMs,
      signal: preflightSignal, monotonicNow: launchMonotonicNow }
    const readOnlyJournal = await attemptStore.snapshotReadOnly(readOnlyIdentity, readOnlyContext)
    let readOnlyExactCurrentGeneration = false
    if (readOnlyJournal) {
      readOnlyExactCurrentGeneration = inspectOpenCodeProductionGeneration(readOnlyJournal, {
        generation: command.request.launchAttempt.generation,
        inputDigest,
        continuation: command.continuation,
        continuationToken: command.request.launchAttempt.continuationToken,
      }) === 'replay'
    }
    // Classify every current or predecessor host obligation from read-only
    // durable state before any final/continuation branch or member recovery.
    // A tokenless v1 receipt is actionable only while this exact manager still
    // retains its live receipt capability; reconstructed PID identity is never
    // sufficient authority on any platform.
    const inspectedHostObligations = await hostReleaseLedger.snapshotAll({
      attemptId: command.request.launchAttempt.attemptId,
      payloadHash: command.request.launchAttempt.payloadHash,
      currentGeneration: command.request.launchAttempt.generation,
    }, preflightLedgerContext)
    const confirmedReadOnlyJournal = await attemptStore.snapshotReadOnly(readOnlyIdentity, readOnlyContext)
    if (JSON.stringify(confirmedReadOnlyJournal) !== JSON.stringify(readOnlyJournal)) {
      throw new Error('OpenCode launch journal changed during read-only host cleanup snapshot')
    }
    const inspectedReleaseRecords = inspectedHostObligations.filter(
      (record): record is OpenCodeLaunchHostReleaseRecord => record.receipt !== null)
    const snapshotHasExactBoundObligationSet = !!readOnlyJournal?.hostCleanupObligations
      && inspectedHostObligations.length === readOnlyJournal.hostCleanupObligations.length
      && inspectedHostObligations.every(record => {
        if (!record.receipt || record.receiptIdentityDigest === null
          || record.generation !== readOnlyJournal.generation) return false
        const binding = readOnlyJournal.hostCleanupObligations!.find(
          item => item.obligationId === record.obligationId)
        return binding?.reservationDigest === record.reservationDigest
          && binding.receiptIdentityDigest === record.receiptIdentityDigest
      })
    const unsafeTokenlessObligation = inspectedReleaseRecords.find(record => {
      if (record.releaseState !== 'pending' || record.receipt.schemaVersion !== 1) return false
      const binding = readOnlyJournal?.hostCleanupObligations?.find(
        item => item.obligationId === record.obligationId)
      const exactRetainedIncompleteCapability = !!readOnlyJournal?.finalResponse
        && readOnlyExactCurrentGeneration
        && readOnlyJournal.cleanupState === 'incomplete'
        && readOnlyJournal.finalResponse.members.cleanupPending.length === 0
        && snapshotHasExactBoundObligationSet
        && record.generation === readOnlyJournal.generation
        && binding?.reservationDigest === record.reservationDigest
        && binding.receiptIdentityDigest === record.receiptIdentityDigest
        && openCodeHostManager.hasExactRetainedHostReleaseCapability(record.receipt)
      return !exactRetainedIncompleteCapability
    })
    if (unsafeTokenlessObligation) {
      if (!readOnlyJournal?.finalResponse || !readOnlyExactCurrentGeneration
        || readOnlyJournal.cleanupState !== 'incomplete') {
        throw new Error('OpenCode launch host cleanup requires exact retained generation authority')
      }
      const final = readOnlyJournal.finalResponse
      validateOpenCodeDurableFinalResponse(command.request, final, {
        inputDigest,
        immutableDigest,
        generation: command.request.launchAttempt.generation,
        acceptedProofResponse: readOnlyJournal.acceptedProofResponse,
        profileBinding: readOnlyJournal.profileBinding,
        members: command.members.map(member => member.memberIdentity),
      })
      const committedIds = new Set(final.members.committed.map(item => item.memberIdentity))
      const failedIds = new Set(final.members.failed.map(item => item.memberIdentity))
      return {
        snapshot: { detected: false, hostHealthy: false, projectPath: command.projectPath,
          profile: null, host: null, config: null, configProviders: null, providers: null,
          providerAuth: null, agents: [], mcp: null, appMcp: null,
          probeError: 'launch cleanup requires reconciliation', diagnostics: [] },
        data: { runId: command.runId, providerId: 'opencode', selectedModel: command.selectedModel,
          members: Object.fromEntries(command.members.map(member => [member.name, {
            launchState: committedIds.has(member.memberIdentity) ? 'created'
              : failedIds.has(member.memberIdentity) ? 'failed' : 'pending',
            evidence: [], diagnostics: [],
          }])), launchAttempt: final },
      }
    }
    const journal = await attemptStore.inspect(readOnlyIdentity, readOnlyContext)
    let exactCurrentGeneration = false
    if (journal) {
      exactCurrentGeneration = inspectOpenCodeProductionGeneration(journal, {
        generation: command.request.launchAttempt.generation,
        inputDigest,
        continuation: command.continuation,
        continuationToken: command.request.launchAttempt.continuationToken,
      }) === 'replay'
    }
    if (journal?.finalResponse && exactCurrentGeneration
      && journal.cleanupState === 'complete') {
      const final = journal.finalResponse
      validateOpenCodeDurableFinalResponse(command.request, final, {
        inputDigest,
        immutableDigest,
        generation: command.request.launchAttempt.generation,
        acceptedProofResponse: journal.acceptedProofResponse,
        profileBinding: journal.profileBinding,
        members: command.members.map(member => member.memberIdentity),
      })
      const committedIds = new Set(final.members.committed.map(item => item.memberIdentity))
      const failedIds = new Set(final.members.failed.map(item => item.memberIdentity))
      return {
        snapshot: { detected: false, hostHealthy: false, projectPath: command.projectPath,
          profile: null, host: null, config: null, configProviders: null, providers: null,
          providerAuth: null, agents: [], mcp: null, appMcp: null,
          probeError: final.launchAttempt.outcome === 'reconciliation_required'
            ? 'launch mutation requires reconciliation' : null, diagnostics: [] },
        data: { runId: command.runId, providerId: 'opencode', selectedModel: command.selectedModel,
          members: Object.fromEntries(command.members.map(member => [member.name, {
            launchState: committedIds.has(member.memberIdentity) ? 'created'
              : failedIds.has(member.memberIdentity) ? 'failed' : 'pending',
            evidence: [], diagnostics: [],
          }])), launchAttempt: final },
      }
    }
    if (journal?.finalResponse && exactCurrentGeneration
      && journal.cleanupState === 'incomplete'
      && journal.finalResponse.members.cleanupPending.length === 0) {
      const releaseIdentity = {
        attemptId: command.request.launchAttempt.attemptId,
        payloadHash: command.request.launchAttempt.payloadHash,
        currentGeneration: command.request.launchAttempt.generation,
      }
      const obligationIds = await hostReleaseLedger.listCleanupObligationIds(
        releaseIdentity, preflightLedgerContext)
      const boundObligations = journal.hostCleanupObligations
      const releaseRecords = inspectedReleaseRecords
      const boundById = new Map(boundObligations?.map(item => [item.obligationId, item]) ?? [])
      const hasExactObligationSet = boundObligations !== undefined
        && JSON.stringify([...obligationIds].sort())
          === JSON.stringify(boundObligations.map(item => item.obligationId).sort())
        && releaseRecords.length > 0
        && releaseRecords.every(record => {
          const binding = boundById.get(record.obligationId)
          return binding?.reservationDigest === record.reservationDigest
            && binding.receiptIdentityDigest === record.receiptIdentityDigest
        })
        && !await hostReleaseLedger.hasUnresolvedAcquisition(releaseIdentity, preflightLedgerContext)
      const legacyRecords = releaseRecords.filter(record => record.releaseState === 'pending'
        && record.receipt.schemaVersion === 1)
      if (!hasExactObligationSet || legacyRecords.length > 0) {
        let legacyRecovered = hasExactObligationSet && legacyRecords.length > 0
        if (legacyRecovered) {
          // The terminal member projection is durable intent and is safe to
          // inspect before recovery. Do not retain a lease, acquire/adopt a
          // host, or consult the remote session merely to classify cleanup.
          const keepPersistentAlive = journal.finalResponse.members.committed.length > 0
          try {
            for (const releaseRecord of legacyRecords) {
              await openCodeHostManager.reconcileHostReleaseReceipt(releaseRecord.receipt, {
                obligationIdentity: releaseRecord,
                keepPersistentAlive,
                signal: preflightSignal,
                remainingMs: () => Math.max(0, preflightDeadlineAtMs - launchMonotonicNow()),
              })
              await hostReleaseLedger.record({ ...releaseRecord, releaseState: 'complete' },
                preflightLedgerContext)
            }
          } catch { legacyRecovered = false }
        }
        if (!legacyRecovered) {
          // In particular, a tokenless Linux v1 receipt without the exact live
          // retained capability is fenced by HostManager before registry/PID
          // observation. Project the durable incomplete final immediately,
          // before priorClaims can retain/acquire/reconcile anything.
          const final = journal.finalResponse
          validateOpenCodeDurableFinalResponse(command.request, final, {
            inputDigest,
            immutableDigest,
            generation: command.request.launchAttempt.generation,
            acceptedProofResponse: journal.acceptedProofResponse,
            profileBinding: journal.profileBinding,
            members: command.members.map(member => member.memberIdentity),
          })
          const committedIds = new Set(final.members.committed.map(item => item.memberIdentity))
          const failedIds = new Set(final.members.failed.map(item => item.memberIdentity))
          return {
            snapshot: { detected: false, hostHealthy: false, projectPath: command.projectPath,
              profile: null, host: null, config: null, configProviders: null, providers: null,
              providerAuth: null, agents: [], mcp: null, appMcp: null,
              probeError: 'launch cleanup requires reconciliation', diagnostics: [] },
            data: { runId: command.runId, providerId: 'opencode', selectedModel: command.selectedModel,
              members: Object.fromEntries(command.members.map(member => [member.name, {
                launchState: committedIds.has(member.memberIdentity) ? 'created'
                  : failedIds.has(member.memberIdentity) ? 'failed' : 'pending',
                evidence: [], diagnostics: [],
              }])), launchAttempt: final },
          }
        }
      }
    }
    let recoveryHost: Promise<OpenCodeHostHandle> | undefined
    let recoveryReference: Promise<OpenCodeHostReferenceCapability> | undefined
    const getRecoveryHost = (): Promise<OpenCodeHostHandle> => {
      recoveryReference ??= (async () => {
        const authorization = this.authorizedPlans.get(command)
        if (!authorization) throw new Error('OpenCode authorized recovery profile plan is absent')
        const prepared = await prepareAuthorizedOpenCodeLaunchScopedProfile(
          openCodeProfileManager as unknown as OpenCodePlanScopedProfileManagerPort,
          { ...authorization, input: { ...authorization.input, abortSignal: preflightSignal,
            deadlineAtMs: preflightDeadlineAtMs } },
        )
        return openCodeHostManager.ensureScopedHostReference({ preparedProfile: prepared,
          expectedHostKey: prepared.plannedHostKey,
          healthTimeoutMs: Math.max(1, preflightDeadlineAtMs - launchMonotonicNow()),
          abortSignal: preflightSignal })
      })()
      recoveryHost ??= recoveryReference.then(reference => reference.handle)
      return recoveryHost
    }
    const memberCleanupReplay = Boolean(journal?.finalResponse && exactCurrentGeneration
      && journal.cleanupState === 'incomplete'
      && (journal.memberCleanupObligations?.length ?? 0) > 0)
    const priorClaims = memberCleanupReplay ? [] : await Promise.all(command.members.map(async member => {
      const target = targetByMember.get(member.memberIdentity)!
      let claim = await mutationLedger.read(target, { deadlineAtMs: preflightDeadlineAtMs,
        signal: preflightSignal, monotonicNow: launchMonotonicNow })
      if (!claim) {
        // A durable member intent without its exact mutation claim is not
        // absence and must never authorize a fresh mutation. This journal
        // evidence also avoids consulting a same-name projection. With no
        // intent at all, claim absence is the normal first-launch path.
        const hasDurableIntent = journal?.events.some(event =>
          event.memberIdentity === member.memberIdentity) === true
        return { member, claim: null, record: null, linkage: null,
          reconciliationError: hasDurableIntent ? 'local_metadata' : null }
      }
      if (claim.attemptId !== command.request.launchAttempt.attemptId
        || claim.payloadHash !== command.request.launchAttempt.payloadHash
        || claim.memberIdentity !== member.memberIdentity) {
        // The canonical logical-member claim belongs to another authorized
        // envelope. This is durable reconciliation evidence, not permission
        // to retry under the contender's different opaque identity.
        const record = await openCodeSessionStore.getByLogicalMember(
          logicalMemberByIdentity.get(member.memberIdentity)!)
        return { member, claim, record, linkage: null, reconciliationError: 'authority' }
      }
      let record = await openCodeSessionStore.getByLogicalMember(
        logicalMemberByIdentity.get(member.memberIdentity)!)
      let linkage = record ? linkageFor(member.memberIdentity, record) : null
      if (claim.state === 'committed' && record && linkage) {
        await hydrateOpenCodeRecoveredSessionLease({
          record, memberIdentity: member.memberIdentity, runId: command.runId,
          leases: retainedSessionLeases,
          retainHostLease: async (hostKey, owner) => {
            await openCodeHostManager.retainHostLease(hostKey, owner)
          },
        })
      }
      let reconciliationError: string | null = null
      if (claim.state === 'claimed') {
        if (!hasExactOpenCodeClaimReconciliationAuthority(journal, exactCurrentGeneration, claim)) {
          reconciliationError = 'authority'
        } else try {
          const host = await getRecoveryHost()
          const client = openCodeClientFactory.create(host.baseUrl, {
            signal: preflightSignal,
            remainingMs: () => Math.max(0, preflightDeadlineAtMs - launchMonotonicNow()),
          })
          const ownershipToken = createHash('sha256').update(claim.claimToken).digest('hex')
          const ownershipTitle = `agent-teams-launch:${claim.attemptId}:${claim.memberIdentity}:${ownershipToken}`
          const outcome = await reconcileOpenCodeOwnedMemberSession({
            authoritativeSessionId: claim.idempotencyIdentity,
            ownershipTitle,
            getSession: id => client.getSession(id),
            deleteSession: id => client.deleteSession(id),
          })
          if (outcome === 'absent' || outcome === 'deleted') {
            await mutationLedger.transition(target, claim, 'known_failure', undefined, {
              deadlineAtMs: preflightDeadlineAtMs, signal: preflightSignal,
              monotonicNow: launchMonotonicNow,
            })
            claim = (await mutationLedger.read(target, { deadlineAtMs: preflightDeadlineAtMs,
              signal: preflightSignal, monotonicNow: launchMonotonicNow }))!
          } else reconciliationError = outcome
        } catch { reconciliationError = 'transport' }
      }
      if (claim.state === 'committed' && (!claim.linkage || !linkage
        || JSON.stringify(claim.linkage) !== JSON.stringify(linkage))) {
        if (!hasExactOpenCodeClaimReconciliationAuthority(journal, exactCurrentGeneration, claim)) {
          reconciliationError = 'authority'
        } else if (record) reconciliationError = 'local_metadata'
        else try {
          const host = await getRecoveryHost()
          if (!claim.recovery || host.hostKey !== claim.recovery.sessionRecord.hostKey) {
            reconciliationError = 'local_metadata'
          } else {
            const client = openCodeClientFactory.create(host.baseUrl, {
              signal: preflightSignal,
              remainingMs: () => Math.max(0, preflightDeadlineAtMs - launchMonotonicNow()),
            })
            if (!client.getSessionMessage) reconciliationError = 'transport'
            else {
              const recovered = await recoverOpenCodeCommittedMemberProjection({
                claim, attemptId: command.request.launchAttempt.attemptId,
                payloadHash: command.request.launchAttempt.payloadHash,
                inputDigest: journal!.inputDigest, immutableDigest: journal!.immutableDigest,
                generation: journal!.generation, fence: journal!.fence,
                claimToken: journal!.events.findLast(event => event.memberIdentity === member.memberIdentity)!.claimToken,
                memberIdentity: member.memberIdentity,
                teamId: command.teamId, laneId: command.laneId, memberName: member.name,
                selectedModel: command.selectedModel,
                expectedBootstrapText: bootstrapText(command, member.name,
                  claim.idempotencyIdentity, member.prompt),
                getSession: id => client.getSession(id),
                getSessionMessage: (id, messageId) => client.getSessionMessage!(id, messageId),
                upsert: async value => {
                  const reservationIdentity = openCodeSessionReservationIdentity(claim)
                  const reservation = await openCodeSessionStore.reserveLogicalMember(
                    claim.logicalMember, reservationIdentity, value.opencodeSessionId)
                  if (reservation.status === 'conflict') {
                    throw new Error('OpenCode logical member reservation is already owned')
                  }
                  const publication = await openCodeSessionStore.publishReserved(value, reservationIdentity)
                  if (publication.status === 'conflict') {
                    throw new Error('OpenCode logical member projection is already owned by another session')
                  }
                },
              })
              if (recovered.status === 'recovered') {
                record = recovered.record; linkage = recovered.linkage
              } else reconciliationError = recovered.reason
            }
          }
        } catch { reconciliationError = 'transport' }
      }
      return { member, claim, record, linkage, reconciliationError }
    }))
    if (journal?.finalResponse && exactCurrentGeneration
      && journal.cleanupState === 'incomplete'
      && journal.finalResponse.members.cleanupPending.length === 0) {
      const releaseIdentity = {
        attemptId: command.request.launchAttempt.attemptId,
        payloadHash: command.request.launchAttempt.payloadHash,
        currentGeneration: command.request.launchAttempt.generation,
      }
      try {
        const ledgerObligationIds = await hostReleaseLedger.listCleanupObligationIds(
          releaseIdentity, preflightLedgerContext)
        if (!journal.hostCleanupObligations
          || JSON.stringify([...ledgerObligationIds].sort())
            !== JSON.stringify(journal.hostCleanupObligations.map(item => item.obligationId).sort())
          || await hostReleaseLedger.hasUnresolvedAcquisition(releaseIdentity, preflightLedgerContext)) {
          throw new Error('OpenCode final host cleanup obligation set is unresolved')
        }
        const boundById = new Map(journal.hostCleanupObligations.map(item => [item.obligationId, item]))
        const releaseRecords = await hostReleaseLedger.readAllPending(
          releaseIdentity, preflightLedgerContext)
        if (releaseRecords.length === 0 || releaseRecords.some(record => {
          const binding = boundById.get(record.obligationId)
          return !binding || binding.reservationDigest !== record.reservationDigest
        })) throw new Error('OpenCode final host cleanup obligation identity is unresolved')
        // Receipt publication, journal binding, and disposition publication
        // are distinct durable transitions. Repair only the exact immutable
        // reservation while holding the same-generation replay lease. The
        // already-recovered durable member leases are the sole keep-alive
        // authority; no HostManager effect is allowed before both CAS updates.
        const needsDurableClassification = releaseRecords.some(record => {
          const binding = boundById.get(record.obligationId)!
          return binding.receiptIdentityDigest === undefined || record.disposition === 'unknown'
        })
        if (needsDurableClassification) {
          await attemptStore.withGeneration({
            attemptId: command.request.launchAttempt.attemptId,
            payloadHash: command.request.launchAttempt.payloadHash,
            inputDigest,
            immutableDigest,
            generation: command.request.launchAttempt.generation,
          }, 'replay', async lease => {
            for (const record of releaseRecords) {
              const binding = lease.journal.hostCleanupObligations?.find(
                item => item.obligationId === record.obligationId)
              if (!binding || binding.reservationDigest !== record.reservationDigest
                || (binding.receiptIdentityDigest !== undefined
                  && binding.receiptIdentityDigest !== record.receiptIdentityDigest)) {
                throw new Error('OpenCode final host cleanup reservation changed')
              }
              if (binding.receiptIdentityDigest === undefined) {
                await lease.bindHostCleanupObligation({
                  obligationId: record.obligationId,
                  reservationDigest: record.reservationDigest,
                  receiptIdentityDigest: record.receiptIdentityDigest,
                }, preflightLedgerContext)
              }
              if (record.disposition === 'unknown') {
                await hostReleaseLedger.record({ ...record,
                  disposition: retainedSessionLeases.shouldKeepHostAlive()
                    ? 'keep_alive' : 'dispose' }, preflightLedgerContext)
              }
            }
          }, preflightLedgerContext)
          return this.run(command, false, inspectionOnly)
        }
        if (releaseRecords.some(record =>
          boundById.get(record.obligationId)?.receiptIdentityDigest !== record.receiptIdentityDigest)) {
          throw new Error('OpenCode final host cleanup receipt identity is unresolved')
        }
        if (releaseRecords.some(record => record.disposition === 'unknown')) {
          throw new Error('OpenCode final host cleanup disposition is unresolved')
        }
        for (const releaseRecord of releaseRecords) {
          if (releaseRecord.releaseState === 'complete') continue
          await openCodeHostManager.reconcileHostReleaseReceipt(releaseRecord.receipt, {
            obligationIdentity: releaseRecord,
            keepPersistentAlive: releaseRecord.disposition === 'keep_alive'
              || retainedSessionLeases.shouldKeepHostAlive(),
            signal: preflightSignal,
            remainingMs: () => Math.max(0, preflightDeadlineAtMs - launchMonotonicNow()),
          })
          await hostReleaseLedger.record({ ...releaseRecord, releaseState: 'complete' },
            preflightLedgerContext)
        }
        await attemptStore.withGeneration({
          attemptId: command.request.launchAttempt.attemptId,
          payloadHash: command.request.launchAttempt.payloadHash,
          inputDigest,
          immutableDigest,
          generation: command.request.launchAttempt.generation,
        }, 'replay', lease => lease.reconcileCleanupComplete(preflightLedgerContext),
        preflightLedgerContext)
        // Re-read and project only the now-complete exact final. This recursive
        // inspection cannot reach profile, host acquisition, proof, or member
        // effects because the complete-final gate is the first journal branch.
        return this.run(command, false, true)
      } catch (error) {
        // Durable incomplete remains authoritative. The core's replay lease
        // projects cleanup timed_out without authorizing fresh effects.
      }
    }
    if (journal && exactCurrentGeneration && !journal.finalResponse) {
      const durableProofCleanup = await proofCleanupLedger.read({
        deadlineAtMs: preflightDeadlineAtMs, signal: preflightSignal,
      })
      if (durableProofCleanup && (durableProofCleanup.attemptId !== command.request.launchAttempt.attemptId
        || durableProofCleanup.requestGeneration > command.request.launchAttempt.generation
        || (durableProofCleanup.state !== 'absent' && durableProofCleanup.state !== 'deleted'
          && durableProofCleanup.state !== 'foreign'))) {
        throw new Error('OpenCode launch proof cleanup requires explicit reconciliation')
      }
      const releaseIdentity = {
        attemptId: command.request.launchAttempt.attemptId,
        payloadHash: command.request.launchAttempt.payloadHash,
        currentGeneration: command.request.launchAttempt.generation,
      }
      const ledgerObligationIds = await hostReleaseLedger.listCleanupObligationIds(
        releaseIdentity, preflightLedgerContext)
      if (journal.hostCleanupObligationIds
        && JSON.stringify([...ledgerObligationIds].sort())
          !== JSON.stringify([...journal.hostCleanupObligationIds].sort())) {
        throw new Error('OpenCode launch host cleanup obligation set changed')
      }
      if (await hostReleaseLedger.hasUnresolvedAcquisition(releaseIdentity, preflightLedgerContext)) {
        throw new Error('OpenCode launch host acquisition cleanup requires exact reconciliation evidence')
      }
      const pendingReleases = await hostReleaseLedger.readAllPending(releaseIdentity, preflightLedgerContext)
      if (journal.hostCleanupObligations) {
        const boundById = new Map(journal.hostCleanupObligations.map(item => [item.obligationId, item]))
        if (pendingReleases.some(record => {
          const binding = boundById.get(record.obligationId)
          return !binding || binding.reservationDigest !== record.reservationDigest
            || (binding.receiptIdentityDigest !== undefined
              && binding.receiptIdentityDigest !== record.receiptIdentityDigest)
        })) throw new Error('OpenCode launch host cleanup obligation identity changed')
      } else if (pendingReleases.some(record => record.schemaVersion === 4)) {
        throw new Error('OpenCode launch host cleanup obligation identity is unbound')
      }
      if (pendingReleases.length === 0) {
        if (journal.cleanupState === 'incomplete') {
          throw new Error('OpenCode launch host cleanup requires exact reconciliation evidence')
        }
      } else {
        const needsDurableClassification = pendingReleases.some(record => {
          const binding = journal.hostCleanupObligations?.find(
            item => item.obligationId === record.obligationId)
          return binding?.receiptIdentityDigest === undefined || record.disposition === 'unknown'
        })
        if (needsDurableClassification) {
          await attemptStore.withGeneration({
            attemptId: command.request.launchAttempt.attemptId,
            payloadHash: command.request.launchAttempt.payloadHash,
            inputDigest,
            immutableDigest,
            generation: command.request.launchAttempt.generation,
          }, 'replay', async lease => {
            for (const record of pendingReleases) {
              const binding = lease.journal.hostCleanupObligations?.find(
                item => item.obligationId === record.obligationId)
              if (!binding || binding.reservationDigest !== record.reservationDigest
                || (binding.receiptIdentityDigest !== undefined
                  && binding.receiptIdentityDigest !== record.receiptIdentityDigest)) {
                throw new Error('OpenCode launch host cleanup reservation changed')
              }
              if (binding.receiptIdentityDigest === undefined) {
                await lease.bindHostCleanupObligation({
                  obligationId: record.obligationId,
                  reservationDigest: record.reservationDigest,
                  receiptIdentityDigest: record.receiptIdentityDigest,
                }, preflightLedgerContext)
              }
              if (record.disposition === 'unknown') {
                await hostReleaseLedger.record({ ...record,
                  disposition: retainedSessionLeases.shouldKeepHostAlive()
                    ? 'keep_alive' : 'dispose' }, preflightLedgerContext)
              }
            }
          }, preflightLedgerContext)
          return this.run(command, false, inspectionOnly)
        }
        for (const pendingRelease of pendingReleases) {
          if (pendingRelease.disposition === 'unknown') {
            throw new Error('OpenCode launch host cleanup disposition is unknown')
          }
          if (pendingRelease.releaseState !== 'pending') continue
          await openCodeHostManager.reconcileHostReleaseReceipt(pendingRelease.receipt, {
            obligationIdentity: pendingRelease,
            keepPersistentAlive: pendingRelease.disposition === 'keep_alive'
              || retainedSessionLeases.shouldKeepHostAlive(),
            signal: preflightSignal,
            remainingMs: () => Math.max(0, preflightDeadlineAtMs - launchMonotonicNow()),
          })
          await hostReleaseLedger.record({ ...pendingRelease, releaseState: 'complete' }, preflightLedgerContext)
        }
      }
    }
    if (recoveryHost) {
      const reference = await recoveryReference.catch(() => null)
      if (reference) await bounded(openCodeHostManager.releaseHostReference(reference, {
        keepPersistentAlive: true, signal: preflightSignal,
        remainingMs: () => Math.max(0, preflightDeadlineAtMs - launchMonotonicNow()),
      }), preflightDeadlineAtMs, preflightSignal).catch(() => undefined)
    }
    const uncertain = priorClaims.some(item => item.claim?.state === 'claimed' || item.claim?.state === 'unknown'
      || item.reconciliationError !== null)
    const completed = priorClaims.length > 0 && priorClaims.every(item => item.claim?.state === 'committed'
      && item.linkage !== null)
    if (uncertain || completed) {
      if (!journal?.acceptedProofResponse || !exactCurrentGeneration) {
        throw new Error('OpenCode launch mutation requires explicit reconciliation: authoritative projection is absent')
      }
      // A crash may leave durable member authority after the accepted proof basis but before the
      // final projection transition. Re-enter only the core reconciliation path; it reconstructs
      // and persists the full response without preparing a profile, acquiring a host, or launching
      // a fresh member mutation.
      for (const item of priorClaims) {
        if (item.record) records.set(item.member.memberIdentity, item.record)
      }
    }
    if (inspectionOnly) return null
    }
    const profileFor = (profile: OpenCodeLaunchProfile) => {
      const prepared = profiles.get(profile.profileIdentity)
      if (!prepared) throw new Error('OpenCode launch profile ownership was lost')
      return prepared
    }
    const hostFor = (identity: OpenCodeRetainedHostIdentity) => {
      const handle = hosts.get(identity.hostKeyIdentity)
      if (!handle || handle.pid !== identity.processId
        || handle.processStartedAtMs !== identity.processStartedAtMs) {
        throw new Error('OpenCode retained host identity changed')
      }
      return handle
    }
    const memberByIdentity = new Map(command.members.map(member => [member.memberIdentity, member]))
    const cleanupLogicalMember = async (obligation: OpenCodeMemberCleanupObligation) => {
      if (obligation.projectIdentity) return {
        teamId: obligation.teamId, laneId: obligation.laneId,
        projectIdentity: obligation.projectIdentity, memberName: obligation.memberName,
      }
      const candidates = (await openCodeSessionStore.list()).filter(record =>
        record.teamId.trim() === obligation.teamId.trim()
        && (record.laneId ?? 'primary').trim() === obligation.laneId.trim()
        && record.memberName.trim().toLowerCase() === obligation.memberName.trim().toLowerCase())
      if (candidates.length > 1) throw new Error('legacy OpenCode cleanup project authority is ambiguous')
      const candidate = candidates[0]
      return candidate ? {
        teamId: obligation.teamId, laneId: obligation.laneId,
        projectIdentity: candidate.projectIdentity, memberName: obligation.memberName,
      } : null
    }
    const runMemberCleanupObligations = async (input: {
      cleanupObligations: readonly OpenCodeMemberCleanupObligation[]
      advanceCleanupObligation(obligation: OpenCodeMemberCleanupObligation,
        phase: OpenCodeMemberCleanupPhase): Promise<void>
      deadlineAtMs: number
      signal: AbortSignal
    }): Promise<'complete' | 'timed_out'> => reconcileOpenCodeMemberCleanupObligations({
      obligations: input.cleanupObligations, deadlineAtMs: input.deadlineAtMs,
      signal: input.signal, monotonicNow: launchMonotonicNow,
      reconcileRemote: async obligation => {
        // Cleanup replay is capability-only. An absent in-memory handle is not
        // authority to prepare a profile, adopt a registry entry, or provision
        // a replacement host. Keep the exact obligation durable until the
        // already-acquired host generation is available to this runtime.
        const handle = Array.from(hosts.values()).find(
          candidate => candidate.hostKey === obligation.hostKey)
        const reconcileAt = (baseUrl: string) => {
          const client = openCodeClientFactory.create(baseUrl, {
            signal: input.signal,
            remainingMs: () => Math.max(0, input.deadlineAtMs - launchMonotonicNow()),
          })
          return reconcileOpenCodeOwnedMemberSession({
            authoritativeSessionId: obligation.sessionId,
            ownershipTitle: obligation.ownershipTitle,
            getSession: id => client.getSession(id), deleteSession: id => client.deleteSession(id),
          })
        }
        if (handle) return reconcileAt(handle.baseUrl)
        if (obligation.hostProcessId === undefined
          || obligation.hostProcessStartedAtMs === undefined) return 'unresolved'
        const recovered = await openCodeHostManager.withRetainedHostAccess({
          hostKey: obligation.hostKey, pid: obligation.hostProcessId,
          processStartedAtMs: obligation.hostProcessStartedAtMs,
          ...(obligation.hostProcessBirthToken
            ? { processBirthToken: obligation.hostProcessBirthToken } : {}),
        }, access => reconcileAt(access.baseUrl), input.signal)
        return recovered.status === 'available' ? recovered.value
          : recovered.status === 'absent' ? 'absent' : 'unresolved'
      },
      readProjection: async obligation => {
        const logicalMember = await cleanupLogicalMember(obligation)
        const projection = logicalMember
          ? await openCodeSessionStore.getByLogicalMember(logicalMember) : null
        return projection
          ? { sessionId: projection.opencodeSessionId, runId: projection.runId } : null
      },
      // The read is only an optimization. The store mutation itself performs
      // the exact project/run/session CAS, closing the replacement race between read/effect.
      markProjectionStale: async obligation => {
        const logicalMember = await cleanupLogicalMember(obligation)
        if (!logicalMember) return 'satisfied'
        const result = await openCodeSessionStore.markStaleIfSessionMatchesLogicalMember(
          logicalMember, obligation.sessionId, 'launch_attempt_cleanup', obligation.runId)
        return result.status === 'foreign' ? 'foreign' : 'satisfied'
      },
      releaseLease: async obligation => {
        // Legacy journals lack the run half of the lease CAS. Session ids are
        // deterministic and may be rebound by a later run, so such an
        // obligation must remain pending rather than perform a session-only
        // release against a replacement lease.
        if (!obligation.runId) throw new Error('OpenCode cleanup lease run identity is absent')
        // `foreign` is a successful stale-replay disposition: the old cleanup
        // advances without deleting the replacement lease.
        await openCodeHostManager.releaseHostLease(obligation.hostKey, {
          teamId: obligation.teamId, laneId: obligation.laneId,
          memberName: obligation.memberName, runId: obligation.runId,
          sessionId: obligation.sessionId,
        })
      },
      deleteProjection: async obligation => {
        const logicalMember = await cleanupLogicalMember(obligation)
        if (!logicalMember) return 'satisfied'
        const result = await openCodeSessionStore.deleteIfSessionMatchesLogicalMember(
          logicalMember, obligation.sessionId, obligation.runId)
        return result.status === 'foreign' ? 'foreign' : 'satisfied'
      },
      advance: input.advanceCleanupObligation,
      completed: obligation => retainedSessionLeases.remove(obligation.memberIdentity),
    })
    const ports: OpenCodeLaunchAttemptPorts = {
      clock: { monotonicNow: launchMonotonicNow },
      profile: { createSelectedProviderProfile: async input => {
        const authorization = this.authorizedPlans.get(command)
        if (!authorization || authorization.input.providerId !== input.providerId) {
          throw new Error('OpenCode authorized scoped profile plan is absent or mismatched')
        }
        const prepared = await prepareAuthorizedOpenCodeLaunchScopedProfile(
          openCodeProfileManager as unknown as OpenCodePlanScopedProfileManagerPort,
          { ...authorization, input: { ...authorization.input, abortSignal: input.signal,
            deadlineAtMs: input.deadlineAtMs } },
        )
        const [observedAuthFingerprint, observedBinaryFingerprint, observedProfileIdentity,
          observedPluginFingerprint, observedCacheIdentity] = await Promise.all([
          fileFingerprint(prepared.managedAuthPath), fileFingerprint(prepared.binaryPath),
          pathIdentity(prepared.profileRootPath), immutableTreeFingerprint(prepared.pluginNodeModulesPath),
          pathIdentity(prepared.xdgCacheHome),
        ])
        const profile: OpenCodeLaunchProfile = {
          purpose: 'launch_attempt', providerId: input.providerId,
          projectIdentity: opaque({ project: projectIdentity }),
          profileIdentity: opaque({ profileRoot: observedProfileIdentity }),
          pluginPolicyIdentity: opaque({ pluginTree: observedPluginFingerprint }),
          cacheIdentity: opaque({ cacheRoot: observedCacheIdentity }),
          authIdentity: opaque({ auth: observedAuthFingerprint }),
          configIdentity: opaque({ config: prepared.managedConfig }),
          binaryIdentity: opaque({ binary: observedBinaryFingerprint }),
        }
        profiles.set(profile.profileIdentity, prepared)
        return profile
      } },
      host: {
        reserveOperationHostCleanup: async input => {
          const prepared = profileFor(input.profile)
          const obligation = await hostReleaseLedger.reserve({
            attemptId: input.attemptId, payloadHash: input.payloadHash, generation: input.generation,
            hostKeyIdentity: opaque({ hostKey: prepared.plannedHostKey }),
            hostKeyDigest: createHash('sha256').update(prepared.plannedHostKey).digest('hex'),
          }, { deadlineAtMs: productionDeadlineAtMs, signal: input.signal })
          hostAcquisitionObligations.set(obligation.obligationId, obligation)
          return { obligationId: obligation.obligationId,
            reservationDigest: obligation.reservationDigest }
        },
        acquireOperationHost: async input => {
          const prepared = profileFor(input.profile)
          const obligation = input.cleanupObligationId
            ? hostAcquisitionObligations.get(input.cleanupObligationId) : undefined
          if (!obligation || !isOpenCodeLaunchHostAcquisitionObligation(obligation)) {
            throw new OpenCodeOperationHostAcquisitionCleanupError(
              new Error('OpenCode host acquisition cleanup obligation is absent'))
          }
          const acquisitionObligation: OpenCodeLaunchHostAcquisitionObligation = obligation
          let reference: OpenCodeHostReferenceCapability
          try {
            reference = await openCodeHostManager.ensureScopedHostReference({ preparedProfile: prepared,
              expectedHostKey: prepared.plannedHostKey,
              healthTimeoutMs: Math.max(1, input.deadlineAtMs - launchMonotonicNow()), abortSignal: input.signal })
          } catch (error) {
            if (error instanceof OpenCodeOperationHostAcquisitionCleanupError) throw error
            if (error && typeof error === 'object'
              && (error as { cleanupIncomplete?: unknown }).cleanupIncomplete === true) {
              const startup = (error as { startupCleanupReceipt?: {
                hostKey: string
                receipt: OpenCodeLaunchHostReleaseRecord['receipt']
              } }).startupCleanupReceipt
              if (startup) {
                const cleanup = absoluteCleanupContext(productionDeadlineAtMs)
                const hostKeyIdentity = opaque({ hostKey: startup.hostKey })
                const startupRecordBase = {
                  schemaVersion: 4,
                  obligationId: obligation.obligationId,
                  reservationDigest: obligation.reservationDigest,
                  hostKeyDigest: obligation.hostKeyDigest,
                  attemptId: obligation.attemptId,
                  payloadHash: obligation.payloadHash,
                  generation: obligation.generation,
                  hostKeyIdentity,
                  disposition: 'dispose',
                  releaseState: 'pending',
                  receipt: startup.receipt,
                } as const
                const startupRecord: OpenCodeLaunchHostReleaseRecord = { ...startupRecordBase,
                  receiptIdentityDigest: computeOpenCodeHostReleaseObligationIdentityDigest(startupRecordBase) }
                const published = await hostReleaseLedger.record(startupRecord, cleanup.context)
                  .then(() => true, () => false).finally(cleanup.close)
                if (published) {
                  hostAcquisitionObligations.set(obligation.obligationId, startupRecord)
                  throw new OpenCodeOperationHostAcquisitionCleanupError(error, {
                    obligationId: startupRecord.obligationId,
                    reservationDigest: startupRecord.reservationDigest,
                    receiptIdentityDigest: startupRecord.receiptIdentityDigest,
                  })
                }
              }
              throw new OpenCodeOperationHostAcquisitionCleanupError(error)
            }
            // HostManager only rejects ordinarily after proving its exact
            // native containment empty. Durably clear the matching obligation
            // within the existing absolute reserve; cancellation of the launch
            // envelope cannot turn a failed clear into cleanup-complete.
            const cleanup = absoluteCleanupContext(productionDeadlineAtMs)
            try {
              await hostReleaseLedger.clearObligation(acquisitionObligation, cleanup.context)
              hostAcquisitionObligations.delete(obligation.obligationId)
            } catch (clearError) {
              throw new OpenCodeOperationHostAcquisitionCleanupError(clearError)
            } finally {
              cleanup.close()
            }
            throw error
          }
          const handle = reference.handle
          if (!handle.processStartedAtMs) throw new Error('OpenCode retained host birth identity is unavailable')
          const identity: OpenCodeRetainedHostIdentity = {
            hostKeyIdentity: opaque({ hostKey: handle.hostKey }), processId: handle.pid,
            processStartedAtMs: handle.processStartedAtMs,
            profileScopeIdentity: input.profile.profileIdentity,
          }
          const releaseReceipt = openCodeHostManager.hostReleaseReceipt(reference)
          const releaseRecordBase = {
            schemaVersion: 4,
            obligationId: obligation.obligationId,
            reservationDigest: obligation.reservationDigest,
            hostKeyDigest: obligation.hostKeyDigest,
            attemptId: command.request.launchAttempt.attemptId,
            payloadHash: command.request.launchAttempt.payloadHash,
            generation: command.request.launchAttempt.generation,
            hostKeyIdentity: identity.hostKeyIdentity,
            disposition: 'unknown',
            releaseState: 'pending',
            receipt: releaseReceipt,
          } as const
          const releaseRecord: OpenCodeLaunchHostReleaseRecord = { ...releaseRecordBase,
            receiptIdentityDigest: computeOpenCodeHostReleaseObligationIdentityDigest(releaseRecordBase) }
          try {
            await hostReleaseLedger.record(releaseRecord,
              { deadlineAtMs: productionDeadlineAtMs, signal: input.signal })
            hostAcquisitionObligations.set(obligation.obligationId, releaseRecord)
            this.dependencies.crashBoundary?.('after_host_receipt_publication')
          } catch (error) {
            // Publication failure must not make cleanup depend on an already
            // closed caller signal. Start the physical release immediately
            // within the existing absolute reserve. Only the wait is caller-bounded;
            // settlement retains the durable obligation until release proof is
            // obtained and then token-clears that exact obligation.
            const cleanup = absoluteCleanupContext(productionDeadlineAtMs)
            const completedReleaseRecord = { ...releaseRecord,
              disposition: 'dispose', releaseState: 'complete' } as const
            const physicalRelease = openCodeHostManager.releaseHostReference(reference, {
              signal: cleanup.context.signal,
              remainingMs: () => Math.max(0, productionDeadlineAtMs - launchMonotonicNow()),
            }).then(() => hostReleaseLedger.record(completedReleaseRecord, {
                deadlineAtMs: productionDeadlineAtMs, signal: cleanup.context.signal,
              })).then(() => {
                hostAcquisitionObligations.set(obligation.obligationId, completedReleaseRecord)
              })
            physicalRelease.then(cleanup.close, cleanup.close)
            // Retain a rejection handler even when the caller's wait expires;
            // the on-disk acquisition obligation remains the restart fence.
            physicalRelease.catch(() => undefined)
            try {
              await bounded(physicalRelease, productionDeadlineAtMs, input.signal)
            } catch (releaseError) {
              throw new OpenCodeOperationHostAcquisitionCleanupError(releaseError)
            }
            throw new OpenCodeOperationHostAcquisitionSettledError({
              obligationId: completedReleaseRecord.obligationId,
              reservationDigest: completedReleaseRecord.reservationDigest,
              receiptIdentityDigest: completedReleaseRecord.receiptIdentityDigest,
            }, error)
          }
          hosts.set(identity.hostKeyIdentity, handle)
          hostReferences.set(identity.hostKeyIdentity, reference)
          currentSnapshot = {
            detected: true, hostHealthy: handle.state === 'healthy', projectPath: handle.projectPath,
            profile: prepared, host: handle, config: null, configProviders: null, providers: null,
            providerAuth: null, agents: [], mcp: null, appMcp: null, probeError: null, diagnostics: [],
          }
          return identity
        },
        readOperationHostCleanupBinding: async input => {
          const record = hostAcquisitionObligations.get(input.cleanupObligationId)
          if (!record || record.receipt === null) {
            throw new Error('OpenCode operation host cleanup receipt identity is absent')
          }
          if (input.signal.aborted || launchMonotonicNow() >= input.deadlineAtMs) {
            throw input.signal.reason ?? new DeadlineError('OpenCode launch deadline expired')
          }
          return { obligationId: record.obligationId, reservationDigest: record.reservationDigest,
            receiptIdentityDigest: record.receiptIdentityDigest }
        },
        releaseOperationHost: async input => {
          // Settlement owns an absolute-deadline signal distinct from the
          // caller-facing wait. Closing a phase can stop waiting, but cannot
          // strand an exact capability before its durable receipt is complete.
          const cleanup = absoluteCleanupContext(productionDeadlineAtMs)
          const settlementContext = cleanup.context
          const settlement = (async () => {
            if (!input.cleanupObligationId) {
              throw new Error('OpenCode operation host release obligation is absent')
            }
            const releaseRecord = await hostReleaseLedger.readObligation({
              attemptId: command.request.launchAttempt.attemptId,
              payloadHash: command.request.launchAttempt.payloadHash,
              generation: command.request.launchAttempt.generation,
              obligationId: input.cleanupObligationId,
            }, settlementContext)
            if (!releaseRecord || releaseRecord.hostKeyIdentity !== input.host.hostKeyIdentity) {
              throw new Error('OpenCode operation host release receipt is absent or mismatched')
            }
            const disposition = retainedSessionLeases.shouldKeepHostAlive() ? 'keep_alive' : 'dispose'
            const intendedRelease = { ...releaseRecord, disposition } as OpenCodeLaunchHostReleaseRecord
            // Commit intent before proof cleanup or host release effects. A crash
            // can now distinguish keep-alive from disposal without guessing.
            this.dependencies.crashBoundary?.('before_host_disposition_publication')
            await hostReleaseLedger.record(intendedRelease, settlementContext)
            const reference = hostReferences.get(input.host.hostKeyIdentity)
            if (reference && reference.handle !== hostFor(input.host)) {
              throw new Error('OpenCode operation host release capability is mismatched')
            }
            const proofSession = proofSessions.get(input.host.hostKeyIdentity)
            if (proofSession) {
              let persisted = proofSession
              if (proofSession.state !== 'absent' && proofSession.state !== 'deleted'
                && proofSession.state !== 'foreign') {
                const handle = hostFor(input.host)
                const client = openCodeClientFactory.create(handle.baseUrl, {
                  signal: settlementContext.signal,
                  remainingMs: () => Math.max(0, productionDeadlineAtMs - launchMonotonicNow()),
                })
                const proofCleanup = await reconcileOpenCodeOwnedMemberSession({
                  authoritativeSessionId: proofSession.authoritativeSessionId,
                  ownershipTitle: proofSession.ownershipTitle,
                  getSession: id => client.getSession(id),
                  deleteSession: id => client.deleteSession(id),
                }).catch(() => 'unresolved' as const)
                persisted = await proofCleanupLedger.recordState(proofSession, proofCleanup,
                  settlementContext)
                  .catch(() => ({ ...proofSession, state: 'unresolved' as const }))
              }
              proofSessions.set(input.host.hostKeyIdentity, persisted)
              if (persisted.state === 'foreign' || persisted.state === 'unresolved'
                || persisted.state === 'registered' || persisted.state === 'owned') {
                throw new Error('OpenCode proof session cleanup could not prove absence')
              }
              proofSessions.delete(input.host.hostKeyIdentity)
            }
            await bounded(openCodeHostManager.reconcileHostReleaseReceipt(intendedRelease.receipt,
              { obligationIdentity: intendedRelease,
                keepPersistentAlive: disposition === 'keep_alive',
                signal: settlementContext.signal,
                remainingMs: () => Math.max(0, productionDeadlineAtMs - launchMonotonicNow()) }),
            productionDeadlineAtMs, settlementContext.signal)
            await hostReleaseLedger.record({ ...intendedRelease, releaseState: 'complete' },
              settlementContext)
            hostReferences.delete(input.host.hostKeyIdentity)
          })()
          settlement.then(cleanup.close, cleanup.close)
          // The settlement may outlive this wait. Always retain a rejection
          // reaction so a caller abort never turns late failure into an
          // unhandled rejection; the durable pending obligation is its fence.
          settlement.catch(() => undefined)
          return bounded(settlement, productionDeadlineAtMs, input.signal)
        },
        reconcileOperationHost: async input => {
          let proofCleanup: OpenCodeProofSessionCleanupRecord | null
          try {
            proofCleanup = await proofCleanupLedger.read({
              deadlineAtMs: input.deadlineAtMs, signal: input.signal,
            })
          } catch { return 'incomplete' }
          if (proofCleanup && (proofCleanup.attemptId !== input.attemptId
            || proofCleanup.requestGeneration > input.generation
            || (proofCleanup.state !== 'absent' && proofCleanup.state !== 'deleted'
              && proofCleanup.state !== 'foreign'))) return 'incomplete'
          const releaseIdentity = {
            attemptId: input.attemptId,
            payloadHash: input.payloadHash,
            currentGeneration: input.generation,
          }
          const ledgerContext = { deadlineAtMs: input.deadlineAtMs, signal: input.signal }
          const ledgerObligationIds = await hostReleaseLedger.listCleanupObligationIds(
            releaseIdentity, ledgerContext)
          if (input.cleanupObligations
            && JSON.stringify([...ledgerObligationIds].sort())
              !== JSON.stringify(input.cleanupObligations.map(item => item.obligationId).sort())) {
            return 'incomplete'
          }
          const hasUnresolvedAcquisition = await hostReleaseLedger.hasUnresolvedAcquisition(
            releaseIdentity, ledgerContext)
          if (hasUnresolvedAcquisition) return 'incomplete'
          const releaseRecords = await hostReleaseLedger.readAllPending(releaseIdentity, ledgerContext)
          if (releaseRecords.length > 0 && !input.cleanupObligations) return 'incomplete'
          const boundById = new Map(input.cleanupObligations?.map(item => [item.obligationId, item]))
          if (input.cleanupObligations && releaseRecords.some(record => {
            const binding = boundById.get(record.obligationId)
            return !binding || binding.reservationDigest !== record.reservationDigest
              || binding.receiptIdentityDigest !== record.receiptIdentityDigest
          })) return 'incomplete'
          if (releaseRecords.length === 0
            || releaseRecords.some(record => record.disposition === 'unknown')) return 'incomplete'
          for (const releaseRecord of releaseRecords) {
            if (releaseRecord.releaseState === 'complete') continue
            try {
              await openCodeHostManager.reconcileHostReleaseReceipt(releaseRecord.receipt, {
                obligationIdentity: releaseRecord,
                keepPersistentAlive: releaseRecord.disposition === 'keep_alive'
                  || retainedSessionLeases.shouldKeepHostAlive(),
                signal: input.signal,
                remainingMs: () => Math.max(0, input.deadlineAtMs - launchMonotonicNow()),
              })
              await hostReleaseLedger.record({ ...releaseRecord, releaseState: 'complete' }, ledgerContext)
            } catch { return 'incomplete' }
          }
          return 'complete'
        },
      },
      mcp: { verifyAppMcp: async input => {
        const handle = hostFor(input.host)
        const context = { signal: input.signal, remainingMs: () => Math.max(0, input.deadlineAtMs - launchMonotonicNow()) }
        const appMcp = await openCodeMcpManager.ensureAppMcp({ baseUrl: handle.baseUrl,
          attachIfMissing: true, requestContext: context })
        if (!appMcp.summary.connected) throw new Error('OpenCode App MCP is not connected')
        const observedTools = await openCodeClientFactory.create(handle.baseUrl, context)
          .listExperimentalToolIds({ directory: handle.projectPath, workspace: handle.projectPath })
        if (currentSnapshot) currentSnapshot = { ...currentSnapshot, appMcp: appMcp.summary }
        return { host: input.host, observedTools }
      } },
      proof: { runFreshExactModelProof: async input => {
        const handle = hostFor(input.host)
        const client = openCodeClientFactory.create(handle.baseUrl, {
          signal: input.signal, remainingMs: () => Math.max(0, input.deadlineAtMs - launchMonotonicNow()),
        })
        const registration = await proofCleanupLedger.reconcileAndRegister({
          attemptId: input.request.launchAttempt.attemptId,
          requestGeneration: input.request.launchAttempt.generation,
          hostKeyIdentity: input.host.hostKeyIdentity,
          ownership: generation => deriveOpenCodeProductionProofOwnership({
            attemptId: input.request.launchAttempt.attemptId,
            requestGeneration: input.request.launchAttempt.generation,
            proofGeneration: generation,
            hostKeyIdentity: input.host.hostKeyIdentity,
          }),
          reconcile: prior => reconcileOpenCodeOwnedMemberSession({
            authoritativeSessionId: prior.authoritativeSessionId,
            ownershipTitle: prior.ownershipTitle,
            getSession: id => client.getSession(id), deleteSession: id => client.deleteSession(id),
          }).catch(() => 'unresolved' as const),
        }, { deadlineAtMs: input.deadlineAtMs, signal: input.signal })
        const proofOwnership = registration.record
        const proofSessionId = proofOwnership.authoritativeSessionId
        const ownershipTitle = proofOwnership.ownershipTitle
        proofSessions.set(input.host.hostKeyIdentity, proofOwnership)
        if (!registration.created) {
          throw new Error(`OpenCode prior proof generation requires cleanup reconciliation (${registration.priorOutcome})`)
        }
        try {
          const existing = await client.getSession(proofSessionId)
          const collisionState: OpenCodeOwnedSessionReconciliation =
            existing.id === proofSessionId && existing.title === ownershipTitle
              ? await reconcileOpenCodeOwnedMemberSession({
                authoritativeSessionId: proofSessionId, ownershipTitle,
                getSession: id => client.getSession(id), deleteSession: id => client.deleteSession(id),
              }).catch(() => 'unresolved' as const)
              : 'foreign'
          await proofCleanupLedger.recordState(proofOwnership, collisionState,
            { deadlineAtMs: input.deadlineAtMs, signal: input.signal })
          proofSessions.set(input.host.hostKeyIdentity, { ...proofOwnership, state: collisionState })
          throw new Error('OpenCode proof session id is already present')
        } catch (error) {
          if (!isNotFound(error)) throw error
        }
        let session: Awaited<ReturnType<typeof client.createSession>>
        try {
          session = await client.createSession({ id: proofSessionId, title: ownershipTitle })
        } catch (error) {
          const observed = await reconcileOpenCodeOwnedMemberSession({
            authoritativeSessionId: proofSessionId, ownershipTitle,
            getSession: id => client.getSession(id), deleteSession: id => client.deleteSession(id),
          }).catch(() => 'unresolved' as const)
          const persisted = await proofCleanupLedger.recordState(proofOwnership, observed,
            { deadlineAtMs: input.deadlineAtMs, signal: input.signal })
            .catch(() => ({ ...proofOwnership, state: 'unresolved' as const }))
          proofSessions.set(input.host.hostKeyIdentity, persisted)
          throw error
        }
        try {
          if (session.id !== proofSessionId || session.title !== ownershipTitle) {
            throw new Error('OpenCode proof session ownership response mismatched')
          }
          const ownedProof = await proofCleanupLedger.recordState(proofOwnership, 'owned',
            { deadlineAtMs: input.deadlineAtMs, signal: input.signal })
          proofSessions.set(input.host.hostKeyIdentity, ownedProof)
          const prompt = `Return exactly this nonce and nothing else: ${input.request.launchAttempt.proofNonce}`
          const response = await client.sendSessionMessage(session.id, {
            agent: 'teammate-model-probe', model: modelParts(command.selectedModel),
            parts: [{ type: 'text', text: prompt }],
          })
          if (readOpenCodeExactMessageText(response) !== input.request.launchAttempt.proofNonce) {
            throw new Error('OpenCode exact-model proof nonce was not returned exactly')
          }
          const info = response.info ?? {}
          if ((info.providerID ?? info.providerId) !== input.request.launchAttempt.providerId
            || (info.modelID ?? info.modelId) !== modelParts(command.selectedModel).modelID) {
            throw new Error('OpenCode exact-model proof provider/model mismatch')
          }
          const [observedMcp, observedToolIds] = await Promise.all([
            client.getMcp(),
            client.listExperimentalToolIds({ directory: handle.projectPath, workspace: handle.projectPath }),
          ])
          const observedAppMcp = observedMcp[OPEN_CODE_APP_MCP_SERVER_NAME]
          const observedMcpState = String(observedAppMcp?.status ?? observedAppMcp?.state
            ?? observedAppMcp?.connection ?? '').toLowerCase()
          if (observedAppMcp?.connected !== true
            && !['connected', 'ready', 'healthy', 'active'].includes(observedMcpState)) {
            throw new Error('OpenCode App MCP disconnected during exact-model proof')
          }
          const observedRequiredTools = input.request.launchAttempt.requiredMcpTools
            .filter(tool => observedToolIds.includes(tool))
          const verifiedAt = launchMonotonicNow()
          const assistantMessageIdentity = messageIdentity(response)
          const rawMessageId = response.info?.id
          if (typeof rawMessageId !== 'string' || !rawMessageId) throw new Error('OpenCode proof message id is absent')
          const observableProof = await proofCleanupLedger.recordObservationMessage(
            ownedProof, rawMessageId, { deadlineAtMs: input.deadlineAtMs, signal: input.signal })
          proofSessions.set(input.host.hostKeyIdentity, observableProof)
          const proof: OpenCodeLaunchAttemptResponse = {
            launchAttempt: {
              contractVersion: 1, attemptId: input.request.launchAttempt.attemptId,
              idempotencyKey: 'attemptId', payloadHash: input.request.launchAttempt.payloadHash,
              generation: input.request.launchAttempt.generation, inputDigest, immutableDigest,
              outcome: 'succeeded', phase: 'complete',
              startedAt: verifiedAt - 1, workDeadlineAt: verifiedAt + 1,
              absoluteDeadlineAt: verifiedAt + 2, cleanupReserveMs: 1, elapsedMs: 1,
              providerId: input.request.launchAttempt.providerId, modelId: input.request.launchAttempt.modelId,
              profilePurpose: input.profile.purpose, projectIdentity: input.profile.projectIdentity,
              profileIdentity: input.profile.profileIdentity,
              configIdentity: input.profile.configIdentity, authIdentity: input.profile.authIdentity,
              pluginPolicyIdentity: input.profile.pluginPolicyIdentity, cacheIdentity: input.profile.cacheIdentity,
              binaryIdentity: input.profile.binaryIdentity,
              retainedHostIdentity: input.host,
              ...(input.request.launchAttempt.requestCorrelationDigest === undefined ? {} : {
                requestCorrelationDigest: input.request.launchAttempt.requestCorrelationDigest,
              }),
            },
            proof: {
              generation: input.request.launchAttempt.generation,
              attemptId: input.request.launchAttempt.attemptId, parent: input.request.launchAttempt.parent,
              providerId: input.request.launchAttempt.providerId, modelId: input.request.launchAttempt.modelId,
              retainedHostIdentity: input.host,
              observedMcpTools: observedRequiredTools,
              nonceHash: createHash('sha256').update(input.request.launchAttempt.proofNonce).digest('hex'),
              sessionIdentity: opaque({ kind: 'proof-session', id: session.id }),
              promptMessageIdentity: opaque({ kind: 'proof-prompt', prompt }),
              assistantMessageIdentity, verifiedAt,
              authorizationSource: 'fresh_live_attempt', cacheUsed: false,
              ...(input.request.launchAttempt.requestCorrelationDigest === undefined ? {} : {
                requestCorrelationDigest: input.request.launchAttempt.requestCorrelationDigest,
              }),
            },
            members: { committed: [], failed: [], pending: [], cleanupPending: [] },
          }
          return { response: proof, authIdentity: input.profile.authIdentity,
            configIdentity: input.profile.configIdentity, binaryIdentity: input.profile.binaryIdentity }
        } catch (error) {
          const observed = await reconcileOpenCodeOwnedMemberSession({
            authoritativeSessionId: proofSessionId, ownershipTitle,
            getSession: id => client.getSession(id), deleteSession: id => client.deleteSession(id),
          }).catch(() => 'unresolved' as const)
          const persisted = await proofCleanupLedger.recordState(proofOwnership, observed,
            { deadlineAtMs: input.deadlineAtMs, signal: input.signal })
            .catch(() => ({ ...proofOwnership, state: 'unresolved' as const }))
          proofSessions.set(input.host.hostKeyIdentity, persisted)
          throw error
        }
      },
      observeRetainedProofState: async input => {
        const handle = hostFor(input.host)
        const prepared = profileFor(input.profile)
        const client = openCodeClientFactory.create(handle.baseUrl, {
          signal: input.signal, remainingMs: () => Math.max(0, input.deadlineAtMs - launchMonotonicNow()),
        })
        const retainedProof = await resolveOpenCodeProductionRetainedProofRecord({
          cached: proofSessions.get(input.host.hostKeyIdentity), ledger: proofCleanupLedger,
          attemptId: input.request.launchAttempt.attemptId,
          requestGeneration: input.request.launchAttempt.generation,
          hostKeyIdentity: input.host.hostKeyIdentity,
          deadlineAtMs: input.deadlineAtMs, signal: input.signal,
        })
        if (!client.getSessionMessage) {
          throw new Error('OpenCode retained proof is unavailable')
        }
        proofSessions.set(input.host.hostKeyIdentity, retainedProof)
        const observedProofMessage = await reobserveOpenCodeProductionRetainedProof({
          retainedProof,
          getSession: id => client.getSession(id),
          getSessionMessage: (id, messageId) => client.getSessionMessage!(id, messageId),
        })
        const [mcp, allTools, observedAuthFingerprint, observedBinaryFingerprint,
          observedProfileIdentity, observedPluginFingerprint, observedCacheIdentity,
          observedConfig] = await Promise.all([
          client.getMcp(),
          client.listExperimentalToolIds({ directory: handle.projectPath, workspace: handle.projectPath }),
          fileFingerprint(prepared.managedAuthPath),
          fileFingerprint(prepared.binaryPath),
          pathIdentity(prepared.profileRootPath),
          immutableTreeFingerprint(prepared.pluginNodeModulesPath),
          pathIdentity(prepared.xdgCacheHome),
          client.getConfig(),
        ])
        const proofInfo = observedProofMessage.info ?? {}
        const proofProviderId = proofInfo.providerID ?? proofInfo.providerId
        const proofModelId = proofInfo.modelID ?? proofInfo.modelId
        if (proofProviderId !== input.request.launchAttempt.providerId
          || proofModelId !== modelParts(command.selectedModel).modelID) {
          throw new Error('OpenCode retained proof provider/model changed')
        }
        const liveSelectedModel = (observedConfig as Record<string, unknown>).model
        const liveModel = typeof liveSelectedModel === 'string'
          ? modelParts(liveSelectedModel)
          : { providerID: '', modelID: '' }
        const appMcp = mcp[OPEN_CODE_APP_MCP_SERVER_NAME]
        const state = String(appMcp?.status ?? appMcp?.state ?? appMcp?.connection ?? '').toLowerCase()
        const mcpConnected = appMcp?.connected === true
          || ['connected', 'ready', 'healthy', 'active'].includes(state)
        return {
          host: input.host,
          nonceHash: createHash('sha256').update(readOpenCodeExactMessageText(observedProofMessage)).digest('hex'),
          providerId: liveModel.providerID,
          modelId: typeof liveSelectedModel === 'string' ? liveSelectedModel : '',
          mcpConnected,
          observedTools: input.request.launchAttempt.requiredMcpTools.filter(tool => allTools.includes(tool)),
          profileIdentity: opaque({ profileRoot: observedProfileIdentity }),
          pluginPolicyIdentity: opaque({ pluginTree: observedPluginFingerprint }),
          cacheIdentity: opaque({ cacheRoot: observedCacheIdentity }),
          authIdentity: opaque({ auth: observedAuthFingerprint }),
          configIdentity: opaque({ config: observedConfig }),
          binaryIdentity: opaque({ binary: observedBinaryFingerprint }),
        }
      } },
      sessions: {
        readMemberLinkage: async input => {
          const member = memberByIdentity.get(input.memberIdentity)
          if (!member) return null
          const target = targetByMember.get(input.memberIdentity)!
          const durableClaim = await mutationLedger.read(target, {
            deadlineAtMs: input.deadlineAtMs, signal: input.signal, monotonicNow: launchMonotonicNow,
          })
          const record = await openCodeSessionStore.getByLogicalMember(
            logicalMemberByIdentity.get(input.memberIdentity)!)
          const linkage = recoverOpenCodeCommittedMemberLinkage({
            claim: durableClaim, record,
            attemptId: input.attemptId, payloadHash: input.payloadHash,
            inputDigest: input.inputDigest, immutableDigest: input.immutableDigest,
            generation: input.generation, fence: input.fence, claimToken: input.claimToken,
            memberIdentity: input.memberIdentity, teamId: command.teamId, laneId: command.laneId,
            memberName: member.name, selectedModel: command.selectedModel,
            expectedBootstrapText: bootstrapText(command, member.name,
              durableClaim?.idempotencyIdentity ?? OpenCodeLaunchMutationLedger.idempotencyIdentity(target), member.prompt),
          })
          if (!linkage || !record) return null
          records.set(input.memberIdentity, record)
          // Restart/continuation reconstructs the in-memory operation-reference
          // transfer before cleanup can decide whether the retained host is shared
          // with an already committed member.
          await hydrateOpenCodeRecoveredSessionLease({
            record, memberIdentity: input.memberIdentity, runId: command.runId,
            leases: retainedSessionLeases,
            retainHostLease: async (hostKey, owner) => {
              await openCodeHostManager.retainHostLease(hostKey, owner)
            },
          })
          return linkage
        },
        claimMemberMutation: async input => {
          const target = targetByMember.get(input.memberIdentity)
          if (!target) return 'reconciliation_required'
          return mutationLedger.claim(target, { ...input,
            logicalMember: logicalMemberByIdentity.get(input.memberIdentity)! }, {
            deadlineAtMs: input.deadlineAtMs, signal: input.signal, monotonicNow: launchMonotonicNow,
          })
        },
        transitionMemberClaim: async input => {
          const target = targetByMember.get(input.memberIdentity)
          if (!target) return 'fenced'
          return transitionOpenCodeProductionMemberClaim(mutationLedger, target, { ...input,
            logicalMember: logicalMemberByIdentity.get(input.memberIdentity)! },
            { deadlineAtMs: input.deadlineAtMs, signal: input.signal, monotonicNow: launchMonotonicNow })
        },
        createBootstrapAndCommit: async input => {
          const member = memberByIdentity.get(input.memberIdentity)
          if (!member) return { outcome: 'known_failure', failure: 'contract_violation', externalEffect: false }
          if (await openCodeSessionStore.getByLogicalMember(
            logicalMemberByIdentity.get(input.memberIdentity)!)) {
            return { outcome: 'known_failure', failure: 'contract_violation', externalEffect: false }
          }
          const target = targetByMember.get(input.memberIdentity)!
          const mutationIdentity = { ...input,
            logicalMember: logicalMemberByIdentity.get(input.memberIdentity)! }
          const claimContext = { deadlineAtMs: input.deadlineAtMs, signal: input.signal,
            monotonicNow: launchMonotonicNow }
          const durableClaim = await readOpenCodeProductionMemberClaim(
            mutationLedger, target, mutationIdentity, claimContext)
          if (!durableClaim) {
            return { outcome: 'known_failure', failure: 'contract_violation', externalEffect: false }
          }
          // A migrated V1 claim is stored under the canonical logical key but
          // deliberately retains its predecessor idempotency identity. Every
          // lookup, effect, projection, and commit below must share that one
          // durable identity across crash/restart.
          const authoritativeSessionId = durableClaim.idempotencyIdentity
          const reservationIdentity = openCodeSessionReservationIdentity(mutationIdentity)
          const reservation = await openCodeSessionStore.reserveLogicalMember(
            logicalMemberByIdentity.get(input.memberIdentity)!, reservationIdentity, authoritativeSessionId)
          if (reservation.status === 'conflict') {
            return { outcome: 'known_failure', failure: 'contract_violation', externalEffect: false }
          }
          await input.revalidateBeforeCommit()
          const handle = hostFor(input.host)
          const client = openCodeClientFactory.create(handle.baseUrl, {
            signal: input.signal, remainingMs: () => Math.max(0, input.deadlineAtMs - launchMonotonicNow()),
          })
          const memberOwnershipToken = createHash('sha256').update(input.claimToken).digest('hex')
          const ownershipTitle = `agent-teams-launch:${command.request.launchAttempt.attemptId}:${input.memberIdentity}:${memberOwnershipToken}`
          memberOwnershipTitles.set(input.memberIdentity, ownershipTitle)
          const now = new Date().toISOString()
          let record: OpenCodeSessionRecord = {
            version: 2,
            teamId: command.teamId, laneId: command.laneId, memberName: member.name,
            providerId: 'opencode', selectedModel: command.selectedModel,
            ...(member.effort ? { selectedVariant: member.effort } : {}),
            projectIdentity: handle.projectPath, projectPath: handle.projectPath,
            runId: command.runId, profileRootKey: handle.profileRootKey,
            hostKey: handle.hostKey, toolApprovalMode: command.toolApprovalMode,
            runtimePid: handle.pid, resolvedBehaviorFingerprint: handle.resolvedConfigFingerprint,
            opencodeSessionId: authoritativeSessionId, lastCanonicalCursor: null,
            lastKnownRawStatus: null, lastKnownDurableState: null,
            sourceAuthFingerprint: handle.profile.sourceAuthFingerprint,
            managedAuthFingerprint: handle.profile.managedAuthFingerprint,
            projectBehaviorFingerprint: handle.projectBehaviorFingerprint,
            managedConfigFingerprint: handle.profile.managedConfigFingerprint,
            ...(handle.version ? { opencodeVersion: handle.version } : {}),
            bootstrapMode: 'app_managed_context', staleReason: null, createdAt: now, updatedAt: now,
          }
          try {
            const existing = await client.getSession(authoritativeSessionId)
            if (existing.id === authoritativeSessionId && existing.title === ownershipTitle) {
              const { owned } = await createOpenCodeOwnedMemberSession({
                memberIdentity: input.memberIdentity,
                authoritativeSessionId,
                registerRecord: () => { records.set(input.memberIdentity, record) },
                registerOwned: input.registerOwned,
                createSession: async () => existing,
              })
              return { outcome: 'unknown_transport', owned }
            }
            return { outcome: 'unknown_transport' }
          } catch (error) {
            if (!isNotFound(error)) throw error
          }
          const { session, owned } = await createOpenCodeOwnedMemberSession({
            memberIdentity: input.memberIdentity,
            authoritativeSessionId,
            registerRecord: () => { records.set(input.memberIdentity, record) },
            registerOwned: input.registerOwned,
            createSession: () => runOpenCodeMutationWithFreshProof(input.revalidateBeforeCommit,
              () => client.createSession({ id: authoritativeSessionId, title: ownershipTitle })),
          })
          if (session.id !== authoritativeSessionId || session.title !== ownershipTitle) {
            return { outcome: 'unknown_transport', owned }
          }
          await runOpenCodeMutationWithFreshProof(input.revalidateBeforeCommit,
            () => openCodeHostManager.retainHostLease(handle.hostKey, {
              teamId: command.teamId, laneId: command.laneId, memberName: member.name,
              runId: command.runId, sessionId: session.id,
            }))
          const text = bootstrapText(command, member.name, record.opencodeSessionId, member.prompt)
          const contextHash = createHash('sha256').update(text).digest('hex')
          const briefingHash = createHash('sha256').update(member.prompt ?? '').digest('hex')
          const messageID = `msg_000000000000${createHash('sha256').update(contextHash).digest('hex').slice(0, 14)}`
          const returned = await runOpenCodeMutationWithFreshProof(input.revalidateBeforeCommit,
            () => client.sendSessionMessage(record.opencodeSessionId, {
              messageID, agent: 'teammate-bootstrap', noReply: true,
              model: modelParts(command.selectedModel), parts: [{ type: 'text', text }],
            }))
          assertOpenCodeProductionBootstrapOwnership({ message: returned, messageId: messageID,
            sessionId: record.opencodeSessionId, phase: 'returned' })
          const written = await client.getSessionMessage?.(record.opencodeSessionId, messageID)
          const writtenInfo = written?.info ?? {}
          const exactWritten = assertOpenCodeProductionBootstrapOwnership({ message: written,
            messageId: messageID, sessionId: record.opencodeSessionId, phase: 'persisted' })
          if (readOpenCodeExactMessageText(exactWritten) !== text
            || (writtenInfo.providerID ?? writtenInfo.providerId) !== modelParts(command.selectedModel).providerID
            || (writtenInfo.modelID ?? writtenInfo.modelId) !== modelParts(command.selectedModel).modelID) {
            throw new Error('OpenCode noReply bootstrap durable verification failed')
          }
          await input.revalidateBeforeCommit()
          record = { ...record, bootstrapMode: 'app_managed_context',
            bootstrapEvidenceSource: 'app_managed_bootstrap', appManagedBootstrap: {
              schemaVersion: 1, messageID, contextHash,
              briefingHash, injectionVerifiedAt: new Date().toISOString(),
              model: command.selectedModel, agent: 'teammate-bootstrap',
            }, updatedAt: new Date().toISOString() }
          const linkage = linkageFor(input.memberIdentity, record)!
          if (await commitOpenCodeMemberProjection({
            commit: () => input.commitIfClaimLive(linkage, { ownershipTitle, sessionRecord: record }),
            onCommitted: () => retainedSessionLeases.commit(input.memberIdentity),
            upsert: async () => {
              const publication = await openCodeSessionStore.publishReserved(record, reservationIdentity)
              if (publication.status === 'conflict') {
                throw new Error('OpenCode logical member projection is already owned by another session')
              }
              records.set(input.memberIdentity, publication.record)
            },
          }) === 'committed') {
            return { outcome: 'applied', linkage, owned }
          }
          return { outcome: 'unknown_transport', owned }
        },
      },
      ownership: {
        // Physical cleanup below first verifies the remote title and then
        // deletes the exact attempt-owned session. An unconditional abort by
        // deterministic id could affect a foreign session that reused the id.
        abortOwned: async () => {},
        createCleanupObligation: input => {
          const record = records.get(input.resource.memberIdentity)
          const ownershipTitle = memberOwnershipTitles.get(input.resource.memberIdentity)
          const handle = record
            ? Array.from(hosts.values()).find(candidate => candidate.hostKey === record.hostKey)
            : undefined
          if (!record || !ownershipTitle || !input.resource.sessionIdentity
            || !handle || !Number.isFinite(handle.processStartedAtMs)
            || opaque({ kind: 'opencode-session', id: record.opencodeSessionId })
              !== input.resource.sessionIdentity) {
            throw new Error('OpenCode exact member cleanup identity is absent')
          }
          return {
            attemptId: input.attemptId, payloadHash: input.payloadHash,
            generation: input.generation, hostKey: record.hostKey,
            hostProcessId: handle.pid,
            hostProcessStartedAtMs: handle.processStartedAtMs!,
            ...(handle.processBirthToken ? { hostProcessBirthToken: handle.processBirthToken } : {}),
            memberIdentity: input.resource.memberIdentity, memberName: record.memberName,
            teamId: record.teamId, laneId: record.laneId ?? 'primary',
            projectIdentity: record.projectPath,
            runId: command.runId, sessionId: record.opencodeSessionId,
            sessionIdentity: input.resource.sessionIdentity,
            ownershipTitle, phase: 'remote',
          }
        },
        cleanupOwned: async input => {
          if (input.resources.length === 0) return 'complete'
          if (!input.cleanupObligations || !input.advanceCleanupObligation
            || input.cleanupObligations.length !== input.resources.length) return 'timed_out'
          return runMemberCleanupObligations({
            cleanupObligations: input.cleanupObligations,
            advanceCleanupObligation: input.advanceCleanupObligation,
            deadlineAtMs: input.deadlineAtMs, signal: input.signal,
          })
        },
        reconcileCleanupObligations: runMemberCleanupObligations,
      },
      deadline: { run: bounded },
    }
    const core = new OpenCodeLaunchAttempt(
      attemptStore, ports)
    const result = await core.run({ request: command.request,
      members: command.members.map(member => member.memberIdentity),
      requestedBudgetMs: command.deadlineAtMs === undefined
        ? command.outerRemainingBudgetMs ?? command.requestedBudgetMs
        : command.requestedBudgetMs,
      deadlineAtMs: command.deadlineAtMs,
      continuation: command.continuation,
      signal: command.signal,
      commandInputDigest: computeOpenCodeLaunchCommandInputDigest(command),
      commandImmutableDigest: computeOpenCodeLaunchCommandImmutableDigest(command) })
    // Completed receipt tombstones remain durable. Clearing here would run
    // after the attempt lease is released and could race a successor. A later
    // exact reconciliation may compact them only while holding that lease.
    // The core returns only after authoring its durable final. Project that immutable result
    // immediately; reacquiring the store here can deadlock behind a retained cleanup lease and
    // can turn a bounded partial/cancellation return into an unbounded production wait.
    const launchAttempt = projectOpenCodeLaunchAttemptResponse(result)
    this.completedResults.set(command, result)
    const members = Object.fromEntries(command.members.map(member => {
      const record = records.get(member.memberIdentity)
      const committed = result.committed.some(link => link.memberIdentity === member.memberIdentity)
      const failed = result.failed.some(item => item.memberIdentity === member.memberIdentity)
      return [member.name, { ...(record ? { sessionId: record.opencodeSessionId } : {}),
        launchState: committed ? 'created' : failed ? 'failed' : 'pending', evidence: [], diagnostics: [] }]
    }))
    return { snapshot: currentSnapshot ?? {
      detected: false, hostHealthy: false, projectPath: command.projectPath, profile: null, host: null,
      config: null, configProviders: null, providers: null, providerAuth: null, agents: [], mcp: null,
      appMcp: null, probeError: 'launch attempt did not acquire a host', diagnostics: [],
    }, data: { runId: command.runId, providerId: 'opencode', selectedModel: command.selectedModel,
      members, ...(launchAttempt === undefined ? {} : { launchAttempt }) } }
  }
}

function openCodeSessionReservationIdentity(input: Pick<OpenCodeLaunchMutationIdentity,
  'attemptId' | 'payloadHash' | 'immutableDigest' | 'memberIdentity'>): string {
  return createHash('sha256').update(JSON.stringify({ domain: 'agent-teams/opencode-session-reservation/v1',
    attemptId: input.attemptId, payloadHash: input.payloadHash, immutableDigest: input.immutableDigest,
    memberIdentity: input.memberIdentity })).digest('hex')
}

const productionRuntime = new OpenCodeProductionLaunchRuntime()

/** Production composition with inert, caller-owned dependencies for focused regression tests. */
export function createOpenCodeLaunchAttemptProductionTestBridge(
  dependencies: OpenCodeProductionLaunchRuntimeTestDependencies,
): OpenCodeLaunchAttemptBridgePort {
  return createOpenCodeLaunchAttemptProductionBridge(new OpenCodeProductionLaunchRuntime(dependencies))
}

/** Lazy production-startup composition. Injected fake ports never enter this path. */
export function ensureOpenCodeLaunchAttemptProductionComposition(): OpenCodeBridgeCommandHandlerPorts {
  const installed = getOpenCodeLaunchAttemptProductionPorts()
  if (installed) return installed
  const ports = { launchAttempt: createOpenCodeLaunchAttemptProductionBridge(productionRuntime) }
  installOpenCodeLaunchAttemptPortsForProduction(ports)
  return ports
}
