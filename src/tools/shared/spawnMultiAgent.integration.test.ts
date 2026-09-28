import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  resetStateForTests,
  setIsInteractive,
} from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AppState } from '../../state/AppState.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  claimTeamMemberForSpawn,
  getTeamDir,
  readTeamFileAsync,
  type TeamMember,
  updateTeamFileAsync,
  writeTeamFileAsync,
} from '../../utils/swarm/teamHelpers.js'

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
    'treats a durable spawn:pending claim as owned and never enters the runtime handler',
    async () => {
      await mkdir(getTeamDir('atlas-hq'), { recursive: true })
      await writeTeamFileAsync('atlas-hq', {
        name: 'atlas-hq', createdAt: 0, leadAgentId: 'team-lead@atlas-hq',
        members: [{
          agentId: 'alice@atlas-hq', name: 'alice', joinedAt: 1,
          tmuxPaneId: 'spawn:pending:claim-a', cwd: '/tmp/project', subscriptions: [],
          spawnClaimToken: 'claim-a', spawnClaimRunId: 'run-a',
          spawnClaimOwnerPid: process.pid,
        }],
      })
      const { spawnTeammate, __setSpawnMultiAgentDepsForTests } =
        await import(new URL(`./spawnMultiAgent.ts?pendingClaimTest=${Date.now()}`, import.meta.url).href)
      __setSpawnMultiAgentDepsForTests({
        isInProcessEnabled: () => {
          throw new Error('runtime handler must not be reached')
        },
      })
      const appState = {
        tasks: {}, mainLoopModel: null, teamContext: undefined,
      } as unknown as AppState
      const context = {
        getAppState: () => appState,
      } as unknown as ToolUseContext
      try {
        const result = await spawnTeammate({
          name: 'ALICE', prompt: 'duplicate', team_name: 'atlas-hq',
        }, context)
        expect(result.data).toMatchObject({
          status: 'duplicate_skipped', reason: 'bootstrap_pending', spawned: false,
        })
      } finally {
        __setSpawnMultiAgentDepsForTests(null)
      }
    },
    IN_PROCESS_CLEANUP_E2E_TIMEOUT_MS,
  )

  it('recovers only an unarmed spawn claim whose exact owner process is gone', async () => {
    const { __isRecoverableUnarmedSpawnClaimForTests } =
      await import(new URL(`./spawnMultiAgent.ts?orphanClaimTest=${Date.now()}`, import.meta.url).href)
    const baseMember = {
      agentId: 'alice@atlas-hq', name: 'alice', joinedAt: Date.now(),
      tmuxPaneId: 'spawn:pending:claim-a', cwd: '/tmp/project', subscriptions: [],
      spawnClaimToken: 'claim-a', spawnClaimRunId: 'run-a',
    }

    expect(await __isRecoverableUnarmedSpawnClaimForTests({
      ...baseMember,
      spawnClaimOwnerPid: 2147483647,
      spawnClaimOwnerStartedAtMs: 1,
    })).toBe(true)
    expect(await __isRecoverableUnarmedSpawnClaimForTests({
      ...baseMember,
      spawnClaimOwnerPid: process.pid,
    })).toBe(false)
    expect(await __isRecoverableUnarmedSpawnClaimForTests({
      ...baseMember,
      spawnClaimOwnerPid: 2147483647,
      spawnClaimRuntimeMayExist: true,
    })).toBe(false)
    expect(await __isRecoverableUnarmedSpawnClaimForTests(baseMember)).toBe(false)
  })

  it('keeps the durable claim unarmed until the runtime-specific handler boundary', async () => {
    await mkdir(getTeamDir('atlas-hq'), { recursive: true })
    await writeTeamFileAsync('atlas-hq', {
      name: 'atlas-hq', createdAt: 0, leadAgentId: 'team-lead@atlas-hq', members: [],
    })
    const { spawnTeammate, __setSpawnMultiAgentDepsForTests } =
      await import(new URL(`./spawnMultiAgent.ts?preHandlerCrashTest=${Date.now()}`, import.meta.url).href)
    let observedClaim: Record<string, unknown> | undefined
    __setSpawnMultiAgentDepsForTests({
      beforeHandleSpawn: async () => {
        const persisted = JSON.parse(await Bun.file(join(getTeamDir('atlas-hq'), 'config.json')).text())
        observedClaim = persisted.members[0]
        throw new Error('simulated crash before runtime handler')
      },
    })
    const appState = { tasks: {}, mainLoopModel: null, teamContext: undefined } as unknown as AppState
    const context = { getAppState: () => appState } as unknown as ToolUseContext
    try {
      await expect(spawnTeammate({
        name: 'alice', prompt: 'fixture', team_name: 'atlas-hq',
      }, context)).rejects.toThrow('simulated crash before runtime handler')
      expect(observedClaim).toMatchObject({
        tmuxPaneId: expect.stringContaining('spawn:pending:'),
      })
      expect(observedClaim?.spawnClaimRuntimeMayExist).toBeUndefined()
    } finally {
      __setSpawnMultiAgentDepsForTests(null)
    }
  })

  it('arms an owned claim before replacing it with a native process reservation', async () => {
    const teamName = 'atlas-hq'
    const agentId = 'alice@atlas-hq'
    const claimToken = 'process-claim-a'
    await mkdir(getTeamDir(teamName), { recursive: true })
    await writeTeamFileAsync(teamName, {
      name: teamName, createdAt: 0, leadAgentId: 'team-lead@atlas-hq', members: [],
    })
    expect(await claimTeamMemberForSpawn(teamName, {
      agentId, name: 'alice', joinedAt: Date.now(),
      tmuxPaneId: `spawn:pending:${claimToken}`,
      cwd: tempConfigDir, subscriptions: [],
      spawnClaimToken: claimToken, spawnClaimRunId: 'process-run-a',
      spawnClaimOwnerPid: process.pid,
    })).toBe(true)

    const { __handleSpawnNativeProcessForTests, __setSpawnMultiAgentDepsForTests } =
      await import(new URL(`./spawnMultiAgent.ts?processClaimTest=${Date.now()}`, import.meta.url).href)
    let reservationAtLaunch: TeamMember | undefined
    __setSpawnMultiAgentDepsForTests({
      beforeNativeProcessLaunch: async () => {
        reservationAtLaunch = (await readTeamFileAsync(teamName))?.members.find(member => member.agentId === agentId)
        throw new Error('stop before fixture process launch')
      },
    })
    let appState = {
      tasks: {}, mainLoopModel: null, teamContext: undefined,
      toolPermissionContext: getEmptyToolPermissionContext(),
    } as unknown as AppState
    const context = {
      getAppState: () => appState,
      setAppState: (updater: (previous: AppState) => AppState) => {
        appState = updater(appState)
      },
    } as unknown as ToolUseContext

    try {
      await expect(__handleSpawnNativeProcessForTests({
        name: 'alice', prompt: 'fixture', team_name: teamName,
        cwd: tempConfigDir, provider: 'codex',
        bootstrapRunId: 'process-run-a', spawnClaimToken: claimToken,
      }, context)).rejects.toThrow('stop before fixture process launch')
      expect(reservationAtLaunch).toMatchObject({
        agentId, spawnClaimToken: claimToken,
        spawnClaimRuntimeMayExist: true,
        backendType: 'process',
        tmuxPaneId: expect.stringContaining('process:pending:'),
        processOwnerToken: expect.any(String),
      })
      expect((await readTeamFileAsync(teamName))?.members).toHaveLength(0)
    } finally {
      __setSpawnMultiAgentDepsForTests(null)
    }
  })

  it('does not launch a native process after another owner replaces its reservation', async () => {
    const teamName = 'atlas-hq'
    const agentId = 'alice@atlas-hq'
    const claimToken = 'process-claim-a'
    await mkdir(getTeamDir(teamName), { recursive: true })
    await writeTeamFileAsync(teamName, {
      name: teamName, createdAt: 0, leadAgentId: 'team-lead@atlas-hq', members: [],
    })
    expect(await claimTeamMemberForSpawn(teamName, {
      agentId, name: 'alice', joinedAt: Date.now(),
      tmuxPaneId: `spawn:pending:${claimToken}`,
      cwd: tempConfigDir, subscriptions: [],
      spawnClaimToken: claimToken, spawnClaimRunId: 'process-run-a',
      spawnClaimOwnerPid: process.pid,
    })).toBe(true)

    const { __handleSpawnNativeProcessForTests, __setSpawnMultiAgentDepsForTests } =
      await import(new URL(`./spawnMultiAgent.ts?processOwnerLossTest=${Date.now()}`, import.meta.url).href)
    let replacedAtLaunch = false
    __setSpawnMultiAgentDepsForTests({
      beforeNativeProcessLaunch: async () => {
        await updateTeamFileAsync(teamName, teamFile => ({
          changed: true,
          teamFile: {
            ...teamFile,
            members: teamFile.members.map(member => member.agentId === agentId ? {
              ...member,
              tmuxPaneId: 'process:pending:successor-owner',
              processOwnerToken: 'successor-owner',
              processRunId: 'successor-run',
              spawnClaimToken: 'successor-claim',
            } : member),
          },
        }))
        replacedAtLaunch = true
      },
    })
    let appState = {
      tasks: {}, mainLoopModel: null, teamContext: undefined,
      toolPermissionContext: getEmptyToolPermissionContext(),
    } as unknown as AppState
    const context = {
      getAppState: () => appState,
      setAppState: (updater: (previous: AppState) => AppState) => {
        appState = updater(appState)
      },
    } as unknown as ToolUseContext

    try {
      await expect(__handleSpawnNativeProcessForTests({
        name: 'alice', prompt: 'fixture', team_name: teamName,
        cwd: tempConfigDir, provider: 'codex',
        bootstrapRunId: 'process-run-a', spawnClaimToken: claimToken,
      }, context)).rejects.toThrow('lost its durable spawn claim before process launch')
      expect(replacedAtLaunch).toBe(true)
      expect((await readTeamFileAsync(teamName))?.members[0]).toMatchObject({
        agentId, spawnClaimToken: 'successor-claim',
        processOwnerToken: 'successor-owner',
        tmuxPaneId: 'process:pending:successor-owner',
      })
    } finally {
      __setSpawnMultiAgentDepsForTests(null)
    }
  })

  it('arms before pane creation and persists the exact pane before later handler work', async () => {
    await mkdir(getTeamDir('atlas-hq'), { recursive: true })
    await writeTeamFileAsync('atlas-hq', {
      name: 'atlas-hq', createdAt: 0, leadAgentId: 'team-lead@atlas-hq', members: [],
    })
    const { spawnTeammate, __setSpawnMultiAgentDepsForTests } =
      await import(new URL(`./spawnMultiAgent.ts?paneBoundaryCrashTest=${Date.now()}`, import.meta.url).href)
    let claimAtCreate: Record<string, unknown> | undefined
    __setSpawnMultiAgentDepsForTests({
      isInProcessEnabled: () => false,
      getTeammateModeFromSnapshot: () => 'tmux',
      detectAndGetBackend: async () => ({
        backend: {
          type: 'tmux', displayName: 'fixture', supportsHideShow: true,
          killPane: async () => true,
        },
        isNative: false,
      } as never),
      createTeammatePaneInSwarmView: async (_name, _color, onCreated) => {
        const persisted = JSON.parse(await Bun.file(join(getTeamDir('atlas-hq'), 'config.json')).text())
        claimAtCreate = persisted.members[0]
        await onCreated?.('%fixture-pane')
        return { paneId: '%fixture-pane', isFirstTeammate: false }
      },
      afterPaneCreated: async () => { throw new Error('simulated crash after exact pane publication') },
    })
    const appState = {
      tasks: {}, mainLoopModel: null, teamContext: undefined,
      toolPermissionContext: getEmptyToolPermissionContext(),
    } as unknown as AppState
    const context = {
      getAppState: () => appState,
      setAppState: () => undefined,
    } as unknown as ToolUseContext
    try {
      await expect(spawnTeammate({
        name: 'alice', prompt: 'fixture', team_name: 'atlas-hq', use_splitpane: true,
      }, context)).rejects.toThrow('simulated crash after exact pane publication')
      expect(claimAtCreate).toMatchObject({
        tmuxPaneId: expect.stringContaining('spawn:pending:'),
        spawnClaimRuntimeMayExist: true,
      })
      const persisted = JSON.parse(await Bun.file(join(getTeamDir('atlas-hq'), 'config.json')).text())
      expect(persisted.members[0]).toMatchObject({
        tmuxPaneId: '%fixture-pane', backendType: 'tmux',
        spawnClaimRuntimeMayExist: true,
      })
    } finally {
      __setSpawnMultiAgentDepsForTests(null)
    }
  })

  it('arms before separate-window creation and persists its exact pane before later work', async () => {
    await mkdir(getTeamDir('atlas-hq'), { recursive: true })
    await writeTeamFileAsync('atlas-hq', {
      name: 'atlas-hq', createdAt: 0, leadAgentId: 'team-lead@atlas-hq', members: [],
    })
    const { spawnTeammate, __setSpawnMultiAgentDepsForTests } =
      await import(new URL(`./spawnMultiAgent.ts?windowBoundaryCrashTest=${Date.now()}`, import.meta.url).href)
    let claimAtCreate: Record<string, unknown> | undefined
    __setSpawnMultiAgentDepsForTests({
      isInProcessEnabled: () => false,
      getTeammateModeFromSnapshot: () => 'tmux',
      detectAndGetBackend: async () => ({ backend: { type: 'tmux' }, isNative: false } as never),
      ensureSession: async () => undefined,
      createSeparateWindow: async () => {
        const persisted = JSON.parse(await Bun.file(join(getTeamDir('atlas-hq'), 'config.json')).text())
        claimAtCreate = persisted.members[0]
        return { code: 0, stdout: '%fixture-window\n', stderr: '', signal: null }
      },
      afterPaneCreated: async () => { throw new Error('simulated crash after exact window publication') },
    })
    const appState = {
      tasks: {}, mainLoopModel: null, teamContext: undefined,
      toolPermissionContext: getEmptyToolPermissionContext(),
    } as unknown as AppState
    const context = {
      getAppState: () => appState,
      setAppState: () => undefined,
    } as unknown as ToolUseContext
    try {
      await expect(spawnTeammate({
        name: 'alice', prompt: 'fixture', team_name: 'atlas-hq', use_splitpane: false,
      }, context)).rejects.toThrow('simulated crash after exact window publication')
      expect(claimAtCreate).toMatchObject({ spawnClaimRuntimeMayExist: true })
      const persisted = JSON.parse(await Bun.file(join(getTeamDir('atlas-hq'), 'config.json')).text())
      expect(persisted.members[0]).toMatchObject({
        tmuxPaneId: '%fixture-window', backendType: 'tmux', spawnClaimRuntimeMayExist: true,
      })
    } finally {
      __setSpawnMultiAgentDepsForTests(null)
    }
  })

  it(
    'cleans up the registered in-process task if final claim publication fails',
    async () => {
      const spawnModulePath = new URL(
        `./spawnMultiAgent.ts?spawnMultiAgentCleanupTest=${Date.now()}`,
        import.meta.url,
      ).href
      const { spawnTeammate, __setSpawnMultiAgentDepsForTests } =
        await import(spawnModulePath)
      await mkdir(getTeamDir('atlas-hq'), { recursive: true })
      await writeTeamFileAsync('atlas-hq', {
        name: 'atlas-hq', createdAt: 0, leadAgentId: 'team-lead@atlas-hq', members: [],
      })
      __setSpawnMultiAgentDepsForTests({
        isInProcessEnabled: () => true,
        finalizeTeamMemberSpawnClaim: async () => false,
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
          'lost its durable spawn claim before execution',
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
