import type { ProviderConnection } from './types.js'

const RECOMMENDED_PROVIDER_ORDER = new Map<string, number>([
  ['openrouter', 0],
  ['opencode', 1],
  ['openai', 2],
  ['anthropic', 3],
  ['ollama', 4],
])

function getRecommendedRank(providerId: string): number {
  return RECOMMENDED_PROVIDER_ORDER.get(providerId) ?? Number.POSITIVE_INFINITY
}

function getStateRank(provider: ProviderConnection): number {
  if (provider.state === 'connected') return 0
  if (provider.state === 'available') return 1
  if (provider.state === 'not-connected') return 2
  if (provider.state === 'ignored') return 3
  return 4
}

export function isRecommendedProvider(providerId: string): boolean {
  return RECOMMENDED_PROVIDER_ORDER.has(providerId)
}

export function sortProviderConnections(
  providers: readonly ProviderConnection[],
): ProviderConnection[] {
  return [...providers].sort((left, right) => {
    const leftRecommendedRank = getRecommendedRank(left.providerId)
    const rightRecommendedRank = getRecommendedRank(right.providerId)
    if (leftRecommendedRank !== rightRecommendedRank) {
      return leftRecommendedRank - rightRecommendedRank
    }

    const stateRank = getStateRank(left) - getStateRank(right)
    if (stateRank !== 0) {
      return stateRank
    }

    return left.displayName.localeCompare(right.displayName)
  })
}
