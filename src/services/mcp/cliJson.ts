import type { ScopedMcpServerConfig } from './types.js'

const EXTENSIONS_MANAGED_MCP_SCOPES = new Set([
  'local',
  'user',
  'global',
  'project',
])

const EMBEDDED_HTTP_URL_PATTERN = /https?:\/\/[^\s"'`]+/gi
const SENSITIVE_FLAG_VALUE_PATTERN =
  /(--(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|secret|password|client[-_]?secret))(?:=([^\s]+)|\s+([^\s]+))/gi

export type McpListJsonServer = {
  name: string
  scope: string
  transport: string
  target: string
}

export type McpListJsonPayload = {
  schemaVersion: 1
  servers: McpListJsonServer[]
}

export type McpDiagnoseJsonEntry = {
  name: string
  scope: string
  transport: string
  target: string
  status: 'connected' | 'needs-authentication' | 'failed' | 'timeout'
  statusLabel: string
}

export type McpDiagnoseJsonPayload = {
  schemaVersion: 1
  checkedAt: string
  diagnostics: McpDiagnoseJsonEntry[]
}

export function isExtensionsManagedMcpScope(scope: string): boolean {
  return EXTENSIONS_MANAGED_MCP_SCOPES.has(scope)
}

export function filterExtensionsManagedMcpServers(
  servers: Record<string, ScopedMcpServerConfig>,
): Record<string, ScopedMcpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).filter(([, server]) => isExtensionsManagedMcpScope(server.scope)),
  )
}

export function getMcpTransport(server: ScopedMcpServerConfig): string {
  if (server.type === 'sse') return 'sse'
  if (server.type === 'http') return 'http'
  if (server.type === 'claudeai-proxy') return 'claudeai-proxy'
  return 'stdio'
}

function redactHttpUrl(urlString: string): string {
  try {
    const parsed = new URL(urlString)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return urlString
    }

    if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) {
      return urlString
    }

    if (parsed.username) parsed.username = '***'
    if (parsed.password) parsed.password = '***'

    for (const key of new Set(parsed.searchParams.keys())) {
      parsed.searchParams.set(key, 'REDACTED')
    }

    if (parsed.hash) {
      parsed.hash = 'REDACTED'
    }

    return parsed.toString()
  } catch {
    return urlString
  }
}

export function redactMcpServerTarget(target: string): string {
  return target
    .replace(EMBEDDED_HTTP_URL_PATTERN, match => redactHttpUrl(match))
    .replace(SENSITIVE_FLAG_VALUE_PATTERN, (_match, flag: string, inlineValue?: string) =>
      inlineValue ? `${flag}=REDACTED` : `${flag} REDACTED`,
    )
}

export function describeMcpServerTarget(server: ScopedMcpServerConfig): string {
  if (server.type === 'sse' || server.type === 'http' || server.type === 'claudeai-proxy') {
    return redactMcpServerTarget(server.url)
  }

  const args = Array.isArray(server.args) ? server.args : []
  return redactMcpServerTarget([server.command, ...args].join(' ').trim())
}

export function buildMcpListJsonPayload(
  servers: Record<string, ScopedMcpServerConfig>,
): McpListJsonPayload {
  return {
    schemaVersion: 1,
    servers: Object.entries(filterExtensionsManagedMcpServers(servers))
      .map(([name, server]) => ({
        name,
        scope: server.scope,
        transport: getMcpTransport(server),
        target: describeMcpServerTarget(server),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  }
}

export function buildMcpDiagnoseJsonPayload(
  diagnostics: McpDiagnoseJsonEntry[],
  checkedAt = new Date().toISOString(),
): McpDiagnoseJsonPayload {
  return {
    schemaVersion: 1,
    checkedAt,
    diagnostics: diagnostics.filter(diagnostic => isExtensionsManagedMcpScope(diagnostic.scope)),
  }
}
