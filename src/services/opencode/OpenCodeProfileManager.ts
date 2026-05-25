import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  readlink,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Dirent } from 'node:fs'

import { getCwd } from '../../utils/cwd.js'
import { safeParseJSONC } from '../../utils/json.js'
import {
  applyOpenCodeAutoUpdatePolicy,
  isOpenCodeAutoUpdateAllowed,
} from './OpenCodeAutoUpdatePolicy.js'
import {
  OPEN_CODE_APP_MCP_SERVER_NAME,
  resolveOpenCodeAppMcpLaunchConfig,
} from './OpenCodeMcpManager.js'
import {
  doesOpenCodeAuthStoreIncludeSource,
  mergeOpenCodeAuthStores,
  reconcileOpenCodeManagedAuthStore,
  readOpenCodeAuthStore,
} from './OpenCodeAuthStore.js'
import {
  readOpenCodeGlobalManagedRuntimePreferences,
  readOpenCodeManagedRuntimePreferences,
} from './OpenCodeManagedPreferences.js'
import {
  CLAUDE_MULTIMODEL_CACHE_HOME_ENV,
  CLAUDE_MULTIMODEL_DATA_HOME_ENV,
  resolveClaudeMultimodelPaths,
} from './OpenCodeManagedPaths.js'
import type {
  OpenCodeMcpServerConfig,
  OpenCodePrepareProfileOptions,
  OpenCodePreparedProfile,
  OpenCodeToolApprovalMode,
} from './types.js'

export const OPEN_CODE_TEAMMATE_AGENT_NAME = 'teammate'
export const OPEN_CODE_TEAMMATE_BOOTSTRAP_AGENT_NAME = 'teammate-bootstrap'
export const OPEN_CODE_MODEL_PROBE_AGENT_NAME = 'teammate-model-probe'

const ATLAS_CLOUD_PROVIDER_ID = 'atlascloud'
const atlasCloudModel = (
  name: string,
  context: number,
  output: number,
  options: { reasoning?: boolean } = {},
) => ({
  name,
  ...(options.reasoning ? { reasoning: true } : {}),
  tool_call: true,
  limit: {
    context,
    output,
  },
})

const ATLAS_CLOUD_OPENCODE_MODELS = {
  // TODO: Replace this curated fallback with cached Atlas /v1/models sync.
  // Keep this map as the offline fallback so OpenCode startup never depends on network availability.
  'zai-org/glm-5.1': atlasCloudModel('GLM 5.1', 202_752, 202_752, { reasoning: true }),
  'zai-org/glm-5-turbo': atlasCloudModel('GLM 5 Turbo', 262_144, 131_072, {
    reasoning: true,
  }),
  'zai-org/glm-5': atlasCloudModel('GLM 5', 202_752, 202_752, { reasoning: true }),
  'zai-org/glm-4.7': atlasCloudModel('GLM 4.7', 202_752, 202_752, { reasoning: true }),
  'deepseek-ai/deepseek-v4-pro': atlasCloudModel('DeepSeek V4 Pro', 1_048_576, 393_216),
  'deepseek-ai/deepseek-v4-flash': atlasCloudModel('DeepSeek V4 Flash', 1_048_576, 393_216),
  'deepseek-ai/deepseek-v3.2': atlasCloudModel('DeepSeek V3.2', 163_840, 163_840, {
    reasoning: true,
  }),
  'deepseek-ai/DeepSeek-V3.1': atlasCloudModel('DeepSeek V3.1', 131_072, 65_536, {
    reasoning: true,
  }),
  'moonshotai/kimi-k2.6': atlasCloudModel('Kimi K2.6', 262_144, 262_144, {
    reasoning: true,
  }),
  'moonshotai/kimi-k2.5': atlasCloudModel('Kimi K2.5', 262_144, 262_144, {
    reasoning: true,
  }),
  'moonshotai/Kimi-K2-Thinking': atlasCloudModel('Kimi K2 Thinking', 262_144, 262_144, {
    reasoning: true,
  }),
  'moonshotai/Kimi-K2-Instruct': atlasCloudModel('Kimi K2 Instruct', 131_072, 131_072),
  'minimaxai/minimax-m2.7': atlasCloudModel('MiniMax M2.7', 196_608, 196_608, {
    reasoning: true,
  }),
  'minimaxai/minimax-m2.5': atlasCloudModel('MiniMax M2.5', 196_608, 196_608, {
    reasoning: true,
  }),
  'minimaxai/minimax-m2.1': atlasCloudModel('MiniMax M2.1', 196_608, 196_608, {
    reasoning: true,
  }),
  'Qwen/Qwen3-Coder': atlasCloudModel('Qwen3 Coder', 262_144, 262_144),
  'qwen/qwen3-coder-next': atlasCloudModel('Qwen3 Coder Next', 262_144, 262_144),
  'qwen/qwen3.6-plus': atlasCloudModel('Qwen3.6 Plus', 1_000_000, 65_536, {
    reasoning: true,
  }),
  'qwen/qwen3.5-397b-a17b': atlasCloudModel('Qwen3.5 397B A17B', 262_144, 65_536, {
    reasoning: true,
  }),
  'qwen/qwen3-max-2026-01-23': atlasCloudModel('Qwen3 Max 20260123', 252_000, 32_000),
  'kwaipilot/kat-coder-pro-v2': atlasCloudModel('KAT Coder Pro V2', 262_144, 144_000),
} as const

