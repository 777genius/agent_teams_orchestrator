import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { createOpenCodeV2ExecutionConfig, type ExecutionConfigInput } from './OpenCodeV2ExecutionConfig.js'

function input(pin: '2.0.0' | '2.0.32'): ExecutionConfigInput {
  return { pin, selection: { agent: 'bridge-worker', model: { providerID: 'provider', id: 'model', variant: 'selected' },
    permissions: [{ action: '*', resource: '*', effect: 'deny' },
      { action: 'mcp', resource: 'agent-teams/*', effect: 'ask' }] },
    controller: { server: 'agent-teams', config: { type: 'local', command: ['/qualified/bun', '/controller/mcp.ts'],
      environment: { CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:1234' } } } }
}
describe('selected V2 execution document', () => {
  for (const pin of ['2.0.0', '2.0.32'] as const) {
    test(`${pin} preserves selected ask/deny and selected model without ambient config`, () => {
      const source = input(pin), result = createOpenCodeV2ExecutionConfig(source)
      expect<unknown>(result.info.agents?.['bridge-worker']?.permissions).toEqual(source.selection.permissions)
      expect<unknown>(result.info.permissions).toEqual(source.selection.permissions)
      expect(result.info.model).toEqual({ providerID: 'provider', model: 'model', variant: 'selected' })
      expect<unknown>(result.info.mcp?.servers?.['agent-teams']).toEqual({ ...source.controller.config, codemode: false })
      expect(result.sha256).toBe(createHash('sha256').update(result.content).digest('hex'))
      expect(JSON.parse(result.content)).toEqual(result.info)
      expect(source.selection.permissions).toHaveLength(2)
    })
  }
  test('current config preserves selected rule order and intentional duplicates for the native safety suffix', () => {
    const source = input('2.0.32')
    source.selection = { ...source.selection, permissions: [...source.selection.permissions,
      { action: 'browser', resource: '*', effect: 'deny' },
      { action: 'mcp', resource: 'agent-teams/*', effect: 'ask' }] }
    const selected = structuredClone(source.selection.permissions)
    const result = createOpenCodeV2ExecutionConfig(source)
    expect<unknown>(result.info.permissions).toEqual(selected)
    expect<unknown>(result.info.agents?.['bridge-worker']?.permissions).toEqual(selected)
    expect(source.selection.permissions).toEqual(selected)
  })
  test('empty policy, foreign controller, disabled MCP and remote OAuth fail before acquisition', () => {
    const empty = input('2.0.0'); empty.selection = { ...empty.selection, permissions: [] }
    expect(() => createOpenCodeV2ExecutionConfig(empty)).toThrow('v2_execution_selection_invalid')
    const foreign = input('2.0.0'); foreign.controller.server = 'foreign'
    expect(() => createOpenCodeV2ExecutionConfig(foreign)).toThrow('v2_execution_selection_invalid')
    const disabled = input('2.0.0'); disabled.controller.config.disabled = true
    expect(() => createOpenCodeV2ExecutionConfig(disabled)).toThrow('v2_execution_mcp_disabled')
    const oauth = input('2.0.0'); oauth.controller.config = { type: 'remote', url: 'https://controller.example/mcp' }
    expect(() => createOpenCodeV2ExecutionConfig(oauth)).toThrow('v2_execution_mcp_invalid')
  })
})

for (const pin of ['2.0.0', '2.0.32'] as const) test(`${pin} managed MCP starts enabled on every platform and refuses a disabled selection`, () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  try {
    Object.defineProperty(process, 'platform', { ...original, value: 'win32' })
    const source = input(pin)
    const result = createOpenCodeV2ExecutionConfig(source)
    const selectedController = source.controller.config
    const expected = selectedController.type === 'local'
      ? { ...selectedController, command: [...selectedController.command], codemode: false } : { ...selectedController, codemode: false }
    expect(result.info.mcp?.servers?.['agent-teams']).toEqual(expected)
    source.controller.config.disabled = true
    expect(() => createOpenCodeV2ExecutionConfig(source)).toThrow('v2_execution_mcp_disabled')
  } finally { Object.defineProperty(process, 'platform', original) }
})

import { mapLegacyOpenCodeV2Package, mapSelectedOpenCodeV2Model } from './OpenCodeV2ExecutionConfig.js'

for (const pin of ['2.0.0', '2.0.32'] as const) test(`${pin} real Product empty custom descriptor reaches selected native config without invented catalog metadata`, () => {
  const source = input(pin)
  source.selection = { ...source.selection, model: { providerID: 'groq', id: 'c41-upstream', variant: 'default' } }
  source.provider = { package: mapLegacyOpenCodeV2Package('@ai-sdk/openai-compatible'), baseURL: 'http://127.0.0.1:1234/v1',
    models: mapSelectedOpenCodeV2Model('c41-upstream', {}) }
  const config = JSON.parse(createOpenCodeV2ExecutionConfig(source).content)
  expect(config.providers.groq).toEqual({ package: 'aisdk:@ai-sdk/openai-compatible',
    settings: { baseURL: 'http://127.0.0.1:1234/v1' }, models: { 'c41-upstream': {} } })
  expect(config.model).toEqual({ providerID: 'groq', model: 'c41-upstream', variant: 'default' })
  expect(config.providers.groq.models['c41-catalog']).toBeUndefined()
})

test('selected upstream alias, limits, capabilities and variants preserve supported public schema', () => {
  const models = mapSelectedOpenCodeV2Model('selected', { id: 'upstream', name: 'Selected model', tool_call: true,
    limit: { context: 32000, output: 2048 }, modalities: { input: ['text'], output: ['text'] },
    variants: { high: { reasoningEffort: 'high' } } })
  expect(JSON.parse(JSON.stringify(models))).toEqual({ selected: { modelID: 'upstream', name: 'Selected model',
    limit: { context: 32000, output: 2048 }, capabilities: { tools: true, input: ['text'], output: ['text'] },
    variants: [{ id: 'high', settings: { reasoningEffort: 'high' } }] } })
  for (const unsupported of [{ mystery: true }, { id: 'a', modelID: 'b' }, { limit: { context: 'unbounded' } },
    { capabilities: { tools: false } },
    { capabilities: { tools: true, input: ['text'], output: ['text'], ambient: true } },
    { variants: { high: { disabled: true } } }]) {
    expect(() => mapSelectedOpenCodeV2Model('selected', unsupported)).toThrow()
  }
})

// A bare legacy npm package makes the native resolver demand model(modelID, settings),
// which AI SDK modules do not export (the observed provider.no-route failure).
test('legacy npm selects AISDK while explicit native packages retain their API', () => {
  expect(mapSelectedOpenCodeV2Model('selected', { npm: '@ai-sdk/openai-compatible' }).selected?.package)
    .toBe('aisdk:@ai-sdk/openai-compatible')
  expect(mapSelectedOpenCodeV2Model('selected', { package: '@opencode/ai/providers/openai-compatible' }).selected?.package)
    .toBe('@opencode/ai/providers/openai-compatible')
  expect(mapLegacyOpenCodeV2Package('aisdk:@ai-sdk/openai-compatible')).toBe('aisdk:@ai-sdk/openai-compatible')
  expect(() => mapSelectedOpenCodeV2Model('selected', { npm: 42 })).toThrow('v2_selected_model_package_invalid')
  expect(() => mapSelectedOpenCodeV2Model('selected', { npm: '@ai-sdk/openai-compatible', package: '@opencode/ai/providers/openai-compatible' }))
    .toThrow('v2_selected_model_alias_conflict')
})

test('V2 teammates never get more than V1 teammates in auto approval mode', async () => {
  const { buildOpenCodeTeammatePermission } = await import('../OpenCodeProfileManager.js')
  const { OPENCODE_V2_TEAMMATE_PERMISSIONS } = await import('./OpenCodeV2ExecutionConfig.js')
  const v1 = buildOpenCodeTeammatePermission('auto')
  // V2 names the same tools differently; V1-only tools have no V2 counterpart.
  const v2Action: Record<string, string> = { bash: 'shell', write: 'edit', task: 'subagent' }
  const v1Allowed = new Set(Object.entries(v1).filter(([, effect]) => effect === 'allow').map(([tool]) => v2Action[tool] ?? tool))
  expect(Object.keys(v1).some(tool => /^agent[-_]teams_/.test(tool) && v1[tool] === 'allow')).toBe(true)
  const rules = OPENCODE_V2_TEAMMATE_PERMISSIONS
  // Last match wins: a leading catch-all deny makes every unlisted tool (webfetch, websearch, skill, ...) denied.
  expect(rules[0]).toEqual({ action: '*', resource: '*', effect: 'deny' })
  expect(v1['*']).toBe('deny')
  for (const rule of rules.slice(1)) {
    expect(rule.resource).toBe('*')
    if (rule.effect === 'allow') expect([rule.action, v1Allowed.has(rule.action)]).toEqual([rule.action, true])
  }
  // V1 denies subagents and paths outside the project; V2 keeps both denied after every allow.
  expect(v1.external_directory).toBe('deny')
  expect((v1.task as Record<string, unknown>)['*']).toBe('deny')
  for (const action of ['subagent', 'external_directory']) {
    const last = rules.findLast(rule => rule.action === action || rule.action === '*')
    expect([action, last?.effect]).toEqual([action, 'deny'])
  }
})

test('V2 code mode stays off and team MCP tools are direct tools, under every staged official evaluator', async () => {
  const { OPENCODE_V2_TEAMMATE_PERMISSIONS: rules } = await import('./OpenCodeV2ExecutionConfig.js')
  for (const version of ['2.0.0', '2.0.32', '2.1.4']) {
    const server = path.dirname(Bun.resolveSync(`@opencode/server-v${version}/package.json`, import.meta.dir))
    const { Permission } = await import(Bun.resolveSync('@opencode/core/permission', server))
    const effect = (action: string, resource = '*') => [version, action, Permission.evaluate(action, resource, rules).effect]
    // Code mode is wholly denied: its fetch and worktree tools skip permission checks.
    expect(effect('execute')).toEqual([version, 'execute', 'deny'])
    // A project's own MCP servers stay wholly denied.
    for (const foreign of ['github_create_issue', 'filesystem_read_file', 'TEST-server_run']) expect(effect(foreign)).toEqual([version, foreign, 'deny'])
    for (const [action, resource] of [['webfetch', 'https://example.invalid'], ['websearch', 'TEST'], ['skill', 'TEST'],
      ['subagent', 'general'], ['external_directory', '/etc/*'], ['question', '*'], ['doom_loop', '*']]) {
      expect(effect(action, resource)).toEqual([version, action, 'deny'])
    }
    for (const [action, resource] of [['agent-teams_message_send', '*'], ['agent_teams_task_complete', '*'],
      ['shell', 'git status'], ['edit', '/TEST/project/file.txt'], ['read', '/TEST/project/file.txt']]) {
      expect(effect(action, resource)).toEqual([version, action, 'allow'])
    }
  }
  const { createOpenCodeV2ExecutionConfig } = await import('./OpenCodeV2ExecutionConfig.js')
  const document = createOpenCodeV2ExecutionConfig({ pin: '2.1.4', selection: { agent: 'worker',
    model: { providerID: 'provider', id: 'model' }, permissions: rules.map(rule => ({ ...rule })) },
    controller: { server: 'agent-teams', config: { type: 'local', command: ['/TEST/bun', '/TEST/mcp.ts'] } } })
  expect(document.info.mcp?.servers?.['agent-teams']).toMatchObject({ codemode: false })
})

// Pins the routing the rule above relies on, for the qualified 2.1.4 core: a server's
// `codemode: false` reaches its tools, such tools are direct, and code mode needs `execute`.
test('qualified 2.1.4 core keeps codemode-false MCP tools direct and gates code mode on execute', async () => {
  const server = path.dirname(Bun.resolveSync('@opencode/server-v2.1.4/package.json', import.meta.dir))
  const chunks = path.join(path.dirname(Bun.resolveSync('@opencode/core/permission', server)), 'chunks')
  const source = (await Promise.all((await readdir(chunks)).filter(name => name.endsWith('.js'))
    .map(name => readFile(path.join(chunks, name), 'utf8')))).join('\n')
  expect(source).toMatch(/\.\.\.entry\.config\.codemode === undefined \? \{\} : \{ codemode: entry\.config\.codemode \}/)
  expect(source).toMatch(/codemode: tool\.codemode !== false/)
  expect(source).toMatch(/const direct = new Map\(Array\.from\(active\)\.filter\(\(\[, tool\]\) => tool\.options\?\.codemode === false\)\);/)
  expect(source).toMatch(/if \(whollyDisabled\(tool\.options\?\.permission \?\? name, rules\)\)\s*continue;/)
  expect(source).toMatch(/const codeModeEnabled = !whollyDisabled\("execute", rules\);/)
  expect(source).toMatch(/permission\.assert\(\{\s*action: \w+\(tool\.server, tool\.name\),/)
})
