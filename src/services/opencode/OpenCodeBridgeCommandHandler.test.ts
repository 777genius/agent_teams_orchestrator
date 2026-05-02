import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'

import {
  __resetAppMcpToolProofCacheForTests,
  executeOpenCodeBridgeCommandEnvelope,
} from './OpenCodeBridgeCommandHandler.js'
import { openCodeExecutionProbe } from './OpenCodeExecutionProbe.js'
import { openCodeHostManager } from './OpenCodeHostManager.js'
import { openCodeLedgerBridgeService } from './OpenCodeLedgerBridgeService.js'
import { openCodeProvisioningProbe } from './OpenCodeProvisioningProbe.js'
import { RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV } from './OpenCodeRuntimeTurnSettledEmitter.js'
import { openCodeSessionBridge } from './OpenCodeSessionBridge.js'
import { openCodeSessionStore } from './OpenCodeSessionStore.js'

import type { OpenCodeTurnSettledSummary } from './OpenCodeTurnSettledObserver.js'
import type {
  OpenCodeCanonicalMessage,
  OpenCodeCanonicalToolCall,
  OpenCodeProvisioningSnapshot,
  OpenCodeSessionRecord,
  OpenCodeSessionReconcileSummary,
} from './types.js'

const snapshot: OpenCodeProvisioningSnapshot = {
  detected: true,
  hostHealthy: true,
  projectPath: '/tmp/project',
  profile: {
    projectPath: '/tmp/project',
    profileRootKey: 'profile-root',
    profileRootPath: '/tmp/profile-root',
    projectBehaviorFingerprint: 'behavior-v1',
    behaviorSources: ['AGENTS.md'],
    managedConfig: {},
    managedConfigFingerprint: 'managed-config-v1',
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
      profileRootKey: 'profile-root',
      profileRootPath: '/tmp/profile-root',
      projectBehaviorFingerprint: 'behavior-v1',
      behaviorSources: ['AGENTS.md'],
      managedConfig: {},
      managedConfigFingerprint: 'managed-config-v1',
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
    resolvedConfigFingerprint: 'resolved-fingerprint',
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
    lastCanonicalCursor: null,
    lastKnownRawStatus: null,
    lastKnownDurableState: 'idle',
    sourceAuthFingerprint: 'source-auth',
    managedAuthFingerprint: 'managed-auth',
    projectBehaviorFingerprint: 'behavior-v1',
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
    toolCallCount: 0,
    errorCount: 0,
    lastCanonicalCursor: 'cursor-1',
    latestUserMessageId: null,
    latestAssistantMessageId: 'msg-assistant-1',
    latestAssistantText: 'ready',
    latestAssistantPreview: 'ready',
    replyPendingSinceMessageId: null,
    messages: [],
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

function expectOpenCodeIdentityPrompt(input: {
  text: string
  teamName: string
  memberName: string
  runtimeSessionId: string
  runId: string
  originalPrompt: string
}): void {
  expect(input.text).toContain('agent-teams_message_send')
  expect(input.text).toContain('"runtimeProvider":"opencode"')
  expect(input.text).toContain(`"teamName":"${input.teamName}"`)
  expect(input.text).toContain(`"memberName":"${input.memberName}"`)
  expect(input.text).toContain(`"runId":"${input.runId}"`)
  expect(input.text).toContain(`"runtimeSessionId":"${input.runtimeSessionId}"`)
  expect(input.text).toContain(input.originalPrompt)
  if (input.text.includes('Your first app-team MCP action must be runtime bootstrap check-in.')) {
    expect(input.text).toContain('agent-teams_runtime_bootstrap_checkin')
    expect(input.text).toContain('agent-teams_member_briefing')
    expect(input.text).toContain('Launch bootstrap is a silent attach')
    expect(input.text).toContain('stop this turn immediately')
    expect(input.text).toContain('stay idle silently')
  } else {
    expect(input.text).not.toContain('If check-in is needed')
    expect(input.text).toContain('do not call runtime_bootstrap_checkin just to answer')
    expect(input.text).toContain('Do not call member_briefing just to answer')
    expect(input.text).toContain('Do not send unrelated readiness')
  }
  expect(input.text).not.toContain('"laneId"')
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

const originalProbe = openCodeProvisioningProbe.probe
const originalProbeModel = openCodeExecutionProbe.probeModel
const originalReconcilePersistentHosts = openCodeHostManager.reconcilePersistentHosts
const originalEnsureSession = openCodeSessionBridge.ensureSession
const originalEnsureSessionAppMcpReady = openCodeSessionBridge.ensureSessionAppMcpReady
const originalPromptAsync = openCodeSessionBridge.promptAsync
const originalPromptAsyncWithTurnSettled = openCodeSessionBridge.promptAsyncWithTurnSettled
const originalReconcileSession = openCodeSessionBridge.reconcileSession
const originalObservePreview = openCodeSessionBridge.observePreview
const originalAbort = openCodeSessionBridge.abort
const originalReleaseSession = openCodeSessionBridge.releaseSession
const originalAnswerPermission = openCodeSessionBridge.answerPermission
const originalProjectLogMessages = openCodeSessionBridge.projectLogMessages
const originalList = openCodeSessionStore.list
const originalGet = openCodeSessionStore.get
const originalMarkStale = openCodeSessionStore.markStale
const originalBackfillTaskLedger = openCodeLedgerBridgeService.backfill
const originalClientConnect = Client.prototype.connect
const originalClientListTools = Client.prototype.listTools
const originalClientClose = Client.prototype.close
let previousRuntimeTurnSettledSpoolRoot: string | undefined

beforeEach(() => {
  previousRuntimeTurnSettledSpoolRoot = process.env[RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV]
  mockRequiredMcpTools()
  openCodeSessionBridge.promptAsyncWithTurnSettled = (async (record, input) => {
    await openCodeSessionBridge.promptAsync(record, input)
    const runtimePromptMessageId = 'msg_test_turn_settled'
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
    return { runtimePromptMessageId, turnSettled }
  }) as typeof openCodeSessionBridge.promptAsyncWithTurnSettled
  openCodeHostManager.reconcilePersistentHosts = (async () => ({
    cleaned: 0,
    remaining: 0,
    hosts: [],
    diagnostics: [],
  })) as typeof openCodeHostManager.reconcilePersistentHosts
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
})

afterEach(() => {
  if (previousRuntimeTurnSettledSpoolRoot == null) {
    delete process.env[RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV]
  } else {
    process.env[RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV] = previousRuntimeTurnSettledSpoolRoot
  }
  __resetAppMcpToolProofCacheForTests()
  openCodeProvisioningProbe.probe = originalProbe
  openCodeExecutionProbe.probeModel = originalProbeModel
  openCodeHostManager.reconcilePersistentHosts = originalReconcilePersistentHosts
  openCodeSessionBridge.ensureSession = originalEnsureSession
  openCodeSessionBridge.ensureSessionAppMcpReady = originalEnsureSessionAppMcpReady
  openCodeSessionBridge.promptAsync = originalPromptAsync
  openCodeSessionBridge.promptAsyncWithTurnSettled = originalPromptAsyncWithTurnSettled
  openCodeSessionBridge.reconcileSession = originalReconcileSession
  openCodeSessionBridge.observePreview = originalObservePreview
  openCodeSessionBridge.abort = originalAbort
  openCodeSessionBridge.releaseSession = originalReleaseSession
  openCodeSessionBridge.answerPermission = originalAnswerPermission
  openCodeSessionBridge.projectLogMessages = originalProjectLogMessages
  openCodeSessionStore.list = originalList
  openCodeSessionStore.get = originalGet
  openCodeSessionStore.markStale = originalMarkStale
  openCodeLedgerBridgeService.backfill = originalBackfillTaskLedger
  Client.prototype.connect = originalClientConnect
  Client.prototype.listTools = originalClientListTools
  Client.prototype.close = originalClientClose
})

function buildEnvelope(command: string, body: Record<string, unknown>) {
  return {
    schemaVersion: 1 as const,
    requestId: 'req-1',
    command,
    cwd: '/tmp/project',
    startedAt: '2026-04-22T12:00:00.000Z',
    timeoutMs: 30_000,
    body,
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(nextResolve => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

describe('OpenCodeBridgeCommandHandler', () => {
  test('exposes the OpenCode task ledger evidence contract version in handshake', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.handshake', {}),
    )

    expect(result.ok).toBe(true)
    expect(result.data.server.bridgeProtocol.opencodeTaskLedgerEvidenceContractVersion).toBe(1)
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
        selectedModel: 'ghost-model',
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

  test('compatibility mode without execution probe still rejects ambiguous raw model ids', async () => {
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
        selectedModel: 'minimax-m2.5-free',
        requireExecutionProbe: false,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.state).toBe('model_unavailable')
    expect(result.data.launchAllowed).toBe(false)
    expect(result.data.missing[0]).toContain('is ambiguous')
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

  test('deep readiness still resolves the raw model id and uses the execution probe', async () => {
    mockRequiredMcpTools()
    openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()
    let probedModelId: string | null = null
    openCodeExecutionProbe.probeModel = (async input => {
      probedModelId = input.selectedModel
      return {
        providerId: 'opencode' as const,
        modelId: input.selectedModel,
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
    }) as typeof openCodeExecutionProbe.probeModel

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        requireExecutionProbe: true,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(probedModelId).toBe('openrouter/minimax-m2.5-free')
    expect(result.data.state).toBe('ready')
    expect(result.data.launchAllowed).toBe(true)
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
        selectedModel: 'minimax-m2.5-free',
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

  test('direct MCP proof compares plain names but readiness evidence emits canonical OpenCode ids', async () => {
    mockRequiredMcpTools()
    openCodeProvisioningProbe.probe = async () => buildReadinessSnapshot()

    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
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
        selectedModel: 'minimax-m2.5-free',
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
        selectedModel: 'minimax-m2.5-free',
        requireExecutionProbe: false,
      }),
    )
    const secondResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        requireExecutionProbe: false,
      }),
    )

    expect(firstResult.ok).toBe(true)
    expect(secondResult.ok).toBe(true)
    expect(connectCalls).toBe(1)
    expect(listToolsCalls).toBe(1)
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
        selectedModel: 'minimax-m2.5-free',
        requireExecutionProbe: false,
      }),
    )
    const secondPromise = executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.readiness', {
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
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
    expect(
      (result.data as { members: Record<string, { runtimePid?: number }> }).members.alice?.runtimePid,
    ).toBe(123)
    expect(Object.keys((result.data as { members: Record<string, unknown> }).members)).toEqual([
      'alice',
    ])
  })

  test('launches provider-scoped OpenCode model ids that contain nested slashes', async () => {
    const ensureInputs: Array<{ memberName: string; selectedModel: string }> = []
    openCodeProvisioningProbe.probe = async () => snapshot
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
        runId: 'run-nested-slash-model',
        laneId: 'secondary:opencode:alice',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/moonshotai/kimi-k2',
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
      },
    ])
    expect(result.data.teamLaunchState).toBe('ready')
    expect(result.data.members.alice?.launchState).toBe('confirmed_alive')
  })

  test('launches raw OpenCode model ids that contain slashes when the catalog match is unique', async () => {
    const ensureInputs: Array<{ memberName: string; selectedModel: string }> = []
    openCodeProvisioningProbe.probe = async () => snapshot
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
        selectedModel: 'moonshotai/kimi-k2',
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
      },
    ])
    expect(result.data.teamLaunchState).toBe('ready')
    expect(result.data.members.alice?.launchState).toBe('confirmed_alive')
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
      'member_session_recorded',
    ])
  })

  test('marks launch failed when required bootstrap MCP tools report Not connected', async () => {
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
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

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
    expect(result.data.teamLaunchState).toBe('failed')
    expect(result.data.members.alice?.launchState).toBe('failed')
    expect(result.data.members.alice?.diagnostics).toContain(
      'OpenCode bootstrap MCP tool failed before required attach completed: runtime_bootstrap_checkin, member_briefing',
    )
    expect(result.data.members.alice?.evidence.map(entry => entry.kind)).toEqual([
      'member_session_recorded',
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
      diagnostics: ['alice: not visible yet'],
    })
    expect(result.data.members.alice?.evidence.map(entry => entry.kind)).toEqual([
      'member_prompt_accepted',
    ])
    expect(result.data.diagnostics).toContainEqual({
      code: 'member_launch_reconcile_pending',
      message: 'alice: not visible yet',
      severity: 'warning',
    })
  })

  test('aggregates a multi-member OpenCode lane with ready and permission-blocked members', async () => {
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
      { memberName: 'alice', agent: 'teammate' },
      { memberName: 'bob', agent: 'teammate' },
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
    expect(result.data.teamLaunchState).toBe('permission_blocked')
    expect(result.data.members.alice?.launchState).toBe('confirmed_alive')
    expect(result.data.members.alice?.runtimePid).toBe(701)
    expect(result.data.members.bob?.launchState).toBe('permission_blocked')
    expect(result.data.members.bob?.runtimePid).toBe(702)
    expect(result.data.members.bob?.pendingPermissionRequestIds).toEqual([
      'perm-bob',
      'perm-shell',
    ])
    expect(result.data.diagnostics).toEqual([
      {
        code: 'member_reconcile',
        message: 'bob: bob waiting for permission',
        severity: 'warning',
      },
    ])
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
      expect(prompt.agent).toBe('teammate')
      expect(prompt.text).toContain('<opencode_runtime_identity>')
      expect(prompt.text).toContain('agent-teams_runtime_bootstrap_checkin')
      expect(prompt.text).toContain('agent-teams_member_briefing')
      expect(prompt.text).toContain('"runtimeProvider":"opencode"')
      expect(prompt.text).toContain('agent-teams_message_send')
      expect(prompt.text).toContain('Do not use SendMessage.')
      expect(prompt.text).toContain('Known failure modes include plain assistant replies')
      expect(prompt.text).not.toContain('Call SendMessage')
      expect(prompt.text).not.toContain('Use SendMessage')
      expect(prompt.text).not.toContain('"laneId"')
      expect(prompt.text.indexOf('<opencode_runtime_identity>')).toBeLessThan(
        prompt.text.indexOf('Team launch context:')
      )
    }
    expect(result.data.teamLaunchState).toBe('ready')
    expect(result.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(result.data.members.jack?.launchState).toBe('confirmed_alive')
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
    expect(ensureInputs).toEqual(['alice', 'bob', 'zoe'])
    expect(promptAttempts).toEqual(['alice', 'bob', 'zoe'])
    expect(reconciledMembers).toEqual(['alice', 'zoe'])
    expect(result.data.teamLaunchState).toBe('failed')
    expect(result.data.members.alice?.launchState).toBe('confirmed_alive')
    expect(result.data.members.bob).toMatchObject({
      sessionId: 'session-bob',
      launchState: 'failed',
      runtimePid: 802,
      diagnostics: ['bob prompt delivery failed'],
    })
    expect(result.data.members.bob?.evidence.map(entry => entry.kind)).toEqual([
      'member_launch_failed',
    ])
    expect(result.data.members.zoe?.launchState).toBe('confirmed_alive')
    expect(result.data.diagnostics).toContainEqual({
      code: 'member_launch_failed',
      message: 'bob: bob prompt delivery failed',
      severity: 'error',
    })
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
    expect(ensureInputs).toEqual(['alice', 'bob', 'zoe'])
    expect(promptAttempts).toEqual(['alice', 'zoe'])
    expect(reconciledMembers).toEqual(['alice', 'zoe'])
    expect(result.data.teamLaunchState).toBe('failed')
    expect(result.data.members.alice?.launchState).toBe('confirmed_alive')
    expect(result.data.members.alice?.runtimePid).toBe(1101)
    expect(result.data.members.bob).toMatchObject({
      sessionId: 'failed:team-a:primary:bob',
      launchState: 'failed',
      runtimePid: 123,
      diagnostics: ['bob ensure session failed'],
    })
    expect(result.data.members.bob?.evidence.map(entry => entry.kind)).toEqual([
      'member_launch_failed',
    ])
    expect(result.data.members.zoe?.launchState).toBe('confirmed_alive')
    expect(result.data.members.zoe?.runtimePid).toBe(1103)
    expect(result.data.diagnostics).toContainEqual({
      code: 'member_launch_failed',
      message: 'bob: bob ensure session failed',
      severity: 'error',
    })
  })

  test('keeps ready peers visible when one OpenCode lane member reconciles as failed', async () => {
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
    expect(result.data.teamLaunchState).toBe('failed')
    expect(result.data.members.alice?.launchState).toBe('confirmed_alive')
    expect(result.data.members.bob?.launchState).toBe('failed')
    expect(result.data.members.bob?.runtimePid).toBe(123)
    expect(result.data.members.bob?.evidence.map(item => item.kind)).toEqual([
      'member_session_recorded',
    ])
    expect(result.data.diagnostics).toEqual([
      {
        code: 'member_reconcile',
        message: 'bob: bob session stale',
        severity: 'warning',
      },
    ])
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
      'OpenCode raw model id "ghost-model" was not found in the live provider catalog',
    )
    expect(ensureSessionCalls).toBe(0)
  })

  test('rejects launch before creating sessions when the provider-scoped selected model is unknown', async () => {
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
      'OpenCode provider-scoped model "openrouter/ghost-model" was not found in the live provider catalog',
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
        selectedModel: 'moonshotai/kimi-k2',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain(
      'OpenCode raw model id "moonshotai/kimi-k2" is ambiguous',
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
    expect(result.error.message).toContain(
      'OpenCode provider-scoped model "openrouter/ghost-model" was not found in the live provider catalog',
    )
    expect(connectCalls).toBe(0)
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
      'OpenCode provider "openrouter" for selected model "openrouter/minimax-m2.5-free" is not connected',
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
    expect(result.error.message).toContain(
      'OpenCode provider "openrouter" for selected model "openrouter/minimax-m2.5-free" is not connected',
    )
    expect(connectCalls).toBe(0)
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
        selectedModel: 'minimax-m2.5-free',
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
        selectedModel: 'minimax-m2.5-free',
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
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain('OpenCode raw model id "minimax-m2.5-free" is ambiguous')
    expect(result.error.message).toContain('openrouter/minimax-m2.5-free')
    expect(result.error.message).toContain('opencode/minimax-m2.5-free')
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
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain(
      'Agent Teams MCP tools are not visible in OpenCode',
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
        selectedModel: 'minimax-m2.5-free',
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

  test('rejects launch with no connected providers before MCP proof or session creation', async () => {
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
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain('No connected OpenCode providers found')
    expect(connectCalls).toBe(0)
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
        selectedModel: 'minimax-m2.5-free',
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

  test('rejects launch before creating sessions when the runtime manifest precondition is stale', async () => {
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
        runId: 'run-stale-manifest',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'team-a',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        manifestHighWatermark: 1,
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob side lane join' }],
      }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.error.message).toContain(
      'OpenCode bridge runtime manifest high watermark precondition is stale',
    )
    expect(ensureSessionCalls).toBe(0)
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
        selectedModel: 'minimax-m2.5-free',
        preconditions: {
          handshakeIdentityHash: 'handshake-1',
          laneId: 'secondary:opencode:jack',
          expectedRunId: 'run-lane-precondition',
          expectedCapabilitySnapshotId: null,
          expectedBehaviorFingerprint: null,
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
        selectedModel: 'minimax-m2.5-free',
        preconditions: {
          handshakeIdentityHash: 'handshake-1',
          laneId: 'secondary:opencode:bob',
          expectedRunId: 'run-stale',
          expectedCapabilitySnapshotId: null,
          expectedBehaviorFingerprint: null,
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
          selectedModel: 'minimax-m2.5-free',
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
        { memberName: 'bob', agent: 'teammate' },
        { memberName: 'jack', agent: 'teammate' },
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
      expect(result.data.teamLaunchState).toBe('ready')
      expect(result.data.members.bob?.launchState).toBe('confirmed_alive')
      expect(result.data.members.jack?.launchState).toBe('confirmed_alive')
      expect(result.data.durableCheckpoints.map(checkpoint => checkpoint.name)).toEqual([
        'required_tools_proven',
        'delivery_ready',
        'run_ready',
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
          selectedModel: 'minimax-m2.5-free',
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
      expect(result.data.teamLaunchState).toBe('ready')
      expect(result.data.members.bob?.launchState).toBe('confirmed_alive')
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
          selectedModel: 'minimax-m2.5-free',
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
      expect(bobResult.data.teamLaunchState).toBe('ready')
      expect(jackResult.data.teamLaunchState).toBe('ready')
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
          selectedModel: 'minimax-m2.5-free',
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
      expect(bobResult.data.teamLaunchState).toBe('failed')
      expect(bobResult.data.members.bob?.launchState).toBe('failed')
      expect(jackResult.data.teamLaunchState).toBe('ready')
      expect(jackResult.data.members.jack?.launchState).toBe('confirmed_alive')
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
          selectedModel: 'minimax-m2.5-free',
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
      expect(bobResult.data.teamLaunchState).toBe('permission_blocked')
      expect(bobResult.data.members.bob?.launchState).toBe('permission_blocked')
      expect(bobResult.data.members.bob?.pendingPermissionRequestIds).toEqual([
        'perm-bob',
      ])
      expect(jackResult.data.teamLaunchState).toBe('ready')
      expect(jackResult.data.members.jack?.launchState).toBe('confirmed_alive')
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
      expect(result.data.members.bob?.launchState).toBe('confirmed_alive')
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
    expect(result.data.teamLaunchState).toBe('permission_blocked')
    expect(result.data.members.alice?.launchState).toBe('permission_blocked')
    expect(result.data.members.alice?.pendingPermissionRequestIds).toEqual(['perm-1', 'perm-2'])
    expect(result.data.members.alice?.diagnostics).toEqual(['waiting for permission approval'])
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
    expect(result.data.members.alice?.launchState).toBe('permission_blocked')
    expect(result.data.members.alice?.evidence.map(entry => entry.kind)).toContain(
      'permission_blocked',
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

  test('keeps a reconciled lane pending until OpenCode emits an assistant bootstrap confirmation', async () => {
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

  test('emits runtime turn-settled spool from the production send-message command path', async () => {
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
      const files = await readdir(incomingDir)
      expect(files).toHaveLength(1)
      const event = JSON.parse(await readFile(path.join(incomingDir, files[0] ?? ''), 'utf8'))
      expect(event).toMatchObject({
        provider: 'opencode',
        source: 'agent-teams-orchestrator-opencode',
        eventName: 'runtime_turn_settled',
        hookEventName: 'Stop',
        teamName: 'team-a',
        memberName: 'bob',
        sessionId: 'session-bob',
        runtimePromptMessageId: 'msg_test_turn_settled',
        outcome: 'success',
      })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('keeps noReply OpenCode delivery out of turn-settled observer path', async () => {
    const promptCalls: Array<{ noReply?: boolean }> = []
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
      summary: buildReconcileSummary(),
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
    expect(promptCalls).toEqual([{ noReply: true }])
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

  test('recreates OpenCode session before sending when bootstrap MCP failed in stored session', async () => {
    const originalRecord = buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob-broken',
      lastCanonicalCursor: 'cursor-broken',
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

  test('recreates the OpenCode session once when app MCP cannot attach before prompt', async () => {
    const promptCalls: Array<{ sessionId: string; prePromptCursor: string | null }> = []
    const staleReasons: string[] = []
    const originalRecord = buildRecord({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      opencodeSessionId: 'session-bob-old',
      lastCanonicalCursor: 'cursor-old',
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
    openCodeSessionBridge.ensureSession = (async () => recreatedRecord) as typeof openCodeSessionBridge.ensureSession
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
    openCodeSessionStore.markStale = (async () => ({
      ...originalRecord,
      staleReason: 'app_mcp_unavailable',
    })) as typeof openCodeSessionStore.markStale
    openCodeSessionBridge.ensureSession = (async () => recreatedRecord) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.ensureSessionAppMcpReady = (async () => ({
      ok: false,
      status: 'attach_failed',
      connected: false,
      diagnostics: ['still not connected'],
    })) as typeof openCodeSessionBridge.ensureSessionAppMcpReady
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
    expect(promptCalls).toBe(0)
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
          })
          : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            pendingPermissionRequestIds: ['perm-2', 'perm-1'],
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
})
