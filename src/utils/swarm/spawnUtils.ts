/**
 * Shared utilities for spawning teammates across different backends.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getChromeFlagOverride,
  getFlagDisallowedTools,
  getFlagMcpConfig,
  getFlagSettingsPath,
  getInlinePlugins,
  getMainLoopModelOverride,
  getSessionBypassPermissionsMode,
  getStrictMcpConfig,
} from '../../bootstrap/state.js'
import { normalizeApiKeyForConfig } from '../authPortable.js'
import { quote } from '../bash/shellQuote.js'
import { isInBundledMode } from '../bundledMode.js'
import { getCustomApiKeyStatus } from '../config.js'
import { logForDebugging } from '../debug.js'
import { isRunningOnHomespace } from '../envUtils.js'
import { execFileNoThrow } from '../execFileNoThrow.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { sleep } from '../sleep.js'
import type { TeammateProvider } from './backends/types.js'
import { getTeammateModeFromSnapshot } from './backends/teammateModeSnapshot.js'
import {
  getSwarmSocketName,
  TEAMMATE_COMMAND_ENV_VAR,
  TMUX_COMMAND,
} from './constants.js'
import { tryReadStartupReadySentinel } from './startupReadySentinel.js'

/**
 * Gets the shell command prefix to use for spawning teammate processes.
 * Uses TEAMMATE_COMMAND_ENV_VAR if set, otherwise:
 * - bundled/native mode: execute the compiled binary directly
 * - script mode (bun/node): execute the current script via process.execPath
 */
export function getTeammateCommand(): string {
  if (process.env[TEAMMATE_COMMAND_ENV_VAR]) {
    return process.env[TEAMMATE_COMMAND_ENV_VAR]
  }
  if (isInBundledMode()) {
    return quote([process.execPath])
  }
  return `${quote([process.execPath])} ${quote([process.argv[1]!])}`
}

/**
 * Builds CLI flags to propagate from the current session to spawned teammates.
 * This ensures teammates inherit important settings like permission mode,
 * model selection, and plugin configuration from their parent.
 *
 * @param options.planModeRequired - If true, don't inherit bypass permissions (plan mode takes precedence)
 * @param options.permissionMode - Permission mode to propagate
 */
export function buildInheritedCliFlags(options?: {
  planModeRequired?: boolean
  permissionMode?: PermissionMode
  effortValue?: string
  strictMcpConfig?: boolean
}): string {
  const flags: string[] = []
  const { planModeRequired, permissionMode, effortValue, strictMcpConfig } = options || {}

  // Propagate permission mode to teammates, but NOT if plan mode is required
  // Plan mode takes precedence over bypass permissions for safety
  if (planModeRequired) {
    // Don't inherit bypass permissions when plan mode is required
  } else if (
    permissionMode === 'bypassPermissions' ||
    getSessionBypassPermissionsMode()
  ) {
    flags.push('--dangerously-skip-permissions')
  } else if (permissionMode === 'acceptEdits') {
    flags.push('--permission-mode acceptEdits')
  }

  // Propagate --model if explicitly set via CLI
  const modelOverride = getMainLoopModelOverride()
  if (modelOverride) {
    flags.push(`--model ${quote([modelOverride])}`)
  }

  if (effortValue) {
    flags.push(`--effort ${quote([effortValue])}`)
  }

  // Propagate --settings if set via CLI
  const settingsPath = getFlagSettingsPath()
  if (settingsPath) {
    flags.push(`--settings ${quote([settingsPath])}`)
  }

  const disallowedTools = getFlagDisallowedTools()
  for (const disallowedTool of disallowedTools) {
    flags.push(`--disallowedTools ${quote([disallowedTool])}`)
  }

  // Propagate explicit --mcp-config / --strict-mcp-config so pane-based
  // teammates inherit dynamic MCP servers from the leader session.
  const mcpConfigs = getFlagMcpConfig()
  for (const mcpConfig of mcpConfigs) {
    flags.push(`--mcp-config ${quote([mcpConfig])}`)
  }
  if (strictMcpConfig || getStrictMcpConfig()) {
    flags.push('--strict-mcp-config')
  }

  // Propagate --plugin-dir for each inline plugin
  const inlinePlugins = getInlinePlugins()
  for (const pluginDir of inlinePlugins) {
    flags.push(`--plugin-dir ${quote([pluginDir])}`)
  }

  // Propagate --teammate-mode so tmux teammates use the same mode as leader
  const sessionMode = getTeammateModeFromSnapshot()
  flags.push(`--teammate-mode ${sessionMode}`)

  // Propagate --chrome / --no-chrome if explicitly set on the CLI
  const chromeFlagOverride = getChromeFlagOverride()
  if (chromeFlagOverride === true) {
    flags.push('--chrome')
  } else if (chromeFlagOverride === false) {
    flags.push('--no-chrome')
  }

  return flags.join(' ')
}

