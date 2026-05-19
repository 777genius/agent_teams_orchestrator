import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import {
  __setTeamBootstrapRunnerDepsForTests,
  assertBootstrapTimeoutBudget,
  assertBootstrapRuntimeWorkspace,
  deriveBootstrapTerminalStatus,
  emitBootstrapProgressSafely,
  runTeamBootstrap,
  shouldCreateTeamForBootstrap,
} from './teamBootstrapRunner.js'
import {
  getTeammateRuntimePaths,
  writeTeammateRuntimeEvent,
} from 'src/utils/swarm/teammateRuntimeEvents.js'

let tempDirs: string[] = []
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR

afterEach(async () => {
  await Promise.all(
    tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })),
  )
  tempDirs = []
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
  }
  __setTeamBootstrapRunnerDepsForTests(null)
})

describe('team bootstrap partial-failure policy', () => {
  test('returns completed when no members failed', () => {
    expect(
      deriveBootstrapTerminalStatus({
        continueOnPartialFailure: false,
        failedMembersCount: 0,
        registeredMembersCount: 0,
      }),
    ).toBe('completed')
  })

  test('returns partial_success when partial failures are allowed and at least one teammate registered', () => {
    expect(
      deriveBootstrapTerminalStatus({
        continueOnPartialFailure: true,
        failedMembersCount: 1,
        registeredMembersCount: 1,
      }),
    ).toBe('partial_success')
  })

  test('returns failed when every teammate failed even if partial failures are allowed', () => {
    expect(
      deriveBootstrapTerminalStatus({
        continueOnPartialFailure: true,
        failedMembersCount: 2,
        registeredMembersCount: 0,
      }),
    ).toBe('failed')
  })

  test('returns failed when partial failures are not allowed', () => {
    expect(
      deriveBootstrapTerminalStatus({
        continueOnPartialFailure: false,
        failedMembersCount: 2,
        registeredMembersCount: 1,
      }),
    ).toBe('failed')
  })
})

describe('team bootstrap create-vs-launch policy', () => {
  test('creates missing team during create mode', () => {
    expect(
      shouldCreateTeamForBootstrap({
        mode: 'create',
        attachState: 'missing',
        teamName: 'atlas-hq',
      }),
    ).toBe(true)
  })

  test('does not create team when already attached', () => {
    expect(
      shouldCreateTeamForBootstrap({
        mode: 'launch',
        attachState: 'attached_existing',
        teamName: 'atlas-hq',
      }),
    ).toBe(false)
  })

  test('throws when launch mode cannot find team config', () => {
    expect(() =>
      shouldCreateTeamForBootstrap({
        mode: 'launch',
        attachState: 'missing',
        teamName: 'atlas-hq',
      }),
    ).toThrow(
      'Deterministic bootstrap cannot launch team "atlas-hq" because the team config does not exist.',
    )
  })
})

describe('team bootstrap workspace safety', () => {
  test('accepts the current runtime workspace when it matches the request', async () => {
    const cwd = process.cwd()
    await expect(
      assertBootstrapRuntimeWorkspace({
        teamName: 'atlas-hq',
        cwd,
      }),
    ).resolves.toBeUndefined()
  })

  test('rejects bootstrap when requested workspace differs from runtime cwd', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-cwd-'))
    tempDirs.push(tempDir)
    await expect(
      assertBootstrapRuntimeWorkspace({
        teamName: 'atlas-hq',
        cwd: tempDir,
      }),
    ).rejects.toThrow(
      `Deterministic bootstrap cannot start team "atlas-hq" because the runtime workspace "${process.cwd()}" does not match the requested workspace "${tempDir}".`,
    )
  })

  test('includes stage context when workspace drift is detected mid-bootstrap', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-cwd-'))
    tempDirs.push(tempDir)
    await expect(
      assertBootstrapRuntimeWorkspace(
        {
          teamName: 'atlas-hq',
          cwd: tempDir,
        },
        'before spawning teammate "alice"',
      ),
    ).rejects.toThrow(
      `Deterministic bootstrap cannot start team "atlas-hq" before spawning teammate "alice" because the runtime workspace "${process.cwd()}" does not match the requested workspace "${tempDir}".`,
    )
  })
})

