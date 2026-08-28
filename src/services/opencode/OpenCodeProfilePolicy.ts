import { canonicalizeOpenCodeProviderId } from './OpenCodeProviderIdentity.js'
import type { OpenCodeProfileScope } from './types.js'

export type { OpenCodeProfilePurpose, OpenCodeProfileScope } from './types.js'

export type OpenCodeProfilePolicyPlan = {
  scope: OpenCodeProfileScope
  includeAppMcp: boolean
  managedSubscriptionPlugins: readonly string[]
  reconcileAuth: boolean
}

const KIRO_PLUGIN = 'opencode-kiro@0.4.0'
const CURSOR_PLUGIN = '@rama_nigg/open-cursor@2.5.2'

export function planOpenCodeProfilePolicy(input: OpenCodeProfileScope): OpenCodeProfilePolicyPlan {
  const providerId = canonicalizeOpenCodeProviderId(input.providerId)
  const configFingerprint = input.configFingerprint.trim()
  if (!providerId) {
    throw new Error('OpenCode profile scope requires a selected provider')
  }
  if (!configFingerprint) {
    throw new Error('OpenCode profile scope requires a config fingerprint')
  }

  return {
    scope: {
      purpose: input.purpose,
      providerId,
      configFingerprint,
    },
    includeAppMcp: input.purpose === 'launch_runtime',
    managedSubscriptionPlugins:
      providerId === 'kiro'
        ? [KIRO_PLUGIN]
        : providerId === 'cursor-acp'
          ? [CURSOR_PLUGIN]
          : [],
    reconcileAuth: input.purpose !== 'catalog',
  }
}
