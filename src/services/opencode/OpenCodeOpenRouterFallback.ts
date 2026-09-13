/** Compatibility route for OpenCode releases whose embedded models.dev omits the router. */
export const OPEN_CODE_OPENROUTER_FREE_ROUTE = {
  providerId: 'openrouter',
  modelId: 'openrouter/free',
  id: 'openrouter/openrouter/free',
} as const

/** Restrictions use provider-relative model keys, as OpenCode config does. */
export function isOpenCodeOpenRouterFreeRouteAllowed(...entries: unknown[]): boolean {
  return entries.every(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true
    const { whitelist, blacklist } = entry as Record<string, unknown>
    const matches = (values: unknown[]) => values.includes(OPEN_CODE_OPENROUTER_FREE_ROUTE.modelId)
      || values.includes(OPEN_CODE_OPENROUTER_FREE_ROUTE.id)
    return !(Array.isArray(blacklist) && matches(blacklist))
      && (!Array.isArray(whitelist) || matches(whitelist))
  })
}

/** Add only the missing model; user provider options, models and auth stay authoritative. */
export function applyOpenCodeOpenRouterFallback(
  config: Record<string, unknown>,
  selectedProviderId?: string | null,
  selectedAuthenticated = false,
): void {
  if (selectedProviderId !== OPEN_CODE_OPENROUTER_FREE_ROUTE.providerId || !selectedAuthenticated) return
  const providers = config.provider as Record<string, Record<string, unknown>> | undefined
  const provider = providers?.[OPEN_CODE_OPENROUTER_FREE_ROUTE.providerId]
  if (!isOpenCodeOpenRouterFreeRouteAllowed(provider)) return
  const models = provider?.models as Record<string, unknown> | undefined
  if (models && Object.hasOwn(models, OPEN_CODE_OPENROUTER_FREE_ROUTE.modelId)) return
  config.provider = {
    ...providers,
    [OPEN_CODE_OPENROUTER_FREE_ROUTE.providerId]: {
      ...provider,
      models: {
        ...models,
        [OPEN_CODE_OPENROUTER_FREE_ROUTE.modelId]: {
          name: 'OpenRouter Free Router',
          cost: { input: 0, output: 0 },
        },
      },
    },
  }
}
