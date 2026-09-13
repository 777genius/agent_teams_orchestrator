import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

/** Same 1 MiB bound as profile authority files. */
const OPEN_CODE_AUTHORITY_FILE_MAX_BYTES = 1024 * 1024

function readReferenceFile(file: string): string {
  const before = statSync(file)
  if (!before.isFile() || before.size > OPEN_CODE_AUTHORITY_FILE_MAX_BYTES) throw new Error()
  // Nonblocking open also closes the stat/open FIFO replacement race.
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.size > OPEN_CODE_AUTHORITY_FILE_MAX_BYTES) throw new Error()
    const bytes = Buffer.alloc(OPEN_CODE_AUTHORITY_FILE_MAX_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (!count) break
      length += count
    }
    if (length > OPEN_CODE_AUTHORITY_FILE_MAX_BYTES) throw new Error()
    return bytes.subarray(0, length).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** Compatibility route for OpenCode releases whose embedded models.dev omits the router. */
export const OPEN_CODE_OPENROUTER_FREE_ROUTE = {
  providerId: 'openrouter',
  modelId: 'openrouter/free',
  id: 'openrouter/openrouter/free',
} as const

/** Restrictions use provider-relative model keys, as OpenCode config does. */
export function isOpenCodeOpenRouterFreeRouteAllowed(...entries: unknown[]): boolean {
  return entries.every(entry => {
    if (entry === undefined) return true
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    const { whitelist, blacklist } = entry as Record<string, unknown>
    if ([whitelist, blacklist].some(value => value !== undefined
      && (!Array.isArray(value) || value.some(item => typeof item !== 'string')))) return false
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
export function resolveOpenCodeOpenRouterEnvironment(
  value: unknown, env: NodeJS.ProcessEnv, referenceDigests?: string[],
): unknown {
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return undefined
    return JSON.parse(text.replace(/\{env:([^}]+)\}/g, (_, name: string) => {
      const replacement = env[name]
      if (replacement !== undefined && typeof replacement !== 'string') throw new Error()
      return replacement || ''
    }).replace(/\{file:([^}]+)\}/g, (_, name: string) => {
      const file = name.startsWith('~/') ? path.join(env.HOME || env.USERPROFILE || '', name.slice(2)) : name
      const content = readReferenceFile(file)
      referenceDigests?.push(createHash('sha256').update(JSON.stringify([file, content])).digest('hex'))
      return JSON.stringify(content.trim()).slice(1, -1)
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
  provider: Record<string, unknown>, env: NodeJS.ProcessEnv, resolved = false,
): boolean {
  const options = provider.options
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) return false
  const key = (options as Record<string, unknown> | undefined)?.apiKey
  if (key === undefined) return true
  try {
    const credential = resolved ? key : resolveOpenCodeOpenRouterEnvironment(key, env)
    return typeof credential === 'string' && credential.trim().length > 0
  } catch { return false }
}

/** Auth.all (OpenCode v1.18.4 / v1.18.29, src/auth/index.ts): only parsed nonempty inline
 * content replaces disk auth. Valid JSON of an invalid shape still replaces it. */
export function readOpenCodeInlineAuthContent(env: NodeJS.ProcessEnv): { value: unknown } | null {
  if (!env.OPENCODE_AUTH_CONTENT) return null
  try { return { value: JSON.parse(env.OPENCODE_AUTH_CONTENT) } }
  catch { return null }
}

/** Native src/provider/provider.ts assigns provider.key only for a single env
 * name. The pinned @openrouter/ai-sdk-provider 2.9.0 otherwise uses OPENROUTER_API_KEY. */
function selectedOpenRouterEnvironment(provider: Record<string, unknown>, env: NodeJS.ProcessEnv): [string, string | undefined] | null {
  const names = provider.env ?? ['OPENROUTER_API_KEY']
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) return null
  const name = names.length === 1 && env[names[0]] ? names[0] : 'OPENROUTER_API_KEY'
  return [name, env[name]]
}

/** Native precedence: explicit options, API auth store, then provider environment. */
export function hasOpenCodeOpenRouterSelectedCredential(
  provider: Record<string, unknown>, env: NodeJS.ProcessEnv,
  auth: unknown, validatedAuth: boolean, resolved = false,
): boolean {
  if (!resolved) {
    try {
      const effective = resolveOpenCodeOpenRouterEnvironment(provider, env) as Record<string, unknown>
      return hasOpenCodeOpenRouterSelectedCredential(effective, env, auth, validatedAuth, true)
    } catch { return false }
  }
  if (!isOpenCodeOpenRouterCredentialOverrideUsable(provider, env, resolved)) return false
  if ((provider.options as Record<string, unknown> | undefined)?.apiKey !== undefined) return true
  const inline = readOpenCodeInlineAuthContent(env)
  if (inline) {
    const store = inline.value
    if (!store || typeof store !== 'object' || Array.isArray(store)) return false
    auth = null
    if (Object.hasOwn(store, 'openrouter')) {
      const entry = (store as Record<string, unknown>).openrouter as Record<string, unknown> | null
      return entry?.type === 'api' && typeof entry.key === 'string' && !!entry.key.trim()
    }
  }
  if (auth && typeof auth === 'object' && (auth as Record<string, unknown>).type === 'api') return validatedAuth
  try {
    const credential = selectedOpenRouterEnvironment(provider, env)?.[1]
    return typeof credential === 'string' && !!credential.trim()
  } catch { return false }
}

/** Evaluate raw config once, leaving runtime-owned substitution in the stored config intact. */
export function isOpenCodeOpenRouterFreeRouteAllowedInEnvironment(
  provider: Record<string, unknown>, env: NodeJS.ProcessEnv,
): boolean {
  try { return isOpenCodeOpenRouterFreeRouteAllowed(resolveOpenCodeOpenRouterRestrictions(provider, env)) }
  catch { return false }
}

/** Validate before safe-config projection can erase malformed provider shapes. */
export function validateOpenCodeOpenRouterConfig(config: Record<string, unknown>): void {
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value)
  if (config.provider === undefined) return
  if (!record(config.provider)) throw new Error('OpenRouter provider configuration is invalid')
  const provider = config.provider.openrouter
  if (provider === undefined) return
  if (!record(provider)) throw new Error('OpenRouter provider configuration is invalid')
  for (const key of ['whitelist', 'blacklist']) {
    const value = provider[key]
    if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) {
      throw new Error('OpenRouter model restriction configuration is invalid')
    }
  }
  if (provider.options !== undefined && !record(provider.options)) {
    throw new Error('OpenRouter options configuration is invalid')
  }
  if (provider.env !== undefined && (!Array.isArray(provider.env)
    || provider.env.some(name => typeof name !== 'string'))) {
    throw new Error('OpenRouter credential environment configuration is invalid')
  }
}

