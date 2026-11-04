import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'

import { openCodeClientFactory } from './OpenCodeClientFactory.js'
import {
  CLAUDE_MULTIMODEL_CACHE_HOME_ENV,
  CLAUDE_MULTIMODEL_DATA_HOME_ENV,
} from './OpenCodeManagedPaths.js'

import type {
  OpenCodeClientRequestContext,
} from './OpenCodeClientFactory.js'
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
const OPEN_CODE_APP_MCP_TIMEOUT_MS = 30_000
const OPEN_CODE_APP_MCP_VERIFY_TIMEOUT_MS = 5_000
const OPEN_CODE_APP_MCP_VERIFY_POLL_MS = 250
const OPEN_CODE_MCP_ENTRY_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY'
const OPEN_CODE_MCP_COMMAND_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND'
const OPEN_CODE_MCP_ARGS_JSON_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON'
const OPEN_CODE_MCP_ENV_JSON_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON'
const OPEN_CODE_MCP_URL_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL'
const AGENT_TEAMS_MCP_CLAUDE_DIR_ENV = 'AGENT_TEAMS_MCP_CLAUDE_DIR'
const CLAUDE_TEAM_CONTROL_URL_ENV = 'CLAUDE_TEAM_CONTROL_URL'
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
  CLAUDE_TEAM_CONTROL_URL_ENV,
  AGENT_TEAMS_MCP_CLAUDE_DIR_ENV,
  CLAUDE_MULTIMODEL_DATA_HOME_ENV,
  CLAUDE_MULTIMODEL_CACHE_HOME_ENV,
] as const
const OPEN_CODE_MCP_ENVIRONMENT_IDENTITY_KEYS = [
  CLAUDE_TEAM_CONTROL_URL_ENV,
  AGENT_TEAMS_MCP_CLAUDE_DIR_ENV,
  CLAUDE_MULTIMODEL_DATA_HOME_ENV,
  CLAUDE_MULTIMODEL_CACHE_HOME_ENV,
] as const

export type ResolvedAppMcpLaunchConfig = {
  source: OpenCodeAppMcpLaunchSource
  config: OpenCodeMcpServerConfig
}

type OpenCodeMcpClient = {
  getConfig?(): Promise<unknown>
  getMcp(): Promise<OpenCodeMcpResponse>
  addMcp?(name: string, config: OpenCodeMcpServerConfig): Promise<OpenCodeMcpResponse>
  connectMcp?(name: string): Promise<OpenCodeMcpResponse>
}

type OpenCodeMcpManagerDeps = {
  clientFactory?: {
    create(baseUrl: string, context?: OpenCodeClientRequestContext): OpenCodeMcpClient
  }
  resolveLaunchConfig?: () => Promise<ResolvedAppMcpLaunchConfig>
  pathExists?: (targetPath: string) => Promise<boolean>
  env?: NodeJS.ProcessEnv
  sleepMs?: (ms: number) => Promise<void>
  verifyTimeoutMs?: number
  verifyPollMs?: number
}

type EnsureAppMcpResult = {
  mcp: OpenCodeMcpResponse
  summary: OpenCodeAppMcpSummary
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

function parseArgsJson(value: string | null): string[] | null {
  if (!value) {
    return null
  }
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) {
      return null
    }
    const args = parsed
      .map(item => asString(item))
      .filter((item): item is string => Boolean(item))
    return args.length > 0 ? args : null
  } catch {
    return null
  }
}

function parseMcpRemoteUrl(value: string | null): string | null {
  if (!value) {
    return null
  }
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }
    return parsed.toString()
  } catch {
    return null
  }
}