const ATLAS_CLOUD_PROVIDER_CONFIG = {
  npm: '@ai-sdk/openai-compatible',
  name: 'Atlas Cloud',
  options: {
    baseURL: 'https://api.atlascloud.ai/v1',
  },
  models: ATLAS_CLOUD_OPENCODE_MODELS,
} as const

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function hashBuffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function buildOpenCodeTeammatePermission(
  toolApprovalMode: OpenCodeToolApprovalMode = 'auto',
): Record<string, unknown> {
  if (toolApprovalMode === 'manual') {
    return {
      '*': 'ask',
      task: {
        '*': 'deny',
      },
      external_directory: 'deny',
      doom_loop: 'deny',
      'agent-teams_*': 'allow',
      'agent_teams_*': 'allow',
      'mcp__agent-teams__*': 'allow',
      'mcp__agent_teams__*': 'allow',
    }
  }

  return {
    '*': 'deny',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    lsp: 'allow',
    todoread: 'allow',
    todowrite: 'allow',
    edit: 'allow',
    bash: 'allow',
    task: {
      '*': 'deny',
    },
    external_directory: 'deny',
    doom_loop: 'deny',
    'agent-teams_*': 'allow',
    'agent_teams_*': 'allow',
    'mcp__agent-teams__*': 'allow',
    'mcp__agent_teams__*': 'allow',
  }
}

function parseProviderScopedModelId(value: string): {
  providerId: string
  modelId: string
} | null {
  const trimmed = value.trim()
  const separatorIndex = trimmed.indexOf('/')
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
    return null
  }

  return {
    providerId: trimmed.slice(0, separatorIndex),
    modelId: trimmed.slice(separatorIndex + 1),
  }
}

function normalizePositiveInteger(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  const normalized = Math.floor(value)
  return normalized > 0 ? normalized : null
}

