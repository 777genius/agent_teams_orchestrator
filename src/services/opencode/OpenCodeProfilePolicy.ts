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
  const selectedAuthIdentity = input.selectedAuthIdentity?.trim()
  const scopeToken = input.scopeToken?.trim() ?? ''
  if (!providerId) {
    throw new Error('OpenCode profile scope requires a selected provider')
  }
  if (!configFingerprint) {
    throw new Error('OpenCode profile scope requires a config fingerprint')
  }
  if (!scopeToken) {
    throw new Error('OpenCode profile scope requires a resolver-issued token')
  }
  if (!selectedAuthIdentity) {
    throw new Error('OpenCode profile scope requires a selected auth identity')
  }

  return {
    scope: {
      purpose: input.purpose,
      providerId,
      configFingerprint,
      selectedAuthIdentity: selectedAuthIdentity as OpenCodeProfileScope['selectedAuthIdentity'],
      scopeToken,
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
