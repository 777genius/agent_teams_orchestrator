/**
 * Shared utilities for spawning teammates across different backends.
 */

import { createHash } from 'node:crypto'
import { assertMemberEnvPatch, type MemberEnvPatch } from './memberEnvPatch.js'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  getChromeFlagOverride,
  getFlagDisallowedTools,
  getFlagMcpConfig,
  getFlagSettingsInline,
  getFlagSettingsPath,
  getInlinePlugins,
  getMainLoopModelOverride,
  getSessionBypassPermissionsMode,
  getStrictMcpConfig,
} from '../../bootstrap/state.js'
import {
  AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV,
  ANTHROPIC_DIRECT_ROUTE_ENV_KEYS,
  ANTHROPIC_EXTERNAL_ROUTE_ENV_KEYS,
  ANTHROPIC_MODEL_ENV_KEYS,
  APP_MANAGED_ANTHROPIC_AUTH_MODE_API_KEY_HELPER,
  APP_MANAGED_ANTHROPIC_AUTH_MODE_ENV,
  APP_MANAGED_ANTHROPIC_SETTINGS_PATH_ENV,
  APP_MANAGED_TEAM_RUNTIME_SETTINGS_PATH_ENV,
  getAnthropicConnectionMode,
  hasAppManagedAnthropicApiKeyHelper,
} from '../anthropicConnectionMode.js'
import { normalizeApiKeyForConfig } from '../authPortable.js'
import { writeFileAtomicSync } from '../atomicWrite.js'
import { quote } from '../bash/shellQuote.js'
import { isInBundledMode } from '../bundledMode.js'
import { getCustomApiKeyStatus } from '../config.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy, isRunningOnHomespace } from '../envUtils.js'
import { execFileNoThrow } from '../execFileNoThrow.js'
import { getAPIProvider } from '../model/providers.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { sleep } from '../sleep.js'
import {
  CODEX_FORCED_LOGIN_METHOD_ENV_VAR,
  getCodexForcedLoginMethod,
} from '../../services/runtimeBackends/codexBackendResolver.js'
import { parseArguments } from '../argumentSubstitution.js'
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
 * Per-member Codex provider overrides carried by the bootstrap spec. These
 * belong to the member's own runtime — the lead's codex settings are never
 * reused as a fallback for them.
 */
export type MemberCodexSpawnOverrides = {
  configOverrides?: string[]
  forcedLoginMethod?: 'api'
}

/**
 * Builds the settings fragment carrying per-member Codex overrides. The shape
 * matches what the existing child-side parser
 * (buildCodexNativeCustomProviderConfigOverrides / getCodexForcedLoginMethod)
 * reads, so both the `-c` config-override form and the inline `--settings` JSON
 * form round-trip through that parser unchanged.
 */
export function buildMemberCodexSettingsFragment(
  memberCodex: MemberCodexSpawnOverrides | undefined,
): Record<string, unknown> | null {
  if (!memberCodex) {
    return null
  }
  const codex: Record<string, unknown> = {}
  if (memberCodex.forcedLoginMethod === 'api') {
    codex.forced_login_method = 'api'
  }
  const configOverrides = memberCodex.configOverrides?.filter(
    override => typeof override === 'string' && override.length > 0,
  )
  if (configOverrides && configOverrides.length > 0) {
    codex.agent_teams_custom_provider = {
      config_overrides: [...configOverrides],
    }
  }
  return Object.keys(codex).length > 0 ? { codex } : null
}

/**
 * Applies a member settings fragment on top of base settings. The fragment's
 * top-level keys replace the base keys wholesale (not deep-merged), so a
 * member's `codex` block never inherits the lead's codex settings.
 */
export function mergeMemberSettingsFragment(
  base: Record<string, unknown> | null,
  fragment: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(base ?? {}), ...fragment }
}

/**
 * Materializes a child settings file that carries the member settings fragment
 * merged over an inherited settings file. Content-hash based path so identical
 * settings produce identical paths (prompt-cache friendly). Returns null when
 * the base settings file cannot be read or written.
 */
