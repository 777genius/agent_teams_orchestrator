import { createHash } from 'node:crypto'

import { openCodeClientFactory } from './OpenCodeClientFactory.js'
import { openCodeEventTranslator } from './OpenCodeEventTranslator.js'
import { openCodeHostManager } from './OpenCodeHostManager.js'
import { openCodeLogProjector } from './OpenCodeLogProjector.js'
import { openCodeMcpManager } from './OpenCodeMcpManager.js'
import { normalizeOpenCodePermissions } from './OpenCodePermissionNormalizer.js'
import { openCodeOfflineSessionReader } from './OpenCodeOfflineSessionReader.js'
import { reserveOpenCodeRuntimePromptMessageId } from './OpenCodeMessageIds.js'
import { hasExactOpenCodeMessageOwnership } from './OpenCodeMessageOwnership.js'
import { openCodeOAuthRefreshCoordinator } from './OpenCodeOAuthRefreshCoordinator.js'
import { openCodePreviewObserver } from './OpenCodePreviewObserver.js'
import {
  buildManagedConfigFingerprint,
  fingerprintOpenCodeScopedInheritedEnvironment,
  openCodeProfileManager,
} from './OpenCodeProfileManager.js'
import { openCodeSessionStore } from './OpenCodeSessionStore.js'
import { openCodeTurnSettledObserver } from './OpenCodeTurnSettledObserver.js'
import { canonicalizeOpenCodeProjectIdentity } from './OpenCodeProjectIdentity.js'

import type {
  OpenCodeAuthState,
  OpenCodeAppMcpStatus,
  OpenCodeLogProjection,
  OpenCodeMessage,
  OpenCodePrepareProfileOptions,
  OpenCodePreparedProfile,
  OpenCodeSessionRecord,
  OpenCodeSessionSuccessorRecoveryProfile,
  OpenCodeSessionPreviewSummary,
  OpenCodeSessionReconcileSummary,
  OpenCodeSessionStatus,
  OpenCodeSessionStatusInput,
  OpenCodeSessionSummary,
  OpenCodeToolApprovalMode,
} from './types.js'
import type { OpenCodeTurnSettledSummary } from './OpenCodeTurnSettledObserver.js'
import type {
  OpenCodeSessionPublicationResult,
  OpenCodeSessionSuccessorPublicationResult,
} from './OpenCodeSessionStore.js'

type OpenCodeSessionBridgeDeps = {
  hostManager?: Pick<typeof openCodeHostManager, 'ensureHost' | 'releaseHost'>
    & Partial<Pick<
      typeof openCodeHostManager,
      'refreshResolvedConfigFingerprint' | 'releaseHostLease'
    >> & { retainHostLease?: (
      hostKey: string,
      input: Parameters<typeof openCodeHostManager.retainHostLease>[1],
    ) => Promise<Awaited<ReturnType<typeof openCodeHostManager.retainHostLease>> | void> }
  sessionStore?: Pick<typeof openCodeSessionStore, 'get'>
    & Partial<Pick<typeof openCodeSessionStore,
      'getByLogicalMember' | 'upsertIfSessionMatches' | 'publishIfAbsentOrExact'
      | 'publishSuccessorIfExact' | 'advanceSuccessorTransitionIfExact'
      | 'markStaleIfSessionMatchesLogicalMember' | 'upsert' | 'markStaleByLogicalMember'
      | 'markStale'>>
  clientFactory?: Pick<typeof openCodeClientFactory, 'create'>
  mcpManager?: Pick<typeof openCodeMcpManager, 'ensureAppMcp'>
  eventTranslator?: Pick<typeof openCodeEventTranslator, 'reconcileSessionMessages'>
  logProjector?: Pick<typeof openCodeLogProjector, 'projectSummary'>
  offlineReader?: Pick<typeof openCodeOfflineSessionReader, 'readSession'>
  previewObserver?: Pick<typeof openCodePreviewObserver, 'observeSession'>
  turnSettledObserver?: Pick<typeof openCodeTurnSettledObserver, 'observe'>
  oauthRefreshCoordinator?: Pick<
    typeof openCodeOAuthRefreshCoordinator,
    'ensureFreshForPrompt'
  >
  prepareProfile?: (
    projectPath?: string | null,
    options?: OpenCodePrepareProfileOptions,
  ) => Promise<OpenCodePreparedProfile>
  fanOutOAuthCredential?: (input: {
    providerId: string
    sourceAuthPath: string
  }) => Promise<void>
}

type OpenCodeClient = ReturnType<typeof openCodeClientFactory.create>

type SessionIdentity = {
  teamId: string
  laneId: string
  memberName: string
}

type PreparedSessionProfile = {
  profile: OpenCodePreparedProfile
  toolApprovalMode: OpenCodeToolApprovalMode
}

export type OpenCodePromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; url: string; filename: string }

export type OpenCodePromptAsyncWithTurnSettledHooks = {
  onPromptSubmitting?: (event: {
    sessionId: string
    runtimePromptMessageId: string
    baseUrl: string
  }) => Promise<void>
  onPromptAccepted?: (event: {
    sessionId: string
    runtimePromptMessageId: string
  }) => Promise<void>
  onTurnObserved?: (event: {
    sessionId: string
    runtimePromptMessageId: string
    turnSettled: OpenCodeTurnSettledSummary
  }) => Promise<void>
}