describe('team bootstrap early-failure durability', () => {
  test('persists terminal failure when onInitialized throws after state init', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-run-'))
    tempDirs.push(tempDir)
    process.env.CLAUDE_CONFIG_DIR = tempDir
    const teamName = `team-${Date.now()}`
    const result = await runTeamBootstrap({
      request: {
        version: 1,
        runId: 'run-1',
        requestHash: 'hash-1',
        mode: 'create',
        teamName,
        cwd: process.cwd(),
        members: [
          {
            originalName: 'alice',
            displayName: 'alice',
            normalizedName: 'alice',
            prompt: 'hello',
          },
        ],
        bootstrapTimeoutMs: 1_000,
        continueOnPartialFailure: true,
        permissionSeedTools: [],
        emitStructuredEvents: true,
        policy: {
          persistentTeam: true,
          registerForSessionCleanup: false,
          writeConversationSummaryMessage: false,
        },
        initiator: {
          kind: 'tool',
          source: 'TeamBootstrap',
        },
      },
      context: {
        getAppState: () => ({
          teamContext: undefined,
        }),
        setAppState: () => {},
      } as never,
      emit: {
        started: async () => {},
        phaseChanged: async () => {},
        teamCreated: async () => {},
        memberSpawnStarted: async () => {},
        memberSpawnResult: async () => {},
        completed: async () => {},
        failed: async () => {},
      },
      onInitialized: async () => {
        throw new Error('boom')
      },
    })

    expect(result.ok).toBe(false)
    expect(result.fatal).toBe(true)
    if (result.ok) {
      throw new Error('expected fatal bootstrap result')
    }
    expect((result as { ok: false; error: string }).error).toContain('boom')

    const teamDir = path.join(
      tempDir,
      'teams',
      teamName,
    )
    const rawState = JSON.parse(
      await fs.readFile(path.join(teamDir, 'bootstrap-state.json'), 'utf8'),
    ) as {
      phase: string
      terminal?: { status?: string; reason?: string }
    }
    expect(rawState.phase).toBe('failed')
    expect(rawState.terminal?.status).toBe('failed')
    expect(rawState.terminal?.reason).toContain('boom')
  })
})