export function materializeMergedMemberSettingsFile(
  baseSettingsPath: string,
  fragment: Record<string, unknown>,
): string | null {
  const baseSettings = readSettingsJsonFile(baseSettingsPath)
  if (!baseSettings) {
    return null
  }
  const merged = mergeMemberSettingsFragment(baseSettings, fragment)
  const serialized = JSON.stringify(merged)
  const contentHash = createHash('sha256').update(serialized).digest('hex').slice(0, 32)
  const outputPath = join(
    tmpdir(),
    `claude-teammate-member-settings-${contentHash}.json`,
  )
  try {
    writeFileAtomicSync(outputPath, `${JSON.stringify(merged, null, 2)}\n`, {
      mode: 0o600,
    })
    chmodSync(outputPath, 0o600)
    return outputPath
  } catch {
    return null
  }
}

/**
 * Builds CLI flags to propagate from the current session to spawned teammates.
 * This ensures teammates inherit important settings like permission mode,
 * model selection, and plugin configuration from their parent.
 *
 * @param options.planModeRequired - If true, don't inherit bypass permissions (plan mode takes precedence)
 * @param options.permissionMode - Permission mode to propagate
 * @param options.memberCodex - Per-member Codex provider overrides that replace
 *   the lead's codex settings namespace for this teammate's spawn
 */
