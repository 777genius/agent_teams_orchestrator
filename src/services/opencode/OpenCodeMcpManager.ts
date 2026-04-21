import path from 'node:path'

import { openCodeClientFactory } from './OpenCodeClientFactory.js'

import type {
  OpenCodeAppMcpLaunchSource,
  OpenCodeAppMcpSummary,
  OpenCodeMcpResponse,
  OpenCodeMcpServerConfig,
  OpenCodeMcpStatusEntry,
} from './types.js'

export const OPEN_CODE_APP_MCP_SERVER_NAME = 'agent-teams'
const OPEN_CODE_APP_MCP_SERVER_ALIASES = [
  OPEN_CODE_APP_MCP_SERVER_NAME,
  'agent_teams',
] as const
const OPEN_CODE_APP_MCP_TIMEOUT_MS = 8_000
const OPEN_CODE_APP_MCP_VERIFY_TIMEOUT_MS = 5_000
const OPEN_CODE_APP_MCP_VERIFY_POLL_MS = 250
const OPEN_CODE_MCP_ENTRY_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY'
const OPEN_CODE_MCP_COMMAND_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND'
const OPEN_CODE_MCP_ENVIRONMENT_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'CLAUDE_TEAM_CONTROL_URL',
] as const

export type ResolvedAppMcpLaunchConfig = {
  source: OpenCodeAppMcpLaunchSource
  config: OpenCodeMcpServerConfig
}

type OpenCodeMcpClient = {
  getMcp(): Promise<OpenCodeMcpResponse>
  addMcp?(name: string, config: OpenCodeMcpServerConfig): Promise<OpenCodeMcpResponse>
}

type OpenCodeMcpManagerDeps = {
  clientFactory?: {
    create(baseUrl: string): OpenCodeMcpClient
  }
  resolveLaunchConfig?: () => Promise<ResolvedAppMcpLaunchConfig>
  pathExists?: (targetPath: string) => Promise<boolean>
  env?: NodeJS.ProcessEnv
  sleepMs?: (ms: number) => Promise<void>
  verifyTimeoutMs?: number
  verifyPollMs?: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

async function defaultPathExists(targetPath: string): Promise<boolean> {
  try {
    await Bun.file(targetPath).exists()
    return true
  } catch {
    return false
  }
}

function getWorkspaceRoot(): string {
  return path.resolve(import.meta.dir, '../../../../')
}

function resolveNodeCommand(): string {
  return Bun.which('node') ?? 'node'
}

function buildForwardedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const forwarded: Record<string, string> = {}
  for (const key of OPEN_CODE_MCP_ENVIRONMENT_ALLOWLIST) {
    const value = env[key]
    if (typeof value !== 'string' || value.length === 0) {
      continue
    }
    forwarded[key] = value
  }
  return forwarded
}

