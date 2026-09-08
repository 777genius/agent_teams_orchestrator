import type { OpenCodeBoundedExecutionPaths } from './OpenCodeBoundedPaths.js'
import { isOpenCodeMcpManagerBoundToCustody } from './OpenCodeMcpManager.js'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs'
import path from 'node:path'

import {
  captureHostedControlProcessIdentity,
  type HostedControlProcessIdentity,
} from '../hostedControl/HostedControlProcessIdentity.js'
import {
  canonicalHostedApprovalDigest,
  isOpenCodeClientFactoryBoundToCustody,
  OpenCodeRequestNotDispatchedError,
  OpenCodePermissionConditionRejectedError,
  openCodeClientFactory,
} from './OpenCodeClientFactory.js'
import { openCodeEventTranslator } from './OpenCodeEventTranslator.js'
import { isOpenCodeHostManagerBoundToCustody, openCodeHostManager } from './OpenCodeHostManager.js'
import { assertTrustedOpenCodeCustody, type OpenCodeHostAcquisitionPolicy,
  type TrustedOpenCodeCustody } from './OpenCodeSupervisedHostCustody.js'
import { openCodeLogProjector } from './OpenCodeLogProjector.js'
import {
  captureOpenCodeEstablishedPeerIdentity,
  captureOpenCodeLoopbackEndpointIdentity,
  type OpenCodeConnectedSocketIdentity,
  type OpenCodeLoopbackEndpointIdentity,
} from './OpenCodeLoopbackEndpointIdentity.js'
import { openCodeMcpManager } from './OpenCodeMcpManager.js'
import { normalizeOpenCodePermissions } from './OpenCodePermissionNormalizer.js'
import { openCodeOfflineSessionReader } from './OpenCodeOfflineSessionReader.js'
import { reserveOpenCodeRuntimePromptMessageId } from './OpenCodeMessageIds.js'
import { openCodeOAuthRefreshCoordinator } from './OpenCodeOAuthRefreshCoordinator.js'
import { openCodePreviewObserver } from './OpenCodePreviewObserver.js'
import { openCodeProfileManager } from './OpenCodeProfileManager.js'
import { openCodeSessionStore } from './OpenCodeSessionStore.js'
import { openCodeTurnSettledObserver } from './OpenCodeTurnSettledObserver.js'

import type {
  OpenCodeAuthState,
  OpenCodeAppMcpStatus,
  OpenCodeLogProjection,
  OpenCodeMessage,
  OpenCodeNormalizedPermission,
  OpenCodeHostedApprovalCapability,
  OpenCodeHostedApprovalPermission,
  OpenCodePrepareProfileOptions,
  OpenCodePreparedProfile,
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
  acquisitionPolicy?: OpenCodeHostAcquisitionPolicy
  hostManager?: Pick<typeof openCodeHostManager, 'ensureHost' | 'releaseHost'>
    & Partial<Pick<
      typeof openCodeHostManager,
      'refreshResolvedConfigFingerprint' | 'releaseHostLease' | 'retainHostLease' |
      'prepareEffectHostToken' | 'verifyEffectHost'
    >>
  sessionStore?: Pick<typeof openCodeSessionStore, 'get' | 'upsert' | 'markStale'>
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
    boundedPaths?: OpenCodeBoundedExecutionPaths
    providerId: string
    sourceAuthPath: string
  }) => Promise<void>
  preparePermissionProfileToken?: (
    profile: OpenCodePreparedProfile,
  ) => Promise<OpenCodePermissionEffectToken | null>
  captureProcessIdentity?: typeof captureHostedControlProcessIdentity
  captureLoopbackEndpointIdentity?: typeof captureOpenCodeLoopbackEndpointIdentity
  captureEstablishedPeerIdentity?: typeof captureOpenCodeEstablishedPeerIdentity
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

export type OpenCodePermissionEffectContext = {
  record: OpenCodeSessionRecord
  profile: OpenCodePreparedProfile
  host: {
    custody?: 'desktop' | 'supervisor'
    hostKey: string
    profileRootKey: string
    projectPath: string
    projectBehaviorFingerprint: string
    openCodeArtifactDigest?: `sha256:${string}` | null
    baseUrl?: string
    port?: number
    pid: number
    processStartedAtMs: number | null
    resolvedConfigFingerprint: string | null
  }
}

export type OpenCodeHostedApprovalBindingCapture = {
  capability: OpenCodeHostedApprovalCapability
  processIdentity: HostedControlProcessIdentity
  endpointIdentity: OpenCodeLoopbackEndpointIdentity
  executedArtifactDigest: `sha256:${string}`
  resolvedConfigFingerprint: string
  context: OpenCodePermissionEffectContext
}

export type OpenCodePermissionEffectToken = { consume(): boolean }

export class OpenCodePermissionEffectNotAuthorizedError extends Error {
  constructor() { super('OpenCode permission effect not authorized at provider edge') }
}

export class OpenCodePermissionPostInvocationError extends Error {
  constructor(readonly cause: unknown) {
    super('OpenCode permission POST outcome is uncertain')
  }
}

export class OpenCodePermissionEffectUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super('OpenCode permission effect pre-POST verification unavailable')
  }
}

const MAX_PERMISSION_PROFILE_FILE_BYTES = 16 * 1024 * 1024

type PinnedProfileFile = {
  consume(): boolean
}

function readPinnedFile(fd: number, size: number): Buffer | null {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_PERMISSION_PROFILE_FILE_BYTES) {
    return null
  }
  const bytes = Buffer.alloc(size)
  return readSync(fd, bytes, 0, size, 0) === size ? bytes : null
}

