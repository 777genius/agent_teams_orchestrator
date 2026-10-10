import { expect, test } from 'bun:test'
import { readConfiguration, readModel, readProvider, readWrapped } from './OpenCodeV2ReadStatus.js'

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
