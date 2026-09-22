import { homedir } from 'node:os'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const CONFIG_FILE_NAME = 'config.toml'
const PROVIDER_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/
const OPENAI_PROVIDER_IDS = new Set(['', 'openai', 'openai-chat', 'openai-responses'])
const MAX_OVERRIDE_LENGTH = 2048
const MAX_OVERRIDES_TOTAL_LENGTH = 8192
const LOOPBACK_TOKEN_ENV_KEY = 'AGENT_TEAMS_CODEX_LOOPBACK_TOKEN'

export type CodexUserLoopbackProvider = {
  providerId: string
  name: string | null
  baseUrl: string
  wireApi: 'responses' | 'chat' | null
  requiresOpenaiAuth: boolean | null
  supportsWebsockets: boolean | null
  streamIdleTimeoutMs: number | null
  requestMaxRetries: number | null
  envKey: string | null
  httpHeaders: Record<string, string>
  experimentalBearerToken: string | null
  defaultModel: string | null
  modelCatalogJsonPath: string | null
}

export type CodexNativeUserLoopbackLaunchConfig = {
  configOverrides: string[]
  secretEnv: Record<string, string>
  overlayToml: string | null
}

type TomlCache = {
  path: string
  mtimeMs: number
  size: number
  text: string
}

let tomlCache: TomlCache | null = null

function defaultCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || path.join(homedir(), '.codex')
}

export function readCodexUserConfigToml(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const filePath = path.join(defaultCodexHome(env), CONFIG_FILE_NAME)
  try {
    const stats = statSync(filePath)
    if (
      tomlCache &&
      tomlCache.path === filePath &&
      tomlCache.mtimeMs === stats.mtimeMs &&
      tomlCache.size === stats.size
    ) {
      return tomlCache.text
    }
    const text = readFileSync(filePath, 'utf8')
    tomlCache = {
      path: filePath,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      text,
    }
    return text
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseTomlDocument(configToml: string): Record<string, unknown> | null {
  try {
    return asRecord(Bun.TOML.parse(configToml))
  } catch {
    return null
  }
}

function parseHttpHeaders(value: unknown): Record<string, string> {
  const record = asRecord(value)
  if (!record) {
    return {}
  }
  const headers: Record<string, string> = {}
  for (const [key, raw] of Object.entries(record)) {
    const headerValue = asString(raw)
    if (!HEADER_NAME_PATTERN.test(key) || !headerValue || headerValue.length > 512) {
      return {}
    }
    headers[key] = headerValue
  }
  return headers
}

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return false
    }
    if (url.username || url.password || url.search || url.hash) {
      return false
    }
    return (
      url.hostname === '127.0.0.1' ||
      url.hostname === 'localhost' ||
      url.hostname === '::1' ||
      url.hostname === '[::1]'
    )
  } catch {
    return false
  }
}

function isSafeLocalCatalogPath(catalogPath: string, env: NodeJS.ProcessEnv): boolean {
  if (!path.isAbsolute(catalogPath) || catalogPath.includes('\0') || catalogPath.includes('..')) {
    return false
  }
  const resolved = path.resolve(catalogPath)
  const allowedRoot = path.resolve(defaultCodexHome(env))
  return resolved === allowedRoot || resolved.startsWith(`${allowedRoot}${path.sep}`)
}

export function parseCodexUserLoopbackProvider(
  configToml: string,
  env: NodeJS.ProcessEnv = process.env,
): CodexUserLoopbackProvider | null {
  const topLevel = parseTomlDocument(configToml)
  if (!topLevel) {
    return null
  }

  const providerId = asString(topLevel.model_provider)
  if (!providerId || OPENAI_PROVIDER_IDS.has(providerId) || !PROVIDER_ID_PATTERN.test(providerId)) {
    return null
  }

  const section = asRecord(asRecord(topLevel.model_providers)?.[providerId])
  const baseUrl = asString(section?.base_url)
  if (!baseUrl || !isLoopbackHttpUrl(baseUrl)) {
    return null
  }

  const wireApiRaw = asString(section?.wire_api)
  const wireApi =
    wireApiRaw === 'responses' || wireApiRaw === 'chat' ? wireApiRaw : null
  const envKey = asString(section?.env_key)
  if (envKey && !ENV_KEY_PATTERN.test(envKey)) {
    return null
  }

  const catalogPath = asString(topLevel.model_catalog_json)
  return {
    providerId,
    name: asString(section?.name),
    baseUrl,
    wireApi,
    requiresOpenaiAuth: asBoolean(section?.requires_openai_auth),
    supportsWebsockets: asBoolean(section?.supports_websockets),
    streamIdleTimeoutMs: asNumber(section?.stream_idle_timeout_ms),
    requestMaxRetries: asNumber(section?.request_max_retries),
    envKey,
    httpHeaders: parseHttpHeaders(section?.http_headers),
    experimentalBearerToken: asString(section?.experimental_bearer_token),
    defaultModel: asString(topLevel.model),
    modelCatalogJsonPath:
      catalogPath && isSafeLocalCatalogPath(catalogPath, env) ? catalogPath : null,
  }
}

