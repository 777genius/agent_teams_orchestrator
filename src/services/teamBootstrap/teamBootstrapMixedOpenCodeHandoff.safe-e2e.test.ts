import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  __resetAppMcpToolProofCacheForTests,
  executeOpenCodeBridgeCommandEnvelope,
} from '../opencode/OpenCodeBridgeCommandHandler.js'
import { openCodeProvisioningProbe } from '../opencode/OpenCodeProvisioningProbe.js'
import { openCodeSessionBridge } from '../opencode/OpenCodeSessionBridge.js'
import { openCodeSessionStore } from '../opencode/OpenCodeSessionStore.js'
import { PROVIDER_DEFAULT_MODEL_SELECTION } from './teamBootstrapModelSelection.js'

import type { TeamBootstrapRequest } from './teamBootstrapTypes.js'
import type {
  OpenCodeProvisioningSnapshot,
  OpenCodeSessionRecord,
  OpenCodeSessionReconcileSummary,
} from '../opencode/types.js'

type SpawnInput = Record<string, unknown>
type DuplicateReason = 'already_running' | 'bootstrap_pending'

const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalProbe = openCodeProvisioningProbe.probe
const originalEnsureSession = openCodeSessionBridge.ensureSession
const originalPromptAsync = openCodeSessionBridge.promptAsync
const originalReconcileSession = openCodeSessionBridge.reconcileSession
const originalAnswerPermission = openCodeSessionBridge.answerPermission
const originalAbort = openCodeSessionBridge.abort
const originalReleaseSession = openCodeSessionBridge.releaseSession
const originalStoreGet = openCodeSessionStore.get
const originalStoreList = openCodeSessionStore.list
const originalClientConnect = Client.prototype.connect
const originalClientListTools = Client.prototype.listTools
const originalClientClose = Client.prototype.close
const SAFE_E2E_TIMEOUT_MS = 15_000

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