export function buildInheritedCliFlags(options?: {
  planModeRequired?: boolean
  permissionMode?: PermissionMode
  effortValue?: string
  strictMcpConfig?: boolean
  provider?: TeammateProvider
  memberCodex?: MemberCodexSpawnOverrides
}): string {
  const flags: string[] = []
  const { planModeRequired, permissionMode, effortValue, strictMcpConfig, provider, memberCodex } =
    options || {}

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

  // Propagate --settings if set via CLI. Per-member Codex overrides are merged
  // in as a final layer: the member's codex settings replace the lead's codex
  // settings namespace for this teammate.
  const settingsPath = getFlagSettingsPath()
  const settingsInline = getFlagSettingsInline()
  const inheritedSettingsInline = buildProviderScopedInheritedSettingsInline(
    provider,
    settingsInline,
  )
  const memberSettingsFragment = buildMemberCodexSettingsFragment(memberCodex)
  const appManagedAnthropicSettingsFlag =
    buildAppManagedAnthropicApiKeyHelperSettingsFlag(
      provider,
      settingsPath,
      memberSettingsFragment,
    )
  const suppressAppManagedAnthropicPath =
    provider !== 'anthropic' && isAppManagedAnthropicSettingsPath(settingsPath)
  const suppressAppManagedTeamRuntimePath =
    provider !== 'anthropic' && isAppManagedTeamRuntimeSettingsPath(settingsPath)
  const inheritedSettingsPath =
    settingsPath &&
    !appManagedAnthropicSettingsFlag &&
    !suppressAppManagedAnthropicPath &&
    !suppressAppManagedTeamRuntimePath
      ? settingsPath
      : null
  if (inheritedSettingsPath) {
    if (memberSettingsFragment) {
      const mergedSettingsPath = materializeMergedMemberSettingsFile(
        inheritedSettingsPath,
        memberSettingsFragment,
      )
      if (!mergedSettingsPath) {
        throw new Error(
          'per-member Codex settings could not be merged into the inherited settings file',
        )
      }
      flags.push(`--settings ${quote([mergedSettingsPath])}`)
    } else {
      flags.push(`--settings ${quote([inheritedSettingsPath])}`)
    }
  }
  if (appManagedAnthropicSettingsFlag) {
    flags.push(appManagedAnthropicSettingsFlag)
  } else if (
    inheritedSettingsInline &&
    (!settingsPath || suppressAppManagedAnthropicPath || suppressAppManagedTeamRuntimePath)
  ) {
    const inlineWithMember = memberSettingsFragment
      ? mergeMemberSettingsFragment(inheritedSettingsInline, memberSettingsFragment)
      : inheritedSettingsInline
    flags.push(`--settings ${quote([JSON.stringify(inlineWithMember)])}`)
  } else if (memberSettingsFragment && !inheritedSettingsPath) {
    flags.push(`--settings ${quote([JSON.stringify(memberSettingsFragment)])}`)
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

export function stripInheritedCliFlag(flags: string, flagName: string): string {
  const parts = parseArguments(flags)
  const kept: string[] = []

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (part === flagName) {
      i += 1
      continue
    }
    if (part.startsWith(`${flagName}=`)) {
      continue
    }
    kept.push(part)
  }

  return kept.map(part => quote([part])).join(' ')
}

export function stripProviderBoundaryInheritedRuntimeFlags(flags: string): string {
  return stripInheritedCliFlag(
    stripInheritedCliFlag(flags, '--model'),
    '--effort',
  )
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
  // App-owned Anthropic connection intent. This is safe to carry through
  // non-Anthropic parents so nested mixed-provider spawns can restore the
  // intended Anthropic route without changing the current process provider.
  AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV,
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
  'CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD',
  'CODEX_CLI_PATH',
  'CODEX_HOME',
  'CLAUDE_TEAM_RUNTIME_SETTINGS_PATH',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'CLAUDE_TEAM_ANTHROPIC_AUTH_MODE',
  'CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH',
  // Custom API endpoint
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_API_KEY',
  'GEMINI_BASE_URL',
  'GEMINI_API_VERSION',
  'GEMINI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT_ID',
  'GCLOUD_PROJECT',
  // Config directory override
  'CLAUDE_CONFIG_DIR',
  // App-owned immutable teammate attachment root contract.
  'CLAUDE_AGENT_TEAMS_ATTACHMENT_ROOT',
  // Desktop-managed teammate backend preference. Forward this so process-backed
  // teammates keep spawning their own teammates without requiring tmux.
  'CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES',
  // App-managed runtime turn-settled spool. Codex native teammates emit durable
  // turn completion events here so the desktop member-work-sync reconciler can
  // react after a managed Codex turn stops.
  'AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT',
  // Live canary barrier: inbox may persist, but consume/start stays blocked
  // while this path exists. Process-backend teammates inherit process.env;
  // tmux panes only get the explicit TEAMMATE_ENV_VARS allowlist.
  'CLAUDE_WORK_SYNC_TEST_HOLD_CONSUME_PATH',
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

const APP_MANAGED_ANTHROPIC_COMPETING_AUTH_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
] as const

const ANTHROPIC_AUTO_SPAWN_ENV_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  ...ANTHROPIC_EXTERNAL_ROUTE_ENV_KEYS,
  ...ANTHROPIC_DIRECT_ROUTE_ENV_KEYS,
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT_ID',
  'GCLOUD_PROJECT',
] as const

const PROVIDER_SELECTION_ENV_VARS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_ENTRY_PROVIDER',
] as const

const ANTHROPIC_MODEL_ENV_KEY_SET = new Set<string>(ANTHROPIC_MODEL_ENV_KEYS)

function getExplicitEntryProvider(provider: TeammateProvider): string {
  return provider === 'codex' || provider === 'gemini' ? provider : 'anthropic'
}

