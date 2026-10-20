import {
  getUserSpecifiedModelSetting,
  parseUserSpecifiedModel,
} from '../../utils/model/model.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import type { RuntimeProviderModelCatalog } from './types.js'

/** Uses the runtime's applied env/settings and alias resolver, without changing explicit selections. */
export function getAnthropicDefaultLaunchModel(
  catalog?: Pick<RuntimeProviderModelCatalog, 'defaultLaunchModel'> | null,
): string | null {
  const provider = getAPIProvider()
  if (provider === 'openai' || provider === 'gemini') return null
  const configured = getUserSpecifiedModelSetting()
  return typeof configured === 'string' && configured.trim()
    ? parseUserSpecifiedModel(configured.trim())
    : catalog?.defaultLaunchModel?.trim() || null
}

export function getAnthropicEffectiveDefaultModel(
  catalog?: Pick<RuntimeProviderModelCatalog, 'defaultLaunchModel'> | null,
): string | null {
  const model = getAnthropicDefaultLaunchModel(catalog)
  if (!model) return null
  // Configured defaults were already resolved above; do not re-interpret a gateway ID as an alias.
  return getUserSpecifiedModelSetting() == null
    ? parseUserSpecifiedModel(model)
    : model
}
