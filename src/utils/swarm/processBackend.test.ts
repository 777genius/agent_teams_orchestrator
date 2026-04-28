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