function applyAnthropicTeammateConnectionPolicy(
  envVars: Record<string, string>,
  provider: TeammateProvider | undefined,
): void {
  if (provider !== 'anthropic') {
    return
  }
  const connectionMode = getAnthropicConnectionMode(envVars)
  if (connectionMode === 'auto') {
    // Legacy/app-helper launches may predate the connection-mode carrier. The
    // helper marker is still authoritative and must keep all competing auth
    // carriers blank instead of restoring Auto-mode ambient credentials.
    if (isAppManagedAnthropicApiKeyHelperTarget(provider)) {
      return
    }
    for (const key of ANTHROPIC_AUTO_SPAWN_ENV_KEYS) {
      const value = process.env[key]
      if (value !== undefined && value !== '') {
        envVars[key] = value
      }
    }
    return
  }

  for (const key of ANTHROPIC_EXTERNAL_ROUTE_ENV_KEYS) {
    if (connectionMode === 'compatible' && ANTHROPIC_MODEL_ENV_KEY_SET.has(key)) {
      envVars[key] = envVars[key] ?? process.env[key] ?? ''
      continue
    }
    envVars[key] = ''
  }
  if (connectionMode !== 'compatible') {
    for (const key of ANTHROPIC_DIRECT_ROUTE_ENV_KEYS) {
      envVars[key] = ''
    }
  }
  if (connectionMode === 'subscription') {
    envVars.ANTHROPIC_API_KEY = ''
    envVars.ANTHROPIC_AUTH_TOKEN = ''
  } else if (connectionMode === 'api_key') {
    envVars.ANTHROPIC_AUTH_TOKEN = ''
    envVars.CLAUDE_CODE_OAUTH_TOKEN = ''
    envVars.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR = ''
  }
}

const PROVIDER_SELECTION_ENV_VAR_SET = new Set<string>(
  PROVIDER_SELECTION_ENV_VARS,
)

export function buildProviderScopedInheritedSettingsInline(
  provider: TeammateProvider | 'opencode' | undefined,
  settings: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!settings) {
    return null
  }
  if (!provider || provider === 'anthropic') {
    return settings
  }

  const next = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>
  delete next.apiKeyHelper

  if (provider === 'codex' || provider === 'opencode') {
    delete next.awsCredentialExport
    delete next.awsAuthRefresh
    delete next.gcpAuthRefresh
  }

  if (provider === 'gemini') {
    delete next.awsCredentialExport
    delete next.awsAuthRefresh
  }

  return Object.keys(next).length > 0 ? next : null
}

function getCurrentTeammateProviderForEnvForwarding(): TeammateProvider {
  const provider = getAPIProvider()
  if (provider === 'openai') {
    return 'codex'
  }
  if (provider === 'gemini') {
    return 'gemini'
  }
  return 'anthropic'
}

function shouldForwardAnthropicAuthToken(
  provider: TeammateProvider | undefined,
): boolean {
  return (provider ?? getCurrentTeammateProviderForEnvForwarding()) === 'anthropic'
}

function isHostManagedAnthropicTeammateTarget(
  provider: TeammateProvider | undefined,
): boolean {
  return (
    (provider ?? getCurrentTeammateProviderForEnvForwarding()) === 'anthropic' &&
    isEnvTruthy(process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST)
  )
}

function isAppManagedAnthropicApiKeyHelperTarget(
  provider: TeammateProvider | undefined,
): boolean {
  return (
    isHostManagedAnthropicTeammateTarget(provider) &&
    hasAppManagedAnthropicApiKeyHelper()
  )
}

export function buildAppManagedAnthropicApiKeyHelperSettingsFlag(
  provider: TeammateProvider | undefined,
  inheritedSettingsPath?: string | null,
  memberSettingsFragment?: Record<string, unknown> | null,
): string | null {
  if (!isAppManagedAnthropicApiKeyHelperTarget(provider)) {
    return null
  }
  const settingsPath = process.env[APP_MANAGED_ANTHROPIC_SETTINGS_PATH_ENV]?.trim()
  if (!settingsPath) {
    return null
  }
  const mergedPath = materializeAppManagedAnthropicChildSettingsFile({
    inheritedSettingsPath: inheritedSettingsPath?.trim() || null,
    helperSettingsPath: settingsPath,
    provider: provider ?? getCurrentTeammateProviderForEnvForwarding(),
    memberSettingsFragment: memberSettingsFragment ?? null,
  })
  return `--settings ${quote([mergedPath ?? settingsPath])}`
}