async function readFingerprint(filePath: string): Promise<string | null> {
  try {
    const content = await readFile(filePath)
    return hashBuffer(content)
  } catch {
    return null
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

function getErrnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

function isAccessDeniedLinkError(error: unknown): boolean {
  const code = getErrnoCode(error)
  return code === 'EPERM' || code === 'EACCES'
}

function normalizePathForCompare(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

async function removePathIfPresent(filePath: string): Promise<void> {
  await rm(filePath, { recursive: true, force: true }).catch(error => {
    if (getErrnoCode(error) !== 'ENOENT') {
      throw error
    }
  })
}

async function isDirectoryLinkTo(linkPath: string, targetPath: string): Promise<boolean> {
  let existing: Awaited<ReturnType<typeof lstat>>
  try {
    existing = await lstat(linkPath)
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') {
      return false
    }
    throw error
  }
  if (!existing.isSymbolicLink() && !existing.isDirectory()) {
    return false
  }

  try {
    const [linkRealPath, targetRealPath] = await Promise.all([
      realpath(linkPath),
      realpath(targetPath),
    ])
    if (normalizePathForCompare(linkRealPath) === normalizePathForCompare(targetRealPath)) {
      return true
    }
  } catch {
    // readlink below still handles symlinks whose target currently cannot be realpathed.
  }

  if (!existing.isSymbolicLink()) {
    return false
  }

  try {
    const currentTarget = await readlink(linkPath)
    return normalizePathForCompare(path.resolve(path.dirname(linkPath), currentTarget))
      === normalizePathForCompare(targetPath)
  } catch (error) {
    if (getErrnoCode(error) === 'EINVAL' || getErrnoCode(error) === 'ENOENT') {
      return false
    }
    throw error
  }
}

export type OpenCodeProfileNodeModulesMode =
  | 'shared-symlink'
  | 'shared-junction'
  | 'profile-directory'

type DirectorySymlinkType = 'dir' | 'junction'

type SymlinkDirectory = (
  target: string,
  path: string,
  type?: DirectorySymlinkType,
) => Promise<void>

export type EnsureOpenCodeProfileNodeModulesOptions = {
  platform?: NodeJS.Platform
  symlink?: SymlinkDirectory
}

async function tryCreateSharedDirectoryLink(
  linkPath: string,
  targetPath: string,
  options: Required<EnsureOpenCodeProfileNodeModulesOptions>,
): Promise<
  | { ok: true, mode: OpenCodeProfileNodeModulesMode }
  | { ok: false, error: unknown }
> {
  const attempts: DirectorySymlinkType[] = options.platform === 'win32'
    ? ['dir', 'junction']
    : ['dir']

  let lastError: unknown = null
  for (const linkType of attempts) {
    try {
      await options.symlink(path.resolve(targetPath), linkPath, linkType)
      return {
        ok: true,
        mode: linkType === 'junction' ? 'shared-junction' : 'shared-symlink',
      }
    } catch (error) {
      if (getErrnoCode(error) === 'EEXIST' && await isDirectoryLinkTo(linkPath, targetPath)) {
        return {
          ok: true,
          mode: linkType === 'junction' ? 'shared-junction' : 'shared-symlink',
        }
      }
      lastError = error
      if (
        linkType === 'dir'
        && options.platform === 'win32'
        && isAccessDeniedLinkError(error)
      ) {
        continue
      }
      break
    }
  }

  return { ok: false, error: lastError }
}

async function restoreOrCreateProfileDirectory(input: {
  linkPath: string
  backupPath: string | null
  backupWasDirectory: boolean
}): Promise<void> {
  await removePathIfPresent(input.linkPath)
  if (input.backupPath && input.backupWasDirectory) {
    try {
      await rename(input.backupPath, input.linkPath)
      return
    } catch (error) {
      if (getErrnoCode(error) !== 'ENOENT') {
        throw error
      }
    }
  }
  if (input.backupPath) {
    await removePathIfPresent(input.backupPath)
  }
  await mkdir(input.linkPath, { recursive: true })
}

export async function ensureOpenCodeProfileNodeModulesPath(
  linkPath: string,
  targetPath: string,
  rawOptions: EnsureOpenCodeProfileNodeModulesOptions = {},
): Promise<OpenCodeProfileNodeModulesMode> {
  const options: Required<EnsureOpenCodeProfileNodeModulesOptions> = {
    platform: rawOptions.platform ?? process.platform,
    symlink: rawOptions.symlink ?? symlink,
  }
  await mkdir(targetPath, { recursive: true })
  await mkdir(path.dirname(linkPath), { recursive: true })

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await isDirectoryLinkTo(linkPath, targetPath)) {
      return options.platform === 'win32' ? 'shared-junction' : 'shared-symlink'
    }

    let existing: Awaited<ReturnType<typeof lstat>> | null = null
    try {
      existing = await lstat(linkPath)
    } catch (error) {
      if (getErrnoCode(error) !== 'ENOENT') {
        throw error
      }
    }

    if (!existing) {
      const created = await tryCreateSharedDirectoryLink(linkPath, targetPath, options)
      if (created.ok) {
        return created.mode
      }
      if (isAccessDeniedLinkError(created.error)) {
        await mkdir(linkPath, { recursive: true })
        return 'profile-directory'
      }
      throw created.error
    }

    const backupPath = `${linkPath}.replaced-${process.pid}-${Date.now()}-${attempt}`
    const backupWasDirectory = existing.isDirectory() && !existing.isSymbolicLink()
    try {
      await rename(linkPath, backupPath)
    } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') {
        continue
      }
      if (isAccessDeniedLinkError(error) && backupWasDirectory) {
        return 'profile-directory'
      }
      throw error
    }

    const created = await tryCreateSharedDirectoryLink(linkPath, targetPath, options)
    if (created.ok) {
      await removePathIfPresent(backupPath)
      return created.mode
    }

    if (isAccessDeniedLinkError(created.error)) {
      await restoreOrCreateProfileDirectory({ linkPath, backupPath, backupWasDirectory })
      return 'profile-directory'
    }

    await restoreOrCreateProfileDirectory({ linkPath, backupPath, backupWasDirectory })
    throw created.error
  }

  if (await isDirectoryLinkTo(linkPath, targetPath)) {
    return options.platform === 'win32' ? 'shared-junction' : 'shared-symlink'
  }
  await removePathIfPresent(linkPath)
  const created = await tryCreateSharedDirectoryLink(linkPath, targetPath, options)
  if (created.ok) {
    return created.mode
  }
  if (isAccessDeniedLinkError(created.error)) {
    await mkdir(linkPath, { recursive: true })
    return 'profile-directory'
  }
  throw created.error
}