/**
 * Environment variables that must be explicitly forwarded to tmux-spawned
 * teammates. Tmux may start a new login shell that doesn't inherit the
 * parent's env, so we forward any that are set in the current process.
 */
const TEAMMATE_ENV_VARS = [
  // Host-managed routing guard. When present, settings-sourced env must not
  // override the provider/env choice that the launcher made for this child.
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  // API provider selection — without these, teammates default to firstParty
  // and send requests to the wrong endpoint (GitHub issue #23561)
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_ENTRY_PROVIDER',
  'CLAUDE_CODE_GEMINI_BACKEND',
  'CLAUDE_CODE_CODEX_BACKEND',
  'CLAUDE_CODE_CODEX_API_KEY_BETA',
  // Custom API endpoint
  'ANTHROPIC_BASE_URL',
  'GEMINI_BASE_URL',
  'GEMINI_API_VERSION',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT_ID',
  'GCLOUD_PROJECT',
  // Config directory override
  'CLAUDE_CONFIG_DIR',
  // CCR marker — teammates need this for CCR-aware code paths. Auth finds
  // its own way via /home/claude/.claude/remote/.oauth_token regardless;
  // the FD env var wouldn't help (pipe FDs don't cross tmux).
  'CLAUDE_CODE_REMOTE',
  // Auto-memory gate (memdir/paths.ts) checks REMOTE && !MEMORY_DIR to
  // disable memory on ephemeral CCR filesystems. Forwarding REMOTE alone
  // would flip teammates to memory-off when the parent has it on.
  'CLAUDE_CODE_REMOTE_MEMORY_DIR',
  // Upstream proxy — the parent's MITM relay is reachable from teammates
  // (same container network). Forward the proxy vars so teammates route
  // customer-configured upstream traffic through the relay for credential
  // injection. Without these, teammates bypass the proxy entirely.
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
] as const

const PROVIDER_SELECTION_ENV_VARS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_ENTRY_PROVIDER',
] as const

function getExplicitEntryProvider(provider: TeammateProvider): string {
  return provider === 'codex' || provider === 'gemini' ? provider : 'anthropic'
}

const PROVIDER_SELECTION_ENV_VAR_SET = new Set<string>(
  PROVIDER_SELECTION_ENV_VARS,
)

export function shouldClearAnthropicApiKeyForTeammateSpawn(params: {
  anthropicApiKey: string | undefined
  customApiKeyStatus: 'approved' | 'rejected' | 'new'
  isHomespace: boolean
}): boolean {
  const { anthropicApiKey, customApiKeyStatus, isHomespace } = params

  if (!anthropicApiKey || isHomespace) {
    return false
  }

  // Pane-spawned teammates inherit the caller's shell env in addition to the
  // explicit env KEY=VALUE prefix we build below. If ANTHROPIC_API_KEY is still
  // "new" for this machine, the child can stall on the ApproveApiKey startup
  // dialog before the REPL loop starts. When that happens, the teammate
  // process is alive but never reaches the first inbox poll/claim.
  //
  // We only clear keys that are still unapproved ("new"). Approved custom keys
  // keep flowing to spawned teammates so we do not silently change the user's
  // chosen auth route.
  return customApiKeyStatus === 'new'
}