describe('team bootstrap readiness contract', () => {
  test('passes native app-managed bootstrap context to teammate spawn', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-native-'))
    tempDirs.push(tempDir)
    process.env.CLAUDE_CONFIG_DIR = tempDir
    const teamName = `team-${Date.now()}`
    const agentId = `alice@${teamName}`
    const nativeAppManagedBootstrap = {
      schemaVersion: 1 as const,
      mode: 'startup_context_file' as const,
      contextText: '<context>native briefing</context>',
      contextHash: 'a'.repeat(64),
      briefingHash: 'b'.repeat(64),
      generatedAt: '2026-05-01T19:56:38.000Z',
    }
    let capturedNativeContextHash: string | undefined
    let capturedBootstrapTimeoutMs: number | undefined

    __setTeamBootstrapRunnerDepsForTests({
      readTeamFileAsync: async () =>
        ({
          members: [
            {
              name: 'alice',
              agentId,
              bootstrapExpectedAfter: '2026-05-01T19:56:38.000Z',
            },
          ],
        }) as never,
      updateTeamFileAsync: async () => ({ status: 'updated' }) as never,
      unregisterTeamForSessionCleanup: () => {},
      spawnTeammate: async input => {
        capturedNativeContextHash =
          input.nativeAppManagedBootstrap?.contextHash
        capturedBootstrapTimeoutMs = input.bootstrapTimeoutMs
        return {
          data: {
            teammate_id: agentId,
            agent_id: agentId,
            name: 'alice',
            team_name: teamName,
            tmux_session_name: 'process',
            tmux_window_name: 'process',
            tmux_pane_id: 'process:1234',
            backend_type: 'process',
            runtime_pid: 1234,
          },
        } as never
      },
      teamCreateCall: async () => {},
    })

    await runTeamBootstrap({
      request: {
        version: 1,
        runId: 'run-native-context',
        requestHash: 'hash-native-context',
        mode: 'launch',
        teamName,
        cwd: process.cwd(),
        members: [
          {
            originalName: 'alice',
            displayName: 'alice',
            normalizedName: 'alice',
            prompt: 'hello',
            provider: 'anthropic',
            nativeAppManagedBootstrap,
          },
        ],
        bootstrapTimeoutMs: 50,
        continueOnPartialFailure: false,
        permissionSeedTools: [],
        emitStructuredEvents: true,
        policy: {
          persistentTeam: true,
          registerForSessionCleanup: false,
          writeConversationSummaryMessage: false,
        },
        initiator: {
          kind: 'tool',
          source: 'TeamBootstrap',
        },
      },
      context: {
        getAppState: () => ({
          teamContext: {
            teamName,
            teamFilePath: '',
            leadAgentId: 'team-lead',
            teammates: {},
            isLeader: true,
          },
          toolPermissionContext: { mode: 'default' },
          mainLoopModel: undefined,
        }),
        setAppState: () => {},
      } as never,
      emit: {
        started: async () => {},
        phaseChanged: async () => {},
        teamCreated: async () => {},
        memberSpawnStarted: async () => {},
        memberSpawnResult: async () => {},
        completed: async () => {},
        failed: async () => {},
      },
    })

    expect(capturedNativeContextHash).toBe(nativeAppManagedBootstrap.contextHash)
    expect(capturedBootstrapTimeoutMs).toBeGreaterThan(0)
    expect(capturedBootstrapTimeoutMs).toBeLessThanOrEqual(50)
  })

  test('retries a transient pre-runtime-ready process startup failure once', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-retry-'))
    tempDirs.push(tempDir)
    process.env.CLAUDE_CONFIG_DIR = tempDir
    const teamName = `team-${Date.now()}`
    const agentId = `alice@${teamName}`
    const runtimePid = 1234
    const proofToken = 'proof-token'
    const runtimePaths = getTeammateRuntimePaths({
      teamName,
      agentName: 'alice',
    })
    let spawnCalls = 0

    await writeTeammateRuntimeEvent({
      type: 'bootstrap_confirmed',
      eventsPath: runtimePaths.eventsPath,
      pid: runtimePid,
      teamName,
      agentName: 'alice',
      agentId,
      source: 'member_briefing_tool_success',
      bootstrapProofToken: proofToken,
    })

    __setTeamBootstrapRunnerDepsForTests({
      readTeamFileAsync: async () =>
        ({
          members: [
            {
              name: 'alice',
              agentId,
              bootstrapExpectedAfter: '2026-04-29T00:00:00.000Z',
              bootstrapProofToken: proofToken,
              bootstrapRuntimeEventsPath: runtimePaths.eventsPath,
              backendType: 'process',
              runtimePid,
            },
          ],
        }) as never,
      updateTeamFileAsync: async () => ({ status: 'updated' }) as never,
      unregisterTeamForSessionCleanup: () => {},
      spawnTeammate: async () => {
        spawnCalls += 1
        if (spawnCalls === 1) {
          throw new Error(
            `Teammate process ${agentId} did not become runtime_ready: teammate process exited before runtime_ready`,
          )
        }
        return {
          data: {
            teammate_id: agentId,
            agent_id: agentId,
            name: 'alice',
            team_name: teamName,
            tmux_session_name: 'process',
            tmux_window_name: 'process',
            tmux_pane_id: `process:${runtimePid}`,
            backend_type: 'process',
            runtime_pid: runtimePid,
          },
        } as never
      },
      teamCreateCall: async () => {},
    })

    const result = await runTeamBootstrap({
      request: {
        version: 1,
        runId: 'run-retry-1',
        requestHash: 'hash-retry-1',
        mode: 'launch',
        teamName,
        cwd: process.cwd(),
        members: [
          {
            originalName: 'alice',
            displayName: 'alice',
            normalizedName: 'alice',
            prompt: 'hello',
            provider: 'anthropic',
          },
        ],
        bootstrapTimeoutMs: 30_000,
        continueOnPartialFailure: false,
        permissionSeedTools: [],
        emitStructuredEvents: true,
        policy: {
          persistentTeam: true,
          registerForSessionCleanup: false,
          writeConversationSummaryMessage: false,
        },
        initiator: {
          kind: 'tool',
          source: 'TeamBootstrap',
        },
      },
      context: {
        getAppState: () => ({
          teamContext: {
            teamName,
            teamFilePath: '',
            leadAgentId: 'team-lead',
            teammates: {},
            isLeader: true,
          },
          toolPermissionContext: { mode: 'default' },
          mainLoopModel: undefined,
        }),
        setAppState: () => {},
      } as never,
      emit: {
        started: async () => {},
        phaseChanged: async () => {},
        teamCreated: async () => {},
        memberSpawnStarted: async () => {},
        memberSpawnResult: async () => {},
        completed: async () => {},
        failed: async () => {},
      },
    })

    expect(spawnCalls).toBe(2)
    expect(result.ok).toBe(true)
  })

  test('registered teammate without bootstrap confirmation fails instead of completed', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-ready-'))
    tempDirs.push(tempDir)
    process.env.CLAUDE_CONFIG_DIR = tempDir
    const teamName = `team-${Date.now()}`
    const agentId = `alice@${teamName}`
    let completedEmitted = false
    let failedReason = ''

    __setTeamBootstrapRunnerDepsForTests({
      readTeamFileAsync: async () =>
        ({
          members: [
            {
              name: 'alice',
              agentId,
              bootstrapExpectedAfter: '2026-04-29T00:00:00.000Z',
            },
          ],
        }) as never,
      updateTeamFileAsync: async () => ({ status: 'updated' }) as never,
      unregisterTeamForSessionCleanup: () => {},
      spawnTeammate: async () =>
        ({
          data: {
            teammate_id: agentId,
            agent_id: agentId,
            name: 'alice',
            team_name: teamName,
            tmux_session_name: 'process',
            tmux_window_name: 'process',
            tmux_pane_id: 'process:1234',
            backend_type: 'process',
            runtime_pid: 1234,
          },
        }) as never,
      teamCreateCall: async () => {},
    })

    const result = await runTeamBootstrap({
      request: {
        version: 1,
        runId: 'run-ready-1',
        requestHash: 'hash-ready-1',
        mode: 'launch',
        teamName,
        cwd: process.cwd(),
        members: [
          {
            originalName: 'alice',
            displayName: 'alice',
            normalizedName: 'alice',
            prompt: 'hello',
          },
        ],
        bootstrapTimeoutMs: 500,
        continueOnPartialFailure: false,
        permissionSeedTools: [],
        emitStructuredEvents: true,
        policy: {
          persistentTeam: true,
          registerForSessionCleanup: false,
          writeConversationSummaryMessage: false,
        },
        initiator: {
          kind: 'tool',
          source: 'TeamBootstrap',
        },
      },
      context: {
        getAppState: () => ({
          teamContext: {
            teamName,
            teamFilePath: '',
            leadAgentId: 'team-lead',
            teammates: {},
            isLeader: true,
          },
          toolPermissionContext: { mode: 'default' },
          mainLoopModel: undefined,
        }),
        setAppState: () => {},
      } as never,
      emit: {
        started: async () => {},
        phaseChanged: async () => {},
        teamCreated: async () => {},
        memberSpawnStarted: async () => {},
        memberSpawnResult: async () => {},
        completed: async () => {
          completedEmitted = true
        },
        failed: async reason => {
          failedReason = reason
        },
      },
    })

    expect(result.ok).toBe(false)
    expect(completedEmitted).toBe(false)
    expect(failedReason).toContain('did not bootstrap-confirm')
  })

  test('process teammate runtime failure fails bootstrap without waiting for timeout', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-ready-'))
    tempDirs.push(tempDir)
    process.env.CLAUDE_CONFIG_DIR = tempDir
    const teamName = `team-${Date.now()}`
    const agentId = `alice@${teamName}`
    const runtimePid = 1234
    let failedReason = ''

    const runtimePaths = getTeammateRuntimePaths({
      teamName,
      agentName: 'alice',
    })
    await writeTeammateRuntimeEvent({
      type: 'failed',
      eventsPath: runtimePaths.eventsPath,
      pid: runtimePid,
      teamName,
      agentName: 'alice',
      agentId,
      detail: 'Bootstrap failed after teammate startup: API Error: 401 invalid authentication credentials',
    })

    __setTeamBootstrapRunnerDepsForTests({
      readTeamFileAsync: async () =>
        ({
          members: [
            {
              name: 'alice',
              agentId,
              bootstrapExpectedAfter: '2026-04-29T00:00:00.000Z',
              backendType: 'process',
              runtimePid,
            },
          ],
        }) as never,
      updateTeamFileAsync: async () => ({ status: 'updated' }) as never,
      unregisterTeamForSessionCleanup: () => {},
      spawnTeammate: async () =>
        ({
          data: {
            teammate_id: agentId,
            agent_id: agentId,
            name: 'alice',
            team_name: teamName,
            tmux_session_name: 'process',
            tmux_window_name: 'process',
            tmux_pane_id: `process:${runtimePid}`,
            backend_type: 'process',
            runtime_pid: runtimePid,
          },
        }) as never,
      teamCreateCall: async () => {},
    })

    const result = await runTeamBootstrap({
      request: {
        version: 1,
        runId: 'run-ready-2',
        requestHash: 'hash-ready-2',
        mode: 'launch',
        teamName,
        cwd: process.cwd(),
        members: [
          {
            originalName: 'alice',
            displayName: 'alice',
            normalizedName: 'alice',
            prompt: 'hello',
          },
        ],
        bootstrapTimeoutMs: 5_000,
        continueOnPartialFailure: false,
        permissionSeedTools: [],
        emitStructuredEvents: true,
        policy: {
          persistentTeam: true,
          registerForSessionCleanup: false,
          writeConversationSummaryMessage: false,
        },
        initiator: {
          kind: 'tool',
          source: 'TeamBootstrap',
        },
      },
      context: {
        getAppState: () => ({
          teamContext: {
            teamName,
            teamFilePath: '',
            leadAgentId: 'team-lead',
            teammates: {},
            isLeader: true,
          },
          toolPermissionContext: { mode: 'default' },
          mainLoopModel: undefined,
        }),
        setAppState: () => {},
      } as never,
      emit: {
        started: async () => {},
        phaseChanged: async () => {},
        teamCreated: async () => {},
        memberSpawnStarted: async () => {},
        memberSpawnResult: async () => {},
        completed: async () => {},
        failed: async reason => {
          failedReason = reason
        },
      },
    })

    expect(result.ok).toBe(false)
    expect(failedReason).toContain('API Error: 401')
  })
})

describe('team bootstrap progress emission safety', () => {
  test('swallows progress sink failures', async () => {
    await expect(
      emitBootstrapProgressSafely('phase_changed:creating_team', async () => {
        throw new Error('consumer disconnected')
      }),
    ).resolves.toBeUndefined()
  })
})

describe('team bootstrap timeout budget', () => {
  test('allows execution while still within the monotonic timeout budget', () => {
    expect(() =>
      assertBootstrapTimeoutBudget({
        teamName: 'atlas-hq',
        startedAtMs: 100,
        timeoutMs: 1_000,
        monotonicNowMs: 1_050,
      }),
    ).not.toThrow()
  })

  test('fails explicitly when the monotonic timeout budget is exhausted', () => {
    expect(() =>
      assertBootstrapTimeoutBudget({
        teamName: 'atlas-hq',
        startedAtMs: 100,
        timeoutMs: 1_000,
        monotonicNowMs: 1_250,
        stage: 'before spawning teammate "alice"',
      }),
    ).toThrow(
      'Deterministic bootstrap for "atlas-hq" timed out before spawning teammate "alice" after 1150ms (budget 1000ms).',
    )
  })
})
