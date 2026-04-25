import { openCodeClientFactory } from './OpenCodeClientFactory.js'
import { openCodeEventTranslator } from './OpenCodeEventTranslator.js'
import { openCodeHostManager } from './OpenCodeHostManager.js'
import { openCodeLogProjector } from './OpenCodeLogProjector.js'
import { normalizeOpenCodePermissions } from './OpenCodePermissionNormalizer.js'
import { openCodePreviewObserver } from './OpenCodePreviewObserver.js'
import { openCodeProfileManager } from './OpenCodeProfileManager.js'
import { openCodeSessionStore } from './OpenCodeSessionStore.js'

import type {
  OpenCodeAuthState,
  OpenCodeLogProjection,
  OpenCodeMessage,
  OpenCodePreparedProfile,
  OpenCodeSessionRecord,
  OpenCodeSessionPreviewSummary,
  OpenCodeSessionReconcileSummary,
  OpenCodeSessionStatus,
  OpenCodeSessionSummary,
} from './types.js'

type OpenCodeSessionBridgeDeps = {
  hostManager?: Pick<typeof openCodeHostManager, 'ensureHost' | 'releaseHost'>
    & Partial<Pick<typeof openCodeHostManager, 'retainHostLease' | 'releaseHostLease'>>
  sessionStore?: Pick<typeof openCodeSessionStore, 'get' | 'upsert' | 'markStale'>
  clientFactory?: Pick<typeof openCodeClientFactory, 'create'>
  eventTranslator?: Pick<typeof openCodeEventTranslator, 'reconcileSessionMessages'>
  logProjector?: Pick<typeof openCodeLogProjector, 'projectSummary'>
  previewObserver?: Pick<typeof openCodePreviewObserver, 'observeSession'>
  prepareProfile?: (projectPath?: string | null) => Promise<OpenCodePreparedProfile>
}