async function runAfterSettled(previous: Promise<void> | undefined): Promise<void> {
  try {
    await previous
  } catch {
    // The next profile preparation should not be blocked by an earlier failure.
  }
}

const PROJECT_BEHAVIOR_FILES = [
  'opencode.json',
  'opencode.jsonc',
  'AGENTS.md',
  'CLAUDE.md',
  '.opencode/package.json',
  '.opencode/package-lock.json',
  '.opencode/pnpm-lock.yaml',
  '.opencode/yarn.lock',
  '.opencode/npm-shrinkwrap.json',
  '.opencode/bun.lock',
  '.opencode/bun.lockb',
] as const

const PROJECT_BEHAVIOR_DIRS = [
  '.opencode/plugins',
  '.opencode/tools',
  '.opencode/agents',
  '.opencode/commands',
  '.opencode/modes',
  '.opencode/skills',
  '.agents/skills',
] as const

async function collectBehaviorDirectoryEntries(
  rootPath: string,
  relativeDir: string,
): Promise<string[]> {
  const absoluteDir = path.join(rootPath, relativeDir)
  if (!(await fileExists(absoluteDir))) {
    return []
  }

  const entries: string[] = []
  const walk = async (currentDir: string): Promise<void> => {
    const dirents = await readdir(currentDir, { withFileTypes: true })
    dirents.sort((left, right) => left.name.localeCompare(right.name))

    for (const dirent of dirents) {
      if (dirent.name === '.DS_Store' || dirent.name === '.git' || dirent.name === 'node_modules') {
        continue
      }

      const nextPath = path.join(currentDir, dirent.name)
      if (dirent.isDirectory()) {
        await walk(nextPath)
        continue
      }
      if (!dirent.isFile()) {
        continue
      }

      const relativePath = path.relative(rootPath, nextPath)
      const content = await readFile(nextPath)
      entries.push(`${relativePath}:${hashBuffer(content)}`)
    }
  }

  await walk(absoluteDir)
  return entries
}

export async function collectProjectBehaviorMetadata(projectPath: string): Promise<{
  projectBehaviorFingerprint: string
  behaviorSources: string[]
}> {
  const entries: string[] = []
  const behaviorSources = new Set<string>()

  for (const relativePath of PROJECT_BEHAVIOR_FILES) {
    const absolutePath = path.join(projectPath, relativePath)
    if (!(await fileExists(absolutePath))) {
      continue
    }

    const content = await readFile(absolutePath)
    entries.push(`${relativePath}:${hashBuffer(content)}`)
    behaviorSources.add(relativePath)
  }

  for (const relativeDir of PROJECT_BEHAVIOR_DIRS) {
    const dirEntries = await collectBehaviorDirectoryEntries(projectPath, relativeDir)
    for (const entry of dirEntries) {
      const separatorIndex = entry.indexOf(':')
      behaviorSources.add(separatorIndex >= 0 ? entry.slice(0, separatorIndex) : entry)
      entries.push(entry)
    }
  }

  entries.sort()

  return {
    projectBehaviorFingerprint: hashString(entries.join('\n')),
    behaviorSources: Array.from(behaviorSources).sort(),
  }
}