export type OpenCodeSessionAppMcpReadyResult = {
  ok: boolean
  runtimePid?: number
  status: OpenCodeAppMcpStatus
  connected: boolean | null
  diagnostics: string[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function buildNowIso(): string {
  return new Date().toISOString()
}

function parseProviderScopedModel(selectedModel: string): {
  providerID: string
  modelID: string
} {
  const trimmed = selectedModel.trim()
  const separatorIndex = trimmed.indexOf('/')
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
    throw new Error(`OpenCode model must be provider-scoped, received "${selectedModel}"`)
  }

  return {
    providerID: trimmed.slice(0, separatorIndex),
    modelID: trimmed.slice(separatorIndex + 1),
  }
}

function getMessageId(message: OpenCodeMessage): string | null {
  return asString(asRecord(message.info)?.id)
}

function getMessageText(message: OpenCodeMessage): string {
  return message.parts
    .map(part => typeof part.text === 'string' ? part.text : '')
    .filter(text => text.length > 0)
    .join('\n')
}

function getMessageRole(message: OpenCodeMessage): string | null {
  const info = asRecord(message.info)
  return typeof info?.role === 'string' ? info.role : null
}

function messageHasNoReplySideEffectParts(message: OpenCodeMessage): boolean {
  return message.parts.some((part) => {
    const record = asRecord(part)
    const type = typeof record?.type === 'string' ? record.type : ''
    return type === 'tool' || type === 'permission'
  })
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function buildSuccessorRecoveryIdentity(
  profile: OpenCodePreparedProfile,
  toolApprovalMode: OpenCodeToolApprovalMode,
): OpenCodeSessionSuccessorRecoveryProfile {
  const providerEnvironmentFingerprint = fingerprintOpenCodeScopedInheritedEnvironment(profile.env)
  const identity = {
    version: 2 as const,
    recipe: { toolApprovalMode },
    projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
    behaviorSourcesFingerprint: hashText(JSON.stringify([...profile.behaviorSources].sort())),
    providerEnvironmentFingerprint,
    managedConfigFingerprint: buildManagedConfigFingerprint(profile.managedConfig),
    managedAuthFingerprint: profile.managedAuthFingerprint,
    sourceAuthFingerprint: profile.sourceAuthFingerprint,
    authState: profile.authState,
  }
  return { ...identity, identityDigest: hashText(JSON.stringify(identity)) }
}

function hasExactSuccessorRecoveryIdentity(
  expected: OpenCodeSessionSuccessorRecoveryProfile,
  observed: OpenCodeSessionSuccessorRecoveryProfile,
): boolean {
  return expected.identityDigest === observed.identityDigest
    && JSON.stringify(expected) === JSON.stringify(observed)
}

function extractManagedConfigFingerprintFromHostKey(hostKey: string | null | undefined): string | null {
  const parts = hostKey?.split('::') ?? []
  if (parts.length < 4) {
    return null
  }
  const lastPart = parts[parts.length - 1]
  const fingerprint = lastPart?.startsWith('process:')
    ? parts[parts.length - 2]
    : lastPart
  const trimmed = fingerprint?.trim()
  return trimmed ? trimmed : null
}

function getRecordManagedConfigFingerprint(record: OpenCodeSessionRecord): string | null {
  return record.managedConfigFingerprint ?? extractManagedConfigFingerprintFromHostKey(record.hostKey)
}

function buildDurableSuccessorAttemptIdentity(
  refreshDecisionKey: string,
  predecessor: Pick<OpenCodeSessionRecord, 'opencodeSessionId' | 'runId'>,
): string {
  return createHash('sha256').update(JSON.stringify({
    schema: 'opencode-session-successor-attempt-v1',
    refreshDecisionKey,
    predecessorOpencodeSessionId: predecessor.opencodeSessionId,
    predecessorRunId: predecessor.runId,
  })).digest('hex')
}

function inferToolApprovalModeFromPreparedProfile(
  profile: OpenCodePreparedProfile,
): OpenCodeToolApprovalMode {
  const agentConfig = asRecord(profile.managedConfig.agent)
  const teammateConfig = asRecord(agentConfig?.teammate)
  const permissionConfig = asRecord(teammateConfig?.permission)
  return permissionConfig?.['*'] === 'ask' ? 'manual' : 'auto'
}

function buildOpenCodePromptParts(params: {
  text: string
  parts?: OpenCodePromptPart[]
}): Array<Record<string, unknown>> {
  const providedParts = params.parts ?? []
  if (providedParts.length === 0) {
    return [{ type: 'text', text: params.text }]
  }

  const hasTextPart = providedParts.some(part => part.type === 'text')
  return [
    ...(hasTextPart ? [] : [{ type: 'text', text: params.text }]),
    ...providedParts,
  ]
}

function delayMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const OPENCODE_PROMPT_MESSAGE_ID_RECENT_LIMIT = 50
const OPENCODE_PROMPT_MESSAGE_ID_MAX_ATTEMPTS = 16
const OPENCODE_CREATE_SESSION_TRANSIENT_RETRY_DELAYS_MS = [150, 500]

function isTransientOpenCodeCreateSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return normalized.includes('socket connection was closed unexpectedly') ||
    normalized.includes('socket closed') ||
    normalized.includes('econnreset') ||
    normalized.includes('connection reset') ||
    normalized.includes('und_err_socket') ||
    normalized.includes('fetch failed')
}

export class OpenCodeSessionBridge {
  private readonly retainedSessionHosts = new Map<string, string>()
  private readonly publishedSuccessors = new Map<string, Pick<OpenCodeSessionRecord,
    'opencodeSessionId' | 'runId'>>()
  private readonly pendingSuccessorCleanups = new Map<string, {
    client: OpenCodeClient
    record: OpenCodeSessionRecord
    retainedHostKey: string
    leaseRetained: boolean
  }>()
  private readonly pendingLeaseTransitions = new Map<string, OpenCodeSessionRecord>()
  private readonly durableSuccessorCompletions = new Map<string, Promise<{
    record: OpenCodeSessionRecord
    runtimePid?: number
  }>>()

  constructor(private readonly deps: OpenCodeSessionBridgeDeps = {}) {}

  private get hostManager() {
    return this.deps.hostManager ?? openCodeHostManager
  }

  private get sessionStore() {
    return this.deps.sessionStore ?? openCodeSessionStore
  }

  private getProjectSession(teamId: string, laneId: string, memberName: string,
    projectIdentity: string): Promise<OpenCodeSessionRecord | null> {
    return this.sessionStore.getByLogicalMember?.({ teamId, laneId, memberName, projectIdentity })
      ?? this.sessionStore.get(teamId, laneId, memberName)
  }

  private async markProjectSessionStale(record: Pick<OpenCodeSessionRecord,
    'teamId' | 'laneId' | 'memberName' | 'projectIdentity' | 'opencodeSessionId' | 'runId'>,
  staleReason: string): Promise<OpenCodeSessionRecord> {
    const logicalMember = {
      teamId: record.teamId, laneId: record.laneId ?? 'primary',
      projectIdentity: record.projectIdentity, memberName: record.memberName,
    }
    const result = await this.sessionStore.markStaleIfSessionMatchesLogicalMember?.(
      logicalMember, record.opencodeSessionId, staleReason, record.runId)
    // Compatibility is limited to explicitly injected legacy test adapters;
    // the production store always exposes the fenced transition above.
    if (!result && this.deps.sessionStore) {
      const legacy = await this.sessionStore.markStaleByLogicalMember?.(logicalMember, staleReason)
        ?? await this.sessionStore.markStale?.(
          record.teamId, record.laneId ?? 'primary', record.memberName, staleReason)
      if (legacy) return legacy
    }
    if (!result || result.status === 'absent' || result.status === 'foreign') {
      throw new Error('OpenCode session ownership changed before stale transition')
    }
    return result.record
  }

  private async persistExactUpdate(
    previous: OpenCodeSessionRecord,
    next: OpenCodeSessionRecord,
  ): Promise<OpenCodeSessionRecord> {
    const result = await this.sessionStore.upsertIfSessionMatches?.(
      next, previous.opencodeSessionId, previous.runId)
    // See markProjectSessionStale: production never takes this adapter seam.
    if (!result && this.deps.sessionStore && this.sessionStore.upsert) {
      await this.sessionStore.upsert(next)
      return next
    }
    if (!result || result.status === 'absent' || result.status === 'foreign') {
      throw new Error('OpenCode session ownership changed before metadata transition')
    }
    return result.record
  }

  private get clientFactory() {
    return this.deps.clientFactory ?? openCodeClientFactory
  }

  private get mcpManager() {
    return this.deps.mcpManager ?? openCodeMcpManager
  }

  private get eventTranslator() {
    return this.deps.eventTranslator ?? openCodeEventTranslator
  }

  private get previewObserver() {
    return this.deps.previewObserver ?? openCodePreviewObserver
  }

  private get turnSettledObserver() {
    return this.deps.turnSettledObserver ?? openCodeTurnSettledObserver
  }

  private get logProjector() {
    return this.deps.logProjector ?? openCodeLogProjector
  }

  private get offlineReader() {
    return this.deps.offlineReader ?? openCodeOfflineSessionReader
  }

  private get oauthRefreshCoordinator() {
    return this.deps.oauthRefreshCoordinator ?? openCodeOAuthRefreshCoordinator
  }

  private async fanOutOAuthCredentialAfterPrompt(
    record: OpenCodeSessionRecord,
    profile: OpenCodePreparedProfile,
  ): Promise<void> {
    if (parseProviderScopedModel(record.selectedModel).providerID !== 'xai') {
      return
    }
    const input = {
      providerId: 'xai',
      sourceAuthPath: profile.managedAuthPath,
    }
    if (this.deps.fanOutOAuthCredential) {
      await this.deps.fanOutOAuthCredential(input)
      return
    }
    await openCodeProfileManager.fanOutOAuthCredential(input.providerId, input.sourceAuthPath)
  }

  private async prepareProfile(
    projectPath?: string | null,
    options?: OpenCodePrepareProfileOptions,
  ) {
    const prepareProfile =
      this.deps.prepareProfile
      ?? openCodeProfileManager.prepareProfile.bind(openCodeProfileManager)
    return prepareProfile(projectPath, options)
  }

  private sessionProfileMatchesStoredConfig(
    record: OpenCodeSessionRecord,
    profile: OpenCodePreparedProfile,
  ): boolean {
    const managedConfigFingerprint = getRecordManagedConfigFingerprint(record)
    return !managedConfigFingerprint || managedConfigFingerprint === profile.managedConfigFingerprint
  }

  private async prepareProfileForSessionRecord(
    record: OpenCodeSessionRecord,
    projectPath: string | null | undefined = record.projectPath,
  ): Promise<PreparedSessionProfile> {
    if (record.toolApprovalMode) {
      return {
        profile: await this.prepareProfile(projectPath, { toolApprovalMode: record.toolApprovalMode }),
        toolApprovalMode: record.toolApprovalMode,
      }
    }

    const autoProfile = await this.prepareProfile(projectPath, { toolApprovalMode: 'auto' })
    if (this.sessionProfileMatchesStoredConfig(record, autoProfile)) {
      return { profile: autoProfile, toolApprovalMode: 'auto' }
    }

    const manualProfile = await this.prepareProfile(projectPath, { toolApprovalMode: 'manual' })
    if (this.sessionProfileMatchesStoredConfig(record, manualProfile)) {
      return { profile: manualProfile, toolApprovalMode: 'manual' }
    }

    return { profile: autoProfile, toolApprovalMode: 'auto' }
  }

  private async prepareRecoveryProfileForSuccessor(
    record: OpenCodeSessionRecord,
  ): Promise<OpenCodePreparedProfile> {
    const transition = record.successorTransition
    if (!transition) throw new Error('OpenCode durable successor transition is unavailable')
    const authority = transition.recoveryProfile
    if (!authority) {
      throw new Error(
        'OpenCode legacy durable successor transition has no immutable recovery authority; recovery refused',
      )
    }
    if (authority.version !== 2) {
      throw new Error(
        'OpenCode legacy durable successor transition has no exact protected recovery recipe; recovery refused',
      )
    }
    const authorityDecisionKey = JSON.stringify([
      record.projectIdentity, record.teamId, record.laneId ?? 'primary', record.memberName,
      record.runId, record.selectedModel, record.selectedVariant ?? null,
      authority.identityDigest,
    ])
    if (transition.attemptIdentity !== buildDurableSuccessorAttemptIdentity(
      authorityDecisionKey,
      {
        opencodeSessionId: transition.predecessorOpencodeSessionId,
        runId: transition.predecessorRunId,
      },
    )) {
      throw new Error('OpenCode durable successor recovery profile authority is invalid')
    }
    const rederived = await this.prepareProfile(record.projectPath, {
      toolApprovalMode: authority.recipe.toolApprovalMode,
    })
    const observed = buildSuccessorRecoveryIdentity(
      rederived, authority.recipe.toolApprovalMode)
    if (!hasExactSuccessorRecoveryIdentity(authority, observed)) {
      throw new Error(
        'OpenCode durable successor recovery protected inputs changed; recovery refused before host effects',
      )
    }
    if (rederived.profileRootKey !== record.profileRootKey) {
      throw new Error('OpenCode durable successor recovery profile root identity changed')
    }
    return rederived
  }

  private buildSessionProfileStaleReason(
    record: OpenCodeSessionRecord,
    profile: OpenCodePreparedProfile,
  ): string | null {
    const managedConfigFingerprint = getRecordManagedConfigFingerprint(record)
    return record.staleReason
      ?? (profile.projectPath !== record.projectPath
        ? 'project_path_changed'
        : profile.projectBehaviorFingerprint !== record.projectBehaviorFingerprint
          ? 'project_behavior_changed'
          : managedConfigFingerprint && managedConfigFingerprint !== profile.managedConfigFingerprint
            ? `managed_config_changed:${managedConfigFingerprint}->${profile.managedConfigFingerprint}`
            : profile.managedAuthFingerprint !== record.managedAuthFingerprint
              ? 'managed_auth_changed'
              : null)
  }

  private withSessionProfileMetadata(
    record: OpenCodeSessionRecord,
    sessionProfile: PreparedSessionProfile,
  ): OpenCodeSessionRecord {
    const storedManagedConfigFingerprint = getRecordManagedConfigFingerprint(record)
    const shouldPersistInferredMetadata =
      record.toolApprovalMode !== undefined
      || storedManagedConfigFingerprint !== null
      || sessionProfile.toolApprovalMode !== 'auto'
    if (!shouldPersistInferredMetadata) {
      return record
    }

    if (
      record.toolApprovalMode === sessionProfile.toolApprovalMode
      && record.managedConfigFingerprint === sessionProfile.profile.managedConfigFingerprint
    ) {
      return record
    }

    return {
      ...record,
      toolApprovalMode: sessionProfile.toolApprovalMode,
      managedConfigFingerprint: sessionProfile.profile.managedConfigFingerprint,
      updatedAt: buildNowIso(),
    }
  }

  private async createFreshSessionRecord(params: {
    identity: SessionIdentity
    profile: OpenCodePreparedProfile
    selectedModel: string
    selectedVariant?: string
    title?: string | null
    runId?: string | null
    toolApprovalMode?: OpenCodeToolApprovalMode
  }): Promise<{
    record: OpenCodeSessionRecord
    retainedHostKey: string
    client: OpenCodeClient
  }> {
    const host = await this.hostManager.ensureHost({
      projectPath: params.profile.projectPath,
      preparedProfile: params.profile,
    })

    try {
      const client = this.clientFactory.create(host.baseUrl)
      const sessionTitle = params.title?.trim() || `${params.identity.teamId} - ${params.identity.memberName}`
      let session: OpenCodeSessionSummary | null = null
      let lastCreateError: unknown = null
      for (const [attemptIndex, retryDelayMs] of [0, ...OPENCODE_CREATE_SESSION_TRANSIENT_RETRY_DELAYS_MS].entries()) {
        if (retryDelayMs > 0) {
          await delayMs(retryDelayMs)
        }
        try {
          session = await client.createSession({ title: sessionTitle })
          break
        } catch (error) {
          lastCreateError = error
          if (
            attemptIndex >= OPENCODE_CREATE_SESSION_TRANSIENT_RETRY_DELAYS_MS.length ||
            !isTransientOpenCodeCreateSessionError(error)
          ) {
            throw error
          }
        }
      }
      if (!session) {
        throw lastCreateError instanceof Error
          ? lastCreateError
          : new Error('OpenCode session creation failed')
      }
      const now = buildNowIso()
      const record: OpenCodeSessionRecord = {
        version: 2,
        teamId: params.identity.teamId,
        laneId: params.identity.laneId,
        memberName: params.identity.memberName,
        providerId: 'opencode',
        selectedModel: params.selectedModel,
        ...(params.selectedVariant ? { selectedVariant: params.selectedVariant } : {}),
        projectIdentity: host.projectPath,
        projectPath: host.projectPath,
        runId: params.runId ?? null,
        profileRootKey: host.profileRootKey,
        hostKey: host.hostKey,
        toolApprovalMode: params.toolApprovalMode ?? 'auto',
        runtimePid: host.pid > 0 ? host.pid : undefined,
        resolvedBehaviorFingerprint: host.resolvedConfigFingerprint,
        opencodeSessionId: session.id,
        lastCanonicalCursor: null,
        lastKnownRawStatus: null,
        lastKnownDurableState: null,
        sourceAuthFingerprint: host.profile.sourceAuthFingerprint,
        managedAuthFingerprint: host.profile.managedAuthFingerprint,
        projectBehaviorFingerprint: host.projectBehaviorFingerprint,
        managedConfigFingerprint: host.profile.managedConfigFingerprint,
        opencodeVersion: host.version ?? undefined,
        bootstrapMode: 'app_managed_context',
        staleReason: null,
        createdAt: now,
        updatedAt: now,
      }
      return {
        client,
        retainedHostKey: host.hostKey,
        record,
      }
    } catch (error) {
      await this.hostManager.releaseHost(host.hostKey)
      throw error
    }
  }

  private async releaseCreatedSessionHost(
    created: {
      record: OpenCodeSessionRecord
      retainedHostKey: string
      leaseRetained: boolean
    },
  ): Promise<void> {
    if (created.leaseRetained) {
      const releaseOutcome = await this.hostManager.releaseHostLease?.(
        created.retainedHostKey,
        {
          teamId: created.record.teamId,
          laneId: created.record.laneId,
          memberName: created.record.memberName,
          runId: created.record.runId,
          sessionId: created.record.opencodeSessionId,
        },
      )
      if (releaseOutcome === 'foreign') {
        throw new Error('OpenCode created host lease is owned by a replacement session')
      }
    }
    await this.hostManager.releaseHost(created.retainedHostKey)
  }

  private async retryPendingSuccessorCleanup(
    refreshDecisionKey: string,
    protectedRemoteSessionId: string | null,
  ): Promise<void> {
    const pending = this.pendingSuccessorCleanups.get(refreshDecisionKey)
    if (!pending) return
    const sessionId = pending.record.opencodeSessionId
    if (sessionId === protectedRemoteSessionId) {
      throw new Error(
        `OpenCode successor cleanup remains blocked for protected session ${sessionId} on ${pending.retainedHostKey}`,
      )
    }
    try {
      const deleted = await pending.client.deleteSession(sessionId)
      if (!deleted) throw new Error('OpenCode remote session deletion was not confirmed')
      await this.releaseCreatedSessionHost(pending)
      this.pendingSuccessorCleanups.delete(refreshDecisionKey)
    } catch (error) {
      throw new Error(
        `OpenCode successor cleanup remains required for ${sessionId} on ${pending.retainedHostKey}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }

  private async completePendingLeaseTransition(refreshDecisionKey: string): Promise<void> {
    const predecessor = this.pendingLeaseTransitions.get(refreshDecisionKey)
    if (!predecessor) return
    const oldSessionKey = this.buildSessionKey(predecessor)
    const oldRetainedHost = this.retainedSessionHosts.get(oldSessionKey)
    const oldLeaseOutcome = await this.hostManager.releaseHostLease?.(predecessor.hostKey, {
      teamId: predecessor.teamId,
      laneId: predecessor.laneId,
      memberName: predecessor.memberName,
      runId: predecessor.runId,
      sessionId: predecessor.opencodeSessionId,
    })
    if (oldRetainedHost === predecessor.hostKey) {
      await this.hostManager.releaseHost(oldRetainedHost)
      this.retainedSessionHosts.delete(oldSessionKey)
    } else if (oldLeaseOutcome === 'applied') {
      await this.hostManager.releaseHost(predecessor.hostKey)
    }
    this.pendingLeaseTransitions.delete(refreshDecisionKey)
  }

  private async advanceDurableSuccessorTransition(
    record: OpenCodeSessionRecord,
    expectedPhase: NonNullable<OpenCodeSessionRecord['successorTransition']>['phase'],
    nextPhase: NonNullable<OpenCodeSessionRecord['successorTransition']>['phase'] | null,
  ): Promise<{ record: OpenCodeSessionRecord; applied: boolean }> {
    const transition = record.successorTransition
    if (!transition || transition.phase !== expectedPhase) {
      throw new Error('OpenCode durable successor transition changed before advancement')
    }
    const result = await this.sessionStore.advanceSuccessorTransitionIfExact?.(
      {
        teamId: record.teamId,
        laneId: record.laneId ?? 'primary',
        projectIdentity: record.projectIdentity,
        memberName: record.memberName,
      },
      record.opencodeSessionId,
      record.runId,
      transition.attemptIdentity,
      expectedPhase,
      nextPhase,
    )
    if (!result || result.status === 'absent' || result.status === 'foreign') {
      throw new Error('OpenCode durable successor transition ownership changed')
    }
    const observed = result.record.successorTransition
    if (result.status === 'applied') {
      if (nextPhase === null) {
        if (observed) {
          throw new Error('OpenCode durable successor transition clear lost its exact fence')
        }
      } else if (!observed || observed.attemptIdentity !== transition.attemptIdentity
        || observed.phase !== nextPhase) {
        throw new Error('OpenCode durable successor transition attempt changed')
      }
      return { record: result.record, applied: true }
    }

    const phases = ['successor_lease_pending', 'predecessor_release_pending',
      'transition_complete'] as const
    const advancedTransition = observed?.attemptIdentity === transition.attemptIdentity
      && phases.indexOf(observed.phase) > phases.indexOf(expectedPhase)
    const completed = !observed
      && result.record.successorCompletionReceipt?.attemptIdentity === transition.attemptIdentity
    if (!advancedTransition && !completed) {
      throw new Error('OpenCode durable successor transition lost its exact advancement fence')
    }
    return { record: result.record, applied: false }
  }

  private async completeDurableSuccessorTransition(
    initial: OpenCodeSessionRecord,
    profile: OpenCodePreparedProfile,
  ): Promise<{ record: OpenCodeSessionRecord; runtimePid?: number }> {
    let record = initial
    let runtimePid: number | undefined
    while (record.successorTransition) {
      const transition = record.successorTransition
      if (transition.phase === 'successor_lease_pending') {
        const retention = await this.retainSessionHost(record, record.runId, profile,
          record.hostKey === transition.predecessorHostKey
            ? { runId: transition.predecessorRunId,
              sessionId: transition.predecessorOpencodeSessionId }
            : null)
        if (retention.host?.pid && retention.host.pid > 0) runtimePid = retention.host.pid
        if (retention.outcome === 'foreign') {
          await this.releaseContendingSessionHostReference(record, false)
          throw new Error('OpenCode durable successor lease is owned by a newer session')
        }
        let advancement: Awaited<ReturnType<typeof this.advanceDurableSuccessorTransition>>
        try {
          advancement = await this.advanceDurableSuccessorTransition(
            record, 'successor_lease_pending', 'predecessor_release_pending')
        } catch (error) {
          let inspected = false
          let observed: OpenCodeSessionRecord | null = null
          try {
            if (this.sessionStore.getByLogicalMember) {
              observed = await this.sessionStore.getByLogicalMember({
                teamId: record.teamId, laneId: record.laneId ?? 'primary',
                projectIdentity: record.projectIdentity, memberName: record.memberName,
              })
              inspected = true
            }
          } catch {
            // An uncertain store write must retain the lease conservatively;
            // restart recovery will resolve whether the CAS committed.
          }
          const observedTransition = observed?.successorTransition
          const installedLeaseIsStale = inspected && (!observed
            || observed.opencodeSessionId !== record.opencodeSessionId
            || observed.runId !== record.runId
            || observedTransition?.attemptIdentity !== transition.attemptIdentity)
          await this.releaseContendingSessionHostReference(record,
            retention.outcome === 'applied' && installedLeaseIsStale)
          throw error
        }
        if (!advancement.applied) {
          // Another contender bound this exact run/session lease to the same
          // attempt. Only this process's local reference is surplus; the
          // durable lease is no longer stale even if this process installed it.
          await this.releaseContendingSessionHostReference(record, false)
          runtimePid = undefined
        }
        record = advancement.record
        continue
      }
      if (transition.phase === 'predecessor_release_pending') {
        const predecessor = {
          teamId: record.teamId,
          laneId: record.laneId,
          memberName: record.memberName,
          projectIdentity: record.projectIdentity,
          hostKey: transition.predecessorHostKey,
          opencodeSessionId: transition.predecessorOpencodeSessionId,
          runId: transition.predecessorRunId,
        }
        const oldSessionKey = this.buildSessionKey(predecessor)
        const oldRetainedHost = this.retainedSessionHosts.get(oldSessionKey)
        const outcome = await this.hostManager.releaseHostLease?.(
          transition.predecessorHostKey,
          {
            teamId: record.teamId,
            laneId: record.laneId,
            memberName: record.memberName,
            runId: transition.predecessorRunId,
            sessionId: transition.predecessorOpencodeSessionId,
          },
        )
        if (oldRetainedHost === transition.predecessorHostKey) {
          await this.hostManager.releaseHost(oldRetainedHost)
          this.retainedSessionHosts.delete(oldSessionKey)
        } else if (outcome === 'applied') {
          await this.hostManager.releaseHost(transition.predecessorHostKey)
        }
        record = (await this.advanceDurableSuccessorTransition(
          record, 'predecessor_release_pending', 'transition_complete')).record
        continue
      }
      record = (await this.advanceDurableSuccessorTransition(
        record, 'transition_complete', null)).record
    }
    return { record, ...(runtimePid ? { runtimePid } : {}) }
  }

  private async releaseContendingSessionHostReference(
    record: OpenCodeSessionRecord,
    releaseInstalledLease: boolean,
  ): Promise<void> {
    if (releaseInstalledLease) {
      await this.hostManager.releaseHostLease?.(record.hostKey, {
        teamId: record.teamId, laneId: record.laneId, memberName: record.memberName,
        runId: record.runId, sessionId: record.opencodeSessionId,
      })
    }
    await this.hostManager.releaseHost(record.hostKey)
    const sessionKey = this.buildSessionKey(record)
    if (this.retainedSessionHosts.get(sessionKey) === record.hostKey) {
      this.retainedSessionHosts.delete(sessionKey)
    }
  }

  /** Coalesces only callers sharing this bridge's process-local host references. */
  private completeDurableSuccessorTransitionLocally(
    initial: OpenCodeSessionRecord,
    profile: OpenCodePreparedProfile,
  ): Promise<{ record: OpenCodeSessionRecord; runtimePid?: number }> {
    const transition = initial.successorTransition
    if (!transition) return Promise.resolve({ record: initial })
    const key = JSON.stringify([
      initial.projectIdentity, initial.teamId, initial.laneId ?? 'primary', initial.memberName,
      initial.opencodeSessionId, initial.runId, transition.attemptIdentity,
    ])
    const pending = this.durableSuccessorCompletions.get(key)
    if (pending) return pending
    const completion = this.completeDurableSuccessorTransition(initial, profile)
      .finally(() => {
        if (this.durableSuccessorCompletions.get(key) === completion) {
          this.durableSuccessorCompletions.delete(key)
        }
      })
    this.durableSuccessorCompletions.set(key, completion)
    return completion
  }

  private async rejectUnpublishedSuccessor(
    refreshDecisionKey: string,
    created: {
      client: OpenCodeClient
      record: OpenCodeSessionRecord
      retainedHostKey: string
      leaseRetained: boolean
    },
    protectedRemoteSessionId: string | null,
    publicationError: unknown,
  ): Promise<never> {
    const sessionId = created.record.opencodeSessionId
    if (sessionId === protectedRemoteSessionId) {
      await this.releaseCreatedSessionHost(created)
      throw publicationError
    }
    try {
      const deleted = await created.client.deleteSession(sessionId)
      if (!deleted) throw new Error('OpenCode remote session deletion was not confirmed')
    } catch (cleanupError) {
      this.pendingSuccessorCleanups.set(refreshDecisionKey, created)
      throw new Error(
        `OpenCode successor publication failed and remote cleanup remains required for ${sessionId} on ${created.retainedHostKey}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        { cause: publicationError },
      )
    }
    await this.releaseCreatedSessionHost(created)
    throw publicationError
  }

  private buildSessionKey(
    identity: Pick<OpenCodeSessionRecord, 'teamId' | 'memberName' | 'projectIdentity'
      | 'opencodeSessionId' | 'runId'> & { laneId?: string | null },
  ): string {
    return JSON.stringify([
      identity.projectIdentity, identity.teamId, identity.laneId?.trim() || 'primary',
      identity.memberName, identity.runId, identity.opencodeSessionId,
    ])
  }

  private async retainSessionHost(
    record: OpenCodeSessionRecord,
    runId?: string | null,
    profile?: OpenCodePreparedProfile,
    expected?: { runId: string | null; sessionId: string | null } | null,
  ): Promise<{ host: OpenCodeHostHandle | null; outcome: 'applied' | 'exact' | 'foreign' }> {
    const sessionKey = this.buildSessionKey(record)
    if (this.retainedSessionHosts.get(sessionKey) === record.hostKey) {
      const outcome = await this.hostManager.retainHostLease?.(record.hostKey, {
        teamId: record.teamId,
        laneId: record.laneId,
        memberName: record.memberName,
        runId: runId ?? null,
        sessionId: record.opencodeSessionId,
        expected,
      })
      return { host: null, outcome: outcome ?? 'applied' }
    }

    const sessionProfile = profile
      ? {
        profile,
        toolApprovalMode: record.toolApprovalMode ?? inferToolApprovalModeFromPreparedProfile(profile),
      }
      : await this.prepareProfileForSessionRecord(record)
    const host = await this.hostManager.ensureHost({
      projectPath: record.projectPath,
      hostKey: record.hostKey,
      preparedProfile: sessionProfile.profile,
    })
    let retentionOutcome: 'applied' | 'exact' | 'foreign' = 'applied'
    try {
      const outcome = await this.hostManager.retainHostLease?.(record.hostKey, {
        teamId: record.teamId,
        laneId: record.laneId,
        memberName: record.memberName,
        runId: runId ?? null,
        sessionId: record.opencodeSessionId,
        expected,
      })
      retentionOutcome = outcome ?? 'applied'
    } catch (error) {
      await this.hostManager.releaseHost(record.hostKey)
      throw error
    }
    this.retainedSessionHosts.set(sessionKey, record.hostKey)
    return { host, outcome: retentionOutcome }
  }

  async releaseSession(record: Pick<OpenCodeSessionRecord,
    'teamId' | 'laneId' | 'memberName' | 'hostKey' | 'opencodeSessionId'
    | 'projectIdentity' | 'runId'>): Promise<void> {
    const sessionKey = this.buildSessionKey(record)
    const retainedHostKey = this.retainedSessionHosts.get(sessionKey)
    const leaseOutcome = await this.hostManager.releaseHostLease?.(record.hostKey, {
      teamId: record.teamId,
      laneId: record.laneId,
      memberName: record.memberName,
      runId: record.runId,
      sessionId: record.opencodeSessionId,
    })
    if (leaseOutcome === 'foreign') {
      throw new Error('OpenCode host lease is owned by a replacement session')
    }
    if (!retainedHostKey) {
      return
    }

    if (retainedHostKey !== record.hostKey) {
      throw new Error('OpenCode retained host ownership changed before release')
    }
    this.retainedSessionHosts.delete(sessionKey)
    await this.hostManager.releaseHost(retainedHostKey)
  }

  async ensureSessionAppMcpReady(
    record: OpenCodeSessionRecord,
    options: { attachIfMissing?: boolean } = {},
  ): Promise<OpenCodeSessionAppMcpReadyResult> {
    return this.withSessionHost(record, async ({ baseUrl, runtimePid }) => {
      let result: Awaited<ReturnType<typeof openCodeMcpManager.ensureAppMcp>>
      try {
        result = await this.mcpManager.ensureAppMcp({
          baseUrl,
          attachIfMissing: options.attachIfMissing === true,
        })
      } catch (error) {
        return {
          ok: false,
          ...(runtimePid && runtimePid > 0 ? { runtimePid } : {}),
          status: 'attach_failed',
          connected: null,
          diagnostics: [
            `OpenCode app MCP readiness check failed: ${error instanceof Error ? error.message : String(error)}`,
          ],
        }
      }
      const ok = result.summary.connected === true
        && (result.summary.status === 'present' || result.summary.status === 'attached')
      return {
        ok,
        ...(runtimePid && runtimePid > 0 ? { runtimePid } : {}),
        status: result.summary.status,
        connected: result.summary.connected,
        diagnostics: result.summary.diagnostics,
      }
    })
  }

  private async withSessionHost<T>(
    record: OpenCodeSessionRecord,
    callback: (context: {
      baseUrl: string
      profile: OpenCodePreparedProfile
      resolvedConfigFingerprint: string | null
      runtimePid: number | null
    }) => Promise<T>,
    profile?: OpenCodePreparedProfile,
  ): Promise<T> {
    const sessionProfile = profile
      ? {
        profile,
        toolApprovalMode: record.toolApprovalMode ?? inferToolApprovalModeFromPreparedProfile(profile),
      }
      : await this.prepareProfileForSessionRecord(record)
    const host = await this.hostManager.ensureHost({
      projectPath: record.projectPath,
      hostKey: record.hostKey,
      preparedProfile: sessionProfile.profile,
    })
    await this.hostManager.retainHostLease?.(record.hostKey, {
      teamId: record.teamId,
      laneId: record.laneId,
      memberName: record.memberName,
      runId: record.runId,
      sessionId: record.opencodeSessionId,
    }).catch(() => undefined)

    try {
      return await callback({
        baseUrl: host.baseUrl,
        profile: sessionProfile.profile,
        resolvedConfigFingerprint: host.resolvedConfigFingerprint,
        runtimePid: host.pid > 0 ? host.pid : null,
      })
    } finally {
      await this.hostManager.releaseHost(host.hostKey)
    }
  }

  private async withSessionPromptHost<T>(
    record: OpenCodeSessionRecord,
    callback: (context: {
      baseUrl: string
      profile: OpenCodePreparedProfile
      resolvedConfigFingerprint: string | null
      runtimePid: number | null
    }) => Promise<T>,
  ): Promise<T> {
    let sessionProfile = await this.prepareProfileForSessionRecord(record)
    const refreshResult = await this.oauthRefreshCoordinator.ensureFreshForPrompt({
      selectedModel: record.selectedModel,
      projectPath: record.projectPath,
      profile: sessionProfile.profile,
    })
    if (refreshResult.refreshed) {
      sessionProfile = await this.prepareProfileForSessionRecord(record)
    }
    return this.withSessionHost(record, callback, sessionProfile.profile)
  }

  private buildUpdatedRecord(
    record: OpenCodeSessionRecord,
    patch: Partial<Pick<OpenCodeSessionRecord, 'lastCanonicalCursor' | 'lastKnownRawStatus' | 'lastKnownDurableState' | 'resolvedBehaviorFingerprint'>>,
  ): OpenCodeSessionRecord {
    const next: OpenCodeSessionRecord = {
      ...record,
      ...patch,
    }

    const changed =
      next.lastCanonicalCursor !== record.lastCanonicalCursor
      || next.lastKnownRawStatus !== record.lastKnownRawStatus
      || next.lastKnownDurableState !== record.lastKnownDurableState
      || next.resolvedBehaviorFingerprint !== record.resolvedBehaviorFingerprint

    if (changed) {
      next.updatedAt = buildNowIso()
    }

    return next
  }

  private async buildStaleReconcileResult(params: {
    record: OpenCodeSessionRecord
    staleReason: string
    profileAuthState: OpenCodeAuthState | null
    diagnostics: string[]
  }): Promise<{
    record: OpenCodeSessionRecord
    summary: OpenCodeSessionReconcileSummary
  }> {
    const nextRecord =
      params.record.staleReason === params.staleReason
        ? params.record
        : (await this.markProjectSessionStale(params.record, params.staleReason)) ?? {
            ...params.record,
            staleReason: params.staleReason,
            updatedAt: buildNowIso(),
          }

    return {
      record: nextRecord,
      summary: {
        sessionId: nextRecord.opencodeSessionId,
        reconcileOutcome: 'stale',
        rawStatus: nextRecord.lastKnownRawStatus as OpenCodeSessionStatus | null,
        durableState: nextRecord.lastKnownDurableState ?? 'unknown',
        staleReason: params.staleReason,
        profileAuthState: params.profileAuthState,
        pendingPermissionRequestIds: [],
        messageCount: 0,
        toolCallCount: 0,
        errorCount: 0,
        lastCanonicalCursor: nextRecord.lastCanonicalCursor,
        latestUserMessageId: null,
        latestAssistantMessageId: null,
        latestAssistantText: null,
        latestAssistantPreview: null,
        replyPendingSinceMessageId: null,
        messages: [],
        diagnostics: [
          `OpenCode session reconcile skipped because the stored session is stale (${params.staleReason})`,
          ...params.diagnostics,
        ],
      },
    }
  }

  private async buildStalePreviewResult(params: {
    record: OpenCodeSessionRecord
    staleReason: string
    profileAuthState: OpenCodeAuthState | null
    diagnostics: string[]
  }): Promise<{
    record: OpenCodeSessionRecord
    summary: OpenCodeSessionPreviewSummary
  }> {
    const nextRecord =
      params.record.staleReason === params.staleReason
        ? params.record
        : (await this.markProjectSessionStale(params.record, params.staleReason)) ?? {
            ...params.record,
            staleReason: params.staleReason,
            updatedAt: buildNowIso(),
          }

    return {
      record: nextRecord,
      summary: {
        sessionId: nextRecord.opencodeSessionId,
        previewOutcome: 'stale',
        staleReason: params.staleReason,
        profileAuthState: params.profileAuthState,
        streamEndpoint: null,
        streamConnected: false,
        observedEventCount: 0,
        matchedEventCount: 0,
        runtimeState: nextRecord.lastKnownDurableState === 'reply_pending'
          ? 'unknown'
          : (nextRecord.lastKnownDurableState ?? 'unknown'),
        latestEventType: null,
        latestAssistantMessageId: null,
        latestAssistantPreview: null,
        pendingPermissionRequestIds: [],
        diagnostics: [
          `OpenCode preview observation skipped because the stored session is stale (${params.staleReason})`,
          ...params.diagnostics,
        ],
      },
    }
  }

  async ensureSession(params: {
    teamId: string
    laneId?: string
    memberName: string
    selectedModel: string
    selectedVariant?: string
    title?: string | null
    projectPath?: string | null
    preparedProfile?: OpenCodePreparedProfile | null
    runId?: string | null
    fresh?: boolean
    toolApprovalMode?: OpenCodeToolApprovalMode
  }): Promise<OpenCodeSessionRecord> {
    const laneId = params.laneId?.trim() || 'primary'
    const selectedVariant = params.selectedVariant?.trim() || undefined
    // Recover a published host under its immutable profile authority before
    // current preparation is allowed to materialize drifted config or auth.
    const recoveryProjectIdentity = params.preparedProfile?.projectPath
      ?? await canonicalizeOpenCodeProjectIdentity(
        params.projectPath ?? process.cwd(), { allowMissing: true })
    let existing = await this.getProjectSession(
      params.teamId, laneId, params.memberName, recoveryProjectIdentity)
    let recoveredTransition: { record: OpenCodeSessionRecord; runtimePid?: number } | null = null
    let recoveredAttempt: NonNullable<OpenCodeSessionRecord['successorTransition']> | null = null
    if (existing?.successorTransition) {
      recoveredAttempt = existing.successorTransition
      const recoveryProfile = await this.prepareRecoveryProfileForSuccessor(existing)
      recoveredTransition = await this.completeDurableSuccessorTransitionLocally(
        existing, recoveryProfile)
      existing = recoveredTransition.record
    }
    const initialProfile = params.preparedProfile
      ?? await this.prepareProfile(params.projectPath, {
        toolApprovalMode: params.toolApprovalMode ?? 'auto',
      })
    const projectIdentity = initialProfile.projectPath
    if (projectIdentity !== recoveryProjectIdentity) {
      existing = await this.getProjectSession(
        params.teamId, laneId, params.memberName, projectIdentity)
      recoveredTransition = null
      recoveredAttempt = null
    }
    const requestedProfile: PreparedSessionProfile = params.preparedProfile
      ? {
        profile: params.preparedProfile,
        toolApprovalMode: params.toolApprovalMode
          ?? existing?.toolApprovalMode
          ?? inferToolApprovalModeFromPreparedProfile(params.preparedProfile),
      }
      : params.toolApprovalMode
        ? {
          profile: initialProfile,
          toolApprovalMode: params.toolApprovalMode,
        }
        : existing
          ? existing.toolApprovalMode === 'auto'
            ? { profile: initialProfile, toolApprovalMode: 'auto' }
            : existing.toolApprovalMode === 'manual'
              ? {
                profile: await this.prepareProfile(params.projectPath, { toolApprovalMode: 'manual' }),
                toolApprovalMode: 'manual',
              }
              : this.sessionProfileMatchesStoredConfig(existing, initialProfile)
                ? { profile: initialProfile, toolApprovalMode: 'auto' }
                : {
                  profile: await this.prepareProfile(params.projectPath, { toolApprovalMode: 'manual' }),
                  toolApprovalMode: 'manual',
                }
          : {
            profile: initialProfile,
            toolApprovalMode: 'auto',
          }
    const profile = requestedProfile.profile
    const recoveryIdentity = buildSuccessorRecoveryIdentity(
      profile, requestedProfile.toolApprovalMode)
    const refreshDecisionKey = JSON.stringify([
      projectIdentity, params.teamId, laneId, params.memberName,
      params.runId ?? null, params.selectedModel, selectedVariant ?? null,
      recoveryIdentity.identityDigest,
    ])
    await this.retryPendingSuccessorCleanup(
      refreshDecisionKey,
      existing?.opencodeSessionId ?? null,
    )
    if (recoveredTransition) {
      const transition = existing.successorCompletionReceipt ?? recoveredAttempt
      if (!transition) throw new Error('OpenCode durable successor completion receipt is unavailable')
      const isCurrentAttempt = transition.attemptIdentity
        === buildDurableSuccessorAttemptIdentity(refreshDecisionKey, {
          opencodeSessionId: transition.predecessorOpencodeSessionId,
          runId: transition.predecessorRunId,
        })
      const recoveredMatchesNonFreshRequest = params.fresh !== true
        && existing.selectedModel === params.selectedModel
        && existing.selectedVariant === selectedVariant
        && existing.runId === (params.runId ?? null)
        && existing.projectBehaviorFingerprint === profile.projectBehaviorFingerprint
        && existing.managedAuthFingerprint === profile.managedAuthFingerprint
        && (!getRecordManagedConfigFingerprint(existing)
          || getRecordManagedConfigFingerprint(existing) === profile.managedConfigFingerprint)
        && !existing.staleReason
      if (isCurrentAttempt || recoveredMatchesNonFreshRequest) {
        return recoveredTransition.runtimePid
          ? { ...recoveredTransition.record, runtimePid: recoveredTransition.runtimePid }
          : recoveredTransition.record
      }
    }
    const knownSuccessor = this.publishedSuccessors.get(refreshDecisionKey)
    if (
      existing && knownSuccessor
      && existing.opencodeSessionId === knownSuccessor.opencodeSessionId
      && existing.runId === knownSuccessor.runId
    ) {
      const retained = await this.retainSessionHost(existing, existing.runId, profile)
      await this.completePendingLeaseTransition(refreshDecisionKey)
      this.publishedSuccessors.delete(refreshDecisionKey)
      this.pendingLeaseTransitions.delete(refreshDecisionKey)
      return retained.host?.pid && retained.host.pid > 0
        ? { ...existing, runtimePid: retained.host.pid } : existing
    }
    const existingManagedConfigFingerprint = existing
      ? getRecordManagedConfigFingerprint(existing)
      : null
    if (
      existing &&
      existing.selectedModel === params.selectedModel &&
      existing.selectedVariant === selectedVariant &&
      existing.projectPath === profile.projectPath &&
      existing.projectBehaviorFingerprint === profile.projectBehaviorFingerprint &&
      existing.managedAuthFingerprint === profile.managedAuthFingerprint &&
      (!existingManagedConfigFingerprint || existingManagedConfigFingerprint === profile.managedConfigFingerprint) &&
      existing.runId === (params.runId ?? null) &&
      params.fresh !== true &&
      !existing.staleReason
    ) {
      const host = await this.retainSessionHost(existing, params.runId, profile)
      const cleanRecord = this.withSessionProfileMetadata(existing, requestedProfile)
      if (cleanRecord !== existing) {
        await this.persistExactUpdate(existing, cleanRecord)
      }
      return host.host?.pid && host.host.pid > 0
        ? { ...cleanRecord, runtimePid: host.host.pid } : cleanRecord
    }

    if (existing) {
      const staleReason =
        params.fresh === true
          ? 'fresh_launch_requested'
          : existing.selectedModel !== params.selectedModel
          ? `model_changed:${existing.selectedModel}->${params.selectedModel}`
          : existing.selectedVariant !== selectedVariant
            ? `variant_changed:${existing.selectedVariant ?? 'default'}->${selectedVariant ?? 'default'}`
          : existing.runId !== (params.runId ?? null)
            ? 'run_owner_changed'
          : existing.projectPath !== profile.projectPath
            ? 'project_path_changed'
            : existing.projectBehaviorFingerprint !== profile.projectBehaviorFingerprint
              ? 'project_behavior_changed'
              : existingManagedConfigFingerprint && existingManagedConfigFingerprint !== profile.managedConfigFingerprint
                ? `managed_config_changed:${existingManagedConfigFingerprint}->${profile.managedConfigFingerprint}`
                : existing.managedAuthFingerprint !== profile.managedAuthFingerprint
                  ? 'managed_auth_changed'
                  : existing.staleReason ?? 'session_refresh_required'

      // The reason is computed before the provider effect so this invocation has
      // an attempt-local refresh decision. The durable old owner remains intact
      // until the successor CAS below succeeds.
      void staleReason
    }

    const created = await this.createFreshSessionRecord({
      identity: {
        teamId: params.teamId,
        laneId,
        memberName: params.memberName,
      },
      profile,
      selectedModel: params.selectedModel,
      selectedVariant,
      title: params.title,
      runId: params.runId ?? null,
      toolApprovalMode: requestedProfile.toolApprovalMode,
    })
    let protectedRemoteSessionId = existing?.opencodeSessionId ?? null
    let publication: OpenCodeSessionPublicationResult
      | OpenCodeSessionSuccessorPublicationResult
      | undefined
    try {
      if (existing && this.sessionStore.advanceSuccessorTransitionIfExact) {
        created.record = {
          ...created.record,
          successorTransition: {
            version: 1,
            attemptIdentity: buildDurableSuccessorAttemptIdentity(
              refreshDecisionKey, existing),
            phase: 'successor_lease_pending',
            predecessorHostKey: existing.hostKey,
            predecessorOpencodeSessionId: existing.opencodeSessionId,
            predecessorRunId: existing.runId,
            recoveryProfile: recoveryIdentity,
          },
        }
      }
      publication = existing
        ? await this.sessionStore.publishSuccessorIfExact?.(
          created.record,
          existing.opencodeSessionId,
          existing.runId,
        )
        : await this.sessionStore.publishIfAbsentOrExact?.(created.record)
      if (!existing && !publication && this.deps.sessionStore && this.sessionStore.upsert) {
        await this.sessionStore.upsert(created.record)
        publication = { status: 'inserted', record: created.record }
      }
      if (publication && 'record' in publication
        && publication.status === 'conflict' && publication.record) {
        protectedRemoteSessionId = publication.record.opencodeSessionId
      }
      if (!publication || publication.status === 'conflict'
        || publication.status === 'absent') {
        throw new Error('OpenCode session ownership changed before publication')
      }
    } catch (error) {
      return this.rejectUnpublishedSuccessor(
        refreshDecisionKey,
        { ...created, leaseRetained: false },
        protectedRemoteSessionId,
        error,
      )
    }

    this.retainedSessionHosts.set(
      this.buildSessionKey(created.record),
      created.retainedHostKey,
    )
    if (created.record.successorTransition) {
      try {
        const completed = await this.completeDurableSuccessorTransitionLocally(
          created.record, profile)
        return completed.runtimePid
          ? { ...completed.record, runtimePid: completed.runtimePid }
          : completed.record
      } catch (error) {
        throw new Error(
          `OpenCode successor session ${created.record.opencodeSessionId} has a recoverable durable lease transition: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
    }

    this.publishedSuccessors.set(refreshDecisionKey, {
      opencodeSessionId: created.record.opencodeSessionId,
      runId: created.record.runId,
    })
    if (existing) {
      this.pendingLeaseTransitions.set(refreshDecisionKey, existing)
    }
    try {
      await this.hostManager.retainHostLease?.(created.retainedHostKey, {
        teamId: created.record.teamId,
        laneId: created.record.laneId,
        memberName: created.record.memberName,
        runId: created.record.runId,
        sessionId: created.record.opencodeSessionId,
      })
    } catch (error) {
      throw new Error(
        `OpenCode session ${created.record.opencodeSessionId} was published but successor host lease retention failed on ${created.retainedHostKey}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    if (existing) {
      try {
        await this.completePendingLeaseTransition(refreshDecisionKey)
      } catch (error) {
        throw new Error(
          `OpenCode successor session ${created.record.opencodeSessionId} is safe but predecessor host lease release failed on ${existing.hostKey}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
    }
    this.publishedSuccessors.delete(refreshDecisionKey)
    this.pendingLeaseTransitions.delete(refreshDecisionKey)
    return created.record
  }

  async refreshSessionEnvironment(record: OpenCodeSessionRecord): Promise<OpenCodeSessionRecord> {
    const [sessionProfile, resolvedBehaviorFingerprint] = await Promise.all([
      this.prepareProfileForSessionRecord(record),
      this.hostManager.refreshResolvedConfigFingerprint?.(record.hostKey) ?? Promise.resolve(null),
    ])
    const profile = sessionProfile.profile
    const next: OpenCodeSessionRecord = {
      ...record,
      toolApprovalMode: sessionProfile.toolApprovalMode,
      sourceAuthFingerprint: profile.sourceAuthFingerprint,
      managedAuthFingerprint: profile.managedAuthFingerprint,
      projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
      managedConfigFingerprint: profile.managedConfigFingerprint,
      resolvedBehaviorFingerprint: resolvedBehaviorFingerprint ?? record.resolvedBehaviorFingerprint,
    }
    const changed =
      next.toolApprovalMode !== record.toolApprovalMode
      || next.sourceAuthFingerprint !== record.sourceAuthFingerprint
      || next.managedAuthFingerprint !== record.managedAuthFingerprint
      || next.projectBehaviorFingerprint !== record.projectBehaviorFingerprint
      || next.managedConfigFingerprint !== record.managedConfigFingerprint
      || next.resolvedBehaviorFingerprint !== record.resolvedBehaviorFingerprint

    if (!changed) {
      return record
    }

    next.updatedAt = buildNowIso()
    return this.persistExactUpdate(record, next)
  }

  async listMessages(
    record: OpenCodeSessionRecord,
    limit?: number,
  ): Promise<OpenCodeMessage[]> {
    return this.withSessionHost(record, async ({ baseUrl }) => {
      const client = this.clientFactory.create(baseUrl)
      return client.getSessionMessages(record.opencodeSessionId, limit)
    })
  }

  private async getSessionMessage(
    client: ReturnType<typeof openCodeClientFactory.create>,
    sessionId: string,
    messageID: string,
  ): Promise<OpenCodeMessage | null> {
    if (client.getSessionMessage) {
      return client.getSessionMessage(sessionId, messageID)
    }
    const messages = await client.getSessionMessages(sessionId)
    return messages.find(message => getMessageId(message) === messageID) ?? null
  }

  private async allocateRuntimePromptMessageId(
    client: OpenCodeClient,
    sessionId: string,
  ): Promise<{
    runtimePromptMessageId: string
    diagnostics: string[]
  }> {
    const diagnostics: string[] = []
    let lowerBoundMessageIds: Array<string | null> = []
    try {
      const messages = await client.getSessionMessages(
        sessionId,
        OPENCODE_PROMPT_MESSAGE_ID_RECENT_LIMIT,
      )
      lowerBoundMessageIds = messages.map(getMessageId)
    } catch (error) {
      diagnostics.push(
        `OpenCode prompt id lower-bound check skipped - ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    let latestLowerBoundMessageId: string | null = null
    for (let attempt = 0; attempt < OPENCODE_PROMPT_MESSAGE_ID_MAX_ATTEMPTS; attempt += 1) {
      const reservation = reserveOpenCodeRuntimePromptMessageId({
        lowerBoundMessageIds,
      })
      latestLowerBoundMessageId = reservation.lowerBoundMessageId
      if (reservation.waitMs > 0) {
        await delayMs(reservation.waitMs)
      }
      if (
        !reservation.lowerBoundMessageId ||
        reservation.runtimePromptMessageId > reservation.lowerBoundMessageId
      ) {
        return {
          runtimePromptMessageId: reservation.runtimePromptMessageId,
          diagnostics,
        }
      }
      await delayMs(1)
    }

    throw new Error(
      `OpenCode prompt id allocation failed to advance past ${latestLowerBoundMessageId ?? 'unknown'} after ${OPENCODE_PROMPT_MESSAGE_ID_MAX_ATTEMPTS} attempts`,
    )
  }

  async sendMessage(
    record: OpenCodeSessionRecord,
    params: {
      text: string
      parts?: OpenCodePromptPart[]
      agent?: string
      noReply?: boolean
      system?: string
    },
  ): Promise<OpenCodeMessage> {
    return this.withSessionPromptHost(record, async ({ baseUrl, profile }) => {
      const client = this.clientFactory.create(baseUrl)
      try {
        return await client.sendSessionMessage(record.opencodeSessionId, {
          agent: params.agent,
          noReply: params.noReply,
          system: params.system,
          ...(record.selectedVariant ? { variant: record.selectedVariant } : {}),
          model: parseProviderScopedModel(record.selectedModel),
          parts: buildOpenCodePromptParts({
            text: params.text,
            parts: params.parts,
          }),
        })
      } finally {
        await this.fanOutOAuthCredentialAfterPrompt(record, profile).catch(() => undefined)
      }
    })
  }

  async injectAppManagedBootstrapContext(
    record: OpenCodeSessionRecord,
    params: {
      messageID: string
      text: string
      agent?: string
      contextHash: string
      briefingHash: string
    },
  ): Promise<{
    messageID: string
    runtimeSessionId: string
    contextHash: string
    briefingHash: string
    injectionVerifiedAt: string
    alreadyPresent: boolean
  }> {
    return this.withSessionPromptHost(record, async ({ baseUrl }) => {
      const client = this.clientFactory.create(baseUrl)
      const assertMessageMatches = (message: OpenCodeMessage | null, phase: string) => {
        if (!message) {
          throw new Error(`OpenCode app-managed bootstrap context was not found after ${phase}`)
        }
        const actualId = getMessageId(message)
        if (actualId !== params.messageID) {
          throw new Error(
            `OpenCode app-managed bootstrap context id mismatch after ${phase}: expected ${params.messageID}, got ${actualId ?? 'missing'}`,
          )
        }
        if (!hasExactOpenCodeMessageOwnership(message, params.messageID, record.opencodeSessionId)) {
          throw new Error(
            `OpenCode app-managed bootstrap context session mismatch after ${phase}: expected ${record.opencodeSessionId}`,
          )
        }
        const actualHash = hashText(getMessageText(message))
        if (actualHash !== params.contextHash) {
          throw new Error(
            `OpenCode app-managed bootstrap context hash mismatch after ${phase}: expected ${params.contextHash}, got ${actualHash}`,
          )
        }
      }

      const existing = await this.getSessionMessage(client, record.opencodeSessionId, params.messageID)
      if (existing) {
        assertMessageMatches(existing, 'read-before-send')
        return {
          messageID: params.messageID,
          runtimeSessionId: record.opencodeSessionId,
          contextHash: params.contextHash,
          briefingHash: params.briefingHash,
          injectionVerifiedAt: buildNowIso(),
          alreadyPresent: true,
        }
      }

      const beforeMessages = await client.getSessionMessages(record.opencodeSessionId, 20)
        .catch(() => [] as OpenCodeMessage[])
      const beforeMessageIds = new Set(
        beforeMessages.map(message => getMessageId(message)).filter((id): id is string => id !== null),
      )
      // This is a context injection, not a model turn. noReply keeps bootstrap
      // deterministic; the side-effect check below protects against OpenCode
      // accidentally producing assistant/tool output that could be mistaken for
      // launch readiness or a visible teammate reply.
      const returned = await client.sendSessionMessage(record.opencodeSessionId, {
        messageID: params.messageID,
        ...(params.agent ? { agent: params.agent } : {}),
        noReply: true,
        ...(record.selectedVariant ? { variant: record.selectedVariant } : {}),
        model: parseProviderScopedModel(record.selectedModel),
        parts: [{ type: 'text', text: params.text }],
      })
      assertMessageMatches(returned, 'send')

      let written: OpenCodeMessage | null = null
      for (const delay of [0, 100, 250, 500]) {
        if (delay > 0) {
          await delayMs(delay)
        }
        written = await this.getSessionMessage(client, record.opencodeSessionId, params.messageID)
        if (written) {
          break
        }
      }
      assertMessageMatches(written, 'read-after-send')
      const recentMessages = await client.getSessionMessages(record.opencodeSessionId, 20)
        .catch(() => [] as OpenCodeMessage[])
      const sideEffect = recentMessages.find((message) => {
        const id = getMessageId(message)
        if (!id || id === params.messageID || beforeMessageIds.has(id)) {
          return false
        }
        const parentId = asString(asRecord(message.info)?.parentID)
        if (parentId !== params.messageID) {
          return false
        }
        const role = getMessageRole(message)
        return role === 'assistant' || messageHasNoReplySideEffectParts(message)
      })
      if (sideEffect) {
        throw new Error(
          `OpenCode app-managed noReply bootstrap produced a side-effect message ${getMessageId(sideEffect) ?? 'unknown'}`,
        )
      }

      return {
        messageID: params.messageID,
        runtimeSessionId: record.opencodeSessionId,
        contextHash: params.contextHash,
        briefingHash: params.briefingHash,
        injectionVerifiedAt: buildNowIso(),
        alreadyPresent: false,
      }
    })
  }

  async promptAsync(
    record: OpenCodeSessionRecord,
    params: {
      text: string
      parts?: OpenCodePromptPart[]
      agent?: string
      noReply?: boolean
      system?: string
    },
  ): Promise<void> {
    await this.withSessionPromptHost(record, async ({ baseUrl, profile }) => {
      const client = this.clientFactory.create(baseUrl)
      try {
        await client.promptSessionAsync(record.opencodeSessionId, {
          agent: params.agent,
          noReply: params.noReply,
          system: params.system,
          ...(record.selectedVariant ? { variant: record.selectedVariant } : {}),
          model: parseProviderScopedModel(record.selectedModel),
          parts: buildOpenCodePromptParts({
            text: params.text,
            parts: params.parts,
          }),
        })
      } finally {
        await this.fanOutOAuthCredentialAfterPrompt(record, profile).catch(() => undefined)
      }
    })
  }

  async promptAsyncWithTurnSettled(
    record: OpenCodeSessionRecord,
    params: {
      text: string
      parts?: OpenCodePromptPart[]
      agent?: string
      noReply?: boolean
      system?: string
      timeoutMs?: number
      idleTimeoutMs?: number
    } & OpenCodePromptAsyncWithTurnSettledHooks,
  ): Promise<{
    runtimePromptMessageId: string
    turnSettled: OpenCodeTurnSettledSummary
    hookDiagnostics: string[]
  }> {
    if (params.noReply) {
      throw new Error('OpenCode turn-settled observation does not support noReply prompts')
    }
    return this.withSessionPromptHost(record, async ({ baseUrl, profile }) => {
      const client = this.clientFactory.create(baseUrl)
      const allocation = await this.allocateRuntimePromptMessageId(client, record.opencodeSessionId)
      const observation = this.turnSettledObserver.observe({
        baseUrl,
        sessionId: record.opencodeSessionId,
        projectPath: record.projectPath,
        runtimePromptMessageId: allocation.runtimePromptMessageId,
        timeoutMs: params.timeoutMs,
        idleTimeoutMs: params.idleTimeoutMs,
      })
      const hookDiagnostics: string[] = [...allocation.diagnostics]
      let endpointAccepted = false
      try {
        observation.markPromptSubmitting()
        await params.onPromptSubmitting?.({
          sessionId: record.opencodeSessionId,
          runtimePromptMessageId: observation.runtimePromptMessageId,
          baseUrl,
        })
        await client.promptSessionAsync(record.opencodeSessionId, {
          messageID: observation.runtimePromptMessageId,
          agent: params.agent,
          noReply: params.noReply,
          system: params.system,
          ...(record.selectedVariant ? { variant: record.selectedVariant } : {}),
          model: parseProviderScopedModel(record.selectedModel),
          parts: buildOpenCodePromptParts({
            text: params.text,
            parts: params.parts,
          }),
        })
        endpointAccepted = true
        observation.markPromptAcceptedByEndpoint()
        try {
          await params.onPromptAccepted?.({
            sessionId: record.opencodeSessionId,
            runtimePromptMessageId: observation.runtimePromptMessageId,
          })
        } catch (error) {
          hookDiagnostics.push(
            `OpenCode prompt accepted hook failed - ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        const turnSettled = await observation.waitForSettled()
        try {
          await params.onTurnObserved?.({
            sessionId: record.opencodeSessionId,
            runtimePromptMessageId: observation.runtimePromptMessageId,
            turnSettled,
          })
        } catch (error) {
          hookDiagnostics.push(
            `OpenCode turn observed hook failed - ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        return {
          runtimePromptMessageId: observation.runtimePromptMessageId,
          turnSettled,
          hookDiagnostics,
        }
      } catch (error) {
        if (!endpointAccepted) {
          observation.markPromptRejectedByEndpoint(error)
        }
        throw error
      } finally {
        observation.dispose()
        await this.fanOutOAuthCredentialAfterPrompt(record, profile).catch(() => undefined)
      }
    })
  }

  async abort(record: OpenCodeSessionRecord): Promise<boolean> {
    return this.withSessionHost(record, async ({ baseUrl }) => {
      const client = this.clientFactory.create(baseUrl)
      return client.abortSession(record.opencodeSessionId)
    })
  }

  async answerPermission(
    record: OpenCodeSessionRecord,
    params: {
      requestId: string
      decision: 'allow' | 'always' | 'reject'
    },
  ): Promise<unknown> {
    return this.withSessionHost(record, async ({ baseUrl }) => {
      const client = this.clientFactory.create(baseUrl)
      return client.answerPermission({
        requestId: params.requestId,
        sessionId: record.opencodeSessionId,
        decision: params.decision,
      })
    })
  }

  async getSession(record: OpenCodeSessionRecord): Promise<OpenCodeSessionSummary> {
    return this.withSessionHost(record, async ({ baseUrl }) => {
      const client = this.clientFactory.create(baseUrl)
      return client.getSession(record.opencodeSessionId)
    })
  }

  async getRawStatus(record: OpenCodeSessionRecord): Promise<OpenCodeSessionStatusInput | null> {
    return this.withSessionHost(record, async ({ baseUrl }) => {
      const client = this.clientFactory.create(baseUrl)
      const statusMap = await client.getSessionStatus()
      return statusMap[record.opencodeSessionId] ?? null
    })
  }

  async promptAsyncUntilAccepted(
    record: OpenCodeSessionRecord,
    params: {
      text: string
      parts?: OpenCodePromptPart[]
      agent?: string
      noReply?: boolean
      system?: string
    } & Pick<OpenCodePromptAsyncWithTurnSettledHooks, 'onPromptSubmitting' | 'onPromptAccepted'>,
  ): Promise<{
    runtimePromptMessageId: string
    hookDiagnostics: string[]
  }> {
    if (params.noReply) {
      throw new Error('OpenCode prompt acceptance observation does not support noReply prompts')
    }
    return this.withSessionPromptHost(record, async ({ baseUrl, profile }) => {
      const client = this.clientFactory.create(baseUrl)
      try {
        const allocation = await this.allocateRuntimePromptMessageId(client, record.opencodeSessionId)
        const runtimePromptMessageId = allocation.runtimePromptMessageId
        const hookDiagnostics: string[] = [...allocation.diagnostics]
        await params.onPromptSubmitting?.({
          sessionId: record.opencodeSessionId,
          runtimePromptMessageId,
          baseUrl,
        })
        await client.promptSessionAsync(record.opencodeSessionId, {
          messageID: runtimePromptMessageId,
          agent: params.agent,
          noReply: false,
          system: params.system,
          ...(record.selectedVariant ? { variant: record.selectedVariant } : {}),
          model: parseProviderScopedModel(record.selectedModel),
          parts: buildOpenCodePromptParts({
            text: params.text,
            parts: params.parts,
          }),
        })
        try {
          await params.onPromptAccepted?.({
            sessionId: record.opencodeSessionId,
            runtimePromptMessageId,
          })
        } catch (error) {
          hookDiagnostics.push(
            `OpenCode prompt accepted hook failed - ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        return {
          runtimePromptMessageId,
          hookDiagnostics,
        }
      } finally {
        await this.fanOutOAuthCredentialAfterPrompt(record, profile).catch(() => undefined)
      }
    })
  }

  async reconcileSession(
    record: OpenCodeSessionRecord,
    options: {
      limit?: number
      sessionId?: string | null
    } = {},
  ): Promise<{
    record: OpenCodeSessionRecord
    summary: OpenCodeSessionReconcileSummary
  }> {
    const sessionProfile = await this.prepareProfileForSessionRecord(record)
    const profile = sessionProfile.profile
    const activeRecord = this.withSessionProfileMetadata(record, sessionProfile)
    const staleReason = this.buildSessionProfileStaleReason(record, profile)

    const preflightDiagnostics: string[] = []
    if (profile.authState === 'stale') {
      preflightDiagnostics.push('Managed OpenCode auth import is stale relative to the source auth store')
    }

    if (staleReason) {
      return this.buildStaleReconcileResult({
        record,
        staleReason,
        profileAuthState: profile.authState,
        diagnostics: preflightDiagnostics,
      })
    }

    return this.withSessionHost(activeRecord, async ({ baseUrl, resolvedConfigFingerprint, runtimePid }) => {
      if (
        activeRecord.resolvedBehaviorFingerprint
        && resolvedConfigFingerprint
        && activeRecord.resolvedBehaviorFingerprint !== resolvedConfigFingerprint
      ) {
        return this.buildStaleReconcileResult({
          record: activeRecord,
          staleReason: `resolved_behavior_changed:${activeRecord.resolvedBehaviorFingerprint}->${resolvedConfigFingerprint}`,
          profileAuthState: profile.authState,
          diagnostics: preflightDiagnostics,
        })
      }

      const client = this.clientFactory.create(baseUrl)
      let permissionDiagnostic: string | null = null
      const [statusMap, pendingPermissions] = await Promise.all([
        client.getSessionStatus(),
        client.getPermissions().catch(error => {
          permissionDiagnostic = error instanceof Error ? error.message : String(error)
          return []
        }),
      ])
      const messageDiagnostics: string[] = []
      const targetSessionId = options.sessionId?.trim() || activeRecord.opencodeSessionId
      let messages = await client.getSessionMessages(targetSessionId, options.limit)
      if (
        typeof options.limit === 'number'
        && activeRecord.lastCanonicalCursor
        && !messages.some(message => getMessageId(message) === activeRecord.lastCanonicalCursor)
      ) {
        messageDiagnostics.push(
          `Stored cursor ${activeRecord.lastCanonicalCursor} was missing from the latest ${options.limit} messages, rebuilding full OpenCode session history`,
        )
        messages = await client.getSessionMessages(targetSessionId)
      }
      const rawStatus = statusMap[targetSessionId] ?? null
      const summary = this.eventTranslator.reconcileSessionMessages({
        sessionId: targetSessionId,
        rawStatus,
        messages,
      })
      summary.profileAuthState = profile.authState
      const normalizedPendingPermissions = normalizeOpenCodePermissions(pendingPermissions)
        .filter(permission => permission.sessionId === targetSessionId)
      const pendingPermissionRequestIds = normalizedPendingPermissions
        .map(permission => permission.requestId)
      summary.pendingPermissions = normalizedPendingPermissions
      summary.pendingPermissionRequestIds = pendingPermissionRequestIds
      if (pendingPermissionRequestIds.length > 0) {
        summary.durableState = 'blocked'
        summary.diagnostics.push(
          `OpenCode session has ${pendingPermissionRequestIds.length} pending permission request(s)`,
        )
      }
      if (permissionDiagnostic) {
        summary.diagnostics.push(`Permission probe unavailable - ${permissionDiagnostic}`)
      }
      if (messageDiagnostics.length > 0) {
        summary.diagnostics.push(...messageDiagnostics)
      }
      if (preflightDiagnostics.length > 0) {
        summary.diagnostics.push(...preflightDiagnostics)
      }

      const nextRecord = this.buildUpdatedRecord(activeRecord, {
        lastCanonicalCursor: summary.lastCanonicalCursor,
        lastKnownRawStatus: summary.rawStatus,
        lastKnownDurableState: summary.durableState,
        resolvedBehaviorFingerprint: resolvedConfigFingerprint ?? activeRecord.resolvedBehaviorFingerprint,
      })
      const isCurrentSession = targetSessionId === activeRecord.opencodeSessionId

      if (
        isCurrentSession &&
        (
          nextRecord.lastCanonicalCursor !== record.lastCanonicalCursor
          || nextRecord.lastKnownRawStatus !== record.lastKnownRawStatus
          || nextRecord.lastKnownDurableState !== record.lastKnownDurableState
          || nextRecord.resolvedBehaviorFingerprint !== record.resolvedBehaviorFingerprint
          || nextRecord.managedConfigFingerprint !== record.managedConfigFingerprint
          || nextRecord.toolApprovalMode !== record.toolApprovalMode
        )
      ) {
        await this.persistExactUpdate(record, nextRecord)
      }

      const reconciledRecord = isCurrentSession ? nextRecord : activeRecord
      return {
        record: runtimePid ? { ...reconciledRecord, runtimePid } : reconciledRecord,
        summary,
      }
    }, profile)
  }

  async observePreview(
    record: OpenCodeSessionRecord,
    options: {
      timeoutMs?: number
      idleTimeoutMs?: number
      signal?: AbortSignal
    } = {},
  ): Promise<{
    record: OpenCodeSessionRecord
    summary: OpenCodeSessionPreviewSummary
  }> {
    const sessionProfile = await this.prepareProfileForSessionRecord(record)
    const profile = sessionProfile.profile
    const activeRecord = this.withSessionProfileMetadata(record, sessionProfile)
    const staleReason = this.buildSessionProfileStaleReason(record, profile)

    const preflightDiagnostics: string[] = []
    if (profile.authState === 'stale') {
      preflightDiagnostics.push('Managed OpenCode auth import is stale relative to the source auth store')
    }

    if (staleReason) {
      return this.buildStalePreviewResult({
        record,
        staleReason,
        profileAuthState: profile.authState,
        diagnostics: preflightDiagnostics,
      })
    }

    return this.withSessionHost(activeRecord, async ({ baseUrl, resolvedConfigFingerprint }) => {
      if (
        activeRecord.resolvedBehaviorFingerprint
        && resolvedConfigFingerprint
        && activeRecord.resolvedBehaviorFingerprint !== resolvedConfigFingerprint
      ) {
        return this.buildStalePreviewResult({
          record: activeRecord,
          staleReason: `resolved_behavior_changed:${activeRecord.resolvedBehaviorFingerprint}->${resolvedConfigFingerprint}`,
          profileAuthState: profile.authState,
          diagnostics: preflightDiagnostics,
        })
      }

      const summary = await this.previewObserver.observeSession({
        baseUrl,
        sessionId: activeRecord.opencodeSessionId,
        timeoutMs: options.timeoutMs,
        idleTimeoutMs: options.idleTimeoutMs,
        signal: options.signal,
      })
      summary.profileAuthState = profile.authState
      if (preflightDiagnostics.length > 0) {
        summary.diagnostics.push(...preflightDiagnostics)
      }

      return {
        record: activeRecord,
        summary,
      }
    }, profile)
  }

  async projectLogMessages(
    record: OpenCodeSessionRecord,
    options: {
      limit?: number
    } = {},
  ): Promise<{
    record: OpenCodeSessionRecord
    summary: OpenCodeSessionReconcileSummary
    logProjection: OpenCodeLogProjection
  }> {
    let reconciled = await this.reconcileSession(record, options)
    if (reconciled.summary.reconcileOutcome === 'stale') {
      try {
        reconciled = await this.readStaleSessionMessagesForLogProjection(record, {
          limit: options.limit,
          staleReason: reconciled.summary.staleReason ?? record.staleReason ?? 'stale_session',
          profileAuthState: reconciled.summary.profileAuthState,
          diagnostics: reconciled.summary.diagnostics,
        })
      } catch (error) {
        reconciled.summary.diagnostics.push(
          `OpenCode stale session log read failed - ${error instanceof Error ? error.message : String(error)}`,
        )
        const offline = await this.readOfflineSessionMessagesForLogProjection(record, {
          staleReason: reconciled.summary.staleReason ?? record.staleReason ?? 'stale_session',
          profileAuthState: reconciled.summary.profileAuthState,
          diagnostics: reconciled.summary.diagnostics,
        })
        if (offline) {
          reconciled = offline
        }
      }
    }

    return {
      ...reconciled,
      logProjection: this.logProjector.projectSummary(reconciled.summary),
    }
  }

  private async readStaleSessionMessagesForLogProjection(
    record: OpenCodeSessionRecord,
    options: {
      limit?: number
      staleReason: string
      profileAuthState: OpenCodeAuthState | null
      diagnostics: string[]
    },
  ): Promise<{
    record: OpenCodeSessionRecord
    summary: OpenCodeSessionReconcileSummary
  }> {
    return this.withSessionHost(record, async ({ baseUrl, runtimePid }) => {
      const client = this.clientFactory.create(baseUrl)
      const diagnostics = [...options.diagnostics]
      let rawStatus: OpenCodeSessionStatusInput | null = null
      try {
        const statusMap = await client.getSessionStatus()
        rawStatus = statusMap[record.opencodeSessionId] ?? null
      } catch (error) {
        diagnostics.push(
          `OpenCode stale session status unavailable during log projection - ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      const summary = this.eventTranslator.reconcileSessionMessages({
        sessionId: record.opencodeSessionId,
        rawStatus,
        messages: await client.getSessionMessages(record.opencodeSessionId, options.limit),
      })
      summary.reconcileOutcome = 'stale'
      summary.staleReason = options.staleReason
      summary.profileAuthState = options.profileAuthState
      summary.diagnostics.unshift(
        `OpenCode session is stale (${options.staleReason}); reading historical messages for log projection only`,
      )
      summary.diagnostics.push(...diagnostics)

      return {
        record: runtimePid ? { ...record, runtimePid } : record,
        summary,
      }
    })
  }

  private async readOfflineSessionMessagesForLogProjection(
    record: OpenCodeSessionRecord,
    options: {
      staleReason: string
      profileAuthState: OpenCodeAuthState | null
      diagnostics: string[]
    },
  ): Promise<{
    record: OpenCodeSessionRecord
    summary: OpenCodeSessionReconcileSummary
  } | null> {
    const offline = await this.offlineReader.readSession(record)
    if (!offline || offline.messages.length === 0) {
      return null
    }
    const summary = this.eventTranslator.reconcileSessionMessages({
      sessionId: record.opencodeSessionId,
      rawStatus: record.lastKnownRawStatus as OpenCodeSessionStatus | null,
      messages: offline.messages,
    })
    summary.reconcileOutcome = 'stale'
    summary.staleReason = options.staleReason
    summary.profileAuthState = options.profileAuthState
    summary.diagnostics.unshift(
      `OpenCode session is stale (${options.staleReason}); recovered historical messages from local SQLite store`,
    )
    summary.diagnostics.push(...options.diagnostics, ...offline.diagnostics)
    return { record, summary }
  }
}

export const openCodeSessionBridge = new OpenCodeSessionBridge()
