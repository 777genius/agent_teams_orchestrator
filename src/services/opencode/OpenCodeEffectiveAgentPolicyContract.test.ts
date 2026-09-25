import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { buildManagedConfig } from './OpenCodeProfileManager.js'
import { assertOpenCodeEffectiveAgentPolicies, buildExpectedOpenCodeAgentPolicies } from './OpenCodeEffectiveAgentPolicyContract.js'

const dataHome = '/sandbox/isolated-data'
const r = (permission: string, action: 'allow' | 'deny' | 'ask', pattern = '*') => ({ permission, pattern, action })
const mcpNames = ['agent-teams_*', 'agent_teams_*', 'mcp__agent-teams__*', 'mcp__agent_teams__*']
const mcp = mcpNames.map(name => r(name, 'allow'))
const truncate = r('external_directory', 'allow', path.join(dataHome, 'opencode', 'tool-output', '*'))
// Independent intent fixtures, deliberately not produced by the contract's flattening code.
// The probe carries exactly the teammate tool set, but every tool the teammate may run is "ask".
function teammateRules(mode: 'auto' | 'manual', grant: 'allow' | 'ask') {
  return [
    r('*', mode === 'auto' ? 'deny' : 'ask'),
    ...(mode === 'auto' ? ['read', 'glob', 'grep', 'list', 'lsp', 'todoread', 'todowrite', 'edit', 'write', 'bash'].map(name => r(name, grant)) : []),
    r('task', 'deny'), r('external_directory', 'deny'), r('doom_loop', 'deny'), ...mcpNames.map(name => r(name, grant)), truncate,
  ]
}
function intended(mode: 'auto' | 'manual') {
  return [
    { name: 'teammate', permission: teammateRules(mode, 'allow') },
    { name: 'teammate-bootstrap', permission: [r('*', 'deny'), ...mcp, truncate] },
    { name: 'teammate-model-probe', permission: teammateRules(mode, 'ask') },
  ].map(value => structuredClone(value))
}
const error = 'Invalid OpenCode effective agent policy contract'

describe('effective managed agent policy', () => {
  for (const mode of ['auto', 'manual'] as const) {
    test(`actual generated ${mode} configuration matches independent intentions`, () => {
      const snapshot = buildExpectedOpenCodeAgentPolicies(buildManagedConfig(null, { toolApprovalMode: mode }), dataHome)
      expect(snapshot.map(({ name, rules }) => ({ name, permission: rules }))).toEqual(intended(mode))
      expect(() => assertOpenCodeEffectiveAgentPolicies(snapshot, intended(mode))).not.toThrow()
    })
  }

  test('accepts arbitrary valid shadowed prefix including earlier universal resets', () => {
    const live = intended('auto')
    for (const agent of live) agent.permission.unshift(r('*', 'allow'), r('unknown_plugin', 'allow', '/private/*'))
    assertOpenCodeEffectiveAgentPolicies(buildExpectedOpenCodeAgentPolicies(buildManagedConfig(), dataHome), live)
  })

  test('preserves nested order and detaches/freeze snapshots without changing raw config', () => {
    const raw = buildManagedConfig() as any
    raw.agent.teammate.permission.read = { '*': 'deny', '*.ts': 'allow', 'secret.ts': 'deny' }
    const before = JSON.stringify(raw)
    const snapshot = buildExpectedOpenCodeAgentPolicies(raw, dataHome)
    expect(JSON.stringify(raw)).toBe(before)
    const live = intended('auto')
    live[0].permission.splice(1, 1, r('read', 'deny'), r('read', 'allow', '*.ts'), r('read', 'deny', 'secret.ts'))
    assertOpenCodeEffectiveAgentPolicies(snapshot, live)
    raw.agent.teammate.permission.read['*.ts'] = 'deny'
    assertOpenCodeEffectiveAgentPolicies(snapshot, live)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot[0].rules[0])).toBe(true)
    ;[live[0].permission[2], live[0].permission[3]] = [live[0].permission[3], live[0].permission[2]]
    expect(() => assertOpenCodeEffectiveAgentPolicies(snapshot, live)).toThrow(error)
  })

  const mutations: Record<string, (live: any[]) => unknown> = {
    missing: live => live.pop(),
    duplicate: live => live.push(live[0]),
    'missing permission': live => delete live[0].permission,
    'object permission': live => live[0].permission = {},
    'wrong reset': live => live[0].permission[0].action = 'allow',
    'missing reset': live => live[0].permission.shift(),
    'removed rule': live => live[0].permission.splice(1, 1),
    'reordered rule': live => [live[0].permission[1], live[0].permission[2]] = [live[0].permission[2], live[0].permission[1]],
    'extra tail': live => live[0].permission.push(r('unknown', 'allow')),
    'inserted rule': live => live[0].permission.splice(1, 0, r('unknown', 'allow')),
    'wrong truncate path': live => live[0].permission.at(-1).pattern = '/other/*',
    'wrong truncate action': live => live[0].permission.at(-1).action = 'ask',
    'double truncate': live => live[0].permission.push(truncate),
    'missing truncate': live => live[0].permission.pop(),
    'later universal reset': live => live[0].permission.push(r('*', 'deny')),
    'extra rule field': live => live[0].permission[0].secret = 'sensitive',
    'invalid prefix': live => live[0].permission.unshift({ permission: 'unknown', pattern: '*', action: ['allow'] }),
    'sparse rules': live => delete live[0].permission[1],
  }
  for (const [label, mutate] of Object.entries(mutations)) {
    test(`rejects ${label}`, () => {
      const live = intended('auto')
      mutate(live)
      expect(() => assertOpenCodeEffectiveAgentPolicies(buildExpectedOpenCodeAgentPolicies(buildManagedConfig(), dataHome), live)).toThrow(error)
    })
  }

  const unsupported: Record<string, (raw: any) => unknown> = {
    'root policy': raw => raw.permission = { '*': 'deny' },
    'missing agent': raw => delete raw.agent.teammate,
    'missing policy': raw => delete raw.agent.teammate.permission,
    'allow reset': raw => raw.agent.teammate.permission['*'] = 'allow',
    'late reset': raw => raw.agent.teammate.permission = { read: 'allow', '*': 'deny' },
    'nested reset': raw => raw.agent.teammate.permission = { '*': { '*': 'deny' } },
    'bad action': raw => raw.agent.teammate.permission.read = 'secret',
    'empty patterns': raw => raw.agent.teammate.permission.read = {},
    'throwing getter': raw => Object.defineProperty(raw.agent.teammate.permission, 'read', { enumerable: true, get() { throw Error('secret') } }),
  }
  for (const [label, mutate] of Object.entries(unsupported)) {
    test(`rejects unsupported ${label} safely`, () => {
      const raw = buildManagedConfig()
      mutate(raw)
      expect(() => buildExpectedOpenCodeAgentPolicies(raw, dataHome)).toThrow(new TypeError(error))
    })
  }
  test('rejects invalid inventory and data path safely', () => {
    for (const live of [null, {}, [null]]) expect(() => assertOpenCodeEffectiveAgentPolicies(buildExpectedOpenCodeAgentPolicies(buildManagedConfig(), dataHome), live)).toThrow(error)
    expect(() => buildExpectedOpenCodeAgentPolicies(buildManagedConfig(), '')).toThrow(error)
  })
})
