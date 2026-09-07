import { OpenCodeClientFactory, isOpenCodeClientFactoryBoundToCustody } from './OpenCodeClientFactory.js'
import { assertTrustedOpenCodeCustody, type TrustedOpenCodeCustody } from './OpenCodeSupervisedHostCustody.js'
import type { OpenCodeInventorySnapshot } from './types.js'

/** Inventory is read from the admitted running host. No CLI subprocess, profile
 * preparation, auth-store scan or model cache can stand in for these responses. */
export function createOpenCodeSupervisedInventory(custody: TrustedOpenCodeCustody, clients: OpenCodeClientFactory) {
  assertTrustedOpenCodeCustody(custody)
  if (!isOpenCodeClientFactoryBoundToCustody(clients, custody)) {
    throw new Error('OpenCode inventory client custody mismatch')
  }
  const create = clients.create.bind(clients)
  const readProfile = custody.readPreparedProfile.bind(custody)
  const current = custody.assertCurrent.bind(custody)
  const expected = custody.expected
  return Object.freeze({
    async probe(projectPath?: string | null, options: { abortSignal?: AbortSignal } = {}): Promise<OpenCodeInventorySnapshot> {
      if (projectPath && projectPath !== expected.profile.projectPath) {
        throw new Error('OpenCode supervised inventory project mismatch')
      }
      const profile = await readProfile()
      const client = create(expected.endpoint.baseUrl, { signal: options.abortSignal })
      const [health, providers, agents] = await Promise.all([
        client.getHealth!(), client.getProviders(), client.listAgents(),
      ])
      if (!health.healthy || !(await current())) throw new Error('OpenCode supervised inventory unavailable')
      const all = providers.all ?? []
      const connected = providers.connected ?? []
      const models = all.flatMap(provider => provider.id
        ? Object.keys(provider.models ?? {}).map(model => `${provider.id}/${model}`) : [])
      return {
        detected: true, binaryPath: `/proc/${expected.process.pid}/exe`, version: health.version ?? null,
        projectPath: expected.profile.projectPath, profile,
        connectedProviders: connected.map(id => ({ id, authHint: null, source: 'supervised-host' })),
        availableProviders: all.flatMap(provider => provider.id ? [provider.id] : []),
        models: [...new Set(models)].sort(),
        agents: agents.flatMap(agent => agent.name ? [{ id: agent.name,
          mode: agent.mode === 'primary' || agent.mode === 'subagent' ? agent.mode : 'unknown' }] : []),
        authStorePath: null, probeError: null, diagnostics: [],
      }
    },
  })
}