function normalizeComparableSettingsPath(pathValue?: string | null): string | null {
  const trimmed = pathValue?.trim()
  if (!trimmed) {
    return null
  }
  if (process.platform === 'darwin' && trimmed.startsWith('/private/var/')) {
    return trimmed.slice('/private'.length)
  }
  return trimmed
}

export function isAppManagedAnthropicSettingsPath(settingsPath?: string | null): boolean {
  const comparableSettingsPath = normalizeComparableSettingsPath(settingsPath)
  const helperSettingsPath = normalizeComparableSettingsPath(
    process.env[APP_MANAGED_ANTHROPIC_SETTINGS_PATH_ENV],
  )
  if (
    !comparableSettingsPath ||
    !helperSettingsPath ||
    process.env[APP_MANAGED_ANTHROPIC_AUTH_MODE_ENV] !==
      APP_MANAGED_ANTHROPIC_AUTH_MODE_API_KEY_HELPER
  ) {
    return false
  }
  return (
    comparableSettingsPath === helperSettingsPath ||
    dirname(comparableSettingsPath) === dirname(helperSettingsPath)
  )
}

export function isAppManagedTeamRuntimeSettingsPath(
  settingsPath?: string | null,
): boolean {
  const comparableSettingsPath = normalizeComparableSettingsPath(settingsPath)
  const appManagedPath = normalizeComparableSettingsPath(
    process.env[APP_MANAGED_TEAM_RUNTIME_SETTINGS_PATH_ENV],
  )
  return Boolean(comparableSettingsPath && appManagedPath && comparableSettingsPath === appManagedPath)
}

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeJsonSettingsObjects(target: JsonObject, source: JsonObject): JsonObject {
  const merged: JsonObject = { ...target }
  for (const [key, value] of Object.entries(source)) {
    const current = merged[key]
    if (isJsonObject(current) && isJsonObject(value)) {
      merged[key] = mergeJsonSettingsObjects(current, value)
      continue
    }
    merged[key] = value
  }
  return merged
}

