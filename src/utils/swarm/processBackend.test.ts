import { describe, expect, it } from 'bun:test'

import {
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
})