type SessionIdentity = {
  teamId: string
  laneId: string
  memberName: string
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

  private get eventTranslator() {
    return this.deps.eventTranslator ?? openCodeEventTranslator
  }

  private get previewObserver() {
    return this.deps.previewObserver ?? openCodePreviewObserver
  }

  private get logProjector() {
    return this.deps.logProjector ?? openCodeLogProjector
  }

  private async prepareProfile(projectPath?: string | null) {
    const prepareProfile =
      this.deps.prepareProfile
      ?? openCodeProfileManager.prepareProfile.bind(openCodeProfileManager)
    return prepareProfile(projectPath)
  }

  private async createFreshSessionRecord(params: {
    identity: SessionIdentity
    selectedModel: string
    title?: string | null
    projectPath?: string | null
    runId?: string | null
  }): Promise<{ record: OpenCodeSessionRecord; retainedHostKey: string }> {
    const host = await this.hostManager.ensureHost({
      projectPath: params.projectPath,
    })

    try {
      const client = this.clientFactory.create(host.baseUrl)
      const session = await client.createSession({
        title: params.title?.trim() || `${params.identity.teamId} - ${params.identity.memberName}`,
      })
      const now = buildNowIso()
      const record: OpenCodeSessionRecord = {
        teamId: params.identity.teamId,
        laneId: params.identity.laneId,
        memberName: params.identity.memberName,
        providerId: 'opencode',
        selectedModel: params.selectedModel,
        projectPath: host.projectPath,
        profileRootKey: host.profileRootKey,
        hostKey: host.hostKey,
        runtimePid: host.pid > 0 ? host.pid : undefined,
        resolvedBehaviorFingerprint: host.resolvedConfigFingerprint,
        opencodeSessionId: session.id,
        lastCanonicalCursor: null,
        lastKnownRawStatus: null,
        lastKnownDurableState: null,
        sourceAuthFingerprint: host.profile.sourceAuthFingerprint,
        managedAuthFingerprint: host.profile.managedAuthFingerprint,
        projectBehaviorFingerprint: host.projectBehaviorFingerprint,
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

  private buildSessionKey(identity: SessionIdentity): string {
    return `${identity.teamId}::${identity.laneId}::${identity.memberName}`
  }

  private async retainSessionHost(record: OpenCodeSessionRecord, runId?: string | null) {
    const sessionKey = this.buildSessionKey(record)
    if (this.retainedSessionHosts.get(sessionKey) === record.hostKey) {
      await this.hostManager.retainHostLease?.(record.hostKey, {
        teamId: record.teamId,
        laneId: record.laneId,
        memberName: record.memberName,
        runId: runId ?? null,
        sessionId: record.opencodeSessionId,
      }).catch(() => undefined)
      return null
    }

    const host = await this.hostManager.ensureHost({
      projectPath: record.projectPath,
      hostKey: record.hostKey,
    })
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

  async releaseSession(record: Pick<OpenCodeSessionRecord, 'teamId' | 'laneId' | 'memberName' | 'hostKey'>): Promise<void> {
    const sessionKey = this.buildSessionKey(record)
    const retainedHostKey = this.retainedSessionHosts.get(sessionKey)
    await this.hostManager.releaseHostLease?.(record.hostKey, {
      teamId: record.teamId,
      laneId: record.laneId,
      memberName: record.memberName,
    }).catch(() => undefined)
    if (!retainedHostKey) {
      return
    }

    this.retainedSessionHosts.delete(sessionKey)
    await this.hostManager.releaseHost(retainedHostKey)
  }

  private async withSessionHost<T>(
    record: OpenCodeSessionRecord,
    callback: (context: {
      baseUrl: string
      resolvedConfigFingerprint: string | null
      runtimePid: number | null
    }) => Promise<T>,
  ): Promise<T> {
    const host = await this.hostManager.ensureHost({
      projectPath: record.projectPath,
      hostKey: record.hostKey,
    })
    await this.hostManager.retainHostLease?.(record.hostKey, {
      teamId: record.teamId,
      laneId: record.laneId,
      memberName: record.memberName,
      sessionId: record.opencodeSessionId,
    }).catch(() => undefined)

    try {
      return await callback({
        baseUrl: host.baseUrl,
        resolvedConfigFingerprint: host.resolvedConfigFingerprint,
        runtimePid: host.pid > 0 ? host.pid : null,
      })
    } finally {
      await this.hostManager.releaseHost(host.hostKey)
    }
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
    title?: string | null
    projectPath?: string | null
    runId?: string | null
  }): Promise<OpenCodeSessionRecord> {
    const profile = await this.prepareProfile(params.projectPath)
    const laneId = params.laneId?.trim() || 'primary'
    const existing = await this.sessionStore.get(params.teamId, laneId, params.memberName)
    if (
      existing &&
      existing.selectedModel === params.selectedModel &&
      existing.projectPath === profile.projectPath &&
      existing.projectBehaviorFingerprint === profile.projectBehaviorFingerprint &&
      existing.managedAuthFingerprint === profile.managedAuthFingerprint &&
      !existing.staleReason
    ) {
      const host = await this.retainSessionHost(existing, params.runId)
      return host?.pid && host.pid > 0 ? { ...existing, runtimePid: host.pid } : existing
    }

    if (existing) {
      const staleReason =
        existing.selectedModel !== params.selectedModel
          ? `model_changed:${existing.selectedModel}->${params.selectedModel}`
          : existing.projectPath !== profile.projectPath
            ? 'project_path_changed'
            : existing.projectBehaviorFingerprint !== profile.projectBehaviorFingerprint
              ? 'project_behavior_changed'
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
      selectedModel: params.selectedModel,
      title: params.title,
      projectPath: profile.projectPath,
      runId: params.runId ?? null,
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

  async listMessages(
    record: OpenCodeSessionRecord,
    limit?: number,
  ): Promise<OpenCodeMessage[]> {
    return this.withSessionHost(record, async ({ baseUrl }) => {
      const client = this.clientFactory.create(baseUrl)
      return client.getSessionMessages(record.opencodeSessionId, limit)
    })
  }

  async sendMessage(
    record: OpenCodeSessionRecord,
    params: {
      text: string
      agent?: string
      noReply?: boolean
      system?: string
    },
  ): Promise<OpenCodeMessage> {
    return this.withSessionHost(record, async ({ baseUrl }) => {
      const client = this.clientFactory.create(baseUrl)
      return client.sendSessionMessage(record.opencodeSessionId, {
        agent: params.agent,
        noReply: params.noReply,
        system: params.system,
        model: parseProviderScopedModel(record.selectedModel),
        parts: [{ type: 'text', text: params.text }],
      })
    })
  }

  async promptAsync(
    record: OpenCodeSessionRecord,
    params: {
      text: string
      agent?: string
      noReply?: boolean
      system?: string
    },
  ): Promise<void> {
    await this.withSessionHost(record, async ({ baseUrl }) => {
      const client = this.clientFactory.create(baseUrl)
      await client.promptSessionAsync(record.opencodeSessionId, {
        agent: params.agent,
        noReply: params.noReply,
        system: params.system,
        model: parseProviderScopedModel(record.selectedModel),
        parts: [{ type: 'text', text: params.text }],
      })
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

  async getRawStatus(record: OpenCodeSessionRecord): Promise<OpenCodeSessionStatus | null> {
    return this.withSessionHost(record, async ({ baseUrl }) => {
      const client = this.clientFactory.create(baseUrl)
      const statusMap = await client.getSessionStatus()
      return statusMap[record.opencodeSessionId] ?? null
    })
  }

  async reconcileSession(
    record: OpenCodeSessionRecord,
    options: {
      limit?: number
    } = {},
  ): Promise<{
    record: OpenCodeSessionRecord
    summary: OpenCodeSessionReconcileSummary
  }> {
    const profile = await this.prepareProfile(record.projectPath)
    const staleReason =
      record.staleReason
      ?? (profile.projectPath !== record.projectPath
        ? 'project_path_changed'
        : profile.projectBehaviorFingerprint !== record.projectBehaviorFingerprint
          ? 'project_behavior_changed'
          : profile.managedAuthFingerprint !== record.managedAuthFingerprint
            ? 'managed_auth_changed'
            : null)

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

    return this.withSessionHost(record, async ({ baseUrl, resolvedConfigFingerprint, runtimePid }) => {
      if (
        record.resolvedBehaviorFingerprint
        && resolvedConfigFingerprint
        && record.resolvedBehaviorFingerprint !== resolvedConfigFingerprint
      ) {
        return this.buildStaleReconcileResult({
          record,
          staleReason: `resolved_behavior_changed:${record.resolvedBehaviorFingerprint}->${resolvedConfigFingerprint}`,
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
      let messages = await client.getSessionMessages(record.opencodeSessionId, options.limit)
      if (
        typeof options.limit === 'number'
        && record.lastCanonicalCursor
        && !messages.some(message => getMessageId(message) === record.lastCanonicalCursor)
      ) {
        messageDiagnostics.push(
          `Stored cursor ${record.lastCanonicalCursor} was missing from the latest ${options.limit} messages, rebuilding full OpenCode session history`,
        )
        messages = await client.getSessionMessages(record.opencodeSessionId)
      }
      const rawStatus = statusMap[record.opencodeSessionId] ?? null
      const summary = this.eventTranslator.reconcileSessionMessages({
        sessionId: record.opencodeSessionId,
        rawStatus,
        messages,
      })
      summary.profileAuthState = profile.authState
      const pendingPermissionRequestIds = normalizeOpenCodePermissions(pendingPermissions)
        .filter(permission => permission.sessionId === record.opencodeSessionId)
        .map(permission => permission.requestId)
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

      const nextRecord = this.buildUpdatedRecord(record, {
        lastCanonicalCursor: summary.lastCanonicalCursor,
        lastKnownRawStatus: summary.rawStatus,
        lastKnownDurableState: summary.durableState,
        resolvedBehaviorFingerprint: resolvedConfigFingerprint ?? record.resolvedBehaviorFingerprint,
      })

      if (
        nextRecord.lastCanonicalCursor !== record.lastCanonicalCursor
        || nextRecord.lastKnownRawStatus !== record.lastKnownRawStatus
        || nextRecord.lastKnownDurableState !== record.lastKnownDurableState
        || nextRecord.resolvedBehaviorFingerprint !== record.resolvedBehaviorFingerprint
      ) {
        await this.sessionStore.upsert(nextRecord)
      }

      return {
        record: runtimePid ? { ...nextRecord, runtimePid } : nextRecord,
        summary,
      }
    })
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
    const profile = await this.prepareProfile(record.projectPath)
    const staleReason =
      record.staleReason
      ?? (profile.projectPath !== record.projectPath
        ? 'project_path_changed'
        : profile.projectBehaviorFingerprint !== record.projectBehaviorFingerprint
          ? 'project_behavior_changed'
          : profile.managedAuthFingerprint !== record.managedAuthFingerprint
            ? 'managed_auth_changed'
            : null)

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

    return this.withSessionHost(record, async ({ baseUrl, resolvedConfigFingerprint }) => {
      if (
        record.resolvedBehaviorFingerprint
        && resolvedConfigFingerprint
        && record.resolvedBehaviorFingerprint !== resolvedConfigFingerprint
      ) {
        return this.buildStalePreviewResult({
          record,
          staleReason: `resolved_behavior_changed:${record.resolvedBehaviorFingerprint}->${resolvedConfigFingerprint}`,
          profileAuthState: profile.authState,
          diagnostics: preflightDiagnostics,
        })
      }

      const summary = await this.previewObserver.observeSession({
        baseUrl,
        sessionId: record.opencodeSessionId,
        timeoutMs: options.timeoutMs,
        idleTimeoutMs: options.idleTimeoutMs,
        signal: options.signal,
      })
      summary.profileAuthState = profile.authState
      if (preflightDiagnostics.length > 0) {
        summary.diagnostics.push(...preflightDiagnostics)
      }

      return {
        record,
        summary,
      }
    })
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
      let rawStatus: OpenCodeSessionStatus | null = null
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
}

export const openCodeSessionBridge = new OpenCodeSessionBridge()
