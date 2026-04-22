import { afterEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'

import {
  __resetAppMcpToolProofCacheForTests,
  executeOpenCodeBridgeCommandEnvelope,
} from './OpenCodeBridgeCommandHandler.js'
import { openCodeExecutionProbe } from './OpenCodeExecutionProbe.js'
import { openCodeProvisioningProbe } from './OpenCodeProvisioningProbe.js'
import { openCodeSessionBridge } from './OpenCodeSessionBridge.js'
import { openCodeSessionStore } from './OpenCodeSessionStore.js'

import type {
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
  configProviders: null,
  providers: { connected: ['openrouter'] },
  providerAuth: null,
  agents: [],
  mcp: {},
  appMcp: null,
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

function mockRequiredMcpTools(): void {
  ;(Client.prototype.connect as unknown as (...args: unknown[]) => Promise<void>) = async () => {}
  ;(Client.prototype.listTools as unknown as (...args: unknown[]) => Promise<{ tools: Array<{ name: string }> }>) =
    async () => ({
      tools: [
        { name: 'runtime_bootstrap_checkin' },
        { name: 'runtime_deliver_message' },
        { name: 'runtime_task_event' },
        { name: 'runtime_heartbeat' },
      ],
    })
  ;(Client.prototype.close as unknown as () => Promise<void>) = async () => {}
}

const originalProbe = openCodeProvisioningProbe.probe
const originalProbeModel = openCodeExecutionProbe.probeModel
const originalEnsureSession = openCodeSessionBridge.ensureSession
const originalPromptAsync = openCodeSessionBridge.promptAsync
const originalReconcileSession = openCodeSessionBridge.reconcileSession
const originalAbort = openCodeSessionBridge.abort
const originalReleaseSession = openCodeSessionBridge.releaseSession
const originalAnswerPermission = openCodeSessionBridge.answerPermission
const originalProjectLogMessages = openCodeSessionBridge.projectLogMessages
const originalList = openCodeSessionStore.list
const originalGet = openCodeSessionStore.get
const originalClientConnect = Client.prototype.connect
const originalClientListTools = Client.prototype.listTools
const originalClientClose = Client.prototype.close

afterEach(() => {
  __resetAppMcpToolProofCacheForTests()
  openCodeProvisioningProbe.probe = originalProbe
  openCodeExecutionProbe.probeModel = originalProbeModel
  openCodeSessionBridge.ensureSession = originalEnsureSession
  openCodeSessionBridge.promptAsync = originalPromptAsync
  openCodeSessionBridge.reconcileSession = originalReconcileSession
  openCodeSessionBridge.abort = originalAbort
  openCodeSessionBridge.releaseSession = originalReleaseSession
  openCodeSessionBridge.answerPermission = originalAnswerPermission
  openCodeSessionBridge.projectLogMessages = originalProjectLogMessages
  openCodeSessionStore.list = originalList
  openCodeSessionStore.get = originalGet
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
          tools: [
            { name: 'runtime_bootstrap_checkin' },
            { name: 'runtime_deliver_message' },
            { name: 'runtime_task_event' },
            { name: 'runtime_heartbeat' },
          ],
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
      tools: [
        { name: 'runtime_bootstrap_checkin' },
        { name: 'runtime_deliver_message' },
        { name: 'runtime_task_event' },
        { name: 'runtime_heartbeat' },
      ],
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

  test('stops only the addressed lane', async () => {
    const abortedMembers: string[] = []
    const releasedMembers: string[] = []
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
  })

  test('rejects ambiguous permission answers without laneId when multiple lanes exist', async () => {
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

  test('marks the lane ready after answering permission when bootstrap confirmation is already present', async () => {
    openCodeProvisioningProbe.probe = async () => snapshot
    openCodeSessionStore.get = (async () =>
      buildRecord({
        laneId: 'secondary:opencode:alice',
        memberName: 'alice',
      })) as typeof openCodeSessionStore.get
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