/**
 * Builds the `env KEY=VALUE ...` string for teammate spawn commands.
 * Always includes CLAUDECODE=1 and CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1,
 * plus any provider/config env vars that are set in the current process.
 */
export function buildInheritedEnvVars(options?: {
  provider?: TeammateProvider
  extraEnv?: Record<string, string | undefined>
}): string {
  const envVars = ['CLAUDECODE=1', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1']
  const provider = options?.provider

  if (
    shouldClearAnthropicApiKeyForTeammateSpawn({
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      customApiKeyStatus: process.env.ANTHROPIC_API_KEY
        ? getCustomApiKeyStatus(
            normalizeApiKeyForConfig(process.env.ANTHROPIC_API_KEY),
          )
        : 'rejected',
      isHomespace: isRunningOnHomespace(),
    })
  ) {
    // Explicitly blank the inherited shell env for pane-based teammates. Not
    // forwarding the key is insufficient because tmux/login shells can still
    // inherit ANTHROPIC_API_KEY from the parent environment.
    envVars.push("ANTHROPIC_API_KEY=''")
  }

  for (const key of TEAMMATE_ENV_VARS) {
    if (provider && PROVIDER_SELECTION_ENV_VAR_SET.has(key)) {
      continue
    }
    const value = process.env[key]
    if (value !== undefined && value !== '') {
      envVars.push(`${key}=${quote([value])}`)
    }
  }

  if (options?.extraEnv) {
    for (const [key, value] of Object.entries(options.extraEnv)) {
      if (value !== undefined) {
        envVars.push(`${key}=${quote([value])}`)
      }
    }
  }

  if (provider) {
    for (const key of PROVIDER_SELECTION_ENV_VARS) {
      envVars.push(`${key}=''`)
    }
    // Teammate provider overrides must be positive pins, not "unset and hope
    // firstParty wins". The desktop/dev host can already be running with a
    // different routed provider (for example codex), and settings.env is
    // applied again after trust inside the child. Mark the child as
    // host-managed and set an explicit entry provider for all override cases,
    // including anthropic, so model alias resolution cannot drift.
    envVars.push('CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1')
    envVars.push(
      `CLAUDE_CODE_ENTRY_PROVIDER=${getExplicitEntryProvider(provider)}`,
    )
  }

  return envVars.join(' ')
}

const TMUX_SPAWN_SMOKE_DELAY_MS = 800
const TMUX_TEAMMATE_EXIT_SENTINEL = '__CLAUDE_TEAMMATE_EXIT__:'

const TMUX_SPAWN_FAILURE_PATTERNS: Array<{
  pattern: RegExp
  message: string
}> = [
  {
    pattern: /permission denied/i,
    message: 'Teammate runtime failed to start: permission denied.',
  },
  {
    pattern: /command not found/i,
    message: 'Teammate runtime failed to start: command not found.',
  },
  {
    pattern: /no such file or directory/i,
    message: 'Teammate runtime failed to start: file not found.',
  },
  {
    pattern: /bad interpreter/i,
    message: 'Teammate runtime failed to start: bad interpreter.',
  },
  {
    pattern: /exec format error/i,
    message: 'Teammate runtime failed to start: exec format error.',
  },
  {
    pattern: /cannot execute/i,
    message: 'Teammate runtime failed to start: shell could not execute the command.',
  },
  {
    pattern: /is not executable/i,
    message: 'Teammate runtime failed to start: file is not executable.',
  },
  {
    pattern: /operation not permitted/i,
    message: 'Teammate runtime failed to start: operation not permitted.',
  },
]

function extractRelevantSpawnFailureLine(output: string): string | null {
  const lines = output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  for (const line of lines.slice().reverse()) {
    for (const { pattern, message } of TMUX_SPAWN_FAILURE_PATTERNS) {
      if (pattern.test(line)) {
        return `${message} (${line})`
      }
    }
  }

  return null
}

export function wrapTeammateSpawnCommand(command: string): string {
  return `${command}; __claude_teammate_exit=$?; printf '\\n${TMUX_TEAMMATE_EXIT_SENTINEL}%s\\n' "$__claude_teammate_exit"`
}

/**
 * Writes the long teammate spawn command into a short-lived shell script and
 * returns a compact launcher command for pane-based backends.
 *
 * Long commands sent directly via tmux send-keys can land in the shell as a
 * broken multiline continuation prompt. Launching through a temp script keeps
 * the pane command short and avoids fragile interactive quoting.
 */
export async function buildPaneLauncherCommand(
  command: string,
): Promise<string> {
  const scriptDir = await mkdtemp(join(tmpdir(), 'claude-teammate-spawn-'))
  const scriptPath = join(scriptDir, 'launch.zsh')
  const script = [
    '#!/bin/zsh',
    `SCRIPT_PATH=${quote([scriptPath])}`,
    `SCRIPT_DIR=${quote([scriptDir])}`,
    'cleanup_spawn_script() {',
    '  rm -f "$SCRIPT_PATH"',
    '  rmdir "$SCRIPT_DIR" 2>/dev/null || true',
    '}',
    'trap cleanup_spawn_script EXIT',
    command,
    '',
  ].join('\n')

  await writeFile(scriptPath, script, { mode: 0o700 })

  return `zsh ${quote([scriptPath])}`
}

function extractExitSentinelCode(output: string): number | null {
  const match = output.match(
    /__CLAUDE_TEAMMATE_EXIT__:(\d+)(?![\s\S]*__CLAUDE_TEAMMATE_EXIT__:)/,
  )
  if (!match) {
    return null
  }
  const parsed = Number.parseInt(match[1] ?? '', 10)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * Checks whether a tmux-spawned teammate command crashed immediately after
 * launch. This is intentionally conservative: we only fail on clear shell
 * startup errors or when the pane disappears right away.
 */
export async function probeTmuxTeammateSpawn(
  paneId: string,
  useExternalSessionOrOptions:
    | boolean
    | {
        useExternalSession?: boolean
        readySentinelPath?: string
        readyTimeoutMs?: number
        pollIntervalMs?: number
      } = false,
): Promise<string | null> {
  return probeTmuxTeammateSpawnWithDeps(
    paneId,
    useExternalSessionOrOptions,
    {
      execFileNoThrowFn: execFileNoThrow,
      sleepFn: sleep,
    },
  )
}

export async function probeTmuxTeammateSpawnWithDeps(
  paneId: string,
  useExternalSessionOrOptions:
    | boolean
    | {
        useExternalSession?: boolean
        readySentinelPath?: string
        readyTimeoutMs?: number
        pollIntervalMs?: number
      } = false,
  deps: {
    execFileNoThrowFn: typeof execFileNoThrow
    sleepFn: typeof sleep
  },
): Promise<string | null> {
  const useExternalSession =
    typeof useExternalSessionOrOptions === 'boolean'
      ? useExternalSessionOrOptions
      : Boolean(useExternalSessionOrOptions.useExternalSession)
  const readySentinelPath =
    typeof useExternalSessionOrOptions === 'boolean'
      ? undefined
      : useExternalSessionOrOptions.readySentinelPath
  const readyTimeoutMs =
    typeof useExternalSessionOrOptions === 'boolean'
      ? 1500
      : useExternalSessionOrOptions.readyTimeoutMs ?? 1500
  const pollIntervalMs =
    typeof useExternalSessionOrOptions === 'boolean'
      ? 100
      : useExternalSessionOrOptions.pollIntervalMs ?? 100

  await deps.sleepFn(TMUX_SPAWN_SMOKE_DELAY_MS)

  const socketArgs = useExternalSession ? ['-L', getSwarmSocketName()] : []
  const deadline = Date.now() + readyTimeoutMs
  const initialPaneFailure = await readPaneStartupFailure({
    paneId,
    socketArgs,
    execFileNoThrowFn: deps.execFileNoThrowFn,
  })
  if (initialPaneFailure) {
    return initialPaneFailure
  }

  if (!readySentinelPath) {
    return null
  }

  while (true) {
    if (readySentinelPath) {
      const ready = await tryReadStartupReadySentinel(readySentinelPath)
      if (ready) {
        // Stronger positive proof that startup gates were passed. This remains
        // probe-only and must not be treated as bootstrap/contact truth.
        return null
      }
    }

    const paneStatus = await readPaneLiveness({
      paneId,
      socketArgs,
      execFileNoThrowFn: deps.execFileNoThrowFn,
    })
    if (paneStatus.failure) {
      return paneStatus.failure
    }

    if (!readySentinelPath || Date.now() >= deadline) {
      break
    }

    await deps.sleepFn(pollIntervalMs)
  }

  const paneFailure = await readPaneStartupFailure({
    paneId,
    socketArgs,
    execFileNoThrowFn: deps.execFileNoThrowFn,
  })
  if (paneFailure) {
    return paneFailure
  }

  if (readySentinelPath) {
    const ready = await tryReadStartupReadySentinel(readySentinelPath)
    if (ready) {
      return null
    }

    logForDebugging(
      `[SpawnProbe] startup-ready sentinel not observed before timeout for ${paneId}`,
    )
  }

  return null
}

async function readPaneLiveness(params: {
  paneId: string
  socketArgs: string[]
  execFileNoThrowFn: typeof execFileNoThrow
}): Promise<{
  failure: string | null
  paneDeadRaw: string
  currentCommand: string
  panePid: string
}> {
  const { paneId, socketArgs, execFileNoThrowFn } = params
  const status = await execFileNoThrowFn(TMUX_COMMAND, [
    ...socketArgs,
    'display-message',
    '-p',
    '-t',
    paneId,
    '#{pane_dead}|#{pane_current_command}|#{pane_pid}',
  ])

  if (status.code !== 0) {
    return {
      failure: `Teammate pane ${paneId} exited immediately after launch.`,
      paneDeadRaw: '1',
      currentCommand: '',
      panePid: '',
    }
  }

  const [paneDeadRaw = '0', currentCommand = '', panePid = ''] = status.stdout
    .trim()
    .split('|')

  if (paneDeadRaw === '1') {
    const commandSuffix = currentCommand ? ` (${currentCommand})` : ''
    const pidSuffix = panePid ? ` pid=${panePid}` : ''
    return {
      failure: `Teammate pane ${paneId} exited immediately after launch${commandSuffix}${pidSuffix}.`,
      paneDeadRaw,
      currentCommand,
      panePid,
    }
  }

  return {
    failure: null,
    paneDeadRaw,
    currentCommand,
    panePid,
  }
}

async function readPaneStartupFailure(params: {
  paneId: string
  socketArgs: string[]
  execFileNoThrowFn: typeof execFileNoThrow
}): Promise<string | null> {
  const { paneId, socketArgs, execFileNoThrowFn } = params
  const paneStatus = await readPaneLiveness({
    paneId,
    socketArgs,
    execFileNoThrowFn,
  })
  if (paneStatus.failure) {
    return paneStatus.failure
  }

  const capture = await execFileNoThrowFn(TMUX_COMMAND, [
    ...socketArgs,
    'capture-pane',
    '-p',
    '-t',
    paneId,
    '-S',
    '-60',
  ])

  const capturedOutput = capture.code === 0 ? capture.stdout.trim() : ''
  const failureLine = extractRelevantSpawnFailureLine(capturedOutput)
  if (failureLine) {
    return failureLine
  }

  const exitCode = extractExitSentinelCode(capturedOutput)
  if (exitCode !== null) {
    if (exitCode === 0) {
      return 'Teammate runtime exited immediately after launch.'
    }
    return `Teammate runtime exited immediately after launch with code ${exitCode}.`
  }

  return null
}