export function buildManagedConfig(
  appMcpConfig?: OpenCodeMcpServerConfig | null,
  options: {
    allowAutoUpdate?: boolean
    defaultModelId?: string | null
    modelOutputLimitOverrides?: OpenCodePrepareProfileOptions['modelOutputLimitOverrides']
    toolApprovalMode?: OpenCodeToolApprovalMode
  } = {},
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    default_agent: OPEN_CODE_TEAMMATE_AGENT_NAME,
    share: 'disabled',
    snapshot: true,
    provider: {
      [ATLAS_CLOUD_PROVIDER_ID]: ATLAS_CLOUD_PROVIDER_CONFIG,
    },
    agent: {
      [OPEN_CODE_TEAMMATE_AGENT_NAME]: {
        mode: 'primary',
        description: 'Managed teammate agent for claude-multimodel runtime orchestration.',
        permission: buildOpenCodeTeammatePermission(options.toolApprovalMode),
      },
      [OPEN_CODE_TEAMMATE_BOOTSTRAP_AGENT_NAME]: {
        mode: 'primary',
        description: 'Silent launch bootstrap agent restricted to Agent Teams MCP attach tools.',
        tools: {
          '*': false,
          'agent-teams_*': true,
          'agent_teams_*': true,
          'mcp__agent-teams__*': true,
          'mcp__agent_teams__*': true,
        },
        permission: {
          '*': 'deny',
          'agent-teams_*': 'allow',
          'agent_teams_*': 'allow',
          'mcp__agent-teams__*': 'allow',
          'mcp__agent_teams__*': 'allow',
        },
      },
      [OPEN_CODE_MODEL_PROBE_AGENT_NAME]: {
        mode: 'primary',
        description: 'Minimal model execution probe agent with tools disabled.',
        tools: {
          '*': false,
        },
        permission: {
          '*': 'deny',
        },
      },
    },
    // Keep project/global plugin config untouched. OpenCode merges inline config as overrides,
    // so setting plugin here would shadow user and project extension points.
  }

  if (options.allowAutoUpdate !== true) {
    config.autoupdate = false
  }

  const defaultModelId = options.defaultModelId?.trim()
  if (defaultModelId) {
    config.model = defaultModelId
  }

  for (const override of options.modelOutputLimitOverrides ?? []) {
    const parsedModel = parseProviderScopedModelId(override.modelId)
    const outputTokens = normalizePositiveInteger(override.outputTokens)
    if (!parsedModel || outputTokens === null) {
      continue
    }

    const contextTokens = normalizePositiveInteger(override.contextTokens)
      ?? Math.max(outputTokens, 32_000)
    const providerConfig = { ...asRecord(asRecord(config.provider)[parsedModel.providerId]) }
    const models = { ...asRecord(providerConfig.models) }
    const modelConfig = { ...asRecord(models[parsedModel.modelId]) }
    modelConfig.limit = {
      context: contextTokens,
      output: outputTokens,
    }
    models[parsedModel.modelId] = modelConfig
    providerConfig.models = models
    config.provider = {
      ...asRecord(config.provider),
      [parsedModel.providerId]: providerConfig,
    }
  }

  if (appMcpConfig) {
    config.mcp = {
      [OPEN_CODE_APP_MCP_SERVER_NAME]: appMcpConfig,
    }
  }

  return config
}

function hasOwnRecordKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0
}

function deepMergeOpenCodeConfig(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key]
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && existing
      && typeof existing === 'object'
      && !Array.isArray(existing)
    ) {
      merged[key] = deepMergeOpenCodeConfig(
        existing as Record<string, unknown>,
        value as Record<string, unknown>,
      )
      continue
    }
    merged[key] = value
  }
  return merged
}

function pickSafeOpenCodeRuntimeConfig(value: unknown): Record<string, unknown> {
  const source = asRecord(value)
  const safe: Record<string, unknown> = {}
  const provider = asRecord(source.provider)
  if (hasOwnRecordKeys(provider)) {
    safe.provider = provider
  }

  const model = typeof source.model === 'string' ? source.model.trim() : ''
  if (model) {
    safe.model = model
  }

  const smallModel = typeof source.small_model === 'string' ? source.small_model.trim() : ''
  if (smallModel) {
    safe.small_model = smallModel
  }

  return safe
}

function getOpenCodeConfigImportPaths(env: NodeJS.ProcessEnv): string[] {
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config')
  const candidates = [
    path.join(xdgConfigHome, 'opencode', 'opencode.json'),
    path.join(xdgConfigHome, 'opencode', 'opencode.jsonc'),
    path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
    path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc'),
  ]
  const explicitConfigPath = env.OPENCODE_CONFIG?.trim()
  if (explicitConfigPath) {
    candidates.push(path.resolve(explicitConfigPath))
  }
  return Array.from(new Set(candidates.map(candidate => path.resolve(candidate))))
}