export async function resolveOpenCodeAppMcpLaunchConfig(deps: {
  env?: NodeJS.ProcessEnv
  pathExists?: (targetPath: string) => Promise<boolean>
} = {}): Promise<ResolvedAppMcpLaunchConfig> {
  const env = deps.env ?? process.env
  const pathExists = deps.pathExists ?? defaultPathExists
  const forwardedEnvironment = buildForwardedEnvironment(env)
  const commandOverride = asString(env[OPEN_CODE_MCP_COMMAND_ENV])
  const entryOverride = asString(env[OPEN_CODE_MCP_ENTRY_ENV])

  if (entryOverride) {
    const absoluteEntry = path.resolve(entryOverride)
    return {
      source: 'env-override',
      config: {
        type: 'local',
        command: [commandOverride ?? resolveNodeCommand(), absoluteEntry],
        environment: forwardedEnvironment,
        enabled: true,
        timeout: OPEN_CODE_APP_MCP_TIMEOUT_MS,
      },
    }
  }

  const workspaceRoot = getWorkspaceRoot()
  const builtEntry = path.join(
    workspaceRoot,
    'claude_team',
    'mcp-server',
    'dist',
    'index.js',
  )
  if (await pathExists(builtEntry)) {
    return {
      source: 'workspace-dist',
      config: {
        type: 'local',
        command: [resolveNodeCommand(), builtEntry],
        environment: forwardedEnvironment,
        enabled: true,
        timeout: OPEN_CODE_APP_MCP_TIMEOUT_MS,
      },
    }
  }

  const sourceEntry = path.join(
    workspaceRoot,
    'claude_team',
    'mcp-server',
    'src',
    'index.ts',
  )
  const tsxCandidates = [
    path.join(workspaceRoot, 'claude_team', 'mcp-server', 'node_modules', '.bin', 'tsx'),
    path.join(workspaceRoot, 'claude_team', 'node_modules', '.bin', 'tsx'),
    path.join(workspaceRoot, 'node_modules', '.bin', 'tsx'),
  ]

  if (await pathExists(sourceEntry)) {
    for (const tsxBinary of tsxCandidates) {
      if (!(await pathExists(tsxBinary))) {
        continue
      }

      return {
        source: 'workspace-src',
        config: {
          type: 'local',
          command: [tsxBinary, sourceEntry],
          environment: forwardedEnvironment,
          enabled: true,
          timeout: OPEN_CODE_APP_MCP_TIMEOUT_MS,
        },
      }
    }
  }

  throw new Error(
    [
      'Unable to resolve the agent-teams MCP entrypoint for OpenCode dynamic attach',
      `Set ${OPEN_CODE_MCP_ENTRY_ENV} to override the entrypoint path if needed.`,
    ].join(' '),
  )
}

function getMcpServerNames(mcp: OpenCodeMcpResponse): string[] {
  return Object.keys(asRecord(mcp) ?? {}).sort()
}

function getMatchedAppMcpEntry(mcp: OpenCodeMcpResponse): {
  matchedServerName: string | null
  entry: OpenCodeMcpStatusEntry | null
} {
  const record = asRecord(mcp) ?? {}
  for (const serverName of OPEN_CODE_APP_MCP_SERVER_ALIASES) {
    const entry = asRecord(record[serverName])
    if (entry) {
      return {
        matchedServerName: serverName,
        entry,
      }
    }
  }
  return {
    matchedServerName: null,
    entry: null,
  }
}

function inferMcpConnected(entry: OpenCodeMcpStatusEntry | null): boolean | null {
  if (!entry) {
    return null
  }
  if (typeof entry.connected === 'boolean') {
    return entry.connected
  }

  const stateValue =
    asString(entry.status)
    ?? asString(entry.state)
    ?? asString(entry.connection)
    ?? asString(entry.health)

  if (!stateValue) {
    return null
  }

  const normalizedState = stateValue.toLowerCase()
  if (
    normalizedState === 'connected'
    || normalizedState === 'ready'
    || normalizedState === 'healthy'
    || normalizedState === 'active'
  ) {
    return true
  }

  if (
    normalizedState === 'disconnected'
    || normalizedState === 'failed'
    || normalizedState === 'error'
    || normalizedState === 'disabled'
  ) {
    return false
  }

  return null
}

export class OpenCodeMcpManager {
  constructor(private readonly deps: OpenCodeMcpManagerDeps = {}) {}

  private get clientFactory() {
    return this.deps.clientFactory ?? openCodeClientFactory
  }

  private async sleepMs(ms: number): Promise<void> {
    if (this.deps.sleepMs) {
      await this.deps.sleepMs(ms)
      return
    }
    await new Promise(resolve => setTimeout(resolve, ms))
  }

  private get verifyTimeoutMs(): number {
    return this.deps.verifyTimeoutMs ?? OPEN_CODE_APP_MCP_VERIFY_TIMEOUT_MS
  }

  private get verifyPollMs(): number {
    return this.deps.verifyPollMs ?? OPEN_CODE_APP_MCP_VERIFY_POLL_MS
  }

