import { createHash } from 'node:crypto'

import { jsonStringify } from '../../utils/slowOperations.js'

import { openCodeClientFactory } from './OpenCodeClientFactory.js'
import { openCodeEventTranslator } from './OpenCodeEventTranslator.js'
import { openCodeHostManager } from './OpenCodeHostManager.js'
import { openCodeLogProjector } from './OpenCodeLogProjector.js'
import { openCodeMcpManager } from './OpenCodeMcpManager.js'
import { normalizeOpenCodePermissions } from './OpenCodePermissionNormalizer.js'
import { openCodeOfflineSessionReader } from './OpenCodeOfflineSessionReader.js'
import { reserveOpenCodeRuntimePromptMessageId } from './OpenCodeMessageIds.js'
import { openCodeOAuthRefreshCoordinator } from './OpenCodeOAuthRefreshCoordinator.js'
import { openCodePreviewObserver } from './OpenCodePreviewObserver.js'
import { canonicalizeOpenCodeProviderId } from './OpenCodeProviderIdentity.js'
import { throwOpenCodeAbortReason } from './OpenCodeRuntimeDeadline.js'
import {
  assertOpenCodePreparedProfileScope,
  openCodeProfileManager,
  resolveOpenCodeProfileScope,
} from './OpenCodeProfileManager.js'
import { openCodeSessionStore } from './OpenCodeSessionStore.js'
import type { MaterializationOwnerToken } from './OpenCodeSessionStore.js'
import { refreshSelectedProfileAuthority } from './OpenCodeSelectedProfileAuthority.js'
import { openCodeTurnSettledObserver } from './OpenCodeTurnSettledObserver.js'

import type {
  OpenCodeAuthState,
  OpenCodeAppMcpStatus,
  OpenCodeHostHandle,
  OpenCodeLogProjection,
  OpenCodeMessage,
  OpenCodePrepareProfileOptions,
  OpenCodePreparedProfile,
  OpenCodeProfileScope,
  OpenCodeSessionRecord,
  OpenCodeSessionPreviewSummary,
  OpenCodeSessionReconcileSummary,
  OpenCodeSessionStatus,
  OpenCodeSessionStatusInput,
  OpenCodeSessionSummary,
  OpenCodeToolApprovalMode,
} from './types.js'
import type { OpenCodeTurnSettledSummary } from './OpenCodeTurnSettledObserver.js'