function readSettingsJsonFile(filePath: string): JsonObject | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    return isJsonObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function materializeAppManagedAnthropicChildSettingsFile(input: {
  inheritedSettingsPath: string | null
  helperSettingsPath: string
  provider: TeammateProvider
  memberSettingsFragment?: Record<string, unknown> | null
}): string | null {
  const helperSettings = readSettingsJsonFile(input.helperSettingsPath)
  if (!helperSettings) {
    return null
  }
  const inheritedSettings =
    input.inheritedSettingsPath && input.inheritedSettingsPath !== input.helperSettingsPath
      ? readSettingsJsonFile(input.inheritedSettingsPath)
      : null
  const mergedWithHelper = inheritedSettings
    ? mergeJsonSettingsObjects(inheritedSettings, helperSettings)
    : helperSettings
  const merged = input.memberSettingsFragment
    ? mergeMemberSettingsFragment(mergedWithHelper, input.memberSettingsFragment)
    : mergedWithHelper
  const dir = dirname(input.helperSettingsPath)
  const outputPath = join(dir, `child-runtime-settings-${input.provider}.json`)
  try {
    writeFileAtomicSync(outputPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
    chmodSync(outputPath, 0o600)
    return outputPath
  } catch {
    return null
  }
}

export function shouldClearCodexApiKeysForTeammateSpawn(
  provider: TeammateProvider | undefined,
  memberForcedLoginMethod?: 'api',
): boolean {
  const effectiveForcedLoginMethod =
    memberForcedLoginMethod ?? getCodexForcedLoginMethod()
  return (
    (provider ?? getCurrentTeammateProviderForEnvForwarding()) === 'codex' &&
    effectiveForcedLoginMethod === 'chatgpt'
  )
}

export function shouldClearAnthropicApiKeyForTeammateSpawn(params: {
  anthropicApiKey: string | undefined
  customApiKeyStatus: 'approved' | 'rejected' | 'new'
  isHostManagedAnthropicTarget?: boolean
  isHomespace: boolean
}): boolean {
  const {
    anthropicApiKey,
    customApiKeyStatus,
    isHostManagedAnthropicTarget,
    isHomespace,
  } = params

  if (!anthropicApiKey || isHomespace) {
    return false
  }

  if (isHostManagedAnthropicTarget) {
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
 * Applies the final narrow per-member env patch as the very last env layer.
 * This runs after every inherited-auth transformation, so patch values always
 * win (a member ANTHROPIC_AUTH_TOKEN beats the inherited parent copy).
 *
 * Claude-style patch semantics: when the patch supplies its own
 * ANTHROPIC_AUTH_TOKEN and does not explicitly set ANTHROPIC_API_KEY, the
 * competing ANTHROPIC_API_KEY is blanked as part of the patch itself so the
 * parent's key cannot race the member token.
 */
export function applyFinalMemberEnvPatch(
  envVars: Record<string, string>,
  patch: MemberEnvPatch,
): void {
  assertMemberEnvPatch(patch)
  for (const [key, value] of Object.entries(patch)) {
    envVars[key] = value
  }
  if (patch.ANTHROPIC_BASE_URL !== undefined) {
    // Reuse the explicit compatible route so child settings.env cannot later
    // restore the lead's token/URL during the before/after-trust settings pass.
    envVars[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV] = 'compatible'
  }
  if (
    typeof patch.ANTHROPIC_AUTH_TOKEN === 'string' &&
    patch.ANTHROPIC_AUTH_TOKEN !== '' &&
    patch.ANTHROPIC_API_KEY === undefined
  ) {
    envVars.ANTHROPIC_API_KEY = ''
  }
}

/**
 * Builds the `env KEY=VALUE ...` string for teammate spawn commands.
 * Always includes CLAUDECODE=1 and CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1,
 * plus any provider/config env vars that are set in the current process.
 */
export function buildInheritedEnvVars(options?: {
  provider?: TeammateProvider
  extraEnv?: Record<string, string | undefined>
  finalEnvPatch?: Record<string, string>
  forcedCodexLoginMethod?: 'api'
}): string {
  return Object.entries(buildInheritedEnvObject(options))
    .map(([key, value]) => `${key}=${quote([value])}`)
    .join(' ')
}

export function buildInheritedEnvObject(options?: {
  provider?: TeammateProvider
  extraEnv?: Record<string, string | undefined>
  finalEnvPatch?: Record<string, string>
  forcedCodexLoginMethod?: 'api'
}): Record<string, string> {
  const envVars: Record<string, string> = {
    CLAUDECODE: '1',
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  }
  const provider = options?.provider
  const useAppManagedAnthropicHelper =
    isAppManagedAnthropicApiKeyHelperTarget(provider)
  const clearCodexApiKeys = shouldClearCodexApiKeysForTeammateSpawn(
    provider,
    options?.forcedCodexLoginMethod,
  )
  const clearAnthropicApiKey = shouldClearAnthropicApiKeyForTeammateSpawn({
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    customApiKeyStatus: process.env.ANTHROPIC_API_KEY
      ? getCustomApiKeyStatus(
          normalizeApiKeyForConfig(process.env.ANTHROPIC_API_KEY),
        )
      : 'rejected',
    isHostManagedAnthropicTarget:
      isHostManagedAnthropicTeammateTarget(provider),
    isHomespace: isRunningOnHomespace(),
  })

  for (const key of TEAMMATE_ENV_VARS) {
    if (provider && PROVIDER_SELECTION_ENV_VAR_SET.has(key)) {
      continue
    }
    if (
      key.startsWith('CLAUDE_TEAM_ANTHROPIC_') &&
      !useAppManagedAnthropicHelper
    ) {
      continue
    }
    if (clearCodexApiKeys && (key === 'CODEX_API_KEY' || key === 'OPENAI_API_KEY')) {
      continue
    }
    if (
      key === 'ANTHROPIC_API_KEY' &&
      (useAppManagedAnthropicHelper || !shouldForwardAnthropicAuthToken(provider))
    ) {
      continue
    }
    const value = process.env[key]
    if (value !== undefined && value !== '') {
      envVars[key] = value
    }
  }

  if (useAppManagedAnthropicHelper) {
    for (const key of APP_MANAGED_ANTHROPIC_COMPETING_AUTH_ENV_VARS) {
      envVars[key] = ''
    }
    envVars[APP_MANAGED_ANTHROPIC_AUTH_MODE_ENV] =
      APP_MANAGED_ANTHROPIC_AUTH_MODE_API_KEY_HELPER
    envVars[APP_MANAGED_ANTHROPIC_SETTINGS_PATH_ENV] =
      process.env[APP_MANAGED_ANTHROPIC_SETTINGS_PATH_ENV] ?? ''
  } else if (clearAnthropicApiKey) {
    // Explicitly blank the inherited shell env for pane/process teammates. Not
    // forwarding the key is insufficient because tmux/login shells and native
    // process spawns can still inherit ANTHROPIC_API_KEY from the parent env.
    envVars.ANTHROPIC_API_KEY = ''
  }

  if (clearCodexApiKeys) {
    envVars.CODEX_API_KEY = ''
    envVars.OPENAI_API_KEY = ''
  }

  if (options?.extraEnv) {
    for (const [key, value] of Object.entries(options.extraEnv)) {
      if (value !== undefined) {
        envVars[key] = value
      }
    }
  }

  // Keep the external Anthropic bearer token aligned with the forwarded
  // ANTHROPIC_BASE_URL, but only for Anthropic-routed teammates.
  if (
    shouldForwardAnthropicAuthToken(provider) &&
    !useAppManagedAnthropicHelper &&
    process.env.ANTHROPIC_AUTH_TOKEN
  ) {
    envVars.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN
  }

  if (provider) {
    for (const key of PROVIDER_SELECTION_ENV_VARS) {
      envVars[key] = ''
    }
    // Teammate provider overrides must be positive pins, not "unset and hope
    // firstParty wins". The desktop/dev host can already be running with a
    // different routed provider (for example codex), and settings.env is
    // applied again after trust inside the child. Mark the child as
    // host-managed and set an explicit entry provider for all override cases,
    // including anthropic, so model alias resolution cannot drift.
    envVars.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    envVars.CLAUDE_CODE_ENTRY_PROVIDER = getExplicitEntryProvider(provider)
  }

  if (useAppManagedAnthropicHelper) {
    for (const key of APP_MANAGED_ANTHROPIC_COMPETING_AUTH_ENV_VARS) {
      envVars[key] = ''
    }
    envVars[APP_MANAGED_ANTHROPIC_AUTH_MODE_ENV] =
      APP_MANAGED_ANTHROPIC_AUTH_MODE_API_KEY_HELPER
    envVars[APP_MANAGED_ANTHROPIC_SETTINGS_PATH_ENV] =
      process.env[APP_MANAGED_ANTHROPIC_SETTINGS_PATH_ENV] ?? ''
  }

  applyAnthropicTeammateConnectionPolicy(envVars, provider)
  if (clearAnthropicApiKey && !useAppManagedAnthropicHelper) {
    envVars.ANTHROPIC_API_KEY = ''
  }

  if (options?.forcedCodexLoginMethod === 'api') {
    // Per-member Codex login mode pin. Scoped to this member's spawn only, so
    // a lead-level chatgpt forced login cannot clobber a gateway member's
    // API-key login mode.
    envVars[CODEX_FORCED_LOGIN_METHOD_ENV_VAR] = 'api'
  }

  // Final layer: the narrow per-member env patch always wins over inherited
  // auth env, and no auth re-normalization runs after it.
  if (options?.finalEnvPatch) {
    applyFinalMemberEnvPatch(envVars, options.finalEnvPatch)
  }

  return envVars
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
  const scriptPath = join(scriptDir, 'launch.sh')
  const script = [
    '#!/bin/sh',
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

  return `sh ${quote([scriptPath])}`
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
