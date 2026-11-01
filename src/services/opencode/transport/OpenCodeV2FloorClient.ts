import type { FloorClient } from '../compatibility/OpenCodeV2WireTypes.js'
import type { OpenCodeV2ReadClient } from './OpenCodeV2ClientFactory.js'
import type { OpenCodeBoundedFetch } from './OpenCodeBoundedFetch.js'

export function createOpenCodeV2FloorClient(client: typeof FloorClient, baseUrl: string, wire: OpenCodeBoundedFetch): OpenCodeV2ReadClient {
  const sdk = client.OpenCode.make({ baseUrl, fetch: wire.fetch })
  return {
    identity: () => sdk.health.get(),
    urls: async () => (await sdk.server.get()).urls,
    location: directory => sdk.location.get({ location: { directory } }),
    ready: async directory => { await sdk.plugin.awaitActivation({ location: { directory } }); wire.check() },
    models: directory => sdk.model.list({ location: { directory } }),
    integrations: directory => sdk.integration.list({ location: { directory } }),
    defaultModel: directory => sdk.model.default({ location: { directory } }),
    providers: directory => sdk.provider.list({ location: { directory } }),
    provider: (directory, providerID) => sdk.provider.get({ location: { directory }, providerID }),
    agents: directory => sdk.agent.list({ location: { directory } }),
    agent: (directory, agentID) => sdk.agent.get({ location: { directory }, agentID }),
    config: directory => sdk.config.get({ location: { directory } }),
  }
}
