import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { attachOpenCodeV2SelectedKey } from './OpenCodeV2ExecutionAuth.js'
import type { SelectedExecutionProfile } from './OpenCodeV2ExecutionBinding.js'

const providerID = 'local-lab', modelID = 'qwen-test:0.5b'
const baseURL = 'http://127.0.0.1:31999/v1'
const compatiblePackage = '@opencode/ai/providers/openai-compatible'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

function fixture() {
  const config = {
    model: { providerID, model: modelID, variant: 'default' },
    providers: { [providerID]: { package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL }, models: { [modelID]: {} } } },
  }
  const content = JSON.stringify(config)
  const profile: SelectedExecutionProfile = {
    root: '/TEST-owned-local', epoch: 'TEST-local', directory: '/TEST-owned-project',
    databasePath: '/TEST-owned-local/data/opencode/opencode.db', env: {}, envSha256: digest('{}'),
    config: { directory: '/TEST-owned-local/config/opencode', content, sha256: digest(content) },
    selection: { agent: 'build', model: { providerID, id: modelID, variant: 'default' }, permissions: [] },
  }
  const location = { directory: profile.directory }
  // Official config.provider enables the declared provider and rewrites the AI SDK
  // package to its native compatible adapter. No public key or free price is supplied.
  const provider = { id: providerID, activation: 'enabled', package: compatiblePackage,
    settings: { baseURL, provider: providerID } }
  const model = { id: modelID, modelID, providerID, enabled: true, status: 'active', variants: [],
    cost: [{ input: 7, output: 9, cache: { read: 1, write: 2 } }] }
  let mutations = 0
  const port = {
    providers: async () => ({ location, data: [provider] }),
    integration: async (id: string) => ({ location, data: { id, methods: [{ type: 'key' }], connections: [] } }),
    models: async () => ({ location, data: [model] }),
    connect: async () => { mutations++ },
  }
  return { config, profile, location, provider, model, port, mutations: () => mutations }
}

function withConfig(profile: SelectedExecutionProfile, value: unknown): SelectedExecutionProfile {
  const content = JSON.stringify(value)
  return { ...profile, config: { ...profile.config, content, sha256: digest(content) } }
}

test('declared authless loopback route admits exact native readback without a credential or free-price claim', async () => {
  const f = fixture()
  await attachOpenCodeV2SelectedKey(f.profile, f.port)
  expect(f.mutations()).toBe(0)
})

test('remote declared compatible configuration retains the existing native public/free guard', async () => {
  const f = fixture(), remote = 'https://api.example.test/v1'
  const config = structuredClone(f.config)
  config.providers[providerID]!.settings.baseURL = remote
  await attachOpenCodeV2SelectedKey(withConfig(f.profile, config), {
    ...f.port,
    providers: async () => ({ location: f.location, data: [{ ...f.provider, integrationID: providerID,
      settings: { baseURL: remote, apiKey: 'public' } }] }),
    models: async () => ({ location: f.location, data: [{ ...f.model,
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] }] }),
  })
  expect(f.mutations()).toBe(0)
})

test.each([
  'https://api.example.test/v1', 'http://127.0.0.1.example.test/v1', 'http://127.1/v1',
  'http://2130706433/v1', 'http://user@127.0.0.1/v1', 'file://127.0.0.1/v1',
])('absent auth never admits a declared nonliteral or remote route: %s', async endpoint => {
  const f = fixture()
  const config = structuredClone(f.config)
  config.providers[providerID]!.settings.baseURL = endpoint
  await expect(attachOpenCodeV2SelectedKey(withConfig(f.profile, config), {
    ...f.port, providers: async () => ({ location: f.location, data: [{ ...f.provider, settings: { baseURL: endpoint } }] }),
  })).rejects.toThrow('execution_selected_auth_')
  expect(f.mutations()).toBe(0)
})

