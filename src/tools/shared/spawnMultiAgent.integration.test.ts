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
    await rm(tempConfigDir, { recursive: true, force: true })
  })

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
})
