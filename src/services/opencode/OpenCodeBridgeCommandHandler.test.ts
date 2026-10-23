import { effectiveAgentsFixture } from './OpenCodeEffectiveAgents.test-support.js'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import {
  __getAppMcpPreflightTimeoutMsForTests,
  __resetAppMcpToolProofCacheForTests,
  executeOpenCodeBridgeCommandEnvelope,
  __readinessDataForTests,
} from './OpenCodeBridgeCommandHandler.js'
import { OpenCodeRuntimeDeadlineError, type OpenCodeProvisioningStage } from './OpenCodeRuntimeDeadline.js'
import { resolveClaudeMultimodelPaths } from './OpenCodeManagedPaths.js'
import { openCodeCommandOutcomeStore } from './OpenCodeCommandOutcomeStore.js'
import { openCodeExecutionProbe } from './OpenCodeExecutionProbe.js'
import { OpenCodeHostProcessGoneError, openCodeHostManager } from './OpenCodeHostManager.js'
import {
  computeOpenCodeExpectedBehaviorFingerprint,
  OPEN_CODE_KNOWN_ABSENT_AUTH_FINGERPRINT,
} from './OpenCodeExpectedBehaviorFingerprint.js'
import { openCodeInventoryService } from './OpenCodeInventoryService.js'
import { openCodeLedgerBridgeService } from './OpenCodeLedgerBridgeService.js'
import { parseOpenCodeProviderScopedModelRef } from './OpenCodeModelRef.js'
import { resolveProcessAttributionDirectory } from './OpenCodeProcessAttributionStore.js'
import { buildManagedConfig, buildManagedConfigFingerprint } from './OpenCodeProfileManager.js'
import { refreshSelectedProfileAuthority } from './OpenCodeSelectedProfileAuthority.js'
import { normalizeOpenCodeProjectIdentity } from './OpenCodeProjectIdentity.js'
import { openCodeProvisioningProbe } from './OpenCodeProvisioningProbe.js'
import { RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV } from './OpenCodeRuntimeTurnSettledEmitter.js'
import { openCodeSessionBridge } from './OpenCodeSessionBridge.js'
import { OpenCodeSessionStore, openCodeSessionStore } from './OpenCodeSessionStore.js'

import type { OpenCodeTurnSettledSummary } from './OpenCodeTurnSettledObserver.js'
import type {
  OpenCodeCanonicalMessage,
  OpenCodeCanonicalToolCall,
  OpenCodeModelMetadata,
  OpenCodeProvisioningSnapshot,
  OpenCodeSessionRecord,
  OpenCodeSessionReconcileSummary,
} from './types.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const retainedAppMcpConfig = {
  type: 'local' as const,
  command: [process.execPath, '-e', 'process.stdin.resume()'],
  environment: {},
  enabled: true,
  timeout: 30_000,
}
const retainedManagedConfig = { mcp: { 'agent-teams': retainedAppMcpConfig } }
const managedConfigFingerprint = buildManagedConfigFingerprint(retainedManagedConfig)

const snapshot: OpenCodeProvisioningSnapshot = {
  detected: true,
  hostHealthy: true,
  projectPath: '/tmp/project',
  profile: {
    projectPath: '/tmp/project',
    canonicalProjectPath: '/tmp/project',
    workingDirectoryPath: '/tmp/project',
    scopeToken: null,
    profileRootKey: 'profile-root',
    profileRootPath: '/tmp/profile-root',
    projectBehaviorFingerprint: 'b'.repeat(64),
    behaviorSources: ['AGENTS.md'],
    managedConfig: retainedManagedConfig,
    managedConfigFingerprint,
    appMcpLaunchSource: 'env-override',
    homePath: '/tmp/profile-root/home',
    xdgConfigHome: '/tmp/profile-root/config',
    xdgDataHome: '/tmp/profile-root/data',
    xdgCacheHome: '/tmp/profile-root/cache',
    managedAuthPath: '/tmp/profile-root/data/opencode/auth.json',
    sourceAuthPath: '/Users/test/.local/share/opencode/auth.json',
    sourceAuthFingerprint: 'source-auth',
    managedAuthFingerprint: 'managed-auth',
    authState: 'ok',
    env: {},
  },
  host: {
    hostKey: 'host-key',
    profileRootKey: 'profile-root',
    projectPath: '/tmp/project',
    projectBehaviorFingerprint: 'behavior-v1',
    baseUrl: 'http://127.0.0.1:4096',
    port: 4096,
    pid: 123,
    version: '1.4.0',
    state: 'healthy',
    profile: {
      projectPath: '/tmp/project',
      canonicalProjectPath: '/tmp/project',
      workingDirectoryPath: '/tmp/project',
      scopeToken: null,
      profileRootKey: 'profile-root',
      profileRootPath: '/tmp/profile-root',
      projectBehaviorFingerprint: 'b'.repeat(64),
      behaviorSources: ['AGENTS.md'],
      managedConfig: retainedManagedConfig,
      managedConfigFingerprint,
      appMcpLaunchSource: 'env-override',
      homePath: '/tmp/profile-root/home',
      xdgConfigHome: '/tmp/profile-root/config',
      xdgDataHome: '/tmp/profile-root/data',
      xdgCacheHome: '/tmp/profile-root/cache',
      managedAuthPath: '/tmp/profile-root/data/opencode/auth.json',
      sourceAuthPath: '/Users/test/.local/share/opencode/auth.json',
      sourceAuthFingerprint: 'source-auth',
      managedAuthFingerprint: 'managed-auth',
      authState: 'ok',
      env: {},
    },
    resolvedConfigFingerprint: managedConfigFingerprint,
    diagnostics: [],
  },
  config: null,
  configProviders: {
    providers: [
      {
        id: 'openrouter',
        models: {
          'minimax-m2.5-free': {},
          'ling-2.6-flash-free': {},
          'nemotron-3-super-free': {},
          'moonshotai/kimi-k2': {},
        },
      },
    ],
    default: {
      openrouter: 'minimax-m2.5-free',
    },
  },
  providers: {
    connected: ['openrouter'],
    default: {
      openrouter: 'minimax-m2.5-free',
    },
  },
  providerAuth: null,
  agents: [],
  mcp: {},
  appMcp: {
    serverName: 'agent-teams',
    matchedServerName: 'agent-teams',
    status: 'present',
    connected: true,
    launchSource: 'workspace-src',
    availableServerNames: ['agent-teams'],
    diagnostics: [],
  },
  probeError: null,
  diagnostics: [],
}

function expectedFingerprintForModel(
  model: string,
  effectiveConfigFingerprint = managedConfigFingerprint,
): string {
  const fullModelId = model.includes('/') ? model : `openrouter/${model}`
  const providerId = fullModelId.slice(0, fullModelId.indexOf('/')).toLowerCase()
  return computeOpenCodeExpectedBehaviorFingerprint({
    canonicalProjectPathFingerprint: hash(normalizeOpenCodeProjectIdentity('/tmp/project')),
    modelProviderId: providerId,
    fullModelId: `${providerId}${fullModelId.slice(fullModelId.indexOf('/'))}`,
    projectBehaviorFingerprint: 'b'.repeat(64),
    effectiveConfigFingerprint,
    effectiveSelectedAuthFingerprint: OPEN_CODE_KNOWN_ABSENT_AUTH_FINGERPRINT,
  })
}
const expectedBehaviorFingerprint = expectedFingerprintForModel(
  'openrouter/minimax-m2.5-free',
)

function buildRecord(overrides: Partial<OpenCodeSessionRecord> = {}): OpenCodeSessionRecord {
  return {
    teamId: 'team-a',
    laneId: 'primary',
    memberName: 'alice',
    providerId: 'opencode',
    selectedModel: 'openrouter/minimax-m2.5-free',
    projectPath: '/tmp/project',
    profileRootKey: 'profile-root',
    hostKey: 'host-key',
    resolvedBehaviorFingerprint: 'resolved-fingerprint',
    opencodeSessionId: 'session-1',
    runId: 'run-1',
    lastCanonicalCursor: null,
    lastKnownRawStatus: null,
    lastKnownDurableState: 'idle',
    sourceAuthFingerprint: 'source-auth',
    managedAuthFingerprint: 'managed-auth',
    projectBehaviorFingerprint: 'behavior-v1',
    expectedBehaviorFingerprint,
    staleReason: null,
    createdAt: '2026-04-22T12:00:00.000Z',
    updatedAt: '2026-04-22T12:00:00.000Z',
    ...overrides,
  }
}

function buildReconcileSummary(
  overrides: Partial<OpenCodeSessionReconcileSummary> = {},
): OpenCodeSessionReconcileSummary {
  return {
    sessionId: 'session-1',
    reconcileOutcome: 'reconciled',
    rawStatus: 'idle',
    durableState: 'idle',
    staleReason: null,
    profileAuthState: 'ok',
    pendingPermissionRequestIds: [],
    messageCount: 1,
    toolCallCount: 2,
    errorCount: 0,
    lastCanonicalCursor: 'cursor-1',
    latestUserMessageId: null,
    latestAssistantMessageId: 'msg-assistant-1',
    latestAssistantText: 'ready',
    latestAssistantPreview: 'ready',
    replyPendingSinceMessageId: null,
    messages: buildBootstrapReadyMessages(),
    diagnostics: [],
    ...overrides,
  }
}

function buildCanonicalMessage(
  overrides: Partial<OpenCodeCanonicalMessage> = {},
): OpenCodeCanonicalMessage {
  return {
    id: 'msg-1',
    parentId: null,
    role: 'assistant',
    agent: null,
    providerId: null,
    modelId: null,
    createdAt: null,
    completedAt: null,
    text: '',
    reasoningText: '',
    previewText: null,
    partTypes: [],
    reasoningPartCount: 0,
    toolCalls: [],
    contentBlocks: [],
    finishReason: null,
    errorName: null,
    errorMessage: null,
    hasError: false,
    ...overrides,
  }
}

function buildToolCall(
  overrides: Partial<OpenCodeCanonicalToolCall> = {},
): OpenCodeCanonicalToolCall {
  return {
    callId: 'tool-1',
    toolName: 'agent-teams_runtime_bootstrap_checkin',
    title: null,
    status: 'completed',
    input: null,
    output: null,
    outputText: null,
    outputPreview: null,
    startedAt: null,
    completedAt: null,
    isError: false,
    ...overrides,
  }
}

function buildBootstrapReadyMessages(): OpenCodeCanonicalMessage[] {
  return [
    buildCanonicalMessage({
      id: 'msg-assistant-1',
      role: 'assistant',
      text: 'ready',
      toolCalls: [
        buildToolCall({
          callId: 'tool-bootstrap-checkin',
          toolName: 'agent-teams_runtime_bootstrap_checkin',
          status: 'completed',
          output: { ok: true },
        }),
        buildToolCall({
          callId: 'tool-member-briefing',
          toolName: 'agent-teams_member_briefing',
          status: 'completed',
          output: { ok: true },
        }),
      ],
    }),
  ]
}

function buildReadinessSnapshot(
  overrides: Partial<OpenCodeProvisioningSnapshot> = {},
): OpenCodeProvisioningSnapshot {
  return {
    ...snapshot,
    configProviders: {
      providers: [
        {
          id: 'openrouter',
          models: {
            'minimax-m2.5-free': {},
            'ling-2.6-flash-free': {},
            'nemotron-3-super-free': {},
            'moonshotai/kimi-k2': {},
          },
        },
      ],
      default: {
        openrouter: 'minimax-m2.5-free',
      },
    },
    providers: {
      connected: ['openrouter'],
      default: {
        openrouter: 'minimax-m2.5-free',
      },
    },
    appMcp: {
      serverName: 'agent-teams',
      matchedServerName: 'agent-teams',
      status: 'present',
      connected: true,
      launchSource: 'workspace-src',
      availableServerNames: ['agent-teams'],
      diagnostics: [],
    },
    ...overrides,
  }
}

function buildAppMcpSnapshot(
  config: typeof retainedAppMcpConfig | {
    type: 'remote'
    url: string
    enabled: true
    timeout: number
    oauth: false
  },
) {
  const managedConfig = { mcp: { 'agent-teams': config } }
  const fingerprint = buildManagedConfigFingerprint(managedConfig)
  const profile = {
    ...snapshot.profile!, managedConfig, managedConfigFingerprint: fingerprint,
    appMcpLaunchSource: 'env-override' as const,
  }
  return {
    snapshot: buildReadinessSnapshot({
      profile,
      host: {
        ...snapshot.host!, profile: { ...profile }, resolvedConfigFingerprint: fingerprint,
      },
    }),
    fingerprint,
  }
}

function buildModelMetadata(
  id: string,
  overrides: Partial<OpenCodeModelMetadata> = {},
): OpenCodeModelMetadata {
  return {
    id,
    cost: null,
    context: null,
    limits: null,
    free: true,
    raw: {},
    ...overrides,
  }
}

function expectOpenCodeIdentityPrompt(input: {
  text: string
  teamName: string
  memberName: string
  runtimeSessionId: string
  runId: string
  originalPrompt: string
}): void {
  expect(input.text).toContain('message_send')
  expect(input.text).toContain('"runtimeProvider":"opencode"')
  expect(input.text).toContain(`"teamName":"${input.teamName}"`)
  expect(input.text).toContain(`"memberName":"${input.memberName}"`)
  expect(input.text).toContain(`"runId":"${input.runId}"`)
  expect(input.text).toContain(`"runtimeSessionId":"${input.runtimeSessionId}"`)
  expect(input.text).toContain(input.originalPrompt)
  if (input.text.includes('<agent_teams_app_managed_bootstrap>')) {
    expect(input.text).toContain('AGENT_TEAMS_APP_MANAGED_BOOTSTRAP_V1')
    expect(input.text).toContain('"laneId"')
    expect(input.text).toContain('Do not call runtime_bootstrap_checkin')
    expect(input.text).toContain('member_briefing')
    expect(input.text).not.toContain('Your first app-team MCP action must be runtime bootstrap check-in.')
  } else {
    expect(input.text).toContain('<opencode_runtime_identity>')
    expect(input.text).toContain('agent-teams_message_send')
    expect(input.text).toContain('do not call runtime_bootstrap_checkin just to answer')
    expect(input.text).toContain('Do not call member_briefing just to answer')
    expect(input.text).not.toContain('"laneId"')
  }
  expect(input.text).toContain('Do not use SendMessage.')
  expect(input.text).not.toContain('Call SendMessage')
  expect(input.text).not.toContain('Use SendMessage')
}

const REQUIRED_MOCK_MCP_TOOL_NAMES = [
  'cross_team_get_outbox',
  'cross_team_list_targets',
  'cross_team_send',
  'member_briefing',
  'message_send',
  'process_list',
  'process_register',
  'process_stop',
  'process_unregister',
  'review_approve',
  'review_request',
  'review_request_changes',
  'review_start',
  'runtime_bootstrap_checkin',
  'runtime_deliver_message',
  'runtime_task_event',
  'runtime_heartbeat',
  'task_add_comment',
  'task_attach_comment_file',
  'task_attach_file',
  'task_briefing',
  'task_complete',
  'task_create',
  'task_create_from_message',
  'task_get',
  'task_get_comment',
  'task_link',
  'task_list',
  'task_set_clarification',
  'task_set_owner',
  'task_set_status',
  'task_start',
  'task_unlink',
] as const

function requiredMockMcpTools(): Array<{ name: string }> {
  return REQUIRED_MOCK_MCP_TOOL_NAMES.map(name => ({ name }))
}

function mockRequiredMcpTools(): void {
  ;(Client.prototype.connect as unknown as (...args: unknown[]) => Promise<void>) = async () => {}
  ;(Client.prototype.listTools as unknown as (...args: unknown[]) => Promise<{ tools: Array<{ name: string }> }>) =
    async () => ({
      tools: requiredMockMcpTools(),
    })
  ;(Client.prototype.close as unknown as () => Promise<void>) = async () => {}
}

function mockUnavailableExactProof(reason = 'selected execution unavailable'): void {
  openCodeExecutionProbe.probeModelOnHost = (async input => ({
    providerId: 'opencode',
    modelId: input.selectedModel,
    probePrompt: input.prompt ?? '', expectedOutput: input.expectedOutput ?? '',
    outcome: 'unavailable', reason, durationMs: 1, rawStatus: 'error',
    durableState: 'failed', latestAssistantText: null, latestAssistantPreview: null,
    toolCallCount: 0, errorCount: 1, diagnostics: [reason],
    verifiedAt: '2026-04-21T12:00:00.000Z',
  })) as typeof openCodeExecutionProbe.probeModelOnHost
}

const originalProbe = openCodeProvisioningProbe.probe
const originalProbeRetainingHost = openCodeProvisioningProbe.probeRetainingHost
const originalRefreshSelectedProfileAuthority =
  openCodeProvisioningProbe.refreshSelectedProfileAuthority
const originalInventoryProbe = openCodeInventoryService.probe
const originalProbeModel = openCodeExecutionProbe.probeModel
const originalProbeModelOnHost = openCodeExecutionProbe.probeModelOnHost
const originalResolveOwnedSessionEndpoint = openCodeHostManager.resolveOwnedSessionEndpoint
const originalReconcilePersistentHosts = openCodeHostManager.reconcilePersistentHosts
const originalRefreshResolvedConfigFingerprint = openCodeHostManager.refreshResolvedConfigFingerprint
const originalEnsureSession = openCodeSessionBridge.ensureSession
const originalMaterializeSessionOnHost = openCodeSessionBridge.materializeSessionOnHost
const originalEnsureSessionAppMcpReady = openCodeSessionBridge.ensureSessionAppMcpReady
const originalInjectAppManagedBootstrapContext = openCodeSessionBridge.injectAppManagedBootstrapContext
const originalRefreshSessionEnvironment = openCodeSessionBridge.refreshSessionEnvironment
const originalPromptAsync = openCodeSessionBridge.promptAsync
const originalPromptAsyncWithTurnSettled = openCodeSessionBridge.promptAsyncWithTurnSettled
const originalPromptAsyncUntilAccepted = openCodeSessionBridge.promptAsyncUntilAccepted
const originalReconcileSession = openCodeSessionBridge.reconcileSession
const originalObservePreview = openCodeSessionBridge.observePreview
const originalAbort = openCodeSessionBridge.abort
const originalObserveStopIdle = openCodeSessionBridge.observeStopIdle
const originalGetRawStatus = openCodeSessionBridge.getRawStatus
const originalReleaseSession = openCodeSessionBridge.releaseSession
const originalRestoreSessionLease = openCodeSessionBridge.restoreSessionLease
const originalAnswerPermission = openCodeSessionBridge.answerPermission
const originalProjectLogMessages = openCodeSessionBridge.projectLogMessages
const originalList = openCodeSessionStore.list
const originalGet = openCodeSessionStore.get
const originalUpsert = openCodeSessionStore.upsert
const originalMarkStale = openCodeSessionStore.markStale
const originalMarkStoppedIfSession = openCodeSessionStore.markStoppedIfSession
const originalDelete = openCodeSessionStore.delete
const originalObserveMaterialization = openCodeSessionStore.observeMaterialization
const originalReleaseInactiveMaterializationOwner =
  openCodeSessionStore.releaseInactiveMaterializationOwner
const originalReleaseMaterializationOwner = openCodeSessionStore.releaseMaterializationOwner
const originalMarkStaleIfSession = openCodeSessionStore.markStaleIfSession
const originalDeleteIfSession = openCodeSessionStore.deleteIfSession
const originalOutcomeUpsert = openCodeCommandOutcomeStore.upsert
const originalOutcomeQuery = openCodeCommandOutcomeStore.query
const originalOutcomePrune = openCodeCommandOutcomeStore.prune
const originalBackfillTaskLedger = openCodeLedgerBridgeService.backfill
const originalClientConnect = Client.prototype.connect
const originalClientListTools = Client.prototype.listTools
const originalClientClose = Client.prototype.close
let previousRuntimeTurnSettledSpoolRoot: string | undefined
let previousAppMcpToolProofCachePath: string | undefined
let previousAppMcpToolProofCacheDisabled: string | undefined
let previousMcpCommand: string | undefined
let previousMcpEntry: string | undefined
let previousMcpArgsJson: string | undefined
let previousMcpEnvJson: string | undefined
let previousMcpUrl: string | undefined
let appMcpToolProofCacheDir: string | null = null

beforeEach(async () => {
  previousRuntimeTurnSettledSpoolRoot = process.env[RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV]
  previousAppMcpToolProofCachePath =
    process.env.AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_PATH
  previousAppMcpToolProofCacheDisabled =
    process.env.AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_DISABLED
  previousMcpCommand = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND
  previousMcpEntry = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY
  previousMcpArgsJson = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON
  previousMcpEnvJson = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON
  previousMcpUrl = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
  appMcpToolProofCacheDir = await mkdtemp(path.join(os.tmpdir(), 'agent-teams-mcp-proof-'))
  process.env.AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_PATH = path.join(
    appMcpToolProofCacheDir,
    'proof-cache.json',
  )
  delete process.env.AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_DISABLED
  const fakeMcpEntryPath = path.join(appMcpToolProofCacheDir, 'agent-teams-mcp.js')
  await writeFile(fakeMcpEntryPath, 'process.stdin.resume()\n', 'utf8')
  process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = process.execPath
  process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY = fakeMcpEntryPath
  delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON
  delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON
  delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
  __resetAppMcpToolProofCacheForTests()
  openCodeCommandOutcomeStore.upsert = (async patch => ({
    schemaVersion: 1,
    command: 'opencode.sendMessage',
    requestId: patch.requestId,
    ...(patch.deliveryAttemptId ? { deliveryAttemptId: patch.deliveryAttemptId } : {}),
    teamId: patch.teamId,
    teamName: patch.teamName,
    laneId: patch.laneId,
    memberName: patch.memberName,
    runId: patch.runId ?? null,
    projectPath: patch.projectPath,
    messageId: patch.messageId ?? null,
    payloadHash: patch.payloadHash ?? null,
    status: patch.status,
    safeToRetry: false,
    sessionId: patch.sessionId ?? null,
    runtimePid: patch.runtimePid ?? null,
    prePromptCursor: patch.prePromptCursor ?? null,
    runtimePromptMessageId: patch.runtimePromptMessageId ?? null,
    acceptedAt: patch.acceptedAt ?? null,
    turnObservedAt: patch.turnObservedAt ?? null,
    completedAt: patch.completedAt ?? null,
    error: patch.error ?? null,
    diagnostics: patch.diagnostics ?? [],
    ...(patch.sendMessageData ? { sendMessageData: patch.sendMessageData } : {}),
    createdAt: '2026-04-21T00:00:00.000Z',
    updatedAt: '2026-04-21T00:00:00.000Z',
  })) as typeof openCodeCommandOutcomeStore.upsert
  openCodeCommandOutcomeStore.query = (async () => ({
    record: null,
    diagnostics: [],
  })) as typeof openCodeCommandOutcomeStore.query
  openCodeCommandOutcomeStore.prune = (async () => 0) as typeof openCodeCommandOutcomeStore.prune
  mockRequiredMcpTools()
  openCodeProvisioningProbe.probeRetainingHost = (async (projectPath, options) => {
    const retainedSnapshot = await openCodeProvisioningProbe.probe(projectPath)
    const selected = parseOpenCodeProviderScopedModelRef(options.selectedModel)
    const retainedHost = retainedSnapshot.host && selected
      ? {
          ...retainedSnapshot.host,
          profile: {
            ...retainedSnapshot.host.profile,
            scopeToken: 'launch-scope',
            profileScope: {
              purpose: 'launch_runtime' as const,
              providerId: selected.providerId,
              configFingerprint: 'config-fingerprint',
              selectedAuthIdentity: 'absent' as const,
              scopeToken: 'launch-scope',
            },
          },
        }
      : retainedSnapshot.host
    return {
      snapshot: retainedHost ? { ...retainedSnapshot, host: retainedHost } : retainedSnapshot,
      host: retainedHost,
      release: async () => {},
    }
  }) as typeof openCodeProvisioningProbe.probeRetainingHost
  openCodeExecutionProbe.probeModelOnHost = (async input => {
    if (openCodeExecutionProbe.probeModel !== originalProbeModel) {
      return openCodeExecutionProbe.probeModel({
        ...input, disposeHostOnRelease: false, bypassCache: true,
      })
    }
    return {
    providerId: 'opencode',
    modelId: input.selectedModel,
    observedProviderId: parseOpenCodeProviderScopedModelRef(input.selectedModel)!.providerId,
    observedModelId: parseOpenCodeProviderScopedModelRef(input.selectedModel)!.modelId,
    probePrompt: input.prompt ?? '',
    expectedOutput: input.expectedOutput ?? '',
    outcome: 'available',
    reason: null,
    durationMs: 1,
    rawStatus: 'idle',
    durableState: 'idle',
    latestAssistantText: input.expectedOutput ?? 'PONG',
    latestAssistantPreview: input.expectedOutput ?? 'PONG',
    toolCallCount: 0,
    errorCount: 0,
    diagnostics: [],
    verifiedAt: '2026-04-21T12:00:00.000Z',
    }
  }) as typeof openCodeExecutionProbe.probeModelOnHost
  openCodeProvisioningProbe.refreshSelectedProfileAuthority = (async input =>
    buildManagedConfigFingerprint(input.host.profile.managedConfig, input.host.profile.env)
      === input.host.profile.managedConfigFingerprint ? input.host.profile : null
  ) as typeof openCodeProvisioningProbe.refreshSelectedProfileAuthority
  openCodeSessionBridge.materializeSessionOnHost = (async input => ({
    record: {
      ...await openCodeSessionBridge.ensureSession({
        teamId: input.teamId,
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        selectedVariant: input.selectedVariant,
        title: input.title,
        projectPath: input.host.projectPath,
        preparedProfile: input.host.profile,
        runId: input.runId,
        fresh: true,
        toolApprovalMode: input.toolApprovalMode,
      }),
      expectedBehaviorFingerprint: input.expectedBehaviorFingerprint,
      runId: input.runId,
    },
    ownerToken: { attemptId: 'test-owner', sessionId: '', version: 1 },
    created: true,
  })) as typeof openCodeSessionBridge.materializeSessionOnHost
  openCodeSessionBridge.injectAppManagedBootstrapContext = (async (record, input) => {
    await openCodeSessionBridge.promptAsync(record, {
      text: input.text,
      agent: input.agent,
      noReply: true,
    })
    return {
      messageID: input.messageID,
      runtimeSessionId: record.opencodeSessionId,
      contextHash: input.contextHash,
      briefingHash: input.briefingHash,
      injectionVerifiedAt: '2026-04-21T12:00:00.000Z',
      alreadyPresent: false,
    }
  }) as typeof openCodeSessionBridge.injectAppManagedBootstrapContext
  openCodeSessionBridge.promptAsyncWithTurnSettled = (async (record, input) => {
    const runtimePromptMessageId = 'msg_test_turn_settled'
    await input.onPromptSubmitting?.({
      sessionId: record.opencodeSessionId,
      runtimePromptMessageId,
      baseUrl: 'http://127.0.0.1:4096',
    })
    await openCodeSessionBridge.promptAsync(record, input)
    await input.onPromptAccepted?.({
      sessionId: record.opencodeSessionId,
      runtimePromptMessageId,
    })
    const turnSettled: OpenCodeTurnSettledSummary = {
      outcome: 'success',
      sessionId: record.opencodeSessionId,
      runtimePromptMessageId,
      turnId: runtimePromptMessageId,
      endpoint: '/event',
      streamConnected: true,
      observedEventCount: 2,
      matchedEventCount: 2,
      assistantActivityCount: 1,
      promptPersisted: true,
      latestEventType: 'session.status',
      latestAssistantMessageId: 'msg-assistant-1',
      diagnostics: [],
    }
    await input.onTurnObserved?.({
      sessionId: record.opencodeSessionId,
      runtimePromptMessageId,
      turnSettled,
    })
    return { runtimePromptMessageId, turnSettled, hookDiagnostics: [] }
  }) as typeof openCodeSessionBridge.promptAsyncWithTurnSettled
  openCodeSessionBridge.promptAsyncUntilAccepted = (async (record, input) => {
    const runtimePromptMessageId = 'msg_test_acceptance'
    await input.onPromptSubmitting?.({
      sessionId: record.opencodeSessionId,
      runtimePromptMessageId,
      baseUrl: 'http://127.0.0.1:4096',
    })
    await openCodeSessionBridge.promptAsync(record, input)
    await input.onPromptAccepted?.({
      sessionId: record.opencodeSessionId,
      runtimePromptMessageId,
    })
    return { runtimePromptMessageId, hookDiagnostics: [] }
  }) as typeof openCodeSessionBridge.promptAsyncUntilAccepted
  openCodeSessionStore.markStoppedIfSession = async record => ({
    ...buildRecord(), ...record, stoppedAt: new Date().toISOString(),
  })
  openCodeHostManager.reconcilePersistentHosts = (async () => ({
    cleaned: 0,
    remaining: 0,
    hosts: [],
    diagnostics: [],
  })) as typeof openCodeHostManager.reconcilePersistentHosts
  openCodeHostManager.refreshResolvedConfigFingerprint = (async () =>
    snapshot.host?.resolvedConfigFingerprint ?? null
  ) as typeof openCodeHostManager.refreshResolvedConfigFingerprint
  openCodeSessionBridge.observePreview = (async record => ({
    record,
    summary: {
      sessionId: record.opencodeSessionId,
      previewOutcome: 'observed',
      staleReason: null,
      profileAuthState: 'ok',
      streamEndpoint: '/event',
      streamConnected: true,
      observedEventCount: 1,
      matchedEventCount: 1,
      runtimeState: 'running',
      latestEventType: 'message.updated',
      latestAssistantMessageId: 'preview-message',
      latestAssistantPreview: 'preview',
      pendingPermissionRequestIds: [],
      diagnostics: [],
    },
  })) as typeof openCodeSessionBridge.observePreview
  openCodeSessionBridge.ensureSessionAppMcpReady = (async record => ({
    ok: true,
    runtimePid: record.runtimePid,
    status: 'present',
    connected: true,
    diagnostics: [],
  })) as typeof openCodeSessionBridge.ensureSessionAppMcpReady
  openCodeSessionBridge.refreshSessionEnvironment = (async record =>
    record) as typeof openCodeSessionBridge.refreshSessionEnvironment
  openCodeSessionBridge.getRawStatus = (async () => 'idle') as typeof openCodeSessionBridge.getRawStatus
  openCodeSessionBridge.restoreSessionLease = async () => {}
  openCodeSessionBridge.observeStopIdle = (async () => ({
    arm: () => {},
    currentStatus: () => null,
    waitForIdle: async () => false,
    dispose: async () => {},
  })) as typeof openCodeSessionBridge.observeStopIdle
  openCodeSessionStore.upsert = (async () => 'updated') as typeof openCodeSessionStore.upsert
  openCodeSessionStore.delete = (async () => true) as typeof openCodeSessionStore.delete
  openCodeSessionStore.get = (async (teamId, laneId, memberName) =>
    (await openCodeSessionStore.list()).find(record =>
      record.teamId === teamId
      && (record.laneId ?? 'primary') === laneId
      && record.memberName === memberName) ?? null
  ) as typeof openCodeSessionStore.get
})

afterEach(async () => {
  if (previousRuntimeTurnSettledSpoolRoot == null) {
    delete process.env[RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV]
  } else {
    process.env[RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV] = previousRuntimeTurnSettledSpoolRoot
  }
  if (previousAppMcpToolProofCachePath == null) {
    delete process.env.AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_PATH
  } else {
    process.env.AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_PATH = previousAppMcpToolProofCachePath
  }
  if (previousAppMcpToolProofCacheDisabled == null) {
    delete process.env.AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_DISABLED
  } else {
    process.env.AGENT_TEAMS_OPENCODE_MCP_TOOL_PROOF_CACHE_DISABLED =
      previousAppMcpToolProofCacheDisabled
  }
  if (previousMcpCommand == null) {
    delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND
  } else {
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = previousMcpCommand
  }
  if (previousMcpEntry == null) {
    delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY
  } else {
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY = previousMcpEntry
  }
  if (previousMcpArgsJson == null) {
    delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON
  } else {
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON = previousMcpArgsJson
  }
  if (previousMcpEnvJson == null) {
    delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON
  } else {
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON = previousMcpEnvJson
  }
  if (previousMcpUrl == null) {
    delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
  } else {
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = previousMcpUrl
  }
  __resetAppMcpToolProofCacheForTests()
  openCodeProvisioningProbe.probe = originalProbe
  openCodeProvisioningProbe.probeRetainingHost = originalProbeRetainingHost
  openCodeProvisioningProbe.refreshSelectedProfileAuthority =
    originalRefreshSelectedProfileAuthority
  openCodeInventoryService.probe = originalInventoryProbe
  openCodeExecutionProbe.probeModel = originalProbeModel
  openCodeExecutionProbe.probeModelOnHost = originalProbeModelOnHost
  openCodeHostManager.resolveOwnedSessionEndpoint = originalResolveOwnedSessionEndpoint
  openCodeHostManager.reconcilePersistentHosts = originalReconcilePersistentHosts
  openCodeHostManager.refreshResolvedConfigFingerprint = originalRefreshResolvedConfigFingerprint
  openCodeSessionBridge.ensureSession = originalEnsureSession
  openCodeSessionBridge.materializeSessionOnHost = originalMaterializeSessionOnHost
  openCodeSessionBridge.ensureSessionAppMcpReady = originalEnsureSessionAppMcpReady
  openCodeSessionBridge.injectAppManagedBootstrapContext = originalInjectAppManagedBootstrapContext
  openCodeSessionBridge.refreshSessionEnvironment = originalRefreshSessionEnvironment
  openCodeSessionBridge.promptAsync = originalPromptAsync
  openCodeSessionBridge.promptAsyncWithTurnSettled = originalPromptAsyncWithTurnSettled
  openCodeSessionBridge.promptAsyncUntilAccepted = originalPromptAsyncUntilAccepted
  openCodeSessionBridge.reconcileSession = originalReconcileSession
  openCodeSessionBridge.observePreview = originalObservePreview
  openCodeSessionBridge.abort = originalAbort
  openCodeSessionBridge.observeStopIdle = originalObserveStopIdle
  openCodeSessionBridge.getRawStatus = originalGetRawStatus
  openCodeSessionBridge.releaseSession = originalReleaseSession
  openCodeSessionBridge.restoreSessionLease = originalRestoreSessionLease
  openCodeSessionBridge.answerPermission = originalAnswerPermission
  openCodeSessionBridge.projectLogMessages = originalProjectLogMessages
  openCodeSessionStore.list = originalList
  openCodeSessionStore.get = originalGet
  openCodeSessionStore.upsert = originalUpsert
  openCodeSessionStore.markStale = originalMarkStale
  openCodeSessionStore.markStoppedIfSession = originalMarkStoppedIfSession
  openCodeSessionStore.delete = originalDelete
  openCodeSessionStore.observeMaterialization = originalObserveMaterialization
  openCodeSessionStore.releaseInactiveMaterializationOwner =
    originalReleaseInactiveMaterializationOwner
  openCodeSessionStore.releaseMaterializationOwner = originalReleaseMaterializationOwner
  openCodeSessionStore.markStaleIfSession = originalMarkStaleIfSession
  openCodeSessionStore.deleteIfSession = originalDeleteIfSession
  openCodeCommandOutcomeStore.upsert = originalOutcomeUpsert
  openCodeCommandOutcomeStore.query = originalOutcomeQuery
  openCodeCommandOutcomeStore.prune = originalOutcomePrune
  openCodeLedgerBridgeService.backfill = originalBackfillTaskLedger
  Client.prototype.connect = originalClientConnect
  Client.prototype.listTools = originalClientListTools
  Client.prototype.close = originalClientClose
  if (appMcpToolProofCacheDir) {
    await rm(appMcpToolProofCacheDir, { recursive: true, force: true })
    appMcpToolProofCacheDir = null
  }
})

function buildEnvelope(command: string, body: Record<string, unknown>) {
  return {
    schemaVersion: 1 as const,
    requestId: 'req-1',
    command,
    cwd: '/tmp/project',
    startedAt: '2026-04-22T12:00:00.000Z',
    timeoutMs: 30_000,
    body: command === 'opencode.launchTeam' && body.preconditions === undefined
      ? {
          ...body,
          preconditions: {
            handshakeIdentityHash: 'handshake-test',
            laneId: body.laneId ?? null,
            expectedRunId: body.runId ?? null,
            expectedCapabilitySnapshotId: null,
            expectedBehaviorFingerprint: expectedFingerprintForModel(
              String(body.selectedModel ?? 'openrouter/minimax-m2.5-free'),
            ),
            expectedManifestHighWatermark: body.manifestHighWatermark ?? 0,
            commandLeaseId: 'lease-test',
            idempotencyKey: `launch:${String(body.runId ?? 'test')}`,
          },
        }
      : body,
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

async function waitForCommandStage(
  stage: Promise<void>,
  command: ReturnType<typeof executeOpenCodeBridgeCommandEnvelope>,
  stageName: string,
): Promise<void> {
  await Promise.race([
    stage,
    command.then(result => {
      throw new Error(`Command settled before ${stageName}: ${
        'error' in result ? result.error.message : 'completed successfully'
      }`)
    }),
  ])
}

type ManualTimer = { callback: () => void; timeoutMs: number; cancelled: boolean }
type RetainedProbe = Awaited<ReturnType<typeof openCodeProvisioningProbe.probeRetainingHost>>
async function withManualTimers<T>(run: (timers: ManualTimer[]) => Promise<T>): Promise<T> {
  const realSetTimeout = globalThis.setTimeout; const realClearTimeout = globalThis.clearTimeout
  const timers: ManualTimer[] = []
  globalThis.setTimeout = ((callback: () => void, timeoutMs = 0) => {
    const timer = { callback, timeoutMs, cancelled: false }
    timers.push(timer)
    return Object.assign(timer, { unref: () => timer })
  }) as typeof setTimeout
  globalThis.clearTimeout = ((timer: ManualTimer) => { timer.cancelled = true }) as typeof clearTimeout
  try {
    return await run(timers)
  } finally {
    globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout
  }
}

describe('OpenCodeBridgeCommandHandler', () => {
  for (const code of ['ELOCKED', 'ECOMPROMISED']) {
    test(`redacts lock failure ${code} while preserving finite classification`, async () => {
      const root = path.join(resolveClaudeMultimodelPaths().data, 'opencode')
      const cases: { file: unknown; category: string }[] = [
        { file: path.join(root, 'host-registry.json.lock'), category: 'registry' },
        { file: path.join(root, 'profiles', 'SECRET-PROFILE', 'node_modules.prepare-lock'), category: 'profile' },
        { file: path.join(root, 'host-startup-locks', `${'a'.repeat(64)}.lock`), category: 'startup' },
        { file: path.join(`${root}-outside`, 'host-registry.json.lock'), category: 'unknown' },
        { file: path.join(root, '..', 'profiles', 'node_modules.prepare-lock'), category: 'unknown' },
        { file: path.join(root, 'host-startup-locks', 'SECRET-PROFILE.lock'), category: 'unknown' },
        { file: path.join(root, 'host-registry.json.lock') + '\0SECRET-PROFILE', category: 'unknown' },
        { file: 'host-registry.json.lock', category: 'unknown' },
        { file: 123, category: 'unknown' },
      ]
      for (const { file, category } of cases) {
        const failure = Object.assign(new Error('SECRET-MESSAGE /private/auth.json'), {
          code, file, stack: 'SECRET-STACK', env: { TOKEN: 'SECRET-ENV' },
        })
        openCodeProvisioningProbe.probe = async () => { throw failure }
        const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.handshake', {}))
        if (!('error' in result)) throw new Error('Expected lock failure')
        expect(result.error.kind).toBe('provider_error')
        expect(result.error.details).toEqual({ lockCode: code, lockCategory: category })
        expect(result.error.message).toBe(`OpenCode lock operation failed [code=${code}, lock=${category}]`)
        const serialized = JSON.stringify(result)
        for (const secret of ['SECRET-', root, '/private/auth.json', 'TOKEN']) expect(serialized).not.toContain(secret)
        if (typeof file === 'string') expect(serialized).not.toContain(file)
      }
    })
  }

  test('keeps deadline classification and details ahead of lock metadata', async () => {
    const timeout = Object.assign(new OpenCodeRuntimeDeadlineError('host_start', 50, 60), { code: 'ELOCKED' })
    openCodeProvisioningProbe.probe = async () => { throw timeout }
    const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.handshake', {}))
    if (!('error' in result)) throw new Error('Expected deadline failure')
    expect(result.error.kind).toBe('timeout')
    expect(result.error.message).toBe(timeout.message)
    expect(result.error.details).toEqual(timeout.toDetails())
    expect(JSON.stringify(result)).not.toContain('lockCode')
  })

  test('outer provider failures publish matching nonblank error and diagnostic messages', async () => {
    for (const message of ['', ' \t\r\n', undefined, 42, '  Known provider failure  ']) {
      openCodeProvisioningProbe.probe = async () => {
        throw Object.assign(new Error(), { message })
      }
      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.handshake', {}))
      if (!('error' in result)) throw new Error('Expected provider failure')
      const expected = message === '  Known provider failure  ' ? message : 'OpenCode bridge operation failed'
      expect(result.error).toEqual({ kind: 'provider_error', message: expected, retryable: true })
      expect(result.diagnostics).toEqual([expect.objectContaining({
        type: 'opencode_bridge', providerId: 'opencode', severity: 'error', message: expected,
      })])
      expect(result.error.message.trim().length).toBeGreaterThan(0)
      expect(result.diagnostics[0]!.message.trim().length).toBeGreaterThan(0)
    }
  })

  test('outer validation failure also publishes a nonblank message', async () => {
    const input = Object.defineProperty({}, 'schemaVersion', { get() { throw new Error(' \t') } })
    const result = await executeOpenCodeBridgeCommandEnvelope(input)
    if (!('error' in result)) throw new Error('Expected validation failure')
    expect(result.error).toEqual({ kind: 'invalid_input', message: 'OpenCode bridge operation failed', retryable: false })
    expect(result.diagnostics).toEqual([])
  })

  test('keeps non-lock provider failure message and diagnostic unchanged', async () => {
    const message = 'Known provider failure'
    openCodeProvisioningProbe.probe = async () => { throw Object.assign(new Error(message), { code: 'OTHER' }) }
    const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.handshake', {}))
    if (!('error' in result)) throw new Error('Expected provider failure')
    expect(result.error.message).toBe(message)
    expect(result.error.details).toBeUndefined()
    expect(result.diagnostics).toEqual([expect.objectContaining({ message })])
  })

  test('publishes group protocol only for a live bootstrapped lane with fresh group tools and the retained binding', async () => {
    const live = structuredClone(snapshot)
    let sessionAvailable = true
    let mcpConnected = true
    let archived = false
    const groupContext = JSON.stringify({ appInstanceId: 'synthetic-app', dataRootFingerprint: 'synthetic-root', connectionGeneration: 1 })
    const hostRequests: string[] = []
    const host = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname
        hostRequests.push(pathname)
        if (pathname === '/mcp') return Response.json({ 'agent-teams': { status: mcpConnected ? 'connected' : 'disconnected' } })
        if (pathname === '/session/session-1') return sessionAvailable ? Response.json({ id: 'session-1' }) : new Response('Missing session', { status: 404 })
        if (pathname.startsWith('/api/teams/team-a/group-chats/')) {
          if (request.headers.get('x-agent-teams-app-context') !== groupContext) return new Response('Wrong binding', { status: 409 })
          const body = await request.json() as Record<string, unknown>
          if (pathname.endsWith('/list')) return Response.json([{ id: '3695a573-5ad2-469a-91f2-427f90792e11', name: 'Design', archivedAt: archived ? '2026-10-10T00:00:01Z' : null }])
          if (archived) return Response.json({ code: 'GROUP_ARCHIVED' }, { status: 409 })
          return Response.json({ saved: true, groupChatId: body.groupChatId, groupMessageId: body.messageId, relayOfMessageId: body.relayOfMessageId })
        }
        return new Response('Unknown synthetic endpoint', { status: 404 })
      },
    })
    try {
      live.host!.baseUrl = host.url.origin
      live.host!.port = host.port!
      live.host!.pid = process.pid
      live.mcp = { 'agent-teams': { status: 'connected' } }
      live.host!.profile.managedConfig.mcp!['agent-teams']!.environment = {
        AGENT_TEAMS_BOUND_CONTROL_URL: host.url.origin,
        AGENT_TEAMS_BOUND_CONTEXT_JSON: groupContext,
      }
      let record = buildRecord({
        runtimePid: process.pid, selectedModel: 'openai/gpt-5.6-sol', toolApprovalMode: 'auto',
        profileScope: { purpose: 'launch_runtime', providerId: 'openai', scopeToken: 'group-lane', configFingerprint: 'config', selectedAuthIdentity: 'absent' },
        appManagedBootstrap: { schemaVersion: 1, messageID: 'msg_bootstrap_group', contextHash: 'a'.repeat(64), briefingHash: 'b'.repeat(64), injectionVerifiedAt: '2026-10-10T00:00:00Z' },
      })
      openCodeSessionStore.list = async () => [record]
      openCodeSessionStore.get = async () => record
      openCodeProvisioningProbe.probe = async () => live
      openCodeProvisioningProbe.probeRetainingHost = async () => ({ snapshot: live, host: live.host!, release: async () => {} })
      const mcpConfig = live.host!.profile.managedConfig.mcp!['agent-teams']!
      mcpConfig.command = [process.execPath, fileURLToPath(new URL('./fixtures/group-chat-mcp.ts', import.meta.url))]
      mcpConfig.environment!.SYNTHETIC_MCP_TOOL_NAMES = JSON.stringify(REQUIRED_MOCK_MCP_TOOL_NAMES)
      mcpConfig.environment!.SYNTHETIC_GROUP_TOOLS = '1'
      Client.prototype.connect = originalClientConnect
      Client.prototype.listTools = originalClientListTools
      Client.prototype.close = originalClientClose
      const negotiation = { requiredCommand: 'opencode.sendMessage', teamName: 'team-a', memberName: 'alice', teamId: 'team-a', laneId: 'primary', runId: record.runId, expectedCapabilitySnapshotId: 'opencode:' + 'a'.repeat(32) }
      const handshake = async () => {
        const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.handshake', negotiation))
        if ('error' in result) throw new Error(result.error.message)
        if (!('server' in result.data)) throw new Error('Expected handshake server identity')
        return result.data.server
      }
      const ready = await handshake()
      expect(ready.bridgeProtocol.groupChatProtocolVersion).toBe(1)
      expect(ready.runtime.groupChatRunProof).toEqual({
        teamName: 'team-a', memberName: 'alice', runId: 'run-1', runKey: 'run-1', laneId: 'primary',
        runtimePid: process.pid, runtimeSessionId: record.opencodeSessionId, processorReady: true, groupReactionProtocolVersion: 1,
      })
      expect(Object.hasOwn(ready.runtime, 'groupChatCapabilities')).toBe(false)
      expect(Object.hasOwn(ready.runtime, 'groupRunKey')).toBe(false)
      expect(Object.hasOwn(ready.runtime, 'groupChatProtocolVersion')).toBe(false)
      expect(hostRequests).toContain('/session/session-1')
      expect(hostRequests).toContain('/mcp')
      process.kill(ready.runtime.groupChatRunProof.runtimePid, 0)
      openCodeSessionBridge.reconcileSession = (async target => ({ record: target, summary: buildReconcileSummary() })) as typeof openCodeSessionBridge.reconcileSession
      const reconciled = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.reconcileTeam', {
        ...negotiation, expectedCapabilitySnapshotId: ready.runtime.capabilitySnapshotId,
        expectedMembers: [{ name: 'alice', model: record.selectedModel }],
      }))
      if ('error' in reconciled) throw new Error(reconciled.error.message)
      if (!('members' in reconciled.data)) throw new Error('Expected reconciled member projection')
      const reconciledMember = reconciled.data.members.alice
      if (!('groupChatRunProof' in reconciledMember)) throw new Error('Expected current member group proof')
      expect(reconciledMember.groupChatRunProof).toEqual(ready.runtime.groupChatRunProof)
      expect(Object.hasOwn(reconciledMember, 'groupRunKey')).toBe(false)
      const prompts: string[] = []
      openCodeSessionBridge.promptAsync = (async (_record, input) => { prompts.push(input.text) }) as typeof openCodeSessionBridge.promptAsync
      const groupBody = {
        teamId: 'team-a', teamName: 'team-a', laneId: 'primary', runId: 'run-1', memberName: 'alice', text: 'Review this',
        expectedCapabilitySnapshotId: ready.runtime.capabilitySnapshotId, expectedBehaviorFingerprint: record.expectedBehaviorFingerprint,
        groupChatProtocolVersion: 1, groupRunKey: ready.runtime.groupChatRunProof.runKey,
        groupChatId: '3695a573-5ad2-469a-91f2-427f90792e11', groupChatName: 'Design',
        groupMessageId: 'b8192a4c-97c8-4f67-bccd-7b29d8131286', messageId: '0bdf10f0-3fd3-4494-a974-b394de06c181',
        from: 'user', timestamp: '2026-10-10T00:00:00Z', settlementMode: 'acceptance',
      }
      const delivered = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.sendMessage', groupBody))
      expect(delivered.ok).toBe(true)
      if ('error' in delivered) throw new Error(delivered.error.message)
      if (!('accepted' in delivered.data)) throw new Error('Expected send acceptance')
      expect(delivered.data.accepted).toBe(true)
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain('Group name: "Design"')
      expect(prompts[0]).toContain('"relayOfMessageId":"0bdf10f0-3fd3-4494-a974-b394de06c181"')
      expect(prompts[0]).toContain('Fresh group catalog:')
      expect(prompts[0]).toContain('For an optional informational acknowledgement, use group_chat_react')
      expect(prompts[0]).toContain('for requested or substantive replies')
      expect(prompts[0]).toContain('After success stop; never send an extra OK or answer a reaction.')
      expect(prompts[0]).not.toContain('reply only through group_chat_send')
      expect(prompts[0]).toContain('Never redirect it to message_send or SendMessage.')
      expect(prompts[0]).toContain('Sender: "user". Timestamp: "2026-10-10T00:00:00Z".')
      let observedMcpToolNames: string[] = []
      let groupToolResults: unknown[] = []
      const mcp = new Client({ name: 'synthetic-group-reply-proof', version: '1' })
      try {
        await mcp.connect(new StdioClientTransport({ command: mcpConfig.command![0]!, args: mcpConfig.command!.slice(1), env: mcpConfig.environment }))
        observedMcpToolNames = (await mcp.listTools()).tools.map(tool => tool.name)
        const catalog = await mcp.callTool({ name: 'group_chat_list', arguments: { teamName: 'team-a', from: 'alice' } })
        expect(catalog.isError).toBe(false)
        const reply = { teamName: 'team-a', from: 'alice', groupChatId: groupBody.groupChatId,
          messageId: 'fae7d421-dfd0-4bd3-bc0b-2693fd24b344', relayOfMessageId: groupBody.messageId, text: 'Group reply' }
        const saved = await mcp.callTool({ name: 'mcp__agent-teams__group_chat_send', arguments: reply })
        expect(saved.isError).toBe(false)
        expect(saved.content).toEqual([{ type: 'text', text: JSON.stringify({ saved: true, groupChatId: reply.groupChatId, groupMessageId: reply.messageId, relayOfMessageId: reply.relayOfMessageId }) }])
        archived = true
        const blocked = await mcp.callTool({ name: 'mcp__agent-teams__group_chat_send', arguments: reply })
        expect(blocked.isError).toBe(true)
        groupToolResults = [catalog, saved, blocked]
      } finally { await mcp.close() }
      archived = false
      const missingRunKey = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.sendMessage', { ...groupBody, groupRunKey: undefined }))
      expect(missingRunKey.ok).toBe(false)
      const stale = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.sendMessage', { ...groupBody, groupRunKey: 'old-run:123' }))
      expect(stale.ok).toBe(false)
      expect(prompts).toHaveLength(1)
      if (process.env.GROUP_CHAT_RUNTIME_EVIDENCE_PATH) {
        await writeFile(process.env.GROUP_CHAT_RUNTIME_EVIDENCE_PATH, JSON.stringify({
          observedAt: new Date().toISOString(), synthetic: true,
          source: 'synthetic live HTTP host/session + real stdio MCP tools/list; retained lane store/provisioning mocked, no model',
          server: ready, hostRequests, pidLiveAtObservation: true,
          observedMcpToolNames, groupToolResults, reconciledMember,
        }, null, 2))
      }
      const lightweight = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.handshake', { requiredCommand: 'opencode.launchTeam' }))
      if ('error' in lightweight) throw new Error(lightweight.error.message)
      if (!('server' in lightweight.data)) throw new Error('Expected lightweight handshake identity')
      expect(lightweight.data.server.bridgeProtocol.groupChatProtocolVersion).toBeUndefined()
      expect(lightweight.data.server.runtime.groupChatRunProof).toBeUndefined()
      sessionAvailable = false
      expect((await handshake()).runtime.groupChatRunProof).toBeUndefined()
      sessionAvailable = true
      mcpConnected = false
      expect((await handshake()).runtime.groupChatRunProof).toBeUndefined()
      mcpConnected = true
      mcpConfig.environment!.SYNTHETIC_GROUP_TOOLS = '0'
      expect((await handshake()).runtime.groupChatRunProof).toBeUndefined()
      mcpConfig.environment!.SYNTHETIC_GROUP_TOOLS = '1'
      record = { ...record, runtimePid: 2147483647 }
      expect((await handshake()).runtime.groupChatRunProof).toBeUndefined()
      record = { ...record, runtimePid: process.pid, appManagedBootstrap: undefined }
      expect((await handshake()).runtime.groupChatRunProof).toBeUndefined()
    } finally { host.stop(true) }
  })
  test('exposes the OpenCode task ledger evidence contract version in handshake', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.handshake', {}),
    )

    expect(result.ok).toBe(true)
    expect(result.data.server.bridgeProtocol.opencodeTaskLedgerEvidenceContractVersion).toBe(1)
    expect(result.data.server.bridgeProtocol.opencodeDeliveryAcceptanceContractVersion).toBe(2)
    expect(result.data.server.bridgeProtocol.opencodeFilePartsContractVersion).toBe(2)
    expect(result.data.server.bridgeProtocol.expectedBehaviorFingerprintSchemaVersion).toBe(2)
    // The desktop app detects a runtime that records process attribution by
    // this block, never by parsing a version string.
    expect(result.data.server.runtime.processAttribution).toEqual({
      schemaVersion: 1,
      directory: resolveProcessAttributionDirectory(),
    })
  })

  test('uses lightweight handshake for launch commands without a required capability snapshot', async () => {
    let probeCalled = false
    openCodeProvisioningProbe.probe = (async () => {
      probeCalled = true
      throw new Error('launch handshake should not probe OpenCode')
    }) as typeof openCodeProvisioningProbe.probe

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.handshake', {
        requiredCommand: 'opencode.launchTeam',
        expectedCapabilitySnapshotId: null,
        expectedRunId: 'run-1',
        expectedManifestHighWatermark: 0,
      }),
    )

    expect(result.ok).toBe(true)
    expect(probeCalled).toBe(false)
    if (result.ok) {
      expect(result.runtime.capabilitySnapshotId).toBeNull()
      expect(result.data.server.runtime.capabilitySnapshotId).toBeNull()
      expect(result.data.server.runtime.runtimeStoreManifestHighWatermark).toBe(0)
    }
  })

  test('lightweight launch handshake preserves the requested manifest high watermark', async () => {
    let probeCalled = false
    openCodeProvisioningProbe.probe = (async () => {
      probeCalled = true
      throw new Error('launch handshake should not probe OpenCode')
    }) as typeof openCodeProvisioningProbe.probe

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.handshake', {
        requiredCommand: 'opencode.launchTeam',
        expectedCapabilitySnapshotId: null,
        expectedRunId: 'run-1',
        expectedManifestHighWatermark: 17,
      }),
    )

    expect(result.ok).toBe(true)
    expect(probeCalled).toBe(false)
    if (result.ok) {
      expect(result.data.server.runtime.runtimeStoreManifestHighWatermark).toBe(17)
    }
  })

  test('handshake echoes the requested manifest high watermark for every command', async () => {
    // The app owns the manifest high watermark; the bridge only reports back
    // whatever the handshake carried, whichever command it negotiates.
    const record = buildRecord({
      runId: 'run-1', selectedModel: 'openai/gpt-5.6-sol', toolApprovalMode: 'auto',
      profileScope: { purpose: 'launch_runtime', providerId: 'openai', scopeToken: 'lane-scope',
        configFingerprint: 'config', selectedAuthIdentity: 'absent' },
    })
    openCodeSessionStore.list = async () => [record]
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeProvisioningProbe.probeRetainingHost = async () => ({
      snapshot, host: snapshot.host, release: async () => {},
    })

    const permission = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.handshake', {
        requiredCommand: 'opencode.answerPermission',
        teamId: 'team-a',
        laneId: 'primary',
        expectedRunId: 'run-1',
        expectedManifestHighWatermark: 2,
      }),
    )

    expect(permission.ok).toBe(true)
    if (permission.ok) {
      expect(permission.data.server.runtime.runtimeStoreManifestHighWatermark).toBe(2)
    }

    const stop = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.handshake', {
        requiredCommand: 'opencode.stopTeam',
        teamId: 'team-a',
        laneId: 'primary',
        runId: 'run-1',
        expectedRunId: 'run-1',
        expectedCapabilitySnapshotId: 'selected',
        expectedManifestHighWatermark: 41,
      }),
    )

    expect(stop.ok).toBe(true)
    if (stop.ok) {
      expect(stop.data.server.runtime.runtimeStoreManifestHighWatermark).toBe(41)
    }
  })

  for (const value of ['1', -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity]) {
    test(`rejects handshake watermark ${value} before probing or acquiring a host`, async () => {
      let effects = 0
      openCodeProvisioningProbe.probe = async () => { effects++; return snapshot }
      openCodeProvisioningProbe.probeRetainingHost = async () => {
        effects++
        return { snapshot, host: snapshot.host, release: async () => {} }
      }
      for (const requiredCommand of ['opencode.answerPermission', 'opencode.launchTeam']) {
        const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.handshake', {
          requiredCommand, selectedModel: 'openai/gpt-5.6-sol', expectedManifestHighWatermark: value,
        }))
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error.message).toContain('non-negative safe integer')
      }
      expect(effects).toBe(0)
    })
  }

  for (const value of [undefined, null, 0, Number.MAX_SAFE_INTEGER]) {
    test(`accepts optional handshake watermark ${value}`, async () => {
      openCodeProvisioningProbe.probe = async () => snapshot
      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.handshake', {
        requiredCommand: 'opencode.answerPermission', expectedManifestHighWatermark: value,
      }))
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.data.server.runtime.runtimeStoreManifestHighWatermark).toBe(value ?? 0)
    })
  }

  test('uses selected scope handshake when launch commands require a capability snapshot', async () => {
    let probeCalled = false
    let probeOptions: unknown = null
    let released = false
    openCodeProvisioningProbe.probe = async () => { throw new Error('broad probe forbidden') }
    openCodeProvisioningProbe.probeRetainingHost = (async (_projectPath, options) => {
      probeCalled = true
      probeOptions = options
      return { snapshot, host: snapshot.host, release: async () => { released = true } }
    }) as typeof openCodeProvisioningProbe.probeRetainingHost

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.handshake', {
        requiredCommand: 'opencode.launchTeam',
        expectedCapabilitySnapshotId: 'opencode:expected',
        selectedModel: 'openrouter/minimax-m2.5-free',
        toolApprovalMode: 'manual',
        expectedRunId: 'run-1',
        expectedManifestHighWatermark: 0,
      }),
    )

    expect(result.ok).toBe(true)
    expect(probeCalled).toBe(true)
    expect(probeOptions).toEqual(expect.objectContaining({
      selectedModel: 'openrouter/minimax-m2.5-free', toolApprovalMode: 'manual',
      phaseContext: expect.objectContaining({ phase: 'host_start' }),
    }))
    expect(released).toBe(true)
    if (result.ok) {
      expect(result.runtime.capabilitySnapshotId).toMatch(/^opencode:/)
      expect(result.data.server.runtime.capabilitySnapshotId).toMatch(/^opencode:/)
    }
  })

  test('launch handshake matches selected readiness while preserving model and approval-mode distinctions', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    const broad = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.handshake', {}))
    openCodeProvisioningProbe.probe = async () => { throw new Error('broad probe forbidden') }
    let released = 0
    openCodeProvisioningProbe.probeRetainingHost = async (_projectPath, options) => {
      const managedConfig = { ...retainedManagedConfig, model: options?.selectedModel,
        permission: options?.toolApprovalMode === 'manual' ? 'ask' : 'allow' }
      const profile = { ...snapshot.profile!, managedConfig,
        managedConfigFingerprint: buildManagedConfigFingerprint(managedConfig) }
      const host = { ...snapshot.host!, profile }
      return { snapshot: { ...snapshot, profile, host, providers: null, configProviders: null },
        host, release: async () => { released += 1 } }
    }
    const selectedModel = 'openai/gpt-5.6-sol'
    const readiness = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.readiness', {
      selectedModel, skipPermissions: false, requireExecutionProbe: false,
    }))
    expect(readiness.ok).toBe(true)
    if (!('runtime' in readiness) || !('runtime' in broad)) throw new Error('missing runtime snapshot')
    const expected = readiness.runtime.capabilitySnapshotId
    expect(expected).not.toBe(broad.runtime.capabilitySnapshotId)
    for (const [model, mode, matches] of [
      [selectedModel, 'manual', true], [selectedModel, 'auto', false],
      ['openai/other-model', 'manual', false],
    ] as const) {
      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.handshake', {
        requiredCommand: 'opencode.launchTeam', selectedModel: model, toolApprovalMode: mode,
        expectedCapabilitySnapshotId: expected,
      }))
      expect(result.ok).toBe(true)
      if (!('runtime' in result)) throw new Error('missing runtime snapshot')
      expect(result.runtime.capabilitySnapshotId === expected).toBe(matches)
    }
    expect(released).toBe(4)
  })

  test('launch handshake rejects missing scope, raw models and invalid approval mode before effects', async () => {
    let effects = 0
    openCodeProvisioningProbe.probe = async () => { effects += 1; throw new Error('broad') }
    openCodeProvisioningProbe.probeRetainingHost = async () => { effects += 1; throw new Error('selected') }
    for (const scope of [{}, { selectedModel: 'raw' }, { selectedModel: 'kiro/model' },
      { selectedModel: 'openai/model', toolApprovalMode: 'invalid' }]) {
      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.handshake', {
        requiredCommand: 'opencode.launchTeam', expectedCapabilitySnapshotId: 'expected', ...scope,
      }))
      expect(result.ok).toBe(false)
    }
    expect(effects).toBe(0)
  })

  test('selected delivery handshake and dispatch retain exact lane authority without broad inventory', async () => {
    const record = buildRecord({ runId: 'run-1', selectedModel: 'zai/glm-5.2', toolApprovalMode: 'auto',
      profileScope: { purpose: 'launch_runtime', providerId: 'zai', scopeToken: 'lane-scope',
        configFingerprint: 'config', selectedAuthIdentity: 'absent' } })
    let records = [record]
    openCodeSessionStore.list = async () => records
    openCodeSessionStore.get = async () => record
    openCodeProvisioningProbe.probe = async () => { throw new Error('broad inventory forbidden') }
    let releases = 0
    let prompts = 0
    openCodeProvisioningProbe.probeRetainingHost = async (_project, options) => {
      expect(options).toMatchObject({ selectedModel: 'zai/glm-5.2', toolApprovalMode: 'auto',
        phaseContext: { phase: 'host_start' } })
      return { snapshot, host: snapshot.host, release: async () => { releases++ } }
    }
    openCodeSessionBridge.promptAsync = async () => { prompts++ }
    openCodeSessionBridge.reconcileSession = (async () => ({ record, summary: buildReconcileSummary() })) as typeof openCodeSessionBridge.reconcileSession
    const body = { teamId: 'team-a', laneId: 'primary', runId: 'run-1', memberName: record.memberName, text: 'hello' }
    const handshake = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.handshake', {
      ...body, requiredCommand: 'opencode.sendMessage', expectedCapabilitySnapshotId: 'selected',
    }))
    expect(handshake.ok).toBe(true)
    if (!('runtime' in handshake)) throw new Error('missing handshake runtime')
    const cap = handshake.runtime.capabilitySnapshotId
    const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.sendMessage', {
      ...body, expectedCapabilitySnapshotId: cap,
      preconditions: { handshakeIdentityHash: 'handshake', laneId: 'primary', expectedRunId: 'run-1',
        expectedCapabilitySnapshotId: cap, expectedBehaviorFingerprint: null,
        expectedManifestHighWatermark: null, commandLeaseId: 'lease', idempotencyKey: 'send-selected' },
    }))
    expect(result.ok).toBe(true)
    if ('runtime' in result) expect(result.runtime.capabilitySnapshotId).toBe(cap)
    expect(prompts).toBe(1)
    expect(releases).toBe(2)
    const stale = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.sendMessage', {
      ...body, runId: 'stale', expectedCapabilitySnapshotId: cap,
    }))
    expect(stale.ok).toBe(false)
    expect(prompts).toBe(1)
    for (const patch of [
      { projectPath: '/tmp/different-project' }, { stoppedAt: new Date().toISOString() },
      { runId: 'stale' }, { profileScope: undefined },
    ]) {
      records = [{ ...record, ...patch }]
      const rejected = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.handshake', {
        ...body, requiredCommand: 'opencode.sendMessage', expectedCapabilitySnapshotId: cap,
      }))
      expect(rejected.ok).toBe(false)
    }
    records = [record]
    const mismatched = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.sendMessage', {
      ...body, preconditions: { handshakeIdentityHash: 'handshake', laneId: 'primary', expectedRunId: 'run-1',
        expectedCapabilitySnapshotId: 'wrong', expectedBehaviorFingerprint: null,
        expectedManifestHighWatermark: null, commandLeaseId: 'lease', idempotencyKey: 'send-wrong' },
    }))
    expect(mismatched.ok).toBe(false)
    const unbound = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.sendMessage', body))
    expect(unbound.ok).toBe(false)
    expect(prompts).toBe(1)
    expect(releases).toBe(3)
  })

  async function setupSelectedDeliveryRegression(command: string) {
    const record = buildRecord({
      runId: 'run-1', selectedModel: 'zai/glm-5.2', toolApprovalMode: 'auto', runtimePid: 123,
      profileScope: { purpose: 'launch_runtime', providerId: 'zai', scopeToken: 'lane-scope',
        configFingerprint: 'config', selectedAuthIdentity: 'absent' },
    })
    const state = { records: [record], probes: 0, releases: 0, mcp: 0, prompts: 0, reconciles: 0,
      recreates: 0, targets: [] as string[] }
    openCodeSessionStore.list = async () => state.records
    openCodeSessionStore.get = async (teamId, laneId, memberName) => state.records.find(candidate =>
      candidate.teamId === teamId && candidate.laneId === laneId && candidate.memberName === memberName) ?? null
    openCodeProvisioningProbe.probe = async () => { throw new Error('broad inventory forbidden') }
    openCodeProvisioningProbe.probeRetainingHost = async () => {
      state.probes++
      return { snapshot, host: snapshot.host, release: async () => { state.releases++ } }
    }
    openCodeSessionBridge.ensureSession = async () => { state.recreates++; throw new Error('unexpected recreate') }
    openCodeSessionBridge.ensureSessionAppMcpReady = async target => {
      state.mcp++
      state.targets.push(target.opencodeSessionId)
      return { ok: true, runtimePid: target.runtimePid, status: 'present', connected: true, diagnostics: [] }
    }
    openCodeSessionBridge.promptAsync = async target => {
      state.prompts++
      state.targets.push(target.opencodeSessionId)
    }
    openCodeSessionBridge.reconcileSession = async target => {
      state.reconciles++
      state.targets.push(target.opencodeSessionId)
      return { record: target, summary: buildReconcileSummary() }
    }
    const body = { teamId: record.teamId, laneId: record.laneId, runId: record.runId,
      memberName: record.memberName, text: 'hello', noReply: true, messageId: 'inbound-1' }
    const handshake = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.handshake', {
      ...body, requiredCommand: 'opencode.sendMessage', expectedCapabilitySnapshotId: 'selected',
    }))
    expect(handshake.ok).toBe(true)
    if (!('runtime' in handshake)) throw new Error('missing handshake runtime')
    state.probes = 0
    state.releases = 0
    return { record, state, envelope: buildEnvelope(command, {
      ...body, expectedCapabilitySnapshotId: handshake.runtime.capabilitySnapshotId,
    }) }
  }

  for (const command of ['opencode.sendMessage', 'opencode.observeMessageDelivery']) {
    for (const change of ['replacement run', 'session', 'host', 'PID', 'scope', 'stopped', 'missing member']) {
      test(`selected delivery rejects ${change} between preflight and dispatch: ${command}`, async () => {
        const { record, state, envelope } = await setupSelectedDeliveryRegression(command)
        const probeEntered = createDeferred<void>()
        const resumeProbe = createDeferred<void>()
        const probe = openCodeProvisioningProbe.probeRetainingHost
        openCodeProvisioningProbe.probeRetainingHost = async (...args) => {
          probeEntered.resolve()
          await resumeProbe.promise
          return probe(...args)
        }
        const pending = executeOpenCodeBridgeCommandEnvelope(envelope)
        await waitForCommandStage(probeEntered.promise, pending, 'selected preflight')
        const patches: Record<string, Partial<OpenCodeSessionRecord>> = {
          'replacement run': { runId: 'run-B', opencodeSessionId: 'session-B' },
          session: { opencodeSessionId: 'session-B' },
          host: { hostKey: 'host-B' },
          PID: { runtimePid: 456 },
          scope: { profileScope: { ...record.profileScope!, scopeToken: 'scope-B' } },
          stopped: { stoppedAt: '2026-09-08T00:00:00.000Z' },
        }
        state.records = change === 'missing member'
          ? [buildRecord({ ...record, memberName: 'bob' })]
          : [{ ...record, ...patches[change] }]
        // A cached store implementation may mutate the same nested scope object.
        if (change === 'scope') record.profileScope!.scopeToken = 'scope-B'
        resumeProbe.resolve()
        const result = await pending
        expect(result.ok).toBe(false)
        if ('error' in result) expect(result.error.message).toMatch(/authority changed|active session authority|No stored OpenCode session/)
        expect(state.mcp).toBe(0)
        expect(state.prompts).toBe(0)
        expect(state.reconciles).toBe(0)
        expect(state.recreates).toBe(0)
        expect(state.releases).toBe(1)
      })
    }

    test(`selected delivery permits historical stopped sibling: ${command}`, async () => {
      const { record, state, envelope } = await setupSelectedDeliveryRegression(command)
      state.records.push(buildRecord({ memberName: 'bob', runId: 'old-run',
        opencodeSessionId: 'old-session', hostKey: 'old-host', selectedModel: 'other/model',
        stoppedAt: '2026-09-08T00:00:00.000Z' }))
      const result = await executeOpenCodeBridgeCommandEnvelope(envelope)
      expect(result.ok).toBe(true)
      if ('data' in result) expect(result.data).toMatchObject({ sessionId: record.opencodeSessionId,
        ...(command === 'opencode.sendMessage' ? { accepted: true } : { observed: true }) })
      expect(state.prompts).toBe(command === 'opencode.sendMessage' ? 1 : 0)
      if (command === 'opencode.observeMessageDelivery') expect(state.reconciles).toBeGreaterThan(0)
      expect([...new Set(state.targets)]).toEqual([record.opencodeSessionId])
      expect(state.releases).toBe(1)
    })

    for (const laneState of ['foreign active run', 'same-run stopped sibling', 'empty lane', 'historical only']) {
      test(`selected delivery rejects ${laneState}: ${command}`, async () => {
        const { record, state, envelope } = await setupSelectedDeliveryRegression(command)
        const sibling = buildRecord({ ...record, memberName: 'bob',
          runId: laneState === 'same-run stopped sibling' ? record.runId : 'old-run',
          ...(laneState !== 'foreign active run' ? { stoppedAt: '2026-09-08T00:00:00.000Z' } : {}) })
        state.records = laneState === 'empty lane' ? []
          : laneState === 'historical only' ? [sibling] : [record, sibling]
        const result = await executeOpenCodeBridgeCommandEnvelope(envelope)
        expect(result.ok).toBe(false)
        if ('error' in result && laneState === 'foreign active run') {
          expect(result.error.message).toContain('another run is active')
        }
        expect(state.probes).toBe(0)
        expect(state.mcp).toBe(0)
        expect(state.prompts).toBe(0)
        expect(state.reconciles).toBe(0)
      })
    }
  }

  for (const stage of ['session_resolved', 'mcp_ready']) {
    test(`selected delivery rechecks authority after awaited ${stage} outcome`, async () => {
      const { record, state, envelope } = await setupSelectedDeliveryRegression('opencode.sendMessage')
      const upsert = openCodeCommandOutcomeStore.upsert
      openCodeCommandOutcomeStore.upsert = async patch => {
        if (patch.status === stage) state.records = [{ ...record, runId: 'run-B', opencodeSessionId: 'session-B' }]
        return upsert(patch)
      }
      const result = await executeOpenCodeBridgeCommandEnvelope(envelope)
      expect(result.ok).toBe(false)
      if ('error' in result) expect(result.error.message).toContain('authority changed')
      expect(state.mcp).toBe(stage === 'mcp_ready' ? 1 : 0)
      expect(state.prompts).toBe(0)
      expect(state.recreates).toBe(0)
      expect(state.releases).toBe(1)
    })
  }

  test('selected delivery observation rejects authority changes during reconciliation', async () => {
    const { record, state, envelope } = await setupSelectedDeliveryRegression('opencode.observeMessageDelivery')
    const reconcile = openCodeSessionBridge.reconcileSession
    openCodeSessionBridge.reconcileSession = async (...args) => {
      state.records = [{ ...record, opencodeSessionId: 'session-B' }]
      return reconcile(...args)
    }
    const result = await executeOpenCodeBridgeCommandEnvelope(envelope)
    expect(result.ok).toBe(false)
    if ('error' in result) expect(result.error.message).toContain('authority changed')
    expect(state.reconciles).toBe(1)
    expect(state.prompts).toBe(0)
    expect(state.releases).toBe(1)
  })

  for (const reason of ['stale record', 'forced refresh', 'MCP unavailable']) {
    test(`selected delivery requires relaunch instead of recovery: ${reason}`, async () => {
      const { record, state, envelope } = await setupSelectedDeliveryRegression('opencode.sendMessage')
      if (reason === 'stale record') state.records = [{ ...record, staleReason: 'changed' }]
      if (reason === 'forced refresh') envelope.body.forceSessionRefreshReason = 'refresh'
      if (reason === 'MCP unavailable') openCodeSessionBridge.ensureSessionAppMcpReady = async () => ({
        ok: false, status: 'missing', connected: false, diagnostics: [],
      })
      const result = await executeOpenCodeBridgeCommandEnvelope(envelope)
      expect(result.ok).toBe(false)
      if ('error' in result) expect(result.error.message).toContain('relaunch the lane')
      expect(state.recreates).toBe(0)
      expect(state.prompts).toBe(0)
      expect(state.releases).toBe(1)
    })
  }

  test('failed selected launch requires strict launch recovery before delivery', async () => {
    const { record, state, envelope } = await setupSelectedDeliveryRegression('opencode.sendMessage')
    state.records = [{ ...record, staleReason: 'launch_failed' }]

    const result = await executeOpenCodeBridgeCommandEnvelope(envelope)

    expect(result.ok).toBe(false)
    if ('error' in result) {
      expect(result.error.message).toContain('retry launch for the same run or relaunch the lane')
    }
    expect(state.recreates).toBe(0)
    expect(state.prompts).toBe(0)
    expect(state.releases).toBe(1)
  })

  test('selected delivery handshake deadline cancels probe and releases late retained authority', async () => {
    const record = buildRecord({ runId: 'run-1', selectedModel: 'zai/glm-5.2', toolApprovalMode: 'auto',
      profileScope: { purpose: 'launch_runtime', providerId: 'zai', scopeToken: 'lane-scope',
        configFingerprint: 'config', selectedAuthIdentity: 'absent' } })
    openCodeSessionStore.list = async () => [record]
    openCodeProvisioningProbe.probe = async () => { throw new Error('broad inventory forbidden') }
    let signal: AbortSignal | undefined
    let releases = 0
    openCodeProvisioningProbe.probeRetainingHost = async (_project, options) => {
      signal = options?.phaseContext?.signal
      await new Promise(resolve => setTimeout(resolve, 100))
      return { snapshot, host: snapshot.host, release: async () => { releases++ } }
    }
    const result = await executeOpenCodeBridgeCommandEnvelope({ ...buildEnvelope('opencode.handshake', {
      teamId: 'team-a', laneId: 'primary', expectedRunId: 'run-1',
      requiredCommand: 'opencode.sendMessage', expectedCapabilitySnapshotId: 'selected',
    }), timeoutMs: 25 })
    expect(result.ok).toBe(false)
    if ('error' in result) expect(result.error.kind).toBe('timeout')
    expect(signal?.aborted).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(releases).toBe(1)
  })

  test('stored lane handshake, reconcile and stop share selected authority without a provider catalog', async () => {
    const record = buildRecord({ runId: 'run-1', selectedModel: 'openai/gpt-5.6-sol', toolApprovalMode: 'manual',
      profileScope: { purpose: 'launch_runtime', providerId: 'openai', scopeToken: 'lane-scope',
        configFingerprint: 'config', selectedAuthIdentity: 'absent' } })
    let records = [record, buildRecord({ laneId: 'other-lane' })]
    openCodeSessionStore.list = async () => records
    openCodeSessionStore.get = async () => record
    openCodeProvisioningProbe.probe = async () => { throw new Error('broad probe forbidden') }
    let released = 0
    let effects = 0
    openCodeProvisioningProbe.probeRetainingHost = async (_path, options) => {
      expect(options).toEqual(expect.objectContaining({
        selectedModel: record.selectedModel,
        toolApprovalMode: 'manual',
      }))
      return { snapshot: { ...snapshot, providers: null, configProviders: null, modelMetadata: [] },
        host: snapshot.host, release: async () => { released += 1 } }
    }
    openCodeSessionBridge.reconcileSession = (async () => {
      effects += 1; return { record, summary: buildReconcileSummary() }
    }) as typeof openCodeSessionBridge.reconcileSession
    openCodeSessionBridge.abort = async () => { effects += 1; return true }
    openCodeSessionBridge.releaseSession = async () => {}
    const body = { teamId: 'team-a', laneId: 'primary', runId: 'run-1',
      expectedCapabilitySnapshotId: 'not-echoed' }
    const handshake = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.handshake', {
      ...body, requiredCommand: 'opencode.stopTeam', expectedRunId: 'run-1',
    }))
    expect(handshake.ok).toBe(true)
    if (!('runtime' in handshake)) throw new Error('missing runtime snapshot')
    const cap = handshake.runtime.capabilitySnapshotId
    expect(cap).not.toBe(body.expectedCapabilitySnapshotId)
    for (const command of ['opencode.reconcileTeam', 'opencode.stopTeam']) {
      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope(command, {
        ...body, expectedCapabilitySnapshotId: cap,
        expectedMembers: [{ name: 'alice', model: record.selectedModel }],
      }))
      expect(result.ok).toBe(true)
    }
    expect(effects).toBe(2)
    expect(released).toBe(3)
    for (const patch of [{ runId: 'stale-run' }, { runId: undefined },
      { projectPath: '/tmp/unrelated-project' }]) {
      records = [{ ...record, ...patch }]
      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
        ...body, expectedCapabilitySnapshotId: cap,
      }))
      expect(result.ok).toBe(false)
    }
    records = [record, { ...record, memberName: 'bob', toolApprovalMode: 'auto' }]
    expect((await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
      ...body, expectedCapabilitySnapshotId: cap,
    }))).ok).toBe(false)
    expect(effects).toBe(2)
    expect(released).toBe(3)
  })

  for (const sharedHost of [false, true]) {
    test(`stop releases its preflight before cleanup and preserves other-team leases: ${sharedHost}`, async () => {
      const record = buildRecord({ runId: 'run-1', selectedModel: 'openai/gpt-5.6-sol', toolApprovalMode: 'auto',
        profileScope: { purpose: 'launch_runtime', providerId: 'openai', scopeToken: 'lane-scope',
          configFingerprint: 'config', selectedAuthIdentity: 'absent' } })
      const events: string[] = []
      const leases = new Set(['session:team-a', ...(sharedHost ? ['session:other-team'] : [])])
      openCodeSessionStore.list = async () => [record,
        ...(sharedHost ? [buildRecord({ teamId: 'other-team' })] : [])]
      openCodeProvisioningProbe.probe = async () => { throw new Error('broad probe forbidden') }
      openCodeProvisioningProbe.probeRetainingHost = async () => {
        leases.add('preflight:stop')
        events.push('retain')
        return { snapshot, host: snapshot.host, release: async keepAlive => {
          if (events.includes('abort')) expect(keepAlive).toBe(true)
          events.push('release-preflight')
          expect(leases.delete('preflight:stop')).toBe(true)
        } }
      }
      openCodeSessionBridge.abort = async target => {
        expect(target.teamId).toBe('team-a')
        expect(leases.has('preflight:stop')).toBe(true)
        events.push('abort')
        return true
      }
      openCodeSessionBridge.releaseSession = async target => {
        expect(target.teamId).toBe('team-a')
        events.push('release-session')
        leases.delete('session:team-a')
      }
      openCodeHostManager.reconcilePersistentHosts = async input => {
        events.push('cleanup')
        expect(input).toEqual({ mode: 'stale', reason: 'stopTeam', projectPath: record.projectPath,
          staleAgeMs: 0, leaseStaleAgeMs: null, preflightLeaseStaleAgeMs: null })
        expect([...leases]).toEqual(sharedHost ? ['session:other-team'] : [])
        return { cleaned: leases.size ? 0 : 1, remaining: leases.size ? 1 : 0,
          hosts: [], diagnostics: [] }
      }
      const handshake = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.handshake', {
        requiredCommand: 'opencode.stopTeam', teamId: 'team-a', laneId: 'primary', runId: 'run-1',
        expectedCapabilitySnapshotId: 'selected',
      }))
      if (!('runtime' in handshake)) throw new Error('missing runtime snapshot')
      events.length = 0
      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
        teamId: 'team-a', laneId: 'primary', runId: 'run-1',
        expectedCapabilitySnapshotId: handshake.runtime.capabilitySnapshotId,
      }))
      if (!('data' in result) || !('stopped' in result.data)) throw new Error('stop failed')
      expect(result.ok).toBe(true)
      expect(result.data.stopped).toBe(true)
      expect(events).toEqual(['retain', 'abort', 'release-session', 'release-preflight', 'cleanup'])
      expect([...leases]).toEqual(sharedHost ? ['session:other-team'] : [])
      expect(result.data.diagnostics.some(item => item.code === 'opencode_host_cleanup')).toBe(!sharedHost)
    })
  }

  test('stop releases preflight exactly once when authority validation fails before member effects', async () => {
    const record = buildRecord({ runId: 'run-1', selectedModel: 'openai/gpt-5.6-sol', toolApprovalMode: 'auto',
      profileScope: { purpose: 'launch_runtime', providerId: 'openai', scopeToken: 'lane-scope',
        configFingerprint: 'config', selectedAuthIdentity: 'absent' } })
    const events: string[] = []
    openCodeSessionStore.list = async () => [record]
    openCodeProvisioningProbe.probeRetainingHost = async () => ({ snapshot, host: snapshot.host,
      release: async keepAlive => { expect(keepAlive).toBe(true); events.push('release-preflight') } })
    openCodeSessionBridge.abort = async () => { events.push('abort'); return true }
    openCodeSessionBridge.releaseSession = async () => { events.push('release-session') }
    openCodeHostManager.reconcilePersistentHosts = async () => {
      events.push('cleanup')
      return { cleaned: 0, remaining: 0, hosts: [], diagnostics: [] }
    }
    const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
      teamId: 'team-a', laneId: 'primary', runId: 'run-1', preconditions: {
        handshakeIdentityHash: 'handshake', laneId: 'primary', expectedRunId: 'run-1',
        expectedCapabilitySnapshotId: 'stale-capability', expectedBehaviorFingerprint: null,
        expectedManifestHighWatermark: null, commandLeaseId: 'lease', idempotencyKey: 'stop',
      },
    }))
    expect(result.ok).toBe(false)
    expect(events).toEqual(['release-preflight'])
  })

  test('stop does not retry a failed preflight release or clean up uncertain ownership', async () => {
    const record = buildRecord({ runId: 'run-1', selectedModel: 'openai/gpt-5.6-sol', toolApprovalMode: 'auto',
      profileScope: { purpose: 'launch_runtime', providerId: 'openai', scopeToken: 'lane-scope',
        configFingerprint: 'config', selectedAuthIdentity: 'absent' } })
    const events: string[] = []
    openCodeSessionStore.list = async () => [record]
    openCodeProvisioningProbe.probeRetainingHost = async () => ({ snapshot, host: snapshot.host,
      release: async keepAlive => {
        if (!keepAlive) return // The preceding handshake releases its own preflight.
        events.push('release-preflight')
        throw new Error('uncertain preflight release')
      } })
    openCodeSessionBridge.abort = async () => { events.push('abort'); return true }
    openCodeSessionBridge.releaseSession = async () => { events.push('release-session') }
    openCodeHostManager.reconcilePersistentHosts = async () => {
      events.push('cleanup')
      return { cleaned: 0, remaining: 0, hosts: [], diagnostics: [] }
    }
    const body = { teamId: 'team-a', laneId: 'primary', runId: 'run-1' }
    const handshake = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.handshake', {
      ...body, requiredCommand: 'opencode.stopTeam', expectedCapabilitySnapshotId: 'selected',
    }))
    if (!('runtime' in handshake)) throw new Error('missing runtime snapshot')
    const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
      ...body, expectedCapabilitySnapshotId: handshake.runtime.capabilitySnapshotId,
    }))
    expect(result.ok).toBe(false)
    if (!('error' in result)) throw new Error('expected release failure')
    expect(result.error.message).toContain('uncertain preflight release')
    expect(events).toEqual(['abort', 'release-session', 'release-preflight'])
  })

  for (const legacy of [false, true]) {
    test(`Cursor desktop Stop preserves ${legacy ? 'persisted desktop capability' : 'retained launch receipt'} after signout/assets/config loss and restart`, async () => {
      const projectPath = await mkdtemp(path.join(os.tmpdir(), 'cursor-desktop-stop-owned-'))
      const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
      process.env.CLAUDE_CONFIG_DIR = projectPath
      try {
        const store = new OpenCodeSessionStore(path.join(projectPath, 'sessions.json'))
        const runtime = { providerId: 'opencode' as const, binaryPath: 'opencode', binaryFingerprint: 'version:fixture',
          version: 'fixture', capabilitySnapshotId: `opencode:${'a'.repeat(32)}` }
        const record = buildRecord({ projectPath, runId: 'run-1', selectedModel: 'cursor-acp/auto', toolApprovalMode: 'auto',
          profileScope: { purpose: 'launch_runtime', providerId: 'cursor-acp', scopeToken: 'scope',
            configFingerprint: 'config', selectedAuthIdentity: `known:${'c'.repeat(64)}` },
          expectedBehaviorFingerprint: 'b'.repeat(64), stopAuthority: { runtime, expectedBehaviorFingerprint: 'b'.repeat(64) } })
        if (legacy) {
          delete record.stopAuthority
          const manifestPath = path.join(projectPath, 'teams', record.teamId,
            '.opencode-runtime', 'lanes', record.laneId ?? 'primary', 'manifest.json')
          await mkdir(path.dirname(manifestPath), { recursive: true })
          await writeFile(manifestPath, JSON.stringify({ data: { schemaVersion: 1,
            teamName: record.teamId, activeRunId: record.runId,
            activeCapabilitySnapshotId: runtime.capabilitySnapshotId } }))
        }
        await store.upsert(record)
        openCodeSessionStore.list = store.list.bind(store)
        openCodeSessionStore.get = store.get.bind(store)
        openCodeSessionStore.markStoppedIfSession = store.markStoppedIfSession.bind(store)
        openCodeProvisioningProbe.probe = async () => { throw new Error('signed out/assets missing/config drift') }
        openCodeProvisioningProbe.probeRetainingHost = async () => { throw new Error('no new launch authorization for cleanup') }
        openCodeHostManager.resolveOwnedSessionEndpoint = async (key, lease) => {
          expect(key).toBe(record.hostKey)
          expect(lease.runId).toBe(record.runId)
          expect(lease.sessionId).toBe(record.opencodeSessionId)
          return { baseUrl: 'http://127.0.0.1:43210', pid: 123 }
        }
        let aborts = 0
        openCodeSessionBridge.abort = async () => { aborts++; return true }
        openCodeSessionBridge.getRawStatus = async () => 'idle'
        openCodeSessionBridge.releaseSession = async () => {}
        const body = { projectPath, teamId: record.teamId, laneId: record.laneId, runId: record.runId,
          expectedCapabilitySnapshotId: runtime.capabilitySnapshotId }
        const handshake = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.handshake', {
          ...body, requiredCommand: 'opencode.stopTeam',
        }))
        expect(handshake.ok).toBe(true)
        if (!('data' in handshake) || !('server' in handshake.data)) throw new Error('missing handshake')
        // Desktop rejects the command unless this equals its persisted launch ID.
        expect(handshake.data.server.runtime.capabilitySnapshotId).toBe(runtime.capabilitySnapshotId)
        const rejected = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.handshake', {
          ...body, requiredCommand: 'opencode.stopTeam', expectedCapabilitySnapshotId: `opencode:${'f'.repeat(32)}`,
        }))
        expect(rejected.ok).toBe(false)
        expect(aborts).toBe(0)
        const first = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', body))
        expect(first.ok).toBe(true)
        expect((await store.get(record.teamId, record.laneId!, record.memberName))?.stoppedAt).toBeDefined()
        const restarted = new OpenCodeSessionStore(path.join(projectPath, 'sessions.json'))
        openCodeSessionStore.list = restarted.list.bind(restarted)
        openCodeSessionStore.get = restarted.get.bind(restarted)
        expect((await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', body))).ok).toBe(true)
        expect(aborts).toBe(1)
        for (const patch of [{ runId: 'foreign' }, { expectedCapabilitySnapshotId: 'foreign' }]) {
          expect((await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', { ...body, ...patch }))).ok).toBe(false)
        }
      } finally {
        if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
        await rm(projectPath, { recursive: true, force: true })
      }
    })
  }

  test('confirmed stop receipts survive partial stop and lost responses without probing or re-aborting', async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), 'opencode-terminal-stop-'))
    try {
      const store = new OpenCodeSessionStore(path.join(projectPath, 'sessions.json'))
      const record = buildRecord({ projectPath, runId: 'run-1', selectedModel: 'openai/gpt-5.6-sol', toolApprovalMode: 'auto',
        profileScope: { purpose: 'launch_runtime', providerId: 'openai', scopeToken: 'lane-scope',
          configFingerprint: 'config', selectedAuthIdentity: 'absent' } })
      await store.upsert(record)
      await store.upsert({ ...record, memberName: 'bob', opencodeSessionId: 'session-bob' })
      openCodeSessionStore.list = store.list.bind(store)
      openCodeSessionStore.get = store.get.bind(store)
      openCodeSessionStore.markStoppedIfSession = store.markStoppedIfSession.bind(store)
      let probes = 0
      let bobCanStop = false
      const aborted: string[] = []
      const released: string[] = []
      openCodeProvisioningProbe.probe = async () => { throw new Error('broad probe forbidden') }
      openCodeProvisioningProbe.probeRetainingHost = async () => {
        probes += 1
        return { snapshot: { ...snapshot, projectPath }, host: snapshot.host, release: async () => {} }
      }
      openCodeSessionBridge.abort = async target => {
        aborted.push(target.memberName)
        return target.memberName !== 'bob' || bobCanStop
      }
      openCodeSessionBridge.getRawStatus = async target =>
        target.memberName === 'bob' && !bobCanStop ? null : 'idle'
      openCodeSessionBridge.releaseSession = async target => { released.push(target.memberName) }
      const body = { projectPath, teamId: 'team-a', laneId: 'primary', runId: 'run-1' }
      const handshake = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.handshake', {
        ...body, requiredCommand: 'opencode.stopTeam', expectedCapabilitySnapshotId: 'selected',
      }))
      if (!('runtime' in handshake)) throw new Error('missing runtime')
      const cap = handshake.runtime.capabilitySnapshotId
      const stop = () => executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
        ...body, expectedCapabilitySnapshotId: cap,
      }))
      const partial = await stop()
      if (!('data' in partial) || !('stopped' in partial.data)) throw new Error('missing stop result')
      expect(partial.data.stopped).toBe(false)
      expect((await store.get('team-a', 'primary', 'alice'))?.stoppedAt).toBeDefined()
      expect((await store.get('team-a', 'primary', 'bob'))?.stoppedAt).toBeUndefined()
      bobCanStop = true
      const complete = await stop()
      if (!('data' in complete) || !('stopped' in complete.data)) throw new Error('missing stop result')
      expect(complete.data.stopped).toBe(true)
      expect([...aborted].sort()).toEqual(['alice', 'bob', 'bob'])
      expect(released).toEqual(['alice', 'bob'])
      const terminal = await store.list()
      expect(probes).toBe(3)
      openCodeProvisioningProbe.probeRetainingHost = async () => { throw new Error('auth changed; no host probe allowed') }
      for (const command of ['opencode.handshake', 'opencode.stopTeam']) {
        const replay = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope(command, {
          ...body, projectPath: await realpath(projectPath), requiredCommand: 'opencode.stopTeam',
          expectedCapabilitySnapshotId: cap,
        }))
        expect(replay.ok).toBe(true)
        if (!('runtime' in replay)) throw new Error('missing replay runtime')
        expect(replay.runtime.capabilitySnapshotId).toBe(cap)
      }
      expect(await store.list()).toEqual(terminal)
      expect([...aborted].sort()).toEqual(['alice', 'bob', 'bob'])
      expect(released).toEqual(['alice', 'bob'])
      for (const patch of [{ expectedCapabilitySnapshotId: 'wrong' }, { runId: 'wrong-run' },
        { projectPath: '/tmp/wrong-terminal-project' }, { preconditions: {
          handshakeIdentityHash: 'handshake', laneId: 'primary', expectedRunId: 'run-1',
          expectedCapabilitySnapshotId: cap, expectedBehaviorFingerprint: 'f'.repeat(64),
          expectedManifestHighWatermark: null, commandLeaseId: 'lease', idempotencyKey: 'stop',
        } }]) {
        for (const command of ['opencode.handshake', 'opencode.stopTeam']) {
          const rejected = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope(command, {
            ...body, requiredCommand: 'opencode.stopTeam', expectedCapabilitySnapshotId: cap, ...patch,
          }))
          expect(rejected.ok).toBe(false)
        }
      }
      expect(await store.list()).toEqual(terminal)
    } finally { await rm(projectPath, { recursive: true, force: true }) }
  })

  test('stop confirms a verified-gone host without minting confirmed Stop receipts', async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), 'opencode-gone-host-stop-'))
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = projectPath
    try {
      const store = new OpenCodeSessionStore(path.join(projectPath, 'sessions.json'))
      const capabilitySnapshotId = `opencode:${'a'.repeat(32)}`
      const record = buildRecord({ projectPath, runId: 'run-1', runtimePid: 123,
        selectedModel: 'openai/gpt-5.6-sol', toolApprovalMode: 'auto',
        profileScope: { purpose: 'launch_runtime', providerId: 'openai', scopeToken: 'lane-scope',
          configFingerprint: 'config', selectedAuthIdentity: 'absent' },
        expectedBehaviorFingerprint: 'b'.repeat(64) })
      await store.upsert(record)
      await store.upsert({ ...record, memberName: 'bob', opencodeSessionId: 'session-bob' })
      openCodeSessionStore.list = store.list.bind(store)
      openCodeSessionStore.get = store.get.bind(store)
      openCodeSessionStore.markStoppedIfSession = store.markStoppedIfSession.bind(store)
      const manifestPath = path.join(projectPath, 'teams', record.teamId,
        '.opencode-runtime', 'lanes', record.laneId ?? 'primary', 'manifest.json')
      await mkdir(path.dirname(manifestPath), { recursive: true })
      await writeFile(manifestPath, JSON.stringify({ data: { schemaVersion: 1,
        teamName: record.teamId, activeRunId: record.runId,
        activeCapabilitySnapshotId: capabilitySnapshotId } }))
      let goneProbes = 0
      openCodeProvisioningProbe.probe = async () => { throw new Error('broad probe forbidden') }
      openCodeProvisioningProbe.probeRetainingHost = async () => {
        goneProbes += 1
        throw new OpenCodeHostProcessGoneError(123)
      }
      openCodeSessionBridge.abort = async () => {
        throw new Error('must not abort a session on a gone host')
      }
      const released: string[] = []
      openCodeSessionBridge.releaseSession = async (target, options) => {
        expect(options?.strictLeaseRelease).toBe(true)
        released.push(target.memberName)
      }
      const body = { projectPath, teamId: record.teamId, laneId: record.laneId, runId: record.runId,
        expectedCapabilitySnapshotId: capabilitySnapshotId }
      const handshake = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.handshake', {
        ...body, requiredCommand: 'opencode.stopTeam',
      }))
      expect(handshake.ok).toBe(true)
      if (!('data' in handshake) || !('server' in handshake.data)) throw new Error('missing handshake')
      // Desktop rejects the command unless this equals its persisted launch ID.
      expect(handshake.data.server.runtime.capabilitySnapshotId).toBe(capabilitySnapshotId)
      const first = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', body))
      expect(first.ok).toBe(true)
      if (!('data' in first) || !('stopped' in first.data)) throw new Error('missing stop result')
      expect(first.data.stopped).toBe(true)
      expect([...released].sort()).toEqual(['alice', 'bob'])
      for (const memberName of ['alice', 'bob']) {
        const terminal = await store.get(record.teamId, record.laneId ?? 'primary', memberName)
        expect(terminal?.stoppedAt).toBeDefined()
        // Process absence retires the session; it never mints a Stop receipt.
        expect(terminal?.stopAuthority).toBeUndefined()
      }
      expect(goneProbes).toBe(2)
      // A terminal replay confirms without any host probe or re-close.
      openCodeProvisioningProbe.probeRetainingHost = async () => {
        throw new Error('must not probe a terminal lane')
      }
      for (const command of ['opencode.handshake', 'opencode.stopTeam']) {
        const replay = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope(command, {
          ...body, requiredCommand: 'opencode.stopTeam',
        }))
        expect(replay.ok).toBe(true)
        if (!('runtime' in replay)) throw new Error('missing replay runtime')
        expect(replay.runtime.capabilitySnapshotId).toBe(capabilitySnapshotId)
      }
      expect([...released].sort()).toEqual(['alice', 'bob'])
      // Capability and run binding stay fail-closed.
      for (const patch of [{ expectedCapabilitySnapshotId: `opencode:${'f'.repeat(32)}` },
        { runId: 'foreign-run' }]) {
        expect((await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
          ...body, ...patch,
        }))).ok).toBe(false)
      }
    } finally {
      if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
      await rm(projectPath, { recursive: true, force: true })
    }
  })

  for (const failure of ['abort', 'release', 'cas'] as const) {
    test(`stop never marks terminal when ${failure} fails`, async () => {
      const record = buildRecord()
      let marks = 0
      openCodeSessionStore.list = async () => [record]
      openCodeProvisioningProbe.probe = async () => snapshot
      openCodeSessionBridge.abort = async () => {
        if (failure === 'abort') throw new Error('abort failed')
        return true
      }
      openCodeSessionBridge.releaseSession = async (_record, options) => {
        expect(options?.strictLeaseRelease).toBe(true)
        if (failure === 'release') throw new Error('release failed')
      }
      openCodeSessionStore.markStoppedIfSession = async () => { marks += 1; return null }
      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
        teamId: record.teamId, laneId: 'primary', runId: 'run-1',
      }))
      if (!('data' in result) || !('stopped' in result.data)) throw new Error('missing stop result')
      expect(result.data.stopped).toBe(false)
      expect(marks).toBe(failure === 'cas' ? 1 : 0)
      expect(record.stoppedAt).toBeUndefined()
    })
  }

  describe('reliable OpenCode stop contract', () => {
    beforeEach(() => {
      openCodeProvisioningProbe.probe = async () => snapshot
      openCodeSessionBridge.releaseSession = async () => {}
    })

    test('1. exact stale run never aborts a successor session', async () => {
      let aborts = 0
      openCodeSessionStore.list = async () => [buildRecord({
        runId: 'run-successor',
        opencodeSessionId: 'session-successor',
      })]
      openCodeSessionBridge.abort = async () => { aborts += 1; return true }

      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
        teamId: 'team-a', laneId: 'primary', runId: 'run-stale',
      }))

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.stopped).toBe(false)
      expect(result.data.members).toEqual({})
      expect(result.data.diagnostics.map(item => item.code)).toContain('opencode_stop_identity_changed')
      expect(aborts).toBe(0)
    })

    test('2. mixed lanes abort and release only the addressed lane', async () => {
      const effects: string[] = []
      openCodeSessionStore.list = async () => [
        buildRecord({ laneId: 'lane-a', memberName: 'alice', opencodeSessionId: 'session-alice' }),
        buildRecord({ laneId: 'lane-b', memberName: 'bob', opencodeSessionId: 'session-bob' }),
      ]
      openCodeSessionBridge.abort = async record => { effects.push(`abort:${record.memberName}`); return true }
      openCodeSessionBridge.releaseSession = async record => { effects.push(`release:${record.memberName}`) }

      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
        teamId: 'team-a', laneId: 'lane-a', runId: 'run-1',
      }))

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(Object.keys(result.data.members)).toEqual(['alice'])
      expect(result.data.stopped).toBe(true)
      expect(effects).toEqual(['abort:alice', 'release:alice'])
    })

    test('3. abort true with busy then idle releases the lease and applies CAS', async () => {
      const record = buildRecord()
      const statuses = ['busy', 'idle']
      const events: string[] = []
      openCodeSessionStore.list = async () => [record]
      openCodeSessionBridge.observeStopIdle = async () => {
        events.push('observer-connected')
        return {
          arm: () => { events.push('observer-armed') },
          currentStatus: () => null,
          waitForIdle: async () => false,
          dispose: async () => {},
        }
      }
      openCodeSessionBridge.abort = async () => { events.push('abort'); return true }
      openCodeSessionBridge.getRawStatus = async () => statuses.shift() ?? 'idle'
      openCodeSessionBridge.releaseSession = async (_record, options) => {
        expect(options).toEqual({ strictLeaseRelease: true })
        events.push('release')
      }
      openCodeSessionStore.markStoppedIfSession = async current => {
        events.push('cas')
        return { ...record, ...current, stoppedAt: '2026-09-05T00:00:00.000Z' }
      }

      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
        teamId: record.teamId, laneId: record.laneId, runId: record.runId,
      }))

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.members.alice?.stopped).toBe(true)
      expect(events).toEqual(['observer-connected', 'observer-armed', 'abort', 'release', 'cas'])
    })

    test('4. a session that remains busy keeps its lease and terminal marker', async () => {
      const record = buildRecord()
      let statusReads = 0; let releases = 0; let marks = 0
      openCodeSessionStore.list = async () => [record]
      openCodeSessionBridge.abort = async () => true
      openCodeSessionBridge.getRawStatus = async () => { statusReads += 1; return 'busy' }
      openCodeSessionBridge.releaseSession = async () => { releases += 1 }
      openCodeSessionStore.markStoppedIfSession = async () => { marks += 1; return null }

      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
        teamId: record.teamId, laneId: record.laneId, runId: record.runId,
      }))

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.members.alice).toEqual({
        sessionId: record.opencodeSessionId, stopped: false, diagnostics: ['still busy'],
      })
      expect(statusReads).toBe(3)
      expect({ releases, marks }).toEqual({ releases: 0, marks: 0 })
    })

    test('5. abort false with explicit idle succeeds as already idle', async () => {
      const record = buildRecord()
      let releases = 0; let marks = 0
      openCodeSessionStore.list = async () => [record]
      openCodeSessionBridge.abort = async () => false
      openCodeSessionBridge.getRawStatus = async () => 'idle'
      openCodeSessionBridge.releaseSession = async () => { releases += 1 }
      openCodeSessionStore.markStoppedIfSession = async () => {
        marks += 1
        return { ...record, stoppedAt: '2026-09-05T00:00:00.000Z' }
      }

      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
        teamId: record.teamId, laneId: record.laneId, runId: record.runId,
      }))

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.members.alice).toEqual({
        sessionId: record.opencodeSessionId, stopped: true, diagnostics: ['already idle'],
      })
      expect({ releases, marks }).toEqual({ releases: 1, marks: 1 })
    })

    test('6. abort false with missing or unknown status never releases or marks stopped', async () => {
      for (const [rawStatus, reason] of [[null, 'status missing'], [{ type: 'mystery' }, 'status unrecognized']] as const) {
        const record = buildRecord()
        let releases = 0; let marks = 0
        openCodeSessionStore.list = async () => [record]
        openCodeSessionBridge.abort = async () => false
        openCodeSessionBridge.getRawStatus = (async () => rawStatus) as typeof openCodeSessionBridge.getRawStatus
        openCodeSessionBridge.releaseSession = async () => { releases += 1 }
        openCodeSessionStore.markStoppedIfSession = async () => { marks += 1; return null }

        const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
          teamId: record.teamId, laneId: record.laneId, runId: record.runId,
        }))
        expect(result.ok).toBe(true)
        if (!result.ok) continue
        expect(result.data.members.alice?.stopped).toBe(false)
        expect(result.data.members.alice?.diagnostics).toEqual(['abort rejected', reason])
        expect({ releases, marks }).toEqual({ releases: 0, marks: 0 })
      }
    })

    test('7. identity is rechecked before abort', async () => {
      const record = buildRecord()
      let aborts = 0
      openCodeSessionStore.list = async () => [record]
      openCodeSessionStore.get = async () => ({
        ...record, runId: 'run-successor', opencodeSessionId: 'session-successor',
      })
      openCodeSessionBridge.abort = async () => { aborts += 1; return true }

      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
        teamId: record.teamId, laneId: record.laneId, runId: record.runId,
      }))

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.members.alice?.diagnostics).toEqual(['identity changed before abort'])
      expect(aborts).toBe(0)
    })

    test('8. identity changes after idle and CAS mismatch both preserve the successor', async () => {
      const record = buildRecord()
      for (const failure of ['host-key', 'cas'] as const) {
        let reads = 0; let releases = 0; let marks = 0
        openCodeSessionStore.list = async () => [record]
        openCodeSessionStore.get = async () => {
          reads += 1
          if (failure === 'host-key' && reads === 3) return { ...record, hostKey: 'successor-host' }
          return record
        }
        openCodeSessionBridge.abort = async () => true
        openCodeSessionBridge.getRawStatus = async () => 'idle'
        openCodeSessionBridge.releaseSession = async () => { releases += 1 }
        openCodeSessionStore.markStoppedIfSession = async () => { marks += 1; return null }

        const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
          teamId: record.teamId, laneId: record.laneId, runId: record.runId,
        }))
        expect(result.ok).toBe(true)
        if (!result.ok) continue
        expect(result.data.members.alice?.stopped).toBe(false)
        expect(result.data.members.alice?.diagnostics).toEqual(['identity changed before confirmation'])
        expect({ releases, marks }).toEqual(failure === 'host-key'
          ? { releases: 0, marks: 0 }
          : { releases: 1, marks: 1 })
      }
    })

    test('9. slow and failing members do not block successful peers', async () => {
      const records = ['alice', 'bob', 'carol'].map(name => buildRecord({
        memberName: name, opencodeSessionId: `session-${name}`,
      }))
      openCodeSessionStore.list = async () => records
      openCodeSessionBridge.abort = async record => {
        if (record.memberName === 'bob') throw new Error('bob transport failed')
        if (record.memberName === 'carol') await new Promise(resolve => setTimeout(resolve, 20))
        return true
      }

      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
        teamId: 'team-a', laneId: 'primary', runId: 'run-1',
      }))

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.stopped).toBe(false)
      expect(result.data.members.alice?.stopped).toBe(true)
      expect(result.data.members.bob?.diagnostics).toEqual(['bob transport failed'])
      expect(result.data.members.carol?.stopped).toBe(true)
    })

    test('10. member stop concurrency never exceeds four', async () => {
      const records = Array.from({ length: 9 }, (_, index) => buildRecord({
        memberName: `member-${index}`, opencodeSessionId: `session-${index}`,
      }))
      const gate = createDeferred<void>()
      let active = 0; let maximum = 0; let started = 0
      const firstWave = createDeferred<void>()
      openCodeSessionStore.list = async () => records
      openCodeSessionBridge.abort = async () => {
        active += 1; started += 1; maximum = Math.max(maximum, active)
        if (started === 4) firstWave.resolve()
        await gate.promise
        active -= 1
        return true
      }

      const stop = executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
        teamId: 'team-a', laneId: 'primary', runId: 'run-1',
      }))
      await firstWave.promise
      expect(started).toBe(4)
      expect(maximum).toBe(4)
      gate.resolve()
      const result = await stop
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.stopped).toBe(true)
      expect(started).toBe(9)
      expect(maximum).toBe(4)
    })

    test('11. the shared deadline cancels in-flight aborts and starts no queued aborts', async () => {
      const records = Array.from({ length: 8 }, (_, index) => buildRecord({
        memberName: `member-${index}`, opencodeSessionId: `session-${index}`,
      }))
      let started = 0; let cancelled = 0
      openCodeSessionStore.list = async () => records
      openCodeSessionBridge.abort = async (_record, options) => {
        started += 1
        return new Promise<boolean>((_resolve, reject) => {
          const cancel = () => { cancelled += 1; reject(options.signal?.reason) }
          if (options.signal?.aborted) cancel()
          else options.signal?.addEventListener('abort', cancel, { once: true })
        })
      }
      const envelope = {
        ...buildEnvelope('opencode.stopTeam', {
          teamId: 'team-a', laneId: 'primary', runId: 'run-1',
        }),
        timeoutMs: 25,
      }

      const result = await executeOpenCodeBridgeCommandEnvelope(envelope)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(started).toBe(4)
      expect(cancelled).toBe(4)
      expect(Object.values(result.data.members).every(member => !member.stopped)).toBe(true)
      expect(result.data.diagnostics.some(item => item.code === 'opencode_stop_deadline')).toBe(true)
    })

    test('12. an exact already-terminal record is idempotent and never aborts again', async () => {
      const record = buildRecord({ stoppedAt: '2026-09-05T00:00:00.000Z' })
      let aborts = 0
      openCodeSessionStore.list = async () => [record]
      openCodeSessionBridge.abort = async () => { aborts += 1; return true }

      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
        teamId: record.teamId, laneId: record.laneId, runId: record.runId,
      }))

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.stopped).toBe(true)
      expect(result.data.members.alice?.stopped).toBe(true)
      expect(aborts).toBe(0)
    })

    test('13. shared-host cleanup is scoped and preserves another active lease', async () => {
      const record = buildRecord()
      let cleanupInput: unknown
      openCodeSessionStore.list = async () => [record, buildRecord({
        teamId: 'team-other', laneId: 'other', memberName: 'peer', opencodeSessionId: 'session-peer',
      })]
      openCodeSessionBridge.abort = async () => true
      openCodeHostManager.reconcilePersistentHosts = async input => {
        cleanupInput = input
        return { cleaned: 0, remaining: 1, hosts: [], diagnostics: [] }
      }

      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
        teamId: record.teamId, laneId: record.laneId, runId: record.runId,
      }))

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.stopped).toBe(true)
      expect(cleanupInput).toEqual({ mode: 'stale', reason: 'stopTeam', projectPath: '/tmp/project',
        staleAgeMs: 0, leaseStaleAgeMs: null, preflightLeaseStaleAgeMs: null })
      expect(result.data.diagnostics.some(item => item.code === 'opencode_host_cleanup')).toBe(false)
    })

    test('14. a host without leases is reported as cleaned', async () => {
      const record = buildRecord()
      openCodeSessionStore.list = async () => [record]
      openCodeSessionBridge.abort = async () => true
      openCodeHostManager.reconcilePersistentHosts = async () => ({
        cleaned: 1, remaining: 0, hosts: [], diagnostics: [],
      })

      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
        teamId: record.teamId, laneId: record.laneId, runId: record.runId,
      }))

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.diagnostics).toContainEqual({
        code: 'opencode_host_cleanup', severity: 'info',
        message: 'Disposed 1 OpenCode host without active leases for /tmp/project',
      })
    })

    test('15. cleanup failure is a warning and preserves confirmed member success', async () => {
      const record = buildRecord()
      openCodeSessionStore.list = async () => [record]
      openCodeSessionBridge.abort = async () => true
      openCodeHostManager.reconcilePersistentHosts = async () => { throw new Error('cleanup unavailable') }

      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
        teamId: record.teamId, laneId: record.laneId, runId: record.runId,
      }))

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.stopped).toBe(true)
      expect(result.data.members.alice?.stopped).toBe(true)
      expect(result.data.diagnostics).toContainEqual({
        code: 'opencode_host_cleanup_failed', severity: 'warning', message: 'cleanup unavailable',
      })
    })

    test('16. aggregate stopped is true only when every addressed member is confirmed', async () => {
      const records = ['alice', 'bob'].map(name => buildRecord({
        memberName: name, opencodeSessionId: `session-${name}`,
      }))
      openCodeSessionStore.list = async () => records
      openCodeSessionBridge.abort = async () => true
      openCodeSessionBridge.getRawStatus = async record => record.memberName === 'alice' ? 'idle' : null

      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
        teamId: 'team-a', laneId: 'primary', runId: 'run-1',
      }))

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.members.alice?.stopped).toBe(true)
      expect(result.data.members.bob?.stopped).toBe(false)
      expect(result.data.stopped).toBe(false)
    })

    test('17. retained stop ignores a terminal member from a prior run', async () => {
      const profileScope = {
        purpose: 'launch_runtime' as const,
        providerId: 'openai',
        scopeToken: 'lane-scope',
        configFingerprint: 'config',
        selectedAuthIdentity: 'absent' as const,
      }
      const current = buildRecord({
        runId: 'run-current',
        selectedModel: 'openai/gpt-5.6-sol',
        toolApprovalMode: 'auto',
        profileScope,
      })
      const terminalPriorRun = buildRecord({
        runId: 'run-prior',
        memberName: 'retired-member',
        opencodeSessionId: 'session-prior',
        selectedModel: current.selectedModel,
        toolApprovalMode: current.toolApprovalMode,
        profileScope,
        stoppedAt: '2026-09-04T00:00:00.000Z',
      })
      const aborted: string[] = []
      openCodeSessionStore.list = async () => [current, terminalPriorRun]
      openCodeProvisioningProbe.probeRetainingHost = async () => ({
        snapshot, host: snapshot.host, release: async () => {},
      })
      openCodeSessionBridge.abort = async record => { aborted.push(record.memberName); return true }
      const body = {
        teamId: current.teamId,
        laneId: current.laneId,
        runId: current.runId,
      }
      const handshake = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.handshake', {
        ...body,
        requiredCommand: 'opencode.stopTeam',
        expectedCapabilitySnapshotId: 'selected',
      }))
      expect(handshake.ok).toBe(true)
      if (!handshake.ok) return

      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
        ...body,
        expectedCapabilitySnapshotId: handshake.runtime.capabilitySnapshotId,
      }))

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.stopped).toBe(true)
      expect(Object.keys(result.data.members)).toEqual(['alice'])
      expect(aborted).toEqual(['alice'])
    })

    test('18. retained stop rejects an active foreign run before any abort', async () => {
      const profileScope = {
        purpose: 'launch_runtime' as const,
        providerId: 'openai',
        scopeToken: 'lane-scope',
        configFingerprint: 'config',
        selectedAuthIdentity: 'absent' as const,
      }
      const current = buildRecord({
        runId: 'run-current',
        selectedModel: 'openai/gpt-5.6-sol',
        toolApprovalMode: 'auto',
        profileScope,
      })
      let records = [current]
      let aborts = 0
      openCodeSessionStore.list = async () => records
      openCodeProvisioningProbe.probeRetainingHost = async () => ({
        snapshot, host: snapshot.host, release: async () => {},
      })
      openCodeSessionBridge.abort = async () => { aborts += 1; return true }
      const body = {
        teamId: current.teamId,
        laneId: current.laneId,
        runId: current.runId,
      }
      const handshake = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.handshake', {
        ...body,
        requiredCommand: 'opencode.stopTeam',
        expectedCapabilitySnapshotId: 'selected',
      }))
      expect(handshake.ok).toBe(true)
      if (!handshake.ok) return
      records = [current, buildRecord({
        runId: 'run-foreign',
        memberName: 'foreign-member',
        opencodeSessionId: 'session-foreign',
        selectedModel: current.selectedModel,
        toolApprovalMode: current.toolApprovalMode,
        profileScope,
      })]

      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
        ...body,
        expectedCapabilitySnapshotId: handshake.runtime.capabilitySnapshotId,
      }))

      expect(result.ok).toBe(false)
      expect(aborts).toBe(0)
      if (!result.ok) {
        expect(result.error.message).toContain('another run is active')
      }
    })

    test('19. terminal CAS exception restores the exact active session lease', async () => {
      const record = buildRecord()
      const events: string[] = []
      openCodeSessionStore.list = async () => [record]
      openCodeSessionBridge.abort = async () => true
      openCodeSessionBridge.releaseSession = async () => { events.push('release') }
      openCodeSessionStore.markStoppedIfSession = async () => {
        events.push('cas')
        throw new Error('terminal CAS failed')
      }
      openCodeSessionBridge.restoreSessionLease = async restored => {
        expect(restored).toEqual(record)
        events.push('restore')
      }

      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
        teamId: record.teamId, laneId: record.laneId, runId: record.runId,
      }))

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.stopped).toBe(false)
      expect(result.data.members.alice?.diagnostics).toEqual(['terminal CAS failed'])
      expect(result.data.diagnostics).toContainEqual({
        code: 'opencode_stop_lease_restored',
        severity: 'warning',
        message: 'alice: restored the exact session lease after terminal CAS failed',
      })
      expect(events).toEqual(['release', 'cas', 'restore'])
    })

    test('20. terminal CAS exception never restores a successor session lease', async () => {
      const record = buildRecord()
      let reads = 0; let restores = 0
      openCodeSessionStore.list = async () => [record]
      openCodeSessionStore.get = async () => {
        reads += 1
        return reads >= 4
          ? { ...record, opencodeSessionId: 'session-successor', runId: 'run-successor' }
          : record
      }
      openCodeSessionBridge.abort = async () => true
      openCodeSessionStore.markStoppedIfSession = async () => { throw new Error('terminal CAS failed') }
      openCodeSessionBridge.restoreSessionLease = async () => { restores += 1 }

      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
        teamId: record.teamId, laneId: record.laneId, runId: record.runId,
      }))

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.stopped).toBe(false)
      expect(result.data.members.alice?.diagnostics).toEqual(['terminal CAS failed'])
      expect(result.data.diagnostics.map(item => item.code)).not.toContain('opencode_stop_lease_restored')
      expect(restores).toBe(0)
    })

    test('21. lease restoration failure surfaces the CAS and compensation errors', async () => {
      const record = buildRecord()
      openCodeSessionStore.list = async () => [record]
      openCodeSessionBridge.abort = async () => true
      openCodeSessionStore.markStoppedIfSession = async () => { throw new Error('terminal CAS failed') }
      openCodeSessionBridge.restoreSessionLease = async () => { throw new Error('lease restore failed') }

      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
        teamId: record.teamId, laneId: record.laneId, runId: record.runId,
      }))

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.data.stopped).toBe(false)
      expect(result.data.members.alice?.diagnostics).toEqual([
        'OpenCode terminal CAS failed: terminal CAS failed; lease restoration failed: lease restore failed',
      ])
      expect(result.data.diagnostics).toContainEqual({
        code: 'opencode_stop_compensation_failed',
        severity: 'error',
        message: 'alice: terminal CAS failed (terminal CAS failed) and exact lease restoration failed (lease restore failed)',
      })
    })

    test('22. terminal CAS completing after deadline reports failure but remains idempotently terminal', async () => {
      const originalPerformanceNow = Object.getOwnPropertyDescriptor(performance, 'now')
      let monotonicNow = 1_000
      Object.defineProperty(performance, 'now', {
        configurable: true,
        value: () => monotonicNow,
      })
      try {
        const record = buildRecord()
        let stored = record
        let aborts = 0; let releases = 0; let marks = 0
        openCodeSessionStore.list = async () => [stored]
        openCodeSessionBridge.abort = async () => { aborts += 1; return true }
        openCodeSessionBridge.releaseSession = async (_record, options) => {
          expect(options).toEqual({ strictLeaseRelease: true })
          releases += 1
        }
        openCodeSessionStore.markStoppedIfSession = async () => {
          marks += 1
          monotonicNow = 2_501
          stored = { ...record, stoppedAt: '2026-09-05T00:00:00.000Z' }
          return stored
        }
        const body = { teamId: record.teamId, laneId: record.laneId, runId: record.runId }
        const firstEnvelope = {
          ...buildEnvelope('opencode.stopTeam', body),
          timeoutMs: 1_500,
        }

        const first = await executeOpenCodeBridgeCommandEnvelope(firstEnvelope)

        expect(first.ok).toBe(true)
        if (!first.ok) return
        expect(first.data.stopped).toBe(false)
        expect(first.data.members.alice).toEqual({
          sessionId: record.opencodeSessionId,
          stopped: false,
          diagnostics: ['deadline expired'],
        })
        expect(first.data.diagnostics).toContainEqual({
          code: 'opencode_stop_deadline',
          severity: 'error',
          message: 'alice: deadline expired while completing the atomic lease/CAS transition',
        })
        expect(stored.stoppedAt).toBeDefined()
        expect({ aborts, releases, marks }).toEqual({ aborts: 1, releases: 1, marks: 1 })

        const replay = await executeOpenCodeBridgeCommandEnvelope({
          ...buildEnvelope('opencode.stopTeam', body),
          timeoutMs: 1_500,
        })

        expect(replay.ok).toBe(true)
        if (!replay.ok) return
        expect(replay.data.stopped).toBe(true)
        expect(replay.data.members.alice?.stopped).toBe(true)
        expect({ aborts, releases, marks }).toEqual({ aborts: 1, releases: 1, marks: 1 })
      } finally {
        if (originalPerformanceNow) {
          Object.defineProperty(performance, 'now', originalPerformanceNow)
        }
      }
    })
  })

  test('explicit empty-lane stop checks absence in handshake and command before host or abort effects', async () => {
    let records: OpenCodeSessionRecord[] = []
    let effects = 0
    openCodeSessionStore.list = async () => records
    openCodeProvisioningProbe.probe = async () => { effects += 1; throw new Error('broad') }
    openCodeProvisioningProbe.probeRetainingHost = async () => { effects += 1; throw new Error('selected') }
    openCodeSessionBridge.abort = async () => { effects += 1; return true }
    const body = { teamId: 'team-a', laneId: 'primary', runId: 'run-1', allowEmptyLaneStop: true,
      expectedCapabilitySnapshotId: null, preconditions: {
        handshakeIdentityHash: 'test', laneId: 'primary', expectedRunId: 'run-1',
        expectedCapabilitySnapshotId: null, expectedBehaviorFingerprint: null,
        expectedManifestHighWatermark: null, commandLeaseId: 'lease', idempotencyKey: 'stop',
      } }
    for (const command of ['opencode.handshake', 'opencode.stopTeam']) {
      expect((await executeOpenCodeBridgeCommandEnvelope(buildEnvelope(command, {
        ...body, requiredCommand: 'opencode.stopTeam', expectedRunId: 'run-1',
      }))).ok).toBe(true)
    }
    records = [buildRecord()]
    for (const command of ['opencode.handshake', 'opencode.stopTeam']) {
      expect((await executeOpenCodeBridgeCommandEnvelope(buildEnvelope(command, {
        ...body, requiredCommand: 'opencode.stopTeam', expectedRunId: 'run-1',
      }))).ok).toBe(false)
    }
    expect(effects).toBe(0)
    expect((await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.stopTeam', {
      ...body, preconditions: undefined,
    }))).ok).toBe(false)
    expect(effects).toBe(0)
  })

  test('executes host cleanup without provisioning a readiness host', async () => {
    let probeCalled = false
    let cleanupInput: unknown = null
    openCodeProvisioningProbe.probe = (async () => {
      probeCalled = true
      throw new Error('cleanup must not probe readiness or spawn a host')
    }) as typeof openCodeProvisioningProbe.probe
    openCodeHostManager.reconcilePersistentHosts = (async (input) => {
      cleanupInput = input
      return {
        cleaned: 1,
        remaining: 0,
        hosts: [
          {
            hostKey: 'host-key',
            projectPath: '/tmp/project',
            pid: 123,
            port: 43116,
            action: 'disposed',
            reason: 'stale host has no active leases during startup',
            leaseCount: 0,
          },
        ],
        diagnostics: [],
      }
    }) as typeof openCodeHostManager.reconcilePersistentHosts

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.cleanupHosts', {
        reason: 'startup',
        mode: 'stale',
        projectPath: '/tmp/project',
        staleAgeMs: 1_000,
      }),
    )

    expect(result.ok).toBe(true)
    expect(probeCalled).toBe(false)
    expect(cleanupInput).toEqual({
      mode: 'stale',
      reason: 'startup',
      projectPath: '/tmp/project',
      staleAgeMs: 1_000,
      leaseStaleAgeMs: null,
      preflightLeaseStaleAgeMs: null,
    })
    if (result.ok) {
      expect(result.data.cleaned).toBe(1)
      expect(result.runtime.capabilitySnapshotId).toBeNull()
    }
  })

  test('checks command status with read-only summary inventory', async () => {
    const probeCalls: Array<{ projectPath?: string | null; options?: Record<string, unknown> }> = []
    openCodeInventoryService.probe = (async (projectPath, options) => {
      probeCalls.push({ projectPath, options: options as Record<string, unknown> })
      return {
        detected: true,
        binaryPath: 'opencode',
        version: '1.0.0',
        projectPath: projectPath ?? '/tmp/project',
        profile: null,
        connectedProviders: [],
        availableProviders: [],
        models: [],
        modelMetadata: [],
        agents: [],
        authStorePath: null,
        probeError: null,
        diagnostics: [],
      }
    }) as typeof openCodeInventoryService.probe

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.commandStatus', {
        projectPath: '/tmp/project',
        originalRequestId: 'missing-request',
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.status).toBe('unknown')
    expect(probeCalls).toEqual([
      {
        projectPath: '/tmp/project',
        options: { mode: 'passive', includeAppMcp: false },
      },
    ])
  })

  test('compatibility mode without execution probe still rejects unknown raw model ids', async () => {
    mockRequiredMcpTools()
    openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()
    let executionProbeCalled = false
    openCodeExecutionProbe.probeModel = (async () => {
      executionProbeCalled = true
      throw new Error('execution probe should not run')
    }) as typeof openCodeExecutionProbe.probeModel

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/ghost-model',
        requireExecutionProbe: false,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.state).toBe('model_unavailable')
    expect(result.data.launchAllowed).toBe(false)
    expect(result.data.missing[0]).toContain('was not found in the live provider catalog')
    expect(executionProbeCalled).toBe(false)
  })

  test('keeps an unhealthy host timeout provider-scoped instead of reporting the model missing', async () => {
    openCodeProvisioningProbe.probe = async () =>
      buildReadinessSnapshot({
        hostHealthy: false,
        host: null,
        configProviders: null,
        providers: null,
        probeError: '/config request failed: request timed out after 15000ms',
        diagnostics: [
          'Failed to query OpenCode agents: OpenCode command timed out after 10000ms',
          'Failed to query OpenCode models: OpenCode command timed out after 10000ms',
          '/config request failed: request timed out after 15000ms',
        ],
      })
    let executionProbeCalled = false
    openCodeExecutionProbe.probeModel = (async () => {
      executionProbeCalled = true
      throw new Error('execution probe should not run while the host is unhealthy')
    }) as typeof openCodeExecutionProbe.probeModel

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'zai-coding-plan/glm-5.1',
        requireExecutionProbe: true,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.state).toBe('unknown_error')
    expect(result.data.launchAllowed).toBe(false)
    expect(result.data.missing).toEqual([
      '/config request failed: request timed out after 15000ms',
    ])
    expect(result.data.diagnostics.join('\n')).toContain('OpenCode command timed out')
    expect(result.data.diagnostics.join('\n')).not.toContain('not found')
    expect(executionProbeCalled).toBe(false)
  })

  test('selected readiness uses one retained launch host and releases it without broad fallback', async () => {
    let released = 0
    let provenHost: string | null = null
    let observedProviderId = 'deepinfra'
    const selected = parseOpenCodeProviderScopedModelRef('deepinfra/chosen')!
    const retainedHost = {
      ...snapshot.host!,
      profile: {
        ...snapshot.host!.profile,
        scopeToken: 'selected-readiness',
        profileScope: {
          purpose: 'launch_runtime' as const,
          providerId: selected.providerId,
          configFingerprint: 'selected-config',
          selectedAuthIdentity: 'absent' as const,
          scopeToken: 'selected-readiness',
        },
      },
    }
    openCodeProvisioningProbe.probe = async () => {
      throw new Error('broad readiness poison path must not run')
    }
    openCodeProvisioningProbe.probeRetainingHost = (async () => ({
      snapshot: { ...snapshot, models: [selected.raw], host: retainedHost,
        profile: retainedHost.profile },
      host: retainedHost,
      release: async () => { released += 1 },
    })) as typeof openCodeProvisioningProbe.probeRetainingHost
    openCodeExecutionProbe.probeModel = (async () => {
      throw new Error('separate execution host poison path must not run')
    }) as typeof openCodeExecutionProbe.probeModel
    openCodeExecutionProbe.probeModelOnHost = (async input => {
      provenHost = input.host.hostKey
      return {
        providerId: 'opencode', modelId: input.selectedModel,
        observedProviderId, observedModelId: selected.modelId,
        probePrompt: 'PONG', expectedOutput: 'PONG', outcome: 'available', reason: null,
        durationMs: 1, rawStatus: 'idle', durableState: 'idle', latestAssistantText: 'PONG',
        latestAssistantPreview: 'PONG', toolCallCount: 0, errorCount: 0, diagnostics: [],
        verifiedAt: '2026-04-21T12:00:00.000Z',
      }
    }) as typeof openCodeExecutionProbe.probeModelOnHost

    const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.readiness', {
      projectPath: '/tmp/project', selectedModel: selected.raw, requireExecutionProbe: true,
    }))

    expect(result.ok).toBe(true)
    expect(provenHost).toBe('host-key')
    expect(released).toBe(1)
    if (result.ok) expect(result.data.expectedBehaviorEvidence.fullModelId).toBe(selected.raw)

    observedProviderId = 'other'
    const mismatch = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.readiness', {
      projectPath: '/tmp/project', selectedModel: selected.raw, requireExecutionProbe: true,
    }))
    expect(mismatch.ok).toBe(true)
    if (mismatch.ok) {
      expect(mismatch.data.launchAllowed).toBe(false)
      expect(mismatch.data.executionProof).toBeUndefined()
    }
  })

  test('selected readiness reports bounded authority diagnostics before and after execution', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    const successfulExecution = openCodeExecutionProbe.probeModelOnHost
    for (const rejectAfterExecution of [false, true]) {
      let refreshCalls = 0
      let executionCalls = 0
      openCodeProvisioningProbe.refreshSelectedProfileAuthority = async input => {
        refreshCalls += 1
        if (rejectAfterExecution && refreshCalls === 1) return input.host.profile
        input.onRejection?.({ check: 'selected_config_match', fields: ['agent', 'command'] })
        return null
      }
      openCodeExecutionProbe.probeModelOnHost = (async input => {
        executionCalls += 1
        return successfulExecution(input)
      }) as typeof openCodeExecutionProbe.probeModelOnHost
      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project', selectedModel: 'openrouter/minimax-m2.5-free',
        requireExecutionProbe: true,
      }))
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.message).toContain('(selected_config_match:agent,command)')
        expect(result.error.message).toContain(rejectAfterExecution
          ? 'changed during execution proof' : 'authority is unavailable')
      }
      expect(executionCalls).toBe(rejectAfterExecution ? 1 : 0)
    }
  })

  test('owned OAuth continuity is requested only after successful matching execution', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    const execute = openCodeExecutionProbe.probeModelOnHost
    for (const resultKind of ['available', 'unavailable', 'wrong_provider', 'wrong_model', 'missing_identity']) {
      const continuity: boolean[] = []
      openCodeProvisioningProbe.refreshSelectedProfileAuthority = async input => {
        continuity.push(input.completedOAuthProbe !== undefined)
        return input.host.profile
      }
      openCodeExecutionProbe.probeModelOnHost = async input => {
        const result = await execute(input)
        if (resultKind !== 'missing_identity') input.onOwnedOAuthProbeSuccess?.({
          hostKey: input.host.hostKey, baseUrl: input.host.baseUrl, pid: input.host.pid,
          processStartedAtMs: input.host.processStartedAtMs!, profileRootKey: input.host.profileRootKey,
          projectPath: input.host.projectPath, scopeToken: input.host.profile.scopeToken!,
          selectedModel: input.selectedModel, sessionId: 'TEST-session', messageId: 'TEST-message',
        })
        if (resultKind === 'unavailable') result.outcome = 'unavailable'
        if (resultKind === 'wrong_provider') result.observedProviderId = 'foreign'
        if (resultKind === 'wrong_model') result.observedModelId = 'foreign'
        return result
      }
      await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project', selectedModel: 'openrouter/minimax-m2.5-free', requireExecutionProbe: true,
      }))
      expect(continuity).toEqual([false, resultKind === 'available'])
    }
  })

  test('selected readiness bounds real authority auth reads before and after execution and ignores late results', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    const successfulExecution = openCodeExecutionProbe.probeModelOnHost
    const retain = openCodeProvisioningProbe.probeRetainingHost
    for (const afterExecution of [false, true]) {
      for (const lateReject of [false, true]) {
        let refreshCalls = 0
        let executionCalls = 0
        let releases = 0
        let reachedAuth = false
        let settle!: () => void
        let capturedSignal: AbortSignal | undefined
        openCodeProvisioningProbe.probeRetainingHost = (async (...args) => {
          const retained = await retain(...args)
          return { ...retained, release: async () => { releases += 1; await retained.release() } }
        }) as typeof retain
        openCodeExecutionProbe.probeModelOnHost = (async input => {
          executionCalls += 1
          return successfulExecution(input)
        }) as typeof successfulExecution
        openCodeProvisioningProbe.refreshSelectedProfileAuthority = async input => {
          refreshCalls += 1
          expect(input.phaseContext?.phase).toBe('post_probe_refresh')
          if (afterExecution && refreshCalls === 1) return input.host.profile
          capturedSignal = input.phaseContext?.signal
          const managedConfig = buildManagedConfig(retainedAppMcpConfig)
          const env = { ...input.host.profile.env, XDG_DATA_HOME: path.join(os.tmpdir(), 'readiness-authority-TEST-data') }
          const profile = { ...input.host.profile, managedConfig, env,
            managedConfigFingerprint: buildManagedConfigFingerprint(managedConfig, env) }
          input = { ...input, host: { ...input.host, profile } }
          const live = JSON.parse(JSON.stringify(profile.managedConfig)
            .replace(/\{env:([^}]+)\}/g, (_match, name: string) => profile.env[name] || ''))
          return refreshSelectedProfileAuthority(input, {
            clientFactory: { create: () => ({ getConfig: async () => live,
              listAgents: async () => effectiveAgentsFixture(profile.managedConfig, profile.env.XDG_DATA_HOME) }) as never },
            mcpManager: { ensureAppMcp: async () => ({ summary: {
              matchedServerName: 'agent-teams', connected: true,
            } }) as never },
            collectBehavior: async () => ({ projectBehaviorFingerprint: profile.projectBehaviorFingerprint }) as never,
            resolveScope: async () => profile.profileScope!,
            buildEvidence: () => {
              reachedAuth = true
              return new Promise((resolve, reject) => {
                settle = () => lateReject ? reject(new Error('late secret auth error'))
                  : resolve({ expectedBehaviorFingerprint: input.expectedBehaviorFingerprint } as never)
              })
            },
          })
        }
        const envelope = buildEnvelope('opencode.readiness', {
          projectPath: '/tmp/project', selectedModel: 'openrouter/minimax-m2.5-free',
          requireExecutionProbe: true,
        })
        envelope.timeoutMs = 500
        const result = await executeOpenCodeBridgeCommandEnvelope(envelope)
        expect({ reachedAuth, refreshCalls, result }).toMatchObject({ reachedAuth: true })
        expect(capturedSignal?.aborted).toBe(true)
        expect(result.ok).toBe(false)
        if ('error' in result) expect(result.error.message).toContain('post_probe_refresh')
        expect(executionCalls).toBe(afterExecution ? 1 : 0)
        expect(releases).toBe(1)
        const serializedResult = JSON.stringify(result)
        settle()
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(executionCalls).toBe(afterExecution ? 1 : 0)
        expect(releases).toBe(1)
        expect(JSON.stringify(result)).toBe(serializedResult)
        expect(serializedResult).not.toContain('late secret')
      }
    }
  })

  test('selected execution readiness rejects raw models before host or MCP effects', async () => {
    let effects = 0
    openCodeProvisioningProbe.probeRetainingHost = (async () => {
      effects += 1
      throw new Error('host effect')
    }) as typeof openCodeProvisioningProbe.probeRetainingHost
    Client.prototype.connect = (async () => { effects += 1 }) as typeof Client.prototype.connect

    for (const requireExecutionProbe of [false, true]) {
      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project', selectedModel: 'raw-model', requireExecutionProbe,
      }))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.message).toContain('provider-qualified')
    }
    expect(effects).toBe(0)
  })

  test('execution readiness reports Kiro and Cursor as model-unavailable before side effects', async () => {
    let effects = 0
    openCodeProvisioningProbe.probeRetainingHost = (async () => {
      effects += 1
      throw new Error('host effect')
    }) as typeof openCodeProvisioningProbe.probeRetainingHost
    openCodeExecutionProbe.probeModelOnHost = (async () => {
      effects += 1
      throw new Error('provider effect')
    }) as typeof openCodeExecutionProbe.probeModelOnHost
    openCodeSessionBridge.ensureSession = (async () => {
      effects += 1
      throw new Error('member effect')
    }) as typeof openCodeSessionBridge.ensureSession
    Client.prototype.connect = (async () => { effects += 1 }) as typeof Client.prototype.connect

    for (const providerId of ['kiro', 'cursor-acp']) {
      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project', selectedModel: `${providerId}/near-marker-model`,
        requireExecutionProbe: true,
      }))
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.state).toBe('model_unavailable')
        expect(result.data.launchAllowed).toBe(false)
        expect(result.data.missing).toEqual([
          expect.stringContaining(`extension-bound provider ${providerId}`),
        ])
      }
    }
    expect(effects).toBe(0)
  })

  test('selected readiness without execution proof stays on the retained provider seam', async () => {
    let retainedCalls = 0
    openCodeProvisioningProbe.probe = async () => {
      throw new Error('broad readiness poison path must not run')
    }
    openCodeProvisioningProbe.probeRetainingHost = (async (_projectPath, options) => {
      retainedCalls += 1
      expect(options.selectedModel).toBe('deepinfra/chosen')
      return { snapshot, host: snapshot.host, release: async () => {} }
    }) as typeof openCodeProvisioningProbe.probeRetainingHost
    openCodeExecutionProbe.probeModelOnHost = (async () => {
      throw new Error('model execution must not run')
    }) as typeof openCodeExecutionProbe.probeModelOnHost

    const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.readiness', {
      projectPath: '/tmp/project', selectedModel: 'deepinfra/chosen',
      requireExecutionProbe: false,
    }))
    expect(result.ok).toBe(true)
    expect(retainedCalls).toBe(1)
    if (result.ok) {
      expect(result.data.launchAllowed).toBe(false)
      expect(result.data.executionProof).toBeUndefined()
    }
  })

  test('compatibility mode without execution probe still rejects unknown provider-scoped model ids', async () => {
    mockRequiredMcpTools()
    openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()
    let executionProbeCalled = false
    openCodeExecutionProbe.probeModel = (async () => {
      executionProbeCalled = true
      throw new Error('execution probe should not run')
    }) as typeof openCodeExecutionProbe.probeModel

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/ghost-model',
        requireExecutionProbe: false,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.state).toBe('model_unavailable')
    expect(result.data.launchAllowed).toBe(false)
    expect(result.data.missing[0]).toContain(
      'provider-scoped model "openrouter/ghost-model" was not found in the live provider catalog',
    )
    expect(executionProbeCalled).toBe(false)
  })

  test('compatibility model rejection returns before starting MCP tool proof', async () => {
    openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()
    let connectCalls = 0
    let listToolsCalls = 0
    let executionProbeCalled = false
    ;(Client.prototype.connect as unknown as (...args: unknown[]) => Promise<void>) = async () => {
      connectCalls += 1
      throw new Error('MCP proof should not run for rejected selected models')
    }
    ;(Client.prototype.listTools as unknown as (...args: unknown[]) => Promise<{ tools: Array<{ name: string }> }>) =
      async () => {
        listToolsCalls += 1
        throw new Error('MCP tools/list should not run for rejected selected models')
      }
    openCodeExecutionProbe.probeModel = (async () => {
      executionProbeCalled = true
      throw new Error('execution probe should not run')
    }) as typeof openCodeExecutionProbe.probeModel

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/ghost-model',
        requireExecutionProbe: false,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.state).toBe('model_unavailable')
    expect(result.data.launchAllowed).toBe(false)
    expect(result.data.missing[0]).toContain(
      'provider-scoped model "openrouter/ghost-model" was not found in the live provider catalog',
    )
    expect(connectCalls).toBe(0)
    expect(listToolsCalls).toBe(0)
    expect(executionProbeCalled).toBe(false)
  })

  test('compatibility mode without execution probe rejects selected models from disconnected providers', async () => {
    mockRequiredMcpTools()
    openCodeProvisioningProbe.probe = async () =>
      buildReadinessSnapshot({
        providers: {
          connected: ['opencode'],
          default: {},
        },
      })
    let executionProbeCalled = false
    openCodeExecutionProbe.probeModel = (async () => {
      executionProbeCalled = true
      throw new Error('execution probe should not run')
    }) as typeof openCodeExecutionProbe.probeModel

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        requireExecutionProbe: false,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.state).toBe('not_authenticated')
    expect(result.data.launchAllowed).toBe(false)
    expect(result.data.missing[0]).toContain(
      'OpenCode provider "openrouter" for selected model "openrouter/minimax-m2.5-free" is not connected',
    )
    expect(executionProbeCalled).toBe(false)
  })

  test('compatibility mode without execution probe requires proof for configured authless local models', async () => {
    mockRequiredMcpTools()
    openCodeProvisioningProbe.probe = async () =>
      buildReadinessSnapshot({
        configProviders: {
          providers: [
            {
              id: 'llama.cpp',
              npm: '@ai-sdk/openai-compatible',
              options: { baseURL: 'http://127.0.0.1:8080/v1' },
              models: { 'qwen-test:0.5b': {} },
            },
          ],
          default: {},
        },
        providers: {
          connected: [],
          default: {},
        },
      })
    let executionProbeCalled = false
    openCodeExecutionProbe.probeModel = (async () => {
      executionProbeCalled = true
      throw new Error('execution probe should not run')
    }) as typeof openCodeExecutionProbe.probeModel

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'llama.cpp/qwen-test:0.5b',
        requireExecutionProbe: false,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.state).toBe('not_authenticated')
    expect(result.data.launchAllowed).toBe(false)
    expect(result.data.missing[0]).toContain('requires execution verification')
    expect(executionProbeCalled).toBe(false)
  })

  test('deep readiness verifies configured authless local models with execution probe', async () => {
    mockRequiredMcpTools()
    const provisioningOptions: Array<
      NonNullable<Parameters<typeof openCodeProvisioningProbe.probe>[1]>
    > = []
    openCodeProvisioningProbe.probe = async (_projectPath, options) => {
      provisioningOptions.push(options ?? {})
      return buildReadinessSnapshot({
        configProviders: {
          providers: [
            {
              id: 'llama.cpp',
              npm: '@ai-sdk/openai-compatible',
              options: { baseURL: 'http://127.0.0.1:8080/v1' },
              models: { 'qwen-test:0.5b': {} },
            },
          ],
          default: {},
        },
        providers: {
          connected: [],
          default: {},
        },
      })
    }
    let probedModelId: string | null = null
    let probedDisposeHostOnRelease: boolean | undefined
    let slimProbeCalls = 0
    openCodeExecutionProbe.probeModel = (async () => {
      slimProbeCalls += 1
      throw new Error('readiness proof must stay on the retained host')
    }) as typeof openCodeExecutionProbe.probeModel
    openCodeExecutionProbe.probeModelOnHost = (async input => {
      probedModelId = input.selectedModel
      probedDisposeHostOnRelease = input.disposeHostOnRelease
      return {
        providerId: 'opencode' as const,
        modelId: input.selectedModel,
        observedProviderId: 'llama.cpp',
        observedModelId: 'qwen-test:0.5b',
        probePrompt: 'Output only the single word PONG.',
        expectedOutput: 'PONG',
        outcome: 'available' as const,
        reason: null,
        durationMs: 1,
        rawStatus: 'idle',
        durableState: 'idle',
        latestAssistantText: 'PONG',
        latestAssistantPreview: 'PONG',
        toolCallCount: 0,
        errorCount: 0,
        diagnostics: [],
      }
    }) as typeof openCodeExecutionProbe.probeModelOnHost

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'llama.cpp/qwen-test:0.5b',
        requireExecutionProbe: true,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(probedModelId).toBe('llama.cpp/qwen-test:0.5b')
    expect(probedDisposeHostOnRelease).toBeUndefined()
    expect(slimProbeCalls).toBe(0)
    expect(provisioningOptions).toEqual([{}])
    expect(result.data.state).toBe('ready')
    expect(result.data.launchAllowed).toBe(true)
  })

  test('deep readiness reports auth failures from configured authless local model probes', async () => {
    mockRequiredMcpTools()
    openCodeProvisioningProbe.probe = async () =>
      buildReadinessSnapshot({
        configProviders: {
          providers: [
            {
              id: 'llama.cpp',
              npm: '@ai-sdk/openai-compatible',
              options: { baseURL: 'http://127.0.0.1:8080/v1' },
              models: { 'qwen-test:0.5b': {} },
            },
          ],
          default: {},
        },
        providers: {
          connected: [],
          default: {},
        },
      })
    openCodeExecutionProbe.probeModel = (async input => ({
      providerId: 'opencode' as const,
      modelId: input.selectedModel,
      probePrompt: 'Output only the single word PONG.',
      expectedOutput: 'PONG',
      outcome: 'not_authenticated' as const,
      reason: 'Local server rejected the probe',
      durationMs: 1,
      rawStatus: 'idle',
      durableState: 'idle',
      latestAssistantText: null,
      latestAssistantPreview: null,
      toolCallCount: 0,
      errorCount: 1,
      diagnostics: ['Local server rejected the probe'],
    })) as typeof openCodeExecutionProbe.probeModel

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'llama.cpp/qwen-test:0.5b',
        requireExecutionProbe: true,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.state).toBe('not_authenticated')
    expect(result.data.launchAllowed).toBe(false)
    expect(result.data.missing[0]).toBe('Local server rejected the probe')
  })

  for (const outcome of ['unavailable', 'unknown'] as const) {
    test(`deep readiness reports ${outcome} configured authless local model probes as model unavailable`, async () => {
      mockRequiredMcpTools()
      let provisioningProbeCalls = 0
      openCodeProvisioningProbe.probe = async () => {
        provisioningProbeCalls += 1
        if (outcome === 'unavailable' && provisioningProbeCalls > 1) {
          throw new Error('Terminal model failures must not wait for post-probe refresh')
        }
        return buildReadinessSnapshot({
          configProviders: {
            providers: [
              {
                id: 'llama.cpp',
                npm: '@ai-sdk/openai-compatible',
                options: { baseURL: 'http://127.0.0.1:8080/v1' },
                models: { 'qwen-test:0.5b': {} },
              },
            ],
            default: {},
          },
          providers: {
            connected: [],
            default: {},
          },
        })
      }
      openCodeExecutionProbe.probeModel = (async input => ({
        providerId: 'opencode' as const,
        modelId: input.selectedModel,
        probePrompt: 'Output only the single word PONG.',
        expectedOutput: 'PONG',
        outcome,
        reason: `Local model probe ended as ${outcome}`,
        durationMs: 1,
        rawStatus: 'idle',
        durableState: 'idle',
        latestAssistantText: null,
        latestAssistantPreview: null,
        toolCallCount: 0,
        errorCount: 1,
        diagnostics: [`Local model probe ended as ${outcome}`],
      })) as typeof openCodeExecutionProbe.probeModel

      const result = await executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.readiness', {
          projectPath: '/tmp/project',
          selectedModel: 'llama.cpp/qwen-test:0.5b',
          requireExecutionProbe: true,
        }),
      )

      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      expect(result.data.state).toBe('model_unavailable')
      expect(result.data.launchAllowed).toBe(false)
      expect(result.data.missing[0]).toBe(`Local model probe ended as ${outcome}`)
      expect(provisioningProbeCalls).toBe(1)
    })
  }

  test('deep readiness starts the retained host but skips its model when MCP contract proof fails', async () => {
    ;(Client.prototype.connect as unknown as (...args: unknown[]) => Promise<void>) = async () => {
      throw new Error('Connection closed')
    }
    ;(Client.prototype.listTools as unknown as () => Promise<{ tools: Array<{ name: string }> }>) =
      async () => ({
        tools: [],
      })
    ;(Client.prototype.close as unknown as () => Promise<void>) = async () => {}
    let provisioningProbeCalled = false
    openCodeProvisioningProbe.probe = (async () => {
      provisioningProbeCalled = true
      return buildReadinessSnapshot()
    }) as typeof openCodeProvisioningProbe.probe
    let executionProbeCalled = false
    openCodeExecutionProbe.probeModel = (async () => {
      executionProbeCalled = true
      throw new Error('execution probe should not run when MCP proof already failed')
    }) as typeof openCodeExecutionProbe.probeModel

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'llama.cpp/qwen-test:0.5b',
        requireExecutionProbe: true,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.state).toBe('mcp_unavailable')
    expect(result.data.launchAllowed).toBe(false)
    expect(result.data.hostHealthy).toBe(true)
    expect(result.data.requiredToolsPresent).toBe(false)
    expect(result.data.missing.join('\n')).toContain('direct server contract')
    expect(result.data.diagnostics.join('\n')).toContain('Connection closed')
    expect(result.data.diagnostics.join('\n')).toContain(
      'Agent Teams MCP direct contract tools/list preflight failed',
    )
    expect(provisioningProbeCalled).toBe(true)
    expect(executionProbeCalled).toBe(false)
  })

  test('direct MCP proof includes child stderr when local MCP launch closes', async () => {
    ;(Client.prototype.connect as unknown as (transport: unknown) => Promise<void>) =
      async transport => {
        const stderr = (transport as {
          stderr?: { emit?: (event: 'data', chunk: string) => boolean }
        }).stderr
        stderr?.emit?.('data', 'node: bad option: --appimage-extract-and-run\n')
        throw new Error('Connection closed')
      }
    ;(Client.prototype.listTools as unknown as () => Promise<{ tools: Array<{ name: string }> }>) =
      async () => ({
        tools: [],
      })
    ;(Client.prototype.close as unknown as () => Promise<void>) = async () => {}
    openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'llama.cpp/qwen-test:0.5b',
        requireExecutionProbe: true,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.state).toBe('mcp_unavailable')
    expect(result.data.diagnostics.join('\n')).toContain('Connection closed')
    expect(result.data.diagnostics.join('\n')).toContain('Agent Teams MCP stderr:')
    expect(result.data.diagnostics.join('\n')).toContain('node: bad option')
  })

  test('direct MCP proof does not forward inherited Electron Node env without MCP config env', async () => {
    const previousElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE
    const previousMcpEnvJson = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON
    let capturedEnv: Record<string, string> | undefined
    ;(Client.prototype.connect as unknown as (transport: unknown) => Promise<void>) =
      async transport => {
        capturedEnv = (transport as {
          _serverParams?: { env?: Record<string, string> }
        })._serverParams?.env
      }
    ;(Client.prototype.listTools as unknown as () => Promise<{ tools: Array<{ name: string }> }>) =
      async () => ({
        tools: requiredMockMcpTools(),
      })
    ;(Client.prototype.close as unknown as () => Promise<void>) = async () => {}
    openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()

    try {
      process.env.ELECTRON_RUN_AS_NODE = 'inherited-global-value'
      delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON

      const result = await executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.readiness', {
          projectPath: '/tmp/project',
          selectedModel: 'openrouter/minimax-m2.5-free',
          requireExecutionProbe: false,
        }),
      )

      expect(result.ok).toBe(true)
      expect(capturedEnv?.ELECTRON_RUN_AS_NODE).toBeUndefined()
    } finally {
      if (previousElectronRunAsNode == null) {
        delete process.env.ELECTRON_RUN_AS_NODE
      } else {
        process.env.ELECTRON_RUN_AS_NODE = previousElectronRunAsNode
      }
      if (previousMcpEnvJson == null) {
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON
      } else {
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON = previousMcpEnvJson
      }
    }
  })

  test('compatibility mode without execution probe allows built-in free OpenCode models without connected providers', async () => {
    mockRequiredMcpTools()
    openCodeProvisioningProbe.probe = async () =>
      buildReadinessSnapshot({
        models: ['opencode/big-pickle'],
        modelMetadata: [buildModelMetadata('opencode/big-pickle')],
        configProviders: {
          providers: [],
          default: {},
        },
        providers: {
          connected: [],
          default: {},
        },
      })
    let executionProbeCalled = false
    openCodeExecutionProbe.probeModel = (async () => {
      executionProbeCalled = true
      throw new Error('execution probe should not run')
    }) as typeof openCodeExecutionProbe.probeModel

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'opencode/big-pickle',
        requireExecutionProbe: false,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.state).toBe('model_unavailable')
    expect(result.data.launchAllowed).toBe(false)
    expect(result.data.modelId).toBe('opencode/big-pickle')
    expect(executionProbeCalled).toBe(false)
  })

  test('compatibility mode without execution probe rejects built-in OpenCode models without free metadata', async () => {
    mockRequiredMcpTools()
    openCodeProvisioningProbe.probe = async () =>
      buildReadinessSnapshot({
        models: ['opencode/big-pickle'],
        modelMetadata: [],
        configProviders: {
          providers: [],
          default: {},
        },
        providers: {
          connected: [],
          default: {},
        },
      })
    let executionProbeCalled = false
    openCodeExecutionProbe.probeModel = (async () => {
      executionProbeCalled = true
      throw new Error('execution probe should not run')
    }) as typeof openCodeExecutionProbe.probeModel

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'opencode/big-pickle',
        requireExecutionProbe: false,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.state).toBe('not_authenticated')
    expect(result.data.launchAllowed).toBe(false)
    expect(result.data.missing[0]).toContain(
      'OpenCode provider "opencode" for selected model "opencode/big-pickle" is not connected',
    )
    expect(executionProbeCalled).toBe(false)
  })

  test('compatibility mode without execution probe rejects paid built-in OpenCode models without connected providers', async () => {
    mockRequiredMcpTools()
    openCodeProvisioningProbe.probe = async () =>
      buildReadinessSnapshot({
        models: ['opencode/big-pickle'],
        modelMetadata: [buildModelMetadata('opencode/big-pickle', { free: false })],
        configProviders: {
          providers: [],
          default: {},
        },
        providers: {
          connected: [],
          default: {},
        },
      })

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'opencode/big-pickle',
        requireExecutionProbe: false,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.state).toBe('not_authenticated')
    expect(result.data.launchAllowed).toBe(false)
    expect(result.data.missing[0]).toContain(
      'OpenCode provider "opencode" for selected model "opencode/big-pickle" is not connected',
    )
  })

  test('compatibility mode without a selected model treats built-in free OpenCode models as launch providers', async () => {
    mockRequiredMcpTools()
    openCodeProvisioningProbe.probe = async () =>
      buildReadinessSnapshot({
        models: ['opencode/big-pickle'],
        modelMetadata: [buildModelMetadata('opencode/big-pickle')],
        configProviders: {
          providers: [],
          default: {},
        },
        providers: {
          connected: [],
          default: {},
        },
      })

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        requireExecutionProbe: false,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.state).toBe('ready')
    expect(result.data.launchAllowed).toBe(true)
    expect(result.data.modelId).toBe(null)
  })

  test('compatibility provider rejection returns before starting MCP tool proof', async () => {
    openCodeProvisioningProbe.probe = async () =>
      buildReadinessSnapshot({
        providers: {
          connected: ['opencode'],
          default: {},
        },
      })
    let connectCalls = 0
    let listToolsCalls = 0
    let executionProbeCalled = false
    ;(Client.prototype.connect as unknown as (...args: unknown[]) => Promise<void>) = async () => {
      connectCalls += 1
      throw new Error('MCP proof should not run for disconnected model providers')
    }
    ;(Client.prototype.listTools as unknown as (...args: unknown[]) => Promise<{ tools: Array<{ name: string }> }>) =
      async () => {
        listToolsCalls += 1
        throw new Error('MCP tools/list should not run for disconnected model providers')
      }
    openCodeExecutionProbe.probeModel = (async () => {
      executionProbeCalled = true
      throw new Error('execution probe should not run')
    }) as typeof openCodeExecutionProbe.probeModel

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        requireExecutionProbe: false,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.state).toBe('not_authenticated')
    expect(result.data.launchAllowed).toBe(false)
    expect(result.data.missing[0]).toContain(
      'OpenCode provider "openrouter" for selected model "openrouter/minimax-m2.5-free" is not connected',
    )
    expect(connectCalls).toBe(0)
    expect(listToolsCalls).toBe(0)
    expect(executionProbeCalled).toBe(false)
  })

  test('qualified non-proof readiness stays conservative when raw model ids are ambiguous', async () => {
    mockRequiredMcpTools()
    openCodeProvisioningProbe.probe = async () =>
      buildReadinessSnapshot({
        configProviders: {
          providers: [
            {
              id: 'openrouter',
              models: {
                'minimax-m2.5-free': {},
              },
            },
            {
              id: 'opencode',
              models: {
                'minimax-m2.5-free': {},
              },
            },
          ],
          default: {},
        },
        providers: {
          connected: ['openrouter', 'opencode'],
          default: {},
        },
      })

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        requireExecutionProbe: false,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.state).toBe('model_unavailable')
    expect(result.data.launchAllowed).toBe(false)
    expect(result.data.missing[0]).toContain('execution proof was not requested')
  })

  test('compatibility mode without a selected model ignores unrelated provider defaults', async () => {
    mockRequiredMcpTools()
    openCodeProvisioningProbe.probe = async () =>
      buildReadinessSnapshot({
        providers: {
          connected: ['openrouter'],
          default: {
            google: 'gemini-3-pro-preview',
          },
        },
      })
    let executionProbeCalled = false
    openCodeExecutionProbe.probeModel = (async () => {
      executionProbeCalled = true
      throw new Error('execution probe should not run')
    }) as typeof openCodeExecutionProbe.probeModel

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        requireExecutionProbe: false,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.state).toBe('ready')
    expect(result.data.launchAllowed).toBe(true)
    expect(result.data.modelId).toBe(null)
    expect(executionProbeCalled).toBe(false)
  })

  test('deep readiness rejects a raw model before provisioning or execution', async () => {
    let sideEffects = 0
    openCodeProvisioningProbe.probe = async () => { sideEffects += 1; return snapshot }
    openCodeExecutionProbe.probeModel = (async () => {
      sideEffects += 1
      throw new Error('must not execute')
    }) as typeof openCodeExecutionProbe.probeModel
    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'raw-model',
        requireExecutionProbe: true,
      }),
    )

    expect(result.ok).toBe(false)
    expect(sideEffects).toBe(0)
  })

  test('readiness fails when app MCP message_send is missing', async () => {
    ;(Client.prototype.connect as unknown as (...args: unknown[]) => Promise<void>) = async () => {}
    ;(Client.prototype.listTools as unknown as (...args: unknown[]) => Promise<{ tools: Array<{ name: string }> }>) =
      async () => ({
        tools: requiredMockMcpTools().filter(tool => tool.name !== 'message_send'),
      })
    ;(Client.prototype.close as unknown as () => Promise<void>) = async () => {}
    openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        requireExecutionProbe: false,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.state).toBe('mcp_unavailable')
    expect(result.data.launchAllowed).toBe(false)
    expect(result.data.missing.join('\n')).toContain('agent-teams_message_send')
    expect(result.data.diagnostics.join('\n')).toContain('agent-teams_message_send')
  })

  test('readiness does not require legacy OpenCode bootstrap MCP tools', async () => {
    ;(Client.prototype.connect as unknown as (...args: unknown[]) => Promise<void>) = async () => {}
    ;(Client.prototype.listTools as unknown as (...args: unknown[]) => Promise<{ tools: Array<{ name: string }> }>) =
      async () => ({
        tools: requiredMockMcpTools().filter(tool =>
          tool.name !== 'runtime_bootstrap_checkin' && tool.name !== 'member_briefing'
        ),
      })
    ;(Client.prototype.close as unknown as () => Promise<void>) = async () => {}
    openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        requireExecutionProbe: false,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.state).toBe('model_unavailable')
    expect(result.data.launchAllowed).toBe(false)
    expect(result.data.requiredToolsPresent).toBe(true)
    expect(result.data.missing.join('\n')).not.toContain('runtime_bootstrap_checkin')
    expect(result.data.missing.join('\n')).not.toContain('member_briefing')
  })

  test('direct MCP proof compares plain names but readiness evidence emits canonical OpenCode ids', async () => {
    mockRequiredMcpTools()
    openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        requireExecutionProbe: false,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.requiredToolsPresent).toBe(true)
    expect(result.data.evidence.observedMcpTools).toContain('agent-teams_message_send')
    expect(result.data.evidence.observedMcpTools).toContain('agent-teams_member_briefing')
    expect(result.data.evidence.observedMcpTools).toContain('agent-teams_cross_team_send')
    expect(result.data.evidence.observedMcpTools).not.toContain('message_send')
  })

  test('direct MCP proof keeps readiness bounded when MCP client close hangs', async () => {
    ;(Client.prototype.connect as unknown as (...args: unknown[]) => Promise<void>) = async () => {}
    ;(Client.prototype.listTools as unknown as (...args: unknown[]) => Promise<{ tools: Array<{ name: string }> }>) =
      async () => ({
        tools: requiredMockMcpTools(),
      })
    ;(Client.prototype.close as unknown as () => Promise<void>) = async () =>
      new Promise<void>(() => {})
    openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()

    const startedAt = Date.now()
    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        requireExecutionProbe: false,
      }),
    )

    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.state).toBe('model_unavailable')
    expect(result.data.launchAllowed).toBe(false)
    expect(result.data.requiredToolsPresent).toBe(true)
  })

  test('direct MCP proof keeps default timeout short except for source MCP launch configs', () => {
    expect(__getAppMcpPreflightTimeoutMsForTests({
      source: 'env-override',
      config: {
        type: 'remote',
        url: 'http://127.0.0.1:3210/mcp',
        enabled: true,
        timeout: 60_000,
        oauth: false,
      },
    })).toBe(45_000)

    expect(__getAppMcpPreflightTimeoutMsForTests({
      source: 'workspace-dist',
      config: {
        type: 'local',
        command: [process.execPath, '/repo/mcp-server/dist/index.js'],
        environment: {},
        enabled: true,
        timeout: 60_000,
      },
    })).toBe(45_000)

    expect(__getAppMcpPreflightTimeoutMsForTests({
      source: 'env-override',
      config: {
        type: 'local',
        command: ['/repo/node_modules/.bin/tsx', '/repo/mcp-server/src/index.ts'],
        environment: {},
        enabled: true,
        timeout: 60_000,
      },
    })).toBe(90_000)

    expect(__getAppMcpPreflightTimeoutMsForTests({
      source: 'env-override',
      config: {
        type: 'local',
        command: [process.execPath, '/repo/mcp-server/src/index.ts'],
        environment: {},
        enabled: true,
        timeout: 60_000,
      },
    })).toBe(90_000)
  })

  test('direct MCP proof timeout override is bounded', () => {
    const previous = process.env.AGENT_TEAMS_OPENCODE_MCP_PREFLIGHT_TIMEOUT_MS
    const launchConfig = {
      source: 'workspace-dist' as const,
      config: {
        type: 'local' as const,
        command: [process.execPath, '/repo/mcp-server/dist/index.js'],
        environment: {},
        enabled: true,
        timeout: 60_000,
      },
    }

    try {
      process.env.AGENT_TEAMS_OPENCODE_MCP_PREFLIGHT_TIMEOUT_MS = '12'
      expect(__getAppMcpPreflightTimeoutMsForTests(launchConfig)).toBe(12)

      process.env.AGENT_TEAMS_OPENCODE_MCP_PREFLIGHT_TIMEOUT_MS = '999999'
      expect(__getAppMcpPreflightTimeoutMsForTests(launchConfig)).toBe(180_000)

      process.env.AGENT_TEAMS_OPENCODE_MCP_PREFLIGHT_TIMEOUT_MS = '0'
      expect(__getAppMcpPreflightTimeoutMsForTests(launchConfig)).toBe(45_000)
    } finally {
      if (previous == null) {
        delete process.env.AGENT_TEAMS_OPENCODE_MCP_PREFLIGHT_TIMEOUT_MS
      } else {
        process.env.AGENT_TEAMS_OPENCODE_MCP_PREFLIGHT_TIMEOUT_MS = previous
      }
    }
  })

  test('direct MCP proof does not accept proxy-prefixed plain message_send as Agent Teams proof', async () => {
    ;(Client.prototype.connect as unknown as (...args: unknown[]) => Promise<void>) = async () => {}
    ;(Client.prototype.listTools as unknown as (...args: unknown[]) => Promise<{ tools: Array<{ name: string }> }>) =
      async () => ({
        tools: requiredMockMcpTools().map(tool =>
          tool.name === 'message_send' ? { name: 'proxy_message_send' } : tool
        ),
      })
    ;(Client.prototype.close as unknown as () => Promise<void>) = async () => {}
    openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        requireExecutionProbe: false,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.state).toBe('mcp_unavailable')
    expect(result.data.launchAllowed).toBe(false)
    expect(result.data.missing.join('\n')).toContain('agent-teams_message_send')
  })

  test('reuses a successful MCP tool proof across repeated readiness checks', async () => {
    let connectCalls = 0
    let listToolsCalls = 0
    ;(Client.prototype.connect as unknown as (...args: unknown[]) => Promise<void>) = async () => {
      connectCalls += 1
    }
    ;(Client.prototype.listTools as unknown as (...args: unknown[]) => Promise<{ tools: Array<{ name: string }> }>) =
      async () => {
        listToolsCalls += 1
        return {
          tools: requiredMockMcpTools(),
        }
      }
    ;(Client.prototype.close as unknown as () => Promise<void>) = async () => {}
    openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()

    const firstResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        requireExecutionProbe: false,
      }),
    )
    const secondResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        requireExecutionProbe: false,
      }),
    )

    expect(firstResult.ok).toBe(true)
    expect(secondResult.ok).toBe(true)
    expect(connectCalls).toBe(1)
    expect(listToolsCalls).toBe(1)
  })

  test('reuses a persisted MCP tool proof after bridge process memory reset', async () => {
    let connectCalls = 0
    let listToolsCalls = 0
    ;(Client.prototype.connect as unknown as (...args: unknown[]) => Promise<void>) = async () => {
      connectCalls += 1
    }
    ;(Client.prototype.listTools as unknown as (...args: unknown[]) => Promise<{ tools: Array<{ name: string }> }>) =
      async () => {
        listToolsCalls += 1
        return {
          tools: requiredMockMcpTools(),
        }
      }
    ;(Client.prototype.close as unknown as () => Promise<void>) = async () => {}
    openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()

    const firstResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        requireExecutionProbe: false,
      }),
    )

    expect(firstResult.ok).toBe(true)
    expect(connectCalls).toBe(1)
    expect(listToolsCalls).toBe(1)

    __resetAppMcpToolProofCacheForTests()
    ;(Client.prototype.connect as unknown as (...args: unknown[]) => Promise<void>) = async () => {
      throw new Error('direct MCP proof should come from persisted cache')
    }
    ;(Client.prototype.listTools as unknown as (...args: unknown[]) => Promise<{ tools: Array<{ name: string }> }>) =
      async () => {
        throw new Error('direct MCP proof should come from persisted cache')
      }

    const secondResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        requireExecutionProbe: false,
      }),
    )

    expect(secondResult.ok).toBe(true)
    if (!secondResult.ok) {
      return
    }
    expect(secondResult.data.state).toBe('model_unavailable')
    expect(secondResult.data.diagnostics).toContain(
      'opencode_app_mcp_tool_proof_persisted_cache_hit',
    )
  })

  test('dedupes concurrent MCP tool proof requests for the same launch config', async () => {
    const deferredTools = createDeferred<{ tools: Array<{ name: string }> }>()
    let connectCalls = 0
    let listToolsCalls = 0
    ;(Client.prototype.connect as unknown as (...args: unknown[]) => Promise<void>) = async () => {
      connectCalls += 1
    }
    ;(Client.prototype.listTools as unknown as (...args: unknown[]) => Promise<{ tools: Array<{ name: string }> }>) =
      async () => {
        listToolsCalls += 1
        return deferredTools.promise
      }
    ;(Client.prototype.close as unknown as () => Promise<void>) = async () => {}
    openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()

    const firstPromise = executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        requireExecutionProbe: false,
      }),
    )
    const secondPromise = executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        requireExecutionProbe: false,
      }),
    )

    deferredTools.resolve({
      tools: requiredMockMcpTools(),
    })

    const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise])
    expect(firstResult.ok).toBe(true)
    expect(secondResult.ok).toBe(true)
    expect(connectCalls).toBe(1)
    expect(listToolsCalls).toBe(1)
  })

  test('launches only the addressed lane and forwards laneId into ensureSession', async () => {
    const ensureInputs: Array<Record<string, unknown>> = []
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push(input as unknown as Record<string, unknown>)
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      summary: buildReconcileSummary({ sessionId: record.opencodeSessionId }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-1',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'alice', role: 'Developer', prompt: 'Join the team' }],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(ensureInputs).toHaveLength(1)
    expect(ensureInputs[0]?.laneId).toBe('secondary:opencode:alice')
    expect(ensureInputs[0]?.preparedProfile).toMatchObject({
      profileRootKey: snapshot.profile?.profileRootKey,
      managedConfigFingerprint: snapshot.profile?.managedConfigFingerprint,
    })
    expect(
      (result.data as { members: Record<string, { runtimePid?: number }> }).members.alice?.runtimePid,
    ).toBe(123)
    expect(Object.keys((result.data as { members: Record<string, unknown> }).members)).toEqual([
      'alice',
    ])
  })

  test('launch does not require legacy OpenCode bootstrap MCP tools in direct tool proof', async () => {
    ;(Client.prototype.connect as unknown as (...args: unknown[]) => Promise<void>) = async () => {}
    ;(Client.prototype.listTools as unknown as (...args: unknown[]) => Promise<{ tools: Array<{ name: string }> }>) =
      async () => ({
        tools: requiredMockMcpTools().filter(tool =>
          tool.name !== 'runtime_bootstrap_checkin' && tool.name !== 'member_briefing'
        ),
      })
    ;(Client.prototype.close as unknown as () => Promise<void>) = async () => {}
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionBridge.ensureSession = (async input =>
      buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
      })) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      summary: buildReconcileSummary({ sessionId: record.opencodeSessionId }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-no-legacy-bootstrap-tools',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'alice', role: 'Developer', prompt: 'Join the team' }],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.teamLaunchState).toBe('launching')
    expect(result.data.members.alice?.launchState).toBe('created')
    expect(result.data.members.alice?.bootstrapMode).toBe('app_managed_context')
    const diagnosticText = result.data.diagnostics.map(diagnostic => diagnostic.message).join('\n')
    expect(diagnosticText).not.toContain('runtime_bootstrap_checkin')
    expect(diagnosticText).not.toContain('member_briefing')
  })

  test('keeps the launch provisioning host retained until launch finishes', async () => {
    let releaseCalls = 0
    const ownershipEvents: string[] = []
    openCodeProvisioningProbe.probe = async () => {
      throw new Error('unretained probe should not be used for launch')
    }
    openCodeProvisioningProbe.probeRetainingHost = (async () => ({
      snapshot,
      host: snapshot.host,
      release: async () => {
        releaseCalls += 1
        ownershipEvents.push('release')
      },
    })) as typeof openCodeProvisioningProbe.probeRetainingHost
    openCodeSessionBridge.ensureSession = (async input => {
      ownershipEvents.push('materialize')
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      summary: buildReconcileSummary({ sessionId: record.opencodeSessionId }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-retained-host',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'alice', role: 'Developer', prompt: 'Join the team' }],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'opencode_launch_member_timing' }),
        expect.objectContaining({ code: 'opencode_launch_total_timing' }),
      ]),
    )
    expect(releaseCalls).toBe(1)
    expect(ownershipEvents).toEqual(['materialize', 'release'])
  })

  test('releases the attempt-owned retained host once when App MCP is unavailable', async () => {
    let releaseCalls = 0
    let memberCalls = 0
    openCodeProvisioningProbe.probeRetainingHost = (async () => ({
      snapshot: {
        ...snapshot,
        appMcp: {
          serverName: 'agent-teams',
          matchedServerName: 'agent-teams',
          status: 'unavailable',
          connected: false,
          launchSource: null,
          availableServerNames: [],
          diagnostics: ['fake unavailable App MCP'],
        },
      },
      host: snapshot.host,
      release: async () => { releaseCalls += 1 },
    })) as typeof openCodeProvisioningProbe.probeRetainingHost
    openCodeSessionBridge.materializeSessionOnHost = (async () => {
      memberCalls += 1
      throw new Error('member work must not run')
    }) as typeof openCodeSessionBridge.materializeSessionOnHost

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-app-mcp-unavailable',
        laneId: 'primary',
        teamId: 'team-a',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'alice' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('MCP retained connection')
    expect(memberCalls).toBe(0)
    expect(releaseCalls).toBe(1)
  })

  test('releases the attempt-owned retained host once on capability precondition failure', async () => {
    let releaseCalls = 0
    let proofCalls = 0
    openCodeProvisioningProbe.probeRetainingHost = (async () => ({
      snapshot,
      host: snapshot.host,
      release: async () => { releaseCalls += 1 },
    })) as typeof openCodeProvisioningProbe.probeRetainingHost
    openCodeExecutionProbe.probeModelOnHost = (async () => {
      proofCalls += 1
      throw new Error('proof must not run')
    }) as typeof openCodeExecutionProbe.probeModelOnHost
    const body = {
      runId: 'run-capability-failure',
      laneId: 'primary',
      teamId: 'team-a',
      selectedModel: 'openrouter/minimax-m2.5-free',
      members: [{ name: 'alice' }],
      preconditions: {
        handshakeIdentityHash: 'handshake-test',
        laneId: 'primary',
        expectedRunId: 'run-capability-failure',
        expectedCapabilitySnapshotId: 'opencode:stale-capability',
        expectedBehaviorFingerprint,
        expectedManifestHighWatermark: 0,
        commandLeaseId: 'lease-capability-failure',
        idempotencyKey: 'launch:capability-failure',
      },
    }

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', body),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('capability snapshot precondition mismatch')
    expect(proofCalls).toBe(0)
    expect(releaseCalls).toBe(1)
  })

  test('strict launch preserves a commit, stops on unknown, and continues only the missing member', async () => {
    const records = new Map<string, OpenCodeSessionRecord>()
    const events: string[] = []
    const probeOptions: Array<Record<string, unknown>> = []
    let bobUnknown = true
    openCodeProvisioningProbe.probeRetainingHost = (async (_projectPath, options) => {
      probeOptions.push(options as Record<string, unknown>)
      return { snapshot, host: snapshot.host, release: async () => {} }
    }) as typeof openCodeProvisioningProbe.probeRetainingHost
    openCodeSessionStore.get = (async (_teamId, _laneId, memberName) =>
      records.get(memberName ?? _laneId) ?? null) as typeof openCodeSessionStore.get
    openCodeSessionStore.observeMaterialization = (async identity => {
      const record = records.get(identity.memberName) ?? null
      return record ? { record, ownerToken: null } : null
    }) as typeof openCodeSessionStore.observeMaterialization
    openCodeSessionStore.upsert = (async record => {
      records.set(record.memberName, record)
      return 'updated'
    }) as typeof openCodeSessionStore.upsert
    openCodeExecutionProbe.probeModelOnHost = (async input => {
      events.push(`proof:${input.host.hostKey}`)
      return {
        providerId: 'opencode',
        modelId: input.selectedModel,
        observedProviderId: 'openrouter',
        observedModelId: 'minimax-m2.5-free',
        probePrompt: input.prompt ?? '',
        expectedOutput: input.expectedOutput ?? '',
        outcome: 'available',
        reason: null,
        durationMs: 1,
        rawStatus: 'idle',
        durableState: 'idle',
        latestAssistantText: input.expectedOutput ?? null,
        latestAssistantPreview: input.expectedOutput ?? null,
        toolCallCount: 0,
        errorCount: 0,
        diagnostics: [],
        verifiedAt: '2026-04-21T12:00:00.000Z',
      }
    }) as typeof openCodeExecutionProbe.probeModelOnHost
    openCodeSessionBridge.materializeSessionOnHost = (async input => {
      events.push(`member:${input.memberName}:${input.host.hostKey}`)
      if (input.memberName === 'bob' && bobUnknown) {
        bobUnknown = false
        throw new Error(`transport result unknown authorization=secret ${'x'.repeat(600)}`)
      }
      return {
        ownerToken: { attemptId: 'test-owner', sessionId: '', version: 1 },
        created: true,
        record: buildRecord({
          laneId: input.laneId,
          memberName: input.memberName,
          runId: input.runId,
          selectedModel: input.selectedModel,
          hostKey: input.host.hostKey,
          profileScope: input.host.profile.profileScope ?? null,
          toolApprovalMode: input.toolApprovalMode ?? 'auto',
          resolvedBehaviorFingerprint: input.host.resolvedConfigFingerprint,
          projectBehaviorFingerprint: input.host.projectBehaviorFingerprint,
          managedConfigFingerprint: input.host.profile.managedConfigFingerprint,
          expectedBehaviorFingerprint: input.expectedBehaviorFingerprint,
          opencodeSessionId: `session-${input.memberName}`,
        }),
      }
    }) as typeof openCodeSessionBridge.materializeSessionOnHost
    openCodeSessionBridge.injectAppManagedBootstrapContext = (async (record, input) => ({
      messageID: input.messageID,
      runtimeSessionId: record.opencodeSessionId,
      contextHash: input.contextHash,
      briefingHash: input.briefingHash,
      injectionVerifiedAt: '2026-04-21T12:00:00.000Z',
      alreadyPresent: false,
    })) as typeof openCodeSessionBridge.injectAppManagedBootstrapContext
    const body = {
      runId: 'run-strict-partial',
      laneId: 'primary',
      teamId: 'team-a',
      teamName: 'team-a',
      projectPath: '/tmp/project',
      selectedModel: 'openrouter/minimax-m2.5-free',
      members: [
        { name: 'alice', prompt: 'Alice join' },
        { name: 'bob', prompt: 'Bob join' },
      ],
    }

    const first = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', body),
    )
    expect(first.ok).toBe(true)
    expect(Object.keys(first.data.members)).toEqual(['alice'])
    expect(events).toEqual([
      'proof:host-key',
      'member:alice:host-key',
      'member:bob:host-key',
    ])
    expect(probeOptions[0]).toMatchObject({
      selectedModel: 'openrouter/minimax-m2.5-free',
      leaseId: 'lease-test',
    })
    expect((probeOptions[0]?.phaseContext as { signal?: unknown })?.signal).toBeInstanceOf(
      AbortSignal,
    )
    const publicUnknown = first.data.diagnostics.find(
      diagnostic => diagnostic.code === 'opencode_strict_launch_unknown',
    )?.message ?? ''
    expect(publicUnknown).not.toContain('secret')
    expect(publicUnknown.length).toBeLessThanOrEqual(512)

    events.length = 0
    const second = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', body),
    )
    expect(second.ok).toBe(true)
    expect(Object.keys(second.data.members)).toEqual(['alice', 'bob'])
    expect(events).toEqual(['proof:host-key', 'member:bob:host-key'])
  })

  test('reports rejected preflight instead of waiting for an unreached launch stage', async () => {
    openCodeProvisioningProbe.probeRetainingHost = (async () => ({
      snapshot, host: snapshot.host, release: async () => {},
    })) as typeof openCodeProvisioningProbe.probeRetainingHost
    await withManualTimers(async () => {
      const envelope = buildEnvelope('opencode.launchTeam', {
        runId: 'run-rejected-preflight', laneId: 'primary', teamId: 'team-a',
        selectedModel: 'openrouter/minimax-m2.5-free', members: [{ name: 'alice' }],
      })
      ;(envelope.body.preconditions as Record<string, unknown>).expectedBehaviorFingerprint =
        '0'.repeat(64)
      const command = executeOpenCodeBridgeCommandEnvelope(envelope)
      await expect(waitForCommandStage(
        createDeferred<void>().promise, command, 'bootstrap injection',
      )).rejects.toThrow(
        'Command settled before bootstrap injection: OpenCode strict launch behavior precondition mismatch',
      )
    })
  })

  test('waits for tracked cancellation cleanup before bounded owner release', async () => {
    const realNow = Date.now
    const originalReleaseMaterializationOwner = openCodeSessionStore.releaseMaterializationOwner
    const originalMarkStaleIfSession = openCodeSessionStore.markStaleIfSession
    const originalDeleteIfSession = openCodeSessionStore.deleteIfSession
    let now = 1_000
    Date.now = () => now
    try {
      await withManualTimers(async timers => {
        const releaseStarted = createDeferred<void>()
        const hostReleased = createDeferred<void>()
        const injectionStarted = createDeferred<void>()
        const cancellationCleanupStarted = createDeferred<void>()
        const cancellationCleanupCompleted = createDeferred<void>()
        const ownerReleaseCompleted = createDeferred<boolean>()
        let materializeCalls = 0
        let hostReleaseCalls = 0
        let ownerReleaseCalls = 0
        let sessionReleaseCalls = 0
        openCodeProvisioningProbe.probeRetainingHost = (async () => ({
          snapshot,
          host: snapshot.host,
          release: async () => { hostReleaseCalls += 1; hostReleased.resolve() },
        })) as typeof openCodeProvisioningProbe.probeRetainingHost
        openCodeSessionStore.get = (async () => null) as typeof openCodeSessionStore.get
        openCodeSessionBridge.materializeSessionOnHost = (async input => {
          materializeCalls += 1
          return {
            ownerToken: { attemptId: 'test-owner', sessionId: '', version: 1 },
            created: true,
            record: buildRecord({
              memberName: input.memberName,
              opencodeSessionId: 'session-owner-release',
              expectedBehaviorFingerprint: input.expectedBehaviorFingerprint,
            }),
          }
        }) as typeof openCodeSessionBridge.materializeSessionOnHost
        openCodeSessionBridge.injectAppManagedBootstrapContext = ((record, input) => {
          injectionStarted.resolve()
          return new Promise<never>((_resolve, reject) => {
            const cancel = () => {
              cancellationCleanupStarted.resolve()
              void cancellationCleanupCompleted.promise.then(() => reject(input.signal.reason))
            }
            if (input.signal.aborted) cancel()
            else input.signal.addEventListener('abort', cancel, { once: true })
          })
        }) as typeof openCodeSessionBridge.injectAppManagedBootstrapContext
        openCodeSessionStore.markStaleIfSession = (async record => ({
          ...record, staleReason: 'launch_failed',
        })) as typeof openCodeSessionStore.markStaleIfSession
        openCodeSessionStore.deleteIfSession = (async () => true) as
          typeof openCodeSessionStore.deleteIfSession
        openCodeSessionBridge.releaseSession = (async () => {
          sessionReleaseCalls += 1
        }) as typeof openCodeSessionBridge.releaseSession
        openCodeSessionStore.releaseMaterializationOwner = (async () => {
          ownerReleaseCalls += 1
          now = 1_800
          releaseStarted.resolve()
          return ownerReleaseCompleted.promise
        }) as typeof openCodeSessionStore.releaseMaterializationOwner

        const envelope = buildEnvelope('opencode.launchTeam', {
          runId: 'run-owner-release-deadline', laneId: 'primary', teamId: 'team-a',
          selectedModel: 'openrouter/minimax-m2.5-free', members: [{ name: 'alice' }],
        })
        envelope.timeoutMs = 1_000
        const resultPromise = executeOpenCodeBridgeCommandEnvelope(envelope)
        await waitForCommandStage(injectionStarted.promise, resultPromise, 'bootstrap injection')
        const workTimer = timers.find(timer => !timer.cancelled && timer.timeoutMs === 750)
        expect(workTimer).toBeDefined()
        now = 1_750
        workTimer!.callback()
        await Promise.all([hostReleased.promise, cancellationCleanupStarted.promise])
        expect(ownerReleaseCalls).toBe(0)
        cancellationCleanupCompleted.resolve()
        await releaseStarted.promise

        const ownerReleaseTimer = [...timers].reverse().find(timer =>
          !timer.cancelled && timer.timeoutMs < envelope.timeoutMs)
        expect(ownerReleaseTimer).toBeDefined()
        expect(ownerReleaseTimer!.timeoutMs).toBeGreaterThan(0)
        expect(ownerReleaseTimer!.timeoutMs).toBeLessThanOrEqual(750)
        now = 2_000
        ownerReleaseTimer!.callback()
        const result = await resultPromise

        expect(result.ok).toBe(false)
        expect(materializeCalls).toBe(1)
        expect(hostReleaseCalls).toBe(1)
        expect(ownerReleaseCalls).toBe(1)
        expect(sessionReleaseCalls).toBe(1)

        let drained = false
        const drain = openCodeSessionStore.drainPendingLateLockReleases().then(() => {
          drained = true
        })
        await Promise.resolve()
        expect(drained).toBe(false)
        ownerReleaseCompleted.resolve(true)
        await drain
        expect(drained).toBe(true)
      })
    } finally {
      Date.now = realNow
      openCodeSessionStore.releaseMaterializationOwner = originalReleaseMaterializationOwner
      openCodeSessionStore.markStaleIfSession = originalMarkStaleIfSession
      openCodeSessionStore.deleteIfSession = originalDeleteIfSession
    }
  })

  test('refreshes authority after MCP readiness and cleans only the uncommitted attempt member', async () => {
    const events: string[] = []
    let authorityCurrent = true
    const originalMarkStaleIfSession = openCodeSessionStore.markStaleIfSession
    const originalDeleteIfSession = openCodeSessionStore.deleteIfSession
    try {
      openCodeProvisioningProbe.probeRetainingHost = (async () => ({
        snapshot, host: snapshot.host, release: async () => {},
      })) as typeof openCodeProvisioningProbe.probeRetainingHost
      openCodeProvisioningProbe.refreshSelectedProfileAuthority = (async () =>
        authorityCurrent ? snapshot.profile! : null
      ) as typeof openCodeProvisioningProbe.refreshSelectedProfileAuthority
      openCodeSessionBridge.materializeSessionOnHost = (async input => {
        events.push(`materialize:${input.memberName}`)
        return {
          ownerToken: { attemptId: 'test-owner', sessionId: '', version: 1 },
          created: true,
          record: buildRecord({
            memberName: input.memberName,
            opencodeSessionId: `session-${input.memberName}`,
            expectedBehaviorFingerprint: input.expectedBehaviorFingerprint,
          }),
        }
      }) as typeof openCodeSessionBridge.materializeSessionOnHost
      openCodeSessionBridge.ensureSessionAppMcpReady = (async record => {
        events.push(`mcp:${record.memberName}`)
        authorityCurrent = false
        return { ok: true, status: 'present', connected: true, runtimePid: 123, diagnostics: [] }
      }) as typeof openCodeSessionBridge.ensureSessionAppMcpReady
      openCodeSessionBridge.injectAppManagedBootstrapContext = (async () => {
        events.push('bootstrap')
        throw new Error('bootstrap must be fenced after stale MCP readiness')
      }) as typeof openCodeSessionBridge.injectAppManagedBootstrapContext
      openCodeSessionStore.upsert = (async () => {
        events.push('publish')
        return 'updated'
      }) as typeof openCodeSessionStore.upsert
      openCodeSessionStore.markStaleIfSession = (async record => {
        events.push(`cleanup-stale:${record.memberName}`)
        return record as OpenCodeSessionRecord
      }) as typeof openCodeSessionStore.markStaleIfSession
      openCodeSessionStore.deleteIfSession = (async record => {
        events.push(`cleanup-delete:${record.memberName}`)
        return true
      }) as typeof openCodeSessionStore.deleteIfSession
      openCodeSessionBridge.releaseSession = (async record => {
        events.push(`cleanup-release:${record.memberName}`)
      }) as typeof openCodeSessionBridge.releaseSession

      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.launchTeam', {
        runId: 'run-authority-mutated-during-mcp', laneId: 'primary', teamId: 'team-a',
        selectedModel: 'openrouter/minimax-m2.5-free', members: [{ name: 'alice' }],
      }))

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.message).toContain('changed before bootstrap')
      // No cleanup-delete: strict launch can resume the known session while
      // delivery remains fenced until bootstrap succeeds.
      expect(events).toEqual([
        'materialize:alice', 'mcp:alice', 'cleanup-stale:alice',
        'cleanup-release:alice',
      ])
    } finally {
      openCodeSessionStore.markStaleIfSession = originalMarkStaleIfSession
      openCodeSessionStore.deleteIfSession = originalDeleteIfSession
    }
  })

  test('creates zero members when frozen MCP authority mismatches after ambient mutation', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeProvisioningProbe.refreshSelectedProfileAuthority = (async () => null) as
      typeof openCodeProvisioningProbe.refreshSelectedProfileAuthority
    let memberCreations = 0
    openCodeSessionBridge.ensureSession = (async () => {
      memberCreations += 1
      throw new Error('member creation must not run')
    }) as typeof openCodeSessionBridge.ensureSession
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = '/mutated/mcp-command'
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON = JSON.stringify(['mutated-arg'])
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON = JSON.stringify({ ROUTE: 'mutated' })
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = 'https://mutated.example/mcp'

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-frozen-mcp-mismatch', laneId: 'primary', teamId: 'team-a',
        selectedModel: 'openrouter/minimax-m2.5-free', members: [{ name: 'alice' }],
      }),
    )

    expect(result.ok).toBe(false)
    expect(memberCreations).toBe(0)
  })

  test('refreshes authority after bootstrap while preserving an earlier committed member', async () => {
    const events: string[] = []
    let authorityCurrent = true
    const originalMarkStaleIfSession = openCodeSessionStore.markStaleIfSession
    const originalDeleteIfSession = openCodeSessionStore.deleteIfSession
    try {
      openCodeProvisioningProbe.probeRetainingHost = (async () => ({
        snapshot, host: snapshot.host, release: async () => {},
      })) as typeof openCodeProvisioningProbe.probeRetainingHost
      openCodeProvisioningProbe.refreshSelectedProfileAuthority = (async () =>
        authorityCurrent ? snapshot.profile! : null
      ) as typeof openCodeProvisioningProbe.refreshSelectedProfileAuthority
      openCodeSessionStore.get = (async () => null) as typeof openCodeSessionStore.get
      openCodeSessionBridge.materializeSessionOnHost = (async input => ({
        ownerToken: { attemptId: 'test-owner', sessionId: '', version: 1 },
        created: true,
        record: buildRecord({
          memberName: input.memberName,
          opencodeSessionId: `session-${input.memberName}`,
          expectedBehaviorFingerprint: input.expectedBehaviorFingerprint,
        }),
      })) as typeof openCodeSessionBridge.materializeSessionOnHost
      openCodeSessionBridge.ensureSessionAppMcpReady = (async () => ({
        ok: true, status: 'present', connected: true, runtimePid: 123, diagnostics: [],
      })) as typeof openCodeSessionBridge.ensureSessionAppMcpReady
      openCodeSessionBridge.injectAppManagedBootstrapContext = (async (record, input) => {
        events.push(`bootstrap:${record.memberName}`)
        if (record.memberName === 'bob') authorityCurrent = false
        return {
          messageID: input.messageID, runtimeSessionId: record.opencodeSessionId,
          contextHash: input.contextHash, briefingHash: input.briefingHash,
          injectionVerifiedAt: '2026-04-21T12:00:00.000Z', alreadyPresent: false,
        }
      }) as typeof openCodeSessionBridge.injectAppManagedBootstrapContext
      openCodeSessionStore.upsert = (async record => {
        events.push(`publish:${record.memberName}`)
        return 'updated'
      }) as typeof openCodeSessionStore.upsert
      openCodeSessionStore.markStaleIfSession = (async record => {
        events.push(`cleanup-stale:${record.memberName}`)
        return record as OpenCodeSessionRecord
      }) as typeof openCodeSessionStore.markStaleIfSession
      openCodeSessionStore.deleteIfSession = (async record => {
        events.push(`cleanup-delete:${record.memberName}`)
        return true
      }) as typeof openCodeSessionStore.deleteIfSession
      openCodeSessionBridge.releaseSession = (async record => {
        events.push(`cleanup-release:${record.memberName}`)
      }) as typeof openCodeSessionBridge.releaseSession

      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.launchTeam', {
        runId: 'run-authority-mutated-during-bootstrap', laneId: 'primary', teamId: 'team-a',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'alice' }, { name: 'bob' }],
      }))

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(Object.keys(result.data.members)).toEqual(['alice'])
      expect(events).toEqual([
        'bootstrap:alice', 'publish:alice', 'bootstrap:bob',
        'cleanup-stale:bob', 'cleanup-release:bob',
      ])
    } finally {
      openCodeSessionStore.markStaleIfSession = originalMarkStaleIfSession
      openCodeSessionStore.deleteIfSession = originalDeleteIfSession
    }
  })

  test('redacts quoted JSON credential values without hiding diagnostic context', async () => {
    openCodeProvisioningProbe.probeRetainingHost = (async () => ({
      snapshot, host: snapshot.host, release: async () => {},
    })) as typeof openCodeProvisioningProbe.probeRetainingHost
    openCodeSessionStore.get = (async () => null) as typeof openCodeSessionStore.get
    openCodeSessionBridge.materializeSessionOnHost = (async () => {
      throw new Error(
        'provider request failed {"apiKey":"alpha key",' +
        '"token":"token-value","authorization":"Basic credential",' +
        '"passwords":"password-value","credentials":"credential-value",' +
        '"detail":"retry disabled"} status=401',
      )
    }) as typeof openCodeSessionBridge.materializeSessionOnHost

    const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.launchTeam', {
      runId: 'run-quoted-json-redaction', laneId: 'primary', teamId: 'team-a',
      selectedModel: 'openrouter/minimax-m2.5-free', members: [{ name: 'alice' }],
    }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('provider request failed')
    expect(result.error.message).toContain('"detail":"retry disabled"')
    expect(result.error.message).toContain('status=401')
    expect(result.error.message).toContain('"apiKey":"[redacted]"')
    for (const secret of [
      'alpha key', 'token-value', 'Basic credential', 'password-value', 'credential-value',
    ]) expect(result.error.message).not.toContain(secret)
  })

  test('strict launch resumes bootstrap for an exact persisted materialization', async () => {
    const writes: OpenCodeSessionRecord[] = []
    let createCalls = 0
    let injectionCalls = 0
    const releasedOwners: unknown[] = []
    const releaseOwner = openCodeSessionStore.releaseMaterializationOwner
    openCodeSessionStore.releaseMaterializationOwner = (async (_record, token) => {
      releasedOwners.push(token)
      return true
    }) as typeof openCodeSessionStore.releaseMaterializationOwner
    openCodeProvisioningProbe.probeRetainingHost = (async () => ({
      snapshot,
      host: snapshot.host,
      release: async () => {},
    })) as typeof openCodeProvisioningProbe.probeRetainingHost
    openCodeSessionStore.get = (async () => null) as typeof openCodeSessionStore.get
    openCodeSessionStore.upsert = (async record => {
      writes.push(record)
      return 'updated'
    }) as typeof openCodeSessionStore.upsert
    openCodeSessionBridge.materializeSessionOnHost = (async input => {
      createCalls += 1
      return {
        created: false,
        ownerToken: { attemptId: 'test-owner', sessionId: 'session-known', version: 1 },
        resumeBootstrap: true,
        record: buildRecord({
          laneId: input.laneId,
          memberName: input.memberName,
          selectedModel: input.selectedModel,
          selectedVariant: input.selectedVariant,
          hostKey: input.host.hostKey,
          profileScope: input.host.profile.profileScope ?? null,
          toolApprovalMode: input.toolApprovalMode ?? 'auto',
          resolvedBehaviorFingerprint: input.host.resolvedConfigFingerprint,
          projectBehaviorFingerprint: input.host.projectBehaviorFingerprint,
          managedConfigFingerprint: input.host.profile.managedConfigFingerprint,
          expectedBehaviorFingerprint: input.expectedBehaviorFingerprint,
          opencodeSessionId: 'session-known',
        }),
      }
    }) as typeof openCodeSessionBridge.materializeSessionOnHost
    openCodeSessionBridge.ensureSessionAppMcpReady = (async () => ({
      ok: true,
      status: 'present',
      connected: true,
      runtimePid: 123,
      diagnostics: [],
    })) as typeof openCodeSessionBridge.ensureSessionAppMcpReady
    openCodeSessionBridge.injectAppManagedBootstrapContext = (async (record, input) => {
      injectionCalls += 1
      return {
        messageID: input.messageID,
        runtimeSessionId: record.opencodeSessionId,
        contextHash: input.contextHash,
        briefingHash: input.briefingHash,
        injectionVerifiedAt: '2026-04-21T12:00:00.000Z',
        alreadyPresent: false,
      }
    }) as typeof openCodeSessionBridge.injectAppManagedBootstrapContext

    const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.launchTeam', {
      runId: 'run-bootstrap-retry',
      laneId: 'primary',
      teamId: 'team-a',
      projectPath: '/tmp/project',
      selectedModel: 'openrouter/minimax-m2.5-free',
      members: [{ name: 'alice', prompt: 'Alice join' }],
    }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(createCalls).toBe(1)
    expect(injectionCalls).toBe(1)
    expect(result.data.members.alice?.sessionId).toBe('session-known')
    expect(writes.at(-1)?.appManagedBootstrap).toMatchObject({
      model: 'openrouter/minimax-m2.5-free',
      agent: 'teammate-bootstrap',
    })
    expect(releasedOwners).toEqual([
      { attemptId: 'test-owner', sessionId: 'session-known', version: 1 },
    ])
    openCodeSessionStore.releaseMaterializationOwner = releaseOwner
  })

  test('strict launch keeps a compatible materialization race non-owned and untouched', async () => {
    const calls = { readiness: 0, injection: 0, writes: 0, cleanup: 0, materialize: 0,
      ownerRelease: 0 }
    let racedRecord: OpenCodeSessionRecord | null = null
    const releaseOwner = openCodeSessionStore.releaseMaterializationOwner
    const observeMaterialization = openCodeSessionStore.observeMaterialization
    const releaseInactiveOwner = openCodeSessionStore.releaseInactiveMaterializationOwner
    openCodeSessionStore.releaseMaterializationOwner = (async () => {
      calls.ownerRelease += 1
      return true
    }) as typeof openCodeSessionStore.releaseMaterializationOwner
    openCodeProvisioningProbe.probeRetainingHost = (async () => ({
      snapshot, host: snapshot.host, release: async () => {},
    })) as typeof openCodeProvisioningProbe.probeRetainingHost
    openCodeSessionStore.get = (async () => null) as typeof openCodeSessionStore.get
    openCodeSessionStore.upsert = (async () => { calls.writes += 1; return 'updated' }) as typeof openCodeSessionStore.upsert
    openCodeSessionStore.markStale = (async () => { calls.cleanup += 1; return null }) as typeof openCodeSessionStore.markStale
    openCodeSessionStore.delete = (async () => { calls.cleanup += 1 }) as typeof openCodeSessionStore.delete
    openCodeSessionBridge.releaseSession = (async () => { calls.cleanup += 1 }) as typeof openCodeSessionBridge.releaseSession
    openCodeSessionBridge.ensureSessionAppMcpReady = (async () => { calls.readiness += 1; throw new Error('must not mutate') }) as typeof openCodeSessionBridge.ensureSessionAppMcpReady
    openCodeSessionBridge.injectAppManagedBootstrapContext = (async () => { calls.injection += 1; throw new Error('must not reinject') }) as typeof openCodeSessionBridge.injectAppManagedBootstrapContext
    openCodeSessionBridge.materializeSessionOnHost = (async input => {
      calls.materialize += 1
      const bootstrap = input.expectedBootstrapForSession('session-existing')
      racedRecord = buildRecord({
        laneId: input.laneId, memberName: input.memberName, runId: input.runId,
        selectedModel: input.selectedModel, selectedVariant: input.selectedVariant,
        hostKey: input.host.hostKey, profileScope: input.host.profile.profileScope ?? null,
        toolApprovalMode: input.toolApprovalMode ?? 'auto',
        resolvedBehaviorFingerprint: input.host.resolvedConfigFingerprint,
        projectBehaviorFingerprint: input.host.projectBehaviorFingerprint,
        managedConfigFingerprint: input.host.profile.managedConfigFingerprint,
        expectedBehaviorFingerprint: input.expectedBehaviorFingerprint,
        opencodeSessionId: 'session-existing', bootstrapMode: 'app_managed_context',
        bootstrapEvidenceSource: 'app_managed_bootstrap',
        appManagedBootstrap: {
          schemaVersion: 1, ...bootstrap, injectionVerifiedAt: '2026-04-21T12:00:00.000Z',
          model: input.selectedModel,
        },
      })
      return {
        created: false,
        record: racedRecord,
      }
    }) as typeof openCodeSessionBridge.materializeSessionOnHost

    const body = {
      runId: 'run-raced-commit', laneId: 'primary', teamId: 'team-a',
      projectPath: '/tmp/project', selectedModel: 'openrouter/minimax-m2.5-free',
      members: [{ name: 'alice', prompt: 'Alice join' }],
    }
    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', body),
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('materialization race must not be reported committed')
    expect(result.error.message).toContain('appeared during materialization')
    expect(calls).toEqual({ readiness: 0, injection: 0, writes: 0, cleanup: 0,
      materialize: 1, ownerRelease: 0 })

    openCodeSessionStore.observeMaterialization = (async () => ({
      record: racedRecord!,
      ownerToken: { attemptId: 'active-attempt', sessionId: 'session-existing', version: 7 },
    })) as typeof openCodeSessionStore.observeMaterialization
    openCodeSessionStore.releaseInactiveMaterializationOwner = (async () => false) as
      typeof openCodeSessionStore.releaseInactiveMaterializationOwner
    calls.materialize = 0
    const owned = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', body),
    )
    expect(owned.ok).toBe(false)
    if (!owned.ok) expect(owned.error.message).toContain('owned by an active launch attempt')
    expect(calls).toEqual({ readiness: 0, injection: 0, writes: 0, cleanup: 0,
      materialize: 0, ownerRelease: 0 })

    let observations = 0
    let deadOwnerReleases = 0
    openCodeSessionStore.observeMaterialization = (async () => ({
      record: racedRecord!,
      ownerToken: observations++ === 0
        ? { attemptId: 'dead-attempt', sessionId: 'session-existing', version: 8 }
        : null,
    })) as typeof openCodeSessionStore.observeMaterialization
    openCodeSessionStore.releaseInactiveMaterializationOwner = (async () => {
      deadOwnerReleases += 1
      return true
    }) as typeof openCodeSessionStore.releaseInactiveMaterializationOwner
    const recovered = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', body),
    )
    openCodeSessionStore.releaseMaterializationOwner = releaseOwner
    openCodeSessionStore.observeMaterialization = observeMaterialization
    openCodeSessionStore.releaseInactiveMaterializationOwner = releaseInactiveOwner
    expect(recovered.ok).toBe(true)
    if (recovered.ok) expect(recovered.data.members.alice?.sessionId).toBe('session-existing')
    expect(deadOwnerReleases).toBe(1)
    expect(calls.materialize).toBe(0)
  })

  test('strict launch rejects missing or malformed behavior digests before host or member effects', async () => {
    let hostCalls = 0
    let proofCalls = 0
    let memberCalls = 0
    openCodeProvisioningProbe.probeRetainingHost = (async () => {
      hostCalls += 1
      throw new Error('must not run')
    }) as typeof openCodeProvisioningProbe.probeRetainingHost
    openCodeExecutionProbe.probeModelOnHost = (async () => {
      proofCalls += 1
      throw new Error('must not run')
    }) as typeof openCodeExecutionProbe.probeModelOnHost
    openCodeSessionBridge.materializeSessionOnHost = (async () => {
      memberCalls += 1
      throw new Error('must not run')
    }) as typeof openCodeSessionBridge.materializeSessionOnHost

    const values = [undefined, null, '', ' ', 'A'.repeat(64), 'a'.repeat(63)]
    for (const value of values) {
      const body: Record<string, unknown> = {
        runId: 'run-missing-strict-preconditions',
        laneId: 'primary',
        teamId: 'team-a',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'alice' }],
      }
      if (value !== undefined) {
        body.preconditions = {
          handshakeIdentityHash: 'handshake-test',
          laneId: 'primary',
          expectedRunId: 'run-missing-strict-preconditions',
          expectedCapabilitySnapshotId: null,
          expectedBehaviorFingerprint: value,
          expectedManifestHighWatermark: 0,
          commandLeaseId: 'lease-test',
          idempotencyKey: 'launch:invalid-fingerprint',
        }
      } else {
        body.preconditions = null
      }
      const result = await executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', body),
      )
      expect(result.ok).toBe(false)
      expect(result.error.message).toContain('expectedBehaviorFingerprint')
    }
    expect(hostCalls).toBe(0)
    expect(proofCalls).toBe(0)
    expect(memberCalls).toBe(0)
  })

  for (const selectedModel of [
    'deepinfra/chosen',
    'custom-provider/nested/model',
    'opencode/big-pickle',
  ]) {
    test(`authorizes empty-catalog ${selectedModel} only through exact retained-host proof`, async () => {
      const strictHost = snapshot.host!
      openCodeProvisioningProbe.probeRetainingHost = (async () => ({
        snapshot: {
          ...snapshot, models: [], modelMetadata: [], configProviders: null,
          providers: null, providerAuth: null,
        },
        host: strictHost,
        release: async () => {},
      })) as typeof openCodeProvisioningProbe.probeRetainingHost
      const proofHosts: string[] = []
      const prove = openCodeExecutionProbe.probeModelOnHost
      openCodeExecutionProbe.probeModelOnHost = (async input => {
        proofHosts.push(input.host.hostKey)
        return prove(input)
      }) as typeof openCodeExecutionProbe.probeModelOnHost
      openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
      const memberHosts: string[] = []
      openCodeSessionBridge.materializeSessionOnHost = (async input => {
        memberHosts.push(input.host.hostKey)
        return {
          record: buildRecord({
            laneId: input.laneId, memberName: input.memberName,
            selectedModel: input.selectedModel, opencodeSessionId: `session-${input.memberName}`,
            expectedBehaviorFingerprint: input.expectedBehaviorFingerprint,
          }),
          ownerToken: { attemptId: 'test-owner', sessionId: '', version: 1 },
          created: true,
        }
      }) as typeof openCodeSessionBridge.materializeSessionOnHost

      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope(
        'opencode.launchTeam', {
          runId: `run-${selectedModel}`, laneId: 'primary', teamId: 'team-a',
          projectPath: '/tmp/project', selectedModel, members: [{ name: 'alice' }],
        },
      ))
      expect(result.ok).toBe(true)
      expect(proofHosts).toEqual([strictHost.hostKey])
      expect(memberHosts).toEqual([strictHost.hostKey])
    })
  }

  test('accepts local Ollama execution proof on the retained host without the STRICT token', async () => {
    let requireExactOutput: boolean | undefined
    let probedOnHost = false
    let slimProbeCalls = 0
    openCodeProvisioningProbe.probeRetainingHost = (async () => (
      { snapshot, host: snapshot.host, release: async () => {} }
    )) as typeof openCodeProvisioningProbe.probeRetainingHost
    openCodeExecutionProbe.probeModel = (async () => {
      slimProbeCalls += 1
      throw new Error('launch proof must stay on the retained host')
    }) as typeof openCodeExecutionProbe.probeModel
    openCodeExecutionProbe.probeModelOnHost = (async input => {
      probedOnHost = true
      requireExactOutput = input.requireExactOutput
      return {
        providerId: 'opencode' as const,
        modelId: input.selectedModel,
        observedProviderId: 'ollama',
        observedModelId: 'qwen2.5-coder:1.5b',
        probePrompt: input.prompt ?? '',
        expectedOutput: input.expectedOutput ?? '',
        outcome: 'available' as const,
        reason: null,
        durationMs: 1,
        rawStatus: 'idle',
        durableState: 'idle',
        latestAssistantText: 'PONG',
        latestAssistantPreview: 'PONG',
        toolCallCount: 0,
        errorCount: 0,
        diagnostics: [],
        verifiedAt: '2026-04-21T12:00:00.000Z',
      }
    }) as typeof openCodeExecutionProbe.probeModelOnHost
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    let memberCalls = 0
    openCodeSessionBridge.materializeSessionOnHost = (async input => {
      memberCalls += 1
      return {
        record: buildRecord({
          laneId: input.laneId, memberName: input.memberName,
          selectedModel: input.selectedModel, opencodeSessionId: `session-${input.memberName}`,
          expectedBehaviorFingerprint: input.expectedBehaviorFingerprint,
        }),
        ownerToken: { attemptId: 'test-owner', sessionId: '', version: 1 },
        created: true,
      }
    }) as typeof openCodeSessionBridge.materializeSessionOnHost

    const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope(
      'opencode.launchTeam', {
        runId: 'run-ollama-inexact', laneId: 'primary', teamId: 'team-a',
        projectPath: '/tmp/project', selectedModel: 'ollama/qwen2.5-coder:1.5b',
        members: [{ name: 'oscar' }],
      },
    ))
    expect(result.ok).toBe(true)
    expect(probedOnHost).toBe(true)
    expect(slimProbeCalls).toBe(0)
    expect(requireExactOutput).toBe(false)
    expect(memberCalls).toBe(1)
  })

  test('rejects local Ollama launch proof that is not PONG', async () => {
    let memberCalls = 0
    openCodeProvisioningProbe.probeRetainingHost = (async () => (
      { snapshot, host: snapshot.host, release: async () => {} }
    )) as typeof openCodeProvisioningProbe.probeRetainingHost
    openCodeExecutionProbe.probeModel = (async () => {
      throw new Error('launch proof must stay on the retained host')
    }) as typeof openCodeExecutionProbe.probeModel
    openCodeExecutionProbe.probeModelOnHost = (async input => ({
      providerId: 'opencode' as const,
      modelId: input.selectedModel,
      observedProviderId: 'ollama',
      observedModelId: 'qwen2.5-coder:1.5b',
      probePrompt: input.prompt ?? '',
      expectedOutput: input.expectedOutput ?? '',
      outcome: 'available' as const,
      reason: null,
      durationMs: 1,
      rawStatus: 'idle',
      durableState: 'idle',
      latestAssistantText: 'ok',
      latestAssistantPreview: 'ok',
      toolCallCount: 0,
      errorCount: 0,
      diagnostics: [],
      verifiedAt: '2026-04-21T12:00:00.000Z',
    })) as typeof openCodeExecutionProbe.probeModelOnHost
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.materializeSessionOnHost = (async input => {
      memberCalls += 1
      return {
        record: buildRecord({
          laneId: input.laneId, memberName: input.memberName,
          selectedModel: input.selectedModel, opencodeSessionId: `session-${input.memberName}`,
          expectedBehaviorFingerprint: input.expectedBehaviorFingerprint,
        }),
        ownerToken: { attemptId: 'test-owner', sessionId: '', version: 1 },
        created: true,
      }
    }) as typeof openCodeSessionBridge.materializeSessionOnHost

    const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope(
      'opencode.launchTeam', {
        runId: 'run-ollama-non-pong', laneId: 'primary', teamId: 'team-a',
        projectPath: '/tmp/project', selectedModel: 'ollama/qwen2.5-coder:1.5b',
        members: [{ name: 'oscar' }],
      },
    ))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('local-model execution proof was mismatched')
    expect(memberCalls).toBe(0)
  })

  test('rejects mismatched exact full-model and nonce output proofs before member work', async () => {
    const prove = openCodeExecutionProbe.probeModelOnHost
    let memberCalls = 0
    openCodeProvisioningProbe.probeRetainingHost = (async () => (
      { snapshot, host: snapshot.host, release: async () => {} }
    )) as typeof openCodeProvisioningProbe.probeRetainingHost
    const noMember = async () => { memberCalls += 1; throw new Error('member must not run') }
    openCodeSessionBridge.materializeSessionOnHost = noMember as typeof openCodeSessionBridge.materializeSessionOnHost
    for (const mismatch of ['full-model', 'observed-provider', 'observed-model', 'nonce'] as const) {
      openCodeExecutionProbe.probeModelOnHost = (async input => {
        const proof = await prove(input)
        if (mismatch === 'full-model') return { ...proof, modelId: 'deepinfra/not-chosen' }
        if (mismatch === 'observed-provider') {
          return { ...proof, observedProviderId: 'other' }
        }
        if (mismatch === 'observed-model') return { ...proof, observedModelId: 'not-chosen' }
        return {
          ...proof,
          latestAssistantText: 'STRICT_LAUNCH_wrong-nonce',
          latestAssistantPreview: 'STRICT_LAUNCH_wrong-nonce',
        }
      }) as typeof openCodeExecutionProbe.probeModelOnHost
      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.launchTeam', {
        runId: `run-mismatched-${mismatch}`, laneId: 'primary', teamId: 'team-a',
        selectedModel: 'deepinfra/chosen', members: [{ name: 'alice' }],
      }))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.message).toContain('mismatched')
    }
    expect(memberCalls).toBe(0)
  })
  test('allows provisioning completed immediately before the work deadline to reach proof', async () => {
    const realNow = Date.now; let now = 1_000; Date.now = () => now
    try {
      await withManualTimers(async () => {
        let proofCalls = 0
        const prove = openCodeExecutionProbe.probeModelOnHost
        const acquire = openCodeProvisioningProbe.probeRetainingHost
        openCodeProvisioningProbe.probe = async () => snapshot
        openCodeProvisioningProbe.probeRetainingHost = (async (_path, options) => {
          now += options.phaseContext.remainingMs() - 1
          return acquire(_path, options)
        }) as typeof openCodeProvisioningProbe.probeRetainingHost
        openCodeExecutionProbe.probeModelOnHost = (async input => {
          proofCalls += 1; return prove(input)
        }) as typeof openCodeExecutionProbe.probeModelOnHost
        const envelope = buildEnvelope('opencode.launchTeam', {
          runId: 'run-provisioning-before-work-deadline', laneId: 'primary',
          teamId: 'team-a', selectedModel: 'deepinfra/chosen',
          members: [{ name: 'alice' }],
        })
        envelope.timeoutMs = 1_000
        await executeOpenCodeBridgeCommandEnvelope(envelope)
        expect(proofCalls).toBe(1)
      })
    } finally { Date.now = realNow }
  })

  test('cancels a hanging initial authority refresh and releases the owned host', async () => {
    await withManualTimers(async timers => {
      let refreshSignal: AbortSignal | null = null
      const refreshStarted = createDeferred<void>()
      let releaseCalls = 0
      openCodeProvisioningProbe.probeRetainingHost = (async () => ({
        snapshot,
        host: snapshot.host,
        release: async () => { releaseCalls += 1 },
      })) as typeof openCodeProvisioningProbe.probeRetainingHost
      openCodeProvisioningProbe.refreshSelectedProfileAuthority = (async input => {
        refreshSignal = input.phaseContext?.signal ?? null
        refreshStarted.resolve()
        return new Promise((_resolve, reject) => {
          refreshSignal?.addEventListener('abort', () => reject(refreshSignal?.reason), { once: true })
        })
      }) as typeof openCodeProvisioningProbe.refreshSelectedProfileAuthority
      let proofCalls = 0
      openCodeExecutionProbe.probeModelOnHost = (async () => {
        proofCalls += 1
        throw new Error('proof must not run after authority refresh hangs')
      }) as typeof openCodeExecutionProbe.probeModelOnHost
      const envelope = buildEnvelope('opencode.launchTeam', {
        runId: 'run-authority-refresh-timeout', laneId: 'primary',
        teamId: 'team-a', selectedModel: 'deepinfra/chosen',
        members: [{ name: 'alice' }],
      })
      envelope.timeoutMs = 1_000
      const resultPromise = executeOpenCodeBridgeCommandEnvelope(envelope)
      await waitForCommandStage(refreshStarted.promise, resultPromise, 'authority refresh')
      expect(refreshSignal).not.toBeNull()
      const workTimer = timers.find(timer => timer.timeoutMs < 1_000 && !timer.cancelled)
      expect(workTimer).toBeDefined()
      workTimer!.callback()
      const result = await resultPromise
      expect(result.ok).toBe(false)
      expect(refreshSignal?.aborted).toBe(true)
      expect(proofCalls).toBe(0)
      expect(releaseCalls).toBe(1)
    })
  })

  test('fences abort-ignoring provisioning and releases only a late owned host in time', async () => {
    const realNow = Date.now
    let now = 1_000
    Date.now = () => now
    try {
      await withManualTimers(async timers => {
        const acquired = createDeferred<RetainedProbe>()
        const provisioningStarted = createDeferred<void>()
        let workCalls = 0; let releaseCalls = 0
        let reportStage: ((stage: OpenCodeProvisioningStage) => void) | undefined
        openCodeProvisioningProbe.probeRetainingHost = (async (_projectPath, options) => {
          reportStage = options?.phaseContext?.reportProvisioningStage
          options?.phaseContext?.reportProvisioningStage?.('inventory')
          provisioningStarted.resolve()
          return acquired.promise
        }) as typeof openCodeProvisioningProbe.probeRetainingHost
        const noWork = async () => { workCalls += 1; throw new Error('work must not run') }
        openCodeExecutionProbe.probeModelOnHost = noWork as typeof openCodeExecutionProbe.probeModelOnHost
        openCodeSessionBridge.materializeSessionOnHost = noWork as typeof openCodeSessionBridge.materializeSessionOnHost
        const envelope = buildEnvelope('opencode.launchTeam', {
          runId: 'run-provisioning-work-timeout', laneId: 'primary',
          teamId: 'team-a', selectedModel: 'deepinfra/chosen', members: [{ name: 'alice' }],
        })
        envelope.timeoutMs = 1_000
        const resultPromise = executeOpenCodeBridgeCommandEnvelope(envelope)
        await waitForCommandStage(provisioningStarted.promise, resultPromise, 'provisioning')
        // Microtasks may resume after the deadline before the timer can abort.
        now += 1_000
        reportStage?.('ensure_host')
        const workTimer = timers.find(timer => timer.timeoutMs < 1_000 && !timer.cancelled)
        expect(workTimer).toBeDefined(); workTimer!.callback()
        const result = await resultPromise
        expect(result.ok).toBe(false)
        if (!('error' in result)) throw new Error('Expected provisioning failure error')
        expect(result.error.kind).toBe('provider_error')
        expect(result.error.message).toMatch(
          /OpenCode strict launch provisioning deadline expired \(stage=inventory, stageElapsedMs=\d+\)/,
        )
        expect(workCalls).toBe(0)
        acquired.resolve({ snapshot, host: snapshot.host, release: async () => { releaseCalls += 1 } })
        await Promise.resolve(); await Promise.resolve()
        expect(releaseCalls).toBe(1)
      })
    } finally {
      Date.now = realNow
    }
  })

  test('external cancellation cleans an exact late lease after deadline and contains late rejection', async () => {
    const realNow = Date.now; let now = 1_000; Date.now = () => now
    try {
      await withManualTimers(async () => {
        const acquired = createDeferred<RetainedProbe>()
        const provisioningStarted = createDeferred<void>()
        let workCalls = 0; let lateReleaseCalls = 0
        openCodeProvisioningProbe.probeRetainingHost = (async () => { provisioningStarted.resolve(); return acquired.promise }) as
          typeof openCodeProvisioningProbe.probeRetainingHost
        const noWork = async () => { workCalls += 1; throw new Error('work must not run') }
        openCodeExecutionProbe.probeModelOnHost = noWork as typeof openCodeExecutionProbe.probeModelOnHost
        openCodeSessionBridge.materializeSessionOnHost = noWork as typeof openCodeSessionBridge.materializeSessionOnHost
        const controller = new AbortController()
        const envelope = buildEnvelope('opencode.launchTeam', {
          runId: 'run-cancelled-provisioning', laneId: 'primary',
          teamId: 'team-a', selectedModel: 'deepinfra/chosen', members: [{ name: 'alice' }],
        })
        envelope.timeoutMs = 1_000
        const resultPromise = executeOpenCodeBridgeCommandEnvelope(
          envelope, { signal: controller.signal },
        )
        await waitForCommandStage(provisioningStarted.promise, resultPromise, 'provisioning')
        controller.abort(new Error('cancelled externally'))
        const result = await resultPromise
        expect(result.ok).toBe(false)
        expect(workCalls).toBe(0)
        now = 2_001
        acquired.resolve({ snapshot, host: snapshot.host,
          release: async () => { lateReleaseCalls += 1 } })
        await Promise.resolve(); await Promise.resolve()
        expect(lateReleaseCalls).toBe(1)
        const rejected = createDeferred<RetainedProbe>()
        const secondStarted = createDeferred<void>()
        openCodeProvisioningProbe.probeRetainingHost = (async () => { secondStarted.resolve(); return rejected.promise }) as
          typeof openCodeProvisioningProbe.probeRetainingHost
        const secondController = new AbortController()
        const second = executeOpenCodeBridgeCommandEnvelope(
          envelope, { signal: secondController.signal },
        )
        await waitForCommandStage(secondStarted.promise, second, 'second provisioning')
        secondController.abort(new Error('cancelled externally'))
        await second
        rejected.reject(new Error('late provisioning rejection'))
        await Promise.resolve()
      })
    } finally { Date.now = realNow }
  })

  test('rechecks retained-host behavior after model proof before materialization', async () => {
    let memberCalls = 0
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeExecutionProbe.probeModelOnHost = (async input => {
      input.host.profile.managedConfig = { changed: true }
      return {
        providerId: 'opencode', modelId: input.selectedModel,
        observedProviderId: 'openrouter', observedModelId: 'minimax-m2.5-free',
        probePrompt: input.prompt ?? '', expectedOutput: input.expectedOutput ?? '',
        outcome: 'available', reason: null, durationMs: 1, rawStatus: 'idle',
        durableState: 'idle', latestAssistantText: input.expectedOutput ?? '',
        latestAssistantPreview: input.expectedOutput ?? '', toolCallCount: 0,
        errorCount: 0, diagnostics: [], verifiedAt: '2026-04-21T12:00:00.000Z',
      }
    }) as typeof openCodeExecutionProbe.probeModelOnHost
    openCodeSessionBridge.materializeSessionOnHost = (async () => {
      memberCalls += 1
      throw new Error('must not materialize after proof evidence changes')
    }) as typeof openCodeSessionBridge.materializeSessionOnHost

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-proof-change',
        laneId: 'primary',
        teamId: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'alice' }],
      }),
    )

    expect(result.ok).toBe(false)
    expect(result.error.message).toContain('behavior changed during proof')
    expect(memberCalls).toBe(0)
  })

  test('launches provider-scoped OpenCode model ids that contain nested slashes', async () => {
    const ensureInputs: Array<{
      memberName: string
      selectedModel: string
      selectedVariant?: string
    }> = []
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        selectedVariant: input.selectedVariant,
      })
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        selectedVariant: input.selectedVariant,
        opencodeSessionId: `session-${input.memberName}`,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: 'msg-alice-ready',
        latestAssistantText: 'alice ready',
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-nested-slash-model',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/moonshotai/kimi-k2',
        effort: 'max',
        members: [{ name: 'alice', role: 'Developer', prompt: 'Alice join' }],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(ensureInputs).toEqual([
      {
        memberName: 'alice',
        selectedModel: 'openrouter/moonshotai/kimi-k2',
        selectedVariant: 'max',
      },
    ])
    expect(result.data.teamLaunchState).toBe('launching')
    expect(result.data.members.alice?.launchState).toBe('created')
    expect(result.data.members.alice?.bootstrapMode).toBe('app_managed_context')
  })

  test('fails closed for an unqualified raw model id before host, proof, or member effects', async () => {
    let hostCalls = 0
    let proofCalls = 0
    const ensureInputs: Array<{ memberName: string; selectedModel: string }> = []
    openCodeProvisioningProbe.probeRetainingHost = (async () => {
      hostCalls += 1
      throw new Error('host must not be reached')
    }) as typeof openCodeProvisioningProbe.probeRetainingHost
    openCodeExecutionProbe.probeModelOnHost = (async () => {
      proofCalls += 1
      throw new Error('proof must not be reached')
    }) as typeof openCodeExecutionProbe.probeModelOnHost
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: 'msg-alice-ready',
        latestAssistantText: 'alice ready',
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-raw-slash-model',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'kimi-k2',
        members: [{ name: 'alice', role: 'Developer', prompt: 'Alice join' }],
      }),
    )

    expect(result.ok).toBe(false)
    expect(hostCalls).toBe(0)
    expect(proofCalls).toBe(0)
    expect(ensureInputs).toEqual([])
  })

  test('persists app-managed bootstrap metadata after launch injection', async () => {
    const upserts: OpenCodeSessionRecord[] = []
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionBridge.ensureSession = (async input =>
      buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
      })) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionStore.upsert = (async record => {
      upserts.push(record)
      return 'updated'
    }) as typeof openCodeSessionStore.upsert

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-app-managed-persisted',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'alice', role: 'Developer', prompt: 'Alice join' }],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(upserts.length).toBeGreaterThanOrEqual(1)
    const finalUpsert = upserts.at(-1)
    expect(finalUpsert?.appManagedBootstrap?.messageID).toMatch(/^msg_000000000000[0-9a-f]{14}$/)
    expect(finalUpsert).toMatchObject({
      opencodeSessionId: 'session-alice',
      bootstrapMode: 'app_managed_context',
      bootstrapEvidenceSource: 'app_managed_bootstrap',
      appManagedBootstrap: {
        schemaVersion: 1,
        briefingHash: expect.any(String),
        contextHash: expect.any(String),
        injectionVerifiedAt: '2026-04-21T12:00:00.000Z',
        messageID: expect.any(String),
        model: 'openrouter/minimax-m2.5-free',
        agent: 'teammate-bootstrap',
      },
    })
    expect(result.data.members.alice?.bootstrapEvidenceSource).toBe('app_managed_bootstrap')
    expect(result.data.members.alice?.bootstrapMode).toBe('app_managed_context')
  })

  test('uses the OpenCode session runtime pid during launch before host fallback', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionBridge.ensureSession = (async input =>
      buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: 777,
      })) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      summary: buildReconcileSummary({ sessionId: record.opencodeSessionId }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-1',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'alice', role: 'Developer', prompt: 'Join the team' }],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.members.alice?.runtimePid).toBe(777)
  })

  test('keeps a launched member pending until OpenCode emits an assistant bootstrap confirmation', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionBridge.ensureSession = (async input =>
      buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
      })) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: null,
        latestAssistantText: null,
        latestAssistantPreview: null,
        messageCount: 0,
        durableState: 'idle',
        messages: [],
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-1',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'alice', role: 'Developer', prompt: 'Join the team' }],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.teamLaunchState).toBe('launching')
    expect(result.data.members.alice?.launchState).toBe('created')
    expect(result.data.members.alice?.evidence.map(entry => entry.kind)).toEqual([
      'app_managed_bootstrap_context_injected',
    ])
  })

  test('injects app-managed bootstrap without retrying stale model bootstrap errors', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionBridge.ensureSession = (async input =>
      buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
      })) as typeof openCodeSessionBridge.ensureSession
    const promptAsync = mock(async () => {})
    openCodeSessionBridge.promptAsync = promptAsync as typeof openCodeSessionBridge.promptAsync
    const failedSummary = buildReconcileSummary({
      sessionId: 'session-alice',
      latestAssistantMessageId: 'msg-bootstrap-failed',
      latestAssistantText: 'Both calls returned "Not connected".',
      messages: [
        buildCanonicalMessage({
          id: 'msg-bootstrap-failed',
          role: 'assistant',
          text: 'Both calls returned "Not connected".',
          toolCalls: [
            buildToolCall({
              toolName: 'agent-teams_runtime_bootstrap_checkin',
              status: 'errored',
              outputText: 'Not connected',
              isError: true,
            }),
            buildToolCall({
              callId: 'tool-2',
              toolName: 'agent-teams_member_briefing',
              status: 'errored',
              outputText: 'Not connected',
              isError: true,
            }),
          ],
        }),
      ],
    })
    let reconcileAttempt = 0
    const reconcileSession = mock(async record => {
      reconcileAttempt += 1
      return {
        record,
        summary:
          reconcileAttempt === 1
            ? failedSummary
            : buildReconcileSummary({ sessionId: record.opencodeSessionId }),
      }
    })
    openCodeSessionBridge.reconcileSession =
      reconcileSession as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-bootstrap-not-connected',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'alice', role: 'Developer', prompt: 'Join the team' }],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.teamLaunchState).toBe('launching')
    expect(result.data.members.alice?.launchState).toBe('created')
    expect(result.data.members.alice?.evidence.map(entry => entry.kind)).toEqual([
      'app_managed_bootstrap_context_injected',
    ])
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(promptAsync.mock.calls[0]?.[1]?.text).toContain('<agent_teams_app_managed_bootstrap>')
    expect(reconcileSession).not.toHaveBeenCalled()
    expect(result.data.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'opencode_app_managed_bootstrap_context_verified',
    )
  })

  test('does not require model bootstrap briefing before app-managed launch context is accepted', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionBridge.ensureSession = (async input =>
      buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
      })) as typeof openCodeSessionBridge.ensureSession
    const promptAsync = mock(async () => {})
    openCodeSessionBridge.promptAsync = promptAsync as typeof openCodeSessionBridge.promptAsync
    const missingBriefingSummary = buildReconcileSummary({
      sessionId: 'session-alice',
      latestAssistantMessageId: 'msg-checkin-only',
      latestAssistantText: 'Bootstrap check-in completed.',
      toolCallCount: 1,
      messages: [
        buildCanonicalMessage({
          id: 'msg-checkin-only',
          role: 'assistant',
          text: 'Bootstrap check-in completed.',
          toolCalls: [
            buildToolCall({
              toolName: 'agent-teams_runtime_bootstrap_checkin',
              status: 'completed',
              output: { ok: true },
            }),
          ],
        }),
      ],
    })
    let reconcileAttempt = 0
    const reconcileSession = mock(async record => {
      reconcileAttempt += 1
      return {
        record,
        summary:
          reconcileAttempt === 1
            ? missingBriefingSummary
            : buildReconcileSummary({ sessionId: record.opencodeSessionId }),
      }
    })
    openCodeSessionBridge.reconcileSession =
      reconcileSession as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-bootstrap-missing-briefing',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'alice', role: 'Developer', prompt: 'Join the team' }],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.teamLaunchState).toBe('launching')
    expect(result.data.members.alice?.launchState).toBe('created')
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(promptAsync.mock.calls[0]?.[1]?.text).toContain('<agent_teams_app_managed_bootstrap>')
    expect(reconcileSession).not.toHaveBeenCalled()
    expect(result.data.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'opencode_app_managed_bootstrap_context_verified',
    )
  })

  test('ensures session app MCP is ready before first launch bootstrap prompt', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionBridge.ensureSession = (async input =>
      buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
      })) as typeof openCodeSessionBridge.ensureSession
    const callOrder: string[] = []
    openCodeSessionBridge.ensureSessionAppMcpReady = (async record => {
      callOrder.push(`mcp:${record.memberName}`)
      return {
        ok: true,
        runtimePid: record.runtimePid,
        status: 'present',
        connected: true,
        diagnostics: [],
      }
    }) as typeof openCodeSessionBridge.ensureSessionAppMcpReady
    openCodeSessionBridge.promptAsync = (async record => {
      callOrder.push(`prompt:${record.memberName}`)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary: buildReconcileSummary({ sessionId: record.opencodeSessionId }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-bootstrap-mcp-ready-before-prompt',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'alice', role: 'Developer', prompt: 'Join the team' }],
      }),
    )

    expect(result.ok).toBe(true)
    expect(callOrder).toEqual(['mcp:alice', 'prompt:alice'])
  })

  test('proves app MCP tools through a remote URL override before launch', async () => {
    const remoteUrl = 'http://127.0.0.1:41009/mcp'
    const retained = buildAppMcpSnapshot({
      type: 'remote', url: remoteUrl, enabled: true, timeout: 30_000, oauth: false,
    })
    openCodeProvisioningProbe.probe = async () => retained.snapshot
    let connectedTransportName: string | null = null
    ;(Client.prototype.connect as unknown as (transport: unknown) => Promise<void>) =
      async transport => {
        connectedTransportName = transport && typeof transport === 'object'
          ? transport.constructor.name
          : null
      }
    openCodeSessionBridge.ensureSession = (async input =>
      buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
      })) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.ensureSessionAppMcpReady = (async record => ({
      ok: true,
      runtimePid: record.runtimePid,
      status: 'present',
      connected: true,
      diagnostics: [],
    })) as typeof openCodeSessionBridge.ensureSessionAppMcpReady
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary: buildReconcileSummary({ sessionId: record.opencodeSessionId }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const envelope = buildEnvelope('opencode.launchTeam', {
        runId: 'run-bootstrap-remote-mcp-proof',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'alice', role: 'Developer', prompt: 'Join the team' }],
      })
    ;(envelope.body.preconditions as Record<string, unknown>).expectedBehaviorFingerprint =
      expectedFingerprintForModel('openrouter/minimax-m2.5-free', retained.fingerprint)
    const result = await executeOpenCodeBridgeCommandEnvelope(envelope)

    expect(result.ok).toBe(true)
    expect(connectedTransportName).toBe('StreamableHTTPClientTransport')
  })

  test('falls back to SSE when proving remote app MCP tools before launch', async () => {
    const remoteUrl = 'http://127.0.0.1:41010/mcp'
    const retained = buildAppMcpSnapshot({
      type: 'remote', url: remoteUrl, enabled: true, timeout: 30_000, oauth: false,
    })
    openCodeProvisioningProbe.probe = async () => retained.snapshot
    const connectedTransportNames: string[] = []
    ;(Client.prototype.connect as unknown as (transport: unknown) => Promise<void>) =
      async transport => {
        const name = transport && typeof transport === 'object'
          ? transport.constructor.name
          : 'unknown'
        connectedTransportNames.push(name)
        if (name === 'StreamableHTTPClientTransport') {
          throw new Error('streamable unavailable')
        }
      }
    openCodeSessionBridge.ensureSession = (async input =>
      buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
      })) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.ensureSessionAppMcpReady = (async record => ({
      ok: true,
      runtimePid: record.runtimePid,
      status: 'present',
      connected: true,
      diagnostics: [],
    })) as typeof openCodeSessionBridge.ensureSessionAppMcpReady
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary: buildReconcileSummary({ sessionId: record.opencodeSessionId }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const envelope = buildEnvelope('opencode.launchTeam', {
        runId: 'run-bootstrap-remote-mcp-sse-proof',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'alice', role: 'Developer', prompt: 'Join the team' }],
      })
    ;(envelope.body.preconditions as Record<string, unknown>).expectedBehaviorFingerprint =
      expectedFingerprintForModel('openrouter/minimax-m2.5-free', retained.fingerprint)
    const result = await executeOpenCodeBridgeCommandEnvelope(envelope)

    expect(result.ok).toBe(true)
    expect(connectedTransportNames).toEqual([
      'StreamableHTTPClientTransport',
      'SSEClientTransport',
    ])
  })

  test('does not recreate a proven strict-host session after MCP is already attached', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    let ensureCount = 0
    const callOrder: string[] = []
    openCodeSessionBridge.ensureSession = (async input => {
      ensureCount += 1
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${ensureCount}`,
      })
      callOrder.push(`ensure:${record.opencodeSessionId}`)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.ensureSessionAppMcpReady = (async record => {
      callOrder.push(`mcp:${record.opencodeSessionId}`)
      return {
        ok: true,
        runtimePid: record.runtimePid,
        status: record.opencodeSessionId === 'session-1' ? 'attached' : 'present',
        connected: true,
        diagnostics: [],
      }
    }) as typeof openCodeSessionBridge.ensureSessionAppMcpReady
    openCodeSessionStore.markStale = (async (_teamId, _laneId, _memberName, reason) => {
      callOrder.push(`stale:${reason}`)
      return null
    }) as typeof openCodeSessionStore.markStale
    openCodeSessionBridge.promptAsync = (async record => {
      callOrder.push(`prompt:${record.opencodeSessionId}`)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary: buildReconcileSummary({ sessionId: record.opencodeSessionId }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-bootstrap-mcp-attached-recreate',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'alice', role: 'Developer', prompt: 'Join the team' }],
      }),
    )

    expect(result.ok).toBe(true)
    expect(callOrder).toEqual([
      'ensure:session-1',
      'mcp:session-1',
      'prompt:session-1',
    ])
    if (result.ok) {
      expect(result.data.members.alice?.sessionId).toBe('session-1')
    }
  })

  test('does not send launch bootstrap prompt when session app MCP cannot attach', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    const released: Array<{ teamId: string; laneId: string; memberName: string; hostKey: string }> = []
    const deleted: Array<{ teamId: string; laneId: string; memberName: string }> = []
    const stale: Array<{ teamId: string; laneId: string; memberName: string; reason: string }> = []
    openCodeSessionBridge.ensureSession = (async input =>
      buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
      })) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.releaseSession = (async record => {
      released.push({
        teamId: record.teamId,
        laneId: record.laneId,
        memberName: record.memberName,
        hostKey: record.hostKey,
      })
    }) as typeof openCodeSessionBridge.releaseSession
    openCodeSessionStore.markStale = (async (teamId, laneIdOrMemberName, memberNameOrReason, reasonMaybe) => {
      stale.push({
        teamId,
        laneId: reasonMaybe ? laneIdOrMemberName : 'primary',
        memberName: reasonMaybe ? memberNameOrReason : laneIdOrMemberName,
        reason: reasonMaybe ?? memberNameOrReason,
      })
      return null
    }) as typeof openCodeSessionStore.markStale
    openCodeSessionStore.delete = (async (teamId, laneIdOrMemberName, memberNameMaybe) => {
      deleted.push({
        teamId,
        laneId: memberNameMaybe ? laneIdOrMemberName : 'primary',
        memberName: memberNameMaybe ?? laneIdOrMemberName,
      })
      return true
    }) as typeof openCodeSessionStore.delete
    openCodeSessionBridge.ensureSessionAppMcpReady = (async () => ({
      ok: false,
      runtimePid: 1234,
      status: 'attach_failed',
      connected: false,
      diagnostics: ['OpenCode app MCP attach failed: test failure'],
    })) as typeof openCodeSessionBridge.ensureSessionAppMcpReady
    const promptAsync = mock(async () => {})
    openCodeSessionBridge.promptAsync = promptAsync as typeof openCodeSessionBridge.promptAsync

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-bootstrap-mcp-not-ready',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'alice', role: 'Developer', prompt: 'Join the team' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      return
    }
    expect(promptAsync).not.toHaveBeenCalled()
    expect(result.data.teamLaunchState).toBe('failed')
    expect(result.data.members.alice?.launchState).toBe('failed')
    expect(result.data.members.alice?.runtimePid).toBe(1234)
    expect(result.data.members.alice?.diagnostics.join('\n')).toContain(
      'OpenCode app MCP was not ready for alice before launch bootstrap',
    )
    expect(stale).toEqual([
      {
        teamId: 'team-a',
        laneId: 'secondary:opencode:alice',
        memberName: 'alice',
        reason: 'launch_failed',
      },
    ])
    expect(released).toEqual([
      {
        teamId: 'team-a',
        laneId: 'secondary:opencode:alice',
        memberName: 'alice',
        hostKey: 'host-key',
      },
    ])
    expect(deleted).toEqual([
      {
        teamId: 'team-a',
        laneId: 'secondary:opencode:alice',
        memberName: 'alice',
      },
    ])
  })

  test('does not require assistant bootstrap tools after app-managed context injection', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionBridge.ensureSession = (async input =>
      buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
      })) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: 'msg-no-tools',
        latestAssistantText:
          "I don't have the agent-teams MCP tools available in my current toolset.",
        messages: [
          buildCanonicalMessage({
            id: 'msg-no-tools',
            role: 'assistant',
            text: "I don't have the agent-teams MCP tools available in my current toolset.",
            toolCalls: [],
          }),
        ],
        toolCallCount: 0,
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-bootstrap-missing-tools',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'alice', role: 'Developer', prompt: 'Join the team' }],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.teamLaunchState).toBe('launching')
    expect(result.data.members.alice?.launchState).toBe('created')
    expect(result.data.members.alice?.diagnostics).toContain(
      'OpenCode app-managed bootstrap context was injected and verified.',
    )
    expect(result.data.members.alice?.evidence.map(entry => entry.kind)).toEqual([
      'app_managed_bootstrap_context_injected',
    ])
  })

  test('does not hard-fail launch when prompt is accepted but settle reconcile is still pending', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionBridge.ensureSession = (async input =>
      buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: 812,
      })) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async () => {
      throw new Error('not visible yet')
    }) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-prompt-accepted',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'alice', role: 'Developer', prompt: 'Join the team' }],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.teamLaunchState).toBe('launching')
    expect(result.data.members.alice).toMatchObject({
      sessionId: 'session-alice',
      launchState: 'created',
      runtimePid: 812,
      diagnostics: ['OpenCode app-managed bootstrap context was injected and verified.'],
    })
    expect(result.data.members.alice?.evidence.map(entry => entry.kind)).toEqual([
      'app_managed_bootstrap_context_injected',
    ])
    expect(result.data.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'opencode_app_managed_bootstrap_context_verified',
    )
  })

  test('aggregates a multi-member OpenCode lane after app-managed bootstrap injection', async () => {
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const prompts: Array<{ memberName: string; text: string; agent: string }> = []
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: input.memberName === 'alice' ? 701 : 702,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async (record, input) => {
      prompts.push({
        memberName: record.memberName,
        text: input.text,
        agent: input.agent ?? '',
      })
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      summary:
        record.memberName === 'alice'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: 'msg-alice-ready',
            latestAssistantText: 'ready',
          })
          : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: null,
            latestAssistantText: null,
            latestAssistantPreview: null,
            messageCount: 0,
            durableState: 'blocked',
            pendingPermissionRequestIds: ['perm-bob', 'perm-bob', 'perm-shell'],
            diagnostics: ['bob waiting for permission'],
            messages: [],
          }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-1',
        laneId: 'primary',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [
          { name: 'alice', role: 'Developer', prompt: 'Alice join' },
          { name: 'bob', role: 'Reviewer', prompt: 'Bob join' },
        ],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(ensureInputs).toEqual([
      {
        laneId: 'primary',
        memberName: 'alice',
        selectedModel: 'openrouter/minimax-m2.5-free',
      },
      {
        laneId: 'primary',
        memberName: 'bob',
        selectedModel: 'openrouter/minimax-m2.5-free',
      },
    ])
    expect(prompts.map(prompt => ({ memberName: prompt.memberName, agent: prompt.agent }))).toEqual([
      { memberName: 'alice', agent: 'teammate-bootstrap' },
      { memberName: 'bob', agent: 'teammate-bootstrap' },
    ])
    expectOpenCodeIdentityPrompt({
      text: prompts[0]?.text ?? '',
      teamName: 'team-a',
      memberName: 'alice',
      runtimeSessionId: 'session-alice',
      runId: 'run-1',
      originalPrompt: 'Alice join',
    })
    expectOpenCodeIdentityPrompt({
      text: prompts[1]?.text ?? '',
      teamName: 'team-a',
      memberName: 'bob',
      runtimeSessionId: 'session-bob',
      runId: 'run-1',
      originalPrompt: 'Bob join',
    })
    expect(result.data.teamLaunchState).toBe('launching')
    expect(result.data.members.alice?.launchState).toBe('created')
    expect(result.data.members.alice?.runtimePid).toBe(701)
    expect(result.data.members.bob?.launchState).toBe('created')
    expect(result.data.members.bob?.runtimePid).toBe(702)
    expect(result.data.members.bob?.pendingPermissionRequestIds).toBeUndefined()
    expect(result.data.diagnostics.map(diagnostic => diagnostic.code)).toEqual(
      expect.arrayContaining([
        'opencode_app_managed_bootstrap_context_verified',
        'opencode_launch_member_timing',
        'opencode_launch_total_timing',
      ]),
    )
  })

  test('prepends runtime identity to realistic OpenCode launch prompts without native SendMessage routing', async () => {
    const prompts: Array<{ memberName: string; text: string; agent: string }> = []
    const realisticTeamContext = [
      'Team launch context: verify OpenCode runtime messaging in a production desktop app.',
      'Members must preserve taskRefs, avoid idle acknowledgements, and use Agent Teams MCP.',
      'Known failure modes include plain assistant replies, fake #00000000 task labels, and peer relay drops.',
    ].join('\n')
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionBridge.ensureSession = (async input =>
      buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: input.memberName === 'bob' ? 801 : 802,
      })) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async (record, input) => {
      prompts.push({
        memberName: record.memberName,
        text: input.text,
        agent: input.agent ?? '',
      })
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: `msg-${record.memberName}-ready`,
        latestAssistantText: `${record.memberName} ready`,
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-realistic-contract',
        laneId: 'primary',
        teamId: 'team-realistic',
        teamName: 'team-realistic',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [
          {
            name: 'bob',
            role: 'Developer',
            prompt: `${realisticTeamContext}\nWorkflow: own direct app runtime delivery.`,
          },
          {
            name: 'jack',
            role: 'Reviewer',
            prompt: `${realisticTeamContext}\nWorkflow: verify OpenCode peer relay.`,
          },
        ],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(prompts).toHaveLength(2)
    for (const prompt of prompts) {
      expect(prompt.agent).toBe('teammate-bootstrap')
      expect(prompt.text).toContain('<agent_teams_app_managed_bootstrap>')
      expect(prompt.text).toContain('AGENT_TEAMS_APP_MANAGED_BOOTSTRAP_V1')
      expect(prompt.text).toContain('Do not call runtime_bootstrap_checkin')
      expect(prompt.text).toContain('member_briefing')
      expect(prompt.text).toContain('"runtimeProvider":"opencode"')
      expect(prompt.text).toContain('message_send')
      expect(prompt.text).toContain('Do not use SendMessage.')
      expect(prompt.text).toContain('Known failure modes include plain assistant replies')
      expect(prompt.text).not.toContain('Call SendMessage')
      expect(prompt.text).not.toContain('Use SendMessage')
      expect(prompt.text).toContain('"laneId"')
      expect(prompt.text.indexOf('<agent_teams_app_managed_bootstrap>')).toBeLessThan(
        prompt.text.indexOf('Team launch context:')
      )
    }
    expect(result.data.teamLaunchState).toBe('launching')
    expect(result.data.members.bob?.launchState).toBe('created')
    expect(result.data.members.jack?.launchState).toBe('created')
  })

  test('keeps OpenCode peers visible when one launch member prompt delivery fails', async () => {
    const ensureInputs: string[] = []
    const promptAttempts: string[] = []
    const reconciledMembers: string[] = []
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push(input.memberName)
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid:
          input.memberName === 'alice'
            ? 801
            : input.memberName === 'bob'
              ? 802
              : 803,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async record => {
      promptAttempts.push(record.memberName)
      if (record.memberName === 'bob') {
        throw new Error('bob prompt delivery failed')
      }
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
          latestAssistantMessageId: `msg-${record.memberName}-ready`,
          latestAssistantText: `${record.memberName} ready`,
        }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-1',
        laneId: 'primary',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [
          { name: 'alice', role: 'Developer', prompt: 'Alice join' },
          { name: 'bob', role: 'Reviewer', prompt: 'Bob join' },
          { name: 'zoe', role: 'Developer', prompt: 'Zoe join' },
        ],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(ensureInputs).toEqual(['alice', 'bob'])
    expect(promptAttempts).toEqual(['alice', 'bob'])
    expect(reconciledMembers).toEqual([])
    expect(result.data.teamLaunchState).toBe('launching')
    expect(result.data.members.alice?.launchState).toBe('created')
    expect(result.data.members.bob).toBeUndefined()
    expect(result.data.members.zoe).toBeUndefined()
  })

  test('keeps OpenCode peers visible when one launch member session creation fails', async () => {
    const ensureInputs: string[] = []
    const promptAttempts: string[] = []
    const reconciledMembers: string[] = []
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push(input.memberName)
      if (input.memberName === 'bob') {
        throw new Error('bob ensure session failed')
      }
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: input.memberName === 'alice' ? 1101 : 1103,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async record => {
      promptAttempts.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
          latestAssistantMessageId: `msg-${record.memberName}-ready`,
          latestAssistantText: `${record.memberName} ready`,
        }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-1',
        laneId: 'primary',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [
          { name: 'alice', role: 'Developer', prompt: 'Alice join' },
          { name: 'bob', role: 'Reviewer', prompt: 'Bob join' },
          { name: 'zoe', role: 'Developer', prompt: 'Zoe join' },
        ],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(ensureInputs).toEqual(['alice', 'bob'])
    expect(promptAttempts).toEqual(['alice'])
    expect(reconciledMembers).toEqual([])
    expect(result.data.teamLaunchState).toBe('launching')
    expect(result.data.members.alice?.launchState).toBe('created')
    expect(result.data.members.alice?.runtimePid).toBe(1101)
    expect(result.data.members.bob).toBeUndefined()
    expect(result.data.members.zoe).toBeUndefined()
  })

  test('keeps launch context visible without reconcile-time failure coupling', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionBridge.ensureSession = (async input =>
      buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
      })) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      summary:
        record.memberName === 'alice'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: 'msg-alice-ready',
            latestAssistantText: 'ready',
          })
          : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            staleReason: 'session store missing latest event',
            errorCount: 1,
            diagnostics: ['bob session stale'],
          }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-1',
        laneId: 'primary',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [
          { name: 'alice', role: 'Developer', prompt: 'Alice join' },
          { name: 'bob', role: 'Reviewer', prompt: 'Bob join' },
        ],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.teamLaunchState).toBe('launching')
    expect(result.data.members.alice?.launchState).toBe('created')
    expect(result.data.members.bob?.launchState).toBe('created')
    expect(result.data.members.bob?.runtimePid).toBe(123)
    expect(result.data.members.bob?.evidence.map(item => item.kind)).toEqual([
      'app_managed_bootstrap_context_injected',
    ])
    expect(result.data.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'opencode_app_managed_bootstrap_context_verified',
    )
  })

  test('launch rejects Kiro and Cursor before provider, host, MCP, or member effects', async () => {
    let effects = 0
    openCodeProvisioningProbe.probeRetainingHost = (async () => {
      effects += 1
      throw new Error('host effect')
    }) as typeof openCodeProvisioningProbe.probeRetainingHost
    openCodeExecutionProbe.probeModelOnHost = (async () => {
      effects += 1
      throw new Error('provider effect')
    }) as typeof openCodeExecutionProbe.probeModelOnHost
    openCodeSessionBridge.ensureSession = (async () => {
      effects += 1
      throw new Error('member effect')
    }) as typeof openCodeSessionBridge.ensureSession
    Client.prototype.connect = (async () => { effects += 1 }) as typeof Client.prototype.connect

    for (const providerId of ['kiro', 'cursor-acp']) {
      const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.launchTeam', {
        runId: `run-${providerId}`,
        laneId: 'primary',
        teamId: 'team-a',
        selectedModel: `${providerId}/near-marker-model`,
        members: [{ name: 'alice', prompt: 'Join.' }],
      }))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.message).toContain(
        `launch_runtime does not support extension-bound provider ${providerId}`,
      )
    }
    expect(effects).toBe(0)
  })

  test('rejects launch before creating sessions when the raw selected model is unknown', async () => {
    let ensureSessionCalls = 0
    openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-unknown-model',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'ghost-model',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain(
      'provider-qualified selectedModel',
    )
    expect(ensureSessionCalls).toBe(0)
  })

  test('rejects launch before creating sessions when the provider-scoped selected model is unknown', async () => {
    let ensureSessionCalls = 0
    openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()
    mockUnavailableExactProof()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-unknown-scoped-model',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/ghost-model',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain(
      'selected execution unavailable',
    )
    expect(ensureSessionCalls).toBe(0)
  })

  test('rejects ambiguous raw slash model launches before MCP proof or session creation', async () => {
    let connectCalls = 0
    let listToolsCalls = 0
    let ensureSessionCalls = 0
    openCodeProvisioningProbe.probe = async () =>
      buildReadinessSnapshot({
        configProviders: {
          providers: [
            {
              id: 'openrouter',
              models: {
                'moonshotai/kimi-k2': {},
              },
            },
            {
              id: 'proxy',
              models: {
                'moonshotai/kimi-k2': {},
              },
            },
          ],
          default: {},
        },
        providers: {
          connected: ['openrouter', 'proxy'],
          default: {},
        },
      })
    ;(Client.prototype.connect as unknown as (...args: unknown[]) => Promise<void>) = async () => {
      connectCalls += 1
      throw new Error('MCP proof should not run before ambiguous launch model rejection')
    }
    ;(Client.prototype.listTools as unknown as (...args: unknown[]) => Promise<{ tools: Array<{ name: string }> }>) =
      async () => {
        listToolsCalls += 1
        throw new Error('MCP tools/list should not run before ambiguous launch model rejection')
      }
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-ambiguous-raw-slash-model',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'kimi-k2',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain(
      'provider-qualified selectedModel',
    )
    expect(connectCalls).toBe(0)
    expect(listToolsCalls).toBe(0)
    expect(ensureSessionCalls).toBe(0)
  })

  test('rejects launch model failures before starting MCP tool proof', async () => {
    let connectCalls = 0
    let listToolsCalls = 0
    let ensureSessionCalls = 0
    openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()
    ;(Client.prototype.connect as unknown as (...args: unknown[]) => Promise<void>) = async () => {
      connectCalls += 1
      throw new Error('MCP proof should not run before launch model rejection')
    }
    ;(Client.prototype.listTools as unknown as (...args: unknown[]) => Promise<{ tools: Array<{ name: string }> }>) =
      async () => {
        listToolsCalls += 1
        throw new Error('MCP tools/list should not run before launch model rejection')
      }
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-launch-model-fail-fast',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/ghost-model',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain('MCP proof should not run before launch model rejection')
    expect(connectCalls).toBe(1)
    expect(listToolsCalls).toBe(0)
    expect(ensureSessionCalls).toBe(0)
  })

  test('rejects launch before creating sessions when the selected model provider is disconnected', async () => {
    let ensureSessionCalls = 0
    openCodeProvisioningProbe.probe = async () =>
      buildReadinessSnapshot({
        providers: {
          connected: ['opencode'],
          default: {},
        },
      })
    mockUnavailableExactProof()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-disconnected-scoped-model',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain(
      'selected execution unavailable',
    )
    expect(ensureSessionCalls).toBe(0)
  })

  test('rejects launch provider failures before starting MCP tool proof', async () => {
    let connectCalls = 0
    let listToolsCalls = 0
    let ensureSessionCalls = 0
    openCodeProvisioningProbe.probe = async () =>
      buildReadinessSnapshot({
        providers: {
          connected: ['opencode'],
          default: {},
        },
      })
    ;(Client.prototype.connect as unknown as (...args: unknown[]) => Promise<void>) = async () => {
      connectCalls += 1
      throw new Error('MCP proof should not run before launch provider rejection')
    }
    ;(Client.prototype.listTools as unknown as (...args: unknown[]) => Promise<{ tools: Array<{ name: string }> }>) =
      async () => {
        listToolsCalls += 1
        throw new Error('MCP tools/list should not run before launch provider rejection')
      }
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-launch-provider-fail-fast',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain('MCP proof should not run before launch provider rejection')
    expect(connectCalls).toBe(1)
    expect(listToolsCalls).toBe(0)
    expect(ensureSessionCalls).toBe(0)
  })

  test('rejects launch before probing runtime when duplicate member names are provided', async () => {
    let probeCalls = 0
    let ensureSessionCalls = 0
    openCodeProvisioningProbe.probe = async () => {
      probeCalls += 1
      return buildReadinessSnapshot()
    }
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-duplicate-member',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [
          { name: 'bob', role: 'Developer', prompt: 'Bob side lane join' },
          { name: 'BOB', role: 'Reviewer', prompt: 'Duplicate Bob side lane join' },
        ],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain(
      'opencode.launchTeam members contains duplicate member name "BOB"',
    )
    expect(probeCalls).toBe(0)
    expect(ensureSessionCalls).toBe(0)
  })

  test('rejects launch before probing runtime when a member name is blank', async () => {
    let probeCalls = 0
    let ensureSessionCalls = 0
    openCodeProvisioningProbe.probe = async () => {
      probeCalls += 1
      return buildReadinessSnapshot()
    }
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-blank-member',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: '   ', role: 'Developer', prompt: 'Blank side lane join' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain(
      'opencode.launchTeam members contains member without a valid name at index 0',
    )
    expect(probeCalls).toBe(0)
    expect(ensureSessionCalls).toBe(0)
  })

  test('rejects launch before creating sessions when the raw selected model is ambiguous', async () => {
    let ensureSessionCalls = 0
    openCodeProvisioningProbe.probe = async () =>
      buildReadinessSnapshot({
        configProviders: {
          providers: [
            {
              id: 'openrouter',
              models: {
                'minimax-m2.5-free': {},
              },
            },
            {
              id: 'opencode',
              models: {
                'minimax-m2.5-free': {},
              },
            },
          ],
          default: {},
        },
        providers: {
          connected: ['openrouter', 'opencode'],
          default: {},
        },
      })
    mockUnavailableExactProof()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-ambiguous-model',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain('selected execution unavailable')
    expect(ensureSessionCalls).toBe(0)
  })

  test('rejects launch before creating sessions when Agent Teams MCP is not connected', async () => {
    let ensureSessionCalls = 0
    let promptCalls = 0
    openCodeProvisioningProbe.probe = async () =>
      buildReadinessSnapshot({
        appMcp: null,
      })
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {
      promptCalls += 1
    }) as typeof openCodeSessionBridge.promptAsync

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-missing-mcp',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain(
      'Agent Teams MCP retained connection/contract proof is unavailable',
    )
    expect(ensureSessionCalls).toBe(0)
    expect(promptCalls).toBe(0)
  })

  test('rejects launch with the real host error before model lookup or session creation', async () => {
    let connectCalls = 0
    let ensureSessionCalls = 0
    openCodeProvisioningProbe.probe = async () =>
      buildReadinessSnapshot({
        hostHealthy: false,
        host: null,
        configProviders: null,
        probeError: 'OpenCode host failed health check',
      })
    ;(Client.prototype.connect as unknown as (...args: unknown[]) => Promise<void>) = async () => {
      connectCalls += 1
      throw new Error('MCP proof should not run when host is unhealthy')
    }
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-host-unhealthy',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain('OpenCode host failed health check')
    expect(result.error.message).not.toContain('was not found in the live provider catalog')
    expect(connectCalls).toBe(0)
    expect(ensureSessionCalls).toBe(0)
  })

  test('rejects launch with a disconnected selected provider before MCP proof or session creation', async () => {
    let connectCalls = 0
    let ensureSessionCalls = 0
    openCodeProvisioningProbe.probe = async () =>
      buildReadinessSnapshot({
        providers: {
          connected: [],
          default: {},
        },
      })
    ;(Client.prototype.connect as unknown as (...args: unknown[]) => Promise<void>) = async () => {
      connectCalls += 1
      throw new Error('MCP proof should not run when provider auth is missing')
    }
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-no-providers',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain('MCP proof should not run when provider auth is missing')
    expect(connectCalls).toBe(1)
    expect(ensureSessionCalls).toBe(0)
  })

  test('allows launch for configured authless local models after execution proof', async () => {
    openCodeProvisioningProbe.probe = async () =>
      buildReadinessSnapshot({
        configProviders: {
          providers: [
            {
              id: 'llama.cpp',
              npm: '@ai-sdk/openai-compatible',
              options: { baseURL: 'http://127.0.0.1:8080/v1' },
              models: { 'qwen-test:0.5b': {} },
            },
          ],
          default: {},
        },
        providers: {
          connected: [],
          default: {},
        },
      })
    let probedModelId: string | null = null
    let probedDisposeHostOnRelease: boolean | undefined
    let slimProbeCalls = 0
    let ensureSessionCalls = 0
    openCodeExecutionProbe.probeModel = (async () => {
      slimProbeCalls += 1
      throw new Error('launch proof must stay on the retained host')
    }) as typeof openCodeExecutionProbe.probeModel
    openCodeExecutionProbe.probeModelOnHost = (async input => {
      probedModelId = input.selectedModel
      probedDisposeHostOnRelease = input.disposeHostOnRelease
      return {
        providerId: 'opencode' as const,
        modelId: input.selectedModel,
        observedProviderId: 'llama.cpp',
        observedModelId: 'qwen-test:0.5b',
        probePrompt: 'Output only the single word PONG.',
        expectedOutput: input.expectedOutput ?? '',
        outcome: 'available' as const,
        reason: null,
        durationMs: 1,
        rawStatus: 'idle',
        durableState: 'idle',
        latestAssistantText: input.expectedOutput || 'PONG',
        latestAssistantPreview: input.expectedOutput || 'PONG',
        toolCallCount: 0,
        errorCount: 0,
        diagnostics: [],
      }
    }) as typeof openCodeExecutionProbe.probeModelOnHost
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-local-authless',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'llama.cpp/qwen-test:0.5b',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(probedModelId).toBe('llama.cpp/qwen-test:0.5b')
    expect(probedDisposeHostOnRelease).toBeUndefined()
    expect(slimProbeCalls).toBe(0)
    expect(ensureSessionCalls).toBe(1)
    expect(result.data.teamLaunchState).toBe('launching')
  })

  test('bounds the cross-version launch execution fallback with the command deadline', async () => {
    openCodeProvisioningProbe.probe = async () =>
      buildReadinessSnapshot({
        configProviders: {
          providers: [
            {
              id: 'llama.cpp',
              npm: '@ai-sdk/openai-compatible',
              options: { baseURL: 'http://127.0.0.1:8080/v1' },
              models: { 'qwen-test:0.5b': {} },
            },
          ],
          default: {},
        },
        providers: {
          connected: [],
          default: {},
        },
      })
    let receivedRuntimeDeadline = false
    let ensureSessionCalls = 0
    const hangOnDeadline = (async input => {
      receivedRuntimeDeadline = input.runtimeDeadline !== undefined
      return input.runtimeDeadline!.runPhase(
        'execution_poll',
        () => new Promise(() => {}),
      )
    }) as typeof openCodeExecutionProbe.probeModelOnHost
    openCodeExecutionProbe.probeModelOnHost = hangOnDeadline
    openCodeExecutionProbe.probeModel = hangOnDeadline as typeof openCodeExecutionProbe.probeModel
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    const envelope = buildEnvelope('opencode.launchTeam', {
      runId: 'run-local-authless-timeout',
      laneId: 'secondary:opencode:bob',
      teamId: 'team-a',
      teamName: 'team-a',
      projectPath: '/tmp/project',
      selectedModel: 'llama.cpp/qwen-test:0.5b',
      members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
    })
    envelope.timeoutMs = 20

    const result = await executeOpenCodeBridgeCommandEnvelope(envelope)

    expect(receivedRuntimeDeadline).toBe(false)
    expect(ensureSessionCalls).toBe(0)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('deadline')
  })

  test('allows launch for built-in free OpenCode models without connected providers', async () => {
    openCodeProvisioningProbe.probe = async () =>
      buildReadinessSnapshot({
        models: ['opencode/big-pickle'],
        modelMetadata: [buildModelMetadata('opencode/big-pickle')],
        configProviders: {
          providers: [],
          default: {},
        },
        providers: {
          connected: [],
          default: {},
        },
      })
    let ensureSessionCalls = 0
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-opencode-free',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'opencode/big-pickle',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(ensureSessionCalls).toBe(1)
    expect(result.data.teamLaunchState).toBe('launching')
    expect(result.data.members.bob?.model).toBe('opencode/big-pickle')
    expect(result.data.members.bob?.launchState).toBe('created')
  })

  test('rejects launch for built-in OpenCode models without free metadata when provider is disconnected', async () => {
    openCodeProvisioningProbe.probe = async () =>
      buildReadinessSnapshot({
        models: ['opencode/big-pickle'],
        modelMetadata: [],
        configProviders: {
          providers: [],
          default: {},
        },
        providers: {
          connected: [],
          default: {},
        },
      })
    mockUnavailableExactProof()
    let ensureSessionCalls = 0
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-opencode-no-free-metadata',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'opencode/big-pickle',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain(
      'selected execution unavailable',
    )
    expect(ensureSessionCalls).toBe(0)
  })

  test('rejects launch for paid built-in OpenCode models when provider is disconnected', async () => {
    openCodeProvisioningProbe.probe = async () =>
      buildReadinessSnapshot({
        models: ['opencode/big-pickle'],
        modelMetadata: [buildModelMetadata('opencode/big-pickle', { free: false })],
        configProviders: {
          providers: [],
          default: {},
        },
        providers: {
          connected: [],
          default: {},
        },
      })
    mockUnavailableExactProof()
    let ensureSessionCalls = 0
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-opencode-paid',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'opencode/big-pickle',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain(
      'selected execution unavailable',
    )
    expect(ensureSessionCalls).toBe(0)
  })

  test('rejects launch before creating sessions when the capability snapshot precondition is stale', async () => {
    let ensureSessionCalls = 0
    openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-stale-capability',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        expectedCapabilitySnapshotId: 'opencode:stale-snapshot',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain(
      'OpenCode bridge capability snapshot precondition mismatch',
    )
    expect(ensureSessionCalls).toBe(0)
  })

  test('accepts a fresh launch snapshot after an explicit capability recovery attempt', async () => {
    let ensureSessionCalls = 0
    openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    const originalRefreshSessionEnvironment = openCodeSessionBridge.refreshSessionEnvironment
    openCodeSessionBridge.refreshSessionEnvironment = (async record =>
      record) as typeof openCodeSessionBridge.refreshSessionEnvironment

    let result: Awaited<ReturnType<typeof executeOpenCodeBridgeCommandEnvelope>>
    try {
      result = await executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-recovered-capability',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'team-a',
          projectPath: '/tmp/project',
          selectedModel: 'openrouter/minimax-m2.5-free',
          expectedCapabilitySnapshotId: 'opencode:stale-snapshot',
          capabilitySnapshotRecoveryAttemptId: 'recovery-1',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
        }),
      )
    } finally {
      openCodeSessionBridge.refreshSessionEnvironment = originalRefreshSessionEnvironment
    }

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.members.bob?.launchState).toBe('created')
    expect(result.data.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'opencode_capability_snapshot_recovery',
        severity: 'warning',
      }),
    )
    expect(ensureSessionCalls).toBe(1)
  })

  test('launches with the app-owned manifest high watermark the bridge does not track', async () => {
    // The watermark counts committed batches in the app's own runtime store.
    // The bridge keeps no such store, so a non-zero value is evidence to echo,
    // never a precondition to reject the launch on.
    let ensureSessionCalls = 0
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      summary: buildReconcileSummary({ sessionId: record.opencodeSessionId }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const envelope = buildEnvelope('opencode.launchTeam', {
      runId: 'run-app-manifest-watermark',
      laneId: 'secondary:opencode:bob',
      teamId: 'team-a',
      teamName: 'team-a',
      projectPath: '/tmp/project',
      selectedModel: 'openrouter/minimax-m2.5-free',
      members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
    })
    ;(envelope.body.preconditions as Record<string, unknown>).expectedManifestHighWatermark = 41

    const result = await executeOpenCodeBridgeCommandEnvelope(envelope)

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(ensureSessionCalls).toBe(1)
    expect(result.data).toMatchObject({
      manifestHighWatermark: 41,
      runtimeStoreManifestHighWatermark: 41,
    })
  })

  test('rejects launch before creating sessions when the lane precondition targets another mixed lane', async () => {
    let ensureSessionCalls = 0
    openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-lane-precondition',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        preconditions: {
          handshakeIdentityHash: 'handshake-1',
          laneId: 'secondary:opencode:jack',
          expectedRunId: 'run-lane-precondition',
          expectedCapabilitySnapshotId: null,
          expectedBehaviorFingerprint: expectedFingerprintForModel('openrouter/minimax-m2.5-free'),
          expectedManifestHighWatermark: null,
          commandLeaseId: null,
          idempotencyKey: 'idempotency-lane-mismatch',
        },
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain(
      'OpenCode bridge expected laneId precondition does not match command laneId',
    )
    expect(ensureSessionCalls).toBe(0)
  })

  test('rejects launch before creating sessions when the run id precondition is stale', async () => {
    let ensureSessionCalls = 0
    openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-current',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        preconditions: {
          handshakeIdentityHash: 'handshake-1',
          laneId: 'secondary:opencode:bob',
          expectedRunId: 'run-stale',
          expectedCapabilitySnapshotId: null,
          expectedBehaviorFingerprint: expectedFingerprintForModel('openrouter/minimax-m2.5-free'),
          expectedManifestHighWatermark: null,
          commandLeaseId: null,
          idempotencyKey: 'idempotency-run-mismatch',
        },
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain(
      'OpenCode bridge expectedRunId precondition does not match command runId',
    )
    expect(ensureSessionCalls).toBe(0)
  })

  describe('OpenCode bridge launch matrix safe e2e', () => {
    test('launches a pure OpenCode primary lane with all teammates ready', async () => {
      const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
      const prompts: Array<{ memberName: string; text: string; agent: string }> = []
      openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()
      openCodeSessionBridge.ensureSession = (async input => {
        ensureInputs.push({
          laneId: input.laneId,
          memberName: input.memberName,
          selectedModel: input.selectedModel,
        })
        return buildRecord({
          laneId: input.laneId,
          memberName: input.memberName,
          selectedModel: input.selectedModel,
          opencodeSessionId: `session-${input.memberName}`,
        })
      }) as typeof openCodeSessionBridge.ensureSession
      openCodeSessionBridge.promptAsync = (async (record, input) => {
        prompts.push({
          memberName: record.memberName,
          text: input.text,
          agent: input.agent ?? '',
        })
      }) as typeof openCodeSessionBridge.promptAsync
      openCodeSessionBridge.reconcileSession = (async record => ({
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
          latestAssistantMessageId: `msg-${record.memberName}-ready`,
          latestAssistantText: `${record.memberName} ready`,
        }),
      })) as typeof openCodeSessionBridge.reconcileSession

      const result = await executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-opencode-primary',
          laneId: 'primary',
          teamId: 'team-a',
          teamName: 'team-a',
          projectPath: '/tmp/project',
          selectedModel: 'openrouter/minimax-m2.5-free',
          members: [
            { name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' },
            { name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' },
          ],
        }),
      )

      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      expect(ensureInputs).toEqual([
        {
          laneId: 'primary',
          memberName: 'bob',
          selectedModel: 'openrouter/minimax-m2.5-free',
        },
        {
          laneId: 'primary',
          memberName: 'jack',
          selectedModel: 'openrouter/minimax-m2.5-free',
        },
      ])
      expect(prompts.map(prompt => ({ memberName: prompt.memberName, agent: prompt.agent }))).toEqual([
        { memberName: 'bob', agent: 'teammate-bootstrap' },
        { memberName: 'jack', agent: 'teammate-bootstrap' },
      ])
      expectOpenCodeIdentityPrompt({
        text: prompts[0]?.text ?? '',
        teamName: 'team-a',
        memberName: 'bob',
        runtimeSessionId: 'session-bob',
        runId: 'run-opencode-primary',
        originalPrompt: 'Bob OpenCode join',
      })
      expectOpenCodeIdentityPrompt({
        text: prompts[1]?.text ?? '',
        teamName: 'team-a',
        memberName: 'jack',
        runtimeSessionId: 'session-jack',
        runId: 'run-opencode-primary',
        originalPrompt: 'Jack OpenCode join',
      })
      expect(result.data.teamLaunchState).toBe('launching')
      expect(result.data.members.bob?.launchState).toBe('created')
      expect(result.data.members.jack?.launchState).toBe('created')
      expect(result.data.durableCheckpoints.map(checkpoint => checkpoint.name)).toEqual([
        'required_tools_proven',
        'delivery_ready',
      ])
    })

    test('launches only the mixed-team OpenCode secondary lane member', async () => {
      const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
      openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()
      openCodeSessionBridge.ensureSession = (async input => {
        ensureInputs.push({
          laneId: input.laneId,
          memberName: input.memberName,
          selectedModel: input.selectedModel,
        })
        return buildRecord({
          laneId: input.laneId,
          memberName: input.memberName,
          selectedModel: input.selectedModel,
          opencodeSessionId: `session-${input.memberName}`,
        })
      }) as typeof openCodeSessionBridge.ensureSession
      openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
      openCodeSessionBridge.reconcileSession = (async record => ({
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
          latestAssistantMessageId: `msg-${record.memberName}-ready`,
          latestAssistantText: `${record.memberName} ready`,
        }),
      })) as typeof openCodeSessionBridge.reconcileSession

      const result = await executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-secondary',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'team-a',
          projectPath: '/tmp/project',
          selectedModel: 'openrouter/minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
        }),
      )

      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      expect(ensureInputs).toEqual([
        {
          laneId: 'secondary:opencode:bob',
          memberName: 'bob',
          selectedModel: 'openrouter/minimax-m2.5-free',
        },
      ])
      expect(Object.keys(result.data.members)).toEqual(['bob'])
      expect(result.data.teamLaunchState).toBe('launching')
      expect(result.data.members.bob?.launchState).toBe('created')
      expect(result.data.members.alice).toBeUndefined()
    })

    test('keeps sequential mixed-team OpenCode secondary lanes isolated', async () => {
      const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
      const prompts: Array<{ memberName: string; text: string }> = []
      const readinessSnapshot = buildReadinessSnapshot({
        configProviders: {
          providers: [
            {
              id: 'openrouter',
              models: {
                'minimax-m2.5-free': {},
                'ling-2.6-flash-free': {},
              },
            },
          ],
          default: {
            openrouter: 'minimax-m2.5-free',
          },
        },
      })
      openCodeProvisioningProbe.probe = async () => readinessSnapshot
      openCodeSessionBridge.ensureSession = (async input => {
        ensureInputs.push({
          laneId: input.laneId,
          memberName: input.memberName,
          selectedModel: input.selectedModel,
        })
        return buildRecord({
          laneId: input.laneId,
          memberName: input.memberName,
          selectedModel: input.selectedModel,
          opencodeSessionId: `session-${input.memberName}`,
        })
      }) as typeof openCodeSessionBridge.ensureSession
      openCodeSessionBridge.promptAsync = (async (record, input) => {
        prompts.push({
          memberName: record.memberName,
          text: input.text,
        })
      }) as typeof openCodeSessionBridge.promptAsync
      openCodeSessionBridge.reconcileSession = (async record => ({
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
          latestAssistantMessageId: `msg-${record.memberName}-ready`,
          latestAssistantText: `${record.memberName} ready`,
        }),
      })) as typeof openCodeSessionBridge.reconcileSession

      const bobResult = await executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-secondary-bob',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'team-a',
          projectPath: '/tmp/project',
          selectedModel: 'openrouter/minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
        }),
      )
      const jackResult = await executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-secondary-jack',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'team-a',
          projectPath: '/tmp/project',
          selectedModel: 'openrouter/ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Developer', prompt: 'Jack side lane join' }],
        }),
      )

      expect(bobResult.ok).toBe(true)
      expect(jackResult.ok).toBe(true)
      if (!bobResult.ok || !jackResult.ok) {
        return
      }
      expect(ensureInputs).toEqual([
        {
          laneId: 'secondary:opencode:bob',
          memberName: 'bob',
          selectedModel: 'openrouter/minimax-m2.5-free',
        },
        {
          laneId: 'secondary:opencode:jack',
          memberName: 'jack',
          selectedModel: 'openrouter/ling-2.6-flash-free',
        },
      ])
      expect(prompts.map(prompt => prompt.memberName)).toEqual(['bob', 'jack'])
      expectOpenCodeIdentityPrompt({
        text: prompts[0]?.text ?? '',
        teamName: 'team-a',
        memberName: 'bob',
        runtimeSessionId: 'session-bob',
        runId: 'run-mixed-secondary-bob',
        originalPrompt: 'Bob side lane join',
      })
      expectOpenCodeIdentityPrompt({
        text: prompts[1]?.text ?? '',
        teamName: 'team-a',
        memberName: 'jack',
        runtimeSessionId: 'session-jack',
        runId: 'run-mixed-secondary-jack',
        originalPrompt: 'Jack side lane join',
      })
      expect(Object.keys(bobResult.data.members)).toEqual(['bob'])
      expect(Object.keys(jackResult.data.members)).toEqual(['jack'])
      expect(bobResult.data.members.jack).toBeUndefined()
      expect(jackResult.data.members.bob).toBeUndefined()
      expect(bobResult.data.teamLaunchState).toBe('launching')
      expect(jackResult.data.teamLaunchState).toBe('launching')
    })

    test('keeps failed and ready mixed-team OpenCode secondary lane launches isolated', async () => {
      const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
      const readinessSnapshot = buildReadinessSnapshot({
        configProviders: {
          providers: [
            {
              id: 'openrouter',
              models: {
                'minimax-m2.5-free': {},
                'ling-2.6-flash-free': {},
              },
            },
          ],
          default: {
            openrouter: 'minimax-m2.5-free',
          },
        },
      })
      openCodeProvisioningProbe.probe = async () => readinessSnapshot
      openCodeSessionBridge.ensureSession = (async input => {
        ensureInputs.push({
          laneId: input.laneId,
          memberName: input.memberName,
          selectedModel: input.selectedModel,
        })
        return buildRecord({
          laneId: input.laneId,
          memberName: input.memberName,
          selectedModel: input.selectedModel,
          opencodeSessionId: `session-${input.memberName}`,
        })
      }) as typeof openCodeSessionBridge.ensureSession
      openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
      openCodeSessionBridge.reconcileSession = (async record => ({
        summary:
          record.memberName === 'bob'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              staleReason: 'bob bootstrap session disappeared',
              errorCount: 1,
              diagnostics: ['bob bootstrap session disappeared'],
            })
            : buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: `msg-${record.memberName}-ready`,
              latestAssistantText: `${record.memberName} ready`,
            }),
      })) as typeof openCodeSessionBridge.reconcileSession

      const bobResult = await executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-secondary-bob',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'team-a',
          projectPath: '/tmp/project',
          selectedModel: 'openrouter/minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
        }),
      )
      const jackResult = await executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-secondary-jack',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'team-a',
          projectPath: '/tmp/project',
          selectedModel: 'openrouter/ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Developer', prompt: 'Jack side lane join' }],
        }),
      )

      expect(bobResult.ok).toBe(true)
      expect(jackResult.ok).toBe(true)
      if (!bobResult.ok || !jackResult.ok) {
        return
      }
      expect(ensureInputs).toEqual([
        {
          laneId: 'secondary:opencode:bob',
          memberName: 'bob',
          selectedModel: 'openrouter/minimax-m2.5-free',
        },
        {
          laneId: 'secondary:opencode:jack',
          memberName: 'jack',
          selectedModel: 'openrouter/ling-2.6-flash-free',
        },
      ])
      expect(Object.keys(bobResult.data.members)).toEqual(['bob'])
      expect(Object.keys(jackResult.data.members)).toEqual(['jack'])
      expect(bobResult.data.teamLaunchState).toBe('launching')
      expect(bobResult.data.members.bob?.launchState).toBe('created')
      expect(jackResult.data.teamLaunchState).toBe('launching')
      expect(jackResult.data.members.jack?.launchState).toBe('created')
      expect(jackResult.data.members.bob).toBeUndefined()
    })

    test('keeps permission-blocked and ready mixed-team OpenCode secondary lane launches isolated', async () => {
      const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
      const readinessSnapshot = buildReadinessSnapshot({
        configProviders: {
          providers: [
            {
              id: 'openrouter',
              models: {
                'minimax-m2.5-free': {},
                'ling-2.6-flash-free': {},
              },
            },
          ],
          default: {
            openrouter: 'minimax-m2.5-free',
          },
        },
      })
      openCodeProvisioningProbe.probe = async () => readinessSnapshot
      openCodeSessionBridge.ensureSession = (async input => {
        ensureInputs.push({
          laneId: input.laneId,
          memberName: input.memberName,
          selectedModel: input.selectedModel,
        })
        return buildRecord({
          laneId: input.laneId,
          memberName: input.memberName,
          selectedModel: input.selectedModel,
          opencodeSessionId: `session-${input.memberName}`,
        })
      }) as typeof openCodeSessionBridge.ensureSession
      openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
      openCodeSessionBridge.reconcileSession = (async record => ({
        summary:
          record.memberName === 'bob'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-bob', 'perm-bob'],
              diagnostics: ['bob waiting for permission'],
              messages: [],
            })
            : buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: `msg-${record.memberName}-ready`,
              latestAssistantText: `${record.memberName} ready`,
            }),
      })) as typeof openCodeSessionBridge.reconcileSession

      const bobResult = await executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-secondary-bob',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'team-a',
          projectPath: '/tmp/project',
          selectedModel: 'openrouter/minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
        }),
      )
      const jackResult = await executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-secondary-jack',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'team-a',
          projectPath: '/tmp/project',
          selectedModel: 'openrouter/ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Developer', prompt: 'Jack side lane join' }],
        }),
      )

      expect(bobResult.ok).toBe(true)
      expect(jackResult.ok).toBe(true)
      if (!bobResult.ok || !jackResult.ok) {
        return
      }
      expect(ensureInputs).toEqual([
        {
          laneId: 'secondary:opencode:bob',
          memberName: 'bob',
          selectedModel: 'openrouter/minimax-m2.5-free',
        },
        {
          laneId: 'secondary:opencode:jack',
          memberName: 'jack',
          selectedModel: 'openrouter/ling-2.6-flash-free',
        },
      ])
      expect(Object.keys(bobResult.data.members)).toEqual(['bob'])
      expect(Object.keys(jackResult.data.members)).toEqual(['jack'])
      expect(bobResult.data.teamLaunchState).toBe('launching')
      expect(bobResult.data.members.bob?.launchState).toBe('created')
      expect(bobResult.data.members.bob?.pendingPermissionRequestIds).toBeUndefined()
      expect(jackResult.data.teamLaunchState).toBe('launching')
      expect(jackResult.data.members.jack?.launchState).toBe('created')
      expect(jackResult.data.members.bob).toBeUndefined()
    })

    test('reconciles sequential mixed-team OpenCode secondary lanes independently', async () => {
      const getCalls: Array<{ teamId: string; laneId: string; memberName: string }> = []
      const reconciledMembers: string[] = []
      openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()
      openCodeSessionStore.get = (async (teamId, laneIdOrMemberName, memberName) => {
        const laneId = memberName ? laneIdOrMemberName : 'primary'
        const resolvedMemberName = memberName ?? laneIdOrMemberName
        getCalls.push({
          teamId,
          laneId,
          memberName: resolvedMemberName,
        })
        return buildRecord({
          laneId,
          memberName: resolvedMemberName,
          selectedModel: resolvedMemberName === 'jack'
            ? 'openrouter/ling-2.6-flash-free'
            : 'openrouter/minimax-m2.5-free',
          opencodeSessionId: `session-${resolvedMemberName}`,
        })
      }) as typeof openCodeSessionStore.get
      openCodeSessionBridge.reconcileSession = (async record => {
        reconciledMembers.push(record.memberName)
        return {
          summary: buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: `msg-${record.memberName}-ready`,
            latestAssistantText: `${record.memberName} ready`,
          }),
        }
      }) as typeof openCodeSessionBridge.reconcileSession

      const bobResult = await executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-secondary-bob',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'team-a',
          expectedMembers: [{ name: 'bob', model: 'openrouter/minimax-m2.5-free' }],
        }),
      )
      const jackResult = await executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-secondary-jack',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'team-a',
          expectedMembers: [{ name: 'jack', model: 'openrouter/ling-2.6-flash-free' }],
        }),
      )

      expect(bobResult.ok).toBe(true)
      expect(jackResult.ok).toBe(true)
      if (!bobResult.ok || !jackResult.ok) {
        return
      }
      expect(getCalls).toEqual([
        {
          teamId: 'team-a',
          laneId: 'secondary:opencode:bob',
          memberName: 'bob',
        },
        {
          teamId: 'team-a',
          laneId: 'secondary:opencode:jack',
          memberName: 'jack',
        },
      ])
      expect(reconciledMembers).toEqual(['bob', 'jack'])
      expect(Object.keys(bobResult.data.members)).toEqual(['bob'])
      expect(Object.keys(jackResult.data.members)).toEqual(['jack'])
      expect(bobResult.data.diagnostics).toEqual([])
      expect(jackResult.data.diagnostics).toEqual([])
      expect(bobResult.data.teamLaunchState).toBe('ready')
      expect(jackResult.data.teamLaunchState).toBe('ready')
    })

    test('rejects stale mixed-team OpenCode reconcile lane preconditions before reading sessions', async () => {
      const getCalls: Array<{ teamId: string; laneId: string; memberName: string }> = []
      openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()
      openCodeSessionStore.get = (async (teamId, laneIdOrMemberName, memberName) => {
        getCalls.push({
          teamId,
          laneId: memberName ? laneIdOrMemberName : 'primary',
          memberName: memberName ?? laneIdOrMemberName,
        })
        return buildRecord({
          laneId: memberName ? laneIdOrMemberName : 'primary',
          memberName: memberName ?? laneIdOrMemberName,
          opencodeSessionId: `session-${memberName ?? laneIdOrMemberName}`,
        })
      }) as typeof openCodeSessionStore.get

      const result = await executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-secondary-bob',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'team-a',
          preconditions: {
            handshakeIdentityHash: 'handshake-1',
            laneId: 'secondary:opencode:jack',
            expectedRunId: 'run-mixed-secondary-bob',
            expectedCapabilitySnapshotId: null,
            expectedBehaviorFingerprint: null,
            expectedManifestHighWatermark: null,
            commandLeaseId: null,
            idempotencyKey: 'idempotency-reconcile-lane-mismatch',
          },
          expectedMembers: [{ name: 'bob', model: 'openrouter/minimax-m2.5-free' }],
        }),
      )

      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error.message).toContain(
        'OpenCode bridge expected laneId precondition does not match command laneId',
      )
      expect(getCalls).toEqual([])
    })

    test('rejects stale mixed-team OpenCode reconcile run preconditions before reading sessions', async () => {
      const getCalls: Array<{ teamId: string; laneId: string; memberName: string }> = []
      openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()
      openCodeSessionStore.get = (async (teamId, laneIdOrMemberName, memberName) => {
        getCalls.push({
          teamId,
          laneId: memberName ? laneIdOrMemberName : 'primary',
          memberName: memberName ?? laneIdOrMemberName,
        })
        return buildRecord({
          laneId: memberName ? laneIdOrMemberName : 'primary',
          memberName: memberName ?? laneIdOrMemberName,
          opencodeSessionId: `session-${memberName ?? laneIdOrMemberName}`,
        })
      }) as typeof openCodeSessionStore.get

      const result = await executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-current',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'team-a',
          preconditions: {
            handshakeIdentityHash: 'handshake-1',
            laneId: 'secondary:opencode:bob',
            expectedRunId: 'run-stale',
            expectedCapabilitySnapshotId: null,
            expectedBehaviorFingerprint: null,
            expectedManifestHighWatermark: null,
            commandLeaseId: null,
            idempotencyKey: 'idempotency-reconcile-run-mismatch',
          },
          expectedMembers: [{ name: 'bob', model: 'openrouter/minimax-m2.5-free' }],
        }),
      )

      expect(result.ok).toBe(false)
      if (result.ok) {
        return
      }
      expect(result.error.message).toContain(
        'OpenCode bridge expectedRunId precondition does not match command runId',
      )
      expect(getCalls).toEqual([])
    })

    test('keeps failed and ready mixed-team OpenCode secondary lane reconciles isolated', async () => {
      const getCalls: Array<{ teamId: string; laneId: string; memberName: string }> = []
      openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()
      openCodeSessionStore.get = (async (teamId, laneIdOrMemberName, memberName) => {
        const laneId = memberName ? laneIdOrMemberName : 'primary'
        const resolvedMemberName = memberName ?? laneIdOrMemberName
        getCalls.push({
          teamId,
          laneId,
          memberName: resolvedMemberName,
        })
        return buildRecord({
          laneId,
          memberName: resolvedMemberName,
          selectedModel: resolvedMemberName === 'jack'
            ? 'openrouter/ling-2.6-flash-free'
            : 'openrouter/minimax-m2.5-free',
          opencodeSessionId: `session-${resolvedMemberName}`,
        })
      }) as typeof openCodeSessionStore.get
      openCodeSessionBridge.reconcileSession = (async record => ({
        summary:
          record.memberName === 'bob'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              staleReason: 'bob runtime state missing',
              errorCount: 1,
              diagnostics: ['bob runtime state missing'],
            })
            : buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: 'msg-jack-ready',
              latestAssistantText: 'jack ready',
            }),
      })) as typeof openCodeSessionBridge.reconcileSession

      const bobResult = await executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-secondary-bob',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'team-a',
          expectedMembers: [{ name: 'bob', model: 'openrouter/minimax-m2.5-free' }],
        }),
      )
      const jackResult = await executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-secondary-jack',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'team-a',
          expectedMembers: [{ name: 'jack', model: 'openrouter/ling-2.6-flash-free' }],
        }),
      )

      expect(bobResult.ok).toBe(true)
      expect(jackResult.ok).toBe(true)
      if (!bobResult.ok || !jackResult.ok) {
        return
      }
      expect(getCalls).toEqual([
        {
          teamId: 'team-a',
          laneId: 'secondary:opencode:bob',
          memberName: 'bob',
        },
        {
          teamId: 'team-a',
          laneId: 'secondary:opencode:jack',
          memberName: 'jack',
        },
      ])
      expect(Object.keys(bobResult.data.members)).toEqual(['bob'])
      expect(Object.keys(jackResult.data.members)).toEqual(['jack'])
      expect(bobResult.data.teamLaunchState).toBe('failed')
      expect(bobResult.data.members.bob?.launchState).toBe('failed')
      expect(jackResult.data.teamLaunchState).toBe('ready')
      expect(jackResult.data.members.jack?.launchState).toBe('confirmed_alive')
      expect(jackResult.data.members.bob).toBeUndefined()
    })

    test('treats app-managed reconcile without old bootstrap tool calls as confirmed alive', async () => {
      openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()
      openCodeSessionStore.get = (async (teamId, laneIdOrMemberName, memberName) =>
        buildRecord({
          teamId,
          laneId: memberName ? laneIdOrMemberName : 'primary',
          memberName: memberName ?? laneIdOrMemberName,
          opencodeSessionId: `session-${memberName ?? laneIdOrMemberName}`,
        })) as typeof openCodeSessionStore.get
      openCodeSessionBridge.reconcileSession = (async record => ({
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
          latestAssistantMessageId: 'msg-no-bootstrap-tools',
          latestAssistantText: 'ready without legacy bootstrap proof',
          messages: [
            buildCanonicalMessage({
              id: 'msg-no-bootstrap-tools',
              role: 'assistant',
              text: 'ready without legacy bootstrap proof',
              toolCalls: [],
            }),
          ],
          toolCallCount: 0,
        }),
      })) as typeof openCodeSessionBridge.reconcileSession

      const result = await executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-app-managed-reconcile',
          laneId: 'secondary:opencode:alice',
          teamId: 'team-a',
          teamName: 'team-a',
          expectedMembers: [{ name: 'alice', model: 'openrouter/minimax-m2.5-free' }],
        }),
      )

      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      expect(result.data.teamLaunchState).toBe('ready')
      expect(result.data.members.alice?.launchState).toBe('confirmed_alive')
      expect(result.data.members.alice?.bootstrapMode).toBe('app_managed_context')
      expect(result.data.members.alice?.bootstrapEvidenceSource).toBe('app_managed_bootstrap')
      expect(result.data.members.alice?.diagnostics ?? []).not.toContain(
        'OpenCode bootstrap MCP did not complete required tools before assistant response: runtime_bootstrap_checkin, member_briefing',
      )
      expect(result.data.members.alice?.evidence.map(entry => entry.kind)).toEqual([
        'member_session_recorded',
        'bootstrap_confirmed',
        'member_ready',
      ])
    })

    test('resolves inconsistent app-managed reconcile source from bootstrap mode', async () => {
      openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()
      openCodeSessionStore.get = (async (teamId, laneIdOrMemberName, memberName) =>
        buildRecord({
          teamId,
          laneId: memberName ? laneIdOrMemberName : 'primary',
          memberName: memberName ?? laneIdOrMemberName,
          opencodeSessionId: `session-${memberName ?? laneIdOrMemberName}`,
          bootstrapMode: 'app_managed_context',
          bootstrapEvidenceSource: 'runtime_bootstrap_checkin',
        })) as typeof openCodeSessionStore.get
      openCodeSessionBridge.reconcileSession = (async record => ({
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
          latestAssistantMessageId: 'msg-no-bootstrap-tools',
          messages: [
            buildCanonicalMessage({
              id: 'msg-no-bootstrap-tools',
              role: 'assistant',
              toolCalls: [],
            }),
          ],
          toolCallCount: 0,
        }),
      })) as typeof openCodeSessionBridge.reconcileSession

      const result = await executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-app-managed-inconsistent-source',
          laneId: 'secondary:opencode:alice',
          teamId: 'team-a',
          teamName: 'team-a',
          expectedMembers: [{ name: 'alice', model: 'openrouter/minimax-m2.5-free' }],
        }),
      )

      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      expect(result.data.members.alice?.bootstrapMode).toBe('app_managed_context')
      expect(result.data.members.alice?.bootstrapEvidenceSource).toBe('app_managed_bootstrap')
      expect(result.data.members.alice?.launchState).toBe('confirmed_alive')
    })

    test('keeps a multi-member OpenCode lane launching until every member confirms bootstrap', async () => {
      openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()
      openCodeSessionBridge.ensureSession = (async input =>
        buildRecord({
          laneId: input.laneId,
          memberName: input.memberName,
          selectedModel: input.selectedModel,
          opencodeSessionId: `session-${input.memberName}`,
        })) as typeof openCodeSessionBridge.ensureSession
      openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
      openCodeSessionBridge.reconcileSession = (async record => ({
        summary:
          record.memberName === 'bob'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: 'msg-bob-ready',
              latestAssistantText: 'bob ready',
            })
            : buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'idle',
              messages: [],
            }),
      })) as typeof openCodeSessionBridge.reconcileSession

      const result = await executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-opencode-partial',
          laneId: 'primary',
          teamId: 'team-a',
          teamName: 'team-a',
          projectPath: '/tmp/project',
          selectedModel: 'openrouter/minimax-m2.5-free',
          members: [
            { name: 'bob', role: 'Developer', prompt: 'Bob join' },
            { name: 'tom', role: 'Developer', prompt: 'Tom join' },
          ],
        }),
      )

      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      expect(result.data.teamLaunchState).toBe('launching')
      expect(result.data.members.bob?.launchState).toBe('created')
      expect(result.data.members.tom?.launchState).toBe('created')
      expect(result.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
        'run_ready',
      )
    })
  })

  test('includes pending permission request ids for permission-blocked launch members', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionBridge.ensureSession = (async input =>
      buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
      })) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: null,
        latestAssistantText: null,
        latestAssistantPreview: null,
        messageCount: 0,
        durableState: 'blocked',
        pendingPermissionRequestIds: ['perm-1', 'perm-1', 'perm-2'],
        diagnostics: ['waiting for permission approval'],
        messages: [],
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-1',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'alice', role: 'Developer', prompt: 'Join the team' }],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.teamLaunchState).toBe('launching')
    expect(result.data.members.alice?.launchState).toBe('created')
    expect(result.data.members.alice?.pendingPermissionRequestIds).toBeUndefined()
    expect(result.data.members.alice?.diagnostics).toEqual([
      'OpenCode app-managed bootstrap context was injected and verified.',
    ])
  })

  test('includes permission-blocked evidence when durable state is blocked before request ids materialize', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionBridge.ensureSession = (async input =>
      buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
      })) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: null,
        latestAssistantText: null,
        latestAssistantPreview: null,
        messageCount: 0,
        durableState: 'blocked',
        pendingPermissionRequestIds: [],
        messages: [],
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-1',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/minimax-m2.5-free',
        members: [{ name: 'alice', role: 'Developer', prompt: 'Join the team' }],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.members.alice?.launchState).toBe('created')
    expect(result.data.members.alice?.evidence.map(entry => entry.kind)).toContain(
      'app_managed_bootstrap_context_injected',
    )
  })

  test('reconciles only the addressed lane members', async () => {
    const getCalls: Array<{ teamId: string; laneId: string; memberName: string }> = []
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async (teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getCalls.push({
        teamId,
        laneId,
        memberName: resolvedMemberName,
      })
      return buildRecord({
        laneId,
        memberName: resolvedMemberName,
        opencodeSessionId: `session-${resolvedMemberName}`,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => ({
      summary: buildReconcileSummary({ sessionId: record.opencodeSessionId }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-1',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        expectedMembers: [{ name: 'alice', model: 'openrouter/minimax-m2.5-free' }],
      }),
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(
        (result.data as { members: Record<string, { runtimePid?: number }> }).members.alice
          ?.runtimePid,
      ).toBe(123)
    }
    expect(getCalls).toEqual([
      {
        teamId: 'team-a',
        laneId: 'secondary:opencode:alice',
        memberName: 'alice',
      },
    ])
  })

  test('rejects reconcile before probing runtime when duplicate expected member names are provided', async () => {
    let probeCalls = 0
    const getCalls: string[] = []
    const reconcileCalls: string[] = []
    openCodeProvisioningProbe.probe = async () => {
      probeCalls += 1
      return snapshot
    }
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      getCalls.push(memberName ?? laneIdOrMemberName)
      return buildRecord({
        laneId: memberName ? laneIdOrMemberName : 'primary',
        memberName: memberName ?? laneIdOrMemberName,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconcileCalls.push(record.memberName)
      return {
        summary: buildReconcileSummary({ sessionId: record.opencodeSessionId }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-duplicate-reconcile',
        laneId: 'secondary:opencode:mixed',
        teamId: 'team-a',
        teamName: 'team-a',
        expectedMembers: [
          { name: 'bob', model: 'openrouter/minimax-m2.5-free' },
          { name: 'Bob', model: 'openrouter/minimax-m2.5-free' },
        ],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain(
      'opencode.reconcileTeam expectedMembers contains duplicate member name "Bob"',
    )
    expect(probeCalls).toBe(0)
    expect(getCalls).toEqual([])
    expect(reconcileCalls).toEqual([])
  })

  test('rejects reconcile before probing runtime when an expected member name is blank', async () => {
    let probeCalls = 0
    const getCalls: string[] = []
    const reconcileCalls: string[] = []
    openCodeProvisioningProbe.probe = async () => {
      probeCalls += 1
      return snapshot
    }
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      getCalls.push(memberName ?? laneIdOrMemberName)
      return buildRecord({
        laneId: memberName ? laneIdOrMemberName : 'primary',
        memberName: memberName ?? laneIdOrMemberName,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconcileCalls.push(record.memberName)
      return {
        summary: buildReconcileSummary({ sessionId: record.opencodeSessionId }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-blank-reconcile',
        laneId: 'secondary:opencode:mixed',
        teamId: 'team-a',
        teamName: 'team-a',
        expectedMembers: [{ name: ' ', model: 'openrouter/minimax-m2.5-free' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain(
      'opencode.reconcileTeam expectedMembers contains member without a valid name at index 0',
    )
    expect(probeCalls).toBe(0)
    expect(getCalls).toEqual([])
    expect(reconcileCalls).toEqual([])
  })

  test('keeps OpenCode peers visible when one reconcile member throws', async () => {
    const getCalls: string[] = []
    const reconcileCalls: string[] = []
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getCalls.push(resolvedMemberName)
      return buildRecord({
        laneId: memberName ? laneIdOrMemberName : 'primary',
        memberName: resolvedMemberName,
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid:
          resolvedMemberName === 'alice'
            ? 901
            : resolvedMemberName === 'bob'
              ? 902
              : 903,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconcileCalls.push(record.memberName)
      if (record.memberName === 'bob') {
        throw new Error('bob reconcile failed')
      }
      return {
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
          latestAssistantMessageId: `msg-${record.memberName}-ready`,
          latestAssistantText: `${record.memberName} ready`,
        }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-1',
        laneId: 'secondary:opencode:mixed',
        teamId: 'team-a',
        teamName: 'team-a',
        expectedMembers: [
          { name: 'alice', model: 'openrouter/minimax-m2.5-free' },
          { name: 'bob', model: 'openrouter/minimax-m2.5-free' },
          { name: 'zoe', model: 'openrouter/minimax-m2.5-free' },
        ],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(getCalls).toEqual(['alice', 'bob', 'zoe'])
    expect(reconcileCalls).toEqual(['alice', 'bob', 'zoe'])
    expect(result.data.teamLaunchState).toBe('failed')
    expect(result.data.members.alice?.launchState).toBe('confirmed_alive')
    expect(result.data.members.alice?.runtimePid).toBe(901)
    expect(result.data.members.bob).toMatchObject({
      sessionId: 'session-bob',
      launchState: 'failed',
      runtimePid: 902,
      diagnostics: ['bob reconcile failed'],
    })
    expect(result.data.members.bob?.evidence.map(entry => entry.kind)).toEqual([
      'member_reconcile_failed',
    ])
    expect(result.data.members.zoe?.launchState).toBe('confirmed_alive')
    expect(result.data.members.zoe?.runtimePid).toBe(903)
    expect(result.data.diagnostics).toContainEqual({
      code: 'member_reconcile_failed',
      message: 'bob: bob reconcile failed',
      severity: 'error',
    })
  })

  test('uses the reconciled OpenCode runtime pid before stored record and host fallback', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async (teamId, laneIdOrMemberName, memberName) =>
      buildRecord({
        teamId,
        laneId: memberName ? laneIdOrMemberName : 'primary',
        memberName: memberName ?? laneIdOrMemberName,
        opencodeSessionId: `session-${memberName ?? laneIdOrMemberName}`,
        runtimePid: 555,
      })) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => ({
      record: {
        ...record,
        runtimePid: 888,
      },
      summary: buildReconcileSummary({ sessionId: record.opencodeSessionId }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-1',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        expectedMembers: [{ name: 'alice', model: 'openrouter/minimax-m2.5-free' }],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.members.alice?.runtimePid).toBe(888)
  })

  test('marks an app-managed reconciled lane ready from persisted injection evidence without assistant response', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async (teamId, laneIdOrMemberName, memberName) =>
      buildRecord({
        laneId: memberName ? laneIdOrMemberName : 'primary',
        memberName: memberName ?? laneIdOrMemberName,
        opencodeSessionId: `session-${memberName ?? laneIdOrMemberName}`,
        bootstrapMode: 'app_managed_context',
        bootstrapEvidenceSource: 'app_managed_bootstrap',
        appManagedBootstrap: {
          schemaVersion: 1,
          messageID: 'msg-app-managed-bootstrap',
          contextHash: 'context-hash',
          briefingHash: 'briefing-hash',
          injectionVerifiedAt: '2026-04-21T12:00:00.000Z',
          model: 'openrouter/minimax-m2.5-free',
          agent: 'teammate-bootstrap',
        },
      })) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => ({
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: null,
        latestAssistantText: null,
        latestAssistantPreview: null,
        messageCount: 0,
        durableState: 'idle',
        messages: [],
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-1',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        expectedMembers: [{ name: 'alice', model: 'openrouter/minimax-m2.5-free' }],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.teamLaunchState).toBe('ready')
    expect(result.data.members.alice?.launchState).toBe('confirmed_alive')
    expect(result.data.members.alice?.evidence.map(entry => entry.kind)).toEqual([
      'member_session_recorded',
      'app_managed_bootstrap_context_injected',
      'bootstrap_confirmed',
      'member_ready',
    ])
  })

  test('keeps app-managed reconcile launching without injection evidence or assistant response', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async (teamId, laneIdOrMemberName, memberName) =>
      buildRecord({
        laneId: memberName ? laneIdOrMemberName : 'primary',
        memberName: memberName ?? laneIdOrMemberName,
        opencodeSessionId: `session-${memberName ?? laneIdOrMemberName}`,
      })) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => ({
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: null,
        latestAssistantText: null,
        latestAssistantPreview: null,
        messageCount: 0,
        durableState: 'idle',
        messages: [],
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-app-managed-no-readiness-evidence',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        expectedMembers: [{ name: 'alice', model: 'openrouter/minimax-m2.5-free' }],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.teamLaunchState).toBe('launching')
    expect(result.data.members.alice?.launchState).toBe('created')
    expect(result.data.members.alice?.evidence.map(entry => entry.kind)).toEqual([
      'member_session_recorded',
    ])
  })

  test('keeps reconcile aggregate launching when an expected lane member has no session record yet', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async (_teamId, _laneId, memberName) => {
      if (memberName === 'bob') {
        return null
      }
      return buildRecord({
        laneId: 'secondary:opencode:mixed',
        memberName: memberName ?? 'alice',
        opencodeSessionId: `session-${memberName ?? 'alice'}`,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => ({
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: 'msg-ready',
        latestAssistantText: 'ready',
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-1',
        laneId: 'secondary:opencode:mixed',
        teamId: 'team-a',
        teamName: 'team-a',
        expectedMembers: [
          { name: 'alice', model: 'openrouter/minimax-m2.5-free' },
          { name: 'bob', model: 'openrouter/minimax-m2.5-free' },
        ],
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.teamLaunchState).toBe('launching')
    expect(result.data.members.alice?.launchState).toBe('confirmed_alive')
    expect(result.data.members.bob).toBeUndefined()
    expect(result.data.diagnostics).toEqual([
      {
        code: 'member_session_missing',
        message: 'No stored OpenCode session for team-a/bob',
        severity: 'warning',
      },
    ])
    expect(result.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )
  })

  test('stops only the addressed lane', async () => {
    const abortedMembers: string[] = []
    const releasedMembers: string[] = []
    let cleanupInput: unknown = null
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.list = (async () => [
      buildRecord({ laneId: 'secondary:opencode:alice', memberName: 'alice' }),
      buildRecord({ laneId: 'secondary:opencode:bob', memberName: 'bob', opencodeSessionId: 'session-bob' }),
    ]) as typeof openCodeSessionStore.list
    openCodeSessionBridge.abort = (async record => {
      abortedMembers.push(record.memberName)
      return true
    }) as typeof openCodeSessionBridge.abort
    openCodeSessionBridge.releaseSession = (async record => {
      releasedMembers.push(record.memberName)
    }) as typeof openCodeSessionBridge.releaseSession
    openCodeHostManager.reconcilePersistentHosts = (async (input) => {
      cleanupInput = input
      return {
        cleaned: 1,
        remaining: 0,
        hosts: [
          {
            hostKey: 'host-key',
            projectPath: '/tmp/project',
            pid: 43116,
            port: 43116,
            action: 'disposed',
            reason: 'stale host has no active leases during stopTeam',
            leaseCount: 0,
          },
        ],
        diagnostics: [],
      }
    }) as typeof openCodeHostManager.reconcilePersistentHosts

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.stopTeam', {
        runId: 'run-1',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
      }),
    )

    expect(result.ok).toBe(true)
    expect(abortedMembers).toEqual(['alice'])
    expect(releasedMembers).toEqual(['alice'])
    expect(cleanupInput).toEqual({
      mode: 'stale',
      reason: 'stopTeam',
      projectPath: '/tmp/project',
      staleAgeMs: 0,
      leaseStaleAgeMs: null,
      preflightLeaseStaleAgeMs: null,
    })
    if (result.ok) {
      expect(result.data.diagnostics).toEqual([
        {
          code: 'opencode_host_cleanup',
          severity: 'info',
          message: 'Disposed 1 OpenCode host without active leases for /tmp/project',
        },
      ])
    }
  })

  test('keeps stop failures isolated to the addressed mixed OpenCode secondary lane', async () => {
    const abortedMembers: string[] = []
    const releasedMembers: string[] = []
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.list = (async () => [
      buildRecord({
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        opencodeSessionId: 'session-bob',
      }),
      buildRecord({
        laneId: 'secondary:opencode:jack',
        memberName: 'jack',
        opencodeSessionId: 'session-jack',
      }),
    ]) as typeof openCodeSessionStore.list
    openCodeSessionBridge.abort = (async record => {
      abortedMembers.push(record.memberName)
      throw new Error('bob abort failed')
    }) as typeof openCodeSessionBridge.abort
    openCodeSessionBridge.releaseSession = (async record => {
      releasedMembers.push(record.memberName)
    }) as typeof openCodeSessionBridge.releaseSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.stopTeam', {
        runId: 'run-1',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.stopped).toBe(false)
    expect(Object.keys(result.data.members)).toEqual(['bob'])
    expect(result.data.members.bob).toEqual({
      sessionId: 'session-bob',
      stopped: false,
      diagnostics: ['bob abort failed'],
    })
    expect(result.data.members.jack).toBeUndefined()
    expect(abortedMembers).toEqual(['bob'])
    expect(releasedMembers).toEqual([])
  })

  test('rejects stale mixed OpenCode stop lane preconditions before listing sessions', async () => {
    let listCalls = 0
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.list = (async () => {
      listCalls += 1
      return [
        buildRecord({
          laneId: 'secondary:opencode:bob',
          memberName: 'bob',
          opencodeSessionId: 'session-bob',
        }),
      ]
    }) as typeof openCodeSessionStore.list

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.stopTeam', {
        runId: 'run-stop-bob',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        preconditions: {
          handshakeIdentityHash: 'handshake-1',
          laneId: 'secondary:opencode:jack',
          expectedRunId: 'run-stop-bob',
          expectedCapabilitySnapshotId: null,
          expectedBehaviorFingerprint: null,
          expectedManifestHighWatermark: null,
          commandLeaseId: null,
          idempotencyKey: 'idempotency-stop-lane-mismatch',
        },
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain(
      'OpenCode bridge expected laneId precondition does not match command laneId',
    )
    expect(listCalls).toBe(0)
  })

  test('rejects stale mixed OpenCode stop run preconditions before listing sessions', async () => {
    let listCalls = 0
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.list = (async () => {
      listCalls += 1
      return [
        buildRecord({
          laneId: 'secondary:opencode:bob',
          memberName: 'bob',
          opencodeSessionId: 'session-bob',
        }),
      ]
    }) as typeof openCodeSessionStore.list

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.stopTeam', {
        runId: 'run-current',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        preconditions: {
          handshakeIdentityHash: 'handshake-1',
          laneId: 'secondary:opencode:bob',
          expectedRunId: 'run-stale',
          expectedCapabilitySnapshotId: null,
          expectedBehaviorFingerprint: null,
          expectedManifestHighWatermark: null,
          commandLeaseId: null,
          idempotencyKey: 'idempotency-stop-run-mismatch',
        },
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain(
      'OpenCode bridge expectedRunId precondition does not match command runId',
    )
    expect(listCalls).toBe(0)
  })

  test('sends a message to the addressed OpenCode lane session', async () => {
    const promptCalls: Array<{ memberName: string; text: string; agent?: string }> = []
    const record = buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob',
      runtimePid: 456,
    })
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async (teamId, laneId, memberName) =>
      teamId === 'team-a' && laneId === 'secondary:opencode:bob' && memberName === 'bob'
        ? record
        : null) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async (sessionRecord, input) => {
      promptCalls.push({
        memberName: sessionRecord.memberName,
        text: input.text,
        agent: input.agent,
      })
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async sessionRecord => ({
      record: {
        ...sessionRecord,
        runtimePid: 789,
      },
      summary: buildReconcileSummary(),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.sendMessage', {
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        projectPath: '/tmp/project',
        text: 'hello bob',
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(promptCalls).toEqual([{ memberName: 'bob', text: 'hello bob', agent: 'teammate' }])
    expect(result.data.accepted).toBe(true)
    expect(result.data.sessionId).toBe('session-bob')
    expect(result.data.runtimePid).toBe(789)
  })

  test.each([
    ['video/mp4', 'clip.mp4'],
    ['video/webm', 'clip.webm'],
    ['video/quicktime', 'clip.mov'],
    ['video/mpeg', 'clip.mpeg'],
  ])('accepts %s file parts and forwards them to OpenCode', async (mime, filename) => {
    const promptParts: unknown[] = []
    const record = buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob',
      runtimePid: 456,
    })
    openCodeSessionStore.get = (async () => record) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async (_sessionRecord, input) => {
      promptParts.push(input.parts)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async sessionRecord => ({
      record: sessionRecord,
      summary: buildReconcileSummary(),
    })) as typeof openCodeSessionBridge.reconcileSession

    const filePart = {
      type: 'file',
      mime,
      url: `data:${mime};base64,AAAA`,
      filename,
    }
    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.sendMessage', {
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        projectPath: '/tmp/project',
        text: 'review this video',
        fileParts: [filePart],
      }),
    )

    expect(result.ok).toBe(true)
    expect(promptParts).toEqual([[filePart]])
  })

  test('rejects unsupported video file parts before OpenCode delivery', async () => {
    let promptCalled = false
    openCodeSessionBridge.promptAsync = (async () => {
      promptCalled = true
    }) as typeof openCodeSessionBridge.promptAsync

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.sendMessage', {
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        projectPath: '/tmp/project',
        text: 'review this video',
        fileParts: [{
          type: 'file',
          mime: 'video/mp2t',
          url: 'data:video/mp2t;base64,AAAA',
          filename: 'clip.ts',
        }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain('unsupported MIME: video/mp2t')
    expect(promptCalled).toBe(false)
  })

  test('requires video file parts to use a matching data URL', async () => {
    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.sendMessage', {
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        projectPath: '/tmp/project',
        text: 'review this video',
        fileParts: [{
          type: 'file',
          mime: 'video/mp4',
          url: 'data:video/webm;base64,AAAA',
          filename: 'clip.mp4',
        }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain('must use a matching data URL')
  })

  test('sends a message without provisioning a readiness host first', async () => {
    let probeCalls = 0
    const promptCalls: string[] = []
    const record = buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob',
      runtimePid: 456,
    })
    openCodeProvisioningProbe.probe = (async () => {
      probeCalls += 1
      throw new Error('sendMessage must not run readiness provisioning before delivery')
    }) as typeof openCodeProvisioningProbe.probe
    openCodeSessionStore.get = (async () => record) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async (_sessionRecord, input) => {
      promptCalls.push(input.text)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async sessionRecord => ({
      record: sessionRecord,
      summary: buildReconcileSummary(),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.sendMessage', {
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        projectPath: '/tmp/project',
        text: 'hello bob',
      }),
    )

    expect(result.ok).toBe(true)
    expect(probeCalls).toBe(0)
    expect(promptCalls).toEqual(['hello bob'])
  })

  test('reobserves message_send tool errors before returning plain-text fallback proof', async () => {
    const previousFallbackGrace =
      process.env.AGENT_TEAMS_OPENCODE_MESSAGE_SEND_TOOL_ERROR_FALLBACK_GRACE_MS
    process.env.AGENT_TEAMS_OPENCODE_MESSAGE_SEND_TOOL_ERROR_FALLBACK_GRACE_MS = '80'
    const record = buildRecord({
      laneId: 'secondary:opencode:tom',
      memberName: 'tom',
      opencodeSessionId: 'session-tom',
    })
    let reconcileCalls = 0
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async () => record) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async () => undefined) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async (sessionRecord, options) => {
      if (options?.limit === 80) {
        return {
          record: sessionRecord,
          summary: buildReconcileSummary({
            sessionId: sessionRecord.opencodeSessionId,
          }),
        }
      }
      reconcileCalls += 1
      const prompt = buildCanonicalMessage({
        id: 'msg_test_turn_settled',
        role: 'user',
        text: 'The inbound app messageId is "message-fallback". Please reply.',
      })
      const toolError = buildCanonicalMessage({
        id: 'assistant-tool-error',
        parentId: 'msg_test_turn_settled',
        role: 'assistant',
        toolCalls: [
          buildToolCall({
            callId: 'tool-message-send-error',
            toolName: 'agent-teams_message_send',
            status: 'errored',
            input: {
              relayOfMessageId: 'message-fallback',
              text: 'GAUNTLET_CONCURRENT_TOM_OK_1',
            },
            outputText: 'Not connected',
            isError: true,
          }),
        ],
      })
      const fallback = buildCanonicalMessage({
        id: 'assistant-plain-fallback',
        parentId: 'msg_test_turn_settled',
        role: 'assistant',
        text: 'GAUNTLET_CONCURRENT_TOM_OK_1',
        previewText: 'GAUNTLET_CONCURRENT_TOM_OK_1',
      })
      const pendingFallback = buildCanonicalMessage({
        id: 'assistant-pending-fallback',
        parentId: 'msg_test_turn_settled',
        role: 'assistant',
      })
      return {
        record: sessionRecord,
        summary: buildReconcileSummary({
          sessionId: sessionRecord.opencodeSessionId,
          latestUserMessageId: prompt.id,
          latestAssistantMessageId:
            reconcileCalls > 2
              ? fallback.id
              : reconcileCalls > 1
                ? pendingFallback.id
                : toolError.id,
          latestAssistantPreview: reconcileCalls > 2 ? fallback.previewText : null,
          rawStatus: reconcileCalls === 2 ? 'busy' : 'idle',
          durableState: reconcileCalls === 2 ? 'running' : 'idle',
          messages: reconcileCalls > 2
            ? [prompt, toolError, fallback]
            : reconcileCalls > 1
              ? [prompt, pendingFallback]
              : [prompt, toolError],
        }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const realNow = Date.now
    let now = 1_000
    Date.now = () => now
    try {
      await withManualTimers(async timers => {
        const pollStages = [createDeferred<void>(), createDeferred<void>()]
        const setManualTimer = globalThis.setTimeout
        let pollWaitCount = 0
        globalThis.setTimeout = ((callback: () => void, timeoutMs = 0) => {
          const timer = setManualTimer(callback, timeoutMs)
          if (timeoutMs === 20) pollStages[pollWaitCount++]?.resolve()
          return timer
        }) as typeof setTimeout
        const resultPromise = executeOpenCodeBridgeCommandEnvelope(
          buildEnvelope('opencode.sendMessage', {
            teamId: 'team-a',
            teamName: 'team-a',
            laneId: 'secondary:opencode:tom',
            memberName: 'tom',
            projectPath: '/tmp/project',
            text: 'hello tom',
            messageId: 'message-fallback',
          }),
        )

        // Drive both real grace-loop waits after their preceding reconciliation.
        for (const [index, stage] of pollStages.entries()) {
          await waitForCommandStage(stage.promise, resultPromise, `fallback poll ${index + 1}`)
          const timer = timers.find(timer => timer.timeoutMs === 20 && !timer.cancelled)
          expect(timer).toBeDefined()
          expect(reconcileCalls).toBe(index + 1)
          now += 20
          timer!.callback()
        }
        const result = await resultPromise
        expect(pollWaitCount).toBe(2)

        expect(result.ok).toBe(true)
        if (!result.ok) {
          return
        }
        expect(reconcileCalls).toBe(3)
        expect(result.data.responseObservation).toMatchObject({
          state: 'responded_plain_text',
          assistantMessageId: 'assistant-plain-fallback',
          latestAssistantPreview: 'GAUNTLET_CONCURRENT_TOM_OK_1',
          visibleReplyCorrelation: 'plain_assistant_text',
        })
        const fallbackDiagnostic = result.data.diagnostics.find(
          diagnostic =>
            diagnostic.code ===
            'opencode_send_reconcile_message_send_tool_error_fallback_grace',
        )
        expect(fallbackDiagnostic?.severity).toBe('info')
        expect(fallbackDiagnostic?.message).toContain(
          'Reconciled OpenCode session during 80ms message_send tool_error fallback grace',
        )
      })
    } finally {
      Date.now = realNow
      if (previousFallbackGrace === undefined) {
        delete process.env.AGENT_TEAMS_OPENCODE_MESSAGE_SEND_TOOL_ERROR_FALLBACK_GRACE_MS
      } else {
        process.env.AGENT_TEAMS_OPENCODE_MESSAGE_SEND_TOOL_ERROR_FALLBACK_GRACE_MS =
          previousFallbackGrace
      }
    }
  }, 15_000)

  // R6: original send starts fresh reconciliation after observer cancellation and spools Stop.
  test.each(['observation', 'final', 'fallback', 'deadline'] as const)('public send cancellation during %s fences reads and Stop; recovery retains prompt without replay', async phase => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'TEST-opencode-cancel-'))
    process.env[RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV] = path.join(tempDir, 'spool')
    const record = buildRecord({ laneId: 'secondary:opencode:bob', memberName: 'bob', opencodeSessionId: 'session-bob' })
    const operation = new AbortController()
    let readsAfterCancel = 0, submissions = 0, savedId: string | null = null
    let observedSignal: AbortSignal | undefined, finalSignal: AbortSignal | undefined, finalReads = 0
    const upsert = openCodeCommandOutcomeStore.upsert
    openCodeCommandOutcomeStore.upsert = async patch => {
      if (patch.runtimePromptMessageId) savedId = patch.runtimePromptMessageId
      return upsert(patch)
    }
    const prompt = openCodeSessionBridge.promptAsyncWithTurnSettled
    openCodeSessionBridge.promptAsyncWithTurnSettled = async (sessionRecord, input) => prompt(sessionRecord, {
      ...input, onPromptAccepted: async event => {
        await input.onPromptAccepted?.(event)
        expect(input.signal?.aborted).toBe(false)
        observedSignal = input.signal
        if (phase === 'observation') operation.abort(new Error('TEST cancel accepted turn'))
        if (phase === 'deadline') { const until = performance.now() + 10; while (performance.now() < until) { /* Hold the timer queue past the deadline. */ } }
      },
    })
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = async () => record
    openCodeSessionBridge.promptAsync = async () => { submissions++ }
    openCodeSessionBridge.reconcileSession = async (sessionRecord, options) => {
      if (operation.signal.aborted && options?.signal?.aborted !== false) readsAfterCancel++
      const user = buildCanonicalMessage({ id: 'msg_test_turn_settled', role: 'user', createdAt: 100 })
      if (options?.limit === 50) {
        finalSignal = options.signal
        finalReads++
        if (phase === 'final') operation.abort(new Error('TEST cancel final confirmation'))
      }
      const assistant = buildCanonicalMessage({ id: 'msg_TEST_terminal', parentId: user.id, role: 'assistant',
        createdAt: 101, completedAt: 102, finishReason: 'stop', text: finalReads > 1 ? 'TEST recovered reply' : '' })
      if (phase === 'fallback' && finalReads === 1 && !operation.signal.aborted) {
        assistant.toolCalls = [buildToolCall({ callId: 'TEST-call', toolName: 'agent-teams_message_send', status: 'errored',
          isError: true, input: { relayOfMessageId: 'TEST-inbound-cancel', text: 'TEST reply' }, outputText: 'Not connected' })]
        setTimeout(() => operation.abort(new Error('TEST cancel fallback grace')), 1)
      }
      return { record: sessionRecord, summary: buildReconcileSummary({ sessionId: record.opencodeSessionId,
        latestUserMessageId: user.id, latestAssistantMessageId: assistant.id, messages: [user, assistant],
        terminalEvidence: { authority: record, sessionId: record.opencodeSessionId, messages: [user, assistant],
          messageSessionIds: [record.opencodeSessionId, record.opencodeSessionId], complete: true, interactionsSettled: true, diagnostics: [] },
      }) }
    }
    try {
      const body = { teamId: 'team-a', teamName: 'team-a', laneId: record.laneId, memberName: 'bob',
        projectPath: '/tmp/project', text: 'TEST retained input', messageId: 'TEST-inbound-cancel' }
      const envelope = buildEnvelope('opencode.sendMessage', body)
      if (phase === 'deadline') envelope.timeoutMs = 5
      const result = await executeOpenCodeBridgeCommandEnvelope(envelope, { signal: operation.signal })
      const stopped = await readdir(path.join(tempDir, 'spool', 'incoming')).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      console.log('R6 public cancellation', JSON.stringify({ phase, ok: result.ok, readsAfterCancel, finalReads, submissions, savedId, Stop: stopped.length }))
      expect(result.ok).toBe(false)
      expect(readsAfterCancel).toBe(0)
      if (phase === 'final' || phase === 'fallback') expect(finalSignal).toBe(observedSignal)
      if (phase === 'deadline') { expect(finalReads).toBe(0); if ('error' in result) expect(result.error.kind).toBe('timeout') }
      expect(String(savedId)).toBe('msg_test_turn_settled')
      expect(submissions).toBe(1)
      const recovery = new AbortController()
      const recovered = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.observeMessageDelivery', {
        ...body, sessionId: record.opencodeSessionId, runtimePromptMessageId: savedId,
      }), { signal: recovery.signal })
      expect(recovered.ok).toBe(true)
      expect(submissions).toBe(1)
      expect(String(savedId)).toBe('msg_test_turn_settled')
      const files = await readdir(path.join(tempDir, 'spool', 'incoming')).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      expect(files).toHaveLength(0)
    } finally { await rm(tempDir, { recursive: true, force: true }) }
  })

  test('suppresses execution spool when the production send-message path has only reply progress', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-send-spool-test-'))
    process.env[RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV] = path.join(tempDir, 'runtime-turn-settled')
    const record = buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob',
    })
    try {
      openCodeProvisioningProbe.probe = async () => snapshot
      openCodeSessionStore.get = (async () => record) as typeof openCodeSessionStore.get
      openCodeSessionBridge.promptAsync = (async () => undefined) as typeof openCodeSessionBridge.promptAsync
      openCodeSessionBridge.reconcileSession = (async sessionRecord => ({
        record: sessionRecord,
        summary: buildReconcileSummary({
          sessionId: sessionRecord.opencodeSessionId,
          latestUserMessageId: 'msg_test_turn_settled',
          latestAssistantMessageId: 'msg-current-assistant',
          messages: [
            ...buildBootstrapReadyMessages(),
            {
              id: 'msg_test_turn_settled',
              parentId: null,
              role: 'user',
              agent: null,
              providerId: null,
              modelId: null,
              createdAt: null,
              completedAt: null,
              text: 'hello bob',
              reasoningText: '',
              previewText: null,
              partTypes: [],
              reasoningPartCount: 0,
              toolCalls: [],
              contentBlocks: [],
              finishReason: null,
              errorName: null,
              errorMessage: null,
              hasError: false,
            },
            {
              id: 'msg-current-assistant',
              parentId: 'msg_test_turn_settled',
              role: 'assistant',
              agent: null,
              providerId: null,
              modelId: null,
              createdAt: null,
              completedAt: null,
              text: 'done',
              reasoningText: '',
              previewText: 'done',
              partTypes: [],
              reasoningPartCount: 0,
              toolCalls: [],
              contentBlocks: [],
              finishReason: null,
              errorName: null,
              errorMessage: null,
              hasError: false,
            },
          ],
        }),
      })) as typeof openCodeSessionBridge.reconcileSession

      const result = await executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.sendMessage', {
          teamId: 'team-a',
          teamName: 'team-a',
          laneId: 'secondary:opencode:bob',
          memberName: 'bob',
          projectPath: '/tmp/project',
          text: 'hello bob',
        }),
      )

      expect(result.ok).toBe(true)
      const incomingDir = path.join(tempDir, 'runtime-turn-settled', 'incoming')
      // Regression: assistant allocation/text plus an outcome summary used to spool Stop.
      const files = await readdir(incomingDir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      expect(files).toHaveLength(0)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('returns acceptance settlement mode immediately without turn-settled observation', async () => {
    const record = buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob',
    })
    let reconcileCalls = 0
    let postAcceptanceReconcileCalls = 0
    let promptAccepted = false
    try {
      openCodeProvisioningProbe.probe = async () => snapshot
      openCodeSessionStore.get = (async () => record) as typeof openCodeSessionStore.get
      openCodeSessionBridge.promptAsync = (async () => undefined) as typeof openCodeSessionBridge.promptAsync
      openCodeSessionBridge.promptAsyncUntilAccepted = (async (_record, input) => {
        const runtimePromptMessageId = 'msg_test_acceptance'
        await input.onPromptSubmitting?.({
          sessionId: record.opencodeSessionId,
          runtimePromptMessageId,
          baseUrl: 'http://127.0.0.1:4096',
        })
        await input.onPromptAccepted?.({
          sessionId: record.opencodeSessionId,
          runtimePromptMessageId,
        })
        promptAccepted = true
        return { runtimePromptMessageId, hookDiagnostics: [] }
      }) as typeof openCodeSessionBridge.promptAsyncUntilAccepted
      openCodeSessionBridge.promptAsyncWithTurnSettled = (async () => {
        throw new Error('acceptance mode must not wait for turn-settled observation')
      }) as typeof openCodeSessionBridge.promptAsyncWithTurnSettled
      openCodeSessionBridge.reconcileSession = (async () => {
        reconcileCalls += 1
        if (promptAccepted) {
          postAcceptanceReconcileCalls += 1
        }
        return {
          record,
          summary: buildReconcileSummary({ sessionId: record.opencodeSessionId }),
        }
      }) as typeof openCodeSessionBridge.reconcileSession

      const result = await executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.sendMessage', {
          teamId: 'team-a',
          teamName: 'team-a',
          laneId: 'secondary:opencode:bob',
          memberName: 'bob',
          projectPath: '/tmp/project',
          text: 'hello bob',
          messageId: 'message-acceptance',
          settlementMode: 'acceptance',
        }),
      )

      expect(result.ok).toBe(true)
      if (!result.ok) {
        return
      }
      expect(result.data).toMatchObject({
        accepted: true,
        sessionId: 'session-bob',
        memberName: 'bob',
        prePromptCursor: record.lastCanonicalCursor,
        runtimePromptMessageId: 'msg_test_acceptance',
      })
      expect(result.data.responseObservation).toBeUndefined()
      expect(reconcileCalls).toBe(0)
      expect(postAcceptanceReconcileCalls).toBe(0)
      const diagnosticCodes = result.data.diagnostics.map(diagnostic => diagnostic.code)
      expect(diagnosticCodes).toContain('opencode_send_settlement_acceptance')
    } finally {
      openCodeSessionBridge.reconcileSession = originalReconcileSession
      openCodeSessionBridge.promptAsyncWithTurnSettled = originalPromptAsyncWithTurnSettled
      openCodeSessionBridge.promptAsyncUntilAccepted = originalPromptAsyncUntilAccepted
    }
  })

  test('keeps noReply OpenCode delivery out of turn-settled observer path', async () => {
    const promptCalls: Array<{ noReply?: boolean }> = []
    let reconcileCalls = 0
    const record = buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob',
    })
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async () => record) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async (_sessionRecord, input) => {
      promptCalls.push({ noReply: input.noReply })
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.promptAsyncWithTurnSettled = (async () => {
      throw new Error('noReply must not wait for turn-settled observation')
    }) as typeof openCodeSessionBridge.promptAsyncWithTurnSettled
    openCodeSessionBridge.reconcileSession = (async sessionRecord => ({
      record: sessionRecord,
      summary: (reconcileCalls += 1, buildReconcileSummary()),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.sendMessage', {
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        projectPath: '/tmp/project',
        text: 'silent bootstrap',
        noReply: true,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(promptCalls).toEqual([{ noReply: true }])
    expect(reconcileCalls).toBe(0)
    expect(result.data).toMatchObject({
      accepted: true,
      sessionId: 'session-bob',
      memberName: 'bob',
      prePromptCursor: record.lastCanonicalCursor,
    })
    expect(result.data.runtimePromptMessageId).toBeUndefined()
    expect(result.data.responseObservation).toBeUndefined()
    expect(result.data.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'opencode_send_no_reply_accepted',
    )
  })

  test('reattaches app MCP before sending a message to an OpenCode lane session', async () => {
    const promptCalls: Array<{ memberName: string; text: string }> = []
    const record = buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob',
    })
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async () => record) as typeof openCodeSessionStore.get
    openCodeSessionBridge.ensureSessionAppMcpReady = (async () => ({
      ok: true,
      runtimePid: 456,
      status: 'attached',
      connected: true,
      diagnostics: ['Reattached OpenCode app MCP server after connect failed: disconnected'],
    })) as typeof openCodeSessionBridge.ensureSessionAppMcpReady
    openCodeSessionBridge.promptAsync = (async (sessionRecord, input) => {
      promptCalls.push({ memberName: sessionRecord.memberName, text: input.text })
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async sessionRecord => ({
      record: sessionRecord,
      summary: buildReconcileSummary(),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.sendMessage', {
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        projectPath: '/tmp/project',
        text: 'hello bob',
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(promptCalls).toEqual([{ memberName: 'bob', text: 'hello bob' }])
    expect(result.data.diagnostics).toContainEqual({
      code: 'opencode_send_mcp_reattached',
      message: 'OpenCode app MCP was reattached before message delivery.',
      severity: 'info',
    })
  })

  test('does not recreate app-managed OpenCode session when old bootstrap MCP proof is absent', async () => {
    const originalRecord = buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob-app-managed',
      lastCanonicalCursor: 'cursor-app-managed',
    })
    const staleReasons: string[] = []
    const promptSessionIds: string[] = []
    const mcpCheckedSessionIds: string[] = []
    let ensureSessionCalls = 0
    let reconcileCalls = 0
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async () => originalRecord) as typeof openCodeSessionStore.get
    openCodeSessionStore.markStale = (async (_teamId, _laneId, _memberName, staleReason) => {
      staleReasons.push(staleReason)
      return { ...originalRecord, staleReason }
    }) as typeof openCodeSessionStore.markStale
    openCodeSessionBridge.ensureSession = (async () => {
      ensureSessionCalls += 1
      return buildRecord({ opencodeSessionId: 'session-should-not-be-created' })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.reconcileSession = (async record => {
      reconcileCalls += 1
      return {
        record,
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
          latestAssistantMessageId: 'msg-bootstrap-failed',
          messages: [
            buildCanonicalMessage({
              id: 'msg-bootstrap-failed',
              role: 'assistant',
              toolCalls: [
                buildToolCall({
                  toolName: 'agent-teams_runtime_bootstrap_checkin',
                  status: 'errored',
                  outputText: 'MCP Not connected',
                  isError: true,
                }),
              ],
            }),
          ],
        }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession
    openCodeSessionBridge.ensureSessionAppMcpReady = (async record => {
      mcpCheckedSessionIds.push(record.opencodeSessionId)
      return {
        ok: true,
        runtimePid: record.runtimePid,
        status: 'present',
        connected: true,
        diagnostics: [],
      }
    }) as typeof openCodeSessionBridge.ensureSessionAppMcpReady
    openCodeSessionBridge.promptAsync = (async record => {
      promptSessionIds.push(record.opencodeSessionId)
    }) as typeof openCodeSessionBridge.promptAsync

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.sendMessage', {
        runId: 'run-app-managed-send',
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        projectPath: '/tmp/project',
        text: 'hello bob',
        messageId: 'message-app-managed-send',
        settlementMode: 'acceptance',
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(staleReasons).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(reconcileCalls).toBe(0)
    expect(mcpCheckedSessionIds).toEqual(['session-bob-app-managed'])
    expect(promptSessionIds).toEqual(['session-bob-app-managed'])
    expect(result.data.sessionId).toBe('session-bob-app-managed')
    expect(result.data.prePromptCursor).toBe('cursor-app-managed')
    expect(result.data.diagnostics).not.toContainEqual({
      code: 'opencode_send_session_recreated_after_bootstrap_mcp_failure',
      message: 'Recreated OpenCode session before message delivery because bootstrap MCP failed in the stored session.',
      severity: 'warning',
    })
  })

  test('recreates legacy OpenCode session before sending when bootstrap MCP failed in stored session', async () => {
    const originalRecord = buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob-broken',
      lastCanonicalCursor: 'cursor-broken',
      bootstrapMode: 'model_tool_checkin',
      bootstrapEvidenceSource: 'runtime_bootstrap_checkin',
      toolApprovalMode: 'manual',
    })
    const freshRecord = buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob-fresh',
      lastCanonicalCursor: 'cursor-fresh',
      runtimePid: 456,
    })
    const staleReasons: string[] = []
    const promptSessionIds: string[] = []
    const mcpCheckedSessionIds: string[] = []
    let ensureSessionCalls = 0
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async () => originalRecord) as typeof openCodeSessionStore.get
    openCodeSessionStore.markStale = (async (_teamId, _laneId, _memberName, staleReason) => {
      staleReasons.push(staleReason)
      return { ...originalRecord, staleReason }
    }) as typeof openCodeSessionStore.markStale
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      expect(input).toMatchObject({
        teamId: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        selectedModel: originalRecord.selectedModel,
        projectPath: originalRecord.projectPath,
        runId: 'run-bootstrap-repair',
        toolApprovalMode: 'manual',
      })
      return freshRecord
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary: record.opencodeSessionId === 'session-bob-broken'
        ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: 'msg-bootstrap-failed',
            messages: [
              buildCanonicalMessage({
                id: 'msg-bootstrap-failed',
                role: 'assistant',
                toolCalls: [
                  buildToolCall({
                    toolName: 'agent-teams_runtime_bootstrap_checkin',
                    status: 'errored',
                    outputText: 'MCP Not connected',
                    isError: true,
                  }),
                ],
              }),
            ],
          })
        : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            lastCanonicalCursor: record.lastCanonicalCursor,
          }),
    })) as typeof openCodeSessionBridge.reconcileSession
    openCodeSessionBridge.ensureSessionAppMcpReady = (async record => {
      mcpCheckedSessionIds.push(record.opencodeSessionId)
      return {
        ok: true,
        runtimePid: record.runtimePid,
        status: 'present',
        connected: true,
        diagnostics: [],
      }
    }) as typeof openCodeSessionBridge.ensureSessionAppMcpReady
    openCodeSessionBridge.promptAsync = (async record => {
      promptSessionIds.push(record.opencodeSessionId)
    }) as typeof openCodeSessionBridge.promptAsync

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.sendMessage', {
        runId: 'run-bootstrap-repair',
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        projectPath: '/tmp/project',
        text: 'hello bob',
        messageId: 'message-bootstrap-repair',
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(staleReasons).toEqual(['bootstrap_app_mcp_unavailable'])
    expect(ensureSessionCalls).toBe(1)
    expect(mcpCheckedSessionIds).toEqual(['session-bob-fresh'])
    expect(promptSessionIds).toEqual(['session-bob-fresh'])
    expect(result.data.sessionId).toBe('session-bob-fresh')
    expect(result.data.prePromptCursor).toBe('cursor-fresh')
    expect(result.data.diagnostics).toContainEqual({
      code: 'opencode_send_session_recreated_after_bootstrap_mcp_failure',
      message: 'Recreated OpenCode session before message delivery because bootstrap MCP failed in the stored session.',
      severity: 'warning',
    })
  })

  test('recreates stale OpenCode session before sending a message', async () => {
    const promptCalls: Array<{ sessionId: string; text: string }> = []
    const staleRecord = buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob-stale',
      lastCanonicalCursor: 'cursor-stale',
      staleReason: 'resolved_behavior_changed:old->new',
      toolApprovalMode: 'manual',
    })
    const freshRecord = buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob-fresh',
      lastCanonicalCursor: 'cursor-fresh',
      runtimePid: 654,
    })
    let ensureSessionCalls = 0
    const mcpCheckedSessionIds: string[] = []
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async () => staleRecord) as typeof openCodeSessionStore.get
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      expect(input).toMatchObject({
        teamId: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        selectedModel: staleRecord.selectedModel,
        projectPath: staleRecord.projectPath,
        runId: 'run-stale-send',
        toolApprovalMode: 'manual',
      })
      return freshRecord
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.ensureSessionAppMcpReady = (async record => {
      mcpCheckedSessionIds.push(record.opencodeSessionId)
      return {
        ok: true,
        runtimePid: record.runtimePid,
        status: 'present',
        connected: true,
        diagnostics: [],
      }
    }) as typeof openCodeSessionBridge.ensureSessionAppMcpReady
    openCodeSessionBridge.promptAsync = (async (sessionRecord, input) => {
      promptCalls.push({
        sessionId: sessionRecord.opencodeSessionId,
        text: input.text,
      })
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async sessionRecord => ({
      record: sessionRecord,
      summary: buildReconcileSummary(),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.sendMessage', {
        runId: 'run-stale-send',
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        projectPath: '/tmp/project',
        text: 'hello fresh bob',
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(ensureSessionCalls).toBe(1)
    expect(mcpCheckedSessionIds).toEqual(['session-bob-fresh'])
    expect(promptCalls).toEqual([{ sessionId: 'session-bob-fresh', text: expect.stringContaining('hello fresh bob') }])
    expect(result.data.sessionId).toBe('session-bob-fresh')
    expect(result.data.prePromptCursor).toBe('cursor-fresh')
    expect(result.data.diagnostics).toContainEqual({
      code: 'opencode_send_session_recreated_after_stale_record',
      message:
        'Recreated OpenCode session before message delivery because the stored session was stale (resolved_behavior_changed:old->new).',
      severity: 'warning',
    })
  })

  test('recreates OpenCode session before sending when app-managed bootstrap id is not sortable', async () => {
    const originalRecord = buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob-legacy-bootstrap',
      lastCanonicalCursor: 'cursor-legacy-bootstrap',
      bootstrapMode: 'app_managed_context',
      bootstrapEvidenceSource: 'app_managed_bootstrap',
      toolApprovalMode: 'manual',
      appManagedBootstrap: {
        schemaVersion: 1,
        messageID: 'msgagtbootlegacy',
        contextHash: 'context-hash',
        briefingHash: 'briefing-hash',
        injectionVerifiedAt: '2026-04-21T12:00:00.000Z',
        model: 'openrouter/minimax-m2.5-free',
        agent: 'teammate-bootstrap',
      },
    })
    const freshRecord = buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob-fresh-bootstrap',
      lastCanonicalCursor: 'cursor-fresh-bootstrap',
      runtimePid: 987,
    })
    const staleReasons: string[] = []
    const mcpCheckedSessionIds: string[] = []
    const promptSessionIds: string[] = []
    let ensureSessionCalls = 0
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async () => originalRecord) as typeof openCodeSessionStore.get
    openCodeSessionStore.markStale = (async (_teamId, _laneId, _memberName, staleReason) => {
      staleReasons.push(staleReason)
      return { ...originalRecord, staleReason }
    }) as typeof openCodeSessionStore.markStale
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      expect(input).toMatchObject({
        teamId: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        selectedModel: originalRecord.selectedModel,
        projectPath: originalRecord.projectPath,
        runId: 'run-sortable-bootstrap-repair',
        toolApprovalMode: 'manual',
      })
      return freshRecord
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.ensureSessionAppMcpReady = (async record => {
      mcpCheckedSessionIds.push(record.opencodeSessionId)
      return {
        ok: true,
        runtimePid: record.runtimePid,
        status: 'present',
        connected: true,
        diagnostics: [],
      }
    }) as typeof openCodeSessionBridge.ensureSessionAppMcpReady
    openCodeSessionBridge.promptAsync = (async record => {
      promptSessionIds.push(record.opencodeSessionId)
    }) as typeof openCodeSessionBridge.promptAsync

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.sendMessage', {
        runId: 'run-sortable-bootstrap-repair',
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        projectPath: '/tmp/project',
        text: 'hello bob',
        messageId: 'message-sortable-bootstrap-repair',
        settlementMode: 'acceptance',
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(staleReasons).toEqual(['app_managed_bootstrap_message_id_not_opencode_sortable'])
    expect(ensureSessionCalls).toBe(1)
    expect(mcpCheckedSessionIds).toEqual(['session-bob-fresh-bootstrap'])
    expect(promptSessionIds).toEqual(['session-bob-fresh-bootstrap'])
    expect(result.data.sessionId).toBe('session-bob-fresh-bootstrap')
    expect(result.data.prePromptCursor).toBe('cursor-fresh-bootstrap')
    expect(result.data.diagnostics).toContainEqual({
      code: 'opencode_send_session_recreated_after_stale_record',
      message:
        'Recreated OpenCode session before message delivery because the stored session was stale (app_managed_bootstrap_message_id_not_opencode_sortable).',
      severity: 'warning',
    })
  })

  test('recreates OpenCode session before sending when the app requests a forced refresh', async () => {
    const promptCalls: Array<{ sessionId: string; text: string }> = []
    const staleReasons: string[] = []
    const originalRecord = buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob-old-transport',
      lastCanonicalCursor: 'cursor-old-transport',
      toolApprovalMode: 'manual',
    })
    const freshRecord = buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob-fresh-transport',
      lastCanonicalCursor: 'cursor-fresh-transport',
      runtimePid: 765,
    })
    let ensureSessionCalls = 0
    const mcpCheckedSessionIds: string[] = []
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async () => originalRecord) as typeof openCodeSessionStore.get
    openCodeSessionStore.markStale = (async (_teamId, _laneId, _memberName, staleReason) => {
      staleReasons.push(staleReason)
      return { ...originalRecord, staleReason }
    }) as typeof openCodeSessionStore.markStale
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      expect(input).toMatchObject({
        teamId: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        selectedModel: originalRecord.selectedModel,
        projectPath: originalRecord.projectPath,
        runId: 'run-forced-refresh',
        toolApprovalMode: 'manual',
      })
      return freshRecord
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.ensureSessionAppMcpReady = (async record => {
      mcpCheckedSessionIds.push(record.opencodeSessionId)
      return {
        ok: true,
        runtimePid: record.runtimePid,
        status: 'present',
        connected: true,
        diagnostics: [],
      }
    }) as typeof openCodeSessionBridge.ensureSessionAppMcpReady
    openCodeSessionBridge.promptAsync = (async (sessionRecord, input) => {
      promptCalls.push({
        sessionId: sessionRecord.opencodeSessionId,
        text: input.text,
      })
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async sessionRecord => ({
      record: sessionRecord,
      summary: buildReconcileSummary(),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.sendMessage', {
        runId: 'run-forced-refresh',
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        projectPath: '/tmp/project',
        text: 'hello refreshed bob',
        forceSessionRefreshReason: 'opencode_app_mcp_transport_changed:old->new',
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(staleReasons).toEqual(['opencode_app_mcp_transport_changed:old->new'])
    expect(ensureSessionCalls).toBe(1)
    expect(mcpCheckedSessionIds).toEqual(['session-bob-fresh-transport'])
    expect(promptCalls).toEqual([
      {
        sessionId: 'session-bob-fresh-transport',
        text: expect.stringContaining('hello refreshed bob'),
      },
    ])
    expect(result.data.sessionId).toBe('session-bob-fresh-transport')
    expect(result.data.prePromptCursor).toBe('cursor-fresh-transport')
    expect(result.data.diagnostics).toContainEqual({
      code: 'opencode_send_session_recreated_after_forced_refresh',
      message:
        'Recreated OpenCode session before message delivery because the app requested a session refresh (opencode_app_mcp_transport_changed:old->new).',
      severity: 'info',
    })
  })

  test('recreates the OpenCode session once when app MCP cannot attach before prompt', async () => {
    const promptCalls: Array<{ sessionId: string; prePromptCursor: string | null }> = []
    const staleReasons: string[] = []
    const originalRecord = buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob-old',
      lastCanonicalCursor: 'cursor-old',
      toolApprovalMode: 'manual',
    })
    const recreatedRecord = buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob-new',
      lastCanonicalCursor: 'cursor-new',
      runtimePid: 987,
    })
    let mcpChecks = 0
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async () => originalRecord) as typeof openCodeSessionStore.get
    openCodeSessionStore.markStale = (async (_teamId, _laneId, _memberName, staleReason) => {
      staleReasons.push(staleReason)
      return { ...originalRecord, staleReason }
    }) as typeof openCodeSessionStore.markStale
    openCodeSessionBridge.ensureSession = (async input => {
      expect(input).toMatchObject({
        teamId: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        selectedModel: originalRecord.selectedModel,
        projectPath: originalRecord.projectPath,
        toolApprovalMode: 'manual',
      })
      return recreatedRecord
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.ensureSessionAppMcpReady = (async () => {
      mcpChecks += 1
      return mcpChecks === 1
        ? {
            ok: false,
            status: 'attach_failed',
            connected: false,
            diagnostics: ['not connected'],
          }
        : {
            ok: true,
            runtimePid: 987,
            status: 'present',
            connected: true,
            diagnostics: [],
          }
    }) as typeof openCodeSessionBridge.ensureSessionAppMcpReady
    openCodeSessionBridge.promptAsync = (async sessionRecord => {
      promptCalls.push({
        sessionId: sessionRecord.opencodeSessionId,
        prePromptCursor: sessionRecord.lastCanonicalCursor,
      })
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async sessionRecord => ({
      record: sessionRecord,
      summary: buildReconcileSummary(),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.sendMessage', {
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        projectPath: '/tmp/project',
        text: 'hello bob',
        messageId: 'message-1',
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(staleReasons).toEqual(['app_mcp_unavailable'])
    expect(mcpChecks).toBe(2)
    expect(promptCalls).toEqual([{ sessionId: 'session-bob-new', prePromptCursor: 'cursor-new' }])
    expect(result.data.sessionId).toBe('session-bob-new')
    expect(result.data.prePromptCursor).toBe('cursor-new')
    expect(result.data.diagnostics).toContainEqual({
      code: 'opencode_send_session_recreated_after_mcp_failure',
      message: 'Recreated OpenCode session after app MCP was unavailable on the stored session.',
      severity: 'warning',
    })
  })

  test('returns accepted false before prompt when app MCP is unavailable after session recreate', async () => {
    let promptCalls = 0
    const staleCalls: Array<{ sessionId: string; reason: string }> = []
    const releaseCalls: string[] = []
    const originalRecord = buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob-old',
    })
    const recreatedRecord = buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob-new',
    })
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async () => originalRecord) as typeof openCodeSessionStore.get
    openCodeSessionStore.markStale = (async (_teamId, _laneId, _memberName, reason) => {
      staleCalls.push({
        sessionId: staleCalls.length === 0 ? originalRecord.opencodeSessionId : recreatedRecord.opencodeSessionId,
        reason: reason ?? _memberName,
      })
      return {
        ...(staleCalls.length === 1 ? originalRecord : recreatedRecord),
        staleReason: reason ?? _memberName,
      }
    }) as typeof openCodeSessionStore.markStale
    openCodeSessionBridge.ensureSession = (async () => recreatedRecord) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.reconcileSession = (async sessionRecord => ({
      record: sessionRecord,
      summary: buildReconcileSummary(),
    })) as typeof openCodeSessionBridge.reconcileSession
    openCodeSessionBridge.ensureSessionAppMcpReady = (async () => ({
      ok: false,
      status: 'attach_failed',
      connected: false,
      diagnostics: ['still not connected'],
    })) as typeof openCodeSessionBridge.ensureSessionAppMcpReady
    openCodeSessionBridge.releaseSession = (async record => {
      releaseCalls.push(record.opencodeSessionId)
      throw new Error('release failed')
    }) as typeof openCodeSessionBridge.releaseSession
    openCodeSessionBridge.promptAsync = (async () => {
      promptCalls += 1
    }) as typeof openCodeSessionBridge.promptAsync

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.sendMessage', {
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        projectPath: '/tmp/project',
        text: 'hello bob',
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.accepted).toBe(false)
    expect(result.data.sessionId).toBe('session-bob-new')
    expect(result.data.diagnostics).toContainEqual({
      code: 'opencode_send_mcp_unavailable',
      message:
        'OpenCode app MCP unavailable for team-a/secondary:opencode:bob/bob after session recreate (status=attach_failed, connected=false). still not connected',
      severity: 'error',
    })
    expect(result.data.diagnostics).toContainEqual({
      code: 'opencode_send_unavailable_session_cleanup_release_failed',
      message: 'bob: release failed',
      severity: 'warning',
    })
    expect(result.data.responseObservation?.reason).toBe(
      'OpenCode app MCP unavailable for team-a/secondary:opencode:bob/bob after session recreate (status=attach_failed, connected=false). still not connected',
    )
    expect(promptCalls).toBe(0)
    expect(staleCalls).toEqual([
      { sessionId: 'session-bob-old', reason: 'app_mcp_unavailable' },
      { sessionId: 'session-bob-new', reason: 'app_mcp_unavailable_after_recreate' },
    ])
    expect(releaseCalls).toEqual(['session-bob-new'])
  })

  test('prepends send-message identity only with runId and treats post-accept reconcile failure as warning', async () => {
    const promptCalls: Array<{ memberName: string; text: string; agent?: string }> = []
    const record = buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob',
      runtimePid: 456,
    })
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async (teamId, laneId, memberName) =>
      teamId === 'team-a' && laneId === 'secondary:opencode:bob' && memberName === 'bob'
        ? record
        : null) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async (sessionRecord, input) => {
      promptCalls.push({
        memberName: sessionRecord.memberName,
        text: input.text,
        agent: input.agent,
      })
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async () => {
      throw new Error('reconcile after accepted prompt failed')
    }) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.sendMessage', {
        runId: 'run-send-1',
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        projectPath: '/tmp/project',
        text: 'hello bob',
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(promptCalls).toHaveLength(1)
    expectOpenCodeIdentityPrompt({
      text: promptCalls[0]?.text ?? '',
      teamName: 'team-a',
      memberName: 'bob',
      runtimeSessionId: 'session-bob',
      runId: 'run-send-1',
      originalPrompt: 'hello bob',
    })
    expect(result.data.accepted).toBe(true)
    expect(result.data.runtimePid).toBe(456)
    expect(result.data.diagnostics).toContainEqual({
      code: 'opencode_send_reconcile_failed_after_prompt_accept',
      message: 'reconcile after accepted prompt failed',
      severity: 'warning',
    })
  })

  test('rejects stale mixed OpenCode send-message lane preconditions before reading sessions', async () => {
    let getCalls = 0
    let promptCalls = 0
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async () => {
      getCalls += 1
      return buildRecord({
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        opencodeSessionId: 'session-bob',
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async () => {
      promptCalls += 1
    }) as typeof openCodeSessionBridge.promptAsync

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.sendMessage', {
        runId: 'run-current-send',
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        projectPath: '/tmp/project',
        text: 'hello stale bob',
        preconditions: {
          handshakeIdentityHash: 'handshake-1',
          laneId: 'secondary:opencode:jack',
          expectedRunId: 'run-current-send',
          expectedCapabilitySnapshotId: null,
          expectedBehaviorFingerprint: null,
          expectedManifestHighWatermark: null,
          commandLeaseId: null,
          idempotencyKey: 'stale-send-lane',
        },
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain(
      'OpenCode bridge expected laneId precondition does not match command laneId',
    )
    expect(getCalls).toBe(0)
    expect(promptCalls).toBe(0)
  })

  test('rejects stale mixed OpenCode send-message run preconditions before prompting', async () => {
    let getCalls = 0
    let promptCalls = 0
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async () => {
      getCalls += 1
      return buildRecord({
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        opencodeSessionId: 'session-bob',
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async () => {
      promptCalls += 1
    }) as typeof openCodeSessionBridge.promptAsync

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.sendMessage', {
        runId: 'run-current-send',
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        projectPath: '/tmp/project',
        text: 'hello stale bob',
        preconditions: {
          handshakeIdentityHash: 'handshake-1',
          laneId: 'secondary:opencode:bob',
          expectedRunId: 'run-stale-send',
          expectedCapabilitySnapshotId: null,
          expectedBehaviorFingerprint: null,
          expectedManifestHighWatermark: null,
          commandLeaseId: null,
          idempotencyKey: 'stale-send-run',
        },
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain(
      'OpenCode bridge expectedRunId precondition does not match command runId',
    )
    expect(getCalls).toBe(0)
    expect(promptCalls).toBe(0)
  })

  test('rejects ambiguous permission answers without laneId when multiple lanes exist', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.list = (async () => [
      buildRecord({ laneId: 'secondary:opencode:alice', memberName: 'alice' }),
      buildRecord({ laneId: 'secondary:opencode:alice:alt', memberName: 'alice', opencodeSessionId: 'session-alt' }),
    ]) as typeof openCodeSessionStore.list

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.answerPermission', {
        runId: 'run-1',
        teamId: 'team-a',
        teamName: 'team-a',
        memberName: 'alice',
        requestId: 'perm-1',
        decision: 'allow',
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain('laneId is required')
  })

  test('rejects stale mixed OpenCode permission lane preconditions before answering permissions', async () => {
    let getCalls = 0
    let answerCalls = 0
    let reconcileCalls = 0
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async () => {
      getCalls += 1
      return buildRecord({
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        opencodeSessionId: 'session-bob',
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.answerPermission = (async () => {
      answerCalls += 1
    }) as typeof openCodeSessionBridge.answerPermission
    openCodeSessionBridge.reconcileSession = (async record => {
      reconcileCalls += 1
      return {
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
        }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.answerPermission', {
        runId: 'run-permission-bob',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        memberName: 'bob',
        requestId: 'perm-bob',
        decision: 'allow',
        preconditions: {
          handshakeIdentityHash: 'handshake-1',
          laneId: 'secondary:opencode:jack',
          expectedRunId: 'run-permission-bob',
          expectedCapabilitySnapshotId: null,
          expectedBehaviorFingerprint: null,
          expectedManifestHighWatermark: null,
          commandLeaseId: null,
          idempotencyKey: 'idempotency-permission-lane-mismatch',
        },
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain(
      'OpenCode bridge expected laneId precondition does not match command laneId',
    )
    expect(getCalls).toBe(0)
    expect(answerCalls).toBe(0)
    expect(reconcileCalls).toBe(0)
  })

  test('rejects stale mixed OpenCode permission run preconditions before answering permissions', async () => {
    let getCalls = 0
    let answerCalls = 0
    let reconcileCalls = 0
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async () => {
      getCalls += 1
      return buildRecord({
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        opencodeSessionId: 'session-bob',
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.answerPermission = (async () => {
      answerCalls += 1
    }) as typeof openCodeSessionBridge.answerPermission
    openCodeSessionBridge.reconcileSession = (async record => {
      reconcileCalls += 1
      return {
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
        }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.answerPermission', {
        runId: 'run-current',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        memberName: 'bob',
        requestId: 'perm-bob',
        decision: 'allow',
        preconditions: {
          handshakeIdentityHash: 'handshake-1',
          laneId: 'secondary:opencode:bob',
          expectedRunId: 'run-stale',
          expectedCapabilitySnapshotId: null,
          expectedBehaviorFingerprint: null,
          expectedManifestHighWatermark: null,
          commandLeaseId: null,
          idempotencyKey: 'idempotency-permission-run-mismatch',
        },
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain(
      'OpenCode bridge expectedRunId precondition does not match command runId',
    )
    expect(getCalls).toBe(0)
    expect(answerCalls).toBe(0)
    expect(reconcileCalls).toBe(0)
  })

  test('marks the lane ready after answering permission when bootstrap confirmation is already present', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async () =>
      buildRecord({
        laneId: 'secondary:opencode:alice',
        memberName: 'alice',
      })) as typeof openCodeSessionStore.get
    openCodeSessionStore.list = (async () => [
      buildRecord({
        laneId: 'secondary:opencode:alice',
        memberName: 'alice',
      }),
    ]) as typeof openCodeSessionStore.list
    const answered: Array<{ requestId: string; decision: string }> = []
    openCodeSessionBridge.answerPermission = (async (_record, input) => {
      answered.push(input)
    }) as typeof openCodeSessionBridge.answerPermission
    openCodeSessionBridge.reconcileSession = (async record => ({
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        pendingPermissionRequestIds: [],
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.answerPermission', {
        runId: 'run-1',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        memberName: 'alice',
        requestId: 'perm-1',
        decision: 'allow',
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(answered).toEqual([{ requestId: 'perm-1', decision: 'allow' }])
    expect(result.data.teamLaunchState).toBe('ready')
    expect(result.data.members.alice?.launchState).toBe('confirmed_alive')
    expect(result.data.members.alice?.runtimePid).toBe(123)
  })

  for (const runId of ['run-other', null]) {
    for (const nested of [false, true]) {
      test(`rejects permission record run ${runId} with nested expectation ${nested}`, async () => {
        openCodeProvisioningProbe.probe = async () => snapshot
        const record = buildRecord({ runId })
        openCodeSessionStore.get = async () => record
        openCodeSessionStore.list = async () => [record]
        let answers = 0
        openCodeSessionBridge.answerPermission = async () => { answers++ }
        const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.answerPermission', {
          teamId: 'team-a', laneId: 'primary', memberName: record.memberName,
          requestId: 'perm-1', decision: 'allow',
          ...(nested ? { runId: 'run-1', preconditions: {
            handshakeIdentityHash: 'handshake-1', laneId: 'primary', expectedRunId: 'run-1',
            expectedCapabilitySnapshotId: null, expectedBehaviorFingerprint: null,
            expectedManifestHighWatermark: null, commandLeaseId: null, idempotencyKey: 'permission',
          } } : { runId: 'run-1' }),
        }))
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error.message).toContain('active run precondition is stale')
        expect(answers).toBe(0)
      })
    }
  }

  for (const memberName of ['alice', undefined]) {
    for (const scenario of ['missing', 'matching', 'wrong-store-lane', 'legacy-primary'] as const) {
      test(`selects nested permission lane with member ${memberName}: ${scenario}`, async () => {
        openCodeProvisioningProbe.probe = async () => snapshot
        const laneId = scenario === 'legacy-primary' ? 'primary' : 'laneA'
        const wrongRecord = buildRecord({ laneId: 'laneB', runId: 'run-1', memberName: 'alice' })
        const matchingRecord = buildRecord({
          laneId: scenario === 'legacy-primary' ? undefined : laneId,
          runId: 'run-1', memberName: 'alice',
        })
        const records = scenario === 'matching' || scenario === 'legacy-primary'
          ? [wrongRecord, matchingRecord] : [wrongRecord]
        const lookups: string[] = []
        openCodeSessionStore.list = async () => records
        openCodeSessionStore.get = async (_team, lane) => {
          lookups.push(lane)
          return scenario === 'wrong-store-lane' ? wrongRecord
            : records.find(record => (record.laneId ?? 'primary') === lane) ?? null
        }
        const answered: OpenCodeSessionRecord[] = []
        openCodeSessionBridge.answerPermission = async record => { answered.push(record) }
        openCodeSessionBridge.reconcileSession = (async record => ({
          summary: buildReconcileSummary({ sessionId: record.opencodeSessionId }),
        })) as typeof openCodeSessionBridge.reconcileSession
        const result = await executeOpenCodeBridgeCommandEnvelope(buildEnvelope('opencode.answerPermission', {
          teamId: 'team-a', memberName, requestId: 'perm-1', decision: 'allow',
          preconditions: {
            handshakeIdentityHash: 'handshake-1', laneId, expectedRunId: 'run-1',
            expectedCapabilitySnapshotId: null, expectedBehaviorFingerprint: null,
            expectedManifestHighWatermark: 2, commandLeaseId: null, idempotencyKey: 'permission',
          },
        }))
        const succeeds = scenario === 'matching' || scenario === 'legacy-primary'
        expect(result.ok).toBe(succeeds)
        expect(answered).toEqual(succeeds ? [matchingRecord] : [])
        expect(lookups).toEqual(memberName ? [laneId] : [])
        if (!result.ok) {
          expect(result.error.message).toContain(memberName && scenario === 'wrong-store-lane'
            ? 'selected session laneId does not match command laneId'
            : 'No OpenCode session record found')
        }
        if (result.ok) expect(result.data.manifestHighWatermark).toBe(2)
      })
    }
  }

  test('answers a permission against a non-zero app manifest high watermark', async () => {
    // Reproduces the live failure: after a launch the app's lane manifest
    // watermark is >= 1, and answering a permission carried that value into a
    // comparison against a bridge constant of 0.
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.list = (async () => [
      buildRecord({
        laneId: 'secondary:opencode:alice',
        memberName: 'alice',
      }),
    ]) as typeof openCodeSessionStore.list
    const answered: Array<{ requestId: string; decision: string }> = []
    openCodeSessionBridge.answerPermission = (async (_record, input) => {
      answered.push(input)
    }) as typeof openCodeSessionBridge.answerPermission
    openCodeSessionBridge.reconcileSession = (async record => ({
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        pendingPermissionRequestIds: [],
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.answerPermission', {
        runId: 'run-1',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        memberName: 'alice',
        requestId: 'perm-1',
        decision: 'allow',
        preconditions: {
          handshakeIdentityHash: 'handshake-1',
          laneId: 'secondary:opencode:alice',
          expectedRunId: 'run-1',
          expectedCapabilitySnapshotId: null,
          expectedBehaviorFingerprint: null,
          expectedManifestHighWatermark: 2,
          commandLeaseId: null,
          idempotencyKey: 'idempotency-permission-watermark',
        },
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(answered).toEqual([{ requestId: 'perm-1', decision: 'allow' }])
    expect(result.data).toMatchObject({
      idempotencyKey: 'idempotency-permission-watermark',
      manifestHighWatermark: 2,
      runtimeStoreManifestHighWatermark: 2,
    })
  })

  test('keeps lane-level permission state after answering one member when another member is still blocked', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async () =>
      buildRecord({
        laneId: 'primary',
        memberName: 'alice',
        opencodeSessionId: 'session-alice',
      })) as typeof openCodeSessionStore.get
    openCodeSessionStore.list = (async () => [
      buildRecord({
        laneId: 'primary',
        memberName: 'alice',
        opencodeSessionId: 'session-alice',
      }),
      buildRecord({
        laneId: 'primary',
        memberName: 'bob',
        opencodeSessionId: 'session-bob',
      }),
    ]) as typeof openCodeSessionStore.list
    openCodeSessionBridge.answerPermission = (async () => {}) as typeof openCodeSessionBridge.answerPermission
    openCodeSessionBridge.reconcileSession = (async record => ({
      summary:
        record.opencodeSessionId === 'session-alice'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            pendingPermissionRequestIds: [],
          })
          : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: null,
            latestAssistantText: null,
            latestAssistantPreview: null,
            messageCount: 0,
            durableState: 'blocked',
            pendingPermissionRequestIds: ['perm-bob'],
            pendingPermissions: [
              {
                requestId: 'perm-bob',
                sessionId: 'session-bob',
                tool: 'bash',
                title: 'Run npm test',
                kind: 'tool',
                raw: {
                  requestID: 'perm-bob',
                  sessionID: 'session-bob',
                  tool: 'bash',
                  title: 'Run npm test',
                  kind: 'tool',
                },
              },
            ],
            messages: [],
          }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.answerPermission', {
        runId: 'run-1',
        laneId: 'primary',
        teamId: 'team-a',
        teamName: 'team-a',
        memberName: 'alice',
        requestId: 'perm-alice',
        decision: 'allow',
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.teamLaunchState).toBe('permission_blocked')
    expect(result.data.members.alice?.launchState).toBe('confirmed_alive')
    expect(result.data.members.bob?.launchState).toBe('permission_blocked')
    expect(result.data.members.bob?.pendingPermissionRequestIds).toEqual(['perm-bob'])
    expect(result.data.members.bob?.pendingPermissions).toMatchObject([
      {
        requestId: 'perm-bob',
        sessionId: 'session-bob',
        tool: 'bash',
        title: 'Run npm test',
      },
    ])
  })

  test('keeps OpenCode permission peers visible when one post-answer reconcile throws', async () => {
    const answered: Array<{ memberName: string; requestId: string; decision: string }> = []
    const reconciledMembers: string[] = []
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async () =>
      buildRecord({
        laneId: 'primary',
        memberName: 'alice',
        opencodeSessionId: 'session-alice',
        runtimePid: 1001,
      })) as typeof openCodeSessionStore.get
    openCodeSessionStore.list = (async () => [
      buildRecord({
        laneId: 'primary',
        memberName: 'alice',
        opencodeSessionId: 'session-alice',
        runtimePid: 1001,
      }),
      buildRecord({
        laneId: 'primary',
        memberName: 'bob',
        opencodeSessionId: 'session-bob',
        runtimePid: 1002,
      }),
      buildRecord({
        laneId: 'primary',
        memberName: 'zoe',
        opencodeSessionId: 'session-zoe',
        runtimePid: 1003,
      }),
    ]) as typeof openCodeSessionStore.list
    openCodeSessionBridge.answerPermission = (async (record, input) => {
      answered.push({
        memberName: record.memberName,
        requestId: input.requestId,
        decision: input.decision,
      })
    }) as typeof openCodeSessionBridge.answerPermission
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      if (record.memberName === 'bob') {
        throw new Error('bob post-permission reconcile failed')
      }
      return {
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
          latestAssistantMessageId: `msg-${record.memberName}-ready`,
          latestAssistantText: `${record.memberName} ready`,
        }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.answerPermission', {
        runId: 'run-1',
        laneId: 'primary',
        teamId: 'team-a',
        teamName: 'team-a',
        memberName: 'alice',
        requestId: 'perm-alice',
        decision: 'allow',
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(answered).toEqual([
      { memberName: 'alice', requestId: 'perm-alice', decision: 'allow' },
    ])
    expect(reconciledMembers).toEqual(['alice', 'bob', 'zoe'])
    expect(result.data.teamLaunchState).toBe('failed')
    expect(result.data.members.alice?.launchState).toBe('confirmed_alive')
    expect(result.data.members.alice?.runtimePid).toBe(1001)
    expect(result.data.members.bob).toMatchObject({
      sessionId: 'session-bob',
      launchState: 'failed',
      runtimePid: 1002,
      diagnostics: ['bob post-permission reconcile failed'],
    })
    expect(result.data.members.bob?.evidence.map(entry => entry.kind)).toEqual([
      'member_reconcile_failed',
    ])
    expect(result.data.members.zoe?.launchState).toBe('confirmed_alive')
    expect(result.data.members.zoe?.runtimePid).toBe(1003)
    expect(result.data.diagnostics).toContainEqual({
      code: 'permission_reconcile_failed',
      message: 'bob: bob post-permission reconcile failed',
      severity: 'error',
    })
  })

  test('answers permission only inside the addressed mixed OpenCode secondary lane', async () => {
    const answered: Array<{ memberName: string; requestId: string; decision: string }> = []
    const reconciledMembers: string[] = []
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async () =>
      buildRecord({
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        opencodeSessionId: 'session-bob',
      })) as typeof openCodeSessionStore.get
    openCodeSessionStore.list = (async () => [
      buildRecord({
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        opencodeSessionId: 'session-bob',
      }),
      buildRecord({
        laneId: 'secondary:opencode:jack',
        memberName: 'jack',
        opencodeSessionId: 'session-jack',
      }),
    ]) as typeof openCodeSessionStore.list
    openCodeSessionBridge.answerPermission = (async (record, input) => {
      answered.push({
        memberName: record.memberName,
        requestId: input.requestId,
        decision: input.decision,
      })
    }) as typeof openCodeSessionBridge.answerPermission
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
          latestAssistantMessageId: `msg-${record.memberName}-ready`,
          latestAssistantText: `${record.memberName} ready`,
        }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.answerPermission', {
        runId: 'run-1',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        memberName: 'bob',
        requestId: 'perm-bob',
        decision: 'allow',
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(answered).toEqual([
      { memberName: 'bob', requestId: 'perm-bob', decision: 'allow' },
    ])
    expect(reconciledMembers).toEqual(['bob'])
    expect(Object.keys(result.data.members)).toEqual(['bob'])
    expect(result.data.members.jack).toBeUndefined()
    expect(result.data.teamLaunchState).toBe('ready')
  })

  test('aggregates runtime permissions across all sessions in the addressed lane', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.list = (async () => [
      buildRecord({
        laneId: 'primary',
        memberName: 'alice',
        opencodeSessionId: 'session-alice',
      }),
      buildRecord({
        laneId: 'primary',
        memberName: 'bob',
        opencodeSessionId: 'session-bob',
      }),
    ]) as typeof openCodeSessionStore.list
    openCodeSessionBridge.reconcileSession = (async record => ({
      summary:
        record.opencodeSessionId === 'session-alice'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            pendingPermissionRequestIds: ['perm-1'],
            pendingPermissions: [
              {
                requestId: 'perm-1',
                sessionId: 'session-alice',
                tool: 'bash',
                title: 'Run git status',
                kind: 'tool',
                raw: {
                  requestID: 'perm-1',
                  sessionID: 'session-alice',
                  tool: 'bash',
                  title: 'Run git status',
                  kind: 'tool',
                },
              },
            ],
          })
          : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            pendingPermissionRequestIds: ['perm-2', 'perm-1'],
            pendingPermissions: [
              {
                requestId: 'perm-2',
                sessionId: 'session-bob',
                tool: 'write',
                title: 'Write src/file.ts',
                kind: 'tool',
                raw: {
                  requestID: 'perm-2',
                  sessionID: 'session-bob',
                  tool: 'write',
                  title: 'Write src/file.ts',
                  kind: 'tool',
                },
              },
            ],
          }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.listRuntimePermissions', {
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'primary',
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.permissions.map(permission => permission.requestId)).toEqual([
      'perm-1',
      'perm-2',
    ])
    expect(result.data.permissions).toMatchObject([
      {
        requestId: 'perm-1',
        sessionId: 'session-alice',
        tool: 'bash',
        title: 'Run git status',
      },
      {
        requestId: 'perm-2',
        sessionId: 'session-bob',
        tool: 'write',
        title: 'Write src/file.ts',
      },
    ])
  })

  test('filters runtime permissions by member session and preserves synthetic permission session ids', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.list = (async () => [
      buildRecord({
        laneId: 'primary',
        memberName: 'alice',
        opencodeSessionId: 'session-alice',
      }),
      buildRecord({
        laneId: 'primary',
        memberName: 'bob',
        opencodeSessionId: 'session-bob',
      }),
    ]) as typeof openCodeSessionStore.list
    const reconciledMembers: string[] = []
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
          pendingPermissionRequestIds: [`perm-${record.memberName}`],
          pendingPermissions: [],
        }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.listRuntimePermissions', {
        teamId: 'team-a',
        teamName: 'team-a',
        laneId: 'primary',
        memberName: 'bob',
        sessionId: 'session-bob',
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(reconciledMembers).toEqual(['bob'])
    expect(result.data.permissions).toEqual([
      {
        requestId: 'perm-bob',
        sessionId: 'session-bob',
        tool: null,
        title: null,
        kind: null,
        raw: {
          requestID: 'perm-bob',
          sessionID: 'session-bob',
        },
      },
    ])
  })

  test('rejects runtime permission aggregation without laneId when multiple OpenCode lanes exist', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.list = (async () => [
      buildRecord({
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        opencodeSessionId: 'session-bob',
      }),
      buildRecord({
        laneId: 'secondary:opencode:jack',
        memberName: 'jack',
        opencodeSessionId: 'session-jack',
      }),
    ]) as typeof openCodeSessionStore.list

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.listRuntimePermissions', {
        teamId: 'team-a',
        teamName: 'team-a',
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain('laneId is required')
  })

  test('observes message delivery through stored session authority without inventory provisioning', async () => {
    const manualRecord = buildRecord({
      runId: 'run-observe', selectedModel: 'zai/glm-5.2',
      profileScope: { purpose: 'launch_runtime', providerId: 'zai', scopeToken: 'lane-scope',
        configFingerprint: 'config', selectedAuthIdentity: 'absent' },
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob',
      toolApprovalMode: 'manual',
    })
    const reconciledSessions: Array<string | null | undefined> = []
    openCodeProvisioningProbe.probe = (async () => {
      throw new Error('delivery observation must not probe inventory')
    }) as typeof openCodeProvisioningProbe.probe
    openCodeSessionStore.list = async () => [manualRecord]
    openCodeProvisioningProbe.probeRetainingHost = async (_project, options) => {
      expect(options).toMatchObject({ selectedModel: 'zai/glm-5.2', toolApprovalMode: 'manual' })
      return { snapshot: { ...snapshot, config: { snapshot: true } }, host: snapshot.host, release: async () => {} }
    }
    openCodeSessionStore.get = (async () => manualRecord) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async (record, options) => {
      expect(record.toolApprovalMode).toBe('manual')
      reconciledSessions.push(options?.sessionId)
      return {
        record,
        summary: buildReconcileSummary({
          sessionId: 'session-bob',
          messageCount: 2,
          latestAssistantMessageId: 'msg-assistant-delivery',
          latestAssistantText: 'delivery observed',
          latestAssistantPreview: 'delivery observed',
          messages: [
            buildCanonicalMessage({
              id: 'msg-runtime-prompt',
              role: 'user',
              text: 'deliver message msg-inbound-1',
            }),
            buildCanonicalMessage({
              id: 'msg-assistant-delivery',
              parentId: 'msg-runtime-prompt',
              role: 'assistant',
              text: 'delivery observed',
              previewText: 'delivery observed',
            }),
          ],
        }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.observeMessageDelivery', {
        runId: 'run-observe',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        memberName: 'bob',
        messageId: 'msg-inbound-1',
        sessionId: 'session-bob',
        runtimePromptMessageId: 'msg-runtime-prompt',
        prePromptCursor: 'cursor-before',
      }),
    )

    expect(result.ok).toBe(true)
    if (!('data' in result) || !('responseObservation' in result.data) || !('snapshotBoundary' in result.data)) {
      throw new Error('missing delivery observation')
    }
    expect(result.data.snapshotBoundary.captureStatus).not.toBe('snapshot-disabled')
    expect(reconciledSessions).toEqual(['session-bob'])
    expect(result.data.responseObservation.state).toBe('responded_plain_text')
    expect(result.data.responseObservation.deliveredUserMessageId).toBe('msg-runtime-prompt')
  })

  test('rejects ambiguous transcript reads without laneId when multiple lanes exist', async () => {
    openCodeSessionStore.list = (async () => [
      buildRecord({ laneId: 'secondary:opencode:alice', memberName: 'alice' }),
      buildRecord({ laneId: 'secondary:opencode:alice:alt', memberName: 'alice', opencodeSessionId: 'session-alt' }),
    ]) as typeof openCodeSessionStore.list

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.getRuntimeTranscript', {
        teamId: 'team-a',
        teamName: 'team-a',
        memberName: 'alice',
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain('laneId is required')
  })

  test('uses sessionId to select an exact transcript when multiple member lanes exist', async () => {
    const selectedRecord = buildRecord({
      laneId: 'secondary:opencode:alice:alt',
      memberName: 'alice',
      opencodeSessionId: 'session-alt',
      toolApprovalMode: 'manual',
    })
    const projectedRecords: OpenCodeSessionRecord[] = []
    openCodeProvisioningProbe.probe = (async () => {
      throw new Error('transcript should not probe provisioning')
    }) as typeof openCodeProvisioningProbe.probe
    openCodeSessionStore.list = (async () => [
      buildRecord({ laneId: 'secondary:opencode:alice', memberName: 'alice' }),
      selectedRecord,
    ]) as typeof openCodeSessionStore.list
    openCodeSessionBridge.projectLogMessages = (async record => {
      projectedRecords.push(record)
      return {
        record,
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
          messages: [],
        }),
        logProjection: {
          sessionId: record.opencodeSessionId,
          durableState: 'idle',
          sourceMessageCount: 0,
          projectedMessageCount: 0,
          syntheticMessageCount: 0,
          toolCallCount: 0,
          errorCount: 0,
          diagnostics: [],
          messages: [],
        },
      }
    }) as typeof openCodeSessionBridge.projectLogMessages

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.getRuntimeTranscript', {
        teamId: 'team-a',
        teamName: 'team-a',
        memberName: 'alice',
        sessionId: 'session-alt',
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(projectedRecords.map(record => record.opencodeSessionId)).toEqual(['session-alt'])
    expect(result.data.sessionId).toBe('session-alt')
  })

  test('rejects transcript sessionId when the selected lane points at a different session', async () => {
    openCodeSessionStore.get = (async () =>
      buildRecord({
        laneId: 'secondary:opencode:alice',
        memberName: 'alice',
        opencodeSessionId: 'session-current',
      })) as typeof openCodeSessionStore.get
    openCodeSessionBridge.projectLogMessages = (async () => {
      throw new Error('projectLogMessages should not run')
    }) as typeof openCodeSessionBridge.projectLogMessages

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.getRuntimeTranscript', {
        teamId: 'team-a',
        teamName: 'team-a',
        memberName: 'alice',
        laneId: 'secondary:opencode:alice',
        sessionId: 'session-old',
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain('does not match sessionId session-old')
  })
})

describe('free-tier readiness', () => {
  const failedProbe = (failureCode?: 'free_tier_restricted') => ({
    providerId: 'opencode' as const,
    modelId: 'opencode/big-pickle',
    probePrompt: 'p',
    expectedOutput: 'e',
    outcome: 'unavailable' as const,
    reason: failureCode ? 'OpenCode rejected this free-tier request (HTTP 403).' : 'model failed',
    durationMs: 1,
    rawStatus: null,
    durableState: 'idle' as const,
    latestAssistantText: null,
    latestAssistantPreview: null,
    toolCallCount: 0,
    errorCount: 1,
    diagnostics: [],
    ...(failureCode ? { failureCode } : {}),
  })
  const noMcpProof = { ok: false, observedTools: [], missingTools: ['x'], diagnostics: [], route: null, contractConfigIdentity: null }
  const disconnected = { ...snapshot, appMcp: { ...snapshot.appMcp!, status: 'missing' as const, connected: false } }

  test('reports the free-tier refusal even when the MCP contract is also unavailable', () => {
    const data = __readinessDataForTests(disconnected, 'opencode/big-pickle', failedProbe('free_tier_restricted'), noMcpProof, true)
    expect(data.state).toBe('model_unavailable')
    expect(data.launchAllowed).toBe(false)
    expect((data as { failureCode?: string }).failureCode).toBe('free_tier_restricted')
    expect(data.missing[0]).toContain('free-tier')
  })

  test('keeps the existing MCP state and adds no code for other probe failures', () => {
    const data = __readinessDataForTests(disconnected, 'opencode/big-pickle', failedProbe(), noMcpProof, true)
    expect(data.state).toBe('mcp_unavailable')
    expect((data as { failureCode?: string }).failureCode).toBeUndefined()
  })
})
