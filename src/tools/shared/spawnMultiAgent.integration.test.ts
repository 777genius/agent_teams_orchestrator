import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
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
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  let tempConfigDir: string

  beforeEach(async () => {
    resetStateForTests()
    setIsInteractive(true)
    tempConfigDir = await mkdtemp(join(tmpdir(), 'spawn-multi-agent-test-'))
    process.env.CLAUDE_CONFIG_DIR = tempConfigDir
    mock.restore()
    mock.clearAllMocks()
  })

  afterEach(async () => {
    resetStateForTests()
    mock.restore()
    mock.clearAllMocks()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    await rm(tempConfigDir, { recursive: true, force: true })
  })

  it('cleans up the registered in-process task if durable registration fails after spawn', async () => {
    const registryModulePath = new URL(
      '../../utils/swarm/backends/registry.js',
      import.meta.url,
    ).href
    const registryModule = await import(registryModulePath)
    mock.module(registryModulePath, () => ({
      ...registryModule,
      isInProcessEnabled: () => true,
    }))

    const teamHelpersModulePath = new URL(
      '../../utils/swarm/teamHelpers.js',
      import.meta.url,
    ).href
    const teamHelpersModule = await import(teamHelpersModulePath)
    mock.module(teamHelpersModulePath, () => ({
      ...teamHelpersModule,
      updateTeamFileAsync: async () => ({ status: 'missing' as const, teamFile: null }),
    }))

    const spawnModulePath = new URL('./spawnMultiAgent.js', import.meta.url).href
    const { spawnTeammate } = await import(spawnModulePath)

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

    await expect(
      spawnTeammate(
        {
          name: 'alice',
          prompt: 'Bootstrap and wait for work',
          team_name: 'atlas-hq',
        },
        toolUseContext,
      ),
    ).rejects.toThrow('Team "atlas-hq" does not exist. Call spawnTeam first to create the team.')

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
  })
})
