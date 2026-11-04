import { expect, test } from 'bun:test'
import { readConfiguration, readIntegration, readModel, readProvider, readWrapped } from './OpenCodeV2ReadStatus.js'

// Authored contract inputs from the official declarations; these are decoder proofs, not native acceptance.
test('catalog ID, upstream ID and variants stay distinct without provider/model secrets', () => {
  const secret = 'test-fixture-literal'
  const provider = readProvider({ id: 'catalog-provider', integrationID: 'different-integration', activation: 'enabled',
    settings: { apiKey: secret }, headers: { authorization: secret }, body: { token: secret } })
  const model = readModel({ id: 'catalog-id', modelID: 'upstream-id', providerID: provider.id, enabled: true, status: 'active',
    capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 8192, output: 512 },
    variants: [{ id: 'reasoning', settings: { token: secret }, body: { secret } }], settings: { secret }, headers: { secret } })
  expect(provider.integrationId).toBe('different-integration')
  expect(model).toMatchObject({ catalogId: 'catalog-id', upstreamModelId: 'upstream-id', variants: ['reasoning'] })
  expect(JSON.stringify({ provider, model })).not.toContain(secret)
})

test('effective config is a union array and foreign location wrappers reject', () => {
  expect(readConfiguration([{ type: 'document', info: { providers: { TEST: { settings: { apiKey: 'TEST-secret' } } } } },
    { type: 'directory', path: '/private/config' }])).toEqual({ documents: 1, directories: 1 })
  expect(() => readConfiguration({ provider: {} })).toThrow()
  expect(() => readConfiguration([{ type: 'future', info: {} }])).toThrow()
  expect(() => readWrapped({ location: { directory: '/OTHER' }, data: [] }, '/TEST', 'project')).toThrow()
})

test('integration discovery retains public identity and only the form-free key capability', () => {
  const row = { id: 'opencode-go', name: 'OpenCode Go', methods: [{ type: 'key' },
    { type: 'env', names: ['TEST-secret'] }], connections: [{ type: 'credential', id: 'TEST-private' }],
    metadata: { token: 'TEST-secret' } }
  expect(readIntegration(row)).toEqual({ id: 'opencode-go', name: 'OpenCode Go', plainKey: true })
  for (const methods of [[{ type: 'oauth' }], [{ type: 'key', form: null }], [{ type: 'key', form: {} }]]) {
    expect(readIntegration({ ...row, methods }).plainKey).toBe(false)
  }
  expect(() => readIntegration({ ...row, methods: null })).toThrow()
  expect(() => readIntegration({ ...row, connections: null })).toThrow()
})

test('floor configuration accepts its native agents and Claude directory tags without exposing their paths', () => {
  const entries = [{ type: 'agents', path: '/TEST/private-agents' }, { type: 'claude', path: '/TEST/private-claude' },
    { type: 'directory', path: '/TEST/private-config' }, { type: 'document', info: {} }]
  expect(readConfiguration(entries, '2.0.0')).toEqual({ documents: 1, directories: 3 })
  expect(() => readConfiguration(entries, '2.0.32')).toThrow()
  expect(() => readConfiguration(entries, '2.1.4')).toThrow()
  expect(() => readConfiguration([{ type: 'agents', path: null }], '2.0.0')).toThrow()
  expect(() => readConfiguration([{ type: 'future', path: '/TEST' }], '2.0.0')).toThrow()
})
