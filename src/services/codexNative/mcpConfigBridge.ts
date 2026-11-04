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
const REQUIRED_AGENT_TEAMS_MCP_SERVER = 'agent-teams'

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
  fieldPathSegments: string[],
  value: unknown,
): string {
  const fieldPath = [serverName, ...fieldPathSegments]
    .map(encodeCodexConfigKeySegment)
    .join('.')
  return `mcp_servers.${fieldPath}=${toCodexConfigLiteral(value)}`
}

function parseDynamicMcpConfigs(
  configEntries: string[],
): {
  allowedServers: Record<string, ScopedMcpServerConfig>
  fatalErrors: string[]
  hasNonEmptyEntries: boolean
} {
  let mergedConfigs: Record<string, ScopedMcpServerConfig> = {}
  const fatalErrors: string[] = []
  let hasNonEmptyEntries = false

  for (const configItem of configEntries) {
    const trimmed = configItem.trim()
    if (trimmed.length === 0) {
      continue
    }
    hasNonEmptyEntries = true

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
      fatalErrors.push(
        ...result.errors.map(error => {
          const location = error.file ? `${error.file}: ` : ''
          const path = error.path ? `${error.path}: ` : ''
          return `${location}${path}${error.message}`
        }),
      )
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

  return {
    allowedServers: filterMcpServersByPolicy(mergedConfigs).allowed,
    fatalErrors,
    hasNonEmptyEntries,
  }
}

function buildOverridesForServer(
  serverName: string,
  config: McpServerConfig,
): string[] {
  switch (config.type) {
    case undefined:
    case 'stdio': {
      const overrides = [
        buildCodexServerOverride(serverName, ['command'], config.command),
        buildCodexServerOverride(serverName, ['args'], config.args ?? []),
      ]
      if (config.env && Object.keys(config.env).length > 0) {
        overrides.push(
          ...Object.entries(config.env)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) =>
              buildCodexServerOverride(serverName, ['env', key], value),
            ),
        )
      }
      if (serverName === REQUIRED_AGENT_TEAMS_MCP_SERVER) {
        overrides.push(buildCodexServerOverride(serverName, ['required'], true))
      }
      if (AUTO_APPROVE_DYNAMIC_MCP_SERVERS.has(serverName)) {
        overrides.push(
          buildCodexServerOverride(
            serverName,
            ['default_tools_approval_mode'],
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
  strictMcpConfig?: boolean
}): string[] {
  const configEntries = params?.mcpConfigEntries ?? getFlagMcpConfig()
  const { allowedServers, fatalErrors, hasNonEmptyEntries } =
    parseDynamicMcpConfigs(configEntries)
  if (params?.strictMcpConfig && hasNonEmptyEntries && fatalErrors.length > 0) {
    throw new Error(
      `Strict Codex MCP launch could not load dynamic MCP config: ${fatalErrors.join('; ')}`,
    )
  }
  if (
    params?.strictMcpConfig &&
    hasNonEmptyEntries &&
    !allowedServers[REQUIRED_AGENT_TEAMS_MCP_SERVER]
  ) {
    throw new Error(
      'Strict Codex MCP launch did not load the required agent-teams MCP server.',
    )
  }

  return Object.entries(allowedServers)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([serverName, config]) => buildOverridesForServer(serverName, config))
}
