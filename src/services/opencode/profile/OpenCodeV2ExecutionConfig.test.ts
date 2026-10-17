import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createOpenCodeV2ExecutionConfig, type ExecutionConfigInput } from './OpenCodeV2ExecutionConfig.js'

function input(pin: '2.0.0' | '2.0.21'): ExecutionConfigInput {
  return { pin, selection: { agent: 'bridge-worker', model: { providerID: 'provider', id: 'model', variant: 'selected' },
    permissions: [{ action: '*', resource: '*', effect: 'deny' },
      { action: 'mcp', resource: 'agent-teams/*', effect: 'ask' }] },
    controller: { server: 'agent-teams', config: { type: 'local', command: ['/qualified/bun', '/controller/mcp.ts'],
      environment: { CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:1234' } } } }
}
describe('selected V2 execution document', () => {
  for (const pin of ['2.0.0', '2.0.21'] as const) {
    test(`${pin} preserves selected ask/deny and selected model without ambient config`, () => {
      const source = input(pin), result = createOpenCodeV2ExecutionConfig(source)
      expect<unknown>(result.info.agents?.['bridge-worker']?.permissions).toEqual(source.selection.permissions)
      expect<unknown>(result.info.permissions).toEqual(source.selection.permissions)
      expect(result.info.model).toEqual({ providerID: 'provider', model: 'model', variant: 'selected' })
      expect<unknown>(result.info.mcp?.servers?.['agent-teams']).toEqual({ ...source.controller.config, ...(process.platform === 'win32' ? { disabled: true } : {}) })
      expect(result.sha256).toBe(createHash('sha256').update(result.content).digest('hex'))
      expect(JSON.parse(result.content)).toEqual(result.info)
      expect(source.selection.permissions).toHaveLength(2)
    })
  }
  test('current config preserves selected rule order and intentional duplicates for the native safety suffix', () => {
    const source = input('2.0.21')
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

for (const pin of ['2.0.0', '2.0.21'] as const) test(`${pin} Windows managed MCP defers autostart without accepting a disabled selection`, () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  try {
    Object.defineProperty(process, 'platform', { ...original, value: 'win32' })
    const source = input(pin)
    const result = createOpenCodeV2ExecutionConfig(source)
    const selectedController = source.controller.config
    const expected = selectedController.type === 'local'
      ? { ...selectedController, command: [...selectedController.command], disabled: true }
      : { ...selectedController, disabled: true }
    expect(result.info.mcp?.servers?.['agent-teams']).toEqual(expected)
    expect(source.controller.config.disabled).toBeUndefined()
    source.controller.config.disabled = true
    expect(() => createOpenCodeV2ExecutionConfig(source)).toThrow('v2_execution_mcp_disabled')
  } finally { Object.defineProperty(process, 'platform', original) }
})

import { mapLegacyOpenCodeV2Package, mapSelectedOpenCodeV2Model } from './OpenCodeV2ExecutionConfig.js'

for (const pin of ['2.0.0', '2.0.21'] as const) test(`${pin} real Product empty custom descriptor reaches selected native config without invented catalog metadata`, () => {
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
