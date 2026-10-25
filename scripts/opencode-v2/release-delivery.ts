import { openCodeV2ReleaseContract } from '../../src/services/opencode/compatibility/OpenCodeV2Registry.js'

/**
 * Whether a runtime release ships OpenCode V2.
 *
 * - `bundled`: the official V2 graphs, the physical JS delivery (`local-cli`) and the pinned Bun
 *   ship beside the compiled front door, which delegates `runtime` and `model list` to them.
 * - `off`: only the compiled runtime ships. Every command runs in it, V1 works as before, and V2
 *   reads and launches are unavailable; the release contract qualifies no V2 version, so a
 *   consumer never treats V2 as eligible.
 *
 * The committed value decides a release: the tag's draft build and its publication build the
 * same source, so they cannot disagree. RUNTIME_OPENCODE_V2 overrides it for CI and local builds.
 */
export type OpenCodeV2ReleaseDelivery = 'bundled' | 'off'
export const OPENCODE_V2_RELEASE_DELIVERY: OpenCodeV2ReleaseDelivery = 'bundled'

export function openCodeV2ReleaseDelivery(env: NodeJS.ProcessEnv = process.env): OpenCodeV2ReleaseDelivery {
  const value = env.RUNTIME_OPENCODE_V2?.trim()
  if (!value) return OPENCODE_V2_RELEASE_DELIVERY
  if (value === 'bundled' || value === 'off') return value
  throw new Error(`Unsupported RUNTIME_OPENCODE_V2: ${value}`)
}

/** The published V2 contract: without V2 in the release, no platform qualifies any version. */
export function releaseOpenCodeV2Contract(delivery: OpenCodeV2ReleaseDelivery = openCodeV2ReleaseDelivery()) {
  const contract = openCodeV2ReleaseContract()
  return delivery === 'bundled'
    ? contract
    : { ...contract, qualified: Object.fromEntries(Object.keys(contract.qualified).map(platform => [platform, []])) }
}

if (import.meta.main) console.log(openCodeV2ReleaseDelivery())