  private async resolveLaunchConfig(): Promise<ResolvedAppMcpLaunchConfig> {
    if (this.deps.resolveLaunchConfig) {
      return this.deps.resolveLaunchConfig()
    }

    return resolveOpenCodeAppMcpLaunchConfig({
      env: this.deps.env,
      pathExists: this.deps.pathExists,
    })
  }

  async ensureAppMcp(params: {
    baseUrl: string
    attachIfMissing?: boolean
  }): Promise<{
    mcp: OpenCodeMcpResponse
    summary: OpenCodeAppMcpSummary
  }> {
    const client = this.clientFactory.create(params.baseUrl)
    const existingMcp = await client.getMcp()
    const existingMatch = getMatchedAppMcpEntry(existingMcp)

    if (existingMatch.matchedServerName) {
      return {
        mcp: existingMcp,
        summary: {
          serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
          matchedServerName: existingMatch.matchedServerName,
          status: 'present',
          connected: inferMcpConnected(existingMatch.entry),
          launchSource: null,
          availableServerNames: getMcpServerNames(existingMcp),
          diagnostics: [],
        },
      }
    }

    if (!params.attachIfMissing) {
      return {
        mcp: existingMcp,
        summary: {
          serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
          matchedServerName: null,
          status: 'missing',
          connected: null,
          launchSource: null,
          availableServerNames: getMcpServerNames(existingMcp),
          diagnostics: ['OpenCode host is missing the app-owned agent-teams MCP server'],
        },
      }
    }

    const launchConfig = await this.resolveLaunchConfig()
    if (typeof client.addMcp !== 'function') {
      return {
        mcp: existingMcp,
        summary: {
          serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
          matchedServerName: null,
          status: 'attach_failed',
          connected: null,
          launchSource: launchConfig.source,
          availableServerNames: getMcpServerNames(existingMcp),
          diagnostics: ['OpenCode client does not expose dynamic MCP attach support'],
        },
      }
    }

    try {
      await client.addMcp(OPEN_CODE_APP_MCP_SERVER_NAME, launchConfig.config)
      let refreshedMcp = await client.getMcp()
      let refreshedMatch = getMatchedAppMcpEntry(refreshedMcp)
      const verifyStartedAt = Date.now()

      while (
        !refreshedMatch.matchedServerName
        && Date.now() - verifyStartedAt < this.verifyTimeoutMs
      ) {
        await this.sleepMs(this.verifyPollMs)
        refreshedMcp = await client.getMcp()
        refreshedMatch = getMatchedAppMcpEntry(refreshedMcp)
      }

      if (!refreshedMatch.matchedServerName) {
        return {
          mcp: refreshedMcp,
          summary: {
            serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
            matchedServerName: null,
            status: 'attach_failed',
            connected: null,
            launchSource: launchConfig.source,
            availableServerNames: getMcpServerNames(refreshedMcp),
            diagnostics: [
              `OpenCode accepted the app MCP attach request, but the MCP server is still absent from /mcp after ${this.verifyTimeoutMs}ms`,
            ],
          },
        }
      }

      return {
        mcp: refreshedMcp,
        summary: {
          serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
          matchedServerName: refreshedMatch.matchedServerName,
          status: 'attached',
          connected: inferMcpConnected(refreshedMatch.entry),
          launchSource: launchConfig.source,
          availableServerNames: getMcpServerNames(refreshedMcp),
          diagnostics: [],
        },
      }
    } catch (error) {
      return {
        mcp: existingMcp,
        summary: {
          serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
          matchedServerName: null,
          status: 'attach_failed',
          connected: null,
          launchSource: launchConfig.source,
          availableServerNames: getMcpServerNames(existingMcp),
          diagnostics: [
            error instanceof Error ? error.message : String(error),
          ],
        },
      }
    }
  }
}

export const openCodeMcpManager = new OpenCodeMcpManager()
