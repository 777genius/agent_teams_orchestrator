import { describe, expect, test } from 'bun:test'

import {
  normalizeOpenCodeLiveConfigProvidersResponse,
  normalizeOpenCodeLiveModelMetadata,
  normalizeOpenCodeLiveProviderAuth,
  normalizeOpenCodeLiveProviderResponse,
} from './OpenCodeLiveProviderNormalizer.js'
import { OPEN_CODE_PROVIDER_ALIAS_ENTRIES } from './OpenCodeProviderIdentity.js'

describe('OpenCode live provider normalization', () => {
  test.each(OPEN_CODE_PROVIDER_ALIAS_ENTRIES)(
    'aligns models, defaults, connections, and auth for alias %s',
    (alias, canonical) => {
      const providers = normalizeOpenCodeLiveProviderResponse({
        all: [{ id: alias, models: { model: { cost: { input: 0, output: 0 } } } }],
        connected: [alias],
        default: { [alias]: 'model' },
      })
      const configProviders = normalizeOpenCodeLiveConfigProvidersResponse({
        providers: [{ id: alias, models: { model: {} } }],
        default: { [alias]: 'model' },
      })
      const auth = normalizeOpenCodeLiveProviderAuth({ [alias]: [{ type: 'api' }] })
      const metadata = normalizeOpenCodeLiveModelMetadata(providers)

      expect(providers.all?.[0]?.id).toBe(canonical)
      expect(providers.connected).toEqual([canonical])
      expect(providers.default).toEqual({ [canonical]: 'model' })
      expect(configProviders.providers?.[0]?.id).toBe(canonical)
      expect(configProviders.default).toEqual({ [canonical]: 'model' })
      expect(auth[canonical]).toEqual([{ type: 'api' }])
      expect(metadata).toContainEqual(expect.objectContaining({
        id: `${canonical}/model`,
        free: true,
      }))
    },
  )
})