test('changed sealed config, undeclared model and model-level endpoint overrides cannot grant local admission', async () => {
  const f = fixture()
  const changed = structuredClone(f.config)
  changed.providers[providerID]!.settings.baseURL = 'http://127.0.0.1:32000/v1'
  const profiles = [
    { ...f.profile, config: { ...f.profile.config, content: JSON.stringify(changed) } },
    withConfig(f.profile, { ...f.config, providers: {} }),
    withConfig(f.profile, { ...f.config, providers: { [providerID]: { ...f.config.providers[providerID], models: {} } } }),
    withConfig(f.profile, { ...f.config, providers: { [providerID]: { ...f.config.providers[providerID],
      models: { [modelID]: { settings: { baseURL: 'https://api.example.test/v1' } } } } } }),
    withConfig(f.profile, { ...f.config, providers: { [providerID]: { ...f.config.providers[providerID],
      models: { [modelID]: { variants: [{ id: 'default', settings: { apiKey: 'TEST-secret' } }] } } } } }),
    ...['body', 'extraBody', 'headers'].map(key => withConfig(f.profile, {
      ...f.config, providers: { [providerID]: { ...f.config.providers[providerID],
        models: { [modelID]: { settings: { [key]: { model: 'foreign', authorization: 'TEST-secret' } } } } } },
    })),
  ]
  for (const profile of profiles) await expect(attachOpenCodeV2SelectedKey(profile, f.port)).rejects.toThrow('execution_')
  expect(f.mutations()).toBe(0)
})

test('native endpoint, package, integration, model or location drift fails closed without credential writes', async () => {
  const f = fixture()
  for (const changed of [
    { ...f.port, providers: async () => ({ location: f.location, data: [{ ...f.provider, activation: 'disabled' }] }) },
    { ...f.port, providers: async () => ({ location: f.location, data: [{ ...f.provider, package: '@opencode/ai/providers/openai' }] }) },
    { ...f.port, providers: async () => ({ location: f.location, data: [{ ...f.provider, integrationID: 'foreign' }] }) },
    { ...f.port, providers: async () => ({ location: f.location, data: [{ ...f.provider, settings: { baseURL: 'http://127.0.0.1:32000/v1' } }] }) },
    { ...f.port, providers: async () => ({ location: f.location, data: [{ ...f.provider, settings: { baseURL, apiKey: 'TEST-secret' } }] }) },
    { ...f.port, providers: async () => ({ location: f.location, data: [f.provider, f.provider] }) },
    { ...f.port, integration: async (id: string) => ({ location: f.location, data: { id, methods: [{ type: 'key' }], connections: [{ type: 'credential', id: 'cred_TEST' }] } }) },
    { ...f.port, integration: async (_id: string) => ({ location: f.location, data: { id: 'foreign', methods: [{ type: 'key' }], connections: [] } }) },
    { ...f.port, models: async () => ({ location: f.location, data: [{ ...f.model, enabled: false }] }) },
    { ...f.port, models: async () => ({ location: f.location, data: [{ ...f.model, modelID: 'foreign' }] }) },
    { ...f.port, models: async () => ({ location: f.location, data: [{ ...f.model, settings: { baseURL: 'https://api.example.test/v1' } }] }) },
    { ...f.port, models: async () => ({ location: f.location, data: [{ ...f.model, headers: { authorization: 'TEST-secret' } }] }) },
    ...['body', 'extraBody', 'headers'].map(key => ({ ...f.port,
      models: async () => ({ location: f.location, data: [{ ...f.model, settings: { [key]: { model: 'foreign', authorization: 'TEST-secret' } } }] }),
    })),
    { ...f.port, models: async () => ({ location: f.location, data: [f.model, f.model] }) },
    { ...f.port, models: async () => ({ location: { directory: '/TEST-other-project' }, data: [f.model] }) },
  ]) await expect(attachOpenCodeV2SelectedKey(f.profile, changed)).rejects.toThrow('execution_selected_auth_')
  expect(f.mutations()).toBe(0)
})
