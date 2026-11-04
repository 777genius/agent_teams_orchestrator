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
  return typeof configured === 'string'
    ? parseUserSpecifiedModel(configured)
    : catalog?.defaultLaunchModel?.trim() || null
}

export function getAnthropicEffectiveDefaultModel(
  catalog?: Pick<RuntimeProviderModelCatalog, 'defaultLaunchModel'> | null,
): string | null {
  const provider = getAPIProvider()
  if (provider === 'openai' || provider === 'gemini') return null
  const explicit = process.env.ANTHROPIC_MODEL?.trim()
  const candidate =
    explicit ||
    getUserSpecifiedModelSetting()?.trim() ||
    catalog?.defaultLaunchModel?.trim()
  if (!candidate) return null
  const alias = /^(opus|sonnet|haiku)(\[1m\])?$/i.exec(candidate)
  if (alias) {
    const family = alias[1]!.toUpperCase()
    const mapped = process.env[`ANTHROPIC_DEFAULT_${family}_MODEL`]?.trim()
    // Never advertise the runtime's built-in alias mapping as an inherited default.
    return mapped ? mapped + (alias[2] || '') : null
  }
  // Settings and catalog recommendations are not evidence of an environment default.
  return explicit || null
}