function tomlStringOverride(key: string, value: string): string {
  return `${key}=${JSON.stringify(value)}`
}

function isBoundedOverride(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_OVERRIDE_LENGTH &&
    !value.includes('\0') &&
    !value.includes('\n') &&
    !value.includes('\r')
  )
}

function pushOverride(overrides: string[], value: string, totalLength: { value: number }): boolean {
  if (!isBoundedOverride(value)) {
    return false
  }
  const next = totalLength.value + value.length
  if (next > MAX_OVERRIDES_TOTAL_LENGTH) {
    return false
  }
  overrides.push(value)
  totalLength.value = next
  return true
}

function buildSecretOverlayToml(provider: CodexUserLoopbackProvider): string | null {
  const lines = [`[model_providers.${provider.providerId}]`]
  let hasSecret = false
  if (provider.experimentalBearerToken) {
    lines.push(
      `experimental_bearer_token = ${JSON.stringify(provider.experimentalBearerToken)}`,
    )
    hasSecret = true
  }
  const headerEntries = Object.entries(provider.httpHeaders)
  if (headerEntries.length > 0) {
    const headerBody = headerEntries
      .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`)
      .join(', ')
    lines.push(`http_headers = { ${headerBody} }`)
    hasSecret = true
  }
  return hasSecret ? `${lines.join('\n')}\n` : null
}

export function resolveCodexNativeUserLoopbackLaunchConfig(params?: {
  configToml?: string | null
  env?: NodeJS.ProcessEnv
}): CodexNativeUserLoopbackLaunchConfig {
  const empty: CodexNativeUserLoopbackLaunchConfig = {
    configOverrides: [],
    secretEnv: {},
    overlayToml: null,
  }
  const env = params?.env ?? process.env
  const configToml =
    params?.configToml === undefined ? readCodexUserConfigToml(env) : params.configToml
  if (!configToml) {
    return empty
  }

  const provider = parseCodexUserLoopbackProvider(configToml, env)
  if (!provider) {
    return empty
  }

  const prefix = `model_providers.${provider.providerId}`
  const overrides: string[] = []
  const totalLength = { value: 0 }
  const secretEnv: Record<string, string> = {}
  const tokenEnvKey =
    provider.experimentalBearerToken
      ? provider.envKey && ENV_KEY_PATTERN.test(provider.envKey)
        ? provider.envKey
        : LOOPBACK_TOKEN_ENV_KEY
      : null
  if (provider.experimentalBearerToken && tokenEnvKey) {
    secretEnv[tokenEnvKey] = provider.experimentalBearerToken
  }

  const required = [
    tomlStringOverride('model_provider', provider.providerId),
    tomlStringOverride(`${prefix}.base_url`, provider.baseUrl),
  ]
  if (provider.defaultModel) {
    required.push(tomlStringOverride('model', provider.defaultModel))
  }
  if (provider.name) {
    required.push(tomlStringOverride(`${prefix}.name`, provider.name))
  }
  if (provider.wireApi) {
    required.push(`${prefix}.wire_api=${JSON.stringify(provider.wireApi)}`)
  }
  if (provider.requiresOpenaiAuth !== null) {
    required.push(`${prefix}.requires_openai_auth=${provider.requiresOpenaiAuth}`)
  }
  if (provider.supportsWebsockets !== null) {
    required.push(`${prefix}.supports_websockets=${provider.supportsWebsockets}`)
  }
  if (provider.streamIdleTimeoutMs !== null) {
    required.push(`${prefix}.stream_idle_timeout_ms=${provider.streamIdleTimeoutMs}`)
  }
  if (provider.requestMaxRetries !== null) {
    required.push(`${prefix}.request_max_retries=${provider.requestMaxRetries}`)
  }
  if (tokenEnvKey) {
    required.push(tomlStringOverride(`${prefix}.env_key`, tokenEnvKey))
  } else if (provider.envKey) {
    required.push(tomlStringOverride(`${prefix}.env_key`, provider.envKey))
  }
  if (provider.modelCatalogJsonPath) {
    required.push(tomlStringOverride('model_catalog_json', provider.modelCatalogJsonPath))
  }

  for (const override of required) {
    if (!pushOverride(overrides, override, totalLength)) {
      return empty
    }
  }

  return {
    configOverrides: overrides,
    secretEnv,
    overlayToml: buildSecretOverlayToml(provider),
  }
}

export function buildCodexNativeUserLoopbackProviderConfigOverrides(params?: {
  configToml?: string | null
  env?: NodeJS.ProcessEnv
}): string[] {
  return resolveCodexNativeUserLoopbackLaunchConfig(params).configOverrides
}
