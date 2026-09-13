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
    return !(Array.isArray(blacklist) && matches(blacklist))
      && (!Array.isArray(whitelist) || matches(whitelist))
  })
}

/** Add only the missing model; user provider options, models and auth stay authoritative. */
export function applyOpenCodeOpenRouterFallback(
  config: Record<string, unknown>,
  selectedProviderId?: string | null,
  selectedAuthenticated = false,
  env: NodeJS.ProcessEnv = {},
): void {
  if (selectedProviderId !== OPEN_CODE_OPENROUTER_FREE_ROUTE.providerId || !selectedAuthenticated) return
  const providers = config.provider as Record<string, Record<string, unknown>> | undefined
  const provider = providers?.[OPEN_CODE_OPENROUTER_FREE_ROUTE.providerId]
  if (!isOpenCodeOpenRouterFreeRouteAllowedInEnvironment(provider ?? {}, env)) return
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

/** Native config substitutes {env:...} in JSON text; ${...} is literal here. */
export function resolveOpenCodeOpenRouterEnvironment(value: unknown, env: NodeJS.ProcessEnv): unknown {
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return undefined
    return JSON.parse(text.replace(/\{env:([^}]+)\}/g, (_, name: string) => {
      const replacement = env[name]
      if (replacement !== undefined && typeof replacement !== 'string') throw new Error()
      return replacement || ''
    }))
  } catch {
    throw new Error('OpenRouter configuration environment could not be resolved')
  }
}

export function resolveOpenCodeOpenRouterRestrictions(
  provider: Record<string, unknown>, env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const restrictions = Object.fromEntries(['whitelist', 'blacklist']
    .filter(key => Object.hasOwn(provider, key)).map(key => [key, provider[key]]))
  return { ...provider, ...resolveOpenCodeOpenRouterEnvironment(restrictions, env) as Record<string, unknown> }
}

/** A configured apiKey shadows every lower-priority credential, including when invalid. */
export function isOpenCodeOpenRouterCredentialOverrideUsable(
  provider: Record<string, unknown>, env: NodeJS.ProcessEnv,
): boolean {
  const options = provider.options
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) return false
  const key = (options as Record<string, unknown> | undefined)?.apiKey
  if (key === undefined) return true
  try {
    const resolved = resolveOpenCodeOpenRouterEnvironment(key, env)
    return typeof resolved === 'string' && resolved.trim().length > 0
  } catch { return false }
}

/** Native precedence: explicit options, API auth store, then provider environment. */
export function hasOpenCodeOpenRouterSelectedCredential(
  provider: Record<string, unknown>, env: NodeJS.ProcessEnv,
  auth: unknown, validatedAuth: boolean,
): boolean {
  if (!isOpenCodeOpenRouterCredentialOverrideUsable(provider, env)) return false
  if ((provider.options as Record<string, unknown> | undefined)?.apiKey !== undefined) return true
  if (auth && typeof auth === 'object' && (auth as Record<string, unknown>).type === 'api') return validatedAuth
  try {
    return typeof env.OPENROUTER_API_KEY === 'string' && env.OPENROUTER_API_KEY.trim().length > 0
  } catch { return false }
}

/** Evaluate raw config once, leaving runtime-owned substitution in the stored config intact. */
export function isOpenCodeOpenRouterFreeRouteAllowedInEnvironment(
  provider: Record<string, unknown>, env: NodeJS.ProcessEnv,
): boolean {
  try { return isOpenCodeOpenRouterFreeRouteAllowed(resolveOpenCodeOpenRouterRestrictions(provider, env)) }
  catch { return false }
}
