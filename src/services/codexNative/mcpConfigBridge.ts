import { resolve } from 'node:path'

import { getFlagMcpConfig } from '../../bootstrap/state.js'
import { safeParseJSON } from '../../utils/json.js'
import {
  filterMcpServersByPolicy,
  parseMcpConfig,
  parseMcpConfigFromFilePath,
} from '../mcp/config.js'
import type {
  McpServerConfig,
  ScopedMcpServerConfig,
} from '../mcp/types.js'

const AUTO_APPROVE_DYNAMIC_MCP_SERVERS = new Set(['agent-teams'])

function isSimpleCodexConfigKeySegment(segment: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(segment)
}

function encodeCodexConfigKeySegment(segment: string): string {
  return isSimpleCodexConfigKeySegment(segment) ? segment : JSON.stringify(segment)
}

function toCodexConfigLiteral(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (value === null) {
    return 'null'
  }
  return JSON.stringify(value)
}

function buildCodexServerOverride(
  serverName: string,
  fieldPath: string,
  value: unknown,
): string {
  const encodedServerName = encodeCodexConfigKeySegment(serverName)
  return `mcp_servers.${encodedServerName}.${fieldPath}=${toCodexConfigLiteral(value)}`
}

function parseDynamicMcpConfigs(
  configEntries: string[],
): Record<string, ScopedMcpServerConfig> {
  let mergedConfigs: Record<string, ScopedMcpServerConfig> = {}

  for (const configItem of configEntries) {
    const trimmed = configItem.trim()
    if (trimmed.length === 0) {
      continue
    }

    const parsedJson = safeParseJSON(trimmed)
    const result = parsedJson
      ? parseMcpConfig({
          configObject: parsedJson,
          expandVars: true,
          scope: 'dynamic',
          filePath: 'command line',
        })
      : parseMcpConfigFromFilePath({
          filePath: resolve(trimmed),
          expandVars: true,
          scope: 'dynamic',
        })

    if (!result.config) {
      continue
    }

    mergedConfigs = {
      ...mergedConfigs,
      ...Object.fromEntries(
        Object.entries(result.config.mcpServers).map(([serverName, config]) => [
          serverName,
          {
            ...config,
            scope: 'dynamic',
          } satisfies ScopedMcpServerConfig,
        ]),
      ),
    }
  }

  return filterMcpServersByPolicy(mergedConfigs).allowed
}

function buildOverridesForServer(
  serverName: string,
  config: McpServerConfig,
): string[] {
  switch (config.type) {
    case undefined:
    case 'stdio': {
      const overrides = [
        buildCodexServerOverride(serverName, 'command', config.command),
        buildCodexServerOverride(serverName, 'args', config.args ?? []),
      ]
      if (config.env && Object.keys(config.env).length > 0) {
        overrides.push(buildCodexServerOverride(serverName, 'env', config.env))
      }
      if (AUTO_APPROVE_DYNAMIC_MCP_SERVERS.has(serverName)) {
        overrides.push(
          buildCodexServerOverride(
            serverName,
            'default_tools_approval_mode',
            'approve',
          ),
        )
      }
      return overrides
    }
    default:
      return []
  }
}

export function buildCodexNativeMcpConfigOverrides(params?: {
  mcpConfigEntries?: string[]
}): string[] {
  const configEntries = params?.mcpConfigEntries ?? getFlagMcpConfig()
  const allowedServers = parseDynamicMcpConfigs(configEntries)

  return Object.entries(allowedServers)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([serverName, config]) => buildOverridesForServer(serverName, config))
}
