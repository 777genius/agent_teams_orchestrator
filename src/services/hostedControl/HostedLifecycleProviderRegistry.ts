import type { HostedLifecycleAction, HostedLifecycleProviderSnapshot } from './HostedLifecycleSnapshot.js'

export type HostedLifecycleScope = { workspaceId: string; teamId: string }
export type HostedLifecycleProviderInspection =
  | { kind: 'owned'; snapshot: HostedLifecycleProviderSnapshot }
  | { kind: 'not_owned' }
  | { kind: 'unavailable' }

export type HostedLifecycleProviderEffectResult =
  | { kind: 'applied'; snapshot: HostedLifecycleProviderSnapshot }
  | { kind: 'not_found' }
  | { kind: 'unavailable' }

/** A provider adapter must be the sole process owner for its lifecycle effects. */
export interface HostedLifecycleProviderAdapter {
  readonly providerId: string
  inspect(scope: HostedLifecycleScope): Promise<HostedLifecycleProviderInspection>
  execute(input: {
    scope: HostedLifecycleScope
    action: HostedLifecycleAction
    commandId: string
    runId: string | null
    expectedProviderGeneration: string
  }): Promise<HostedLifecycleProviderEffectResult>
}

export type HostedLifecycleOwnerResolution =
  | { kind: 'owned'; adapter: HostedLifecycleProviderAdapter; snapshot: HostedLifecycleProviderSnapshot }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; reason: 'provider_unavailable' | 'ambiguous_owner' }

export class HostedLifecycleProviderRegistry {
  readonly #adapters: readonly HostedLifecycleProviderAdapter[]

  constructor(adapters: readonly HostedLifecycleProviderAdapter[]) {
    const ids = adapters.map(adapter => adapter.providerId)
    if (ids.some(id => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) || new Set(ids).size !== ids.length) {
      throw new TypeError('Invalid or duplicate hosted lifecycle provider id')
    }
    this.#adapters = [...adapters]
  }

  async resolve(scope: HostedLifecycleScope): Promise<HostedLifecycleOwnerResolution> {
    const owners: Array<{ adapter: HostedLifecycleProviderAdapter; snapshot: HostedLifecycleProviderSnapshot }> = []
    let unavailable = false
    for (const adapter of this.#adapters) {
      let inspection: HostedLifecycleProviderInspection
      try { inspection = await adapter.inspect(scope) } catch { unavailable = true; continue }
      if (inspection.kind === 'unavailable') unavailable = true
      if (inspection.kind === 'owned') {
        if (inspection.snapshot.providerId !== adapter.providerId) return { kind: 'unavailable', reason: 'provider_unavailable' }
        owners.push({ adapter, snapshot: inspection.snapshot })
      }
    }
    if (owners.length > 1) return { kind: 'unavailable', reason: 'ambiguous_owner' }
    if (unavailable) return { kind: 'unavailable', reason: 'provider_unavailable' }
    return owners[0] ? { kind: 'owned', ...owners[0] } : { kind: 'not_found' }
  }
}
