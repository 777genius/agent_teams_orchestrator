import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { CLAUDE_MULTIMODEL_CACHE_HOME_ENV, CLAUDE_MULTIMODEL_DATA_HOME_ENV } from './OpenCodeManagedPaths.js'
import type { OpenCodeAppMcpLaunchSource, OpenCodeMcpServerConfig } from './types.js'
const OPEN_CODE_APP_MCP_TIMEOUT_MS = 30_000

const OPEN_CODE_MCP_ENTRY_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY'
const OPEN_CODE_MCP_COMMAND_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND'
const OPEN_CODE_MCP_ARGS_JSON_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON'
const OPEN_CODE_MCP_ENV_JSON_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON'
export const OPEN_CODE_MCP_URL_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL'
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
export const OPEN_CODE_MCP_ENVIRONMENT_IDENTITY_KEYS = [
  CLAUDE_TEAM_CONTROL_URL_ENV,
  AGENT_TEAMS_MCP_CLAUDE_DIR_ENV,
  CLAUDE_MULTIMODEL_DATA_HOME_ENV,
  CLAUDE_MULTIMODEL_CACHE_HOME_ENV,
] as const

export type ResolvedAppMcpLaunchConfig = {
  source: OpenCodeAppMcpLaunchSource
  config: OpenCodeMcpServerConfig
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

export function asString(value: unknown): string | null {
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

export function parseMcpRemoteUrl(value: string | null): string | null {
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
  } catch {
    throw new Error(`${OPEN_CODE_MCP_ENV_JSON_ENV} must be a JSON object with string values`)
  }

  const record = asRecord(parsed)
  if (!record) {
    throw new Error(`${OPEN_CODE_MCP_ENV_JSON_ENV} must be a JSON object with string values`)
  }

  const result: Record<string, string> = {}
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw !== 'string') {
      throw new Error(`${OPEN_CODE_MCP_ENV_JSON_ENV} values must be strings`)
    }
    result[key] = raw
  }
  return result
}

export function getMcpEnvironmentJsonKeys(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(parseMcpEnvironmentJson(asString(env[OPEN_CODE_MCP_ENV_JSON_ENV])))
}

export function hasOpenCodeLocalMcpLaunchOverride(env: NodeJS.ProcessEnv): boolean {
  return [
    OPEN_CODE_MCP_COMMAND_ENV,
    OPEN_CODE_MCP_ENTRY_ENV,
    OPEN_CODE_MCP_ARGS_JSON_ENV,
  ].some(key => asString(env[key]) !== null)
}

