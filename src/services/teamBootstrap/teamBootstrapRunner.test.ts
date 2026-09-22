import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import {
  __resolveBootstrapSubmittedElapsedForTests,
  __setTeamBootstrapRunnerDepsForTests,
  assertBootstrapTimeoutBudget,
  assertBootstrapRuntimeWorkspace,
  deriveBootstrapTerminalStatus,
  emitBootstrapProgressSafely,
  getFencedMemberBootstrapTimeoutMs,
  runTeamBootstrap,
  shouldCreateTeamForBootstrap,
} from './teamBootstrapRunner.js'
import {
  getTeammateRuntimePaths,
  writeTeammateRuntimeEvent,
} from 'src/utils/swarm/teammateRuntimeEvents.js'
import { writeToMailbox } from 'src/utils/teammateMailbox.js'

let tempDirs: string[] = []
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalSubmittedConfirmationTimeoutMs =
  process.env.CLAUDE_TEAM_BOOTSTRAP_SUBMITTED_CONFIRMATION_TIMEOUT_MS

async function sleepMs(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return
    }
    await sleepMs(10)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

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
  if (originalSubmittedConfirmationTimeoutMs === undefined) {
    delete process.env.CLAUDE_TEAM_BOOTSTRAP_SUBMITTED_CONFIRMATION_TIMEOUT_MS
  } else {
    process.env.CLAUDE_TEAM_BOOTSTRAP_SUBMITTED_CONFIRMATION_TIMEOUT_MS =
      originalSubmittedConfirmationTimeoutMs
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

describe('team bootstrap member timeout fence', () => {
  test('splits a healthy launch budget across remaining members', () => {
    expect(getFencedMemberBootstrapTimeoutMs(300_000, 4)).toBe(75_000)
    expect(getFencedMemberBootstrapTimeoutMs(170_000, 2)).toBe(85_000)
  })

  test('does not allocate more than the remaining launch budget', () => {
    expect(getFencedMemberBootstrapTimeoutMs(29_000, 1)).toBe(29_000)
  })

  test('keeps a minimum useful timeout while enough budget remains', () => {
    expect(getFencedMemberBootstrapTimeoutMs(180_000, 3)).toBe(60_000)
  })

  test('fair-shares a constrained budget instead of starving later members', () => {
    expect(getFencedMemberBootstrapTimeoutMs(90_000, 3)).toBe(30_000)
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

  test('repairs a member that failed the initial spawn pass while budget remains', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-repair-'))
    tempDirs.push(tempDir)
    process.env.CLAUDE_CONFIG_DIR = tempDir
    const teamName = `team-${Date.now()}`
    const agentId = `alice@${teamName}`
    const runtimePid = 1234
    const proofToken = 'repair-proof-token'
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
      bootstrapRunId: 'run-repair-1',
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
              bootstrapRunId: 'run-repair-1',
            },
          ],
        }) as never,
      updateTeamFileAsync: async () => ({ status: 'updated' }) as never,
      unregisterTeamForSessionCleanup: () => {},
      spawnTeammate: async () => {
        spawnCalls += 1
        if (spawnCalls === 1) {
          throw new Error('non-transient spawn setup failed')
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
        runId: 'run-repair-1',
        requestHash: 'hash-repair-1',
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
        bootstrapTimeoutMs: 90_000,
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

  test('submitted bootstrap prompt times out one member without blocking partial launch', async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'bootstrap-submitted-'),
    )
    tempDirs.push(tempDir)
    process.env.CLAUDE_CONFIG_DIR = tempDir
    process.env.CLAUDE_TEAM_BOOTSTRAP_SUBMITTED_CONFIRMATION_TIMEOUT_MS = '80'

    const teamName = `team-${Date.now()}`
    const runId = 'run-submitted-timeout'
    const aliceAgentId = `alice@${teamName}`
    const bobAgentId = `bob@${teamName}`
    const aliceRuntimePid = 1234
    const bobRuntimePid = 5678
    const bootstrapExpectedAfter = new Date(Date.now() - 5_000).toISOString()
    let completedStatus: string | undefined
    let completedFailedMembers: Array<{ name: string; reason: string }> = []

    await writeTeammateRuntimeEvent({
      type: 'bootstrap_confirmed',
      eventsPath: getTeammateRuntimePaths({
        teamName,
        agentName: 'alice',
      }).eventsPath,
      pid: aliceRuntimePid,
      teamName,
      agentName: 'alice',
      agentId: aliceAgentId,
      bootstrapRunId: runId,
      source: 'member_briefing_tool_success',
    })
    await writeTeammateRuntimeEvent({
      type: 'bootstrap_submitted',
      eventsPath: getTeammateRuntimePaths({
        teamName,
        agentName: 'bob',
      }).eventsPath,
      pid: bobRuntimePid,
      teamName,
      agentName: 'bob',
      agentId: bobAgentId,
      bootstrapRunId: runId,
      bootstrapMessageId: 'bootstrap-bob-1',
      detail: 'messageId=bootstrap-bob-1',
      source: 'test',
    })

    __setTeamBootstrapRunnerDepsForTests({
      readTeamFileAsync: async () =>
        ({
          members: [
            {
              name: 'alice',
              agentId: aliceAgentId,
              bootstrapExpectedAfter,
              backendType: 'process',
              runtimePid: aliceRuntimePid,
              bootstrapRunId: runId,
            },
            {
              name: 'bob',
              agentId: bobAgentId,
              bootstrapExpectedAfter,
              backendType: 'process',
              runtimePid: bobRuntimePid,
              bootstrapRunId: runId,
            },
          ],
        }) as never,
      updateTeamFileAsync: async () => ({ status: 'updated' }) as never,
      unregisterTeamForSessionCleanup: () => {},
      spawnTeammate: async input => {
        const name = input.name === 'bob' ? 'bob' : 'alice'
        const agentId = name === 'bob' ? bobAgentId : aliceAgentId
        const runtimePid = name === 'bob' ? bobRuntimePid : aliceRuntimePid
        return {
          data: {
            teammate_id: agentId,
            agent_id: agentId,
            name,
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
        runId,
        requestHash: 'hash-submitted-timeout',
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
          {
            originalName: 'bob',
            displayName: 'bob',
            normalizedName: 'bob',
            prompt: 'hello',
          },
        ],
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
        completed: async summary => {
          completedStatus = summary.status
          completedFailedMembers = summary.failedMembers
        },
        failed: async () => {},
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('expected partial bootstrap success')
    }
    expect(result.summary.terminalStatus).toBe('partial_success')
    expect(result.summary.registeredMembers).toEqual(['alice'])
    expect(result.summary.failedMembers).toHaveLength(1)
    expect(result.summary.failedMembers[0]).toMatchObject({ name: 'bob' })
    expect(result.summary.failedMembers[0]?.reason).toContain(
      'submitted-confirmation timeout (80ms)',
    )
    expect(result.summary.failedMembers[0]?.reason).toContain(
      'Last transport stage: bootstrap_submitted: messageId=bootstrap-bob-1',
    )
    expect(completedStatus).toBe('partial_success')
    expect(completedFailedMembers).toEqual(result.summary.failedMembers)

    const rawState = JSON.parse(
      await fs.readFile(
        path.join(tempDir, 'teams', teamName, 'bootstrap-state.json'),
        'utf8',
      ),
    ) as {
      members: Array<{ name: string; status: string; failureReason?: string }>
    }
    expect(rawState.members.find(member => member.name === 'alice')?.status).toBe(
      'bootstrap_confirmed',
    )
    const bobState = rawState.members.find(member => member.name === 'bob')
    expect(bobState?.status).toBe('failed')
    expect(bobState?.failureReason).toContain('submitted-confirmation timeout')
  })

  test('waits for Codex process bootstrap confirmation before spawning the next Codex member', async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'bootstrap-codex-backpressure-'),
    )
    tempDirs.push(tempDir)
    process.env.CLAUDE_CONFIG_DIR = tempDir
    process.env.CLAUDE_TEAM_BOOTSTRAP_SUBMITTED_CONFIRMATION_TIMEOUT_MS = '2000'

    const teamName = `team-${Date.now()}`
    const runId = 'run-codex-backpressure'
    const runtimePids = new Map([
      ['alice', 1234],
      ['bob', 5678],
    ])
    const spawnOrder: string[] = []
    const spawnedMembers = new Map<
      string,
      {
        agentId: string
        runtimePid: number
        bootstrapExpectedAfter: string
      }
    >()
    const writeMailboxBootstrapConfirmation = async (name: string): Promise<void> => {
      const agentId = `${name}@${teamName}`
      const timestamp = new Date().toISOString()
      await writeToMailbox(
        'team-lead',
        {
          from: agentId,
          text: JSON.stringify({
            type: 'idle_notification',
            from: agentId,
            timestamp,
            idleReason: 'available',
          }),
          timestamp,
        },
        teamName,
      )
    }

    __setTeamBootstrapRunnerDepsForTests({
      readTeamFileAsync: async () =>
        ({
          members: [
            ...spawnedMembers.entries(),
          ].map(([name, member]) => ({
            name,
            agentId: member.agentId,
            backendType: 'process',
            runtimePid: member.runtimePid,
            bootstrapExpectedAfter: member.bootstrapExpectedAfter,
            bootstrapRunId: runId,
          })),
        }) as never,
      updateTeamFileAsync: async () => ({ status: 'updated' }) as never,
      unregisterTeamForSessionCleanup: () => {},
      spawnTeammate: async input => {
        const name = String(input.name)
        const runtimePid = runtimePids.get(name)
        if (!runtimePid) {
          throw new Error(`unexpected member ${name}`)
        }
        const agentId = `${name}@${teamName}`
        spawnOrder.push(name)
        spawnedMembers.set(name, {
          agentId,
          runtimePid,
          bootstrapExpectedAfter: new Date().toISOString(),
        })
        return {
          data: {
            teammate_id: agentId,
            agent_id: agentId,
            name,
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

    await writeToMailbox(
      'team-lead',
      {
        from: `alice@${teamName}`,
        text: JSON.stringify({
          type: 'idle_notification',
          from: `alice@${teamName}`,
          timestamp: '2026-01-01T00:00:00.000Z',
          idleReason: 'available',
        }),
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      teamName,
    )

    const resultPromise = runTeamBootstrap({
      request: {
        version: 1,
        runId,
        requestHash: 'hash-codex-backpressure',
        mode: 'launch',
        teamName,
        cwd: process.cwd(),
        members: [
          {
            originalName: 'alice',
            displayName: 'alice',
            normalizedName: 'alice',
            prompt: 'hello',
            provider: 'codex',
          },
          {
            originalName: 'bob',
            displayName: 'bob',
            normalizedName: 'bob',
            prompt: 'hello',
            provider: 'codex',
          },
        ],
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

    await waitUntil(() => spawnOrder.length >= 1, 'first Codex spawn')
    await sleepMs(120)
    expect(spawnOrder).toEqual(['alice'])

    await writeMailboxBootstrapConfirmation('alice')

    await waitUntil(() => spawnOrder.length >= 2, 'second Codex spawn')
    expect(spawnOrder).toEqual(['alice', 'bob'])

    await writeMailboxBootstrapConfirmation('bob')

    const result = await resultPromise

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('expected successful Codex bootstrap')
    }
    expect(result.summary.terminalStatus).toBe('completed')
    expect(result.summary.registeredMembers).toEqual(['alice', 'bob'])
    expect(result.summary.failedMembers).toEqual([])
  })

  test('continues Codex bootstrap after a backpressured member hits submitted-confirmation timeout', async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'bootstrap-codex-timeout-continues-'),
    )
    tempDirs.push(tempDir)
    process.env.CLAUDE_CONFIG_DIR = tempDir
    process.env.CLAUDE_TEAM_BOOTSTRAP_SUBMITTED_CONFIRMATION_TIMEOUT_MS = '80'

    const teamName = `team-${Date.now()}`
    const runId = 'run-codex-backpressure-timeout'
    const aliceAgentId = `alice@${teamName}`
    const bobAgentId = `bob@${teamName}`
    const aliceRuntimePid = 1234
    const bobRuntimePid = 5678
    const spawnOrder: string[] = []
    const spawnedMembers = new Map<
      string,
      {
        agentId: string
        runtimePid: number
        bootstrapExpectedAfter: string
      }
    >()

    await writeTeammateRuntimeEvent({
      type: 'bootstrap_submitted',
      eventsPath: getTeammateRuntimePaths({
        teamName,
        agentName: 'alice',
      }).eventsPath,
      pid: aliceRuntimePid,
      teamName,
      agentName: 'alice',
      agentId: aliceAgentId,
      bootstrapRunId: runId,
      bootstrapMessageId: 'bootstrap-alice-1',
      detail: 'messageId=bootstrap-alice-1',
      source: 'test',
    })

    __setTeamBootstrapRunnerDepsForTests({
      readTeamFileAsync: async () =>
        ({
          members: [
            ...spawnedMembers.entries(),
          ].map(([name, member]) => ({
            name,
            agentId: member.agentId,
            backendType: 'process',
            runtimePid: member.runtimePid,
            bootstrapExpectedAfter: member.bootstrapExpectedAfter,
            bootstrapRunId: runId,
          })),
        }) as never,
      updateTeamFileAsync: async () => ({ status: 'updated' }) as never,
      unregisterTeamForSessionCleanup: () => {},
      spawnTeammate: async input => {
        const name = String(input.name)
        const runtimePid = name === 'alice' ? aliceRuntimePid : bobRuntimePid
        const agentId = name === 'alice' ? aliceAgentId : bobAgentId
        spawnOrder.push(name)
        spawnedMembers.set(name, {
          agentId,
          runtimePid,
          bootstrapExpectedAfter: '2026-01-01T00:00:00.000Z',
        })
        return {
          data: {
            teammate_id: agentId,
            agent_id: agentId,
            name,
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

    const resultPromise = runTeamBootstrap({
      request: {
        version: 1,
        runId,
        requestHash: 'hash-codex-backpressure-timeout',
        mode: 'launch',
        teamName,
        cwd: process.cwd(),
        members: [
          {
            originalName: 'alice',
            displayName: 'alice',
            normalizedName: 'alice',
            prompt: 'hello',
            provider: 'codex',
          },
          {
            originalName: 'bob',
            displayName: 'bob',
            normalizedName: 'bob',
            prompt: 'hello',
            provider: 'codex',
          },
        ],
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

    await waitUntil(() => spawnOrder.length >= 2, 'second Codex spawn after timeout')

    const timestamp = new Date().toISOString()
    await writeToMailbox(
      'team-lead',
      {
        from: bobAgentId,
        text: JSON.stringify({
          type: 'idle_notification',
          from: bobAgentId,
          timestamp,
          idleReason: 'available',
        }),
        timestamp,
      },
      teamName,
    )

    const result = await resultPromise

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('expected partial Codex bootstrap success')
    }
    expect(spawnOrder).toEqual(['alice', 'bob'])
    expect(result.summary.terminalStatus).toBe('partial_success')
    expect(result.summary.registeredMembers).toEqual(['bob'])
    expect(result.summary.failedMembers).toHaveLength(1)
    expect(result.summary.failedMembers[0]).toMatchObject({ name: 'alice' })
    expect(result.summary.failedMembers[0]?.reason).toContain(
      'submitted-confirmation timeout (80ms)',
    )
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

describe('team bootstrap submitted-confirmation timing', () => {
  test('combines submitted event age with monotonic elapsed after observation', () => {
    expect(
      __resolveBootstrapSubmittedElapsedForTests({
        submittedTimestamp: new Date(1_000).toISOString(),
        observedWallNowMs: 1_100,
        observedAtMs: 20,
        observedNowMs: 70,
      }),
    ).toBe(150)
  })

  test('falls back to monotonic observation time for unsafe submitted timestamps', () => {
    expect(
      __resolveBootstrapSubmittedElapsedForTests({
        submittedTimestamp: new Date(10_000).toISOString(),
        observedWallNowMs: 1_000,
        observedAtMs: 20,
        observedNowMs: 70,
      }),
    ).toBe(50)
    expect(
      __resolveBootstrapSubmittedElapsedForTests({
        submittedTimestamp: new Date(1_000).toISOString(),
        observedWallNowMs: 2_000,
        observedAtMs: 20,
        observedNowMs: 70,
        bootstrapExpectedAfter: new Date(1_500).toISOString(),
      }),
    ).toBe(50)
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
