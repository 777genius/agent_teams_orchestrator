import type { OpenCodeReadGeneration } from '../../../../services/opencode/compatibility/OpenCodeGenerationPolicy.js'
import type { OpenCodeV2NativeIdentity } from '../../../../services/opencode/compatibility/OpenCodeNativeIdentity.js'

/** The selected executable, not credentials or a catalog row, owns provider routing.
 * Unsupported/incomplete identities never inherit the V1 route. */
export function requireOpenCodeProviderRoute(selection: {
  readonly policy: OpenCodeReadGeneration
  readonly native: OpenCodeV2NativeIdentity | null
}): 'v1' | 'v2' {
  if (selection.policy.generation === 'v1' && selection.native === null) return 'v1'
  if (selection.policy.generation === 'v2' &&
    selection.native?.version === selection.policy.version) return 'v2'
  throw new Error('opencode_provider_generation_unavailable')
}
