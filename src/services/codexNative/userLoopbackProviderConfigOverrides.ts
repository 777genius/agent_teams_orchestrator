import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const CONFIG_FILE_NAME = 'config.toml'
const PROVIDER_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/
const OPENAI_PROVIDER_IDS = new Set(['', 'openai', 'openai-chat', 'openai-responses'])
const MAX_OVERRIDE_LENGTH = 2048
const MAX_OVERRIDES_TOTAL_LENGTH = 8192

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

type ParsedTomlValue = string | boolean | number | Record<string, string> | null

function defaultCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || path.join(homedir(), '.codex')
}

export function readCodexUserConfigToml(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  try {
    return readFileSync(path.join(defaultCodexHome(env), CONFIG_FILE_NAME), 'utf8')
  } catch {
    return null
  }
}

function stripInlineComment(line: string): string {
  let inSingle = false
  let inDouble = false
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && inDouble) {
      escaped = true
      continue
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if ((char === '#' || char === ';') && !inSingle && !inDouble) {
      return line.slice(0, index).trimEnd()
    }
  }
  return line
}

function unescapeJsonString(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'string' ? parsed : null
  } catch {
    return null
  }
}

function parseBareString(raw: string): string {
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    if (raw.startsWith('"')) {
      return unescapeJsonString(raw) ?? raw.slice(1, -1)
    }
    return raw.slice(1, -1)
  }
  return raw
}

function parseInlineTable(raw: string): Record<string, string> | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null
  }
  const body = trimmed.slice(1, -1).trim()
  if (!body) {
    return {}
  }
  const entries: Record<string, string> = {}
  const parts: string[] = []
  let current = ''
  let inSingle = false
  let inDouble = false
  let escaped = false
  for (const char of body) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && inDouble) {
      current += char
      escaped = true
      continue
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle
      current += char
      continue
    }
    if (char === '"' && !inSingle) {
      inDouble = !inDouble
      current += char
      continue
    }
    if (char === ',' && !inSingle && !inDouble) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)

  for (const part of parts) {
    const separator = part.indexOf('=')
    if (separator <= 0) {
      return null
    }
    const key = parseBareString(part.slice(0, separator).trim())
    const value = parseBareString(part.slice(separator + 1).trim())
    if (!HEADER_NAME_PATTERN.test(key) || value.length === 0 || value.length > 512) {
      return null
    }
    entries[key] = value
  }
  return entries
}

function parseTomlValue(raw: string): ParsedTomlValue {
  const trimmed = raw.trim()
  if (trimmed === 'true') {
    return true
  }
  if (trimmed === 'false') {
    return false
  }
  if (/^-?\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10)
  }
  if (trimmed.startsWith('{')) {
    return parseInlineTable(trimmed)
  }
  return parseBareString(trimmed)
}

function parseTopLevelAndSections(configToml: string): {
  topLevel: Record<string, ParsedTomlValue>
  sections: Map<string, Record<string, ParsedTomlValue>>
} {
  const topLevel: Record<string, ParsedTomlValue> = {}
  const sections = new Map<string, Record<string, ParsedTomlValue>>()
  let currentSection: string | null = null

  for (const rawLine of configToml.split('\n')) {
    const line = stripInlineComment(rawLine).trim()
    if (!line) {
      continue
    }
    if (line.startsWith('[')) {
      const match = line.match(/^\[([^\]]+)\]$/)
      currentSection = match ? match[1] : null
      continue
    }
    const separator = line.indexOf('=')
    if (separator <= 0) {
      continue
    }
    const key = line.slice(0, separator).trim()
    const value = parseTomlValue(line.slice(separator + 1))
    if (currentSection) {
      const section = sections.get(currentSection) ?? {}
      section[key] = value
      sections.set(currentSection, section)
      continue
    }
    topLevel[key] = value
  }

  return { topLevel, sections }
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

function asString(value: ParsedTomlValue | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asBoolean(value: ParsedTomlValue | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function asNumber(value: ParsedTomlValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isSafeLocalCatalogPath(catalogPath: string, env: NodeJS.ProcessEnv): boolean {
  if (!path.isAbsolute(catalogPath) || catalogPath.includes('\0') || catalogPath.includes('..')) {
    return false
  }
  const resolved = path.resolve(catalogPath)
  const allowedRoots = [path.resolve(defaultCodexHome(env))]
  return allowedRoots.some(
    root => resolved === root || resolved.startsWith(`${root}${path.sep}`),
  )
}

export function parseCodexUserLoopbackProvider(
  configToml: string,
  env: NodeJS.ProcessEnv = process.env,
): CodexUserLoopbackProvider | null {
  const { topLevel, sections } = parseTopLevelAndSections(configToml)
  const providerId = asString(topLevel.model_provider)
  if (!providerId || OPENAI_PROVIDER_IDS.has(providerId) || !PROVIDER_ID_PATTERN.test(providerId)) {
    return null
  }

  const section = sections.get(`model_providers.${providerId}`)
  const baseUrl = asString(section?.base_url)
  if (!baseUrl || !isLoopbackHttpUrl(baseUrl)) {
    return null
  }

  const wireApiRaw = asString(section?.wire_api)
  const wireApi =
    wireApiRaw === 'responses' || wireApiRaw === 'chat' ? wireApiRaw : null
  const httpHeaders =
    section?.http_headers && typeof section.http_headers === 'object'
      ? section.http_headers
      : {}
  const catalogPath = asString(topLevel.model_catalog_json)
  const envKey = asString(section?.env_key)
  if (envKey && !/^[A-Z][A-Z0-9_]{0,63}$/.test(envKey)) {
    return null
  }

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
    httpHeaders,
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

export function buildCodexNativeUserLoopbackProviderConfigOverrides(params?: {
  configToml?: string | null
  env?: NodeJS.ProcessEnv
}): string[] {
  const env = params?.env ?? process.env
  const configToml = params?.configToml === undefined ? readCodexUserConfigToml(env) : params.configToml
  if (!configToml) {
    return []
  }

  const provider = parseCodexUserLoopbackProvider(configToml, env)
  if (!provider) {
    return []
  }

  const prefix = `model_providers.${provider.providerId}`
  const overrides: string[] = []
  const totalLength = { value: 0 }

  const required = [
    tomlStringOverride('model_provider', provider.providerId),
    tomlStringOverride(`${prefix}.base_url`, provider.baseUrl),
  ]
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
  if (provider.envKey) {
    required.push(tomlStringOverride(`${prefix}.env_key`, provider.envKey))
  }
  if (provider.modelCatalogJsonPath) {
    required.push(tomlStringOverride('model_catalog_json', provider.modelCatalogJsonPath))
  }

  if (Object.keys(provider.httpHeaders).length > 0) {
    const headerBody = Object.entries(provider.httpHeaders)
      .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`)
      .join(', ')
    required.push(`${prefix}.http_headers={ ${headerBody} }`)
  }
  if (provider.experimentalBearerToken) {
    required.push(
      tomlStringOverride(`${prefix}.experimental_bearer_token`, provider.experimentalBearerToken),
    )
  }

  for (const override of required) {
    if (!pushOverride(overrides, override, totalLength)) {
      return []
    }
  }

  return overrides
}