async function readSafeOpenCodeRuntimeConfigFile(
  filePath: string,
): Promise<Record<string, unknown>> {
  try {
    return pickSafeOpenCodeRuntimeConfig(safeParseJSONC(await readFile(filePath, 'utf8')))
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT' || getErrnoCode(error) === 'ENOTDIR') {
      return {}
    }
    return {}
  }
}

async function readSafeOpenCodeRuntimeConfigImport(
  env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  let importedConfig: Record<string, unknown> = {}
  for (const configPath of getOpenCodeConfigImportPaths(env)) {
    importedConfig = deepMergeOpenCodeConfig(
      importedConfig,
      await readSafeOpenCodeRuntimeConfigFile(configPath),
    )
  }

  importedConfig = deepMergeOpenCodeConfig(
    importedConfig,
    pickSafeOpenCodeRuntimeConfig(safeParseJSONC(env.OPENCODE_CONFIG_CONTENT)),
  )

  return importedConfig
}

function applyManagedPathEnvironmentToMcpConfig(
  managedConfig: Record<string, unknown>,
  environment: Record<string, string>,
): void {
  const mcpConfig = asRecord(managedConfig.mcp)
  if (!(OPEN_CODE_APP_MCP_SERVER_NAME in mcpConfig)) {
    return
  }

  const appMcpConfig = {
    ...asRecord(mcpConfig[OPEN_CODE_APP_MCP_SERVER_NAME]),
  }
  if (appMcpConfig.type === 'remote') {
    return
  }
  appMcpConfig.environment = {
    ...asRecord(appMcpConfig.environment),
    ...environment,
  }
  managedConfig.mcp = {
    ...mcpConfig,
    [OPEN_CODE_APP_MCP_SERVER_NAME]: appMcpConfig,
  }
}

function normalizeManagedConfigForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => normalizeManagedConfigForFingerprint(item))
  }
  if (!value || typeof value !== 'object') {
    return value
  }

  const record = value as Record<string, unknown>
  return Object.keys(record).sort().reduce<Record<string, unknown>>((acc, key) => {
    // Environment values like PATH, TMPDIR, and control URLs are runtime
    // transport detail, not capability identity for production proof.
    if (key === 'environment' || (key === 'url' && record.type === 'remote')) {
      return acc
    }
    acc[key] = normalizeManagedConfigForFingerprint(record[key])
    return acc
  }, {})
}

export function buildManagedConfigFingerprint(managedConfig: Record<string, unknown>): string {
  return hashString(JSON.stringify(normalizeManagedConfigForFingerprint(managedConfig)))
}

export function orderOpenCodeAuthSyncSources(input: {
  globalAuthPath: string
  globalAuthFingerprint: string | null
  sourceAuthPath?: string
  sourceAuthFingerprint?: string | null
  sourceAuthSources?: Array<{ path: string; fingerprint: string | null }>
}): string[] {
  const sources: string[] = []
  // App-managed global credentials can provide providers that the real OpenCode
  // store does not know about, but they must not overwrite a freshly refreshed
  // local OpenCode OAuth provider. Sync global first, then local source last.
  if (input.globalAuthFingerprint) {
    sources.push(input.globalAuthPath)
  }
  const sourceAuthSources = input.sourceAuthSources
    ?? (input.sourceAuthPath
      ? [{ path: input.sourceAuthPath, fingerprint: input.sourceAuthFingerprint ?? null }]
      : [])
  for (const source of sourceAuthSources) {
    if (!source.fingerprint || sources.includes(source.path)) {
      continue
    }
    sources.push(source.path)
  }
  return sources
}

export class OpenCodeProfileManager {
  private static readonly profilePreparationLocks = new Map<string, Promise<void>>()

  private readonly paths = resolveClaudeMultimodelPaths()

  private getSourceAuthPaths(): string[] {
    const xdgDataHome =
      process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share')
    return Array.from(new Set([
      path.join(xdgDataHome, 'opencode', 'auth.json'),
      // Bridge/live-test processes can intentionally set XDG_DATA_HOME to an
      // isolated runtime directory. Always include the canonical user OpenCode
      // auth store as the highest-priority source so a fresh `opencode auth`
      // login can override stale app-global OAuth credentials.
      path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'),
    ]))
  }

