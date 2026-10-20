import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  resetStateForTests,
  setIsInteractive,
} from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AppState } from '../../state/AppState.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'

describe('spawnTeammate partial in-process spawn cleanup', () => {
  const IN_PROCESS_CLEANUP_E2E_TIMEOUT_MS = 60_000
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  const originalRuntimeReadyTimeout =
    process.env.CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS
  const originalInboxPollerReadyTimeout =
    process.env.CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS
  let tempConfigDir: string

  beforeEach(async () => {
    resetStateForTests()
    setIsInteractive(true)
    tempConfigDir = await mkdtemp(join(tmpdir(), 'spawn-multi-agent-test-'))
    process.env.CLAUDE_CONFIG_DIR = tempConfigDir
  })

  afterEach(async () => {
    resetStateForTests()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    if (originalRuntimeReadyTimeout === undefined) {
      delete process.env.CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS
    } else {
      process.env.CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS =
        originalRuntimeReadyTimeout
    }
    if (originalInboxPollerReadyTimeout === undefined) {
      delete process.env.CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS
    } else {
      process.env.CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS =
        originalInboxPollerReadyTimeout
    }
    await rm(tempConfigDir, { recursive: true, force: true })
  })

  it(
    'uses process readiness timeout overrides when provided',
    async () => {
      const spawnModulePath = new URL(
        `./spawnMultiAgent.ts?runtimeReadyTimeoutTest=${Date.now()}`,
        import.meta.url,
      ).href
      const { __getProcessReadinessTimeoutsForTests } =
        await import(spawnModulePath)

      process.env.CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS = '90000'
      process.env.CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS = '30000'
      expect(__getProcessReadinessTimeoutsForTests()).toEqual({
        runtimeReadyMs: 90_000,
        inboxPollerReadyMs: 30_000,
      })

      process.env.CLAUDE_TEAM_PROCESS_RUNTIME_READY_TIMEOUT_MS = 'not-a-number'
      process.env.CLAUDE_TEAM_PROCESS_INBOX_POLLER_READY_TIMEOUT_MS = 'not-a-number'
      expect(__getProcessReadinessTimeoutsForTests()).toEqual({
        runtimeReadyMs: 90_000,
        inboxPollerReadyMs: 30_000,
      })
    },
    20_000,
  )

  it(
    'cleans up the registered in-process task if durable registration fails after spawn',
    async () => {
      const spawnModulePath = new URL(
        `./spawnMultiAgent.ts?spawnMultiAgentCleanupTest=${Date.now()}`,
        import.meta.url,
      ).href
      const { spawnTeammate, __setSpawnMultiAgentDepsForTests } =
        await import(spawnModulePath)
      __setSpawnMultiAgentDepsForTests({
        isInProcessEnabled: () => true,
      })

      let appState = {
        abortController: new AbortController(),
        messages: [],
        tasks: {},
        mainLoopModel: null,
        toolPermissionContext: getEmptyToolPermissionContext(),
        inbox: { messages: [] },
        teamContext: undefined,
      } as unknown as AppState

      const toolUseContext = {
        options: {
          commands: [],
          debug: false,
          mainLoopModel: 'test-model',
          tools: [],
          verbose: false,
          thinkingConfig: { type: 'disabled' as const },
          mcpClients: [],
          mcpResources: {},
          isNonInteractiveSession: false,
          agentDefinitions: { activeAgents: [], definitions: [], errors: [] },
        },
        abortController: new AbortController(),
        toolUseId: 'tool-use-1',
        readFileState: new Map(),
        getAppState: () => appState,
        setAppState: (updater: (prev: AppState) => AppState) => {
          appState = updater(appState)
        },
      } as unknown as ToolUseContext

      try {
        await expect(
          spawnTeammate(
            {
              name: 'alice',
              prompt: 'Bootstrap and wait for work',
              team_name: 'atlas-hq',
            },
            toolUseContext,
          ),
        ).rejects.toThrow(
          'Team "atlas-hq" does not exist. Call spawnTeam first to create the team.',
        )
      } finally {
        __setSpawnMultiAgentDepsForTests(null)
      }

      const taskEntries = Object.values(appState.tasks)
      expect(taskEntries).toHaveLength(1)
      expect(taskEntries[0]).toMatchObject({
        type: 'in_process_teammate',
        status: 'killed',
      })

      expect(appState.teamContext?.teammates).not.toHaveProperty(
        'alice@atlas-hq',
      )
      expect(appState.teamContext?.teammates).toHaveProperty(
        'team-lead@atlas-hq',
      )
    },
    IN_PROCESS_CLEANUP_E2E_TIMEOUT_MS,
  )

  it(
    'rejects per-member spawn customizations in the in-process lane',
    async () => {
      const spawnModulePath = new URL(
        `./spawnMultiAgent.ts?inProcessCustomizationTest=${Date.now()}`,
        import.meta.url,
      ).href
      const {
        spawnTeammate,
        getInProcessSpawnCustomizationRejection,
        __setSpawnMultiAgentDepsForTests,
      } = await import(spawnModulePath)
      __setSpawnMultiAgentDepsForTests({
        isInProcessEnabled: () => true,
      })

      let appState = {
        abortController: new AbortController(),
        messages: [],
        tasks: {},
        mainLoopModel: null,
        toolPermissionContext: getEmptyToolPermissionContext(),
        inbox: { messages: [] },
        teamContext: undefined,
      } as unknown as AppState

      const toolUseContext = {
        options: {
          commands: [],
          debug: false,
          mainLoopModel: 'test-model',
          tools: [],
          verbose: false,
          thinkingConfig: { type: 'disabled' as const },
          mcpClients: [],
          mcpResources: {},
          isNonInteractiveSession: false,
          agentDefinitions: { activeAgents: [], definitions: [], errors: [] },
        },
        abortController: new AbortController(),
        toolUseId: 'tool-use-2',
        readFileState: new Map(),
        getAppState: () => appState,
        setAppState: (updater: (prev: AppState) => AppState) => {
          appState = updater(appState)
        },
      } as unknown as ToolUseContext

      try {
        await expect(
          spawnTeammate(
            {
              name: 'alice',
              prompt: 'Bootstrap and wait for work',
              team_name: 'atlas-hq',
              env: { ANTHROPIC_AUTH_TOKEN: 'member-token-literal' },
              gatewayUsageRef: 'gateway-run-123',
            },
            toolUseContext,
          ),
        ).rejects.toThrow('per-member spawn customizations')

        await expect(
          spawnTeammate(
            {
              name: 'bob',
              prompt: 'Bootstrap and wait for work',
              team_name: 'atlas-hq',
              codex: {
                configOverrides: ['model_provider="agent_teams_custom"'],
                forcedLoginMethod: 'api',
              },
            },
            toolUseContext,
          ),
        ).rejects.toThrow('per-member spawn customizations')

        let fallbackMutations = 0
        const previousForceProcess = process.env.CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES
        process.env.CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES = '0'
        __setSpawnMultiAgentDepsForTests({
          isInProcessEnabled: () => false,
          getTeammateModeFromSnapshot: () => 'auto',
          detectAndGetBackend: async () => { throw new Error('test pane backend unavailable') },
          markInProcessFallback: () => { fallbackMutations++ },
        })
        try {
          await expect(spawnTeammate({
            name: 'gateway-fallback',
            team_name: 'atlas-hq',
            prompt: 'Wait for work',
            gatewayUsageRef: 'gateway-run-123',
          }, toolUseContext)).rejects.toThrow('per-member spawn customizations')
          expect(fallbackMutations).toBe(0)
        } finally {
          if (previousForceProcess === undefined) delete process.env.CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES
          else process.env.CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES = previousForceProcess
        }

        // Members without per-member customizations pass the guard.
        expect(
          getInProcessSpawnCustomizationRejection({
            name: 'carol',
          }),
        ).toBeNull()
      } finally {
        __setSpawnMultiAgentDepsForTests(null)
      }
    },
    20_000,
  )
})