export function asStringRecord(value: unknown): Record<string, string> | null {
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
    return (await stat(targetPath)).isFile()
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

function getOpenCodeBridgeRepoRoot(inputs: OpenCodeAppMcpLaunchInputs): string {
  if (inputs.repositoryRoot !== null) return path.resolve(inputs.workingDirectory, inputs.repositoryRoot)
  for (const startDir of [inputs.moduleDirectory, inputs.entrypoint ? path.dirname(inputs.entrypoint) : null]) {
    if (!startDir) continue
    const root = resolveOpenCodeBridgeRepoRootForStartDir(path.resolve(inputs.workingDirectory, startDir))
    if (root) return root
  }
  return path.resolve(inputs.workingDirectory, inputs.moduleDirectory, '../../..')
}

function getRuntimeUserHome(env: NodeJS.ProcessEnv, inputs: OpenCodeAppMcpLaunchInputs): string | null {
  const explicitHome = asString(env.USERPROFILE) ?? asString(env.HOME)
  if (explicitHome) {
    return path.resolve(inputs.workingDirectory, explicitHome)
  }

  const homeDrive = asString(env.HOMEDRIVE)
  const homePath = asString(env.HOMEPATH)
  if (homeDrive && homePath) {
    return path.resolve(inputs.workingDirectory, `${homeDrive}${homePath}`)
  }

  const fallbackHome = inputs.home
  return fallbackHome ? path.resolve(inputs.workingDirectory, fallbackHome) : null
}

function resolveAgentTeamsMcpClaudeDir(env: NodeJS.ProcessEnv, inputs: OpenCodeAppMcpLaunchInputs): string | null {
  const explicitClaudeDir = asString(env[AGENT_TEAMS_MCP_CLAUDE_DIR_ENV])
  if (explicitClaudeDir) {
    return path.resolve(inputs.workingDirectory, explicitClaudeDir)
  }

  const home = getRuntimeUserHome(env, inputs)
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

function getTsxBinaryCandidates(claudeTeamRoot: string, platform: NodeJS.Platform): string[] {
  const candidates = [
    path.join(claudeTeamRoot, 'mcp-server', 'node_modules', '.bin', 'tsx'),
    path.join(claudeTeamRoot, 'node_modules', '.bin', 'tsx'),
    path.join(path.dirname(claudeTeamRoot), 'node_modules', '.bin', 'tsx'),
  ]

  if (platform !== 'win32') {
    return candidates
  }

  return candidates.flatMap(candidate => [`${candidate}.cmd`, candidate])
}

async function buildTsxSourceCommand(
  tsxBinary: string,
  sourceEntry: string,
  nodeCommand: string,
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
    return [nodeCommand, tsxCliEntry, sourceEntry]
  }

  return [tsxBinary, sourceEntry]
}

function buildForwardedEnvironment(env: NodeJS.ProcessEnv, inputs: OpenCodeAppMcpLaunchInputs): Record<string, string> {
  const forwarded: Record<string, string> = {}
  for (const key of OPEN_CODE_MCP_ENVIRONMENT_ALLOWLIST) {
    const value = env[key]
    if (typeof value !== 'string' || value.length === 0) {
      continue
    }
    forwarded[key] = value
  }
  const agentTeamsClaudeDir = resolveAgentTeamsMcpClaudeDir(env, inputs)
  if (agentTeamsClaudeDir && !forwarded[AGENT_TEAMS_MCP_CLAUDE_DIR_ENV]) {
    forwarded[AGENT_TEAMS_MCP_CLAUDE_DIR_ENV] = agentTeamsClaudeDir
  }
  return forwarded
}

function buildLocalMcpEnvironment(env: NodeJS.ProcessEnv, inputs: OpenCodeAppMcpLaunchInputs): Record<string, string> {
  return {
    ...buildForwardedEnvironment(env, inputs),
    ...parseMcpEnvironmentJson(asString(env[OPEN_CODE_MCP_ENV_JSON_ENV])),
  }
}

export interface OpenCodeAppMcpLaunchInputs {
  env: NodeJS.ProcessEnv
  workingDirectory: string
  moduleDirectory: string
  repositoryRoot: string | null
  entrypoint: string | null
  home: string | null
  platform: NodeJS.Platform
  resolveExecutable(command: string): string | null
  pathExists?: (targetPath: string) => Promise<boolean>
}

/** Actual shared resolver; launch ambient inputs are explicitly supplied. */
export async function resolveOpenCodeAppMcpLaunchConfig(inputs: OpenCodeAppMcpLaunchInputs): Promise<ResolvedAppMcpLaunchConfig> {
  const env = inputs.env
  const pathExists = inputs.pathExists ?? defaultPathExists
  const resolveNodeCommand = () => inputs.resolveExecutable('node') ?? 'node'
  const getCandidateClaudeTeamRoots = () => getCandidateClaudeTeamRootsForBridgeRoot(getOpenCodeBridgeRepoRoot(inputs))
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
    const localEnvironment = buildLocalMcpEnvironment(env, inputs)
    return {
      source: 'env-override',
      config: {
        type: 'local',
        command: [
          commandOverride ?? resolveNodeCommand(),
          ...argsOverride.map(arg => arg.startsWith('-') || path.isAbsolute(arg) ? arg : path.resolve(inputs.workingDirectory, arg)),
        ],
        environment: localEnvironment,
        enabled: true,
        timeout: OPEN_CODE_APP_MCP_TIMEOUT_MS,
      },
    }
  }

  if (entryOverride) {
    const absoluteEntry = path.resolve(inputs.workingDirectory, entryOverride)
    const localEnvironment = buildLocalMcpEnvironment(env, inputs)
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

  const forwardedEnvironment = buildForwardedEnvironment(env, inputs)
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
    const tsxCandidates = getTsxBinaryCandidates(claudeTeamRoot, inputs.platform)

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
              resolveNodeCommand(),
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
