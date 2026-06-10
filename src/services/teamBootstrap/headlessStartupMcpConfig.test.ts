import { describe, expect, test } from 'bun:test'

import {
  getHeadlessTeammateMcpConfigTimeoutMs,
  resolveStartupMcpConfig,
} from './headlessStartupMcpConfig.js'

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise(resolve => {
    setTimeout(() => resolve(value), ms)
  })
}

describe('headless startup MCP config resolution', () => {
  test('non-headless startup waits for MCP config instead of applying the timeout fallback', async () => {
    const result = await resolveStartupMcpConfig(
      delay(10, { servers: { github: { type: 'stdio' } } }),
      {
        headlessTeammateRuntime: false,
        timeoutMs: 1,
      },
    )

    expect(result).toEqual({
      result: { servers: { github: { type: 'stdio' } } },
      timedOut: false,
      timeoutMs: 1,
    })
  })

  test('headless startup uses resolved MCP config when it is ready before the timeout', async () => {
    const result = await resolveStartupMcpConfig(
      delay(1, { servers: { 'agent-teams': { type: 'stdio' } } }),
      {
        headlessTeammateRuntime: true,
        timeoutMs: 25,
      },
    )

    expect(result).toEqual({
      result: { servers: { 'agent-teams': { type: 'stdio' } } },
      timedOut: false,
      timeoutMs: 25,
    })
  })

  test('headless startup falls back when auto-discovered MCP config stalls', async () => {
    const stalled = new Promise<{ servers: Record<string, unknown> }>(() => {})

    const result = await resolveStartupMcpConfig(stalled, {
      headlessTeammateRuntime: true,
      timeoutMs: 1,
    })

    expect(result).toEqual({
      result: { servers: {} },
      timedOut: true,
      timeoutMs: 1,
    })
  })

  test('parses the headless MCP timeout env with a safe default', () => {
    expect(
      getHeadlessTeammateMcpConfigTimeoutMs({
        CLAUDE_TEAM_HEADLESS_MCP_CONFIG_TIMEOUT_MS: '42',
      }),
    ).toBe(42)
    expect(
      getHeadlessTeammateMcpConfigTimeoutMs({
        CLAUDE_TEAM_HEADLESS_MCP_CONFIG_TIMEOUT_MS: 'invalid',
      }),
    ).toBe(5_000)
  })
})
