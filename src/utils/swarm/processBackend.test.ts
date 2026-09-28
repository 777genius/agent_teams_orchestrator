import { describe, expect, it } from 'bun:test'

import {
  isProcessBackendRuntimeAlive,
  getProcessBackendRuntimeState,
  isProcessBackendCommandForTeammate,
  killProcessBackendRuntime,
  parseProcessBackendPid,
} from './processBackend.js'

describe('processBackend', () => {
  it('parses process pane pid markers', () => {
    expect(parseProcessBackendPid('process:1234')).toBe(1234)
    expect(parseProcessBackendPid('  5678  ')).toBe(5678)
    expect(parseProcessBackendPid('tmux:%1.2')).toBeNull()
  })

  it('matches teammate process command lines by explicit identity', () => {
    expect(
      isProcessBackendCommandForTeammate(
        'bun cli.js --team-name "alpha team" --agent-id "bob@alpha team"',
        'bob@alpha team',
        'alpha team',
      ),
    ).toBe(true)
    expect(
      isProcessBackendCommandForTeammate(
        'bun cli.js --team-name alpha --agent-id alice@alpha',
        'bob@alpha',
        'alpha',
      ),
    ).toBe(false)
    expect(
      isProcessBackendCommandForTeammate(
        'bun cli.js --team-name alpha --agent-id bob@alpha-extra',
        'bob@alpha',
        'alpha',
      ),
    ).toBe(false)
    expect(
      isProcessBackendCommandForTeammate(
        'bun cli.js --team-name=alpha --agent-id=bob@alpha',
        'bob@alpha',
        'alpha',
      ),
    ).toBe(true)
  })

  it('matches Windows command lines with quoted paths, spaces, and Cyrillic values', () => {
    expect(
      isProcessBackendCommandForTeammate(
        '"C:\\Program Files\\Bun\\bun.exe" "C:\\Users\\User\\папка с пробелом\\fake teammate runtime.mjs" --teammate-runtime headless --team-name "vector room тест" --agent-id "alice@vector room тест" --agent-name alice',
        'alice@vector room тест',
        'vector room тест',
      ),
    ).toBe(true)
    expect(
      isProcessBackendCommandForTeammate(
        '"C:\\Program Files\\Bun\\bun.exe" "C:\\tmp\\fake teammate runtime.mjs" --team-name "vector room тест-extra" --agent-id "alice@vector room тест"',
        'alice@vector room тест',
        'vector room тест',
      ),
    ).toBe(false)
    expect(
      isProcessBackendCommandForTeammate(
        '"C:\\Program Files\\Bun\\bun.exe" "C:\\tmp\\fake teammate runtime.mjs" --team-name "vector room тест" --agent-id "alice@vector room тест-extra"',
        'alice@vector room тест',
        'vector room тест',
      ),
    ).toBe(false)
  })

  it('fails closed when kill identity is incomplete', async () => {
    const currentPid = `process:${process.pid}`

    await expect(killProcessBackendRuntime(currentPid)).resolves.toBe(false)
    await expect(
      killProcessBackendRuntime(currentPid, { expectedAgentId: 'self@test' }),
    ).resolves.toBe(false)
    await expect(
      killProcessBackendRuntime(currentPid, { teamName: 'test' }),
    ).resolves.toBe(false)
  })

  it('reports false for dead process markers without attempting blind success', async () => {
    await expect(killProcessBackendRuntime('process:99999999')).resolves.toBe(
      false,
    )
  })

  const expectedIdentity = {
    expectedAgentId: 'bob@alpha',
    teamName: 'alpha',
    expectedStartedAtMs: 100,
    expectedOwnerToken: 'unguessable-run-token',
    expectedRunId: 'run-a',
  }

  it('requires start time and owner token for liveness and termination', async () => {
    const dependencies = {
      isProcessAlive: () => true,
      readProcessStartTimeMs: async () => 100,
      readProcessCommandLine: async () =>
        'bun cli.js --team-name alpha --agent-id bob@alpha --process-owner-token unguessable-run-token',
    }
    await expect(
      isProcessBackendRuntimeAlive(42, 'bob@alpha', 'alpha', { dependencies }),
    ).resolves.toBe(false)
    await expect(
      killProcessBackendRuntime('process:42', {
        expectedAgentId: 'bob@alpha',
        teamName: 'alpha',
        dependencies,
      }),
    ).resolves.toBe(false)
  })

  it('blocks duplicate respawn for a live legacy runtime without identity fields', async () => {
    await expect(
      getProcessBackendRuntimeState(42, 'bob@alpha', 'alpha', {
        dependencies: { isProcessAlive: () => true },
      }),
    ).resolves.toBe('legacy_unverifiable')
    await expect(
      getProcessBackendRuntimeState(42, 'bob@alpha', 'alpha', {
        dependencies: { isProcessAlive: () => false },
      }),
    ).resolves.toBe('gone')
  })

  it('confirms full process identity for liveness', async () => {
    await expect(
      isProcessBackendRuntimeAlive(42, 'bob@alpha', 'alpha', {
        expectedStartedAtMs: 100,
        expectedOwnerToken: 'unguessable-run-token',
        expectedRunId: 'run-a',
        dependencies: {
          isProcessAlive: () => true,
          readProcessStartTimeMs: async () => 100,
          readProcessCommandLine: async () =>
            'bun cli.js --team-name alpha --agent-id bob@alpha --parent-session-id run-a --process-owner-token unguessable-run-token',
        },
      }),
    ).resolves.toBe(true)
  })

  it('never kills on start-time mismatch, token mismatch, or unrelated command', async () => {
    const cases = [
      {
        startTime: 200,
        command:
          'bun cli.js --team-name alpha --agent-id bob@alpha --parent-session-id run-a --process-owner-token unguessable-run-token',
      },
      {
        startTime: 100,
        command:
          'bun cli.js --team-name alpha --agent-id bob@alpha --parent-session-id run-a --process-owner-token another-token',
      },
      {
        startTime: 100,
        command:
          'bun unrelated.js --team-name beta --agent-id alice@beta --parent-session-id run-a --process-owner-token unguessable-run-token',
      },
    ]
    for (const testCase of cases) {
      let kills = 0
      await expect(
        killProcessBackendRuntime('process:42', {
          ...expectedIdentity,
          dependencies: {
            isProcessAlive: () => true,
            readProcessStartTimeMs: async () => testCase.startTime,
            readProcessCommandLine: async () => testCase.command,
            killProcessTreeAndWait: async () => {
              kills += 1
              return true
            },
          },
        }),
      ).resolves.toBe(false)
      expect(kills).toBe(0)
    }
  })

  it('kills a confirmed cooperative identity but does not claim whole-tree proof after root exit', async () => {
    let alive = true
    let kills = 0
    const dependencies = {
      isProcessAlive: () => alive,
      readProcessStartTimeMs: async () => (alive ? 100 : null),
      readProcessCommandLine: async () =>
        'bun cli.js --team-name alpha --agent-id bob@alpha --parent-session-id run-a --process-owner-token unguessable-run-token',
      killProcessTreeAndWait: async () => {
        kills += 1
        alive = false
        return true
      },
    }

    await expect(
      killProcessBackendRuntime('process:42', { ...expectedIdentity, dependencies }),
    ).resolves.toBe(true)
    await expect(
      killProcessBackendRuntime('process:42', { ...expectedIdentity, dependencies }),
    ).resolves.toBe(false)
    expect(kills).toBe(1)
  })

  it('queries the exact Windows Job after supervisor exit', async () => {
    let jobProofCalls = 0
    await expect(killProcessBackendRuntime('process:42', {
      ...expectedIdentity,
      expectedOsIdentity: 'win32-job:exact-a',
      dependencies: {
        isProcessAlive: () => false,
        readProcessStartTimeMs: async () => null,
        killProcessTreeAndWait: async (_pid, _signal, options) => {
          jobProofCalls += 1
          expect(options.expectedOsIdentity).toBe('win32-job:exact-a')
          return true
        },
        processKillDependencies: { platform: 'win32' },
      },
    })).resolves.toBe(true)
    expect(jobProofCalls).toBe(1)
  })

  it('production boundary never supplies ordinary PID signaling after validation', async () => {
    let killBoundaryCalls = 0
    await expect(
      killProcessBackendRuntime('process:42', {
        ...expectedIdentity,
        dependencies: {
          isProcessAlive: () => true,
          readProcessStartTimeMs: async () => 100,
          readProcessCommandLine: async () =>
            'bun cli.js --team-name alpha --agent-id bob@alpha --parent-session-id run-a --process-owner-token unguessable-run-token',
          killProcessTreeAndWait: async (_pid, _signal, options) => {
            killBoundaryCalls += 1
            expect(options.dependencies?.signalExpectedProcess).toBeUndefined()
            return false
          },
        },
      }),
    ).resolves.toBe(false)
    expect(killBoundaryCalls).toBe(1)
  })

  it('returns false when the exact boundary reports a surviving descendant', async () => {
    let treeProofCalls = 0
    await expect(
      killProcessBackendRuntime('process:42', {
        ...expectedIdentity,
        expectedOsIdentity: 'unix-pgid:42',
        dependencies: {
          isProcessAlive: () => true,
          readProcessStartTimeMs: async () => 100,
          readProcessCommandLine: async () =>
            'bun cli.js --team-name alpha --agent-id bob@alpha --parent-session-id run-a --process-owner-token unguessable-run-token',
          processKillDependencies: {
            platform: 'linux',
            terminateExpectedProcessTree: async () => {
              treeProofCalls += 1
              return false
            },
          },
        },
      }),
    ).resolves.toBe(false)
    expect(treeProofCalls).toBe(1)
  })

  it('rechecks the full identity inside the termination primitive', async () => {
    let commandReads = 0
    let signals = 0
    await expect(
      killProcessBackendRuntime('process:42', {
        ...expectedIdentity,
        dependencies: {
          isProcessAlive: () => true,
          readProcessStartTimeMs: async () => 100,
          readProcessCommandLine: async () => {
            commandReads += 1
            return commandReads === 1
              ? 'bun cli.js --team-name alpha --agent-id bob@alpha --parent-session-id run-a --process-owner-token unguessable-run-token'
              : 'bun cli.js --team-name alpha --agent-id bob@alpha --parent-session-id run-b --process-owner-token changed-token'
          },
          processKillDependencies: {
            platform: 'linux',
            isProcessAlive: () => true,
            readProcessStartTimeMs: async () => 100,
            signalExpectedProcess: async () => {
              signals += 1
              return true
            },
          },
        },
      }),
    ).resolves.toBe(false)
    expect(signals).toBe(0)
  })

  it('does not let stale run A terminate replacement run B', async () => {
    let kills = 0
    await expect(
      killProcessBackendRuntime('process:42', {
        ...expectedIdentity,
        dependencies: {
          isProcessAlive: () => true,
          readProcessStartTimeMs: async () => 200,
          readProcessCommandLine: async () =>
            'bun cli.js --team-name alpha --agent-id bob@alpha --parent-session-id run-b --process-owner-token replacement-token',
          killProcessTreeAndWait: async () => {
            kills += 1
            return true
          },
        },
      }),
    ).resolves.toBe(false)
    expect(kills).toBe(0)
  })

  it('rejects a same-start-time replacement using the per-spawn token', async () => {
    let kills = 0
    await expect(
      killProcessBackendRuntime('process:42', {
        ...expectedIdentity,
        dependencies: {
          isProcessAlive: () => true,
          // Models a platform observation that cannot distinguish same-second
          // process incarnations. The unguessable spawn token still fences B.
          readProcessStartTimeMs: async () => 100,
          readProcessCommandLine: async () =>
            'bun cli.js --team-name alpha --agent-id bob@alpha --parent-session-id run-b --process-owner-token replacement-token',
          killProcessTreeAndWait: async () => {
            kills += 1
            return true
          },
        },
      }),
    ).resolves.toBe(false)
    expect(kills).toBe(0)
  })
})
