/** Compatibility route for OpenCode releases whose embedded models.dev omits the router. */
export const OPEN_CODE_OPENROUTER_FREE_ROUTE = {
  providerId: 'openrouter',
  modelId: 'openrouter/free',
  id: 'openrouter/openrouter/free',
} as const

/** Add only the missing model; user provider options, models and auth stay authoritative. */
export function applyOpenCodeOpenRouterFallback(
  config: Record<string, unknown>,
  selectedProviderId?: string | null,
): void {
  if (selectedProviderId && selectedProviderId !== OPEN_CODE_OPENROUTER_FREE_ROUTE.providerId) return
  const providers = config.provider as Record<string, Record<string, unknown>> | undefined
  const provider = providers?.[OPEN_CODE_OPENROUTER_FREE_ROUTE.providerId]
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