function hashProfileFile(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function missingCanonicalFile(filePath: string): boolean {
  try {
    lstatSync(filePath)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

function pinCanonicalProfileFile(
  filePath: string,
  expectedFingerprint: string | null,
): PinnedProfileFile | null {
  if (expectedFingerprint === null) {
    if (!missingCanonicalFile(filePath)) return null
    let consumed = false
    return {
      consume: () => {
        if (consumed) return false
        consumed = true
        return missingCanonicalFile(filePath)
      },
    }
  }

  let fd = -1
  try {
    fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    const linked = lstatSync(filePath)
    const bytes = opened.isFile() ? readPinnedFile(fd, opened.size) : null
    if (!bytes || !linked.isFile() || linked.isSymbolicLink() ||
      opened.dev !== linked.dev || opened.ino !== linked.ino ||
      realpathSync(filePath) !== path.resolve(filePath) ||
      hashProfileFile(bytes) !== expectedFingerprint) {
      closeSync(fd)
      return null
    }
    const identity = { dev: opened.dev, ino: opened.ino, size: opened.size }
    const ownedFd = fd
    fd = -1
    let consumed = false
    return {
      consume: () => {
        if (consumed) return false
        consumed = true
        try {
          const current = fstatSync(ownedFd)
          const linkedBefore = lstatSync(filePath)
          const currentBytes = current.isFile() ? readPinnedFile(ownedFd, current.size) : null
          const linkedAfter = lstatSync(filePath)
          return !!currentBytes && current.dev === identity.dev && current.ino === identity.ino &&
            current.size === identity.size && linkedBefore.isFile() && linkedAfter.isFile() &&
            !linkedBefore.isSymbolicLink() && !linkedAfter.isSymbolicLink() &&
            linkedBefore.dev === identity.dev && linkedBefore.ino === identity.ino &&
            linkedAfter.dev === identity.dev && linkedAfter.ino === identity.ino &&
            realpathSync(filePath) === path.resolve(filePath) &&
            hashProfileFile(currentBytes) === expectedFingerprint
        } catch {
          return false
        } finally {
          closeSync(ownedFd)
        }
      },
    }
  } catch {
    if (fd >= 0) closeSync(fd)
    return null
  }
}

/** Pins every auth file whose bytes form the prepared profile projection. */
export async function prepareOpenCodePermissionProfileToken(
  profile: OpenCodePreparedProfile,
): Promise<OpenCodePermissionEffectToken | null> {
  const sources = profile.sourceAuthSources
  if (!sources) return null
  const sourceFingerprint = sources.some(source => source.fingerprint)
    ? createHash('sha256').update(sources
      .filter(source => source.fingerprint)
      .map(source => `${source.path}:${source.fingerprint}`)
      .join('\n')).digest('hex')
    : null
  const selectedSourcePath = sources.findLast(source => source.fingerprint)?.path ?? null
  if (sourceFingerprint !== profile.sourceAuthFingerprint ||
    selectedSourcePath !== profile.sourceAuthPath) return null

  const pinned: PinnedProfileFile[] = []
  for (const source of [
    ...sources,
    { path: profile.managedAuthPath, fingerprint: profile.managedAuthFingerprint },
  ]) {
    const token = pinCanonicalProfileFile(source.path, source.fingerprint)
    if (!token) {
      for (const prepared of pinned) prepared.consume()
      return null
    }
    pinned.push(token)
  }
  let consumed = false
  return {
    consume: () => {
      if (consumed) return false
      consumed = true
      let valid = true
      for (const token of pinned) valid = token.consume() && valid
      return valid
    },
  }
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

function canonicalEffectValue(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error('Unsupported OpenCode permission canonical value')
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonicalEffectValue).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalEffectValue(record[key])}`,
  ).join(',')}}`
}

const HOSTED_APPROVAL_PROTOCOL = 'agent-teams-hosted-approval-v2' as const

function decodeHostedApprovalCapability(value: unknown): {
  schemaVersion: 2
  protocol: typeof HOSTED_APPROVAL_PROTOCOL
  authentication: 'opencode-basic'
  runtimeInstanceId: string
  configGeneration: string
} | null {
  const record = asRecord(value)
  if (!record || Object.keys(record).sort().join(',') !==
    'authentication,configGeneration,protocol,runtimeInstanceId,schemaVersion' ||
    record.schemaVersion !== 2 ||
    record.protocol !== HOSTED_APPROVAL_PROTOCOL ||
    record.authentication !== 'opencode-basic' ||
    typeof record.runtimeInstanceId !== 'string' ||
    !/^runtime_instance_[0-9a-f]{32}$/.test(record.runtimeInstanceId) ||
    typeof record.configGeneration !== 'string' ||
    !/^config_generation_[0-9a-f]{32}$/.test(record.configGeneration)) {
    return null
  }
  return record as {
    schemaVersion: 2
    protocol: typeof HOSTED_APPROVAL_PROTOCOL
    authentication: 'opencode-basic'
    runtimeInstanceId: string
    configGeneration: string
  }
}

export type OpenCodeHostedApprovalObservedPermission = {
  capability: OpenCodeHostedApprovalCapability
  permission: OpenCodeHostedApprovalPermission
  normalized: OpenCodeNormalizedPermission
}

function hostedApprovalAuth(profile: OpenCodePreparedProfile) {
  const password = profile.env.OPENCODE_SERVER_PASSWORD
  if (password === undefined || password === '') {
    throw new Error('OpenCode hosted approval Basic Auth unavailable')
  }
  return {
    username: profile.env.OPENCODE_SERVER_USERNAME ?? 'opencode',
    password,
    directory: profile.projectPath,
  }
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
  readonly #retainedSessionHosts = new Map<string, string>()

  private readonly custody?: TrustedOpenCodeCustody
  private readonly deps: OpenCodeSessionBridgeDeps
  constructor(deps: OpenCodeSessionBridgeDeps = {}) {
    deps = { ...deps }
    this.deps = deps
    const policy = deps.acquisitionPolicy
    if (policy && policy.mode !== 'desktop') {
      if (policy.mode !== 'supervisor-adopt-only') throw new Error('OpenCode acquisition policy invalid')
      const custody = policy.custody
      assertTrustedOpenCodeCustody(custody)
      if (new.target !== OpenCodeSessionBridge) throw new Error('OpenCode supervised bridge must use the admitted implementation')
      if (!deps.hostManager || !isOpenCodeHostManagerBoundToCustody(deps.hostManager, custody) ||
        !deps.clientFactory || !isOpenCodeClientFactoryBoundToCustody(deps.clientFactory, custody) || !deps.sessionStore ||
        (deps.mcpManager && !isOpenCodeMcpManagerBoundToCustody(deps.mcpManager, custody)) ||
        deps.prepareProfile || deps.preparePermissionProfileToken || deps.captureProcessIdentity ||
        deps.captureEstablishedPeerIdentity || deps.captureLoopbackEndpointIdentity) {
        throw new Error('OpenCode supervised bridge requires the complete custody-bound dependencies')
      }
      this.custody = custody
      this.deps = Object.freeze({ ...deps,
        acquisitionPolicy: Object.freeze({ mode: 'supervisor-adopt-only', custody }),
        sessionStore: Object.freeze({ get: deps.sessionStore.get.bind(deps.sessionStore),
          upsert: deps.sessionStore.upsert.bind(deps.sessionStore), markStale: deps.sessionStore.markStale.bind(deps.sessionStore) }),
        mcpManager: deps.mcpManager && Object.freeze({ ensureAppMcp: deps.mcpManager.ensureAppMcp.bind(deps.mcpManager) }),
        eventTranslator: deps.eventTranslator && Object.freeze({ reconcileSessionMessages: deps.eventTranslator.reconcileSessionMessages.bind(deps.eventTranslator) }),
        logProjector: deps.logProjector && Object.freeze({ projectSummary: deps.logProjector.projectSummary.bind(deps.logProjector) }),
        offlineReader: deps.offlineReader && Object.freeze({ readSession: deps.offlineReader.readSession.bind(deps.offlineReader) }),
        previewObserver: deps.previewObserver && Object.freeze({ observeSession: deps.previewObserver.observeSession.bind(deps.previewObserver) }),
        turnSettledObserver: deps.turnSettledObserver && Object.freeze({ observe: deps.turnSettledObserver.observe.bind(deps.turnSettledObserver) }),
        oauthRefreshCoordinator: deps.oauthRefreshCoordinator && Object.freeze({ ensureFreshForPrompt: deps.oauthRefreshCoordinator.ensureFreshForPrompt.bind(deps.oauthRefreshCoordinator) }),
      })
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(OpenCodeSessionBridge.prototype))) {
        if (name === 'constructor') continue
        if (typeof descriptor.value === 'function') {
          Object.defineProperty(this, name, { value: descriptor.value.bind(this) })
        } else if (descriptor.get) {
          Object.defineProperty(this, name, { get: descriptor.get.bind(this) })
        }
      }
      Object.freeze(this)
    }
  }

  private snapshotSession(record: OpenCodeSessionRecord): OpenCodeSessionRecord {
    return this.custody ? Object.freeze(structuredClone(record)) : record
  }

  private requireSupervisedDependency(key: keyof OpenCodeSessionBridgeDeps): void {
    if (this.custody && !this.deps[key]) {
      throw new Error(`OpenCode supervised ${key} composition unavailable`)
    }
  }

  private hostedApprovalAuth(profile: OpenCodePreparedProfile) {
    return this.custody ? undefined : hostedApprovalAuth(profile)
  }

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
    this.requireSupervisedDependency('mcpManager')
    return this.deps.mcpManager ?? openCodeMcpManager
  }

  private get eventTranslator() {
    this.requireSupervisedDependency('eventTranslator')
    return this.deps.eventTranslator ?? openCodeEventTranslator
  }

  private get previewObserver() {
    this.requireSupervisedDependency('previewObserver')
    return this.deps.previewObserver ?? openCodePreviewObserver
  }

  private get turnSettledObserver() {
    this.requireSupervisedDependency('turnSettledObserver')
    return this.deps.turnSettledObserver ?? openCodeTurnSettledObserver
  }

  private get logProjector() {
    this.requireSupervisedDependency('logProjector')
    return this.deps.logProjector ?? openCodeLogProjector
  }

  private get offlineReader() {
    this.requireSupervisedDependency('offlineReader')
    return this.deps.offlineReader ?? openCodeOfflineSessionReader
  }

  private get oauthRefreshCoordinator() {
    this.requireSupervisedDependency('oauthRefreshCoordinator')
    return this.deps.oauthRefreshCoordinator ?? openCodeOAuthRefreshCoordinator
  }

  private async fanOutOAuthCredentialAfterPrompt(
    record: OpenCodeSessionRecord,
    profile: OpenCodePreparedProfile,
  ): Promise<void> {
    if (this.custody) throw new Error('OpenCode supervised auth remediation unavailable')
    if (parseProviderScopedModel(record.selectedModel).providerID !== 'xai') {
      return
    }
    const input = {
      providerId: 'xai',
      sourceAuthPath: profile.managedAuthPath,
      boundedPaths: profile.boundedPaths,
    }
    if (this.deps.fanOutOAuthCredential) {
      await this.deps.fanOutOAuthCredential(input)
      return
    }
    await openCodeProfileManager.fanOutOAuthCredential(input.providerId, input.sourceAuthPath, input.boundedPaths)
  }

  private async prepareProfile(
    projectPath?: string | null,
    options?: OpenCodePrepareProfileOptions,
  ) {
    if (this.custody) {
      if ((projectPath != null && projectPath !== this.custody.expected.profile.projectPath) ||
        (options?.toolApprovalMode && options.toolApprovalMode !== 'manual') ||
        Object.keys(options ?? {}).some(key => !['toolApprovalMode', 'abortSignal'].includes(key))) {
        throw new Error('OpenCode supervised profile preparation unavailable')
      }
      return this.custody.readPreparedProfile()
    }
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
    record = this.snapshotSession(record)
    if (this.custody) {
      if (record.toolApprovalMode !== 'manual' || record.hostKey !== this.custody.hostKey ||
        record.projectPath !== this.custody.expected.profile.projectPath) {
        throw new Error('OpenCode supervised session binding mismatch')
      }
      const profile = await this.prepareProfile(projectPath, { toolApprovalMode: 'manual' })
      if (this.buildSessionProfileStaleReason(record, profile)) throw new Error('OpenCode supervised session profile stale')
      return { profile, toolApprovalMode: 'manual' }
    }
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
  }): Promise<{ record: OpenCodeSessionRecord; retainedHostKey: string }> {
    if (this.custody) params = { ...params, identity: { ...params.identity } }
    const host = await this.hostManager.ensureHost({
      projectPath: params.profile.projectPath,
      preparedProfile: params.profile,
      lease: {
        teamId: params.identity.teamId,
        laneId: params.identity.laneId,
        memberName: params.identity.memberName,
        runId: params.runId ?? null,
      },
    })
    let promotedSessionId: string | null = null

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
            this.custody || attemptIndex >= OPENCODE_CREATE_SESSION_TRANSIENT_RETRY_DELAYS_MS.length ||
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
        runId: params.runId ?? null,
        memberName: params.identity.memberName,
        providerId: 'opencode',
        selectedModel: params.selectedModel,
        ...(params.selectedVariant ? { selectedVariant: params.selectedVariant } : {}),
        projectPath: host.projectPath,
        profileRootKey: host.profileRootKey,
        hostKey: host.hostKey,
        openCodeArtifactDigest: host.openCodeArtifactDigest ?? null,
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
      })
      promotedSessionId = session.id
      await this.hostManager.releaseHostLease?.(host.hostKey, {
        teamId: params.identity.teamId,
        laneId: params.identity.laneId,
        memberName: params.identity.memberName,
        runId: params.runId ?? null,
      })

      return {
        retainedHostKey: host.hostKey,
        record,
      }
    } catch (error) {
      if (promotedSessionId) {
        await this.hostManager.releaseHostLease?.(host.hostKey, {
          teamId: params.identity.teamId,
          laneId: params.identity.laneId,
          memberName: params.identity.memberName,
          runId: params.runId ?? null,
          sessionId: promotedSessionId,
        }).catch(() => undefined)
      }
      await this.hostManager.releaseHostLease?.(host.hostKey, {
        teamId: params.identity.teamId,
        laneId: params.identity.laneId,
        memberName: params.identity.memberName,
        runId: params.runId ?? null,
      }).catch(() => undefined)
      await this.hostManager.releaseHost(host.hostKey)
      throw error
    }
  }

  private buildSessionKey(
    identity: Pick<SessionIdentity, 'teamId' | 'memberName'> & { laneId?: string | null },
  ): string {
    return `${identity.teamId}::${identity.laneId?.trim() || 'primary'}::${identity.memberName}`
  }

  private async retainSessionHost(
    record: OpenCodeSessionRecord,
    runId?: string | null,
    profile?: OpenCodePreparedProfile,
  ) {
    record = this.snapshotSession(record)
    const sessionKey = this.buildSessionKey(record)
    if (this.#retainedSessionHosts.get(sessionKey) === record.hostKey) {
      await this.hostManager.retainHostLease?.(record.hostKey, {
        teamId: record.teamId,
        laneId: record.laneId,
        memberName: record.memberName,
        runId: runId ?? null,
        sessionId: record.opencodeSessionId,
      })
      return null
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
      lease: {
        teamId: record.teamId,
        laneId: record.laneId,
        memberName: record.memberName,
        runId: runId ?? null,
        sessionId: record.opencodeSessionId,
      },
    })
    this.#retainedSessionHosts.set(sessionKey, record.hostKey)
    return host
  }

  async releaseSession(record: Pick<OpenCodeSessionRecord, 'teamId' | 'laneId' | 'memberName' | 'hostKey' | 'opencodeSessionId'>): Promise<void> {
    record = { ...record }
    const sessionKey = this.buildSessionKey(record)
    const retainedHostKey = this.#retainedSessionHosts.get(sessionKey)
    await this.hostManager.releaseHostLease?.(record.hostKey, {
      teamId: record.teamId,
      laneId: record.laneId,
      memberName: record.memberName,
      sessionId: record.opencodeSessionId,
    }).catch(() => undefined)
    if (!retainedHostKey) {
      return
    }

    this.#retainedSessionHosts.delete(sessionKey)
    await this.hostManager.releaseHost(retainedHostKey)
  }

  async ensureSessionAppMcpReady(
    record: OpenCodeSessionRecord,
    options: { attachIfMissing?: boolean } = {},
  ): Promise<OpenCodeSessionAppMcpReadyResult> {
    record = this.snapshotSession(record)
    options = { ...options }
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
      host: OpenCodePermissionEffectContext['host']
    }) => Promise<T>,
    profile?: OpenCodePreparedProfile,
  ): Promise<T> {
    record = this.snapshotSession(record)
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
      lease: {
        teamId: record.teamId,
        laneId: record.laneId,
        memberName: record.memberName,
        sessionId: record.opencodeSessionId,
      },
    })

    try {
      const effectProfile = this.custody ? await this.custody.readPreparedProfile() : sessionProfile.profile
      const effectHost: OpenCodePermissionEffectContext['host'] = {
        custody: host.custody, hostKey: host.hostKey, profileRootKey: host.profileRootKey,
        projectPath: host.projectPath, projectBehaviorFingerprint: host.projectBehaviorFingerprint,
        openCodeArtifactDigest: host.openCodeArtifactDigest ?? null, baseUrl: host.baseUrl,
        port: host.port, pid: host.pid, processStartedAtMs: host.processStartedAtMs ?? null,
        resolvedConfigFingerprint: host.resolvedConfigFingerprint,
      }
      return await callback({
        baseUrl: host.baseUrl,
        profile: effectProfile,
        resolvedConfigFingerprint: host.resolvedConfigFingerprint,
        runtimePid: host.pid > 0 ? host.pid : null,
        host: this.custody ? Object.freeze(effectHost) : effectHost,
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
    record = this.snapshotSession(record)
    let sessionProfile = await this.prepareProfileForSessionRecord(record)
    if (this.custody) {
      // The admitted supervisor owns credentials; this owner only uses its
      // retained profile and the authenticated host's actual prompt path.
      return this.withSessionHost(record, callback, sessionProfile.profile)
    }
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
    if (this.custody) params = { ...params,
      preparedProfile: params.preparedProfile ? structuredClone(params.preparedProfile) : params.preparedProfile }
    const laneId = params.laneId?.trim() || 'primary'
    const selectedVariant = params.selectedVariant?.trim() || undefined
    const stored = await this.sessionStore.get(params.teamId, laneId, params.memberName)
    const existing = stored ? this.snapshotSession(stored) : stored
    const requestedProfile: PreparedSessionProfile = params.preparedProfile
      ? {
        profile: params.preparedProfile,
        toolApprovalMode: params.toolApprovalMode
          ?? existing?.toolApprovalMode
          ?? inferToolApprovalModeFromPreparedProfile(params.preparedProfile),
      }
      : params.toolApprovalMode
        ? {
          profile: await this.prepareProfile(params.projectPath, {
            toolApprovalMode: params.toolApprovalMode,
          }),
          toolApprovalMode: params.toolApprovalMode,
        }
        : existing
          ? await this.prepareProfileForSessionRecord(existing, params.projectPath)
          : {
            profile: await this.prepareProfile(params.projectPath, { toolApprovalMode: 'auto' }),
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
                  : existing.staleReason ?? 'session_refresh_required'

      await this.sessionStore.markStale(
        params.teamId,
        laneId,
        params.memberName,
        staleReason,
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
      this.#retainedSessionHosts.set(
        this.buildSessionKey(created.record),
        created.retainedHostKey,
      )
    } catch (error) {
      await this.hostManager.releaseHostLease?.(created.retainedHostKey, {
        teamId: created.record.teamId,
        laneId: created.record.laneId,
        memberName: created.record.memberName,
        runId: created.record.runId,
        sessionId: created.record.opencodeSessionId,
      }).catch(() => undefined)
      await this.hostManager.releaseHost(created.retainedHostKey).catch(() => undefined)
      throw error
    }
    return created.record
  }

  async refreshSessionEnvironment(record: OpenCodeSessionRecord): Promise<OpenCodeSessionRecord> {
    record = this.snapshotSession(record)
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
    record = this.snapshotSession(record)
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
    record = this.snapshotSession(record)
    if (this.custody) params = structuredClone(params)
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
    record = this.snapshotSession(record)
    params = { ...params }
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
    record = this.snapshotSession(record)
    if (this.custody) params = structuredClone(params)
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
    record = this.snapshotSession(record)
    if (this.custody) params = { ...params, parts: params.parts?.map(part => ({ ...part })) }
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
    record = this.snapshotSession(record)
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
      /** Exact raw permission incarnation admitted by the hosted owner. */
      expectedPermissionRaw?: OpenCodeNormalizedPermission['raw']
      /** Exact v2 provider observation admitted by the hosted owner. */
      expectedHostedPermission?: OpenCodeHostedApprovalObservedPermission
      /** Requires the upstream atomic config-CAS permission-reply contract. */
      requireAtomicConfigReply?: boolean
      /** Fences the executable before any hosted provider observation. */
      authorizeObservation?: (
        context: OpenCodePermissionEffectContext,
      ) => Promise<boolean>
      /** Revalidates the persisted session/effect binding after fresh host proof. */
      validatePreparedEffect?: (
        context: OpenCodePermissionEffectContext,
      ) => Promise<boolean | OpenCodePermissionEffectToken>
      /** Last asynchronous admission fence, immediately pre-POST. */
      authorizeEffect?: (
        context: OpenCodePermissionEffectContext,
      ) => Promise<boolean | OpenCodePermissionEffectToken>
    },
  ): Promise<unknown> {
    record = this.snapshotSession(record)
    if (this.custody) params = { ...params,
      expectedPermissionRaw: params.expectedPermissionRaw && structuredClone(params.expectedPermissionRaw),
      expectedHostedPermission: params.expectedHostedPermission && structuredClone(params.expectedHostedPermission) }
    const invocation: {
      phase: 'not_started' | 'invoked' | 'completed'
      completedResult?: unknown
    } = { phase: 'not_started' }
    try {
      if (this.custody && (!params.requireAtomicConfigReply || !params.expectedPermissionRaw ||
        !params.expectedHostedPermission || !params.validatePreparedEffect || !params.authorizeEffect)) {
        throw new OpenCodePermissionEffectNotAuthorizedError()
      }
      return await this.withSessionHost(record, async ({ baseUrl, profile, host }) => {
      if (params.authorizeObservation &&
        !(await params.authorizeObservation({ record, profile, host }))) {
        throw new OpenCodePermissionEffectNotAuthorizedError()
      }
      const client = this.clientFactory.create(
        baseUrl,
        {},
        params.requireAtomicConfigReply ? this.hostedApprovalAuth(profile) : undefined,
      )
      let preparedToken: OpenCodePermissionEffectToken | null = null
      let authorityToken: OpenCodePermissionEffectToken | null = null
      let profileToken: OpenCodePermissionEffectToken | null = null
      let hostToken: OpenCodePermissionEffectToken | null = null
      let preparedConsumed = false
      let authorityConsumed = false
      let profileConsumed = false
      let hostConsumed = false
      let configGeneration: string | null = null
      let runtimeInstanceId: string | null = null
      let sessionIncarnation: string | null = null
      let requestIncarnation: string | null = null
      let permissionDigest: string | null = null
      let preparedEndpointStartIdentity: string | null = null
      const proveEndpointOwner = async (): Promise<string> => {
        const port = host.port
        if (!Number.isSafeInteger(port) || !port || port <= 0) {
          throw new OpenCodePermissionEffectNotAuthorizedError()
        }
        const captureProcessIdentity = this.deps.captureProcessIdentity
          ?? captureHostedControlProcessIdentity
        const captureEndpointIdentity = this.deps.captureLoopbackEndpointIdentity
          ?? captureOpenCodeLoopbackEndpointIdentity
        const processBeforeEndpoint = await captureProcessIdentity(host.pid)
        const endpoint = await captureEndpointIdentity(host.pid, port, captureProcessIdentity)
        const processAfterEndpoint = await captureProcessIdentity(host.pid)
        if (!endpoint || endpoint.address !== '127.0.0.1' || endpoint.port !== port ||
          endpoint.pid !== host.pid ||
          endpoint.startIdentity !== processBeforeEndpoint.startIdentity ||
          processBeforeEndpoint.startIdentity !== processAfterEndpoint.startIdentity) {
          throw new OpenCodePermissionEffectNotAuthorizedError()
        }
        return processAfterEndpoint.startIdentity
      }
      try {
      // Capability probe is deliberately before the raw permission GET. A
      // current upstream host (which lacks atomic config-CAS reply) therefore
      // performs neither the raw read nor the provider decision effect.
      if (params.requireAtomicConfigReply) {
        if (!client.getHostedApprovalCapability) {
          throw new Error('OpenCode atomic hosted approval capability unavailable')
        }
        const capability = decodeHostedApprovalCapability(
          await client.getHostedApprovalCapability(),
        )
        if (!capability) throw new Error('OpenCode atomic hosted approval capability unavailable')
        configGeneration = capability.configGeneration
        runtimeInstanceId = capability.runtimeInstanceId
        if (!client.observeHostedApprovalPermissions || !params.expectedHostedPermission) {
          throw new Error('OpenCode atomic hosted approval observation unavailable')
        }
        const observation = await client.observeHostedApprovalPermissions(record.opencodeSessionId)
        if (observation.runtimeInstanceId !== capability.runtimeInstanceId ||
          observation.configGeneration !== capability.configGeneration) {
          throw new OpenCodePermissionEffectNotAuthorizedError()
        }
        const expected = params.expectedHostedPermission
        const permission = observation.permissions.find(candidate =>
          candidate.requestId === params.requestId &&
          candidate.sessionId === record.opencodeSessionId &&
          candidate.sessionIncarnation === expected.permission.sessionIncarnation &&
          candidate.requestIncarnation === expected.permission.requestIncarnation &&
          candidate.permissionDigest === expected.permission.permissionDigest &&
          canonicalEffectValue(candidate.rawPermission) ===
            canonicalEffectValue(expected.permission.rawPermission),
        )
        if (!permission || expected.capability.runtimeInstanceId !== capability.runtimeInstanceId ||
          expected.capability.configGeneration !== capability.configGeneration) {
          throw new OpenCodePermissionEffectNotAuthorizedError()
        }
        sessionIncarnation = permission.sessionIncarnation
        requestIncarnation = permission.requestIncarnation
        permissionDigest = permission.permissionDigest
      }
      // Observe the exact provider-side incarnation before preparing any final
      // effect tokens. The final host proof below must therefore cover this GET.
      if (params.expectedPermissionRaw && !params.requireAtomicConfigReply) {
        const exactPermission = normalizeOpenCodePermissions(await client.getPermissions()).find(permission =>
          permission.requestId === params.requestId &&
          permission.sessionId === record.opencodeSessionId &&
          canonicalEffectValue(permission.raw) === canonicalEffectValue(params.expectedPermissionRaw),
        )
        if (!exactPermission) throw new OpenCodePermissionEffectNotAuthorizedError()
      }
      if (params.expectedPermissionRaw) {
        preparedEndpointStartIdentity = await proveEndpointOwner()
        if (params.validatePreparedEffect) {
          const prepared = await params.validatePreparedEffect({ record, profile, host })
          if (!prepared) throw new OpenCodePermissionEffectNotAuthorizedError()
          if (this.custody && typeof prepared === 'boolean') throw new OpenCodePermissionEffectNotAuthorizedError()
          preparedToken = typeof prepared === 'boolean' ? null : prepared
        }
      }
      if (params.authorizeEffect) {
        const authorized = await params.authorizeEffect({ record, profile, host })
        if (!authorized) throw new OpenCodePermissionEffectNotAuthorizedError()
        if (this.custody && typeof authorized === 'boolean') throw new OpenCodePermissionEffectNotAuthorizedError()
        authorityToken = typeof authorized === 'boolean' ? null : authorized
      }
      if (params.expectedPermissionRaw) {
        const prepareProfileToken = this.deps.preparePermissionProfileToken
          ?? prepareOpenCodePermissionProfileToken
        profileToken = await prepareProfileToken(profile)
        if (!profileToken) throw new OpenCodePermissionEffectNotAuthorizedError()
      }
      // Prepare the final host token before consuming any one-use fence. The
      // transport-bound endpoint proof below is the last asynchronous fence.
      const hostInput = {
        hostKey: host.hostKey,
        pid: host.pid,
        processStartedAtMs: host.processStartedAtMs,
        resolvedConfigFingerprint: host.resolvedConfigFingerprint,
        openCodeArtifactDigest: host.openCodeArtifactDigest ?? null,
      }
      const prepareHost = this.hostManager.prepareEffectHostToken?.bind(this.hostManager)
      hostToken = prepareHost
        ? await prepareHost(hostInput)
        : null
      if (params.expectedPermissionRaw && !hostToken) throw new OpenCodePermissionEffectNotAuthorizedError()
      const consumePreparedFences = (): boolean => {
        let current = true
        let failure: unknown = null
        const consume = (token: { consume(): boolean }): void => {
          try {
            if (!token.consume()) current = false
          } catch (error) {
            failure ??= error
          }
        }
        if (preparedToken) {
          preparedConsumed = true
          consume(preparedToken)
        }
        if (profileToken) {
          profileConsumed = true
          consume(profileToken)
        }
        if (authorityToken) {
          authorityConsumed = true
          consume(authorityToken)
        }
        if (hostToken) {
          hostConsumed = true
          consume(hostToken)
        }
        if (failure !== null) throw failure
        return current
      }
      const conditionalReply = configGeneration && runtimeInstanceId && sessionIncarnation &&
        requestIncarnation && permissionDigest
      if (!conditionalReply) {
        if (params.expectedPermissionRaw &&
          await proveEndpointOwner() !== preparedEndpointStartIdentity) {
          throw new OpenCodePermissionEffectNotAuthorizedError()
        }
        if (!consumePreparedFences()) throw new OpenCodePermissionEffectNotAuthorizedError()
      }
      try {
        invocation.phase = 'invoked'
        invocation.completedResult = await client.answerPermission({
          requestId: params.requestId,
          sessionId: record.opencodeSessionId,
          decision: params.decision,
          ...(conditionalReply
            ? {
                condition: {
                  runtimeInstanceId,
                  configGeneration,
                  sessionIncarnation,
                  requestIncarnation,
                  permissionDigest,
                  // The transport opens and pins its TCP socket first, awaits
                  // this proof, then consumes the returned one-use finalizer
                  // synchronously at the request.end dispatch edge.
                  authorizeConnected: async (connection: OpenCodeConnectedSocketIdentity) => {
                    try {
                      if (preparedEndpointStartIdentity === null) return null
                      const capturePeerIdentity = this.deps.captureEstablishedPeerIdentity
                        ?? captureOpenCodeEstablishedPeerIdentity
                      const peer = await capturePeerIdentity(
                        host.pid,
                        preparedEndpointStartIdentity,
                        connection,
                        this.deps.captureProcessIdentity ?? captureHostedControlProcessIdentity,
                      )
                      if (peer === null || peer.pid !== host.pid ||
                        peer.port !== connection.remotePort ||
                        peer.startIdentity !== preparedEndpointStartIdentity) return null
                      let finalized = false
                      return () => {
                        if (finalized) return false
                        finalized = true
                        return consumePreparedFences()
                      }
                    } catch {
                      return null
                    }
                  },
                },
              }
            : {}),
        })
        invocation.phase = 'completed'
        return invocation.completedResult
      } catch (error) {
        if (error instanceof OpenCodeRequestNotDispatchedError) {
          invocation.phase = 'not_started'
          throw new OpenCodePermissionEffectUnavailableError(error)
        }
        if (error instanceof OpenCodePermissionConditionRejectedError) {
          invocation.phase = 'not_started'
          throw new OpenCodePermissionEffectNotAuthorizedError()
        }
        throw new OpenCodePermissionPostInvocationError(error)
      }
      } finally {
        if (preparedToken && !preparedConsumed) preparedToken.consume()
        if (profileToken && !profileConsumed) profileToken.consume()
        if (hostToken && !hostConsumed) hostToken.consume()
        if (authorityToken && !authorityConsumed) authorityToken.consume()
      }
      })
    } catch (error) {
      // A successful provider response remains success even if releaseHost or
      // another post-response cleanup step fails.
      if (invocation.phase === 'completed') return invocation.completedResult
      if (invocation.phase === 'invoked' && !(error instanceof OpenCodePermissionPostInvocationError)) {
        throw new OpenCodePermissionPostInvocationError(error)
      }
      if (error instanceof OpenCodePermissionEffectNotAuthorizedError ||
        error instanceof OpenCodePermissionPostInvocationError) throw error
      throw new OpenCodePermissionEffectUnavailableError(error)
    }
  }

  /** Returns the upstream config generation only for the exact atomic contract. */
  async probeHostedApprovalCapability(record: OpenCodeSessionRecord): Promise<string | null> {
    record = this.snapshotSession(record)
    try {
      return await this.withSessionHost(record, async ({ baseUrl, profile }) => {
        const client = this.clientFactory.create(baseUrl, {}, this.hostedApprovalAuth(profile))
        if (!client.getHostedApprovalCapability) return null
        const capability = decodeHostedApprovalCapability(
          await client.getHostedApprovalCapability(),
        )
        return capability?.configGeneration ?? null
      })
    } catch {
      return null
    }
  }

  /**
   * Read-only capture of the exact session/profile/host/process/capability
   * incarnation used by hosted approval. This performs only the capability GET;
   * it never observes a permission and can never invoke a provider decision.
   */
  async captureHostedApprovalBinding(
    record: OpenCodeSessionRecord,
  ): Promise<OpenCodeHostedApprovalBindingCapture> {
    record = this.snapshotSession(record)
    return await this.withSessionHost(record, async ({ baseUrl, profile, host }) => {
      if (record.providerId !== 'opencode' || record.toolApprovalMode !== 'manual' ||
        record.staleReason !== null || host.pid <= 0 ||
        !host.openCodeArtifactDigest || !host.resolvedConfigFingerprint ||
        host.baseUrl !== baseUrl || !Number.isSafeInteger(host.port) || !host.port || host.port <= 0) {
        throw new Error('OpenCode hosted approval binding is unavailable')
      }
      const port = host.port
      const captureProcessIdentity = this.deps.captureProcessIdentity
        ?? captureHostedControlProcessIdentity
      const before = await captureProcessIdentity(host.pid)
      const captureEndpointIdentity = this.deps.captureLoopbackEndpointIdentity
        ?? captureOpenCodeLoopbackEndpointIdentity
      const endpointBefore = await captureEndpointIdentity(host.pid, port, captureProcessIdentity)
      if (!endpointBefore || endpointBefore.startIdentity !== before.startIdentity) {
        throw new Error('OpenCode hosted approval endpoint ownership is unavailable')
      }
      const client = this.clientFactory.create(baseUrl, {}, this.hostedApprovalAuth(profile))
      if (!client.getHostedApprovalCapability) {
        throw new Error('OpenCode atomic hosted approval capability unavailable')
      }
      const capability = decodeHostedApprovalCapability(
        await client.getHostedApprovalCapability(),
      )
      if (!capability) throw new Error('OpenCode atomic hosted approval capability unavailable')
      const after = await captureProcessIdentity(host.pid)
      const endpointAfter = await captureEndpointIdentity(host.pid, port, captureProcessIdentity)
      const verifyHost = this.hostManager.verifyEffectHost?.bind(this.hostManager)
      if (before.startIdentity !== after.startIdentity || !endpointAfter ||
        endpointAfter.startIdentity !== after.startIdentity ||
        endpointBefore.port !== endpointAfter.port ||
        !verifyHost || !(await verifyHost({
          hostKey: host.hostKey,
          pid: host.pid,
          processStartedAtMs: host.processStartedAtMs ?? null,
          resolvedConfigFingerprint: host.resolvedConfigFingerprint,
          openCodeArtifactDigest: host.openCodeArtifactDigest,
        }))) {
        throw new Error('OpenCode hosted approval process identity changed')
      }
      const endpointFinal = await captureEndpointIdentity(host.pid, port, captureProcessIdentity)
      if (!endpointFinal || endpointFinal.startIdentity !== after.startIdentity ||
        endpointFinal.port !== endpointAfter.port) {
        throw new Error('OpenCode hosted approval endpoint ownership changed')
      }
      return {
        capability,
        processIdentity: after,
        endpointIdentity: endpointFinal,
        executedArtifactDigest: host.openCodeArtifactDigest,
        resolvedConfigFingerprint: host.resolvedConfigFingerprint,
        context: { record, profile, host },
      }
    })
  }

  /**
   * Proves the hosted capability and reads raw permissions from the same
   * retained host and client acquisition. No raw permission read occurs unless
   * the exact capability response has already been validated.
   */
  async observeHostedApprovalPermissions(
    record: OpenCodeSessionRecord,
    authorizeObservation?: (context: OpenCodePermissionEffectContext) => Promise<boolean>,
  ): Promise<OpenCodeHostedApprovalObservedPermission[]> {
    record = this.snapshotSession(record)
    return this.withSessionHost(record, async ({ baseUrl, profile, host }) => {
      if (authorizeObservation && !(await authorizeObservation({ record, profile, host }))) {
        throw new OpenCodePermissionEffectNotAuthorizedError()
      }
      const client = this.clientFactory.create(baseUrl, {}, this.hostedApprovalAuth(profile))
      if (!client.getHostedApprovalCapability) {
        throw new Error('OpenCode atomic hosted approval capability unavailable')
      }
      const capability = decodeHostedApprovalCapability(
        await client.getHostedApprovalCapability(),
      )
      if (!capability) {
        throw new Error('OpenCode atomic hosted approval capability unavailable')
      }
      if (!client.observeHostedApprovalPermissions) {
        throw new Error('OpenCode atomic hosted approval observation unavailable')
      }
      const observation = await client.observeHostedApprovalPermissions(record.opencodeSessionId)
      if (observation.runtimeInstanceId !== capability.runtimeInstanceId ||
        observation.configGeneration !== capability.configGeneration) {
        throw new Error('OpenCode hosted approval observation generation changed')
      }
      return observation.permissions.map(permission => {
        const raw = permission.rawPermission
        const normalized: OpenCodeNormalizedPermission = {
          requestId: raw.id,
          sessionId: raw.sessionID,
          tool: raw.permission,
          title: null,
          kind: null,
          raw,
        }
        if (normalized.requestId !== permission.requestId ||
          normalized.sessionId !== permission.sessionId ||
          canonicalHostedApprovalDigest(permission.rawPermission) !== permission.permissionDigest) {
          throw new Error('OpenCode hosted approval permission projection mismatch')
        }
        return { capability, permission, normalized }
      })
    })
  }

  async getSession(record: OpenCodeSessionRecord): Promise<OpenCodeSessionSummary> {
    record = this.snapshotSession(record)
    return this.withSessionHost(record, async ({ baseUrl }) => {
      const client = this.clientFactory.create(baseUrl)
      return client.getSession(record.opencodeSessionId)
    })
  }

  async getRawStatus(record: OpenCodeSessionRecord): Promise<OpenCodeSessionStatusInput | null> {
    record = this.snapshotSession(record)
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
    record = this.snapshotSession(record)
    if (this.custody) params = { ...params, parts: params.parts?.map(part => ({ ...part })) }
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
    record = this.snapshotSession(record)
    options = { ...options }
    if (this.custody && options.sessionId != null && options.sessionId.trim() !== record.opencodeSessionId) {
      throw new Error('OpenCode supervised reconciliation target is not the admitted session')
    }
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
    record = this.snapshotSession(record)
    options = { ...options }
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
    record = this.snapshotSession(record)
    options = { ...options }
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
