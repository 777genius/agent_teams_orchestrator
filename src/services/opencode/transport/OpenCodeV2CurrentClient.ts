import type { CurrentClient } from '../compatibility/OpenCodeV2WireTypes.js'
import type { OpenCodeV2ReadClient } from './OpenCodeV2ClientFactory.js'
import type { OpenCodeBoundedFetch } from './OpenCodeBoundedFetch.js'
import { readRecord } from '../catalog/OpenCodeV2ReadStatus.js'
import { openCodeReadAssert } from './OpenCodeBoundedFetch.js'

export function createOpenCodeV2CurrentClient(client: typeof CurrentClient, baseUrl: string, wire: OpenCodeBoundedFetch): OpenCodeV2ReadClient {
  const sdk = client.OpenCode.make({ baseUrl, fetch: wire.fetch })
  return {
    identity: () => sdk.server.info(),
    urls: async () => (await sdk.server.info()).urls,
    location: directory => sdk.location.get({ location: { directory } }),
    ready: async directory => {
      const result = await sdk.integration.list({ location: { directory } })
      openCodeReadAssert(readRecord(readRecord(result).location).directory === directory, 'identity_mismatch')
      wire.check()
    },
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