type OpenCodeSessionBridgeDeps = {
  hostManager?: Pick<typeof openCodeHostManager, 'ensureHost' | 'releaseHost'>
    & Partial<Pick<
      typeof openCodeHostManager,
      'refreshResolvedConfigFingerprint' | 'releaseHostLease' | 'retainHostLease'
    >>
  sessionStore?: Pick<typeof openCodeSessionStore, 'get' | 'upsert' | 'markStale'>
    & Partial<Pick<typeof openCodeSessionStore,
      'claimMaterialization' | 'commitMaterialization' | 'releaseMaterializationClaim'
      | 'acquireMaterializationOwner' | 'releaseMaterializationOwner' | 'trackPendingMaterializationReconciliation'>>
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

function extractManagedConfigFingerprintFromHostKey(hostKey: string | null | undefined): string | null {
  const parts = hostKey?.split('::') ?? []
  if (parts.length < 4) {
    return null
  }
  const fingerprint = parts[3]
  const trimmed = fingerprint?.trim()
  return trimmed ? trimmed : null
}

function getRecordManagedConfigFingerprint(record: OpenCodeSessionRecord): string | null {
  return record.managedConfigFingerprint ?? extractManagedConfigFingerprintFromHostKey(record.hostKey)
}

function profileScopeMetadataMatches(
  left: OpenCodeProfileScope | null | undefined,
  right: OpenCodeProfileScope | null | undefined,
): boolean {
  return (!left && !right) || Boolean(
    left
    && right
    && left.purpose === right.purpose
    && left.providerId === right.providerId
    && left.configFingerprint === right.configFingerprint
    && left.selectedAuthIdentity === right.selectedAuthIdentity
    && left.scopeToken === right.scopeToken,
  )
}

export type OpenCodeStrictSessionCompatibility = {
  teamId: string
  runId: string
  laneId: string
  memberName: string
  selectedModel: string
  selectedVariant?: string
  host: OpenCodeHostHandle
  toolApprovalMode: OpenCodeToolApprovalMode
  expectedBehaviorFingerprint: string
  bootstrap: {
    messageID: string
    contextHash: string
    briefingHash: string
    agent: string
  }
}

type OpenCodeMaterializeSessionOnHostParams = {
  teamId: string
  laneId: string
  memberName: string
  selectedModel: string
  selectedVariant?: string
  title?: string | null
  runId: string
  attemptId?: string
  host: OpenCodeHostHandle
  signal: AbortSignal
  remainingMs: () => number
  toolApprovalMode?: OpenCodeToolApprovalMode
  expectedBehaviorFingerprint: string
  expectedBootstrapForSession: (
    sessionId: string,
  ) => OpenCodeStrictSessionCompatibility['bootstrap']
}

type OpenCodeMaterializeSessionOnHostResult = {
  record: OpenCodeSessionRecord
  ownerToken?: MaterializationOwnerToken
  created: boolean
  resumeBootstrap?: boolean
}

export function isOpenCodeStrictSessionCompatible(
  record: OpenCodeSessionRecord,
  expected: OpenCodeStrictSessionCompatibility,
): boolean {
  const bootstrap = record.appManagedBootstrap
  return isOpenCodeStrictMaterializedSessionCompatible(record, expected)
    && record.bootstrapMode === 'app_managed_context'
    && record.bootstrapEvidenceSource === 'app_managed_bootstrap'
    && bootstrap?.messageID === expected.bootstrap.messageID
    && bootstrap.contextHash === expected.bootstrap.contextHash
    && bootstrap.briefingHash === expected.bootstrap.briefingHash
    && bootstrap.model === expected.selectedModel
    && bootstrap.agent === expected.bootstrap.agent
}

function canResumeOpenCodeStrictBootstrap(record: OpenCodeSessionRecord): boolean {
  return (record.bootstrapMode === undefined || record.bootstrapMode === 'app_managed_context')
    && record.bootstrapEvidenceSource === undefined
    && record.appManagedBootstrap === undefined
}

function isOpenCodeStrictMaterializedSessionCompatible(
  record: OpenCodeSessionRecord,
  expected: OpenCodeStrictSessionCompatibility,
): boolean {
  return !record.stoppedAt && !record.staleReason
    && record.teamId === expected.teamId
    && record.runId === expected.runId
    && record.laneId === expected.laneId
    && record.memberName === expected.memberName
    && record.hostKey === expected.host.hostKey
    && record.projectPath === expected.host.projectPath
    && record.profileRootKey === expected.host.profileRootKey
    && ((!record.profileScope && !expected.host.profile.profileScope)
      || profileScopeMetadataMatches(record.profileScope, expected.host.profile.profileScope))
    && record.toolApprovalMode === expected.toolApprovalMode
    && record.selectedModel === expected.selectedModel
    && (record.selectedVariant?.trim() || undefined) === (expected.selectedVariant?.trim() || undefined)
    && record.resolvedBehaviorFingerprint === expected.host.resolvedConfigFingerprint
    && record.projectBehaviorFingerprint === expected.host.projectBehaviorFingerprint
    && record.managedConfigFingerprint === expected.host.profile.managedConfigFingerprint
    && record.sourceAuthFingerprint === expected.host.profile.sourceAuthFingerprint
    && record.managedAuthFingerprint === expected.host.profile.managedAuthFingerprint
    && record.expectedBehaviorFingerprint === expected.expectedBehaviorFingerprint
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

  constructor(private readonly deps: OpenCodeSessionBridgeDeps = {}) {}

  private get hostManager() {
    return this.deps.hostManager ?? openCodeHostManager
  }

  private get sessionStore() {
    return this.deps.sessionStore ?? openCodeSessionStore
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
    // A stored scope token belongs to the process that created the record. Resolve
    // a new snapshot before preparing so restart reconciliation never consumes it.
    const profileScope = await resolveOpenCodeProfileScope({
        projectPath,
        purpose: 'launch_runtime',
        selectedModel: record.selectedModel,
      })
    if (record.toolApprovalMode) {
      return {
        profile: await this.prepareProfile(projectPath, {
          toolApprovalMode: record.toolApprovalMode,
          profileScope,
        }),
        toolApprovalMode: record.toolApprovalMode,
      }
    }

    const autoProfile = await this.prepareProfile(projectPath, { toolApprovalMode: 'auto', profileScope })
    if (this.sessionProfileMatchesStoredConfig(record, autoProfile)) {
      return { profile: autoProfile, toolApprovalMode: 'auto' }
    }

    const manualProfile = await this.prepareProfile(projectPath, { toolApprovalMode: 'manual', profileScope })
    if (this.sessionProfileMatchesStoredConfig(record, manualProfile)) {
      return { profile: manualProfile, toolApprovalMode: 'manual' }
    }

    return { profile: autoProfile, toolApprovalMode: 'auto' }
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
              : !profileScopeMetadataMatches(record.profileScope, profile.profileScope)
                ? 'profile_scope_changed'
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
      && profileScopeMetadataMatches(record.profileScope, sessionProfile.profile.profileScope)
    ) {
      return record
    }

    return {
      ...record,
      toolApprovalMode: sessionProfile.toolApprovalMode,
      managedConfigFingerprint: sessionProfile.profile.managedConfigFingerprint,
      profileScope: sessionProfile.profile.profileScope ?? null,
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
  }): Promise<{ record: OpenCodeSessionRecord; retainedHostKey: string }> {
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
        teamId: params.identity.teamId,
        laneId: params.identity.laneId,
        memberName: params.identity.memberName,
        providerId: 'opencode',
        selectedModel: params.selectedModel,
        ...(params.selectedVariant ? { selectedVariant: params.selectedVariant } : {}),
        projectPath: host.projectPath,
        profileRootKey: host.profileRootKey,
        hostKey: host.hostKey,
        profileScope: host.profile.profileScope ?? null,
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
      await this.hostManager.retainHostLease?.(host.hostKey, {
        teamId: params.identity.teamId,
        laneId: params.identity.laneId,
        memberName: params.identity.memberName,
        runId: params.runId ?? null,
        sessionId: session.id,
      }).catch(() => undefined)

      return {
        retainedHostKey: host.hostKey,
        record,
      }
    } catch (error) {
      await this.hostManager.releaseHost(host.hostKey)
      throw error
    }
  }

  private buildSessionKey(
    identity: Pick<SessionIdentity, 'teamId' | 'memberName'> & { laneId?: string | null },
  ): string {
    return `${identity.teamId}::${identity.laneId?.trim() || 'primary'}::${identity.memberName}`
  }

  private async ensureSessionAuthorityHost(record: OpenCodeSessionRecord, profile: OpenCodePreparedProfile) {
    if (record.stoppedAt) throw new Error('OpenCode session is stopped; launch a new run')
    const scoped = record.profileScope?.purpose === 'launch_runtime'
    if (scoped) {
      const current = await this.sessionStore.get(record.teamId, record.laneId ?? 'primary', record.memberName)
      if (!current || current.stoppedAt || current.runId !== record.runId
        || current.opencodeSessionId !== record.opencodeSessionId) {
        throw new Error('OpenCode selected session is no longer active; launch a new run')
      }
    }
    if (scoped && (!record.runId || !record.expectedBehaviorFingerprint
      || !/^[a-f0-9]{64}$/.test(record.expectedBehaviorFingerprint)
      || !record.managedConfigFingerprint
      || record.resolvedBehaviorFingerprint !== record.managedConfigFingerprint
      || this.buildSessionProfileStaleReason(record, profile))) {
      throw new Error('OpenCode selected session authority is stale or unavailable; relaunch the lane')
    }
    const host = await this.hostManager.ensureHost({
      projectPath: record.projectPath,
      hostKey: record.hostKey,
      preparedProfile: profile,
      ...(scoped ? { resolveConfigFingerprint: false, prewarmManagedSubscriptionPlugins: false } : {}),
    })
    if (!scoped) return host
    try {
      // A selected launch seals the managed-config domain, not the broad
      // provider inventory hash. Revalidate its live authority before reuse.
      if (host.hostKey !== record.hostKey
        || host.resolvedConfigFingerprint !== record.managedConfigFingerprint) {
        throw new Error('OpenCode selected session fingerprint domain changed; relaunch the lane')
      }
      const refreshed = await refreshSelectedProfileAuthority({
        host,
        selectedModel: record.selectedModel,
        expectedBehaviorFingerprint: record.expectedBehaviorFingerprint!,
      }, { clientFactory: this.clientFactory, mcpManager: this.mcpManager })
      if (!refreshed || refreshed.managedConfigFingerprint !== record.managedConfigFingerprint) {
        throw new Error('OpenCode selected session live authority changed; relaunch the lane')
      }
      return host
    } catch (error) {
      await this.hostManager.releaseHost(host.hostKey)
      throw error
    }
  }

  private async retainSessionHost(
    record: OpenCodeSessionRecord,
    runId?: string | null,
    profile?: OpenCodePreparedProfile,
  ) {
    const sessionKey = this.buildSessionKey(record)
    if (this.retainedSessionHosts.get(sessionKey) === record.hostKey) {
      if (record.profileScope?.purpose === 'launch_runtime') {
        const prepared = profile ?? (await this.prepareProfileForSessionRecord(record)).profile
        const checkedHost = await this.ensureSessionAuthorityHost(record, prepared)
        await this.hostManager.releaseHost(checkedHost.hostKey)
      }
      await this.hostManager.retainHostLease?.(record.hostKey, {
        teamId: record.teamId,
        laneId: record.laneId,
        memberName: record.memberName,
        runId: runId ?? null,
        sessionId: record.opencodeSessionId,
      }).catch(() => undefined)
      return null
    }

    const sessionProfile = profile
      ? {
        profile,
        toolApprovalMode: record.toolApprovalMode ?? inferToolApprovalModeFromPreparedProfile(profile),
      }
      : await this.prepareProfileForSessionRecord(record)
    const host = await this.ensureSessionAuthorityHost(record, sessionProfile.profile)
    await this.hostManager.retainHostLease?.(record.hostKey, {
      teamId: record.teamId,
      laneId: record.laneId,
      memberName: record.memberName,
      runId: runId ?? null,
      sessionId: record.opencodeSessionId,
    }).catch(() => undefined)
    this.retainedSessionHosts.set(sessionKey, record.hostKey)
    return host
  }

  async releaseSession(
    record: Pick<OpenCodeSessionRecord,
      'teamId' | 'laneId' | 'memberName' | 'hostKey' | 'runId' | 'opencodeSessionId'>,
    options: { strictLeaseRelease?: boolean } = {},
  ): Promise<void> {
    const sessionKey = this.buildSessionKey(record)
    const retainedHostKey = this.retainedSessionHosts.get(sessionKey)
    if (options.strictLeaseRelease && !this.hostManager.releaseHostLease) {
      throw new Error('OpenCode confirmed stop requires persistent lease release')
    }
    const releaseLease = this.hostManager.releaseHostLease?.(record.hostKey, {
      teamId: record.teamId,
      laneId: record.laneId,
      memberName: record.memberName,
      runId: record.runId ?? null,
      sessionId: record.opencodeSessionId,
    })
    if (options.strictLeaseRelease) await releaseLease
    else await releaseLease?.catch(() => undefined)
    if (!retainedHostKey) {
      return
    }

    this.retainedSessionHosts.delete(sessionKey)
    await this.hostManager.releaseHost(retainedHostKey)
  }

  async ensureSessionAppMcpReady(
    record: OpenCodeSessionRecord,
    options: {
      attachIfMissing?: boolean
      host?: OpenCodeHostHandle
      signal?: AbortSignal
      remainingMs?: () => number
    } = {},
  ): Promise<OpenCodeSessionAppMcpReadyResult> {
    const check = async (baseUrl: string, runtimePid: number | null) => {
      let result: Awaited<ReturnType<typeof openCodeMcpManager.ensureAppMcp>>
      try {
        result = await this.mcpManager.ensureAppMcp({
          baseUrl,
          attachIfMissing: options.attachIfMissing === true,
          ...(options.signal ? {
            requestContext: {
              signal: options.signal,
              remainingMs: options.remainingMs,
            },
          } : {}),
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
    }
    if (options.host) {
      if (record.hostKey !== options.host.hostKey) {
        throw new Error('OpenCode strict member MCP host identity mismatch')
      }
      return check(options.host.baseUrl, options.host.pid > 0 ? options.host.pid : null)
    }
    return this.withSessionHost(record, ({ baseUrl, runtimePid }) => check(baseUrl, runtimePid))
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
    const host = await this.ensureSessionAuthorityHost(record, sessionProfile.profile)
    await this.hostManager.retainHostLease?.(record.hostKey, {
      teamId: record.teamId,
      laneId: record.laneId,
      memberName: record.memberName,
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
        : (await this.sessionStore.markStale(
            params.record.teamId,
            params.record.laneId ?? 'primary',
            params.record.memberName,
            params.staleReason,
            params.record,
          )) ?? {
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
        : (await this.sessionStore.markStale(
            params.record.teamId,
            params.record.laneId ?? 'primary',
            params.record.memberName,
            params.staleReason,
            params.record,
          )) ?? {
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
    const existing = await this.sessionStore.get(params.teamId, laneId, params.memberName)
    if (existing?.stoppedAt) throw new Error('OpenCode session is stopped; launch a new run')
    if (existing?.profileScope?.purpose === 'launch_runtime' && params.runId
      && existing.runId !== params.runId) {
      throw new Error('OpenCode selected session run changed; relaunch the lane')
    }
    const profileScope = await resolveOpenCodeProfileScope({
      projectPath: params.projectPath,
      purpose: 'launch_runtime',
      selectedModel: params.selectedModel,
    })
    if (params.preparedProfile) {
      await assertOpenCodePreparedProfileScope(params.preparedProfile, params.projectPath)
      if (
        params.preparedProfile.profileScope?.purpose !== 'launch_runtime'
        || params.preparedProfile.profileScope.providerId
          !== canonicalizeOpenCodeProviderId(params.selectedModel.split('/')[0] ?? '')
        || !profileScopeMetadataMatches(params.preparedProfile.profileScope, profileScope)
      ) {
        throw new Error('OpenCode prepared profile scope does not match the requested session')
      }
    }
    const requestedProfile: PreparedSessionProfile = params.preparedProfile
      ? {
        profile: params.preparedProfile!,
        toolApprovalMode: params.toolApprovalMode
          ?? inferToolApprovalModeFromPreparedProfile(params.preparedProfile),
      }
      : params.toolApprovalMode
        ? {
          profile: await this.prepareProfile(params.projectPath, {
            toolApprovalMode: params.toolApprovalMode,
            profileScope,
          }),
          toolApprovalMode: params.toolApprovalMode,
        }
        : existing
          ? await this.prepareProfileForSessionRecord(existing, params.projectPath)
          : {
            profile: await this.prepareProfile(params.projectPath, {
              toolApprovalMode: 'auto',
              profileScope,
            }),
            toolApprovalMode: 'auto',
          }
    const profile = requestedProfile.profile
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
      profileScopeMetadataMatches(existing.profileScope, profile.profileScope) &&
      (!existingManagedConfigFingerprint || existingManagedConfigFingerprint === profile.managedConfigFingerprint) &&
      params.fresh !== true &&
      !existing.staleReason
    ) {
      const host = await this.retainSessionHost(existing, params.runId, profile)
      const cleanRecord = this.withSessionProfileMetadata(existing, requestedProfile)
      if (cleanRecord !== existing) {
        await this.sessionStore.upsert(cleanRecord)
      }
      return host?.pid && host.pid > 0 ? { ...cleanRecord, runtimePid: host.pid } : cleanRecord
    }

    if (existing?.profileScope?.purpose === 'launch_runtime') {
      throw new Error('OpenCode selected session cannot be recreated without strict launch proof; relaunch the lane')
    }
    if (existing) {
      const staleReason =
        params.fresh === true
          ? 'fresh_launch_requested'
          : existing.selectedModel !== params.selectedModel
          ? `model_changed:${existing.selectedModel}->${params.selectedModel}`
          : existing.selectedVariant !== selectedVariant
            ? `variant_changed:${existing.selectedVariant ?? 'default'}->${selectedVariant ?? 'default'}`
          : existing.projectPath !== profile.projectPath
            ? 'project_path_changed'
            : existing.projectBehaviorFingerprint !== profile.projectBehaviorFingerprint
              ? 'project_behavior_changed'
              : existingManagedConfigFingerprint && existingManagedConfigFingerprint !== profile.managedConfigFingerprint
                ? `managed_config_changed:${existingManagedConfigFingerprint}->${profile.managedConfigFingerprint}`
                : existing.managedAuthFingerprint !== profile.managedAuthFingerprint
                  ? 'managed_auth_changed'
                  : !profileScopeMetadataMatches(existing.profileScope, profile.profileScope)
                    ? 'profile_scope_changed'
                    : existing.staleReason ?? 'session_refresh_required'

      await this.sessionStore.markStale(
        params.teamId,
        laneId,
        params.memberName,
        staleReason,
        existing,
      )
      await this.releaseSession(existing)
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
    try {
      await this.sessionStore.upsert(created.record)
      this.retainedSessionHosts.set(
        this.buildSessionKey(created.record),
        created.retainedHostKey,
      )
    } catch (error) {
      await this.hostManager.releaseHostLease?.(created.retainedHostKey, {
        teamId: created.record.teamId,
        laneId: created.record.laneId,
        memberName: created.record.memberName,
      }).catch(() => undefined)
      await this.hostManager.releaseHost(created.retainedHostKey).catch(() => undefined)
      throw error
    }
    return created.record
  }

  /** Strict launch path: one create request on the caller-retained exact host. */
  materializeSessionOnHost(
    params: OpenCodeMaterializeSessionOnHostParams,
  ): Promise<OpenCodeMaterializeSessionOnHostResult> {
    const observed = this.materializeSessionOnHostObserved(params)
    return this.sessionStore.trackPendingMaterializationReconciliation
      ? this.sessionStore.trackPendingMaterializationReconciliation(observed)
      : observed
  }

  private async materializeSessionOnHostObserved(
    params: OpenCodeMaterializeSessionOnHostParams,
  ): Promise<OpenCodeMaterializeSessionOnHostResult> {
    if (params.signal.aborted) throwOpenCodeAbortReason(params.signal)
    const identity = { teamId: params.teamId, laneId: params.laneId, memberName: params.memberName }
    const attemptId = params.attemptId ?? params.runId
    const claim = this.sessionStore.claimMaterialization
      ? await this.sessionStore.claimMaterialization(identity, attemptId, params.runId, params.signal)
      : null
    const existing = claim?.kind === 'existing'
      ? claim.record
      : claim === null
        ? await this.sessionStore.get(params.teamId, params.laneId, params.memberName)
        : null
    if (claim?.kind === 'owned_by_other') {
      throw new Error('OpenCode session materialization is owned by another launch attempt')
    }
    if (claim?.kind === 'already_owned') {
      throw new Error('OpenCode session materialization was already claimed by this launch attempt')
    }
    if (params.signal.aborted) {
      if (claim?.kind === 'claimed') {
        await this.sessionStore.releaseMaterializationClaim?.(identity, claim.ownerToken, params.runId)
      }
      throwOpenCodeAbortReason(params.signal)
    }
    if (existing) {
      if (existing.stoppedAt) throw new Error('OpenCode session is stopped; launch a new run')
      const selectedVariant = params.selectedVariant?.trim() || undefined
      const expected = {
        teamId: params.teamId,
        runId: params.runId,
        laneId: params.laneId,
        memberName: params.memberName,
        selectedModel: params.selectedModel,
        selectedVariant,
        host: params.host,
        toolApprovalMode: params.toolApprovalMode ?? 'auto',
        expectedBehaviorFingerprint: params.expectedBehaviorFingerprint,
        bootstrap: params.expectedBootstrapForSession(existing.opencodeSessionId),
      }
      if (isOpenCodeStrictSessionCompatible(existing, expected)) {
        return { record: existing, created: false }
      }
      if (!isOpenCodeStrictMaterializedSessionCompatible(existing, expected)) {
        throw new Error('OpenCode committed session identity does not match strict launch')
      }
      if (!canResumeOpenCodeStrictBootstrap(existing)) {
        throw new Error('OpenCode committed session bootstrap evidence does not match strict launch')
      }
      // createSession returned a known id and the exact bound record was
      // committed before bootstrap was interrupted. Resume only that session;
      // an unknown create outcome has no record and remains fenced by its claim.
      const ownerToken = await this.sessionStore.acquireMaterializationOwner?.(
          existing,
          attemptId,
          params.signal,
          claim?.kind === 'existing' ? claim.ownerToken : undefined,
        )
      if (!ownerToken) {
        throw new Error('OpenCode committed session changed before bootstrap ownership transfer')
      }
      try {
        await this.hostManager.retainHostLease?.(existing.hostKey, {
          teamId: existing.teamId, laneId: existing.laneId, memberName: existing.memberName,
          runId: existing.runId, sessionId: existing.opencodeSessionId,
        })
      } catch (error) {
        await this.sessionStore.releaseMaterializationOwner?.(existing, ownerToken)
        throw error
      }
      return { record: existing, ownerToken, created: false, resumeBootstrap: true }
    }

    const selectedVariant = params.selectedVariant?.trim() || undefined
    const client = this.clientFactory.create(params.host.baseUrl, {
      signal: params.signal,
      remainingMs: params.remainingMs,
    })
    let session: { id: string }
    try {
      session = await client.createSession({
        title: params.title?.trim() || `${params.teamId} - ${params.memberName}`,
      })
    } catch (error) {
      // A transport failure can have an unknown remote outcome. Keep the claim
      // so a later attempt cannot repeat that side effect automatically.
      throw error
    }
    const now = buildNowIso()
    const record: OpenCodeSessionRecord = {
      teamId: params.teamId,
      runId: params.runId,
      laneId: params.laneId,
      memberName: params.memberName,
      providerId: 'opencode',
      selectedModel: params.selectedModel,
      ...(selectedVariant ? { selectedVariant } : {}),
      projectPath: params.host.projectPath,
      profileRootKey: params.host.profileRootKey,
      profileScope: params.host.profile.profileScope ?? null,
      toolApprovalMode: params.toolApprovalMode ?? 'auto',
      runtimePid: params.host.pid > 0 ? params.host.pid : undefined,
      resolvedBehaviorFingerprint: params.host.resolvedConfigFingerprint,
      hostKey: params.host.hostKey,
      opencodeSessionId: session.id,
      lastCanonicalCursor: null,
      lastKnownRawStatus: null,
      lastKnownDurableState: null,
      sourceAuthFingerprint: params.host.profile.sourceAuthFingerprint,
      managedAuthFingerprint: params.host.profile.managedAuthFingerprint,
      projectBehaviorFingerprint: params.host.projectBehaviorFingerprint,
      managedConfigFingerprint: params.host.profile.managedConfigFingerprint,
      expectedBehaviorFingerprint: params.expectedBehaviorFingerprint,
      opencodeVersion: params.host.version ?? undefined,
      bootstrapMode: 'app_managed_context',
      staleReason: null,
      createdAt: now,
      updatedAt: now,
    }
    const claimToken = claim?.kind === 'claimed' ? claim.ownerToken : undefined
    const commitKnownRecord = async (signal?: AbortSignal): Promise<MaterializationOwnerToken | undefined> => {
      if (!this.sessionStore.commitMaterialization) {
        await this.sessionStore.upsert(record)
        return undefined
      }
      if (!claimToken) throw new Error('OpenCode materialization reservation token is missing')
      return await this.sessionStore.commitMaterialization(record, claimToken, signal) ?? undefined
    }
    try {
      await this.hostManager.retainHostLease?.(params.host.hostKey, {
        teamId: params.teamId, laneId: params.laneId, memberName: params.memberName,
        runId: params.runId, sessionId: session.id,
      })
    } catch (error) {
      // Persist a known remote identity even when lease persistence is ambiguous.
      // A retry will restore the exact lease before resuming bootstrap.
      let reconciledOwner: MaterializationOwnerToken | undefined
      try {
        reconciledOwner = await commitKnownRecord()
      } catch {
        reconciledOwner = await commitKnownRecord()
      }
      if (reconciledOwner) {
        await this.sessionStore.releaseMaterializationOwner?.(record, reconciledOwner)
      }
      throw error
    }
    const releaseLeaseUnlessSameSessionWon = async (): Promise<void> => {
      const winner = await this.sessionStore.get(record.teamId, record.laneId, record.memberName)
        .catch(() => null)
      if (winner && jsonStringify(winner) === jsonStringify(record)) return
      await this.hostManager.releaseHostLease?.(params.host.hostKey, {
        teamId: record.teamId, laneId: record.laneId, memberName: record.memberName,
        runId: record.runId, sessionId: record.opencodeSessionId,
      }).catch(() => undefined)
    }
    let ownerToken: MaterializationOwnerToken | undefined
    try {
      ownerToken = await commitKnownRecord(params.signal)
    } catch (error) {
      try {
        ownerToken = await commitKnownRecord()
      } catch {
        ownerToken = undefined
      }
      if (!ownerToken) {
        await releaseLeaseUnlessSameSessionWon()
        throw error
      }
    }
    if (this.sessionStore.commitMaterialization && !ownerToken) {
      await releaseLeaseUnlessSameSessionWon()
      throw new Error('OpenCode session materialization claim was lost before commit')
    }
    this.retainedSessionHosts.set(this.buildSessionKey(record), params.host.hostKey)
    if (params.signal.aborted) {
      if (ownerToken) await this.sessionStore.releaseMaterializationOwner?.(record, ownerToken)
      throwOpenCodeAbortReason(params.signal)
    }
    return { record, ownerToken, created: true }
  }

  async refreshSessionEnvironment(record: OpenCodeSessionRecord): Promise<OpenCodeSessionRecord> {
    if (record.profileScope?.purpose === 'launch_runtime') {
      // Never repair a scoped record by overwriting its sealed evidence with
      // the broad host fingerprint. An incompatible record needs a new launch.
      return this.withSessionHost(record, async () => record)
    }
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
    await this.sessionStore.upsert(next)
    return next
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
      lowerBoundMessageIds = messages.map(getMessageId).filter(messageId =>
        // 0-prefixed 128-bit ids from older OpenCode releases are random, not
        // ascending. Treating msg_0d... as a time bound poisons msg_01... ids.
        !messageId?.match(/^msg_0[0-9a-f]{31}$/))
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
      host?: OpenCodeHostHandle
      signal?: AbortSignal
      remainingMs?: () => number
    },
  ): Promise<{
    messageID: string
    runtimeSessionId: string
    contextHash: string
    briefingHash: string
    injectionVerifiedAt: string
    alreadyPresent: boolean
  }> {
    const inject = async (baseUrl: string) => {
      const client = this.clientFactory.create(baseUrl, params.signal
        ? { signal: params.signal, remainingMs: params.remainingMs }
        : undefined)
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
      await client.sendSessionMessage(record.opencodeSessionId, {
        messageID: params.messageID,
        ...(params.agent ? { agent: params.agent } : {}),
        noReply: true,
        ...(record.selectedVariant ? { variant: record.selectedVariant } : {}),
        model: parseProviderScopedModel(record.selectedModel),
        parts: [{ type: 'text', text: params.text }],
      })

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
    }
    if (params.host) {
      if (record.hostKey !== params.host.hostKey) {
        throw new Error('OpenCode strict bootstrap host identity mismatch')
      }
      return inject(params.host.baseUrl)
    }
    return this.withSessionPromptHost(record, ({ baseUrl }) => inject(baseUrl))
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
        await this.sessionStore.upsert(nextRecord)
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
