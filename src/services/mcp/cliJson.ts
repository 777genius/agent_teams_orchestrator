import type { ScopedMcpServerConfig } from './types.js'

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

export function getMcpTransport(server: ScopedMcpServerConfig): string {
  if (server.type === 'sse') return 'sse'
  if (server.type === 'http') return 'http'
  if (server.type === 'claudeai-proxy') return 'claudeai-proxy'
  return 'stdio'
}

export function describeMcpServerTarget(server: ScopedMcpServerConfig): string {
  if (server.type === 'sse' || server.type === 'http' || server.type === 'claudeai-proxy') {
    return server.url
  }

  const args = Array.isArray(server.args) ? server.args : []
  return [server.command, ...args].join(' ').trim()
}

export function buildMcpListJsonPayload(
  servers: Record<string, ScopedMcpServerConfig>,
): McpListJsonPayload {
  return {
    schemaVersion: 1,
    servers: Object.entries(servers)
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
    diagnostics,
  }
}