/** Read the selected materialized auth store, never infer credentials from native membership. */
export function readOpenCodeOpenRouterCredentialEvidence(authPath?: string): unknown {
  if (!authPath) return null
  try {
    const store = JSON.parse(readFileSync(authPath, 'utf8'))
    if (!store || typeof store !== 'object' || Array.isArray(store)) throw new Error()
    return store.openrouter ?? null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    // An unreadable selected store must not fall through to environment credentials.
    return { type: 'api', key: '' }
  }
}

export function hasOpenCodeOpenRouterCatalogCredential(
  provider: Record<string, unknown>, env: NodeJS.ProcessEnv, auth: unknown, resolved = false,
): boolean {
  const entry = auth as Record<string, unknown> | null
  return hasOpenCodeOpenRouterSelectedCredential(provider, env, auth,
    !!entry && entry.type === 'api' && typeof entry.key === 'string' && !!entry.key.trim(), resolved)
}

/** Bind resolved decisions and credentials without putting secret values in cache keys. */
export function openCodeOpenRouterEligibilityIdentity(
  provider: Record<string, unknown>, env: NodeJS.ProcessEnv, auth: unknown,
  resolved = false, referenceDigests: readonly string[] = [],
): string {
  const references = [...referenceDigests]
  let effective: Record<string, unknown>
  try {
    effective = resolved ? provider
      : resolveOpenCodeOpenRouterEnvironment(provider, env, references) as Record<string, unknown>
  } catch { effective = { whitelist: [], options: 'invalid' } }
  const credentialEnvironment = selectedOpenRouterEnvironment(effective, env)
  return createHash('sha256').update(JSON.stringify([
    effective.whitelist, effective.blacklist, effective.options, references,
    auth, env.OPENCODE_AUTH_CONTENT, effective.env, credentialEnvironment,
    hasOpenCodeOpenRouterCatalogCredential(effective, env, auth, true),
    isOpenCodeOpenRouterFreeRouteAllowed(effective),
  ])).digest('hex')
}