  getGlobalAuthPath(): string {
    return path.join(this.paths.data, 'opencode', 'auth.json')
  }

  async listManagedAuthPaths(): Promise<string[]> {
    const profilesRootPath = path.join(this.paths.data, 'opencode', 'profiles')
    let entries: Dirent[]
    try {
      entries = await readdir(profilesRootPath, { withFileTypes: true })
    } catch {
      return []
    }

    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(profilesRootPath, entry.name, 'data', 'opencode', 'auth.json'))
      .sort((left, right) => left.localeCompare(right))
  }

  private getProjectPath(projectPath?: string | null): string {
    return path.resolve(projectPath?.trim() || getCwd())
  }

  private getProfileRootKey(projectPath: string): string {
    return hashString(projectPath).slice(0, 16)
  }

  private async resolveManagedAppMcpConfig(): Promise<OpenCodeMcpServerConfig | null> {
    try {
      return (await resolveOpenCodeAppMcpLaunchConfig()).config
    } catch {
      return null
    }
  }

  private async withProfilePreparationLock<T>(
    profileRootKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = OpenCodeProfileManager.profilePreparationLocks.get(profileRootKey)
    let release!: () => void
    const current = new Promise<void>(resolve => {
      release = resolve
    })
    OpenCodeProfileManager.profilePreparationLocks.set(profileRootKey, current)

    await runAfterSettled(previous)
    try {
      return await operation()
    } finally {
      release()
      if (OpenCodeProfileManager.profilePreparationLocks.get(profileRootKey) === current) {
        OpenCodeProfileManager.profilePreparationLocks.delete(profileRootKey)
      }
    }
  }

  async prepareProfile(
    projectPath?: string | null,
    options: OpenCodePrepareProfileOptions = {},
  ): Promise<OpenCodePreparedProfile> {
    const resolvedProjectPath = this.getProjectPath(projectPath)
    const profileRootKey = this.getProfileRootKey(resolvedProjectPath)
    return this.withProfilePreparationLock(profileRootKey, async () => {
    const profileRootPath = path.join(
      this.paths.data,
      'opencode',
      'profiles',
      profileRootKey,
    )
    const { projectBehaviorFingerprint, behaviorSources } =
      await collectProjectBehaviorMetadata(resolvedProjectPath)
    const managedRuntimePreferences = await readOpenCodeManagedRuntimePreferences(profileRootPath)
    const globalRuntimePreferences = await readOpenCodeGlobalManagedRuntimePreferences(
      this.paths.data,
    )
    const effectiveManagedDefaultModelId =
      managedRuntimePreferences.defaultModelId ?? globalRuntimePreferences.defaultModelId
    const effectiveManagedDefaultSource = managedRuntimePreferences.defaultModelId
      ? 'project' as const
      : globalRuntimePreferences.defaultModelId
        ? 'all_projects' as const
        : null
    const importedRuntimeConfig = await readSafeOpenCodeRuntimeConfigImport(process.env)
    const appMcpConfig =
      options.includeAppMcp === false
        ? null
        : await this.resolveManagedAppMcpConfig()
    const managedConfig = deepMergeOpenCodeConfig(
      importedRuntimeConfig,
      buildManagedConfig(appMcpConfig, {
        allowAutoUpdate: isOpenCodeAutoUpdateAllowed(process.env),
        defaultModelId: effectiveManagedDefaultModelId,
        modelOutputLimitOverrides: options.modelOutputLimitOverrides,
        toolApprovalMode: options.toolApprovalMode,
      }),
    )
    applyManagedPathEnvironmentToMcpConfig(managedConfig, {
      [CLAUDE_MULTIMODEL_DATA_HOME_ENV]: this.paths.data,
      [CLAUDE_MULTIMODEL_CACHE_HOME_ENV]: this.paths.cache,
    })
    const managedConfigFingerprint = buildManagedConfigFingerprint(managedConfig)
    const homePath = path.join(profileRootPath, 'home')
    const xdgConfigHome = path.join(profileRootPath, 'config')
    const xdgDataHome = path.join(profileRootPath, 'data')
    const xdgCacheHome = path.join(this.paths.cache, 'opencode', 'shared-cache')
    const sharedNpmCachePath = path.join(xdgCacheHome, 'npm')
    const sharedOpenCodeNodeModulesPath = path.join(xdgCacheHome, 'config-node_modules')
    const profileOpenCodeNodeModulesPath = path.join(xdgConfigHome, 'opencode', 'node_modules')
    const managedAuthPath = path.join(xdgDataHome, 'opencode', 'auth.json')
    const globalAuthPath = this.getGlobalAuthPath()
    const sourceAuthSources = await Promise.all(
      this.getSourceAuthPaths().map(async sourceAuthPath => {
        const exists = await fileExists(sourceAuthPath)
        return {
          path: sourceAuthPath,
          fingerprint: exists ? await readFingerprint(sourceAuthPath) : null,
        }
      }),
    )

    await Promise.all([
      mkdir(homePath, { recursive: true }),
      mkdir(xdgConfigHome, { recursive: true }),
      mkdir(path.join(xdgDataHome, 'opencode'), { recursive: true }),
      mkdir(xdgCacheHome, { recursive: true }),
      mkdir(sharedNpmCachePath, { recursive: true }),
    ])
    await ensureOpenCodeProfileNodeModulesPath(
      profileOpenCodeNodeModulesPath,
      sharedOpenCodeNodeModulesPath,
    )

    const globalAuthExists = await fileExists(globalAuthPath)
    const globalAuthFingerprint = globalAuthExists
      ? await readFingerprint(globalAuthPath)
      : null
    const sourceAuthFingerprint = sourceAuthSources.some(source => source.fingerprint)
      ? hashString(sourceAuthSources
        .filter(source => source.fingerprint)
        .map(source => `${source.path}:${source.fingerprint}`)
        .join('\n'))
      : null
    const authSourcePaths = orderOpenCodeAuthSyncSources({
      globalAuthPath,
      globalAuthFingerprint,
      sourceAuthSources,
    })
    await reconcileOpenCodeManagedAuthStore({
      sourceAuthPaths: authSourcePaths,
      managedAuthPath,
    })

    const managedAuthFingerprint = await readFingerprint(managedAuthPath)
    const authState = await (async () => {
      if (!managedAuthFingerprint) {
        return 'missing' as const
      }
      if (authSourcePaths.length === 0) {
        return 'ok' as const
      }
      try {
        const managed = await readOpenCodeAuthStore(managedAuthPath)
        let expectedAuth: Awaited<ReturnType<typeof readOpenCodeAuthStore>> = {}
        for (const authSourcePath of authSourcePaths) {
          expectedAuth = mergeOpenCodeAuthStores({
            source: await readOpenCodeAuthStore(authSourcePath),
            managed: expectedAuth,
          })
        }
        return doesOpenCodeAuthStoreIncludeSource({ source: expectedAuth, managed })
          ? 'ok' as const
          : 'stale' as const
      } catch {
        return 'stale' as const
      }
    })()

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homePath,
      USERPROFILE: homePath,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: xdgDataHome,
      XDG_CACHE_HOME: xdgCacheHome,
      NPM_CONFIG_CACHE: sharedNpmCachePath,
      [CLAUDE_MULTIMODEL_DATA_HOME_ENV]: this.paths.data,
      [CLAUDE_MULTIMODEL_CACHE_HOME_ENV]: this.paths.cache,
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify(managedConfig),
    }
    delete env.OPENCODE_CONFIG

    return {
      projectPath: resolvedProjectPath,
      profileRootKey,
      profileRootPath,
      projectDefaultModelId: managedRuntimePreferences.defaultModelId,
      allProjectsDefaultModelId: globalRuntimePreferences.defaultModelId,
      effectiveManagedDefaultModelId,
      effectiveManagedDefaultSource,
      projectBehaviorFingerprint,
      behaviorSources,
      managedConfig,
      managedConfigFingerprint,
      homePath,
      xdgConfigHome,
      xdgDataHome,
      xdgCacheHome,
      globalAuthPath,
      managedAuthPath,
      sourceAuthPath: sourceAuthSources.findLast(source => source.fingerprint)?.path ?? null,
      sourceAuthFingerprint,
      managedAuthFingerprint,
      authState,
      env: applyOpenCodeAutoUpdatePolicy(env),
    }
    })
  }
}

export const openCodeProfileManager = new OpenCodeProfileManager()