describe('mixed Codex and OpenCode launch handoff safe e2e', () => {
  let tempConfigDir: string
  let registeredMemberNames: Set<string>
  let spawnInputs: SpawnInput[]
  let spawnFailures: Map<string, string>
  let duplicateSpawns: Map<string, DuplicateReason>
  let teamConfigExists: boolean
  let createTeamCalls: Array<Record<string, unknown>>
  let updateTeamCalls: string[]

  beforeEach(async () => {
    mock.restore()
    mock.clearAllMocks()
    __resetAppMcpToolProofCacheForTests()
    mockRequiredMcpTools()
    tempConfigDir = await mkdtemp(join(tmpdir(), 'mixed-opencode-handoff-'))
    process.env.CLAUDE_CONFIG_DIR = tempConfigDir
    registeredMemberNames = new Set()
    spawnInputs = []
    spawnFailures = new Map()
    duplicateSpawns = new Map()
    teamConfigExists = true
    createTeamCalls = []
    updateTeamCalls = []

    const teamHelpers = await import('src/utils/swarm/teamHelpers.js')
    const buildMockTeamFile = () => ({
      name: 'atlas-hq',
      leadAgentId: 'team-lead@atlas-hq',
      leadSessionId: 'lead-session',
      members: [
        { name: 'team-lead', agentId: 'team-lead@atlas-hq' },
        ...[...registeredMemberNames].map(name => ({
          name,
          agentId: `${name}@atlas-hq`,
        })),
      ],
    })
    mock.module('src/utils/swarm/teamHelpers.js', () => ({
      ...teamHelpers,
      readTeamFileAsync: async () =>
        teamConfigExists
          ? buildMockTeamFile()
          : null,
      updateTeamFileAsync: async (
        teamName: string,
        updater: (teamFile: ReturnType<typeof buildMockTeamFile>) => unknown,
      ) => {
        updateTeamCalls.push(teamName)
        updater(buildMockTeamFile())
      },
      unregisterTeamForSessionCleanup: () => {},
    }))

    mock.module('src/tools/shared/spawnMultiAgent.js', () => ({
      spawnTeammate: async (input: SpawnInput) => {
        spawnInputs.push(input)
        const name = String(input.name)
        const failure = spawnFailures.get(name)
        if (failure) {
          throw new Error(failure)
        }
        const duplicateReason = duplicateSpawns.get(name)
        if (duplicateReason) {
          return {
            data: {
              status: 'duplicate_skipped',
              reason: duplicateReason,
              agent_id: `${name}@atlas-hq`,
              teammate_id: `${name}@atlas-hq`,
              provider: input.provider,
              model: input.model,
              name,
              team_name: 'atlas-hq',
              spawned: false,
            },
          }
        }
        return {
          data: {
            agent_id: `${name}@atlas-hq`,
            teammate_id: `${name}@atlas-hq`,
            backend_type: input.provider === 'codex' ? 'codex-native' : 'pane',
            name,
            spawned: true,
          },
        }
      },
    }))

    mock.module('src/tools/TeamCreateTool/TeamCreateTool.js', () => ({
      TeamCreateTool: {
        call: async (input: Record<string, unknown>) => {
          createTeamCalls.push(input)
          teamConfigExists = true
          return { data: { team_name: 'atlas-hq' } }
        },
      },
    }))
  }, SAFE_E2E_TIMEOUT_MS)

  afterEach(async () => {
    mock.restore()
    mock.clearAllMocks()
    __resetAppMcpToolProofCacheForTests()
    openCodeProvisioningProbe.probe = originalProbe
    openCodeSessionBridge.ensureSession = originalEnsureSession
    openCodeSessionBridge.promptAsync = originalPromptAsync
    openCodeSessionBridge.reconcileSession = originalReconcileSession
    openCodeSessionBridge.answerPermission = originalAnswerPermission
    openCodeSessionBridge.abort = originalAbort
    openCodeSessionBridge.releaseSession = originalReleaseSession
    openCodeSessionStore.get = originalStoreGet
    openCodeSessionStore.list = originalStoreList
    Client.prototype.connect = originalClientConnect
    Client.prototype.listTools = originalClientListTools
    Client.prototype.close = originalClientClose
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
    }
    await rm(tempConfigDir, { recursive: true, force: true })
  }, SAFE_E2E_TIMEOUT_MS)

  test('launches primary Codex and Gemini teammates before OpenCode secondary lanes', async () => {
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: Array<{ memberName: string; text: string }> = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid: input.memberName === 'bob' ? 2102 : 2103,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async (record, input) => {
      promptInputs.push({
        memberName: record.memberName,
        text: input.text,
      })
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: `msg-${record.memberName}-ready`,
        latestAssistantText: `${record.memberName} ready`,
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-handoff',
        members: [
          {
            ...member('alice', 'codex', 'gpt-5.4-mini'),
            effort: 'medium',
          },
          {
            ...member('reviewer', 'gemini', 'gemini-2.5-flash'),
            effort: 'low',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-handoff',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )
    const jackResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-handoff',
        laneId: 'secondary:opencode:jack',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/ling-2.6-flash-free',
        members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([])
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'codex',
        model: 'gpt-5.4-mini',
        effort: 'medium',
      },
      {
        name: 'reviewer',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        effort: 'low',
      },
    ])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.registeredMembers).toEqual([
      'alice',
      'reviewer',
      'bob',
      'jack',
    ])
    expect(events.completedEvents).toEqual([
      {
        status: 'completed',
        expectedMembers: ['alice', 'reviewer'],
        registeredMembers: ['alice', 'reviewer', 'bob', 'jack'],
        failedMembers: [],
      },
    ])
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
    expect(promptInputs).toEqual([
      { memberName: 'bob', text: 'Bob OpenCode join' },
      { memberName: 'jack', text: 'Jack OpenCode join' },
    ])
    expect(Object.keys(bobResult.data.members)).toEqual(['bob'])
    expect(Object.keys(jackResult.data.members)).toEqual(['jack'])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2102)
    expect(jackResult.data.members.jack?.runtimePid).toBe(2103)
  }, SAFE_E2E_TIMEOUT_MS)

  test('launches Anthropic and Codex primary teammates before split OpenCode secondary lanes', async () => {
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: Array<{ memberName: string; text: string }> = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid: input.memberName === 'bob' ? 2112 : 2113,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async (record, input) => {
      promptInputs.push({
        memberName: record.memberName,
        text: input.text,
      })
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary:
        record.memberName === 'jack'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: null,
            latestAssistantText: null,
            latestAssistantPreview: null,
            messageCount: 0,
            durableState: 'blocked',
            pendingPermissionRequestIds: ['perm-jack-shell'],
            diagnostics: ['jack waiting for OpenCode permission'],
            messages: [],
          })
          : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: `msg-${record.memberName}-ready`,
            latestAssistantText: `${record.memberName} ready`,
          }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-anthropic-codex-opencode-handoff',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
          {
            ...member('reviewer', 'codex', 'gpt-5.4-mini'),
            effort: 'medium',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-anthropic-codex-opencode-handoff',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )
    const jackResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-anthropic-codex-opencode-handoff',
        laneId: 'secondary:opencode:jack',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/ling-2.6-flash-free',
        members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([])
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
      {
        name: 'reviewer',
        provider: 'codex',
        model: 'gpt-5.4-mini',
        effort: 'medium',
      },
    ])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.registeredMembers).toEqual([
      'alice',
      'reviewer',
      'bob',
      'jack',
    ])
    expect(events.completedEvents).toEqual([
      {
        status: 'completed',
        expectedMembers: ['alice', 'reviewer'],
        registeredMembers: ['alice', 'reviewer', 'bob', 'jack'],
        failedMembers: [],
      },
    ])
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
    expect(promptInputs).toEqual([
      { memberName: 'bob', text: 'Bob OpenCode join' },
      { memberName: 'jack', text: 'Jack OpenCode join' },
    ])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2112)
    expect(jackResult.data.members.jack?.runtimePid).toBe(2113)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])
  }, SAFE_E2E_TIMEOUT_MS)

  test('launches Anthropic primary teammate before split OpenCode secondary lanes', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: Array<{ memberName: string; text: string }> = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid: input.memberName === 'bob' ? 2116 : 2117,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async (record, input) => {
      promptInputs.push({
        memberName: record.memberName,
        text: input.text,
      })
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary:
        record.memberName === 'jack'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: null,
            latestAssistantText: null,
            latestAssistantPreview: null,
            messageCount: 0,
            durableState: 'blocked',
            pendingPermissionRequestIds: ['perm-jack-shell'],
            diagnostics: ['jack waiting for OpenCode permission'],
            messages: [],
          })
          : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: `msg-${record.memberName}-ready`,
            latestAssistantText: `${record.memberName} ready`,
          }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-anthropic-opencode-handoff',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-anthropic-opencode-handoff',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )
    const jackResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-anthropic-opencode-handoff',
        laneId: 'secondary:opencode:jack',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/ling-2.6-flash-free',
        members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([])
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
    ])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice'])
    expect(primaryResult.summary.registeredMembers).toEqual([
      'alice',
      'bob',
      'jack',
    ])
    expect(events.completedEvents).toEqual([
      {
        status: 'completed',
        expectedMembers: ['alice'],
        registeredMembers: ['alice', 'bob', 'jack'],
        failedMembers: [],
      },
    ])
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
    expect(promptInputs).toEqual([
      { memberName: 'bob', text: 'Bob OpenCode join' },
      { memberName: 'jack', text: 'Jack OpenCode join' },
    ])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2116)
    expect(jackResult.data.members.jack?.runtimePid).toBe(2117)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps Anthropic primary launch completed while split OpenCode secondary lanes are ready and launching', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: Array<{ memberName: string; text: string }> = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid: input.memberName === 'bob' ? 2118 : 2119,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async (record, input) => {
      promptInputs.push({
        memberName: record.memberName,
        text: input.text,
      })
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary:
        record.memberName === 'jack'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: null,
            latestAssistantText: null,
            latestAssistantPreview: null,
            messageCount: 0,
            durableState: 'idle',
            messages: [],
          })
          : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: `msg-${record.memberName}-ready`,
            latestAssistantText: `${record.memberName} ready`,
          }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-anthropic-opencode-handoff-launching',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [bobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-anthropic-opencode-handoff-launching',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-anthropic-opencode-handoff-launching',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([])
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
    ])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice'])
    expect(primaryResult.summary.registeredMembers).toEqual(['alice', 'bob', 'jack'])
    expect(events.completedEvents).toEqual([
      {
        status: 'completed',
        expectedMembers: ['alice'],
        registeredMembers: ['alice', 'bob', 'jack'],
        failedMembers: [],
      },
    ])
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
    expect(promptInputs).toEqual([
      { memberName: 'bob', text: 'Bob OpenCode join' },
      { memberName: 'jack', text: 'Jack OpenCode join' },
    ])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.teamLaunchState).toBe('launching')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.jack?.launchState).toBe('created')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2118)
    expect(jackResult.data.members.jack?.runtimePid).toBe(2119)
    expect(jackResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps Anthropic primary launch completed when OpenCode sibling lanes split across ready, launching, and permission-blocked', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'jack', 'tom'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: Array<{ memberName: string; text: string }> = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid:
          input.memberName === 'bob'
            ? 2120
            : input.memberName === 'jack'
              ? 2121
              : 2122,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async (record, input) => {
      promptInputs.push({
        memberName: record.memberName,
        text: input.text,
      })
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary:
        record.memberName === 'jack'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: null,
            latestAssistantText: null,
            latestAssistantPreview: null,
            messageCount: 0,
            durableState: 'idle',
            messages: [],
          })
          : record.memberName === 'tom'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-tom-shell'],
              diagnostics: ['tom waiting for OpenCode permission'],
              messages: [],
            })
            : buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: `msg-${record.memberName}-ready`,
              latestAssistantText: `${record.memberName} ready`,
            }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-anthropic-opencode-handoff-three-way-split',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [bobResult, jackResult, tomResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-anthropic-opencode-handoff-three-way-split',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-anthropic-opencode-handoff-three-way-split',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-anthropic-opencode-handoff-three-way-split',
          laneId: 'secondary:opencode:tom',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'nemotron-3-super-free',
          members: [{ name: 'tom', role: 'Analyst', prompt: 'Tom OpenCode join' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(tomResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok || !tomResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([])
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
    ])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(spawnInputs.map(input => input.name)).not.toContain('tom')
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice'])
    expect(primaryResult.summary.registeredMembers).toEqual(['alice', 'bob', 'jack', 'tom'])
    expect(events.completedEvents).toEqual([
      {
        status: 'completed',
        expectedMembers: ['alice'],
        registeredMembers: ['alice', 'bob', 'jack', 'tom'],
        failedMembers: [],
      },
    ])
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
      {
        laneId: 'secondary:opencode:tom',
        memberName: 'tom',
        selectedModel: 'openrouter/nemotron-3-super-free',
      },
    ])
    expect(promptInputs).toEqual([
      { memberName: 'bob', text: 'Bob OpenCode join' },
      { memberName: 'jack', text: 'Jack OpenCode join' },
      { memberName: 'tom', text: 'Tom OpenCode join' },
    ])

    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2120)
    expect(bobResult.data.members.jack).toBeUndefined()
    expect(bobResult.data.members.tom).toBeUndefined()

    expect(jackResult.data.teamLaunchState).toBe('launching')
    expect(jackResult.data.members.jack?.launchState).toBe('created')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2121)
    expect(jackResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )
    expect(jackResult.data.members.bob).toBeUndefined()
    expect(jackResult.data.members.tom).toBeUndefined()

    expect(tomResult.data.teamLaunchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.launchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.runtimePid).toBe(2122)
    expect(tomResult.data.members.tom?.pendingPermissionRequestIds).toEqual([
      'perm-tom-shell',
    ])
    expect(tomResult.data.members.bob).toBeUndefined()
    expect(tomResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('promotes a launching OpenCode sibling lane to ready after Anthropic-only launch without disturbing ready and permission-blocked siblings', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'jack', 'tom'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid:
          input.memberName === 'bob'
            ? 2126
            : input.memberName === 'jack'
              ? 2127
              : 2128,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'bob' && !bobAssistantReady
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'idle',
              messages: [],
            })
            : record.memberName === 'tom'
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: null,
                latestAssistantText: null,
                latestAssistantPreview: null,
                messageCount: 0,
                durableState: 'blocked',
                pendingPermissionRequestIds: ['perm-tom-shell'],
                diagnostics: ['tom waiting for OpenCode permission'],
                messages: [],
              })
              : buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: `msg-${record.memberName}-ready`,
                latestAssistantText: `${record.memberName} ready`,
              }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-anthropic-opencode-promote-launching-three-way-split',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [initialBobResult, jackResult, tomResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-anthropic-opencode-promote-launching-three-way-split',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-anthropic-opencode-promote-launching-three-way-split',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-anthropic-opencode-promote-launching-three-way-split',
          laneId: 'secondary:opencode:tom',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'nemotron-3-super-free',
          members: [{ name: 'tom', role: 'Analyst', prompt: 'Tom OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-anthropic-opencode-promote-launching-three-way-split',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(tomResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (
      !primaryResult.ok
      || !initialBobResult.ok
      || !jackResult.ok
      || !tomResult.ok
      || !promotedBobResult.ok
    ) {
      return
    }
    expect(createTeamCalls).toEqual([])
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
    ])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(spawnInputs.map(input => input.name)).not.toContain('tom')
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice'])
    expect(primaryResult.summary.registeredMembers).toEqual(['alice', 'bob', 'jack', 'tom'])
    expect(events.completedEvents).toEqual([
      {
        status: 'completed',
        expectedMembers: ['alice'],
        registeredMembers: ['alice', 'bob', 'jack', 'tom'],
        failedMembers: [],
      },
    ])
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
      {
        laneId: 'secondary:opencode:tom',
        memberName: 'tom',
        selectedModel: 'openrouter/nemotron-3-super-free',
      },
    ])
    expect(promptInputs.sort()).toEqual(['bob', 'jack', 'tom'])
    expect(reconciledMembers.filter(memberName => memberName === 'bob')).toHaveLength(2)
    expect(reconciledMembers.filter(memberName => memberName === 'jack')).toHaveLength(1)
    expect(reconciledMembers.filter(memberName => memberName === 'tom')).toHaveLength(1)

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2126)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.members.jack?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2127)

    expect(tomResult.data.teamLaunchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.launchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.runtimePid).toBe(2128)
    expect(tomResult.data.members.tom?.pendingPermissionRequestIds).toEqual([
      'perm-tom-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2126)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
    expect(promotedBobResult.data.members.tom).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps Anthropic and Codex primary launch completed while split OpenCode secondary lanes are ready and launching', async () => {
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: Array<{ memberName: string; text: string }> = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid: input.memberName === 'bob' ? 2114 : 2115,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async (record, input) => {
      promptInputs.push({
        memberName: record.memberName,
        text: input.text,
      })
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary:
        record.memberName === 'jack'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: null,
            latestAssistantText: null,
            latestAssistantPreview: null,
            messageCount: 0,
            durableState: 'idle',
            messages: [],
          })
          : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: `msg-${record.memberName}-ready`,
            latestAssistantText: `${record.memberName} ready`,
          }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-anthropic-codex-opencode-split-launching',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
          {
            ...member('reviewer', 'codex', 'gpt-5.4-mini'),
            effort: 'medium',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-anthropic-codex-opencode-split-launching',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )
    const jackResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-anthropic-codex-opencode-split-launching',
        laneId: 'secondary:opencode:jack',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/ling-2.6-flash-free',
        members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([])
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
      {
        name: 'reviewer',
        provider: 'codex',
        model: 'gpt-5.4-mini',
        effort: 'medium',
      },
    ])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.registeredMembers).toEqual([
      'alice',
      'reviewer',
      'bob',
      'jack',
    ])
    expect(events.completedEvents).toEqual([
      {
        status: 'completed',
        expectedMembers: ['alice', 'reviewer'],
        registeredMembers: ['alice', 'reviewer', 'bob', 'jack'],
        failedMembers: [],
      },
    ])
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
    expect(promptInputs).toEqual([
      { memberName: 'bob', text: 'Bob OpenCode join' },
      { memberName: 'jack', text: 'Jack OpenCode join' },
    ])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2114)
    expect(jackResult.data.teamLaunchState).toBe('launching')
    expect(jackResult.data.members.jack?.launchState).toBe('created')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2115)
    expect(jackResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )
  }, SAFE_E2E_TIMEOUT_MS)

  test('promotes a launching OpenCode sibling lane to ready after Anthropic and Codex launch without disturbing ready and permission-blocked siblings', async () => {
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack', 'tom'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid:
          input.memberName === 'bob'
            ? 2130
            : input.memberName === 'jack'
              ? 2131
              : 2132,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'bob' && !bobAssistantReady
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'idle',
              messages: [],
            })
            : record.memberName === 'tom'
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: null,
                latestAssistantText: null,
                latestAssistantPreview: null,
                messageCount: 0,
                durableState: 'blocked',
                pendingPermissionRequestIds: ['perm-tom-shell'],
                diagnostics: ['tom waiting for OpenCode permission'],
                messages: [],
              })
              : buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: `msg-${record.memberName}-ready`,
                latestAssistantText: `${record.memberName} ready`,
              }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-anthropic-codex-opencode-promote-launching-three-way-split',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
          {
            ...member('reviewer', 'codex', 'gpt-5.4-mini'),
            effort: 'medium',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [initialBobResult, jackResult, tomResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-anthropic-codex-opencode-promote-launching-three-way-split',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-anthropic-codex-opencode-promote-launching-three-way-split',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-anthropic-codex-opencode-promote-launching-three-way-split',
          laneId: 'secondary:opencode:tom',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'nemotron-3-super-free',
          members: [{ name: 'tom', role: 'Analyst', prompt: 'Tom OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-anthropic-codex-opencode-promote-launching-three-way-split',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(tomResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (
      !primaryResult.ok
      || !initialBobResult.ok
      || !jackResult.ok
      || !tomResult.ok
      || !promotedBobResult.ok
    ) {
      return
    }
    expect(createTeamCalls).toEqual([])
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
      {
        name: 'reviewer',
        provider: 'codex',
        model: 'gpt-5.4-mini',
        effort: 'medium',
      },
    ])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.registeredMembers).toEqual([
      'alice',
      'reviewer',
      'bob',
      'jack',
      'tom',
    ])
    expect(events.completedEvents).toEqual([
      {
        status: 'completed',
        expectedMembers: ['alice', 'reviewer'],
        registeredMembers: ['alice', 'reviewer', 'bob', 'jack', 'tom'],
        failedMembers: [],
      },
    ])
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
      {
        laneId: 'secondary:opencode:tom',
        memberName: 'tom',
        selectedModel: 'openrouter/nemotron-3-super-free',
      },
    ])
    expect(promptInputs.sort()).toEqual(['bob', 'jack', 'tom'])
    expect(reconciledMembers.filter(memberName => memberName === 'bob')).toHaveLength(2)
    expect(reconciledMembers.filter(memberName => memberName === 'jack')).toHaveLength(1)
    expect(reconciledMembers.filter(memberName => memberName === 'tom')).toHaveLength(1)

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2130)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.members.jack?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2131)

    expect(tomResult.data.teamLaunchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.launchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.runtimePid).toBe(2132)
    expect(tomResult.data.members.tom?.pendingPermissionRequestIds).toEqual([
      'perm-tom-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2130)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
    expect(promotedBobResult.data.members.tom).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps Anthropic and Gemini primary launch completed while split OpenCode secondary lanes are ready and launching', async () => {
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: Array<{ memberName: string; text: string }> = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid: input.memberName === 'bob' ? 2118 : 2119,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async (record, input) => {
      promptInputs.push({
        memberName: record.memberName,
        text: input.text,
      })
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary:
        record.memberName === 'jack'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: null,
            latestAssistantText: null,
            latestAssistantPreview: null,
            messageCount: 0,
            durableState: 'idle',
            messages: [],
          })
          : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: `msg-${record.memberName}-ready`,
            latestAssistantText: `${record.memberName} ready`,
          }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-anthropic-gemini-opencode-split-launching',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
          {
            ...member('reviewer', 'gemini', 'gemini-2.5-flash'),
            effort: 'medium',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-anthropic-gemini-opencode-split-launching',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )
    const jackResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-anthropic-gemini-opencode-split-launching',
        laneId: 'secondary:opencode:jack',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/ling-2.6-flash-free',
        members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([])
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
      {
        name: 'reviewer',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        effort: 'medium',
      },
    ])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.registeredMembers).toEqual([
      'alice',
      'reviewer',
      'bob',
      'jack',
    ])
    expect(events.completedEvents).toEqual([
      {
        status: 'completed',
        expectedMembers: ['alice', 'reviewer'],
        registeredMembers: ['alice', 'reviewer', 'bob', 'jack'],
        failedMembers: [],
      },
    ])
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
    expect(promptInputs).toEqual([
      { memberName: 'bob', text: 'Bob OpenCode join' },
      { memberName: 'jack', text: 'Jack OpenCode join' },
    ])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2118)
    expect(jackResult.data.teamLaunchState).toBe('launching')
    expect(jackResult.data.members.jack?.launchState).toBe('created')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2119)
    expect(jackResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )
  }, SAFE_E2E_TIMEOUT_MS)

  test('promotes a launching OpenCode sibling lane to ready after Anthropic and Gemini launch without disturbing ready and permission-blocked siblings', async () => {
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack', 'tom'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid:
          input.memberName === 'bob'
            ? 2136
            : input.memberName === 'jack'
              ? 2137
              : 2138,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'bob' && !bobAssistantReady
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'idle',
              messages: [],
            })
            : record.memberName === 'tom'
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: null,
                latestAssistantText: null,
                latestAssistantPreview: null,
                messageCount: 0,
                durableState: 'blocked',
                pendingPermissionRequestIds: ['perm-tom-shell'],
                diagnostics: ['tom waiting for OpenCode permission'],
                messages: [],
              })
              : buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: `msg-${record.memberName}-ready`,
                latestAssistantText: `${record.memberName} ready`,
              }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-anthropic-gemini-opencode-promote-launching-three-way-split',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
          {
            ...member('reviewer', 'gemini', 'gemini-2.5-flash'),
            effort: 'medium',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [initialBobResult, jackResult, tomResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-anthropic-gemini-opencode-promote-launching-three-way-split',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-anthropic-gemini-opencode-promote-launching-three-way-split',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-anthropic-gemini-opencode-promote-launching-three-way-split',
          laneId: 'secondary:opencode:tom',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'nemotron-3-super-free',
          members: [{ name: 'tom', role: 'Analyst', prompt: 'Tom OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-anthropic-gemini-opencode-promote-launching-three-way-split',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(tomResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (
      !primaryResult.ok
      || !initialBobResult.ok
      || !jackResult.ok
      || !tomResult.ok
      || !promotedBobResult.ok
    ) {
      return
    }
    expect(createTeamCalls).toEqual([])
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
      {
        name: 'reviewer',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        effort: 'medium',
      },
    ])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.registeredMembers).toEqual([
      'alice',
      'reviewer',
      'bob',
      'jack',
      'tom',
    ])
    expect(events.completedEvents).toEqual([
      {
        status: 'completed',
        expectedMembers: ['alice', 'reviewer'],
        registeredMembers: ['alice', 'reviewer', 'bob', 'jack', 'tom'],
        failedMembers: [],
      },
    ])
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
      {
        laneId: 'secondary:opencode:tom',
        memberName: 'tom',
        selectedModel: 'openrouter/nemotron-3-super-free',
      },
    ])
    expect(promptInputs.sort()).toEqual(['bob', 'jack', 'tom'])
    expect(reconciledMembers.filter(memberName => memberName === 'bob')).toHaveLength(2)
    expect(reconciledMembers.filter(memberName => memberName === 'jack')).toHaveLength(1)
    expect(reconciledMembers.filter(memberName => memberName === 'tom')).toHaveLength(1)

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2136)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.members.jack?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2137)

    expect(tomResult.data.teamLaunchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.launchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.runtimePid).toBe(2138)
    expect(tomResult.data.members.tom?.pendingPermissionRequestIds).toEqual([
      'perm-tom-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2136)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
    expect(promotedBobResult.data.members.tom).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('launches Anthropic and Gemini primary teammates before split OpenCode secondary lanes', async () => {
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: Array<{ memberName: string; text: string }> = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid: input.memberName === 'bob' ? 2124 : 2125,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async (record, input) => {
      promptInputs.push({
        memberName: record.memberName,
        text: input.text,
      })
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary:
        record.memberName === 'jack'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: null,
            latestAssistantText: null,
            latestAssistantPreview: null,
            messageCount: 0,
            durableState: 'blocked',
            pendingPermissionRequestIds: ['perm-jack-shell'],
            diagnostics: ['jack waiting for OpenCode permission'],
            messages: [],
          })
          : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: `msg-${record.memberName}-ready`,
            latestAssistantText: `${record.memberName} ready`,
          }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-anthropic-gemini-opencode-handoff',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
          {
            ...member('reviewer', 'gemini', 'gemini-2.5-flash'),
            effort: 'medium',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-anthropic-gemini-opencode-handoff',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )
    const jackResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-anthropic-gemini-opencode-handoff',
        laneId: 'secondary:opencode:jack',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/ling-2.6-flash-free',
        members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([])
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
      {
        name: 'reviewer',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        effort: 'medium',
      },
    ])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.registeredMembers).toEqual([
      'alice',
      'reviewer',
      'bob',
      'jack',
    ])
    expect(events.completedEvents).toEqual([
      {
        status: 'completed',
        expectedMembers: ['alice', 'reviewer'],
        registeredMembers: ['alice', 'reviewer', 'bob', 'jack'],
        failedMembers: [],
      },
    ])
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
    expect(promptInputs).toEqual([
      { memberName: 'bob', text: 'Bob OpenCode join' },
      { memberName: 'jack', text: 'Jack OpenCode join' },
    ])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2124)
    expect(jackResult.data.members.jack?.runtimePid).toBe(2125)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])
  }, SAFE_E2E_TIMEOUT_MS)

  test('promotes a launching OpenCode sibling lane to ready when Anthropic primary bootstrap is partial success without disturbing a permission-blocked sibling', async () => {
    registeredMemberNames = new Set(['reviewer', 'bob', 'jack'])
    spawnFailures.set('alice', 'Anthropic pane exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: input.memberName === 'bob' ? 2116 : 2117,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-jack-shell'],
              diagnostics: ['jack waiting for OpenCode permission'],
              messages: [],
            })
            : bobAssistantReady
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: 'msg-bob-ready-after-anthropic-partial',
                latestAssistantText: 'bob ready after anthropic partial',
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
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-anthropic-partial-promote-launching-opencode',
        continueOnPartialFailure: true,
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
          {
            ...member('reviewer', 'codex', 'gpt-5.4-mini'),
            effort: 'medium',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [initialBobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-anthropic-partial-promote-launching-opencode',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-anthropic-partial-promote-launching-opencode',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-anthropic-partial-promote-launching-opencode',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (!primaryResult.ok || !initialBobResult.ok || !jackResult.ok || !promotedBobResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.terminalStatus).toBe('partial_success')
    expect(primaryResult.summary.failedMembers).toEqual([
      { name: 'alice', reason: 'Anthropic pane exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'failed',
      reason: 'Anthropic pane exited before bootstrap',
    })
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'reviewer',
      outcome: 'spawned',
      agentId: 'reviewer@atlas-hq',
      teammateId: 'reviewer@atlas-hq',
      backendType: 'codex-native',
    })
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(reconciledMembers).toEqual(['bob', 'jack', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2116)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2117)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2116)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('promotes a launching OpenCode sibling lane to ready when Anthropic-only primary bootstrap is partial success without disturbing a permission-blocked sibling', async () => {
    registeredMemberNames = new Set(['bob', 'jack'])
    spawnFailures.set('alice', 'Anthropic pane exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: input.memberName === 'bob' ? 2118 : 2119,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-jack-shell'],
              diagnostics: ['jack waiting for OpenCode permission'],
              messages: [],
            })
            : bobAssistantReady
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: 'msg-bob-ready-after-anthropic-only-partial',
                latestAssistantText: 'bob ready after anthropic-only partial',
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
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-anthropic-only-partial-promote-launching-opencode',
        continueOnPartialFailure: true,
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [initialBobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-anthropic-only-partial-promote-launching-opencode',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-anthropic-only-partial-promote-launching-opencode',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-anthropic-only-partial-promote-launching-opencode',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (!primaryResult.ok || !initialBobResult.ok || !jackResult.ok || !promotedBobResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(primaryResult.summary.terminalStatus).toBe('partial_success')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice'])
    expect(primaryResult.summary.failedMembers).toEqual([
      { name: 'alice', reason: 'Anthropic pane exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'failed',
      reason: 'Anthropic pane exited before bootstrap',
    })
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(reconciledMembers).toEqual(['bob', 'jack', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2118)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2119)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2118)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('promotes a launching OpenCode sibling lane to ready when strict Anthropic primary bootstrap failed without disturbing a permission-blocked sibling', async () => {
    registeredMemberNames = new Set(['reviewer', 'bob', 'jack'])
    spawnFailures.set('alice', 'Anthropic pane exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: input.memberName === 'bob' ? 2120 : 2121,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-jack-shell'],
              diagnostics: ['jack waiting for OpenCode permission'],
              messages: [],
            })
            : bobAssistantReady
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: 'msg-bob-ready-after-anthropic-failed',
                latestAssistantText: 'bob ready after anthropic failed',
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
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-anthropic-strict-failed-opencode-promote-launching',
        continueOnPartialFailure: false,
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
          {
            ...member('reviewer', 'codex', 'gpt-5.4-mini'),
            effort: 'medium',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [initialBobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-anthropic-strict-failed-opencode-promote-launching',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-anthropic-strict-failed-opencode-promote-launching',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-anthropic-strict-failed-opencode-promote-launching',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(false)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (primaryResult.ok || !initialBobResult.ok || !jackResult.ok || !promotedBobResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary?.terminalStatus).toBe('failed')
    expect(primaryResult.summary?.failedMembers).toEqual([
      { name: 'alice', reason: 'Anthropic pane exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'failed',
      reason: 'Anthropic pane exited before bootstrap',
    })
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'reviewer',
      outcome: 'spawned',
      agentId: 'reviewer@atlas-hq',
      teammateId: 'reviewer@atlas-hq',
      backendType: 'codex-native',
    })
    expect(events.items).toContainEqual({
      type: 'failed',
      reason: primaryResult.error,
    })
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(reconciledMembers).toEqual(['bob', 'jack', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2120)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2121)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2120)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('promotes a launching OpenCode sibling lane to ready when strict Anthropic-only primary bootstrap failed without disturbing a permission-blocked sibling', async () => {
    registeredMemberNames = new Set(['bob', 'jack'])
    spawnFailures.set('alice', 'Anthropic pane exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: input.memberName === 'bob' ? 2122 : 2123,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-jack-shell'],
              diagnostics: ['jack waiting for OpenCode permission'],
              messages: [],
            })
            : bobAssistantReady
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: 'msg-bob-ready-after-anthropic-only-failed',
                latestAssistantText: 'bob ready after anthropic-only failed',
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
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-anthropic-only-strict-failed-opencode-promote-launching',
        continueOnPartialFailure: false,
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [initialBobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-anthropic-only-strict-failed-opencode-promote-launching',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-anthropic-only-strict-failed-opencode-promote-launching',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-anthropic-only-strict-failed-opencode-promote-launching',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(false)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (primaryResult.ok || !initialBobResult.ok || !jackResult.ok || !promotedBobResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(primaryResult.summary?.terminalStatus).toBe('failed')
    expect(primaryResult.summary?.expectedMembers).toEqual(['alice'])
    expect(primaryResult.summary?.failedMembers).toEqual([
      { name: 'alice', reason: 'Anthropic pane exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'failed',
      reason: 'Anthropic pane exited before bootstrap',
    })
    expect(events.items).toContainEqual({
      type: 'failed',
      reason: primaryResult.error,
    })
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(reconciledMembers).toEqual(['bob', 'jack', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2122)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2123)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2122)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('promotes a launching OpenCode sibling lane to ready when strict Gemini primary bootstrap failed while an Anthropic sibling succeeds without disturbing a permission-blocked sibling', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'jack'])
    spawnFailures.set('reviewer', 'Gemini pane exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: input.memberName === 'bob' ? 2122 : 2123,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-jack-shell'],
              diagnostics: ['jack waiting for OpenCode permission'],
              messages: [],
            })
            : bobAssistantReady
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: 'msg-bob-ready-after-anthropic-gemini-failed',
                latestAssistantText: 'bob ready after anthropic gemini failed',
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
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-anthropic-gemini-strict-failed-opencode-promote-launching',
        continueOnPartialFailure: false,
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
          {
            ...member('reviewer', 'gemini', 'gemini-2.5-flash'),
            effort: 'medium',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [initialBobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-anthropic-gemini-strict-failed-opencode-promote-launching',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-anthropic-gemini-strict-failed-opencode-promote-launching',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-anthropic-gemini-strict-failed-opencode-promote-launching',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(false)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (primaryResult.ok || !initialBobResult.ok || !jackResult.ok || !promotedBobResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([])
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary?.terminalStatus).toBe('failed')
    expect(primaryResult.summary?.expectedMembers).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary?.registeredMembers).toEqual(['alice', 'bob', 'jack'])
    expect(primaryResult.summary?.failedMembers).toEqual([
      { name: 'reviewer', reason: 'Gemini pane exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'spawned',
      agentId: 'alice@atlas-hq',
      teammateId: 'alice@atlas-hq',
      backendType: 'pane',
    })
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'reviewer',
      outcome: 'failed',
      reason: 'Gemini pane exited before bootstrap',
    })
    expect(events.items).toContainEqual({
      type: 'failed',
      reason: primaryResult.error,
    })
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(reconciledMembers).toEqual(['bob', 'jack', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2122)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2123)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2122)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('launches provider-default Codex primary before explicit OpenCode secondary without inventing a model', async () => {
    registeredMemberNames = new Set(['alice', 'bob'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid: 3402,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: `msg-${record.memberName}-ready`,
        latestAssistantText: `${record.memberName} ready`,
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-codex-default-opencode-explicit',
        members: [
          {
            originalName: 'alice',
            displayName: 'alice',
            normalizedName: 'alice',
            prompt: 'Alice Codex provider default bootstrap',
            provider: 'codex',
            model: PROVIDER_DEFAULT_MODEL_SELECTION,
            effort: 'medium',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-codex-default-opencode-explicit',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok) {
      return
    }
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'codex',
        effort: 'medium',
      },
    ])
    expect(spawnInputs[0]).not.toHaveProperty('model')
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(ensureInputs).toEqual([
      {
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        selectedModel: 'openrouter/minimax-m2.5-free',
      },
    ])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(3402)
  }, SAFE_E2E_TIMEOUT_MS)

  test('launches OpenCode secondary model ids with nested slashes after Codex primary bootstrap', async () => {
    registeredMemberNames = new Set(['alice', 'bob'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid: 3502,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: `msg-${record.memberName}-ready`,
        latestAssistantText: `${record.memberName} ready`,
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-codex-opencode-nested-slash',
        members: [
          {
            ...member('alice', 'codex', 'gpt-5.4-mini'),
            effort: 'medium',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-codex-opencode-nested-slash',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/moonshotai/kimi-k2',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok) {
      return
    }
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'codex',
        model: 'gpt-5.4-mini',
        effort: 'medium',
      },
    ])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(events.completedEvents).toEqual([
      {
        status: 'completed',
        expectedMembers: ['alice'],
        registeredMembers: ['alice', 'bob'],
        failedMembers: [],
      },
    ])
    expect(ensureInputs).toEqual([
      {
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        selectedModel: 'openrouter/moonshotai/kimi-k2',
      },
    ])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(3502)
  }, SAFE_E2E_TIMEOUT_MS)

  test('launches raw OpenCode secondary model ids with slashes after Codex primary bootstrap', async () => {
    registeredMemberNames = new Set(['alice', 'bob'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid: 3503,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: `msg-${record.memberName}-ready`,
        latestAssistantText: `${record.memberName} ready`,
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-codex-opencode-raw-slash',
        members: [
          {
            ...member('alice', 'codex', 'gpt-5.4-mini'),
            effort: 'medium',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-codex-opencode-raw-slash',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'moonshotai/kimi-k2',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok) {
      return
    }
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'codex',
        model: 'gpt-5.4-mini',
        effort: 'medium',
      },
    ])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(events.completedEvents).toEqual([
      {
        status: 'completed',
        expectedMembers: ['alice'],
        registeredMembers: ['alice', 'bob'],
        failedMembers: [],
      },
    ])
    expect(ensureInputs).toEqual([
      {
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        selectedModel: 'openrouter/moonshotai/kimi-k2',
      },
    ])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(3503)
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new mixed team before launching Codex primary and OpenCode secondary lanes', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['alice', 'bob'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid: 2402,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: `msg-${record.memberName}-ready`,
        latestAssistantText: `${record.memberName} ready`,
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-handoff',
        mode: 'create',
        description: 'new mixed team from safe e2e',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-create-handoff',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new mixed team from safe e2e',
      },
    ])
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'codex',
        model: 'gpt-5.4-mini',
      },
    ])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(primaryResult.summary.createdTeam).toBe(true)
    expect(primaryResult.summary.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice'])
    expect(primaryResult.summary.registeredMembers).toEqual(['alice', 'bob'])
    expect(ensureInputs).toEqual([
      {
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        selectedModel: 'openrouter/minimax-m2.5-free',
      },
    ])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2402)
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new mixed team and promotes a launching OpenCode sibling lane to ready when Codex primary bootstrap is partial success without disturbing a permission-blocked sibling', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['reviewer', 'bob', 'jack'])
    spawnFailures.set('alice', 'Codex native process exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: input.memberName === 'bob' ? 2422 : 2423,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-jack-shell'],
              diagnostics: ['jack waiting for OpenCode permission'],
              messages: [],
            })
            : bobAssistantReady
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: 'msg-bob-ready-after-create-codex-partial',
                latestAssistantText: 'bob ready after create codex partial',
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
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-codex-partial-promote-launching-opencode',
        mode: 'create',
        description: 'new mixed team with partial Codex failure and delayed OpenCode recovery from safe e2e',
        continueOnPartialFailure: true,
        members: [
          member('alice', 'codex', 'gpt-5.4-mini'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const [initialBobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-codex-partial-promote-launching-opencode',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-codex-partial-promote-launching-opencode',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-create-codex-partial-promote-launching-opencode',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (!primaryResult.ok || !initialBobResult.ok || !jackResult.ok || !promotedBobResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new mixed team with partial Codex failure and delayed OpenCode recovery from safe e2e',
      },
    ])
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary.createdTeam).toBe(true)
    expect(primaryResult.summary.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary.terminalStatus).toBe('partial_success')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.registeredMembers).toEqual(['reviewer', 'bob', 'jack'])
    expect(primaryResult.summary.failedMembers).toEqual([
      { name: 'alice', reason: 'Codex native process exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'failed',
      reason: 'Codex native process exited before bootstrap',
    })
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'reviewer',
      outcome: 'spawned',
      agentId: 'reviewer@atlas-hq',
      teammateId: 'reviewer@atlas-hq',
      backendType: 'pane',
    })
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(reconciledMembers).toEqual(['bob', 'jack', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2422)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2423)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2422)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new mixed team and keeps OpenCode secondary ready when Gemini primary partially fails', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['alice', 'bob'])
    spawnFailures.set('reviewer', 'Gemini pane exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid: 2403,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: `msg-${record.memberName}-ready`,
        latestAssistantText: `${record.memberName} ready`,
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-gemini-partial-opencode-ready',
        mode: 'create',
        description: 'new mixed team with partial primary failure from safe e2e',
        continueOnPartialFailure: true,
        members: [
          member('alice', 'codex', 'gpt-5.4-mini'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-create-gemini-partial-opencode-ready',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new mixed team with partial primary failure from safe e2e',
      },
    ])
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(primaryResult.summary.createdTeam).toBe(true)
    expect(primaryResult.summary.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary.terminalStatus).toBe('partial_success')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.registeredMembers).toEqual(['alice', 'bob'])
    expect(primaryResult.summary.failedMembers).toEqual([
      { name: 'reviewer', reason: 'Gemini pane exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'spawned',
      agentId: 'alice@atlas-hq',
      teammateId: 'alice@atlas-hq',
      backendType: 'codex-native',
    })
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'reviewer',
      outcome: 'failed',
      reason: 'Gemini pane exited before bootstrap',
    })
    expect(ensureInputs).toEqual([
      {
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        selectedModel: 'openrouter/minimax-m2.5-free',
      },
    ])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2403)
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new mixed team and keeps split OpenCode secondary lanes isolated when Gemini primary partially fails', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['alice', 'bob', 'jack'])
    spawnFailures.set('reviewer', 'Gemini pane exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid: input.memberName === 'bob' ? 2404 : 2405,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary:
        record.memberName === 'jack'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: null,
            latestAssistantText: null,
            latestAssistantPreview: null,
            messageCount: 0,
            durableState: 'blocked',
            pendingPermissionRequestIds: ['perm-jack-shell'],
            diagnostics: ['jack waiting for OpenCode permission'],
            messages: [],
          })
          : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: `msg-${record.memberName}-ready`,
            latestAssistantText: `${record.memberName} ready`,
          }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-gemini-partial-split-opencode',
        mode: 'create',
        description: 'new mixed team with split OpenCode lanes from safe e2e',
        continueOnPartialFailure: true,
        members: [
          member('alice', 'codex', 'gpt-5.4-mini'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const [bobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-gemini-partial-split-opencode',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-gemini-partial-split-opencode',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new mixed team with split OpenCode lanes from safe e2e',
      },
    ])
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary.createdTeam).toBe(true)
    expect(primaryResult.summary.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary.terminalStatus).toBe('partial_success')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.registeredMembers).toEqual(['alice', 'bob', 'jack'])
    expect(primaryResult.summary.failedMembers).toEqual([
      { name: 'reviewer', reason: 'Gemini pane exited before bootstrap' },
    ])
    expect(ensureInputs).toHaveLength(2)
    expect(ensureInputs).toContainEqual({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      selectedModel: 'openrouter/minimax-m2.5-free',
    })
    expect(ensureInputs).toContainEqual({
      laneId: 'secondary:opencode:jack',
      memberName: 'jack',
      selectedModel: 'openrouter/ling-2.6-flash-free',
    })
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2404)
    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2405)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new mixed team and promotes a launching OpenCode sibling lane to ready when Gemini primary bootstrap is partial success without disturbing a permission-blocked sibling', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['alice', 'bob', 'jack'])
    spawnFailures.set('reviewer', 'Gemini pane exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: input.memberName === 'bob' ? 2408 : 2409,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-jack-shell'],
              diagnostics: ['jack waiting for OpenCode permission'],
              messages: [],
            })
            : bobAssistantReady
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: 'msg-bob-ready-after-create-gemini-partial',
                latestAssistantText: 'bob ready after create gemini partial',
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
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-gemini-partial-promote-launching-opencode',
        mode: 'create',
        description: 'new mixed team with partial Gemini failure and delayed OpenCode recovery from safe e2e',
        continueOnPartialFailure: true,
        members: [
          member('alice', 'codex', 'gpt-5.4-mini'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const [initialBobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-gemini-partial-promote-launching-opencode',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-gemini-partial-promote-launching-opencode',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-create-gemini-partial-promote-launching-opencode',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (!primaryResult.ok || !initialBobResult.ok || !jackResult.ok || !promotedBobResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new mixed team with partial Gemini failure and delayed OpenCode recovery from safe e2e',
      },
    ])
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary.createdTeam).toBe(true)
    expect(primaryResult.summary.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary.terminalStatus).toBe('partial_success')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.registeredMembers).toEqual(['alice', 'bob', 'jack'])
    expect(primaryResult.summary.failedMembers).toEqual([
      { name: 'reviewer', reason: 'Gemini pane exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'spawned',
      agentId: 'alice@atlas-hq',
      teammateId: 'alice@atlas-hq',
      backendType: 'codex-native',
    })
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'reviewer',
      outcome: 'failed',
      reason: 'Gemini pane exited before bootstrap',
    })
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(reconciledMembers).toEqual(['bob', 'jack', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2408)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2409)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2408)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new Anthropic and Codex mixed team while split OpenCode secondary lanes are ready and launching', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid: input.memberName === 'bob' ? 2410 : 2411,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary:
        record.memberName === 'jack'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: null,
            latestAssistantText: null,
            latestAssistantPreview: null,
            messageCount: 0,
            durableState: 'idle',
            messages: [],
          })
          : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: `msg-${record.memberName}-ready`,
            latestAssistantText: `${record.memberName} ready`,
          }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-anthropic-codex-split-opencode-launching',
        mode: 'create',
        description: 'new mixed Anthropic and Codex team with split OpenCode launching from safe e2e',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
          {
            ...member('reviewer', 'codex', 'gpt-5.4-mini'),
            effort: 'medium',
          },
        ],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const [bobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-codex-split-opencode-launching',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-codex-split-opencode-launching',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new mixed Anthropic and Codex team with split OpenCode launching from safe e2e',
      },
    ])
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
      {
        name: 'reviewer',
        provider: 'codex',
        model: 'gpt-5.4-mini',
        effort: 'medium',
      },
    ])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary.createdTeam).toBe(true)
    expect(primaryResult.summary.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.registeredMembers).toEqual(['alice', 'reviewer', 'bob', 'jack'])
    expect(events.completedEvents).toEqual([
      {
        status: 'completed',
        expectedMembers: ['alice', 'reviewer'],
        registeredMembers: ['alice', 'reviewer', 'bob', 'jack'],
        failedMembers: [],
      },
    ])
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2410)
    expect(jackResult.data.teamLaunchState).toBe('launching')
    expect(jackResult.data.members.jack?.launchState).toBe('created')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2411)
    expect(jackResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new Anthropic primary team while split OpenCode secondary lanes are ready and permission-blocked', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['alice', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid: input.memberName === 'bob' ? 2414 : 2415,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary:
        record.memberName === 'jack'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: null,
            latestAssistantText: null,
            latestAssistantPreview: null,
            messageCount: 0,
            durableState: 'blocked',
            pendingPermissionRequestIds: ['perm-jack-shell'],
            diagnostics: ['jack waiting for OpenCode permission'],
            messages: [],
          })
          : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: `msg-${record.memberName}-ready`,
            latestAssistantText: `${record.memberName} ready`,
          }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-anthropic-split-opencode-permission',
        mode: 'create',
        description: 'new Anthropic team with split OpenCode permission from safe e2e',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
        ],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const [bobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-split-opencode-permission',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-split-opencode-permission',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new Anthropic team with split OpenCode permission from safe e2e',
      },
    ])
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
    ])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary.createdTeam).toBe(true)
    expect(primaryResult.summary.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice'])
    expect(primaryResult.summary.registeredMembers).toEqual(['alice', 'bob', 'jack'])
    expect(events.completedEvents).toEqual([
      {
        status: 'completed',
        expectedMembers: ['alice'],
        registeredMembers: ['alice', 'bob', 'jack'],
        failedMembers: [],
      },
    ])
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2414)
    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2415)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new Anthropic primary team while split OpenCode secondary lanes are ready and launching', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['alice', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid: input.memberName === 'bob' ? 2416 : 2417,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary:
        record.memberName === 'jack'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: null,
            latestAssistantText: null,
            latestAssistantPreview: null,
            messageCount: 0,
            durableState: 'idle',
            messages: [],
          })
          : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: `msg-${record.memberName}-ready`,
            latestAssistantText: `${record.memberName} ready`,
          }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-anthropic-split-opencode-launching',
        mode: 'create',
        description: 'new Anthropic team with split OpenCode launching from safe e2e',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
        ],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const [bobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-split-opencode-launching',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-split-opencode-launching',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new Anthropic team with split OpenCode launching from safe e2e',
      },
    ])
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
    ])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary.createdTeam).toBe(true)
    expect(primaryResult.summary.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice'])
    expect(primaryResult.summary.registeredMembers).toEqual(['alice', 'bob', 'jack'])
    expect(events.completedEvents).toEqual([
      {
        status: 'completed',
        expectedMembers: ['alice'],
        registeredMembers: ['alice', 'bob', 'jack'],
        failedMembers: [],
      },
    ])
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2416)
    expect(jackResult.data.teamLaunchState).toBe('launching')
    expect(jackResult.data.members.jack?.launchState).toBe('created')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2417)
    expect(jackResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new Anthropic primary team and promotes a launching OpenCode sibling lane to ready without disturbing a permission-blocked sibling', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['alice', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: input.memberName === 'bob' ? 2420 : 2421,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-jack-shell'],
              diagnostics: ['jack waiting for OpenCode permission'],
              messages: [],
            })
            : bobAssistantReady
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: 'msg-bob-ready-after-create-anthropic',
                latestAssistantText: 'bob ready after create anthropic',
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
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-anthropic-promote-launching-opencode',
        mode: 'create',
        description: 'new Anthropic team with delayed OpenCode recovery from safe e2e',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
        ],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const [initialBobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-promote-launching-opencode',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-promote-launching-opencode',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-create-anthropic-promote-launching-opencode',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (!primaryResult.ok || !initialBobResult.ok || !jackResult.ok || !promotedBobResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new Anthropic team with delayed OpenCode recovery from safe e2e',
      },
    ])
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary.createdTeam).toBe(true)
    expect(primaryResult.summary.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice'])
    expect(primaryResult.summary.registeredMembers).toEqual(['alice', 'bob', 'jack'])
    expect(primaryResult.summary.failedMembers).toEqual([])
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(reconciledMembers).toEqual(['bob', 'jack', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2420)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2421)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2420)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new Anthropic-only team and promotes a launching OpenCode sibling lane to ready when the Anthropic lead bootstrap is partial success without disturbing a permission-blocked sibling', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['bob', 'jack'])
    spawnFailures.set('alice', 'Anthropic pane exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: input.memberName === 'bob' ? 2425 : 2426,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-jack-shell'],
              diagnostics: ['jack waiting for OpenCode permission'],
              messages: [],
            })
            : bobAssistantReady
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: 'msg-bob-ready-after-create-anthropic-only-partial',
                latestAssistantText: 'bob ready after create anthropic-only partial',
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
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-anthropic-only-partial-promote-launching-opencode',
        mode: 'create',
        description: 'new Anthropic-only team with partial Anthropic failure and delayed OpenCode recovery from safe e2e',
        continueOnPartialFailure: true,
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
        ],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const [initialBobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-only-partial-promote-launching-opencode',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-only-partial-promote-launching-opencode',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-create-anthropic-only-partial-promote-launching-opencode',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (!primaryResult.ok || !initialBobResult.ok || !jackResult.ok || !promotedBobResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new Anthropic-only team with partial Anthropic failure and delayed OpenCode recovery from safe e2e',
      },
    ])
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary.createdTeam).toBe(true)
    expect(primaryResult.summary.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary.terminalStatus).toBe('partial_success')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice'])
    expect(primaryResult.summary.registeredMembers).toEqual(['bob', 'jack'])
    expect(primaryResult.summary.failedMembers).toEqual([
      { name: 'alice', reason: 'Anthropic pane exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'failed',
      reason: 'Anthropic pane exited before bootstrap',
    })
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(reconciledMembers).toEqual(['bob', 'jack', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2425)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2426)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2425)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new Anthropic-only team and promotes a launching OpenCode sibling lane to ready when the Anthropic lead bootstrap fails strictly without disturbing a permission-blocked sibling', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['bob', 'jack'])
    spawnFailures.set('alice', 'Anthropic pane exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: input.memberName === 'bob' ? 2427 : 2428,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-jack-shell'],
              diagnostics: ['jack waiting for OpenCode permission'],
              messages: [],
            })
            : bobAssistantReady
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: 'msg-bob-ready-after-create-anthropic-only-failed',
                latestAssistantText: 'bob ready after create anthropic-only failed',
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
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-anthropic-only-strict-failed-promote-launching-opencode',
        mode: 'create',
        description: 'new Anthropic-only team with strict Anthropic failure and delayed OpenCode recovery from safe e2e',
        continueOnPartialFailure: false,
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
        ],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const [initialBobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-only-strict-failed-promote-launching-opencode',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-only-strict-failed-promote-launching-opencode',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-create-anthropic-only-strict-failed-promote-launching-opencode',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(false)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (primaryResult.ok || !initialBobResult.ok || !jackResult.ok || !promotedBobResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new Anthropic-only team with strict Anthropic failure and delayed OpenCode recovery from safe e2e',
      },
    ])
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary?.createdTeam).toBe(true)
    expect(primaryResult.summary?.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary?.terminalStatus).toBe('failed')
    expect(primaryResult.summary?.expectedMembers).toEqual(['alice'])
    expect(primaryResult.summary?.registeredMembers).toEqual(['bob', 'jack'])
    expect(primaryResult.summary?.failedMembers).toEqual([
      { name: 'alice', reason: 'Anthropic pane exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'failed',
      reason: 'Anthropic pane exited before bootstrap',
    })
    expect(events.items).toContainEqual({
      type: 'failed',
      reason: primaryResult.error,
    })
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(reconciledMembers).toEqual(['bob', 'jack', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2427)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2428)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2427)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new Anthropic primary team while OpenCode sibling lanes split across ready, launching, and permission-blocked', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['alice', 'bob', 'jack', 'tom'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid:
          input.memberName === 'bob'
            ? 2422
            : input.memberName === 'jack'
              ? 2423
              : 2424,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary:
        record.memberName === 'jack'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: null,
            latestAssistantText: null,
            latestAssistantPreview: null,
            messageCount: 0,
            durableState: 'idle',
            messages: [],
          })
          : record.memberName === 'tom'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-tom-shell'],
              diagnostics: ['tom waiting for OpenCode permission'],
              messages: [],
            })
            : buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: `msg-${record.memberName}-ready`,
              latestAssistantText: `${record.memberName} ready`,
            }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-anthropic-three-way-opencode-split',
        mode: 'create',
        description: 'new Anthropic team with three-way OpenCode split from safe e2e',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
        ],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const [bobResult, jackResult, tomResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-three-way-opencode-split',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-three-way-opencode-split',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-three-way-opencode-split',
          laneId: 'secondary:opencode:tom',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'nemotron-3-super-free',
          members: [{ name: 'tom', role: 'Analyst', prompt: 'Tom OpenCode join' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(tomResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok || !tomResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new Anthropic team with three-way OpenCode split from safe e2e',
      },
    ])
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
    ])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(spawnInputs.map(input => input.name)).not.toContain('tom')
    expect(primaryResult.summary.createdTeam).toBe(true)
    expect(primaryResult.summary.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice'])
    expect(primaryResult.summary.registeredMembers).toEqual(['alice', 'bob', 'jack', 'tom'])
    expect(events.completedEvents).toEqual([
      {
        status: 'completed',
        expectedMembers: ['alice'],
        registeredMembers: ['alice', 'bob', 'jack', 'tom'],
        failedMembers: [],
      },
    ])
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
      {
        laneId: 'secondary:opencode:tom',
        memberName: 'tom',
        selectedModel: 'openrouter/nemotron-3-super-free',
      },
    ])
    expect(promptInputs.sort()).toEqual(['bob', 'jack', 'tom'])

    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2422)
    expect(bobResult.data.members.jack).toBeUndefined()
    expect(bobResult.data.members.tom).toBeUndefined()

    expect(jackResult.data.teamLaunchState).toBe('launching')
    expect(jackResult.data.members.jack?.launchState).toBe('created')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2423)
    expect(jackResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )
    expect(jackResult.data.members.bob).toBeUndefined()
    expect(jackResult.data.members.tom).toBeUndefined()

    expect(tomResult.data.teamLaunchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.launchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.runtimePid).toBe(2424)
    expect(tomResult.data.members.tom?.pendingPermissionRequestIds).toEqual([
      'perm-tom-shell',
    ])
    expect(tomResult.data.members.bob).toBeUndefined()
    expect(tomResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new Anthropic primary team and promotes a launching OpenCode sibling lane to ready while ready and permission-blocked siblings stay isolated', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['alice', 'bob', 'jack', 'tom'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid:
          input.memberName === 'bob'
            ? 2426
            : input.memberName === 'jack'
              ? 2427
              : 2428,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'bob' && !bobAssistantReady
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'idle',
              messages: [],
            })
            : record.memberName === 'tom'
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: null,
                latestAssistantText: null,
                latestAssistantPreview: null,
                messageCount: 0,
                durableState: 'blocked',
                pendingPermissionRequestIds: ['perm-tom-shell'],
                diagnostics: ['tom waiting for OpenCode permission'],
                messages: [],
              })
              : buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: `msg-${record.memberName}-ready`,
                latestAssistantText: `${record.memberName} ready`,
              }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-anthropic-promote-launching-three-way-split',
        mode: 'create',
        description: 'new Anthropic team with delayed three-way OpenCode recovery from safe e2e',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
        ],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const [initialBobResult, jackResult, tomResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-promote-launching-three-way-split',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-promote-launching-three-way-split',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-promote-launching-three-way-split',
          laneId: 'secondary:opencode:tom',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'nemotron-3-super-free',
          members: [{ name: 'tom', role: 'Analyst', prompt: 'Tom OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-create-anthropic-promote-launching-three-way-split',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(tomResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (
      !primaryResult.ok
      || !initialBobResult.ok
      || !jackResult.ok
      || !tomResult.ok
      || !promotedBobResult.ok
    ) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new Anthropic team with delayed three-way OpenCode recovery from safe e2e',
      },
    ])
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
    ])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(spawnInputs.map(input => input.name)).not.toContain('tom')
    expect(primaryResult.summary.createdTeam).toBe(true)
    expect(primaryResult.summary.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice'])
    expect(primaryResult.summary.registeredMembers).toEqual(['alice', 'bob', 'jack', 'tom'])
    expect(events.completedEvents).toEqual([
      {
        status: 'completed',
        expectedMembers: ['alice'],
        registeredMembers: ['alice', 'bob', 'jack', 'tom'],
        failedMembers: [],
      },
    ])
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
      {
        laneId: 'secondary:opencode:tom',
        memberName: 'tom',
        selectedModel: 'openrouter/nemotron-3-super-free',
      },
    ])
    expect(promptInputs.sort()).toEqual(['bob', 'jack', 'tom'])
    expect(reconciledMembers.filter(memberName => memberName === 'bob')).toHaveLength(2)
    expect(reconciledMembers.filter(memberName => memberName === 'jack')).toHaveLength(1)
    expect(reconciledMembers.filter(memberName => memberName === 'tom')).toHaveLength(1)

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2426)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.members.jack?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2427)

    expect(tomResult.data.teamLaunchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.launchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.runtimePid).toBe(2428)
    expect(tomResult.data.members.tom?.pendingPermissionRequestIds).toEqual([
      'perm-tom-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2426)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
    expect(promotedBobResult.data.members.tom).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new Anthropic-only team and promotes a launching OpenCode sibling lane to ready while ready and permission-blocked siblings stay isolated when the Anthropic lead bootstrap is partial success', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['bob', 'jack', 'tom'])
    spawnFailures.set('alice', 'Anthropic pane exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid:
          input.memberName === 'bob'
            ? 2429
            : input.memberName === 'jack'
              ? 2430
              : 2431,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'bob' && !bobAssistantReady
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'idle',
              messages: [],
            })
            : record.memberName === 'tom'
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: null,
                latestAssistantText: null,
                latestAssistantPreview: null,
                messageCount: 0,
                durableState: 'blocked',
                pendingPermissionRequestIds: ['perm-tom-shell'],
                diagnostics: ['tom waiting for OpenCode permission'],
                messages: [],
              })
              : buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: `msg-${record.memberName}-ready`,
                latestAssistantText: `${record.memberName} ready`,
              }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-anthropic-only-partial-promote-launching-three-way-split',
        mode: 'create',
        description: 'new Anthropic-only team with partial Anthropic failure and delayed three-way OpenCode recovery from safe e2e',
        continueOnPartialFailure: true,
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
        ],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const [initialBobResult, jackResult, tomResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-only-partial-promote-launching-three-way-split',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-only-partial-promote-launching-three-way-split',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-only-partial-promote-launching-three-way-split',
          laneId: 'secondary:opencode:tom',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'nemotron-3-super-free',
          members: [{ name: 'tom', role: 'Analyst', prompt: 'Tom OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-create-anthropic-only-partial-promote-launching-three-way-split',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(tomResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (
      !primaryResult.ok
      || !initialBobResult.ok
      || !jackResult.ok
      || !tomResult.ok
      || !promotedBobResult.ok
    ) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new Anthropic-only team with partial Anthropic failure and delayed three-way OpenCode recovery from safe e2e',
      },
    ])
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(spawnInputs.map(input => input.name)).not.toContain('tom')
    expect(primaryResult.summary.createdTeam).toBe(true)
    expect(primaryResult.summary.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary.terminalStatus).toBe('partial_success')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice'])
    expect(primaryResult.summary.registeredMembers).toEqual(['bob', 'jack', 'tom'])
    expect(primaryResult.summary.failedMembers).toEqual([
      { name: 'alice', reason: 'Anthropic pane exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'failed',
      reason: 'Anthropic pane exited before bootstrap',
    })
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
      {
        laneId: 'secondary:opencode:tom',
        memberName: 'tom',
        selectedModel: 'openrouter/nemotron-3-super-free',
      },
    ])
    expect(promptInputs.sort()).toEqual(['bob', 'jack', 'tom'])
    expect(reconciledMembers).toEqual(['bob', 'jack', 'tom', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2429)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.members.jack?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2430)

    expect(tomResult.data.teamLaunchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.launchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.runtimePid).toBe(2431)
    expect(tomResult.data.members.tom?.pendingPermissionRequestIds).toEqual([
      'perm-tom-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2429)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
    expect(promotedBobResult.data.members.tom).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new Anthropic-only team and promotes a launching OpenCode sibling lane to ready while ready and permission-blocked siblings stay isolated when the Anthropic lead bootstrap fails strictly', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['bob', 'jack', 'tom'])
    spawnFailures.set('alice', 'Anthropic pane exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid:
          input.memberName === 'bob'
            ? 2432
            : input.memberName === 'jack'
              ? 2433
              : 2434,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'bob' && !bobAssistantReady
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'idle',
              messages: [],
            })
            : record.memberName === 'tom'
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: null,
                latestAssistantText: null,
                latestAssistantPreview: null,
                messageCount: 0,
                durableState: 'blocked',
                pendingPermissionRequestIds: ['perm-tom-shell'],
                diagnostics: ['tom waiting for OpenCode permission'],
                messages: [],
              })
              : buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: `msg-${record.memberName}-ready`,
                latestAssistantText: `${record.memberName} ready`,
              }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-anthropic-only-strict-failed-promote-launching-three-way-split',
        mode: 'create',
        description: 'new Anthropic-only team with strict Anthropic failure and delayed three-way OpenCode recovery from safe e2e',
        continueOnPartialFailure: false,
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
        ],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const [initialBobResult, jackResult, tomResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-only-strict-failed-promote-launching-three-way-split',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-only-strict-failed-promote-launching-three-way-split',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-only-strict-failed-promote-launching-three-way-split',
          laneId: 'secondary:opencode:tom',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'nemotron-3-super-free',
          members: [{ name: 'tom', role: 'Analyst', prompt: 'Tom OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-create-anthropic-only-strict-failed-promote-launching-three-way-split',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(false)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(tomResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (
      primaryResult.ok
      || !initialBobResult.ok
      || !jackResult.ok
      || !tomResult.ok
      || !promotedBobResult.ok
    ) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new Anthropic-only team with strict Anthropic failure and delayed three-way OpenCode recovery from safe e2e',
      },
    ])
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(spawnInputs.map(input => input.name)).not.toContain('tom')
    expect(primaryResult.summary?.createdTeam).toBe(true)
    expect(primaryResult.summary?.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary?.terminalStatus).toBe('failed')
    expect(primaryResult.summary?.expectedMembers).toEqual(['alice'])
    expect(primaryResult.summary?.registeredMembers).toEqual(['bob', 'jack', 'tom'])
    expect(primaryResult.summary?.failedMembers).toEqual([
      { name: 'alice', reason: 'Anthropic pane exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'failed',
      reason: 'Anthropic pane exited before bootstrap',
    })
    expect(events.items).toContainEqual({
      type: 'failed',
      reason: primaryResult.error,
    })
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
      {
        laneId: 'secondary:opencode:tom',
        memberName: 'tom',
        selectedModel: 'openrouter/nemotron-3-super-free',
      },
    ])
    expect(promptInputs.sort()).toEqual(['bob', 'jack', 'tom'])
    expect(reconciledMembers).toEqual(['bob', 'jack', 'tom', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2432)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.members.jack?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2433)

    expect(tomResult.data.teamLaunchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.launchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.runtimePid).toBe(2434)
    expect(tomResult.data.members.tom?.pendingPermissionRequestIds).toEqual([
      'perm-tom-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2432)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
    expect(promotedBobResult.data.members.tom).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new Anthropic and Gemini mixed team while split OpenCode secondary lanes are ready and launching', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid: input.memberName === 'bob' ? 2412 : 2413,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary:
        record.memberName === 'jack'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: null,
            latestAssistantText: null,
            latestAssistantPreview: null,
            messageCount: 0,
            durableState: 'idle',
            messages: [],
          })
          : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: `msg-${record.memberName}-ready`,
            latestAssistantText: `${record.memberName} ready`,
          }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-anthropic-gemini-split-opencode-launching',
        mode: 'create',
        description: 'new mixed Anthropic and Gemini team with split OpenCode launching from safe e2e',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
          {
            ...member('reviewer', 'gemini', 'gemini-2.5-flash'),
            effort: 'medium',
          },
        ],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const [bobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-gemini-split-opencode-launching',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-gemini-split-opencode-launching',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new mixed Anthropic and Gemini team with split OpenCode launching from safe e2e',
      },
    ])
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
      {
        name: 'reviewer',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        effort: 'medium',
      },
    ])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary.createdTeam).toBe(true)
    expect(primaryResult.summary.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.registeredMembers).toEqual(['alice', 'reviewer', 'bob', 'jack'])
    expect(events.completedEvents).toEqual([
      {
        status: 'completed',
        expectedMembers: ['alice', 'reviewer'],
        registeredMembers: ['alice', 'reviewer', 'bob', 'jack'],
        failedMembers: [],
      },
    ])
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2412)
    expect(jackResult.data.teamLaunchState).toBe('launching')
    expect(jackResult.data.members.jack?.launchState).toBe('created')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2413)
    expect(jackResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new Anthropic and Gemini mixed team while split OpenCode secondary lanes are ready and permission-blocked', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid: input.memberName === 'bob' ? 2414 : 2415,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary:
        record.memberName === 'jack'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: null,
            latestAssistantText: null,
            latestAssistantPreview: null,
            messageCount: 0,
            durableState: 'blocked',
            pendingPermissionRequestIds: ['perm-jack-shell'],
            diagnostics: ['jack waiting for OpenCode permission'],
            messages: [],
          })
          : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: `msg-${record.memberName}-ready`,
            latestAssistantText: `${record.memberName} ready`,
          }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-anthropic-gemini-split-opencode-permission',
        mode: 'create',
        description: 'new mixed Anthropic and Gemini team with split OpenCode permission from safe e2e',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
          {
            ...member('reviewer', 'gemini', 'gemini-2.5-flash'),
            effort: 'medium',
          },
        ],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const [bobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-gemini-split-opencode-permission',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-gemini-split-opencode-permission',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new mixed Anthropic and Gemini team with split OpenCode permission from safe e2e',
      },
    ])
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
      {
        name: 'reviewer',
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        effort: 'medium',
      },
    ])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary.createdTeam).toBe(true)
    expect(primaryResult.summary.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.registeredMembers).toEqual(['alice', 'reviewer', 'bob', 'jack'])
    expect(events.completedEvents).toEqual([
      {
        status: 'completed',
        expectedMembers: ['alice', 'reviewer'],
        registeredMembers: ['alice', 'reviewer', 'bob', 'jack'],
        failedMembers: [],
      },
    ])
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2414)
    expect(jackResult.data.members.jack?.runtimePid).toBe(2415)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new mixed team and promotes a launching OpenCode sibling lane to ready when strict Gemini primary bootstrap failed while an Anthropic sibling succeeds without disturbing a permission-blocked sibling', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['alice', 'bob', 'jack'])
    spawnFailures.set('reviewer', 'Gemini pane exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: input.memberName === 'bob' ? 2426 : 2427,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-jack-shell'],
              diagnostics: ['jack waiting for OpenCode permission'],
              messages: [],
            })
            : bobAssistantReady
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: 'msg-bob-ready-after-create-anthropic-gemini-failed',
                latestAssistantText: 'bob ready after create anthropic gemini failed',
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
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-anthropic-gemini-strict-failed-promote-launching-opencode',
        mode: 'create',
        description: 'new mixed Anthropic and Gemini team with delayed OpenCode recovery from safe e2e',
        continueOnPartialFailure: false,
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
          {
            ...member('reviewer', 'gemini', 'gemini-2.5-flash'),
            effort: 'medium',
          },
        ],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const [initialBobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-gemini-strict-failed-promote-launching-opencode',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-gemini-strict-failed-promote-launching-opencode',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-create-anthropic-gemini-strict-failed-promote-launching-opencode',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(false)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (primaryResult.ok || !initialBobResult.ok || !jackResult.ok || !promotedBobResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new mixed Anthropic and Gemini team with delayed OpenCode recovery from safe e2e',
      },
    ])
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary?.createdTeam).toBe(true)
    expect(primaryResult.summary?.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary?.terminalStatus).toBe('failed')
    expect(primaryResult.summary?.expectedMembers).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary?.registeredMembers).toEqual(['alice', 'bob', 'jack'])
    expect(primaryResult.summary?.failedMembers).toEqual([
      { name: 'reviewer', reason: 'Gemini pane exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'spawned',
      agentId: 'alice@atlas-hq',
      teammateId: 'alice@atlas-hq',
      backendType: 'pane',
    })
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'reviewer',
      outcome: 'failed',
      reason: 'Gemini pane exited before bootstrap',
    })
    expect(events.items).toContainEqual({
      type: 'failed',
      reason: primaryResult.error,
    })
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(reconciledMembers).toEqual(['bob', 'jack', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2426)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2427)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2426)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new mixed team and promotes a launching OpenCode sibling lane to ready when Anthropic primary bootstrap is partial success without disturbing a permission-blocked sibling', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['reviewer', 'bob', 'jack'])
    spawnFailures.set('alice', 'Anthropic pane exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: input.memberName === 'bob' ? 2414 : 2415,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-jack-shell'],
              diagnostics: ['jack waiting for OpenCode permission'],
              messages: [],
            })
            : bobAssistantReady
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: 'msg-bob-ready-after-create-anthropic-partial',
                latestAssistantText: 'bob ready after create anthropic partial',
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
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-anthropic-partial-promote-launching-opencode',
        mode: 'create',
        description: 'new mixed team with partial Anthropic failure and delayed OpenCode recovery from safe e2e',
        continueOnPartialFailure: true,
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
          {
            ...member('reviewer', 'codex', 'gpt-5.4-mini'),
            effort: 'medium',
          },
        ],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const [initialBobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-partial-promote-launching-opencode',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-partial-promote-launching-opencode',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-create-anthropic-partial-promote-launching-opencode',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (!primaryResult.ok || !initialBobResult.ok || !jackResult.ok || !promotedBobResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new mixed team with partial Anthropic failure and delayed OpenCode recovery from safe e2e',
      },
    ])
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary.createdTeam).toBe(true)
    expect(primaryResult.summary.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary.terminalStatus).toBe('partial_success')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.registeredMembers).toEqual(['reviewer', 'bob', 'jack'])
    expect(primaryResult.summary.failedMembers).toEqual([
      { name: 'alice', reason: 'Anthropic pane exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'failed',
      reason: 'Anthropic pane exited before bootstrap',
    })
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'reviewer',
      outcome: 'spawned',
      agentId: 'reviewer@atlas-hq',
      teammateId: 'reviewer@atlas-hq',
      backendType: 'codex-native',
    })
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(reconciledMembers).toEqual(['bob', 'jack', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2414)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2415)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2414)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new mixed team and promotes a launching OpenCode sibling lane to ready when strict Anthropic primary bootstrap failed without disturbing a permission-blocked sibling', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['reviewer', 'bob', 'jack'])
    spawnFailures.set('alice', 'Anthropic pane exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: input.memberName === 'bob' ? 2412 : 2413,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-jack-shell'],
              diagnostics: ['jack waiting for OpenCode permission'],
              messages: [],
            })
            : bobAssistantReady
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: 'msg-bob-ready-after-create-anthropic-failed',
                latestAssistantText: 'bob ready after create anthropic failed',
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
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-anthropic-strict-failed-promote-launching-opencode',
        mode: 'create',
        description: 'new mixed team with strict Anthropic failure and delayed OpenCode recovery from safe e2e',
        continueOnPartialFailure: false,
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
          {
            ...member('reviewer', 'codex', 'gpt-5.4-mini'),
            effort: 'medium',
          },
        ],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const [initialBobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-strict-failed-promote-launching-opencode',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-anthropic-strict-failed-promote-launching-opencode',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-create-anthropic-strict-failed-promote-launching-opencode',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(false)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (primaryResult.ok || !initialBobResult.ok || !jackResult.ok || !promotedBobResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new mixed team with strict Anthropic failure and delayed OpenCode recovery from safe e2e',
      },
    ])
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary?.createdTeam).toBe(true)
    expect(primaryResult.summary?.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary?.terminalStatus).toBe('failed')
    expect(primaryResult.summary?.expectedMembers).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary?.registeredMembers).toEqual(['reviewer', 'bob', 'jack'])
    expect(primaryResult.summary?.failedMembers).toEqual([
      { name: 'alice', reason: 'Anthropic pane exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'failed',
      reason: 'Anthropic pane exited before bootstrap',
    })
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'reviewer',
      outcome: 'spawned',
      agentId: 'reviewer@atlas-hq',
      teammateId: 'reviewer@atlas-hq',
      backendType: 'codex-native',
    })
    expect(events.items).toContainEqual({
      type: 'failed',
      reason: primaryResult.error,
    })
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(reconciledMembers).toEqual(['bob', 'jack', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2412)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2413)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2412)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new mixed team and keeps split OpenCode secondary lanes isolated when strict Codex primary bootstrap failed', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['reviewer', 'bob', 'jack'])
    spawnFailures.set('alice', 'Codex native process exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid: input.memberName === 'bob' ? 2406 : 2407,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary:
        record.memberName === 'jack'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: null,
            latestAssistantText: null,
            latestAssistantPreview: null,
            messageCount: 0,
            durableState: 'blocked',
            pendingPermissionRequestIds: ['perm-jack-shell'],
            diagnostics: ['jack waiting for OpenCode permission'],
            messages: [],
          })
          : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: `msg-${record.memberName}-ready`,
            latestAssistantText: `${record.memberName} ready`,
          }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-codex-strict-failed-split-opencode',
        mode: 'create',
        description: 'new mixed team with strict Codex failure and split OpenCode lanes from safe e2e',
        continueOnPartialFailure: false,
        members: [
          member('alice', 'codex', 'gpt-5.4-mini'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const [bobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-codex-strict-failed-split-opencode',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-codex-strict-failed-split-opencode',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(false)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new mixed team with strict Codex failure and split OpenCode lanes from safe e2e',
      },
    ])
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary?.createdTeam).toBe(true)
    expect(primaryResult.summary?.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary?.terminalStatus).toBe('failed')
    expect(primaryResult.summary?.expectedMembers).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary?.registeredMembers).toEqual(['reviewer', 'bob', 'jack'])
    expect(primaryResult.summary?.failedMembers).toEqual([
      { name: 'alice', reason: 'Codex native process exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'failed',
      reason: 'Codex native process exited before bootstrap',
    })
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'reviewer',
      outcome: 'spawned',
      agentId: 'reviewer@atlas-hq',
      teammateId: 'reviewer@atlas-hq',
      backendType: 'pane',
    })
    expect(ensureInputs).toHaveLength(2)
    expect(ensureInputs).toContainEqual({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      selectedModel: 'openrouter/minimax-m2.5-free',
    })
    expect(ensureInputs).toContainEqual({
      laneId: 'secondary:opencode:jack',
      memberName: 'jack',
      selectedModel: 'openrouter/ling-2.6-flash-free',
    })
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2406)
    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2407)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new mixed team and promotes a launching OpenCode sibling lane to ready when strict Codex primary bootstrap failed without disturbing a permission-blocked sibling', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['reviewer', 'bob', 'jack'])
    spawnFailures.set('alice', 'Codex native process exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: input.memberName === 'bob' ? 2420 : 2421,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-jack-shell'],
              diagnostics: ['jack waiting for OpenCode permission'],
              messages: [],
            })
            : bobAssistantReady
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: 'msg-bob-ready-after-create-codex-failed',
                latestAssistantText: 'bob ready after create codex failed',
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
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-codex-strict-failed-promote-launching-opencode',
        mode: 'create',
        description: 'new mixed team with strict Codex failure and delayed OpenCode recovery from safe e2e',
        continueOnPartialFailure: false,
        members: [
          member('alice', 'codex', 'gpt-5.4-mini'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const [initialBobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-codex-strict-failed-promote-launching-opencode',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-codex-strict-failed-promote-launching-opencode',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-create-codex-strict-failed-promote-launching-opencode',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(false)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (primaryResult.ok || !initialBobResult.ok || !jackResult.ok || !promotedBobResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new mixed team with strict Codex failure and delayed OpenCode recovery from safe e2e',
      },
    ])
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary?.createdTeam).toBe(true)
    expect(primaryResult.summary?.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary?.terminalStatus).toBe('failed')
    expect(primaryResult.summary?.expectedMembers).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary?.registeredMembers).toEqual(['reviewer', 'bob', 'jack'])
    expect(primaryResult.summary?.failedMembers).toEqual([
      { name: 'alice', reason: 'Codex native process exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'failed',
      reason: 'Codex native process exited before bootstrap',
    })
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'reviewer',
      outcome: 'spawned',
      agentId: 'reviewer@atlas-hq',
      teammateId: 'reviewer@atlas-hq',
      backendType: 'pane',
    })
    expect(events.items).toContainEqual({
      type: 'failed',
      reason: primaryResult.error,
    })
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(reconciledMembers).toEqual(['bob', 'jack', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2420)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2421)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2420)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new mixed team and keeps split OpenCode secondary lanes isolated when strict Gemini primary bootstrap failed', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['alice', 'bob', 'jack'])
    spawnFailures.set('reviewer', 'Gemini pane exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid: input.memberName === 'bob' ? 2408 : 2409,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary:
        record.memberName === 'jack'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: null,
            latestAssistantText: null,
            latestAssistantPreview: null,
            messageCount: 0,
            durableState: 'blocked',
            pendingPermissionRequestIds: ['perm-jack-shell'],
            diagnostics: ['jack waiting for OpenCode permission'],
            messages: [],
          })
          : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: `msg-${record.memberName}-ready`,
            latestAssistantText: `${record.memberName} ready`,
          }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-gemini-strict-failed-split-opencode',
        mode: 'create',
        description: 'new mixed team with strict Gemini failure and split OpenCode lanes from safe e2e',
        continueOnPartialFailure: false,
        members: [
          member('alice', 'codex', 'gpt-5.4-mini'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const [bobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-gemini-strict-failed-split-opencode',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-gemini-strict-failed-split-opencode',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(false)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new mixed team with strict Gemini failure and split OpenCode lanes from safe e2e',
      },
    ])
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary?.createdTeam).toBe(true)
    expect(primaryResult.summary?.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary?.terminalStatus).toBe('failed')
    expect(primaryResult.summary?.expectedMembers).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary?.registeredMembers).toEqual(['alice', 'bob', 'jack'])
    expect(primaryResult.summary?.failedMembers).toEqual([
      { name: 'reviewer', reason: 'Gemini pane exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'spawned',
      agentId: 'alice@atlas-hq',
      teammateId: 'alice@atlas-hq',
      backendType: 'codex-native',
    })
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'reviewer',
      outcome: 'failed',
      reason: 'Gemini pane exited before bootstrap',
    })
    expect(ensureInputs).toHaveLength(2)
    expect(ensureInputs).toContainEqual({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      selectedModel: 'openrouter/minimax-m2.5-free',
    })
    expect(ensureInputs).toContainEqual({
      laneId: 'secondary:opencode:jack',
      memberName: 'jack',
      selectedModel: 'openrouter/ling-2.6-flash-free',
    })
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2408)
    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2409)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a new mixed team and promotes a launching OpenCode sibling lane to ready when strict Gemini primary bootstrap failed without disturbing a permission-blocked sibling', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['alice', 'bob', 'jack'])
    spawnFailures.set('reviewer', 'Gemini pane exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: input.memberName === 'bob' ? 2416 : 2417,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-jack-shell'],
              diagnostics: ['jack waiting for OpenCode permission'],
              messages: [],
            })
            : bobAssistantReady
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: 'msg-bob-ready-after-create-gemini-failed',
                latestAssistantText: 'bob ready after create gemini failed',
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
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-create-gemini-strict-failed-promote-launching-opencode',
        mode: 'create',
        description: 'new mixed team with strict Gemini failure and delayed OpenCode recovery from safe e2e',
        continueOnPartialFailure: false,
        members: [
          member('alice', 'codex', 'gpt-5.4-mini'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const [initialBobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-gemini-strict-failed-promote-launching-opencode',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-create-gemini-strict-failed-promote-launching-opencode',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-create-gemini-strict-failed-promote-launching-opencode',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(false)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (primaryResult.ok || !initialBobResult.ok || !jackResult.ok || !promotedBobResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new mixed team with strict Gemini failure and delayed OpenCode recovery from safe e2e',
      },
    ])
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(spawnInputs.map(input => input.name)).not.toContain('jack')
    expect(primaryResult.summary?.createdTeam).toBe(true)
    expect(primaryResult.summary?.reusedExistingTeam).toBe(false)
    expect(primaryResult.summary?.terminalStatus).toBe('failed')
    expect(primaryResult.summary?.expectedMembers).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary?.registeredMembers).toEqual(['alice', 'bob', 'jack'])
    expect(primaryResult.summary?.failedMembers).toEqual([
      { name: 'reviewer', reason: 'Gemini pane exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'spawned',
      agentId: 'alice@atlas-hq',
      teammateId: 'alice@atlas-hq',
      backendType: 'codex-native',
    })
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'reviewer',
      outcome: 'failed',
      reason: 'Gemini pane exited before bootstrap',
    })
    expect(events.items).toContainEqual({
      type: 'failed',
      reason: primaryResult.error,
    })
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(reconciledMembers).toEqual(['bob', 'jack', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2416)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2417)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2416)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('attaches an existing detached team before launching Codex primary and OpenCode secondary lanes', async () => {
    teamConfigExists = true
    registeredMemberNames = new Set(['alice', 'bob'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid: 2452,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: `msg-${record.memberName}-ready`,
        latestAssistantText: `${record.memberName} ready`,
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-attach-existing-handoff',
        mode: 'launch',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-attach-existing-handoff',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([])
    expect(updateTeamCalls).toEqual(['atlas-hq'])
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'codex',
        model: 'gpt-5.4-mini',
      },
    ])
    expect(spawnInputs.map(input => input.name)).not.toContain('bob')
    expect(primaryResult.summary.createdTeam).toBe(false)
    expect(primaryResult.summary.reusedExistingTeam).toBe(true)
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.expectedMembers).toEqual(['alice'])
    expect(primaryResult.summary.registeredMembers).toEqual(['alice', 'bob'])
    expect(ensureInputs).toEqual([
      {
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        selectedModel: 'openrouter/minimax-m2.5-free',
      },
    ])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2452)
  }, SAFE_E2E_TIMEOUT_MS)

  test('creates a pure OpenCode team with lead-only primary bootstrap before bridge launch', async () => {
    teamConfigExists = false
    registeredMemberNames = new Set(['bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const promptInputs: Array<{ memberName: string; text: string }> = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input =>
      buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
      })) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async (record, input) => {
      promptInputs.push({
        memberName: record.memberName,
        text: input.text,
      })
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: `msg-${record.memberName}-ready`,
        latestAssistantText: `${record.memberName} ready`,
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-pure-opencode-create',
        mode: 'create',
        description: 'new pure OpenCode team from safe e2e',
        members: [],
      }),
      context: detachedContext(),
      emit: events.emit,
    })
    const openCodeResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-pure-opencode-create',
        laneId: 'primary',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [
          { name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' },
          { name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' },
        ],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(openCodeResult.ok).toBe(true)
    if (!primaryResult.ok || !openCodeResult.ok) {
      return
    }
    expect(createTeamCalls).toEqual([
      {
        team_name: 'atlas-hq',
        description: 'new pure OpenCode team from safe e2e',
      },
    ])
    expect(spawnInputs).toEqual([])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.expectedMembers).toEqual([])
    expect(events.items).toContainEqual({ type: 'started', members: [] })
    expect(promptInputs).toEqual([
      { memberName: 'bob', text: 'Bob OpenCode join' },
      { memberName: 'jack', text: 'Jack OpenCode join' },
    ])
    expect(openCodeResult.data.teamLaunchState).toBe('ready')
    expect(openCodeResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(openCodeResult.data.members.jack?.launchState).toBe('confirmed_alive')
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps a pure OpenCode team permission-blocked until every teammate can launch', async () => {
    registeredMemberNames = new Set(['bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string }> = []
    const promptInputs: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
      })
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: input.memberName === 'bob' ? 3202 : 3203,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary:
        record.memberName === 'jack'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: null,
            latestAssistantText: null,
            latestAssistantPreview: null,
            messageCount: 0,
            durableState: 'blocked',
            pendingPermissionRequestIds: ['perm-jack-shell'],
            diagnostics: ['jack waiting for OpenCode permission'],
            messages: [],
          })
          : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: 'msg-bob-ready',
            latestAssistantText: 'bob ready',
          }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-pure-opencode-permission-blocked',
        members: [],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const openCodeResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-pure-opencode-permission-blocked',
        laneId: 'primary',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [
          { name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' },
          { name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' },
        ],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(openCodeResult.ok).toBe(true)
    if (!primaryResult.ok || !openCodeResult.ok) {
      return
    }
    expect(spawnInputs).toEqual([])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(ensureInputs).toEqual([
      { laneId: 'primary', memberName: 'bob' },
      { laneId: 'primary', memberName: 'jack' },
    ])
    expect(promptInputs).toEqual(['bob', 'jack'])
    expect(openCodeResult.data.teamLaunchState).toBe('permission_blocked')
    expect(openCodeResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(openCodeResult.data.members.bob?.runtimePid).toBe(3202)
    expect(openCodeResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(openCodeResult.data.members.jack?.runtimePid).toBe(3203)
    expect(openCodeResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])
    expect(openCodeResult.data.diagnostics).toContainEqual({
      code: 'member_reconcile',
      message: 'jack: jack waiting for OpenCode permission',
      severity: 'warning',
    })
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps primary Codex launch successful when one OpenCode secondary lane fails', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string }> = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
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
      record,
      summary:
        record.memberName === 'bob'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            staleReason: 'bob OpenCode bootstrap session disappeared',
            errorCount: 1,
            diagnostics: ['bob OpenCode bootstrap session disappeared'],
          })
          : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: `msg-${record.memberName}-ready`,
            latestAssistantText: `${record.memberName} ready`,
          }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-handoff-partial',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-handoff-partial',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )
    const jackResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-handoff-partial',
        laneId: 'secondary:opencode:jack',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/ling-2.6-flash-free',
        members: [{ name: 'jack', role: 'Developer', prompt: 'Jack OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'codex',
        model: 'gpt-5.4-mini',
      },
    ])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(events.completedEvents).toEqual([
      {
        status: 'completed',
        expectedMembers: ['alice'],
        registeredMembers: ['alice', 'bob', 'jack'],
        failedMembers: [],
      },
    ])
    expect(ensureInputs).toEqual([
      {
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
      },
      {
        laneId: 'secondary:opencode:jack',
        memberName: 'jack',
      },
    ])
    expect(bobResult.data.teamLaunchState).toBe('failed')
    expect(bobResult.data.members.bob?.launchState).toBe('failed')
    expect(bobResult.data.diagnostics).toContainEqual({
      code: 'member_reconcile',
      message: 'bob: bob OpenCode bootstrap session disappeared',
      severity: 'warning',
    })
    expect(jackResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.members.jack?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.bob).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps duplicate Codex primary and permission-blocked OpenCode secondary states distinct', async () => {
    registeredMemberNames = new Set(['alice', 'bob'])
    duplicateSpawns.set('alice', 'already_running')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        latestAssistantMessageId: null,
        latestAssistantText: null,
        latestAssistantPreview: null,
        messageCount: 0,
        durableState: 'blocked',
        pendingPermissionRequestIds: ['perm-bob', 'perm-bob'],
        diagnostics: ['bob waiting for OpenCode permission'],
        messages: [],
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-duplicate-permission',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-duplicate-permission',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok) {
      return
    }
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'codex',
        model: 'gpt-5.4-mini',
      },
    ])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'already_running',
      agentId: 'alice@atlas-hq',
      teammateId: 'alice@atlas-hq',
      reason: 'already_running',
    })
    expect(bobResult.data.teamLaunchState).toBe('permission_blocked')
    expect(bobResult.data.members.bob?.launchState).toBe('permission_blocked')
    expect(bobResult.data.members.bob?.pendingPermissionRequestIds).toEqual(['perm-bob'])
    expect(bobResult.data.diagnostics).toContainEqual({
      code: 'member_reconcile',
      message: 'bob: bob waiting for OpenCode permission',
      severity: 'warning',
    })
  }, SAFE_E2E_TIMEOUT_MS)

  test('rejects duplicate OpenCode side-lane members without rewriting primary Codex launch state', async () => {
    registeredMemberNames = new Set(['alice'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
      })
    }) as typeof openCodeSessionBridge.ensureSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-duplicate-opencode-lane',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const openCodeResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-duplicate-opencode-lane',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [
          { name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' },
          { name: 'BOB', role: 'Reviewer', prompt: 'Duplicate Bob OpenCode join' },
        ],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(openCodeResult.ok).toBe(false)
    if (!primaryResult.ok || openCodeResult.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'codex',
        model: 'gpt-5.4-mini',
      },
    ])
    expect(openCodeResult.error.message).toContain(
      'opencode.launchTeam members contains duplicate member name "BOB"',
    )
    expect(ensureSessionCalls).toBe(0)
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps bootstrap-pending Codex primary and ready OpenCode secondary states distinct', async () => {
    registeredMemberNames = new Set(['alice', 'bob'])
    duplicateSpawns.set('alice', 'bootstrap_pending')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input =>
      buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: 2802,
      })) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: `msg-${record.memberName}-ready`,
        latestAssistantText: `${record.memberName} ready`,
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-bootstrap-pending-ready',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-bootstrap-pending-ready',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'duplicate_pending',
      agentId: 'alice@atlas-hq',
      teammateId: 'alice@atlas-hq',
      reason: 'bootstrap_pending',
    })
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2802)
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps OpenCode secondary ready when Codex primary launch is partial success', async () => {
    registeredMemberNames = new Set(['reviewer', 'bob'])
    spawnFailures.set('alice', 'Codex native process exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input =>
      buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: 2302,
      })) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: `msg-${record.memberName}-ready`,
        latestAssistantText: `${record.memberName} ready`,
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-codex-partial-opencode-ready',
        continueOnPartialFailure: true,
        members: [
          member('alice', 'codex', 'gpt-5.4-mini'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-codex-partial-opencode-ready',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.terminalStatus).toBe('partial_success')
    expect(primaryResult.summary.failedMembers).toEqual([
      { name: 'alice', reason: 'Codex native process exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'failed',
      reason: 'Codex native process exited before bootstrap',
    })
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'reviewer',
      outcome: 'spawned',
      agentId: 'reviewer@atlas-hq',
      teammateId: 'reviewer@atlas-hq',
      backendType: 'pane',
    })
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2302)
  }, SAFE_E2E_TIMEOUT_MS)

  test('promotes a launching OpenCode sibling lane to ready when Codex primary bootstrap is partial success without disturbing a permission-blocked sibling', async () => {
    registeredMemberNames = new Set(['reviewer', 'bob', 'jack'])
    spawnFailures.set('alice', 'Codex native process exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: input.memberName === 'bob' ? 2308 : 2309,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-jack-shell'],
              diagnostics: ['jack waiting for OpenCode permission'],
              messages: [],
            })
            : bobAssistantReady
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: 'msg-bob-ready-after-codex-partial',
                latestAssistantText: 'bob ready after codex partial',
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
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-codex-partial-promote-launching-opencode',
        continueOnPartialFailure: true,
        members: [
          member('alice', 'codex', 'gpt-5.4-mini'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [initialBobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-codex-partial-promote-launching-opencode',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-codex-partial-promote-launching-opencode',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-codex-partial-promote-launching-opencode',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (!primaryResult.ok || !initialBobResult.ok || !jackResult.ok || !promotedBobResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.terminalStatus).toBe('partial_success')
    expect(primaryResult.summary.failedMembers).toEqual([
      { name: 'alice', reason: 'Codex native process exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'failed',
      reason: 'Codex native process exited before bootstrap',
    })
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'reviewer',
      outcome: 'spawned',
      agentId: 'reviewer@atlas-hq',
      teammateId: 'reviewer@atlas-hq',
      backendType: 'pane',
    })
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(reconciledMembers).toEqual(['bob', 'jack', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2308)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2309)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2308)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps Codex primary and OpenCode secondary ready when Gemini primary launch is partial success', async () => {
    registeredMemberNames = new Set(['alice', 'bob'])
    spawnFailures.set('reviewer', 'Gemini pane exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input =>
      buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: 2305,
      })) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: `msg-${record.memberName}-ready`,
        latestAssistantText: `${record.memberName} ready`,
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-gemini-partial-opencode-ready',
        continueOnPartialFailure: true,
        members: [
          member('alice', 'codex', 'gpt-5.4-mini'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-gemini-partial-opencode-ready',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.terminalStatus).toBe('partial_success')
    expect(primaryResult.summary.registeredMembers).toEqual(['alice', 'bob'])
    expect(primaryResult.summary.failedMembers).toEqual([
      { name: 'reviewer', reason: 'Gemini pane exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'spawned',
      agentId: 'alice@atlas-hq',
      teammateId: 'alice@atlas-hq',
      backendType: 'codex-native',
    })
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'reviewer',
      outcome: 'failed',
      reason: 'Gemini pane exited before bootstrap',
    })
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2305)
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps split OpenCode secondary lanes isolated when Gemini primary partially fails', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'jack'])
    spawnFailures.set('reviewer', 'Gemini pane exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid: input.memberName === 'bob' ? 2310 : 2311,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary:
        record.memberName === 'jack'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: null,
            latestAssistantText: null,
            latestAssistantPreview: null,
            messageCount: 0,
            durableState: 'blocked',
            pendingPermissionRequestIds: ['perm-jack-shell'],
            diagnostics: ['jack waiting for OpenCode permission'],
            messages: [],
          })
          : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: `msg-${record.memberName}-ready`,
            latestAssistantText: `${record.memberName} ready`,
          }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-gemini-partial-split-opencode',
        continueOnPartialFailure: true,
        members: [
          member('alice', 'codex', 'gpt-5.4-mini'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [bobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-gemini-partial-split-opencode',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-gemini-partial-split-opencode',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.terminalStatus).toBe('partial_success')
    expect(primaryResult.summary.failedMembers).toEqual([
      { name: 'reviewer', reason: 'Gemini pane exited before bootstrap' },
    ])
    expect(ensureInputs).toHaveLength(2)
    expect(ensureInputs).toContainEqual({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      selectedModel: 'openrouter/minimax-m2.5-free',
    })
    expect(ensureInputs).toContainEqual({
      laneId: 'secondary:opencode:jack',
      memberName: 'jack',
      selectedModel: 'openrouter/ling-2.6-flash-free',
    })
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(Object.keys(bobResult.data.members)).toEqual(['bob'])
    expect(Object.keys(jackResult.data.members)).toEqual(['jack'])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2310)
    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2311)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])
  }, SAFE_E2E_TIMEOUT_MS)

  test('promotes a launching OpenCode sibling lane to ready when Gemini primary bootstrap is partial success without disturbing a permission-blocked sibling', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'jack'])
    spawnFailures.set('reviewer', 'Gemini pane exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: input.memberName === 'bob' ? 2312 : 2313,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-jack-shell'],
              diagnostics: ['jack waiting for OpenCode permission'],
              messages: [],
            })
            : bobAssistantReady
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: 'msg-bob-ready-after-gemini-partial',
                latestAssistantText: 'bob ready after gemini partial',
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
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-gemini-partial-promote-launching-opencode',
        continueOnPartialFailure: true,
        members: [
          member('alice', 'codex', 'gpt-5.4-mini'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [initialBobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-gemini-partial-promote-launching-opencode',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-gemini-partial-promote-launching-opencode',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-gemini-partial-promote-launching-opencode',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (!primaryResult.ok || !initialBobResult.ok || !jackResult.ok || !promotedBobResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.terminalStatus).toBe('partial_success')
    expect(primaryResult.summary.failedMembers).toEqual([
      { name: 'reviewer', reason: 'Gemini pane exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'reviewer',
      outcome: 'failed',
      reason: 'Gemini pane exited before bootstrap',
    })
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(reconciledMembers).toEqual(['bob', 'jack', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2312)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2313)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2312)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps OpenCode secondary ready when strict Codex primary bootstrap failed', async () => {
    registeredMemberNames = new Set(['reviewer', 'bob'])
    spawnFailures.set('alice', 'Codex native process exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: 2303,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: `msg-${record.memberName}-ready`,
        latestAssistantText: `${record.memberName} ready`,
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-codex-strict-failed-opencode-ready',
        continueOnPartialFailure: false,
        members: [
          member('alice', 'codex', 'gpt-5.4-mini'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-codex-strict-failed-opencode-ready',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(false)
    expect(bobResult.ok).toBe(true)
    if (primaryResult.ok || !bobResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary?.terminalStatus).toBe('failed')
    expect(primaryResult.summary?.failedMembers).toEqual([
      { name: 'alice', reason: 'Codex native process exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'failed',
      reason: 'Codex native process exited before bootstrap',
    })
    expect(events.items).toContainEqual({
      type: 'failed',
      reason: primaryResult.error,
    })
    expect(ensureSessionCalls).toBe(1)
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2303)
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps OpenCode secondary permission-blocked when strict Codex primary bootstrap failed', async () => {
    registeredMemberNames = new Set(['reviewer', 'bob'])
    spawnFailures.set('alice', 'Codex native process exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: 2304,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {}) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: null,
        latestAssistantText: null,
        latestAssistantPreview: null,
        messageCount: 0,
        durableState: 'blocked',
        pendingPermissionRequestIds: ['perm-bob-shell'],
        diagnostics: ['bob waiting for OpenCode permission'],
        messages: [],
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-codex-strict-failed-opencode-permission',
        continueOnPartialFailure: false,
        members: [
          member('alice', 'codex', 'gpt-5.4-mini'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-codex-strict-failed-opencode-permission',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(false)
    expect(bobResult.ok).toBe(true)
    if (primaryResult.ok || !bobResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary?.terminalStatus).toBe('failed')
    expect(primaryResult.summary?.failedMembers).toEqual([
      { name: 'alice', reason: 'Codex native process exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'failed',
      reason: primaryResult.error,
    })
    expect(ensureSessionCalls).toBe(1)
    expect(bobResult.data.teamLaunchState).toBe('permission_blocked')
    expect(bobResult.data.members.bob?.launchState).toBe('permission_blocked')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2304)
    expect(bobResult.data.members.bob?.pendingPermissionRequestIds).toEqual([
      'perm-bob-shell',
    ])
    expect(bobResult.data.diagnostics).toContainEqual({
      code: 'member_reconcile',
      message: 'bob: bob waiting for OpenCode permission',
      severity: 'warning',
    })
  }, SAFE_E2E_TIMEOUT_MS)

  test('promotes a launching OpenCode sibling lane to ready when strict Codex primary bootstrap failed without disturbing a permission-blocked sibling', async () => {
    registeredMemberNames = new Set(['reviewer', 'bob', 'jack'])
    spawnFailures.set('alice', 'Codex native process exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: input.memberName === 'bob' ? 2306 : 2307,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-jack-shell'],
              diagnostics: ['jack waiting for OpenCode permission'],
              messages: [],
            })
            : bobAssistantReady
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: 'msg-bob-ready-after-primary-failed',
                latestAssistantText: 'bob ready after primary failed',
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
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-codex-strict-failed-opencode-promote-launching',
        continueOnPartialFailure: false,
        members: [
          member('alice', 'codex', 'gpt-5.4-mini'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [initialBobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-codex-strict-failed-opencode-promote-launching',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-codex-strict-failed-opencode-promote-launching',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-codex-strict-failed-opencode-promote-launching',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(false)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (primaryResult.ok || !initialBobResult.ok || !jackResult.ok || !promotedBobResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary?.terminalStatus).toBe('failed')
    expect(primaryResult.summary?.failedMembers).toEqual([
      { name: 'alice', reason: 'Codex native process exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'failed',
      reason: primaryResult.error,
    })
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(reconciledMembers).toEqual(['bob', 'jack', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2306)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2307)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2306)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('promotes a launching OpenCode sibling lane to ready when strict Gemini primary bootstrap failed without disturbing a permission-blocked sibling', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'jack'])
    spawnFailures.set('reviewer', 'Gemini pane exited before bootstrap')
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let bobAssistantReady = false
    const storedRecords = new Map<string, OpenCodeSessionRecord>()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: string[] = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
      const record = buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: input.memberName === 'bob' ? 2410 : 2411,
      })
      storedRecords.set(input.memberName, record)
      return record
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return storedRecords.get(resolvedMemberName) ?? null
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async record => {
      promptInputs.push(record.memberName)
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-jack-shell'],
              diagnostics: ['jack waiting for OpenCode permission'],
              messages: [],
            })
            : bobAssistantReady
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: 'msg-bob-ready-after-gemini-failed',
                latestAssistantText: 'bob ready after gemini failed',
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
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-gemini-strict-failed-opencode-promote-launching',
        continueOnPartialFailure: false,
        members: [
          member('alice', 'codex', 'gpt-5.4-mini'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [initialBobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-gemini-strict-failed-opencode-promote-launching',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-gemini-strict-failed-opencode-promote-launching',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-gemini-strict-failed-opencode-promote-launching',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(false)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (primaryResult.ok || !initialBobResult.ok || !jackResult.ok || !promotedBobResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary?.terminalStatus).toBe('failed')
    expect(primaryResult.summary?.failedMembers).toEqual([
      { name: 'reviewer', reason: 'Gemini pane exited before bootstrap' },
    ])
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'alice',
      outcome: 'spawned',
      agentId: 'alice@atlas-hq',
      teammateId: 'alice@atlas-hq',
      backendType: 'codex-native',
    })
    expect(events.items).toContainEqual({
      type: 'member_spawn_result',
      memberName: 'reviewer',
      outcome: 'failed',
      reason: 'Gemini pane exited before bootstrap',
    })
    expect(events.items).toContainEqual({
      type: 'failed',
      reason: primaryResult.error,
    })
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
    expect(promptInputs.sort()).toEqual(['bob', 'jack'])
    expect(reconciledMembers).toEqual(['bob', 'jack', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(2410)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(2411)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(2410)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps primary Codex completed when OpenCode secondary model resolution fails before spawning', async () => {
    registeredMemberNames = new Set(['alice'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
      })
    }) as typeof openCodeSessionBridge.ensureSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-opencode-model-rejected',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-opencode-model-rejected',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'ghost-model',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(false)
    if (!primaryResult.ok || bobResult.ok) {
      return
    }
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'codex',
        model: 'gpt-5.4-mini',
      },
    ])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(events.completedEvents).toEqual([
      {
        status: 'completed',
        expectedMembers: ['alice'],
        registeredMembers: ['alice'],
        failedMembers: [],
      },
    ])
    expect(ensureSessionCalls).toBe(0)
    expect(bobResult.error.message).toContain(
      'OpenCode raw model id "ghost-model" was not found in the live provider catalog',
    )
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps primary Codex completed when OpenCode secondary provider-scoped model is absent from catalog', async () => {
    registeredMemberNames = new Set(['alice'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-opencode-scoped-model-rejected',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-opencode-scoped-model-rejected',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/ghost-model',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(false)
    if (!primaryResult.ok || bobResult.ok) {
      return
    }
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'codex',
        model: 'gpt-5.4-mini',
      },
    ])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(bobResult.error.message).toContain(
      'OpenCode provider-scoped model "openrouter/ghost-model" was not found in the live provider catalog',
    )
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps primary Codex completed when OpenCode secondary model fails before MCP proof', async () => {
    registeredMemberNames = new Set(['alice'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    let mcpConnectCalls = 0
    let mcpListToolsCalls = 0

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    ;(Client.prototype.connect as unknown as (...args: unknown[]) => Promise<void>) = async () => {
      mcpConnectCalls += 1
      throw new Error('MCP proof should not run for OpenCode model fail-fast')
    }
    ;(Client.prototype.listTools as unknown as (...args: unknown[]) => Promise<{ tools: Array<{ name: string }> }>) =
      async () => {
        mcpListToolsCalls += 1
        throw new Error('MCP tools/list should not run for OpenCode model fail-fast')
      }
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-opencode-model-fail-fast-before-mcp',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-opencode-model-fail-fast-before-mcp',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'openrouter/ghost-model',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(false)
    if (!primaryResult.ok || bobResult.ok) {
      return
    }
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'codex',
        model: 'gpt-5.4-mini',
      },
    ])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(mcpConnectCalls).toBe(0)
    expect(mcpListToolsCalls).toBe(0)
    expect(bobResult.error.message).toContain(
      'OpenCode provider-scoped model "openrouter/ghost-model" was not found in the live provider catalog',
    )
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps primary Codex completed when OpenCode secondary model provider is disconnected', async () => {
    registeredMemberNames = new Set(['alice'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0

    openCodeProvisioningProbe.probe = async () => ({
      ...openCodeSnapshot(),
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

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-opencode-provider-disconnected',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-opencode-provider-disconnected',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(false)
    if (!primaryResult.ok || bobResult.ok) {
      return
    }
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'codex',
        model: 'gpt-5.4-mini',
      },
    ])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(bobResult.error.message).toContain(
      'OpenCode provider "openrouter" for selected model "openrouter/minimax-m2.5-free" is not connected',
    )
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps primary Codex completed when OpenCode secondary runtime MCP gate is unavailable', async () => {
    registeredMemberNames = new Set(['alice'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    let promptCalls = 0

    openCodeProvisioningProbe.probe = async () => ({
      ...openCodeSnapshot(),
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

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-opencode-mcp-unavailable',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-opencode-mcp-unavailable',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(false)
    if (!primaryResult.ok || bobResult.ok) {
      return
    }
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'codex',
        model: 'gpt-5.4-mini',
      },
    ])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(promptCalls).toBe(0)
    expect(bobResult.error.message).toContain(
      'Agent Teams MCP tools are not visible in OpenCode',
    )
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps primary Codex completed when OpenCode secondary host is unhealthy', async () => {
    registeredMemberNames = new Set(['alice'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    let mcpConnectCalls = 0

    openCodeProvisioningProbe.probe = async () => ({
      ...openCodeSnapshot(),
      hostHealthy: false,
      host: null,
      configProviders: null,
      probeError: 'OpenCode host failed health check',
    })
    ;(Client.prototype.connect as unknown as (...args: unknown[]) => Promise<void>) = async () => {
      mcpConnectCalls += 1
      throw new Error('MCP proof should not run for an unhealthy host')
    }
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-opencode-host-unhealthy',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-opencode-host-unhealthy',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(false)
    if (!primaryResult.ok || bobResult.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(ensureSessionCalls).toBe(0)
    expect(mcpConnectCalls).toBe(0)
    expect(bobResult.error.message).toContain('OpenCode host failed health check')
    expect(bobResult.error.message).not.toContain(
      'was not found in the live provider catalog',
    )
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps primary Codex completed when OpenCode secondary has no connected providers', async () => {
    registeredMemberNames = new Set(['alice'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    let mcpConnectCalls = 0

    openCodeProvisioningProbe.probe = async () => ({
      ...openCodeSnapshot(),
      providers: {
        connected: [],
        default: {},
      },
    })
    ;(Client.prototype.connect as unknown as (...args: unknown[]) => Promise<void>) = async () => {
      mcpConnectCalls += 1
      throw new Error('MCP proof should not run without provider auth')
    }
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-opencode-no-providers',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-opencode-no-providers',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(false)
    if (!primaryResult.ok || bobResult.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(ensureSessionCalls).toBe(0)
    expect(mcpConnectCalls).toBe(0)
    expect(bobResult.error.message).toContain('No connected OpenCode providers found')
  }, SAFE_E2E_TIMEOUT_MS)

  test('retries OpenCode secondary launch after transient MCP tool visibility failure without relaunching Codex', async () => {
    registeredMemberNames = new Set(['alice', 'bob'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: Array<{ memberName: string; text: string }> = []
    let listToolsCalls = 0

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    ;(Client.prototype.listTools as unknown as (...args: unknown[]) => Promise<{ tools: Array<{ name: string }> }>) =
      async () => {
        listToolsCalls += 1
        if (listToolsCalls === 1) {
          return {
            tools: [
              { name: 'runtime_bootstrap_checkin' },
              { name: 'runtime_deliver_message' },
              { name: 'runtime_task_event' },
            ],
          }
        }
        return {
          tools: [
            { name: 'runtime_bootstrap_checkin' },
            { name: 'runtime_deliver_message' },
            { name: 'runtime_task_event' },
            { name: 'runtime_heartbeat' },
          ],
        }
      }
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
        runtimePid: 3602,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async (record, input) => {
      promptInputs.push({
        memberName: record.memberName,
        text: input.text,
      })
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: `msg-${record.memberName}-ready`,
        latestAssistantText: `${record.memberName} ready after MCP retry`,
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-opencode-mcp-retry',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const launchBody = {
      runId: 'run-mixed-opencode-mcp-retry',
      laneId: 'secondary:opencode:bob',
      teamId: 'team-a',
      teamName: 'atlas-hq',
      projectPath: '/tmp/project',
      selectedModel: 'minimax-m2.5-free',
      members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
    }
    const firstBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', launchBody),
    )
    const retriedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', launchBody),
    )

    expect(primaryResult.ok).toBe(true)
    expect(firstBobResult.ok).toBe(false)
    expect(retriedBobResult.ok).toBe(true)
    if (!primaryResult.ok || firstBobResult.ok || !retriedBobResult.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(firstBobResult.error.message).toContain('agent-teams_runtime_heartbeat')
    expect(listToolsCalls).toBe(2)
    expect(ensureInputs).toEqual([
      {
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        selectedModel: 'openrouter/minimax-m2.5-free',
      },
    ])
    expect(promptInputs).toEqual([
      { memberName: 'bob', text: 'Bob OpenCode join' },
    ])
    expect(retriedBobResult.data.teamLaunchState).toBe('ready')
    expect(retriedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(retriedBobResult.data.members.bob?.runtimePid).toBe(3602)
  }, SAFE_E2E_TIMEOUT_MS)

  test('rejects stale OpenCode secondary message after Codex primary bootstrap before prompting', async () => {
    registeredMemberNames = new Set(['alice', 'bob'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let getCalls = 0
    let promptCalls = 0
    let reconcileCalls = 0

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionStore.get = (async () => {
      getCalls += 1
      return buildRecord({
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        selectedModel: 'openrouter/minimax-m2.5-free',
        opencodeSessionId: 'session-bob',
        runtimePid: 3702,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.promptAsync = (async () => {
      promptCalls += 1
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => {
      reconcileCalls += 1
      return {
        record,
        summary: buildReconcileSummary({ sessionId: record.opencodeSessionId }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-stale-opencode-message',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.sendMessage', {
        runId: 'run-mixed-stale-opencode-message',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        projectPath: '/tmp/project',
        text: 'Deliver stale task to Bob',
        preconditions: {
          handshakeIdentityHash: 'handshake-1',
          laneId: 'secondary:opencode:jack',
          expectedRunId: 'run-mixed-stale-opencode-message',
          expectedCapabilitySnapshotId: null,
          expectedBehaviorFingerprint: null,
          expectedManifestHighWatermark: null,
          commandLeaseId: null,
          idempotencyKey: 'stale-message-lane',
        },
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(result.ok).toBe(false)
    if (!primaryResult.ok || result.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(result.error.message).toContain(
      'OpenCode bridge expected laneId precondition does not match command laneId',
    )
    expect(getCalls).toBe(0)
    expect(promptCalls).toBe(0)
    expect(reconcileCalls).toBe(0)
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps mixed launch in progress when OpenCode secondary has not confirmed bootstrap yet', async () => {
    registeredMemberNames = new Set(['alice', 'bob'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        latestAssistantMessageId: null,
        latestAssistantText: null,
        latestAssistantPreview: null,
        messageCount: 0,
        durableState: 'idle',
        messages: [],
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-opencode-pending',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-opencode-pending',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(bobResult.data.teamLaunchState).toBe('launching')
    expect(bobResult.data.members.bob?.launchState).toBe('created')
    expect(bobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )
  }, SAFE_E2E_TIMEOUT_MS)

  test('promotes a pending OpenCode secondary lane to ready on reconcile without relaunching Codex or OpenCode', async () => {
    registeredMemberNames = new Set(['alice', 'bob'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let storedBobRecord: OpenCodeSessionRecord | null = null
    let bobAssistantReady = false
    let ensureSessionCalls = 0
    let promptCalls = 0
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      storedBobRecord = buildRecord({
        teamId: input.teamId,
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
        runtimePid: 3102,
      })
      return storedBobRecord
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {
      promptCalls += 1
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionStore.get = (async () => storedBobRecord) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary: bobAssistantReady
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: 'msg-bob-ready-after-reopen',
            latestAssistantText: 'bob ready after reopen',
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
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-opencode-promote-after-reopen',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const initialBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-mixed-opencode-promote-after-reopen',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
      }),
    )
    bobAssistantReady = true
    const reconciledBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-opencode-promote-after-reopen',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(initialBobResult.ok).toBe(true)
    expect(reconciledBobResult.ok).toBe(true)
    if (!primaryResult.ok || !initialBobResult.ok || !reconciledBobResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(reconciledBobResult.data.teamLaunchState).toBe('ready')
    expect(reconciledBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(reconciledBobResult.data.members.bob?.runtimePid).toBe(3102)
    expect(ensureSessionCalls).toBe(1)
    expect(promptCalls).toBe(1)
    expect(reconciledMembers).toEqual(['bob', 'bob'])
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps OpenCode secondary joining after reopen when the expected session record is not available yet', async () => {
    registeredMemberNames = new Set(['alice', 'bob'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let reconcileCalls = 0

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionStore.get = (async () => null) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconcileCalls += 1
      return {
        record,
        summary: buildReconcileSummary({ sessionId: record.opencodeSessionId }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-opencode-missing-session-after-reopen',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const bobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-opencode-missing-session-after-reopen',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(bobResult.data.teamLaunchState).toBe('launching')
    expect(bobResult.data.members.bob).toBeUndefined()
    expect(bobResult.data.diagnostics).toContainEqual({
      code: 'member_session_missing',
      message: 'No stored OpenCode session for team-a/bob',
      severity: 'warning',
    })
    expect(bobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )
    expect(reconcileCalls).toBe(0)
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps mixed reopen partially joining when one OpenCode lane is missing and a sibling lane is ready', async () => {
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    const getInputs: Array<{ laneId: string; memberName: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getInputs.push({ laneId, memberName: resolvedMemberName })
      if (resolvedMemberName === 'bob') {
        return null
      }
      return buildRecord({
        laneId,
        memberName: resolvedMemberName,
        selectedModel: 'openrouter/ling-2.6-flash-free',
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid: 3303,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
          latestAssistantMessageId: `msg-${record.memberName}-ready`,
          latestAssistantText: `${record.memberName} ready after reopen`,
        }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-reopen-one-opencode-missing',
        members: [
          member('alice', 'codex', 'gpt-5.4-mini'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [bobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-one-opencode-missing',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-one-opencode-missing',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'jack', model: 'ling-2.6-flash-free' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(getInputs).toEqual([
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
      { laneId: 'secondary:opencode:jack', memberName: 'jack' },
    ])
    expect(reconciledMembers).toEqual(['jack'])
    expect(bobResult.data.teamLaunchState).toBe('launching')
    expect(bobResult.data.members.bob).toBeUndefined()
    expect(bobResult.data.diagnostics).toContainEqual({
      code: 'member_session_missing',
      message: 'No stored OpenCode session for team-a/bob',
      severity: 'warning',
    })
    expect(bobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )
    expect(jackResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.members.jack?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.jack?.runtimePid).toBe(3303)
    expect(jackResult.data.members.bob).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps Anthropic and Codex mixed reopen partially joining when one OpenCode lane is still launching and a sibling lane is ready', async () => {
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    const getInputs: Array<{ laneId: string; memberName: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getInputs.push({ laneId, memberName: resolvedMemberName })
      return buildRecord({
        laneId,
        memberName: resolvedMemberName,
        selectedModel:
          resolvedMemberName === 'bob'
            ? 'openrouter/minimax-m2.5-free'
            : 'openrouter/ling-2.6-flash-free',
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid: resolvedMemberName === 'bob' ? 3304 : 3305,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'idle',
              messages: [],
            })
            : buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: `msg-${record.memberName}-ready`,
              latestAssistantText: `${record.memberName} ready after reopen`,
            }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-reopen-anthropic-codex-one-opencode-launching',
        members: [
          member('alice', 'anthropic', 'claude-opus-4-6'),
          member('reviewer', 'codex', 'gpt-5.4-mini'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [bobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-codex-one-opencode-launching',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-codex-one-opencode-launching',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'jack', model: 'ling-2.6-flash-free' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(getInputs).toEqual([
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
      { laneId: 'secondary:opencode:jack', memberName: 'jack' },
    ])
    expect(reconciledMembers.sort()).toEqual(['bob', 'jack'])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(3304)
    expect(jackResult.data.teamLaunchState).toBe('launching')
    expect(jackResult.data.members.jack?.launchState).toBe('created')
    expect(jackResult.data.members.jack?.runtimePid).toBe(3305)
    expect(jackResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )
    expect(jackResult.data.members.bob).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps Anthropic-only reopen partially joining when one OpenCode lane is still launching and a sibling lane is ready', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    const getInputs: Array<{ laneId: string; memberName: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getInputs.push({ laneId, memberName: resolvedMemberName })
      return buildRecord({
        laneId,
        memberName: resolvedMemberName,
        selectedModel:
          resolvedMemberName === 'bob'
            ? 'openrouter/minimax-m2.5-free'
            : 'openrouter/ling-2.6-flash-free',
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid: resolvedMemberName === 'bob' ? 3334 : 3335,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'idle',
              messages: [],
            })
            : buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: `msg-${record.memberName}-ready`,
              latestAssistantText: `${record.memberName} ready after reopen`,
            }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-reopen-anthropic-one-opencode-launching',
        members: [
          member('alice', 'anthropic', 'claude-opus-4-6'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [bobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-one-opencode-launching',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-one-opencode-launching',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'jack', model: 'ling-2.6-flash-free' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(getInputs).toEqual([
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
      { laneId: 'secondary:opencode:jack', memberName: 'jack' },
    ])
    expect(reconciledMembers.sort()).toEqual(['bob', 'jack'])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(3334)
    expect(jackResult.data.teamLaunchState).toBe('launching')
    expect(jackResult.data.members.jack?.launchState).toBe('created')
    expect(jackResult.data.members.jack?.runtimePid).toBe(3335)
    expect(jackResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )
    expect(jackResult.data.members.bob).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps Anthropic-only reopen split when one OpenCode lane is permission-blocked and a sibling lane is ready', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    const getInputs: Array<{ laneId: string; memberName: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getInputs.push({ laneId, memberName: resolvedMemberName })
      return buildRecord({
        laneId,
        memberName: resolvedMemberName,
        selectedModel:
          resolvedMemberName === 'bob'
            ? 'openrouter/minimax-m2.5-free'
            : 'openrouter/ling-2.6-flash-free',
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid: resolvedMemberName === 'bob' ? 3336 : 3337,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-jack-shell'],
              diagnostics: ['jack waiting for OpenCode permission after reopen'],
              messages: [],
            })
            : buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: `msg-${record.memberName}-ready`,
              latestAssistantText: `${record.memberName} ready after reopen`,
            }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-reopen-anthropic-split-opencode-permission',
        members: [
          member('alice', 'anthropic', 'claude-opus-4-6'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [bobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-split-opencode-permission',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-split-opencode-permission',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'jack', model: 'ling-2.6-flash-free' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(getInputs).toEqual([
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
      { laneId: 'secondary:opencode:jack', memberName: 'jack' },
    ])
    expect(reconciledMembers.sort()).toEqual(['bob', 'jack'])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(3336)
    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(3337)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])
    expect(jackResult.data.members.bob).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps Anthropic-only reopen partially joining when one OpenCode lane is missing and a sibling lane is ready', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    const getInputs: Array<{ laneId: string; memberName: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getInputs.push({ laneId, memberName: resolvedMemberName })
      if (resolvedMemberName === 'bob') {
        return null
      }
      return buildRecord({
        laneId,
        memberName: resolvedMemberName,
        selectedModel: 'openrouter/ling-2.6-flash-free',
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid: 3338,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
          latestAssistantMessageId: `msg-${record.memberName}-ready`,
          latestAssistantText: `${record.memberName} ready after reopen`,
        }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-reopen-anthropic-one-opencode-missing',
        members: [
          member('alice', 'anthropic', 'claude-opus-4-6'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [bobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-one-opencode-missing',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-one-opencode-missing',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'jack', model: 'ling-2.6-flash-free' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(getInputs).toEqual([
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
      { laneId: 'secondary:opencode:jack', memberName: 'jack' },
    ])
    expect(reconciledMembers).toEqual(['jack'])
    expect(bobResult.data.teamLaunchState).toBe('launching')
    expect(bobResult.data.members.bob).toBeUndefined()
    expect(bobResult.data.diagnostics).toContainEqual({
      code: 'member_session_missing',
      message: 'No stored OpenCode session for team-a/bob',
      severity: 'warning',
    })
    expect(bobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )
    expect(jackResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.members.jack?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.jack?.runtimePid).toBe(3338)
    expect(jackResult.data.members.bob).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps Anthropic-only reopen isolated when OpenCode sibling lanes split across ready, launching, and permission-blocked', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'jack', 'tom'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    const getInputs: Array<{ laneId: string; memberName: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getInputs.push({ laneId, memberName: resolvedMemberName })
      return buildRecord({
        laneId,
        memberName: resolvedMemberName,
        selectedModel:
          resolvedMemberName === 'bob'
            ? 'openrouter/minimax-m2.5-free'
            : resolvedMemberName === 'jack'
              ? 'openrouter/ling-2.6-flash-free'
              : 'openrouter/nemotron-3-super-free',
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid:
          resolvedMemberName === 'bob'
            ? 3342
            : resolvedMemberName === 'jack'
              ? 3343
              : 3344,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'idle',
              messages: [],
            })
            : record.memberName === 'tom'
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: null,
                latestAssistantText: null,
                latestAssistantPreview: null,
                messageCount: 0,
                durableState: 'blocked',
                pendingPermissionRequestIds: ['perm-tom-shell'],
                diagnostics: ['tom waiting for OpenCode permission after reopen'],
                messages: [],
              })
              : buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: `msg-${record.memberName}-ready`,
                latestAssistantText: `${record.memberName} ready after reopen`,
              }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-reopen-anthropic-three-opencode-split',
        members: [
          member('alice', 'anthropic', 'claude-opus-4-6'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [bobResult, jackResult, tomResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-three-opencode-split',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-three-opencode-split',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'jack', model: 'ling-2.6-flash-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-three-opencode-split',
          laneId: 'secondary:opencode:tom',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'tom', model: 'nemotron-3-super-free' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(tomResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok || !tomResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(getInputs).toEqual([
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
      { laneId: 'secondary:opencode:jack', memberName: 'jack' },
      { laneId: 'secondary:opencode:tom', memberName: 'tom' },
    ])
    expect(reconciledMembers.sort()).toEqual(['bob', 'jack', 'tom'])

    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(3342)
    expect(bobResult.data.members.jack).toBeUndefined()
    expect(bobResult.data.members.tom).toBeUndefined()

    expect(jackResult.data.teamLaunchState).toBe('launching')
    expect(jackResult.data.members.jack?.launchState).toBe('created')
    expect(jackResult.data.members.jack?.runtimePid).toBe(3343)
    expect(jackResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )
    expect(jackResult.data.members.bob).toBeUndefined()
    expect(jackResult.data.members.tom).toBeUndefined()

    expect(tomResult.data.teamLaunchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.launchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.runtimePid).toBe(3344)
    expect(tomResult.data.members.tom?.pendingPermissionRequestIds).toEqual([
      'perm-tom-shell',
    ])
    expect(tomResult.data.members.bob).toBeUndefined()
    expect(tomResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps Anthropic-only reopen isolated when OpenCode sibling lanes split across missing, ready, and permission-blocked', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'jack', 'tom'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    const getInputs: Array<{ laneId: string; memberName: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getInputs.push({ laneId, memberName: resolvedMemberName })
      if (resolvedMemberName === 'bob') {
        return null
      }
      return buildRecord({
        laneId,
        memberName: resolvedMemberName,
        selectedModel:
          resolvedMemberName === 'jack'
            ? 'openrouter/ling-2.6-flash-free'
            : 'openrouter/nemotron-3-super-free',
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid: resolvedMemberName === 'jack' ? 3345 : 3346,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'tom'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-tom-shell'],
              diagnostics: ['tom waiting for OpenCode permission after reopen'],
              messages: [],
            })
            : buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: `msg-${record.memberName}-ready`,
              latestAssistantText: `${record.memberName} ready after reopen`,
            }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-reopen-anthropic-three-opencode-missing-split',
        members: [
          member('alice', 'anthropic', 'claude-opus-4-6'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [bobResult, jackResult, tomResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-three-opencode-missing-split',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-three-opencode-missing-split',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'jack', model: 'ling-2.6-flash-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-three-opencode-missing-split',
          laneId: 'secondary:opencode:tom',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'tom', model: 'nemotron-3-super-free' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(tomResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok || !tomResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(getInputs).toEqual([
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
      { laneId: 'secondary:opencode:jack', memberName: 'jack' },
      { laneId: 'secondary:opencode:tom', memberName: 'tom' },
    ])
    expect(reconciledMembers.sort()).toEqual(['jack', 'tom'])

    expect(bobResult.data.teamLaunchState).toBe('launching')
    expect(bobResult.data.members.bob).toBeUndefined()
    expect(bobResult.data.diagnostics).toContainEqual({
      code: 'member_session_missing',
      message: 'No stored OpenCode session for team-a/bob',
      severity: 'warning',
    })
    expect(bobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )
    expect(bobResult.data.members.jack).toBeUndefined()
    expect(bobResult.data.members.tom).toBeUndefined()

    expect(jackResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.members.jack?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.jack?.runtimePid).toBe(3345)
    expect(jackResult.data.members.bob).toBeUndefined()
    expect(jackResult.data.members.tom).toBeUndefined()

    expect(tomResult.data.teamLaunchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.launchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.runtimePid).toBe(3346)
    expect(tomResult.data.members.tom?.pendingPermissionRequestIds).toEqual([
      'perm-tom-shell',
    ])
    expect(tomResult.data.members.bob).toBeUndefined()
    expect(tomResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps Anthropic and Codex mixed reopen split when one OpenCode lane is permission-blocked and a sibling lane is ready', async () => {
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    const getInputs: Array<{ laneId: string; memberName: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getInputs.push({ laneId, memberName: resolvedMemberName })
      return buildRecord({
        laneId,
        memberName: resolvedMemberName,
        selectedModel:
          resolvedMemberName === 'bob'
            ? 'openrouter/minimax-m2.5-free'
            : 'openrouter/ling-2.6-flash-free',
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid: resolvedMemberName === 'bob' ? 3306 : 3307,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-jack-shell'],
              diagnostics: ['jack waiting for OpenCode permission after reopen'],
              messages: [],
            })
            : buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: `msg-${record.memberName}-ready`,
              latestAssistantText: `${record.memberName} ready after reopen`,
            }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-reopen-anthropic-codex-one-opencode-permission',
        members: [
          member('alice', 'anthropic', 'claude-opus-4-6'),
          member('reviewer', 'codex', 'gpt-5.4-mini'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [bobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-codex-one-opencode-permission',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-codex-one-opencode-permission',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'jack', model: 'ling-2.6-flash-free' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(getInputs).toEqual([
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
      { laneId: 'secondary:opencode:jack', memberName: 'jack' },
    ])
    expect(reconciledMembers.sort()).toEqual(['bob', 'jack'])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(3306)
    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(3307)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])
    expect(jackResult.data.members.bob).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps Anthropic and Gemini mixed reopen split when one OpenCode lane is permission-blocked and a sibling lane is ready', async () => {
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    const getInputs: Array<{ laneId: string; memberName: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getInputs.push({ laneId, memberName: resolvedMemberName })
      return buildRecord({
        laneId,
        memberName: resolvedMemberName,
        selectedModel:
          resolvedMemberName === 'bob'
            ? 'openrouter/minimax-m2.5-free'
            : 'openrouter/ling-2.6-flash-free',
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid: resolvedMemberName === 'bob' ? 3318 : 3319,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-jack-shell'],
              diagnostics: ['jack waiting for OpenCode permission after reopen'],
              messages: [],
            })
            : buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: `msg-${record.memberName}-ready`,
              latestAssistantText: `${record.memberName} ready after reopen`,
            }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-reopen-anthropic-gemini-one-opencode-permission',
        members: [
          member('alice', 'anthropic', 'claude-opus-4-6'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [bobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-gemini-one-opencode-permission',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-gemini-one-opencode-permission',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'jack', model: 'ling-2.6-flash-free' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(getInputs).toEqual([
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
      { laneId: 'secondary:opencode:jack', memberName: 'jack' },
    ])
    expect(reconciledMembers.sort()).toEqual(['bob', 'jack'])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(3318)
    expect(jackResult.data.teamLaunchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.launchState).toBe('permission_blocked')
    expect(jackResult.data.members.jack?.runtimePid).toBe(3319)
    expect(jackResult.data.members.jack?.pendingPermissionRequestIds).toEqual([
      'perm-jack-shell',
    ])
    expect(jackResult.data.members.bob).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps Anthropic and Gemini mixed reopen partially joining when one OpenCode lane is still launching and a sibling lane is ready', async () => {
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    const getInputs: Array<{ laneId: string; memberName: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getInputs.push({ laneId, memberName: resolvedMemberName })
      return buildRecord({
        laneId,
        memberName: resolvedMemberName,
        selectedModel:
          resolvedMemberName === 'bob'
            ? 'openrouter/minimax-m2.5-free'
            : 'openrouter/ling-2.6-flash-free',
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid: resolvedMemberName === 'bob' ? 3320 : 3321,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'idle',
              messages: [],
            })
            : buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: `msg-${record.memberName}-ready`,
              latestAssistantText: `${record.memberName} ready after reopen`,
            }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-reopen-anthropic-gemini-one-opencode-launching',
        members: [
          member('alice', 'anthropic', 'claude-opus-4-6'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [bobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-gemini-one-opencode-launching',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-gemini-one-opencode-launching',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'jack', model: 'ling-2.6-flash-free' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(getInputs).toEqual([
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
      { laneId: 'secondary:opencode:jack', memberName: 'jack' },
    ])
    expect(reconciledMembers.sort()).toEqual(['bob', 'jack'])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(3320)
    expect(jackResult.data.teamLaunchState).toBe('launching')
    expect(jackResult.data.members.jack?.launchState).toBe('created')
    expect(jackResult.data.members.jack?.runtimePid).toBe(3321)
    expect(jackResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )
    expect(jackResult.data.members.bob).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps Anthropic and Gemini mixed reopen partially joining when one OpenCode lane is missing and a sibling lane is ready', async () => {
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    const getInputs: Array<{ laneId: string; memberName: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getInputs.push({ laneId, memberName: resolvedMemberName })
      if (resolvedMemberName === 'bob') {
        return null
      }
      return buildRecord({
        laneId,
        memberName: resolvedMemberName,
        selectedModel: 'openrouter/ling-2.6-flash-free',
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid: 3322,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
          latestAssistantMessageId: `msg-${record.memberName}-ready`,
          latestAssistantText: `${record.memberName} ready after reopen`,
        }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-reopen-anthropic-gemini-one-opencode-missing',
        members: [
          member('alice', 'anthropic', 'claude-opus-4-6'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [bobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-gemini-one-opencode-missing',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-gemini-one-opencode-missing',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'jack', model: 'ling-2.6-flash-free' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(getInputs).toEqual([
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
      { laneId: 'secondary:opencode:jack', memberName: 'jack' },
    ])
    expect(reconciledMembers).toEqual(['jack'])
    expect(bobResult.data.teamLaunchState).toBe('launching')
    expect(bobResult.data.members.bob).toBeUndefined()
    expect(bobResult.data.diagnostics).toContainEqual({
      code: 'member_session_missing',
      message: 'No stored OpenCode session for team-a/bob',
      severity: 'warning',
    })
    expect(bobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )
    expect(jackResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.members.jack?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.jack?.runtimePid).toBe(3322)
    expect(jackResult.data.members.bob).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps Anthropic and Gemini mixed reopen isolated when OpenCode sibling lanes split across ready, launching, and permission-blocked', async () => {
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack', 'tom'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    const getInputs: Array<{ laneId: string; memberName: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getInputs.push({ laneId, memberName: resolvedMemberName })
      return buildRecord({
        laneId,
        memberName: resolvedMemberName,
        selectedModel:
          resolvedMemberName === 'bob'
            ? 'openrouter/minimax-m2.5-free'
            : resolvedMemberName === 'jack'
              ? 'openrouter/ling-2.6-flash-free'
              : 'openrouter/nemotron-3-super-free',
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid:
          resolvedMemberName === 'bob'
            ? 3323
            : resolvedMemberName === 'jack'
              ? 3324
              : 3325,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'idle',
              messages: [],
            })
            : record.memberName === 'tom'
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: null,
                latestAssistantText: null,
                latestAssistantPreview: null,
                messageCount: 0,
                durableState: 'blocked',
                pendingPermissionRequestIds: ['perm-tom-shell'],
                diagnostics: ['tom waiting for OpenCode permission after reopen'],
                messages: [],
              })
              : buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: `msg-${record.memberName}-ready`,
                latestAssistantText: `${record.memberName} ready after reopen`,
              }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-reopen-anthropic-gemini-three-opencode-split',
        members: [
          member('alice', 'anthropic', 'claude-opus-4-6'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [bobResult, jackResult, tomResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-gemini-three-opencode-split',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-gemini-three-opencode-split',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'jack', model: 'ling-2.6-flash-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-gemini-three-opencode-split',
          laneId: 'secondary:opencode:tom',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'tom', model: 'nemotron-3-super-free' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(tomResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok || !tomResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(getInputs).toEqual([
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
      { laneId: 'secondary:opencode:jack', memberName: 'jack' },
      { laneId: 'secondary:opencode:tom', memberName: 'tom' },
    ])
    expect(reconciledMembers.sort()).toEqual(['bob', 'jack', 'tom'])

    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(3323)
    expect(bobResult.data.members.jack).toBeUndefined()
    expect(bobResult.data.members.tom).toBeUndefined()

    expect(jackResult.data.teamLaunchState).toBe('launching')
    expect(jackResult.data.members.jack?.launchState).toBe('created')
    expect(jackResult.data.members.jack?.runtimePid).toBe(3324)
    expect(jackResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )
    expect(jackResult.data.members.bob).toBeUndefined()
    expect(jackResult.data.members.tom).toBeUndefined()

    expect(tomResult.data.teamLaunchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.launchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.runtimePid).toBe(3325)
    expect(tomResult.data.members.tom?.pendingPermissionRequestIds).toEqual([
      'perm-tom-shell',
    ])
    expect(tomResult.data.members.bob).toBeUndefined()
    expect(tomResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps Anthropic and Codex mixed reopen isolated when OpenCode sibling lanes split across ready, launching, and permission-blocked', async () => {
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack', 'tom'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    const getInputs: Array<{ laneId: string; memberName: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getInputs.push({ laneId, memberName: resolvedMemberName })
      return buildRecord({
        laneId,
        memberName: resolvedMemberName,
        selectedModel:
          resolvedMemberName === 'bob'
            ? 'openrouter/minimax-m2.5-free'
            : resolvedMemberName === 'jack'
              ? 'openrouter/ling-2.6-flash-free'
              : 'openrouter/nemotron-3-super-free',
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid:
          resolvedMemberName === 'bob'
            ? 3308
            : resolvedMemberName === 'jack'
              ? 3309
              : 3310,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'jack'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'idle',
              messages: [],
            })
            : record.memberName === 'tom'
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: null,
                latestAssistantText: null,
                latestAssistantPreview: null,
                messageCount: 0,
                durableState: 'blocked',
                pendingPermissionRequestIds: ['perm-tom-shell'],
                diagnostics: ['tom waiting for OpenCode permission after reopen'],
                messages: [],
              })
              : buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: `msg-${record.memberName}-ready`,
                latestAssistantText: `${record.memberName} ready after reopen`,
              }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-reopen-anthropic-codex-three-opencode-split',
        members: [
          member('alice', 'anthropic', 'claude-opus-4-6'),
          member('reviewer', 'codex', 'gpt-5.4-mini'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [bobResult, jackResult, tomResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-codex-three-opencode-split',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-codex-three-opencode-split',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'jack', model: 'ling-2.6-flash-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-codex-three-opencode-split',
          laneId: 'secondary:opencode:tom',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'tom', model: 'nemotron-3-super-free' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(tomResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok || !tomResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(getInputs).toEqual([
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
      { laneId: 'secondary:opencode:jack', memberName: 'jack' },
      { laneId: 'secondary:opencode:tom', memberName: 'tom' },
    ])
    expect(reconciledMembers.sort()).toEqual(['bob', 'jack', 'tom'])

    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(3308)
    expect(bobResult.data.members.jack).toBeUndefined()
    expect(bobResult.data.members.tom).toBeUndefined()

    expect(jackResult.data.teamLaunchState).toBe('launching')
    expect(jackResult.data.members.jack?.launchState).toBe('created')
    expect(jackResult.data.members.jack?.runtimePid).toBe(3309)
    expect(jackResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )
    expect(jackResult.data.members.bob).toBeUndefined()
    expect(jackResult.data.members.tom).toBeUndefined()

    expect(tomResult.data.teamLaunchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.launchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.runtimePid).toBe(3310)
    expect(tomResult.data.members.tom?.pendingPermissionRequestIds).toEqual([
      'perm-tom-shell',
    ])
    expect(tomResult.data.members.bob).toBeUndefined()
    expect(tomResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps Anthropic and Gemini mixed reopen isolated when OpenCode sibling lanes split across missing, ready, and permission-blocked', async () => {
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack', 'tom'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    const getInputs: Array<{ laneId: string; memberName: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getInputs.push({ laneId, memberName: resolvedMemberName })
      if (resolvedMemberName === 'bob') {
        return null
      }
      return buildRecord({
        laneId,
        memberName: resolvedMemberName,
        selectedModel:
          resolvedMemberName === 'jack'
            ? 'openrouter/ling-2.6-flash-free'
            : 'openrouter/nemotron-3-super-free',
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid: resolvedMemberName === 'jack' ? 3326 : 3327,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'tom'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-tom-shell'],
              diagnostics: ['tom waiting for OpenCode permission after reopen'],
              messages: [],
            })
            : buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: `msg-${record.memberName}-ready`,
              latestAssistantText: `${record.memberName} ready after reopen`,
            }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-reopen-anthropic-gemini-three-opencode-missing-split',
        members: [
          member('alice', 'anthropic', 'claude-opus-4-6'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [bobResult, jackResult, tomResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-gemini-three-opencode-missing-split',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-gemini-three-opencode-missing-split',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'jack', model: 'ling-2.6-flash-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-gemini-three-opencode-missing-split',
          laneId: 'secondary:opencode:tom',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'tom', model: 'nemotron-3-super-free' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(tomResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok || !tomResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(getInputs).toEqual([
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
      { laneId: 'secondary:opencode:jack', memberName: 'jack' },
      { laneId: 'secondary:opencode:tom', memberName: 'tom' },
    ])
    expect(reconciledMembers.sort()).toEqual(['jack', 'tom'])

    expect(bobResult.data.teamLaunchState).toBe('launching')
    expect(bobResult.data.members.bob).toBeUndefined()
    expect(bobResult.data.diagnostics).toContainEqual({
      code: 'member_session_missing',
      message: 'No stored OpenCode session for team-a/bob',
      severity: 'warning',
    })
    expect(bobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )
    expect(bobResult.data.members.jack).toBeUndefined()
    expect(bobResult.data.members.tom).toBeUndefined()

    expect(jackResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.members.jack?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.jack?.runtimePid).toBe(3326)
    expect(jackResult.data.members.bob).toBeUndefined()
    expect(jackResult.data.members.tom).toBeUndefined()

    expect(tomResult.data.teamLaunchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.launchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.runtimePid).toBe(3327)
    expect(tomResult.data.members.tom?.pendingPermissionRequestIds).toEqual([
      'perm-tom-shell',
    ])
    expect(tomResult.data.members.bob).toBeUndefined()
    expect(tomResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps Anthropic and Codex mixed reopen isolated when OpenCode sibling lanes split across missing, ready, and permission-blocked', async () => {
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack', 'tom'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    const getInputs: Array<{ laneId: string; memberName: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getInputs.push({ laneId, memberName: resolvedMemberName })
      if (resolvedMemberName === 'bob') {
        return null
      }
      return buildRecord({
        laneId,
        memberName: resolvedMemberName,
        selectedModel:
          resolvedMemberName === 'jack'
            ? 'openrouter/ling-2.6-flash-free'
            : 'openrouter/nemotron-3-super-free',
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid: resolvedMemberName === 'jack' ? 3311 : 3312,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'tom'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-tom-shell'],
              diagnostics: ['tom waiting for OpenCode permission after reopen'],
              messages: [],
            })
            : buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: `msg-${record.memberName}-ready`,
              latestAssistantText: `${record.memberName} ready after reopen`,
            }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-reopen-anthropic-codex-three-opencode-missing-split',
        members: [
          member('alice', 'anthropic', 'claude-opus-4-6'),
          member('reviewer', 'codex', 'gpt-5.4-mini'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [bobResult, jackResult, tomResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-codex-three-opencode-missing-split',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-codex-three-opencode-missing-split',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'jack', model: 'ling-2.6-flash-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-codex-three-opencode-missing-split',
          laneId: 'secondary:opencode:tom',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'tom', model: 'nemotron-3-super-free' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(tomResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok || !tomResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(getInputs).toEqual([
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
      { laneId: 'secondary:opencode:jack', memberName: 'jack' },
      { laneId: 'secondary:opencode:tom', memberName: 'tom' },
    ])
    expect(reconciledMembers.sort()).toEqual(['jack', 'tom'])

    expect(bobResult.data.teamLaunchState).toBe('launching')
    expect(bobResult.data.members.bob).toBeUndefined()
    expect(bobResult.data.diagnostics).toContainEqual({
      code: 'member_session_missing',
      message: 'No stored OpenCode session for team-a/bob',
      severity: 'warning',
    })
    expect(bobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )
    expect(bobResult.data.members.jack).toBeUndefined()
    expect(bobResult.data.members.tom).toBeUndefined()

    expect(jackResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.members.jack?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.jack?.runtimePid).toBe(3311)
    expect(jackResult.data.members.bob).toBeUndefined()
    expect(jackResult.data.members.tom).toBeUndefined()

    expect(tomResult.data.teamLaunchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.launchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.runtimePid).toBe(3312)
    expect(tomResult.data.members.tom?.pendingPermissionRequestIds).toEqual([
      'perm-tom-shell',
    ])
    expect(tomResult.data.members.bob).toBeUndefined()
    expect(tomResult.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('promotes a missing OpenCode sibling lane to ready after Anthropic and Gemini reopen without disturbing ready and permission-blocked siblings', async () => {
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack', 'tom'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    let bobSessionAvailable = false
    const getInputs: Array<{ laneId: string; memberName: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getInputs.push({ laneId, memberName: resolvedMemberName })
      if (resolvedMemberName === 'bob' && !bobSessionAvailable) {
        return null
      }
      return buildRecord({
        laneId,
        memberName: resolvedMemberName,
        selectedModel:
          resolvedMemberName === 'bob'
            ? 'openrouter/minimax-m2.5-free'
            : resolvedMemberName === 'jack'
              ? 'openrouter/ling-2.6-flash-free'
              : 'openrouter/nemotron-3-super-free',
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid:
          resolvedMemberName === 'bob'
            ? 3328
            : resolvedMemberName === 'jack'
              ? 3329
              : 3330,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'tom'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-tom-shell'],
              diagnostics: ['tom waiting for OpenCode permission after reopen'],
              messages: [],
            })
            : buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: `msg-${record.memberName}-ready`,
              latestAssistantText: `${record.memberName} ready after reopen`,
            }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-reopen-anthropic-gemini-promote-missing-opencode-lane',
        members: [
          member('alice', 'anthropic', 'claude-opus-4-6'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [initialBobResult, jackResult, tomResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-gemini-promote-missing-opencode-lane',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-gemini-promote-missing-opencode-lane',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'jack', model: 'ling-2.6-flash-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-gemini-promote-missing-opencode-lane',
          laneId: 'secondary:opencode:tom',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'tom', model: 'nemotron-3-super-free' }],
        }),
      ),
    ])
    bobSessionAvailable = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-reopen-anthropic-gemini-promote-missing-opencode-lane',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(tomResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (!primaryResult.ok || !initialBobResult.ok || !jackResult.ok || !tomResult.ok || !promotedBobResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(getInputs).toEqual([
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
      { laneId: 'secondary:opencode:jack', memberName: 'jack' },
      { laneId: 'secondary:opencode:tom', memberName: 'tom' },
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
    ])
    expect(reconciledMembers).toEqual(['jack', 'tom', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob).toBeUndefined()
    expect(initialBobResult.data.diagnostics).toContainEqual({
      code: 'member_session_missing',
      message: 'No stored OpenCode session for team-a/bob',
      severity: 'warning',
    })
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.members.jack?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.jack?.runtimePid).toBe(3329)

    expect(tomResult.data.teamLaunchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.launchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.runtimePid).toBe(3330)
    expect(tomResult.data.members.tom?.pendingPermissionRequestIds).toEqual([
      'perm-tom-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(3328)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
    expect(promotedBobResult.data.members.tom).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('promotes a missing OpenCode sibling lane to ready after reopen without disturbing ready and permission-blocked siblings', async () => {
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack', 'tom'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    let bobSessionAvailable = false
    const getInputs: Array<{ laneId: string; memberName: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getInputs.push({ laneId, memberName: resolvedMemberName })
      if (resolvedMemberName === 'bob' && !bobSessionAvailable) {
        return null
      }
      return buildRecord({
        laneId,
        memberName: resolvedMemberName,
        selectedModel:
          resolvedMemberName === 'bob'
            ? 'openrouter/minimax-m2.5-free'
            : resolvedMemberName === 'jack'
              ? 'openrouter/ling-2.6-flash-free'
              : 'openrouter/nemotron-3-super-free',
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid:
          resolvedMemberName === 'bob'
            ? 3313
            : resolvedMemberName === 'jack'
              ? 3314
              : 3315,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'tom'
            ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: null,
                latestAssistantText: null,
                latestAssistantPreview: null,
                messageCount: 0,
                durableState: 'blocked',
                pendingPermissionRequestIds: ['perm-tom-shell'],
                diagnostics: ['tom waiting for OpenCode permission after reopen'],
                messages: [],
              })
            : buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: `msg-${record.memberName}-ready`,
                latestAssistantText: `${record.memberName} ready after reopen`,
              }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-reopen-anthropic-codex-promote-missing-opencode-lane',
        members: [
          member('alice', 'anthropic', 'claude-opus-4-6'),
          member('reviewer', 'codex', 'gpt-5.4-mini'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [initialBobResult, jackResult, tomResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-codex-promote-missing-opencode-lane',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-codex-promote-missing-opencode-lane',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'jack', model: 'ling-2.6-flash-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-codex-promote-missing-opencode-lane',
          laneId: 'secondary:opencode:tom',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'tom', model: 'nemotron-3-super-free' }],
        }),
      ),
    ])
    bobSessionAvailable = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-reopen-anthropic-codex-promote-missing-opencode-lane',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(tomResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (!primaryResult.ok || !initialBobResult.ok || !jackResult.ok || !tomResult.ok || !promotedBobResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(getInputs).toEqual([
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
      { laneId: 'secondary:opencode:jack', memberName: 'jack' },
      { laneId: 'secondary:opencode:tom', memberName: 'tom' },
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
    ])
    expect(reconciledMembers).toEqual(['jack', 'tom', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob).toBeUndefined()
    expect(initialBobResult.data.diagnostics).toContainEqual({
      code: 'member_session_missing',
      message: 'No stored OpenCode session for team-a/bob',
      severity: 'warning',
    })
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.members.jack?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.jack?.runtimePid).toBe(3314)

    expect(tomResult.data.teamLaunchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.launchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.runtimePid).toBe(3315)
    expect(tomResult.data.members.tom?.pendingPermissionRequestIds).toEqual([
      'perm-tom-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(3313)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
    expect(promotedBobResult.data.members.tom).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('promotes a launching OpenCode sibling lane to ready after reopen without disturbing ready and permission-blocked siblings', async () => {
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack', 'tom'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    let bobAssistantReady = false
    const getInputs: Array<{ laneId: string; memberName: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getInputs.push({ laneId, memberName: resolvedMemberName })
      return buildRecord({
        laneId,
        memberName: resolvedMemberName,
        selectedModel:
          resolvedMemberName === 'bob'
            ? 'openrouter/minimax-m2.5-free'
            : resolvedMemberName === 'jack'
              ? 'openrouter/ling-2.6-flash-free'
              : 'openrouter/nemotron-3-super-free',
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid:
          resolvedMemberName === 'bob'
            ? 3316
            : resolvedMemberName === 'jack'
              ? 3317
              : 3318,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'bob' && !bobAssistantReady
            ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: null,
                latestAssistantText: null,
                latestAssistantPreview: null,
                messageCount: 0,
                durableState: 'idle',
                messages: [],
              })
            : record.memberName === 'tom'
              ? buildReconcileSummary({
                  sessionId: record.opencodeSessionId,
                  latestAssistantMessageId: null,
                  latestAssistantText: null,
                  latestAssistantPreview: null,
                  messageCount: 0,
                  durableState: 'blocked',
                  pendingPermissionRequestIds: ['perm-tom-shell'],
                  diagnostics: ['tom waiting for OpenCode permission after reopen'],
                  messages: [],
                })
              : buildReconcileSummary({
                  sessionId: record.opencodeSessionId,
                  latestAssistantMessageId: `msg-${record.memberName}-ready`,
                  latestAssistantText: `${record.memberName} ready after reopen`,
                }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-reopen-anthropic-codex-promote-launching-opencode-lane',
        members: [
          member('alice', 'anthropic', 'claude-opus-4-6'),
          member('reviewer', 'codex', 'gpt-5.4-mini'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [initialBobResult, jackResult, tomResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-codex-promote-launching-opencode-lane',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-codex-promote-launching-opencode-lane',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'jack', model: 'ling-2.6-flash-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-codex-promote-launching-opencode-lane',
          laneId: 'secondary:opencode:tom',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'tom', model: 'nemotron-3-super-free' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-reopen-anthropic-codex-promote-launching-opencode-lane',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(tomResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (!primaryResult.ok || !initialBobResult.ok || !jackResult.ok || !tomResult.ok || !promotedBobResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(getInputs).toEqual([
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
      { laneId: 'secondary:opencode:jack', memberName: 'jack' },
      { laneId: 'secondary:opencode:tom', memberName: 'tom' },
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
    ])
    expect(reconciledMembers.filter(memberName => memberName === 'bob')).toHaveLength(2)
    expect(reconciledMembers.filter(memberName => memberName === 'jack')).toHaveLength(1)
    expect(reconciledMembers.filter(memberName => memberName === 'tom')).toHaveLength(1)

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(3316)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.members.jack?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.jack?.runtimePid).toBe(3317)

    expect(tomResult.data.teamLaunchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.launchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.runtimePid).toBe(3318)
    expect(tomResult.data.members.tom?.pendingPermissionRequestIds).toEqual([
      'perm-tom-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(3316)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
    expect(promotedBobResult.data.members.tom).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('promotes a missing OpenCode sibling lane to ready after Anthropic-only reopen without disturbing ready and permission-blocked siblings', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'jack', 'tom'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    let bobSessionAvailable = false
    const getInputs: Array<{ laneId: string; memberName: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getInputs.push({ laneId, memberName: resolvedMemberName })
      if (resolvedMemberName === 'bob' && !bobSessionAvailable) {
        return null
      }
      return buildRecord({
        laneId,
        memberName: resolvedMemberName,
        selectedModel:
          resolvedMemberName === 'bob'
            ? 'openrouter/minimax-m2.5-free'
            : resolvedMemberName === 'jack'
              ? 'openrouter/ling-2.6-flash-free'
              : 'openrouter/nemotron-3-super-free',
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid:
          resolvedMemberName === 'bob'
            ? 3339
            : resolvedMemberName === 'jack'
              ? 3340
              : 3341,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'tom'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'blocked',
              pendingPermissionRequestIds: ['perm-tom-shell'],
              diagnostics: ['tom waiting for OpenCode permission after reopen'],
              messages: [],
            })
            : buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: `msg-${record.memberName}-ready`,
              latestAssistantText: `${record.memberName} ready after reopen`,
            }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-reopen-anthropic-promote-missing-opencode',
        members: [
          member('alice', 'anthropic', 'claude-opus-4-6'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [initialBobResult, jackResult, tomResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-promote-missing-opencode',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-promote-missing-opencode',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'jack', model: 'ling-2.6-flash-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-promote-missing-opencode',
          laneId: 'secondary:opencode:tom',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'tom', model: 'nemotron-3-super-free' }],
        }),
      ),
    ])
    bobSessionAvailable = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-reopen-anthropic-promote-missing-opencode',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(tomResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (
      !primaryResult.ok
      || !initialBobResult.ok
      || !jackResult.ok
      || !tomResult.ok
      || !promotedBobResult.ok
    ) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(getInputs).toEqual([
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
      { laneId: 'secondary:opencode:jack', memberName: 'jack' },
      { laneId: 'secondary:opencode:tom', memberName: 'tom' },
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
    ])
    expect(reconciledMembers).toEqual(['jack', 'tom', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob).toBeUndefined()
    expect(initialBobResult.data.diagnostics).toContainEqual({
      code: 'member_session_missing',
      message: 'No stored OpenCode session for team-a/bob',
      severity: 'warning',
    })
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.members.jack?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.jack?.runtimePid).toBe(3340)

    expect(tomResult.data.teamLaunchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.launchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.runtimePid).toBe(3341)
    expect(tomResult.data.members.tom?.pendingPermissionRequestIds).toEqual([
      'perm-tom-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(3339)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
    expect(promotedBobResult.data.members.tom).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('promotes a launching OpenCode sibling lane to ready after Anthropic-only reopen without disturbing ready and permission-blocked siblings', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'jack', 'tom'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    let bobAssistantReady = false
    const getInputs: Array<{ laneId: string; memberName: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getInputs.push({ laneId, memberName: resolvedMemberName })
      return buildRecord({
        laneId,
        memberName: resolvedMemberName,
        selectedModel:
          resolvedMemberName === 'bob'
            ? 'openrouter/minimax-m2.5-free'
            : resolvedMemberName === 'jack'
              ? 'openrouter/ling-2.6-flash-free'
              : 'openrouter/nemotron-3-super-free',
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid:
          resolvedMemberName === 'bob'
            ? 3345
            : resolvedMemberName === 'jack'
              ? 3346
              : 3347,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'bob' && !bobAssistantReady
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'idle',
              messages: [],
            })
            : record.memberName === 'tom'
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: null,
                latestAssistantText: null,
                latestAssistantPreview: null,
                messageCount: 0,
                durableState: 'blocked',
                pendingPermissionRequestIds: ['perm-tom-shell'],
                diagnostics: ['tom waiting for OpenCode permission after reopen'],
                messages: [],
              })
              : buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: `msg-${record.memberName}-ready`,
                latestAssistantText: `${record.memberName} ready after reopen`,
              }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-reopen-anthropic-promote-launching-opencode-lane',
        members: [
          member('alice', 'anthropic', 'claude-opus-4-6'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [initialBobResult, jackResult, tomResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-promote-launching-opencode-lane',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-promote-launching-opencode-lane',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'jack', model: 'ling-2.6-flash-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-promote-launching-opencode-lane',
          laneId: 'secondary:opencode:tom',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'tom', model: 'nemotron-3-super-free' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-reopen-anthropic-promote-launching-opencode-lane',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(tomResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (
      !primaryResult.ok
      || !initialBobResult.ok
      || !jackResult.ok
      || !tomResult.ok
      || !promotedBobResult.ok
    ) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(getInputs).toEqual([
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
      { laneId: 'secondary:opencode:jack', memberName: 'jack' },
      { laneId: 'secondary:opencode:tom', memberName: 'tom' },
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
    ])
    expect(reconciledMembers).toEqual(['bob', 'jack', 'tom', 'bob'])

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(3345)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.members.jack?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.jack?.runtimePid).toBe(3346)

    expect(tomResult.data.teamLaunchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.launchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.runtimePid).toBe(3347)
    expect(tomResult.data.members.tom?.pendingPermissionRequestIds).toEqual([
      'perm-tom-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(3345)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
    expect(promotedBobResult.data.members.tom).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('promotes a launching OpenCode sibling lane to ready after Anthropic and Gemini reopen without disturbing ready and permission-blocked siblings', async () => {
    registeredMemberNames = new Set(['alice', 'reviewer', 'bob', 'jack', 'tom'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    let bobAssistantReady = false
    const getInputs: Array<{ laneId: string; memberName: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionStore.get = (async (_teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getInputs.push({ laneId, memberName: resolvedMemberName })
      return buildRecord({
        laneId,
        memberName: resolvedMemberName,
        selectedModel:
          resolvedMemberName === 'bob'
            ? 'openrouter/minimax-m2.5-free'
            : resolvedMemberName === 'jack'
              ? 'openrouter/ling-2.6-flash-free'
              : 'openrouter/nemotron-3-super-free',
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid:
          resolvedMemberName === 'bob'
            ? 3331
            : resolvedMemberName === 'jack'
              ? 3332
              : 3333,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'bob' && !bobAssistantReady
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: null,
              latestAssistantText: null,
              latestAssistantPreview: null,
              messageCount: 0,
              durableState: 'idle',
              messages: [],
            })
            : record.memberName === 'tom'
              ? buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: null,
                latestAssistantText: null,
                latestAssistantPreview: null,
                messageCount: 0,
                durableState: 'blocked',
                pendingPermissionRequestIds: ['perm-tom-shell'],
                diagnostics: ['tom waiting for OpenCode permission after reopen'],
                messages: [],
              })
              : buildReconcileSummary({
                sessionId: record.opencodeSessionId,
                latestAssistantMessageId: `msg-${record.memberName}-ready`,
                latestAssistantText: `${record.memberName} ready after reopen`,
              }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-reopen-anthropic-gemini-promote-launching-opencode-lane',
        members: [
          member('alice', 'anthropic', 'claude-opus-4-6'),
          member('reviewer', 'gemini', 'gemini-2.5-flash'),
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [initialBobResult, jackResult, tomResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-gemini-promote-launching-opencode-lane',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-gemini-promote-launching-opencode-lane',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'jack', model: 'ling-2.6-flash-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reopen-anthropic-gemini-promote-launching-opencode-lane',
          laneId: 'secondary:opencode:tom',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'tom', model: 'nemotron-3-super-free' }],
        }),
      ),
    ])
    bobAssistantReady = true
    const promotedBobResult = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-reopen-anthropic-gemini-promote-launching-opencode-lane',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'minimax-m2.5-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(initialBobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(tomResult.ok).toBe(true)
    expect(promotedBobResult.ok).toBe(true)
    if (!primaryResult.ok || !initialBobResult.ok || !jackResult.ok || !tomResult.ok || !promotedBobResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice', 'reviewer'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(primaryResult.summary.failedMembers).toEqual([])
    expect(ensureSessionCalls).toBe(0)
    expect(getInputs).toEqual([
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
      { laneId: 'secondary:opencode:jack', memberName: 'jack' },
      { laneId: 'secondary:opencode:tom', memberName: 'tom' },
      { laneId: 'secondary:opencode:bob', memberName: 'bob' },
    ])
    expect(reconciledMembers.filter(memberName => memberName === 'bob')).toHaveLength(2)
    expect(reconciledMembers.filter(memberName => memberName === 'jack')).toHaveLength(1)
    expect(reconciledMembers.filter(memberName => memberName === 'tom')).toHaveLength(1)

    expect(initialBobResult.data.teamLaunchState).toBe('launching')
    expect(initialBobResult.data.members.bob?.launchState).toBe('created')
    expect(initialBobResult.data.members.bob?.runtimePid).toBe(3331)
    expect(initialBobResult.data.durableCheckpoints.map(checkpoint => checkpoint.name)).not.toContain(
      'run_ready',
    )

    expect(jackResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.members.jack?.launchState).toBe('confirmed_alive')
    expect(jackResult.data.members.jack?.runtimePid).toBe(3332)

    expect(tomResult.data.teamLaunchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.launchState).toBe('permission_blocked')
    expect(tomResult.data.members.tom?.runtimePid).toBe(3333)
    expect(tomResult.data.members.tom?.pendingPermissionRequestIds).toEqual([
      'perm-tom-shell',
    ])

    expect(promotedBobResult.data.teamLaunchState).toBe('ready')
    expect(promotedBobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(promotedBobResult.data.members.bob?.runtimePid).toBe(3331)
    expect(promotedBobResult.data.members.jack).toBeUndefined()
    expect(promotedBobResult.data.members.tom).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('launches multiple OpenCode secondary lanes concurrently after Codex primary bootstrap', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'jack', 'tom'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string; selectedModel: string }> = []
    const promptInputs: Array<{ memberName: string; text: string }> = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
        runtimePid:
          input.memberName === 'bob'
            ? 2502
            : input.memberName === 'jack'
              ? 2503
              : 2504,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async (record, input) => {
      promptInputs.push({
        memberName: record.memberName,
        text: input.text,
      })
    }) as typeof openCodeSessionBridge.promptAsync
    openCodeSessionBridge.reconcileSession = (async record => ({
      record,
      summary: buildReconcileSummary({
        sessionId: record.opencodeSessionId,
        latestAssistantMessageId: `msg-${record.memberName}-ready`,
        latestAssistantText: `${record.memberName} ready`,
      }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-concurrent-opencode',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [bobResult, jackResult, tomResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-concurrent-opencode',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-concurrent-opencode',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'openrouter/ling-2.6-flash-free',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-concurrent-opencode',
          laneId: 'secondary:opencode:tom',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'nemotron-3-super-free',
          members: [{ name: 'tom', role: 'Developer', prompt: 'Tom OpenCode join' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    expect(tomResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok || !tomResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(ensureInputs).toHaveLength(3)
    expect(ensureInputs).toContainEqual({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
      selectedModel: 'openrouter/minimax-m2.5-free',
    })
    expect(ensureInputs).toContainEqual({
      laneId: 'secondary:opencode:jack',
      memberName: 'jack',
      selectedModel: 'openrouter/ling-2.6-flash-free',
    })
    expect(ensureInputs).toContainEqual({
      laneId: 'secondary:opencode:tom',
      memberName: 'tom',
      selectedModel: 'openrouter/nemotron-3-super-free',
    })
    expect(promptInputs).toHaveLength(3)
    expect(promptInputs).toContainEqual({ memberName: 'bob', text: 'Bob OpenCode join' })
    expect(promptInputs).toContainEqual({ memberName: 'jack', text: 'Jack OpenCode join' })
    expect(promptInputs).toContainEqual({ memberName: 'tom', text: 'Tom OpenCode join' })
    expect(Object.keys(bobResult.data.members)).toEqual(['bob'])
    expect(Object.keys(jackResult.data.members)).toEqual(['jack'])
    expect(Object.keys(tomResult.data.members)).toEqual(['tom'])
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(jackResult.data.teamLaunchState).toBe('ready')
    expect(tomResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2502)
    expect(jackResult.data.members.jack?.runtimePid).toBe(2503)
    expect(tomResult.data.members.tom?.runtimePid).toBe(2504)
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps concurrent OpenCode secondary lane failures isolated after Codex primary bootstrap', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'tom'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const ensureInputs: Array<{ laneId: string; memberName: string }> = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureInputs.push({
        laneId: input.laneId,
        memberName: input.memberName,
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
      record,
      summary:
        record.memberName === 'bob'
          ? buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: null,
            latestAssistantText: null,
            latestAssistantPreview: null,
            messageCount: 0,
            durableState: 'blocked',
            pendingPermissionRequestIds: ['perm-bob'],
            diagnostics: ['bob waiting for OpenCode permission'],
            messages: [],
          })
          : buildReconcileSummary({
            sessionId: record.opencodeSessionId,
            latestAssistantMessageId: `msg-${record.memberName}-ready`,
            latestAssistantText: `${record.memberName} ready`,
          }),
    })) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-concurrent-opencode-isolation',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [bobResult, jackResult, tomResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-concurrent-opencode-isolation',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'minimax-m2.5-free',
          members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-concurrent-opencode-isolation',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'ghost-model',
          members: [{ name: 'jack', role: 'Reviewer', prompt: 'Jack OpenCode join' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.launchTeam', {
          runId: 'run-mixed-concurrent-opencode-isolation',
          laneId: 'secondary:opencode:tom',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          projectPath: '/tmp/project',
          selectedModel: 'nemotron-3-super-free',
          members: [{ name: 'tom', role: 'Developer', prompt: 'Tom OpenCode join' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(false)
    expect(tomResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || jackResult.ok || !tomResult.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(ensureInputs).toHaveLength(2)
    expect(ensureInputs).toContainEqual({
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
    })
    expect(ensureInputs).toContainEqual({
      laneId: 'secondary:opencode:tom',
      memberName: 'tom',
    })
    expect(bobResult.data.teamLaunchState).toBe('permission_blocked')
    expect(bobResult.data.members.bob?.pendingPermissionRequestIds).toEqual(['perm-bob'])
    expect(jackResult.error.message).toContain(
      'OpenCode raw model id "ghost-model" was not found in the live provider catalog',
    )
    expect(tomResult.data.teamLaunchState).toBe('ready')
    expect(tomResult.data.members.tom?.launchState).toBe('confirmed_alive')
    expect(tomResult.data.members.bob).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('reconciles OpenCode secondary lanes after Codex primary bootstrap without relaunching sessions', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const getInputs: Array<{ teamId: string; laneId: string; memberName: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionStore.get = (async (teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      getInputs.push({
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
        runtimePid: resolvedMemberName === 'jack' ? 2603 : 2602,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.ensureSession = (async input =>
      buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
      })) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.reconcileSession = (async record => {
      reconciledMembers.push(record.memberName)
      return {
        record,
        summary:
          record.memberName === 'bob'
            ? buildReconcileSummary({
              sessionId: record.opencodeSessionId,
              latestAssistantMessageId: 'msg-bob-ready',
              latestAssistantText: 'bob ready after reopen',
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
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-reconcile-after-reopen',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const [bobResult, jackResult] = await Promise.all([
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reconcile-after-reopen',
          laneId: 'secondary:opencode:bob',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'bob', model: 'openrouter/minimax-m2.5-free' }],
        }),
      ),
      executeOpenCodeBridgeCommandEnvelope(
        buildEnvelope('opencode.reconcileTeam', {
          runId: 'run-mixed-reconcile-after-reopen',
          laneId: 'secondary:opencode:jack',
          teamId: 'team-a',
          teamName: 'atlas-hq',
          expectedMembers: [{ name: 'jack', model: 'openrouter/ling-2.6-flash-free' }],
        }),
      ),
    ])

    expect(primaryResult.ok).toBe(true)
    expect(bobResult.ok).toBe(true)
    expect(jackResult.ok).toBe(true)
    if (!primaryResult.ok || !bobResult.ok || !jackResult.ok) {
      return
    }
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(getInputs).toHaveLength(2)
    expect(getInputs).toContainEqual({
      teamId: 'team-a',
      laneId: 'secondary:opencode:bob',
      memberName: 'bob',
    })
    expect(getInputs).toContainEqual({
      teamId: 'team-a',
      laneId: 'secondary:opencode:jack',
      memberName: 'jack',
    })
    expect(reconciledMembers).toEqual(expect.arrayContaining(['bob', 'jack']))
    expect(bobResult.data.teamLaunchState).toBe('ready')
    expect(bobResult.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(bobResult.data.members.bob?.runtimePid).toBe(2602)
    expect(jackResult.data.teamLaunchState).toBe('launching')
    expect(jackResult.data.members.jack?.launchState).toBe('created')
    expect(jackResult.data.members.bob).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('fails OpenCode secondary reconcile when the stored session model differs from the expected roster model', async () => {
    registeredMemberNames = new Set(['alice', 'bob'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let reconcileCalls = 0

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionStore.get = (async (teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return buildRecord({
        teamId,
        laneId,
        memberName: resolvedMemberName,
        selectedModel: 'openrouter/minimax-m2.5-free',
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid: 2902,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconcileCalls += 1
      return {
        record,
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
          latestAssistantMessageId: `msg-${record.memberName}-ready`,
          latestAssistantText: `${record.memberName} ready`,
        }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-model-mismatch-reconcile',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-model-mismatch-reconcile',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'openrouter/ling-2.6-flash-free' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(result.ok).toBe(true)
    if (!primaryResult.ok || !result.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(reconcileCalls).toBe(0)
    expect(result.data.teamLaunchState).toBe('failed')
    expect(result.data.members.bob?.launchState).toBe('failed')
    expect(result.data.members.bob?.runtimePid).toBe(2902)
    expect(result.data.members.bob?.diagnostics).toEqual([
      'Stored OpenCode session model "openrouter/minimax-m2.5-free" does not match expected model "openrouter/ling-2.6-flash-free".',
    ])
    expect(result.data.diagnostics).toContainEqual({
      code: 'member_model_mismatch',
      message:
        'bob: Stored OpenCode session model "openrouter/minimax-m2.5-free" does not match expected model "openrouter/ling-2.6-flash-free".',
      severity: 'error',
    })
  }, SAFE_E2E_TIMEOUT_MS)

  test('fails OpenCode secondary reconcile when the expected roster model is not in the live catalog', async () => {
    registeredMemberNames = new Set(['alice', 'bob'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let reconcileCalls = 0

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionStore.get = (async (teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      return buildRecord({
        teamId,
        laneId,
        memberName: resolvedMemberName,
        selectedModel: 'openrouter/minimax-m2.5-free',
        opencodeSessionId: `session-${resolvedMemberName}`,
        runtimePid: 2952,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconcileCalls += 1
      return {
        record,
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
          latestAssistantMessageId: `msg-${record.memberName}-ready`,
          latestAssistantText: `${record.memberName} ready`,
        }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-model-unavailable-reconcile',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-mixed-model-unavailable-reconcile',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'ghost-model' }],
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(result.ok).toBe(true)
    if (!primaryResult.ok || !result.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(reconcileCalls).toBe(0)
    expect(result.data.teamLaunchState).toBe('failed')
    expect(result.data.members.bob?.launchState).toBe('failed')
    expect(result.data.members.bob?.runtimePid).toBe(2952)
    expect(result.data.members.bob?.diagnostics).toEqual([
      'OpenCode raw model id "ghost-model" was not found in the live provider catalog',
    ])
    expect(result.data.diagnostics).toContainEqual({
      code: 'member_model_unavailable',
      message:
        'bob: OpenCode raw model id "ghost-model" was not found in the live provider catalog',
      severity: 'error',
    })
  }, SAFE_E2E_TIMEOUT_MS)

  test('answers one OpenCode secondary permission after Codex primary bootstrap without touching sibling lanes', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const answered: Array<{ memberName: string; requestId: string; decision: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionStore.get = (async (teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      if (resolvedMemberName !== 'bob') {
        return null
      }
      return buildRecord({
        teamId,
        laneId,
        memberName: resolvedMemberName,
        selectedModel: 'openrouter/minimax-m2.5-free',
        opencodeSessionId: 'session-bob',
        runtimePid: 2702,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionStore.list = (async () => [
      buildRecord({
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        selectedModel: 'openrouter/minimax-m2.5-free',
        opencodeSessionId: 'session-bob',
        runtimePid: 2702,
      }),
      buildRecord({
        laneId: 'secondary:opencode:jack',
        memberName: 'jack',
        selectedModel: 'openrouter/ling-2.6-flash-free',
        opencodeSessionId: 'session-jack',
        runtimePid: 2703,
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
        record,
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
          latestAssistantMessageId: `msg-${record.memberName}-ready`,
          latestAssistantText: `${record.memberName} ready`,
        }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-answer-permission',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.answerPermission', {
        runId: 'run-mixed-answer-permission',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        memberName: 'bob',
        requestId: 'perm-bob',
        decision: 'allow',
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(result.ok).toBe(true)
    if (!primaryResult.ok || !result.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(answered).toEqual([
      {
        memberName: 'bob',
        requestId: 'perm-bob',
        decision: 'allow',
      },
    ])
    expect(reconciledMembers).toEqual(['bob'])
    expect(result.data.teamLaunchState).toBe('ready')
    expect(Object.keys(result.data.members)).toEqual(['bob'])
    expect(result.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(result.data.members.bob?.runtimePid).toBe(2702)
    expect(result.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('answers one OpenCode secondary permission after Anthropic primary bootstrap without touching sibling lanes', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const answered: Array<{ memberName: string; requestId: string; decision: string }> = []
    const reconciledMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionStore.get = (async (teamId, laneIdOrMemberName, memberName) => {
      const laneId = memberName ? laneIdOrMemberName : 'primary'
      const resolvedMemberName = memberName ?? laneIdOrMemberName
      if (resolvedMemberName !== 'bob') {
        return null
      }
      return buildRecord({
        teamId,
        laneId,
        memberName: resolvedMemberName,
        selectedModel: 'openrouter/minimax-m2.5-free',
        opencodeSessionId: 'session-bob',
        runtimePid: 2708,
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionStore.list = (async () => [
      buildRecord({
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        selectedModel: 'openrouter/minimax-m2.5-free',
        opencodeSessionId: 'session-bob',
        runtimePid: 2708,
      }),
      buildRecord({
        laneId: 'secondary:opencode:jack',
        memberName: 'jack',
        selectedModel: 'openrouter/ling-2.6-flash-free',
        opencodeSessionId: 'session-jack',
        runtimePid: 2709,
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
        record,
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
          latestAssistantMessageId: `msg-${record.memberName}-ready`,
          latestAssistantText: `${record.memberName} ready`,
        }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-anthropic-answer-permission',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.answerPermission', {
        runId: 'run-mixed-anthropic-answer-permission',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        memberName: 'bob',
        requestId: 'perm-bob',
        decision: 'allow',
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(result.ok).toBe(true)
    if (!primaryResult.ok || !result.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
    ])
    expect(answered).toEqual([
      {
        memberName: 'bob',
        requestId: 'perm-bob',
        decision: 'allow',
      },
    ])
    expect(reconciledMembers).toEqual(['bob'])
    expect(result.data.teamLaunchState).toBe('ready')
    expect(Object.keys(result.data.members)).toEqual(['bob'])
    expect(result.data.members.bob?.launchState).toBe('confirmed_alive')
    expect(result.data.members.bob?.runtimePid).toBe(2708)
    expect(result.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('stops one OpenCode secondary lane after Codex primary bootstrap without touching sibling lanes', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const abortedMembers: string[] = []
    const releasedMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionStore.list = (async () => [
      buildRecord({
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        selectedModel: 'openrouter/minimax-m2.5-free',
        opencodeSessionId: 'session-bob',
      }),
      buildRecord({
        laneId: 'secondary:opencode:jack',
        memberName: 'jack',
        selectedModel: 'openrouter/ling-2.6-flash-free',
        opencodeSessionId: 'session-jack',
      }),
    ]) as typeof openCodeSessionStore.list
    openCodeSessionBridge.abort = (async record => {
      abortedMembers.push(record.memberName)
      return true
    }) as typeof openCodeSessionBridge.abort
    openCodeSessionBridge.releaseSession = (async record => {
      releasedMembers.push(record.memberName)
    }) as typeof openCodeSessionBridge.releaseSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-stop-secondary',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.stopTeam', {
        runId: 'run-mixed-stop-secondary',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(result.ok).toBe(true)
    if (!primaryResult.ok || !result.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(abortedMembers).toEqual(['bob'])
    expect(releasedMembers).toEqual(['bob'])
    expect(result.data.stopped).toBe(true)
    expect(Object.keys(result.data.members)).toEqual(['bob'])
    expect(result.data.members.bob).toEqual({
      sessionId: 'session-bob',
      stopped: true,
      diagnostics: [],
    })
    expect(result.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('stops one OpenCode secondary lane after Anthropic primary bootstrap without touching sibling lanes', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'jack'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const abortedMembers: string[] = []
    const releasedMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionStore.list = (async () => [
      buildRecord({
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        selectedModel: 'openrouter/minimax-m2.5-free',
        opencodeSessionId: 'session-bob',
      }),
      buildRecord({
        laneId: 'secondary:opencode:jack',
        memberName: 'jack',
        selectedModel: 'openrouter/ling-2.6-flash-free',
        opencodeSessionId: 'session-jack',
      }),
    ]) as typeof openCodeSessionStore.list
    openCodeSessionBridge.abort = (async record => {
      abortedMembers.push(record.memberName)
      return true
    }) as typeof openCodeSessionBridge.abort
    openCodeSessionBridge.releaseSession = (async record => {
      releasedMembers.push(record.memberName)
    }) as typeof openCodeSessionBridge.releaseSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-anthropic-stop-secondary',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.stopTeam', {
        runId: 'run-mixed-anthropic-stop-secondary',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(result.ok).toBe(true)
    if (!primaryResult.ok || !result.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
    ])
    expect(abortedMembers).toEqual(['bob'])
    expect(releasedMembers).toEqual(['bob'])
    expect(result.data.stopped).toBe(true)
    expect(Object.keys(result.data.members)).toEqual(['bob'])
    expect(result.data.members.bob).toEqual({
      sessionId: 'session-bob',
      stopped: true,
      diagnostics: [],
    })
    expect(result.data.members.jack).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps OpenCode secondary stop failures isolated after Codex primary bootstrap', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'tom'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const abortedMembers: string[] = []
    const releasedMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionStore.list = (async () => [
      buildRecord({
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        selectedModel: 'openrouter/minimax-m2.5-free',
        opencodeSessionId: 'session-bob',
      }),
      buildRecord({
        laneId: 'secondary:opencode:tom',
        memberName: 'tom',
        selectedModel: 'openrouter/nemotron-3-super-free',
        opencodeSessionId: 'session-tom',
      }),
    ]) as typeof openCodeSessionStore.list
    openCodeSessionBridge.abort = (async record => {
      abortedMembers.push(record.memberName)
      throw new Error('bob stop failed')
    }) as typeof openCodeSessionBridge.abort
    openCodeSessionBridge.releaseSession = (async record => {
      releasedMembers.push(record.memberName)
    }) as typeof openCodeSessionBridge.releaseSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-stop-secondary-failure',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.stopTeam', {
        runId: 'run-mixed-stop-secondary-failure',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(result.ok).toBe(true)
    if (!primaryResult.ok || !result.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(abortedMembers).toEqual(['bob'])
    expect(releasedMembers).toEqual([])
    expect(result.data.stopped).toBe(false)
    expect(Object.keys(result.data.members)).toEqual(['bob'])
    expect(result.data.members.bob).toEqual({
      sessionId: 'session-bob',
      stopped: false,
      diagnostics: ['bob stop failed'],
    })
    expect(result.data.members.tom).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('keeps OpenCode secondary stop failures isolated after Anthropic primary bootstrap', async () => {
    registeredMemberNames = new Set(['alice', 'bob', 'tom'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    const abortedMembers: string[] = []
    const releasedMembers: string[] = []

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionStore.list = (async () => [
      buildRecord({
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        selectedModel: 'openrouter/minimax-m2.5-free',
        opencodeSessionId: 'session-bob',
      }),
      buildRecord({
        laneId: 'secondary:opencode:tom',
        memberName: 'tom',
        selectedModel: 'openrouter/nemotron-3-super-free',
        opencodeSessionId: 'session-tom',
      }),
    ]) as typeof openCodeSessionStore.list
    openCodeSessionBridge.abort = (async record => {
      abortedMembers.push(record.memberName)
      throw new Error('bob stop failed')
    }) as typeof openCodeSessionBridge.abort
    openCodeSessionBridge.releaseSession = (async record => {
      releasedMembers.push(record.memberName)
    }) as typeof openCodeSessionBridge.releaseSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-mixed-anthropic-stop-secondary-failure',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.stopTeam', {
        runId: 'run-mixed-anthropic-stop-secondary-failure',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(result.ok).toBe(true)
    if (!primaryResult.ok || !result.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
    ])
    expect(abortedMembers).toEqual(['bob'])
    expect(releasedMembers).toEqual([])
    expect(result.data.stopped).toBe(false)
    expect(Object.keys(result.data.members)).toEqual(['bob'])
    expect(result.data.members.bob).toEqual({
      sessionId: 'session-bob',
      stopped: false,
      diagnostics: ['bob stop failed'],
    })
    expect(result.data.members.tom).toBeUndefined()
  }, SAFE_E2E_TIMEOUT_MS)

  test('rejects stale OpenCode secondary launch after Codex primary bootstrap before creating sessions', async () => {
    registeredMemberNames = new Set(['alice', 'bob'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    let promptCalls = 0

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {
      promptCalls += 1
    }) as typeof openCodeSessionBridge.promptAsync

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-current-launch-precondition',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-current-launch-precondition',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        preconditions: {
          handshakeIdentityHash: 'handshake-1',
          laneId: 'secondary:opencode:bob',
          expectedRunId: 'run-stale-launch-precondition',
          expectedCapabilitySnapshotId: null,
          expectedBehaviorFingerprint: null,
          expectedManifestHighWatermark: null,
          commandLeaseId: null,
          idempotencyKey: 'stale-launch-run',
        },
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(result.ok).toBe(false)
    if (!primaryResult.ok || result.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(spawnInputs.map(input => input.name)).toEqual(['alice'])
    expect(ensureSessionCalls).toBe(0)
    expect(promptCalls).toBe(0)
    expect(result.error.message).toContain(
      'OpenCode bridge expectedRunId precondition does not match command runId',
    )
  }, SAFE_E2E_TIMEOUT_MS)

  test('rejects stale OpenCode secondary launch after Anthropic primary bootstrap before creating sessions', async () => {
    registeredMemberNames = new Set(['alice', 'bob'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let ensureSessionCalls = 0
    let promptCalls = 0

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionBridge.ensureSession = (async input => {
      ensureSessionCalls += 1
      return buildRecord({
        laneId: input.laneId,
        memberName: input.memberName,
        selectedModel: input.selectedModel,
        opencodeSessionId: `session-${input.memberName}`,
      })
    }) as typeof openCodeSessionBridge.ensureSession
    openCodeSessionBridge.promptAsync = (async () => {
      promptCalls += 1
    }) as typeof openCodeSessionBridge.promptAsync

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-current-anthropic-launch-precondition',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.launchTeam', {
        runId: 'run-current-anthropic-launch-precondition',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        projectPath: '/tmp/project',
        selectedModel: 'minimax-m2.5-free',
        members: [{ name: 'bob', role: 'Developer', prompt: 'Bob OpenCode join' }],
        preconditions: {
          handshakeIdentityHash: 'handshake-1',
          laneId: 'secondary:opencode:bob',
          expectedRunId: 'run-stale-anthropic-launch-precondition',
          expectedCapabilitySnapshotId: null,
          expectedBehaviorFingerprint: null,
          expectedManifestHighWatermark: null,
          commandLeaseId: null,
          idempotencyKey: 'stale-anthropic-launch-run',
        },
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(result.ok).toBe(false)
    if (!primaryResult.ok || result.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
    ])
    expect(ensureSessionCalls).toBe(0)
    expect(promptCalls).toBe(0)
    expect(result.error.message).toContain(
      'OpenCode bridge expectedRunId precondition does not match command runId',
    )
  }, SAFE_E2E_TIMEOUT_MS)

  test('rejects stale OpenCode secondary reconcile after Codex primary bootstrap before reading sessions', async () => {
    registeredMemberNames = new Set(['alice', 'bob'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let getCalls = 0
    let reconcileCalls = 0

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionStore.get = (async () => {
      getCalls += 1
      return buildRecord({
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconcileCalls += 1
      return {
        record,
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
        }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-current-reconcile-precondition',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-current-reconcile-precondition',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'openrouter/minimax-m2.5-free' }],
        preconditions: {
          handshakeIdentityHash: 'handshake-1',
          laneId: 'secondary:opencode:jack',
          expectedRunId: 'run-current-reconcile-precondition',
          expectedCapabilitySnapshotId: null,
          expectedBehaviorFingerprint: null,
          expectedManifestHighWatermark: null,
          commandLeaseId: null,
          idempotencyKey: 'stale-reconcile-lane',
        },
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(result.ok).toBe(false)
    if (!primaryResult.ok || result.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(getCalls).toBe(0)
    expect(reconcileCalls).toBe(0)
    expect(result.error.message).toContain(
      'OpenCode bridge expected laneId precondition does not match command laneId',
    )
  }, SAFE_E2E_TIMEOUT_MS)

  test('rejects stale OpenCode secondary reconcile after Anthropic primary bootstrap before reading sessions', async () => {
    registeredMemberNames = new Set(['alice', 'bob'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let getCalls = 0
    let reconcileCalls = 0

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionStore.get = (async () => {
      getCalls += 1
      return buildRecord({
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
      })
    }) as typeof openCodeSessionStore.get
    openCodeSessionBridge.reconcileSession = (async record => {
      reconcileCalls += 1
      return {
        record,
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
        }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-current-anthropic-reconcile-precondition',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.reconcileTeam', {
        runId: 'run-current-anthropic-reconcile-precondition',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        expectedMembers: [{ name: 'bob', model: 'openrouter/minimax-m2.5-free' }],
        preconditions: {
          handshakeIdentityHash: 'handshake-1',
          laneId: 'secondary:opencode:jack',
          expectedRunId: 'run-current-anthropic-reconcile-precondition',
          expectedCapabilitySnapshotId: null,
          expectedBehaviorFingerprint: null,
          expectedManifestHighWatermark: null,
          commandLeaseId: null,
          idempotencyKey: 'stale-anthropic-reconcile-lane',
        },
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(result.ok).toBe(false)
    if (!primaryResult.ok || result.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
    ])
    expect(getCalls).toBe(0)
    expect(reconcileCalls).toBe(0)
    expect(result.error.message).toContain(
      'OpenCode bridge expected laneId precondition does not match command laneId',
    )
  }, SAFE_E2E_TIMEOUT_MS)

  test('rejects stale OpenCode secondary permission answer after Codex primary bootstrap before answering', async () => {
    registeredMemberNames = new Set(['alice', 'bob'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let getCalls = 0
    let listCalls = 0
    let answerCalls = 0
    let reconcileCalls = 0

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionStore.get = (async () => {
      getCalls += 1
      return buildRecord({
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        opencodeSessionId: 'session-bob',
      })
    }) as typeof openCodeSessionStore.get
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
    openCodeSessionBridge.answerPermission = (async () => {
      answerCalls += 1
    }) as typeof openCodeSessionBridge.answerPermission
    openCodeSessionBridge.reconcileSession = (async record => {
      reconcileCalls += 1
      return {
        record,
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
        }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-current-permission-precondition',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.answerPermission', {
        runId: 'run-current-permission-precondition',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        memberName: 'bob',
        requestId: 'perm-bob',
        decision: 'allow',
        preconditions: {
          handshakeIdentityHash: 'handshake-1',
          laneId: 'secondary:opencode:bob',
          expectedRunId: 'run-stale-permission-precondition',
          expectedCapabilitySnapshotId: null,
          expectedBehaviorFingerprint: null,
          expectedManifestHighWatermark: null,
          commandLeaseId: null,
          idempotencyKey: 'stale-permission-run',
        },
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(result.ok).toBe(false)
    if (!primaryResult.ok || result.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(getCalls).toBe(0)
    expect(listCalls).toBe(0)
    expect(answerCalls).toBe(0)
    expect(reconcileCalls).toBe(0)
    expect(result.error.message).toContain(
      'OpenCode bridge expectedRunId precondition does not match command runId',
    )
  }, SAFE_E2E_TIMEOUT_MS)

  test('rejects stale OpenCode secondary permission answer after Anthropic primary bootstrap before answering', async () => {
    registeredMemberNames = new Set(['alice', 'bob'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let getCalls = 0
    let listCalls = 0
    let answerCalls = 0
    let reconcileCalls = 0

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
    openCodeSessionStore.get = (async () => {
      getCalls += 1
      return buildRecord({
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        opencodeSessionId: 'session-bob',
      })
    }) as typeof openCodeSessionStore.get
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
    openCodeSessionBridge.answerPermission = (async () => {
      answerCalls += 1
    }) as typeof openCodeSessionBridge.answerPermission
    openCodeSessionBridge.reconcileSession = (async record => {
      reconcileCalls += 1
      return {
        record,
        summary: buildReconcileSummary({
          sessionId: record.opencodeSessionId,
        }),
      }
    }) as typeof openCodeSessionBridge.reconcileSession

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-current-anthropic-permission-precondition',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.answerPermission', {
        runId: 'run-current-anthropic-permission-precondition',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        memberName: 'bob',
        requestId: 'perm-bob',
        decision: 'allow',
        preconditions: {
          handshakeIdentityHash: 'handshake-1',
          laneId: 'secondary:opencode:bob',
          expectedRunId: 'run-stale-anthropic-permission-precondition',
          expectedCapabilitySnapshotId: null,
          expectedBehaviorFingerprint: null,
          expectedManifestHighWatermark: null,
          commandLeaseId: null,
          idempotencyKey: 'stale-anthropic-permission-run',
        },
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(result.ok).toBe(false)
    if (!primaryResult.ok || result.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
    ])
    expect(getCalls).toBe(0)
    expect(listCalls).toBe(0)
    expect(answerCalls).toBe(0)
    expect(reconcileCalls).toBe(0)
    expect(result.error.message).toContain(
      'OpenCode bridge expectedRunId precondition does not match command runId',
    )
  }, SAFE_E2E_TIMEOUT_MS)

  test('rejects stale OpenCode secondary stop after Codex primary bootstrap before listing sessions', async () => {
    registeredMemberNames = new Set(['alice', 'bob'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let listCalls = 0
    let abortCalls = 0

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
    openCodeSessionBridge.abort = (async () => {
      abortCalls += 1
      return true
    }) as typeof openCodeSessionBridge.abort

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-current-stop-precondition',
        members: [member('alice', 'codex', 'gpt-5.4-mini')],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.stopTeam', {
        runId: 'run-current-stop-precondition',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        preconditions: {
          handshakeIdentityHash: 'handshake-1',
          laneId: 'secondary:opencode:bob',
          expectedRunId: 'run-stale-stop-precondition',
          expectedCapabilitySnapshotId: null,
          expectedBehaviorFingerprint: null,
          expectedManifestHighWatermark: null,
          commandLeaseId: null,
          idempotencyKey: 'stale-stop-run',
        },
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(result.ok).toBe(false)
    if (!primaryResult.ok || result.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(listCalls).toBe(0)
    expect(abortCalls).toBe(0)
    expect(result.error.message).toContain(
      'OpenCode bridge expectedRunId precondition does not match command runId',
    )
  }, SAFE_E2E_TIMEOUT_MS)

  test('rejects stale OpenCode secondary stop after Anthropic primary bootstrap before listing sessions', async () => {
    registeredMemberNames = new Set(['alice', 'bob'])
    const { runTeamBootstrap } = await import('./teamBootstrapRunner.js')
    const events = createProgressEventSink()
    let listCalls = 0
    let abortCalls = 0

    openCodeProvisioningProbe.probe = async () => openCodeSnapshot()
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
    openCodeSessionBridge.abort = (async () => {
      abortCalls += 1
      return true
    }) as typeof openCodeSessionBridge.abort

    const primaryResult = await runTeamBootstrap({
      request: request({
        runId: 'run-current-anthropic-stop-precondition',
        members: [
          {
            ...member('alice', 'anthropic', 'claude-opus-4-6'),
            effort: 'high',
          },
        ],
      }),
      context: attachedContext('atlas-hq'),
      emit: events.emit,
    })
    const result = await executeOpenCodeBridgeCommandEnvelope(
      buildEnvelope('opencode.stopTeam', {
        runId: 'run-current-anthropic-stop-precondition',
        laneId: 'secondary:opencode:bob',
        teamId: 'team-a',
        teamName: 'atlas-hq',
        preconditions: {
          handshakeIdentityHash: 'handshake-1',
          laneId: 'secondary:opencode:bob',
          expectedRunId: 'run-stale-anthropic-stop-precondition',
          expectedCapabilitySnapshotId: null,
          expectedBehaviorFingerprint: null,
          expectedManifestHighWatermark: null,
          commandLeaseId: null,
          idempotencyKey: 'stale-anthropic-stop-run',
        },
      }),
    )

    expect(primaryResult.ok).toBe(true)
    expect(result.ok).toBe(false)
    if (!primaryResult.ok || result.ok) {
      return
    }
    expect(primaryResult.summary.terminalStatus).toBe('completed')
    expect(spawnInputs).toMatchObject([
      {
        name: 'alice',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'high',
      },
    ])
    expect(listCalls).toBe(0)
    expect(abortCalls).toBe(0)
    expect(result.error.message).toContain(
      'OpenCode bridge expectedRunId precondition does not match command runId',
    )
  }, SAFE_E2E_TIMEOUT_MS)
})

function request(
  overrides: Partial<TeamBootstrapRequest> = {},
): TeamBootstrapRequest {
  const members = overrides.members ?? [member('alice', 'codex', 'gpt-5.4-mini')]
  return {
    version: 1,
    runId: 'run-mixed-opencode-handoff',
    requestHash: `hash-${Math.random().toString(36).slice(2)}`,
    mode: 'launch',
    teamName: 'atlas-hq',
    cwd: process.cwd(),
    bootstrapTimeoutMs: 5_000,
    continueOnPartialFailure: true,
    permissionSeedTools: [],
    emitStructuredEvents: true,
    policy: {
      persistentTeam: true,
      registerForSessionCleanup: false,
      writeConversationSummaryMessage: false,
    },
    initiator: {
      kind: 'app',
      source: 'claude_team_agent_teams_orchestrator',
    },
    ...overrides,
    members,
  }
}

function member(
  name: string,
  provider: 'anthropic' | 'codex' | 'gemini',
  model: string,
): TeamBootstrapRequest['members'][number] {
  return {
    originalName: name,
    displayName: name,
    normalizedName: name,
    prompt: `${name} bootstrap`,
    provider,
    model,
  }
}

function attachedContext(teamName: string) {
  let state = {
    teamContext: {
      teamName,
      teamFilePath: '/tmp/atlas-hq/config.json',
      leadAgentId: 'team-lead@atlas-hq',
      teammates: {},
    },
  }
  return {
    getAppState: () => state,
    setAppState: (updater: (previous: typeof state) => typeof state) => {
      state = updater(state)
    },
  } as never
}

function detachedContext() {
  let state = {
    teamContext: undefined,
  }
  return {
    getAppState: () => state,
    setAppState: (updater: (previous: typeof state) => typeof state) => {
      state = updater(state)
    },
  } as never
}

function createProgressEventSink() {
  const items: Array<Record<string, unknown>> = []
  const completedEvents: Array<{
    status: string
    expectedMembers?: string[]
    registeredMembers?: string[]
    failedMembers?: Array<{ name: string; reason: string }>
  }> = []
  return {
    items,
    completedEvents,
    emit: {
      started: async (members: string[]) => {
        items.push({ type: 'started', members })
      },
      phaseChanged: async (phase: string) => {
        items.push({ type: 'phase', phase })
      },
      teamCreated: async (reusedExistingTeam: boolean) => {
        items.push({ type: 'team_created', reusedExistingTeam })
      },
      memberSpawnStarted: async (memberName: string) => {
        items.push({ type: 'member_spawn_started', memberName })
      },
      memberSpawnResult: async (event: Record<string, unknown>) => {
        items.push({ type: 'member_spawn_result', ...event })
      },
      completed: async (event: {
        status: string
        expectedMembers?: string[]
        registeredMembers?: string[]
        failedMembers?: Array<{ name: string; reason: string }>
      }) => {
        items.push({ type: 'completed', status: event.status })
        completedEvents.push(event)
      },
      failed: async (reason: string) => {
        items.push({ type: 'failed', reason })
      },
    },
  }
}

function buildEnvelope(command: string, body: Record<string, unknown>) {
  return {
    schemaVersion: 1 as const,
    requestId: `req-${command}`,
    command,
    cwd: '/tmp/project',
    startedAt: '2026-04-22T12:00:00.000Z',
    timeoutMs: 30_000,
    body,
  }
}

function openCodeSnapshot(): OpenCodeProvisioningSnapshot {
  return {
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
      pid: 2200,
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