function parseMcpEnvironmentJson(value: string | null): Record<string, string> {
  if (!value) {
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error(
      `${OPEN_CODE_MCP_ENV_JSON_ENV} must be a JSON object with string values: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  const record = asRecord(parsed)
  if (!record) {
    throw new Error(`${OPEN_CODE_MCP_ENV_JSON_ENV} must be a JSON object with string values`)
  }

  const result: Record<string, string> = {}
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw !== 'string') {
      throw new Error(`${OPEN_CODE_MCP_ENV_JSON_ENV} value for ${key} must be a string`)
    }
    result[key] = raw
  }
  return result
}

function getMcpEnvironmentJsonKeys(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(parseMcpEnvironmentJson(asString(env[OPEN_CODE_MCP_ENV_JSON_ENV])))
}

function hasOpenCodeLocalMcpLaunchOverride(env: NodeJS.ProcessEnv): boolean {
  return [
    OPEN_CODE_MCP_COMMAND_ENV,
    OPEN_CODE_MCP_ENTRY_ENV,
    OPEN_CODE_MCP_ARGS_JSON_ENV,
  ].some(key => asString(env[key]) !== null)
}

function asStringRecord(value: unknown): Record<string, string> | null {
  const record = asRecord(value)
  if (!record) {
    return null
  }
  const result: Record<string, string> = {}
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw !== 'string') {
      continue
    }
    result[key] = raw
  }
  return result
}

async function defaultPathExists(targetPath: string): Promise<boolean> {
  try {
    return await Bun.file(targetPath).exists()
  } catch {
    return false
  }
}

function readTextFileSync(targetPath: string): string | null {
  try {
    return readFileSync(targetPath, 'utf8')
  } catch {
    return null
  }
}

export function resolveOpenCodeBridgeRepoRootForStartDir(
  startDir: string,
  deps: {
    pathExists?: (targetPath: string) => boolean
    readText?: (targetPath: string) => string | null
  } = {},
): string | null {
  const pathExists = deps.pathExists ?? existsSync
  const readText = deps.readText ?? readTextFileSync
  let current = path.resolve(startDir)

  while (true) {
    const packageJsonPath = path.join(current, 'package.json')
    if (pathExists(packageJsonPath)) {
      try {
        const parsed = JSON.parse(readText(packageJsonPath) ?? '{}') as { name?: unknown }
        if (parsed.name === 'claude-multimodel') {
          return current
        }
      } catch {
        // Keep walking: parent directories may contain the real runtime package.
      }
    }

    const parent = path.dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}

function getOpenCodeBridgeRepoRoot(): string {
  const argvEntrypoint =
    typeof process.argv[1] === 'string' && process.argv[1].trim().length > 0
      ? path.dirname(process.argv[1])
      : null
  const candidateStartDirs = [import.meta.dir, argvEntrypoint].filter(
    (value): value is string => Boolean(value),
  )

  for (const startDir of candidateStartDirs) {
    const repoRoot = resolveOpenCodeBridgeRepoRootForStartDir(startDir)
    if (repoRoot) {
      return repoRoot
    }
  }

  return path.resolve(import.meta.dir, '../../..')
}

function getRuntimeUserHome(env: NodeJS.ProcessEnv): string | null {
  const explicitHome = asString(env.USERPROFILE) ?? asString(env.HOME)
  if (explicitHome) {
    return path.resolve(explicitHome)
  }

  const homeDrive = asString(env.HOMEDRIVE)
  const homePath = asString(env.HOMEPATH)
  if (homeDrive && homePath) {
    return path.resolve(`${homeDrive}${homePath}`)
  }

  const fallbackHome = os.homedir()
  return fallbackHome ? path.resolve(fallbackHome) : null
}

function resolveAgentTeamsMcpClaudeDir(env: NodeJS.ProcessEnv): string | null {
  const explicitClaudeDir = asString(env[AGENT_TEAMS_MCP_CLAUDE_DIR_ENV])
  if (explicitClaudeDir) {
    return path.resolve(explicitClaudeDir)
  }

  const home = getRuntimeUserHome(env)
  return home ? path.join(home, '.claude') : null
}

export function getCandidateClaudeTeamRootsForBridgeRoot(bridgeRepoRoot: string): string[] {
  const bridgeRepoName = path.basename(bridgeRepoRoot)
  const pairedWorktreeSuffix = bridgeRepoName.startsWith('agent_teams_orchestrator')
    ? bridgeRepoName.slice('agent_teams_orchestrator'.length)
    : null
  const pairedWorktreeNames = pairedWorktreeSuffix === null
    ? []
    : [
        `claude_team${pairedWorktreeSuffix}`,
        `claude_agent_teams_ui${pairedWorktreeSuffix}`,
      ]
  const candidates = [
    ...pairedWorktreeNames.map(name =>
      path.resolve(path.dirname(bridgeRepoRoot), name),
    ),
    path.resolve(bridgeRepoRoot, '../claude_agent_teams_ui'),
    path.resolve(bridgeRepoRoot, '../claude_team'),
    path.resolve(bridgeRepoRoot, '../../claude_agent_teams_ui'),
    path.resolve(bridgeRepoRoot, '../../claude_team'),
  ]
  return [...new Set(candidates)]
}

function getCandidateClaudeTeamRoots(): string[] {
  return getCandidateClaudeTeamRootsForBridgeRoot(getOpenCodeBridgeRepoRoot())
}

function resolveNodeCommand(): string {
  return Bun.which('node') ?? 'node'
}

function getTsxBinaryCandidates(claudeTeamRoot: string): string[] {
  const candidates = [
    path.join(claudeTeamRoot, 'mcp-server', 'node_modules', '.bin', 'tsx'),
    path.join(claudeTeamRoot, 'node_modules', '.bin', 'tsx'),
    path.join(path.dirname(claudeTeamRoot), 'node_modules', '.bin', 'tsx'),
  ]

  if (process.platform !== 'win32') {
    return candidates
  }

  return candidates.flatMap(candidate => [`${candidate}.cmd`, candidate])
}

async function buildTsxSourceCommand(
  tsxBinary: string,
  sourceEntry: string,
  pathExists: (targetPath: string) => Promise<boolean>,
): Promise<string[]> {
  const tsxCliEntry = path.resolve(
    path.dirname(tsxBinary),
    '..',
    'tsx',
    'dist',
    'cli.mjs',
  )

  if (await pathExists(tsxCliEntry)) {
    return [resolveNodeCommand(), tsxCliEntry, sourceEntry]
  }

  return [tsxBinary, sourceEntry]
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
  const agentTeamsClaudeDir = resolveAgentTeamsMcpClaudeDir(env)
  if (agentTeamsClaudeDir && !forwarded[AGENT_TEAMS_MCP_CLAUDE_DIR_ENV]) {
    forwarded[AGENT_TEAMS_MCP_CLAUDE_DIR_ENV] = agentTeamsClaudeDir
  }
  return forwarded
}

function buildLocalMcpEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    ...buildForwardedEnvironment(env),
    ...parseMcpEnvironmentJson(asString(env[OPEN_CODE_MCP_ENV_JSON_ENV])),
  }
}

export async function resolveOpenCodeAppMcpLaunchConfig(deps: {
  env?: NodeJS.ProcessEnv
  pathExists?: (targetPath: string) => Promise<boolean>
} = {}): Promise<ResolvedAppMcpLaunchConfig> {
  const env = deps.env ?? process.env
  const pathExists = deps.pathExists ?? defaultPathExists
  const remoteUrlOverrideRaw = asString(env[OPEN_CODE_MCP_URL_ENV])
  const remoteUrlOverride = parseMcpRemoteUrl(remoteUrlOverrideRaw)
  const commandOverride = asString(env[OPEN_CODE_MCP_COMMAND_ENV])
  const entryOverride = asString(env[OPEN_CODE_MCP_ENTRY_ENV])
  const argsOverride = parseArgsJson(asString(env[OPEN_CODE_MCP_ARGS_JSON_ENV]))

  if (remoteUrlOverrideRaw && !remoteUrlOverride) {
    throw new Error(`${OPEN_CODE_MCP_URL_ENV} must be an http(s) URL`)
  }

  if (remoteUrlOverride) {
    return {
      source: 'env-override',
      config: {
        type: 'remote',
        url: remoteUrlOverride,
        enabled: true,
        timeout: OPEN_CODE_APP_MCP_TIMEOUT_MS,
        oauth: false,
      },
    }
  }

  if (argsOverride) {
    const localEnvironment = buildLocalMcpEnvironment(env)
    return {
      source: 'env-override',
      config: {
        type: 'local',
        command: [
          commandOverride ?? resolveNodeCommand(),
          ...argsOverride,
        ],
        environment: localEnvironment,
        enabled: true,
        timeout: OPEN_CODE_APP_MCP_TIMEOUT_MS,
      },
    }
  }

  if (entryOverride) {
    const absoluteEntry = path.resolve(entryOverride)
    const localEnvironment = buildLocalMcpEnvironment(env)
    return {
      source: 'env-override',
      config: {
        type: 'local',
        command: [commandOverride ?? resolveNodeCommand(), absoluteEntry],
        environment: localEnvironment,
        enabled: true,
        timeout: OPEN_CODE_APP_MCP_TIMEOUT_MS,
      },
    }
  }

  const forwardedEnvironment = buildForwardedEnvironment(env)
  for (const claudeTeamRoot of getCandidateClaudeTeamRoots()) {
    const builtEntry = path.join(claudeTeamRoot, 'mcp-server', 'dist', 'index.js')
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
  }

  for (const claudeTeamRoot of getCandidateClaudeTeamRoots()) {
    const sourceEntry = path.join(claudeTeamRoot, 'mcp-server', 'src', 'index.ts')
    const tsxCandidates = getTsxBinaryCandidates(claudeTeamRoot)

    if (await pathExists(sourceEntry)) {
      for (const tsxBinary of tsxCandidates) {
        if (!(await pathExists(tsxBinary))) {
          continue
        }

        return {
          source: 'workspace-src',
          config: {
            type: 'local',
            command: await buildTsxSourceCommand(
              tsxBinary,
              sourceEntry,
              pathExists,
            ),
            environment: forwardedEnvironment,
            enabled: true,
            timeout: OPEN_CODE_APP_MCP_TIMEOUT_MS,
          },
        }
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

function getMatchedAppMcpConfigEntry(config: unknown): OpenCodeMcpStatusEntry | null {
  const record = asRecord(config)
  const mcp = asRecord(record?.mcp)
  if (!mcp) {
    return null
  }

  for (const serverName of OPEN_CODE_APP_MCP_SERVER_ALIASES) {
    const entry = asRecord(mcp[serverName])
    if (entry) {
      return entry
    }
  }
  return null
}

function getEntryEnvironment(entry: OpenCodeMcpStatusEntry | null): Record<string, string> | null {
  const candidates = [
    entry,
    asRecord(entry?.config),
    asRecord(entry?.server),
    asRecord(entry?.options),
  ]
  for (const candidate of candidates) {
    const environment = asStringRecord(candidate?.environment)
    if (environment) {
      return environment
    }
  }
  return null
}

function getEntryCommand(entry: OpenCodeMcpStatusEntry | null): string[] | null {
  const candidates = [
    entry,
    asRecord(entry?.config),
    asRecord(entry?.server),
    asRecord(entry?.options),
  ]
  for (const candidate of candidates) {
    const command = candidate?.command
    if (!Array.isArray(command)) {
      continue
    }
    const normalized = command.filter((part): part is string => typeof part === 'string')
    if (normalized.length === command.length && normalized.length > 0) {
      return normalized
    }
  }
  return null
}

function getEntryUrl(entry: OpenCodeMcpStatusEntry | null): string | null {
  const candidates = [
    entry,
    asRecord(entry?.config),
    asRecord(entry?.server),
    asRecord(entry?.options),
  ]
  for (const candidate of candidates) {
    const url = parseMcpRemoteUrl(asString(candidate?.url))
    if (url) {
      return url
    }
  }
  return null
}

function shouldVerifyExistingAppMcpConfig(
  entry: OpenCodeMcpStatusEntry | null,
  client: OpenCodeMcpClient,
  env: NodeJS.ProcessEnv,
  attachIfMissing?: boolean,
): boolean {
  if (attachIfMissing !== true) {
    return false
  }

  if (
    asString(env[OPEN_CODE_MCP_URL_ENV]) !== null
    || hasOpenCodeLocalMcpLaunchOverride(env)
    || OPEN_CODE_MCP_ENVIRONMENT_IDENTITY_KEYS.some(key => {
      const value = env[key]
      return typeof value === 'string' && value.length > 0
    })
  ) {
    return true
  }

  return (
    typeof client.getConfig === 'function'
    && getEntryCommand(entry) === null
    && getEntryEnvironment(entry) === null
    && getEntryUrl(entry) === null
  )
}

function appMcpConfigMatchesRequiredRuntime(
  entry: OpenCodeMcpStatusEntry | null,
  desiredConfig: OpenCodeMcpServerConfig,
  options: { requiredEnvironmentKeys?: readonly string[] } = {},
): { ok: boolean; reason: string | null } {
  const desiredEnvironment = desiredConfig.environment ?? {}
  const desiredIdentityKeys = OPEN_CODE_MCP_ENVIRONMENT_IDENTITY_KEYS.filter(key =>
    typeof desiredEnvironment[key] === 'string' && desiredEnvironment[key].length > 0,
  )
  const desiredIdentityKeySet = new Set<string>(desiredIdentityKeys)
  const requiredEnvironmentKeys = Array.from(new Set([
    ...desiredIdentityKeys,
    ...(options.requiredEnvironmentKeys ?? []).filter(
      key => typeof desiredEnvironment[key] === 'string',
    ),
  ]))
  const entryEnvironment = getEntryEnvironment(entry)

  for (const key of requiredEnvironmentKeys) {
    if (!entryEnvironment) {
      return {
        ok: false,
        reason: `existing app MCP config does not expose environment; ${key} cannot be verified`,
      }
    }
    if (entryEnvironment[key] !== desiredEnvironment[key]) {
      return {
        ok: false,
        reason: desiredIdentityKeySet.has(key)
          ? `existing app MCP ${key} does not match current runtime root`
          : `existing app MCP ${key} does not match current MCP child environment`,
      }
    }
  }

  const desiredCommand = desiredConfig.command
  const entryCommand = getEntryCommand(entry)
  if (desiredCommand?.length && entryCommand) {
    if (desiredCommand.join('\0') !== entryCommand.join('\0')) {
      return {
        ok: false,
        reason: 'existing app MCP command does not match current launch command',
      }
    }
  }

  const desiredUrl = parseMcpRemoteUrl(asString(desiredConfig.url))
  if (desiredUrl) {
    const entryUrl = getEntryUrl(entry)
    if (entryUrl !== desiredUrl) {
      return {
        ok: false,
        reason: 'existing app MCP URL does not match current launch URL',
      }
    }
  }

  return { ok: true, reason: null }
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
  private readonly ensureAppMcpInFlight = new Map<string, Promise<EnsureAppMcpResult>>()

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
    requestContext?: OpenCodeClientRequestContext
  }): Promise<EnsureAppMcpResult> {
    if (params.requestContext) {
      return this.ensureAppMcpOnce(params)
    }
    const cacheKey = `${params.baseUrl}::${params.attachIfMissing === true ? 'attach' : 'read'}`
    const inFlight = this.ensureAppMcpInFlight.get(cacheKey)
    if (inFlight) {
      return inFlight
    }

    const work = this.ensureAppMcpOnce(params).finally(() => {
      if (this.ensureAppMcpInFlight.get(cacheKey) === work) {
        this.ensureAppMcpInFlight.delete(cacheKey)
      }
    })
    this.ensureAppMcpInFlight.set(cacheKey, work)
    return work
  }

  private async ensureAppMcpOnce(params: {
    baseUrl: string
    attachIfMissing?: boolean
    requestContext?: OpenCodeClientRequestContext
  }): Promise<EnsureAppMcpResult> {
    const client = this.clientFactory.create(params.baseUrl, params.requestContext)
    const existingMcp = await client.getMcp()
    const existingMatch = getMatchedAppMcpEntry(existingMcp)

    if (existingMatch.matchedServerName) {
      const connected = inferMcpConnected(existingMatch.entry)
      let launchConfig: ResolvedAppMcpLaunchConfig | null = null
      const currentEnv = this.deps.env ?? process.env
      const shouldVerifyExistingConfig = shouldVerifyExistingAppMcpConfig(
        existingMatch.entry,
        client,
        currentEnv,
        params.attachIfMissing,
      )
      if (shouldVerifyExistingConfig) {
        launchConfig = await this.resolveLaunchConfig()
        const requiredEnvironmentKeys =
          launchConfig.source === 'env-override' && launchConfig.config.type === 'local'
            ? getMcpEnvironmentJsonKeys(currentEnv)
            : []
        let compatibility = appMcpConfigMatchesRequiredRuntime(
          existingMatch.entry,
          launchConfig.config,
          { requiredEnvironmentKeys },
        )
        if (!compatibility.ok && typeof client.getConfig === 'function') {
          try {
            const configEntry = getMatchedAppMcpConfigEntry(await client.getConfig())
            if (configEntry) {
              const configCompatibility = appMcpConfigMatchesRequiredRuntime(
                configEntry,
                launchConfig.config,
                { requiredEnvironmentKeys },
              )
              if (configCompatibility.ok) {
                compatibility = configCompatibility
              }
            }
          } catch {
            // Best effort: fall back to the /mcp compatibility result.
          }
        }
        if (!compatibility.ok) {
          if (typeof client.addMcp !== 'function') {
            return {
              mcp: existingMcp,
              summary: {
                serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
                matchedServerName: existingMatch.matchedServerName,
                status: 'attach_failed',
                connected,
                launchSource: launchConfig.source,
                availableServerNames: getMcpServerNames(existingMcp),
                diagnostics: [
                  `OpenCode app MCP server ${existingMatch.matchedServerName} is stale: ${compatibility.reason}`,
                  'OpenCode client does not expose dynamic MCP attach support',
                ],
              },
            }
          }
          try {
            await client.addMcp(OPEN_CODE_APP_MCP_SERVER_NAME, launchConfig.config)
            const refreshedMcp = await this.waitForMcpConnected(
              client,
              OPEN_CODE_APP_MCP_SERVER_NAME,
            )
            const refreshedMatch = getMatchedAppMcpEntry(refreshedMcp)
            const refreshedConnected = inferMcpConnected(refreshedMatch.entry)
            return {
              mcp: refreshedMcp,
              summary: {
                serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
                matchedServerName: refreshedMatch.matchedServerName,
                status: 'attached',
                connected: refreshedConnected,
                launchSource: launchConfig.source,
                availableServerNames: getMcpServerNames(refreshedMcp),
                diagnostics: refreshedConnected === true
                  ? [`Reattached stale OpenCode app MCP server: ${compatibility.reason}`]
                  : [
                      `Reattached stale OpenCode app MCP server: ${compatibility.reason}`,
                      `OpenCode app MCP server ${OPEN_CODE_APP_MCP_SERVER_NAME} did not report connected after reattach`,
                    ],
              },
            }
          } catch (error) {
            return {
              mcp: existingMcp,
              summary: {
                serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
                matchedServerName: existingMatch.matchedServerName,
                status: 'attach_failed',
                connected,
                launchSource: launchConfig.source,
                availableServerNames: getMcpServerNames(existingMcp),
                diagnostics: [
                  `OpenCode app MCP server ${existingMatch.matchedServerName} is stale: ${compatibility.reason}`,
                  `OpenCode app MCP reattach failed: ${error instanceof Error ? error.message : String(error)}`,
                ],
              },
            }
          }
        }
      }
      if (connected !== true && params.attachIfMissing && typeof client.connectMcp === 'function') {
        try {
          await client.connectMcp(existingMatch.matchedServerName)
          const connectedMcp = await this.waitForMcpConnected(client, existingMatch.matchedServerName)
          const connectedMatch = getMatchedAppMcpEntry(connectedMcp)
          const refreshedConnected = inferMcpConnected(connectedMatch.entry)
          return {
            mcp: connectedMcp,
            summary: {
              serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
              matchedServerName: connectedMatch.matchedServerName,
              status: refreshedConnected === true ? 'attached' : 'present',
              connected: refreshedConnected,
              launchSource: launchConfig?.source ?? null,
              availableServerNames: getMcpServerNames(connectedMcp),
              diagnostics: refreshedConnected === true
                ? []
                : [`OpenCode app MCP server ${existingMatch.matchedServerName} did not report connected after connect`],
            },
          }
        } catch (error) {
          if (typeof client.addMcp === 'function') {
            try {
              launchConfig ??= await this.resolveLaunchConfig()
              await client.addMcp(OPEN_CODE_APP_MCP_SERVER_NAME, launchConfig.config)
              const refreshedMcp = await this.waitForMcpConnected(
                client,
                OPEN_CODE_APP_MCP_SERVER_NAME,
              )
              const refreshedMatch = getMatchedAppMcpEntry(refreshedMcp)
              const refreshedConnected = inferMcpConnected(refreshedMatch.entry)
              return {
                mcp: refreshedMcp,
                summary: {
                  serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
                  matchedServerName: refreshedMatch.matchedServerName,
                  status: 'attached',
                  connected: refreshedConnected,
                  launchSource: launchConfig.source,
                  availableServerNames: getMcpServerNames(refreshedMcp),
                  diagnostics: refreshedConnected === true
                    ? [
                        `Reattached OpenCode app MCP server after connect failed: ${error instanceof Error ? error.message : String(error)}`,
                      ]
                    : [
                        `Reattached OpenCode app MCP server after connect failed: ${error instanceof Error ? error.message : String(error)}`,
                        `OpenCode app MCP server ${OPEN_CODE_APP_MCP_SERVER_NAME} did not report connected after reattach`,
                      ],
                },
              }
            } catch (reattachError) {
              return {
                mcp: existingMcp,
                summary: {
                  serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
                  matchedServerName: existingMatch.matchedServerName,
                  status: 'attach_failed',
                  connected,
                  launchSource: launchConfig?.source ?? null,
                  availableServerNames: getMcpServerNames(existingMcp),
                  diagnostics: [
                    `OpenCode app MCP connect failed: ${error instanceof Error ? error.message : String(error)}`,
                    `OpenCode app MCP reattach after connect failure failed: ${reattachError instanceof Error ? reattachError.message : String(reattachError)}`,
                  ],
                },
              }
            }
          }
          return {
            mcp: existingMcp,
            summary: {
              serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
              matchedServerName: existingMatch.matchedServerName,
              status: 'attach_failed',
              connected,
              launchSource: launchConfig?.source ?? null,
              availableServerNames: getMcpServerNames(existingMcp),
              diagnostics: [`OpenCode app MCP connect failed: ${error instanceof Error ? error.message : String(error)}`],
            },
          }
        }
      }

      return {
        mcp: existingMcp,
        summary: {
          serverName: OPEN_CODE_APP_MCP_SERVER_NAME,
          matchedServerName: existingMatch.matchedServerName,
          status: 'present',
          connected,
          launchSource: launchConfig?.source ?? null,
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

  private async waitForMcpConnected(
    client: OpenCodeMcpClient,
    serverName: string,
  ): Promise<OpenCodeMcpResponse> {
    const verifyStartedAt = Date.now()
    let latest = await client.getMcp()
    while (Date.now() - verifyStartedAt < this.verifyTimeoutMs) {
      const match = getMatchedAppMcpEntry(latest)
      if (match.matchedServerName === serverName && inferMcpConnected(match.entry) === true) {
        return latest
      }
      await this.sleepMs(this.verifyPollMs)
      latest = await client.getMcp()
    }
    return latest
  }
}

export const openCodeMcpManager = new OpenCodeMcpManager()
