import { resolveOpenCodeAuthCoordinationPath } from './OpenCodeAuthCoordinationLock.js'
import { buildManagedConfigFingerprint } from './OpenCodeManagedConfigFingerprint.js'
export { buildManagedConfigFingerprint } from './OpenCodeManagedConfigFingerprint.js'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants, type Dirent } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readlink,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { parse as parseJsonc } from 'jsonc-parser/lib/esm/main.js'
function safeParseJSONC(value: string | null | undefined): unknown {
  if (!value) return null
  try { return parseJsonc(value.replace(/^\uFEFF/, '')) } catch { return null }
}
// Static package edge lets Product pin/bundle the real filesystem lock implementation in Node ESM.
import lockfile from 'proper-lockfile'
import {
  applyOpenCodeAutoUpdatePolicy,
  isOpenCodeAutoUpdateAllowed,
} from './OpenCodeAutoUpdatePolicy.js'
import { OPEN_CODE_APP_MCP_SERVER_NAME } from './OpenCodeAppMcpName.js'
import {
  getOpenCodeCuratedSubscriptionProviderConfigs,
  getOpenCodeManagedSubscriptionPluginPackages,
} from './OpenCodeCuratedSubscriptionCatalog.js'
import {
  doesOpenCodeAuthStoreIncludeSource,
  mergeOpenCodeManagedAuthSources,
  reconcileOpenCodeManagedAuthStores,
  readOpenCodeAuthCredential,
  readOpenCodeAuthStore,
  removeOpenCodeAuthCredential,
  upsertOpenCodeAuthCredential,
} from './OpenCodeAuthStore.js'
import {
  readOpenCodeGlobalManagedRuntimePreferences,
  readOpenCodeManagedRuntimePreferences,
} from './OpenCodeManagedPreferences.js'
import {
  CLAUDE_MULTIMODEL_CACHE_HOME_ENV,
  CLAUDE_MULTIMODEL_DATA_HOME_ENV,
} from './OpenCodeManagedPaths.js'
import {
  raceOpenCodeAbortSignal,
  throwOpenCodeAbortReason,
} from './OpenCodeRuntimeDeadline.js'
import {
  buildCursorAgentResourceExhaustedPreloadScript,
  CURSOR_RESOURCE_EXHAUSTED_PATCH_DISABLED_ENV,
} from './OpenCodeCursorResourceExhaustedPatch.js'
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
const GITHUB_COPILOT_PROVIDER_ID = 'github-copilot'

// Copilot Free and Student can expose only GitHub's Auto picker, which OpenCode
// cannot currently execute through an explicit model id. Seed one conservative
// explicit model so provider discovery and verification can return an actionable
// limitation instead of hiding the authenticated provider. Paid accounts still
// receive their account-specific models from OpenCode live discovery.
const GITHUB_COPILOT_FALLBACK_PROVIDER_CONFIG = {
  name: 'GitHub Copilot',
  npm: '@ai-sdk/github-copilot',
  api: 'https://api.githubcopilot.com',
  models: {
    'gpt-5-mini': {
      name: 'GPT-5 Mini',
      family: 'gpt-mini',
      attachment: true,
      reasoning: true,
      tool_call: true,
      structured_output: true,
      temperature: false,
      limit: {
        context: 264_000,
        input: 128_000,
        output: 64_000,
      },
      modalities: {
        input: ['text', 'image'],
        output: ['text'],
      },
    },
  },
} as const

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

async function isDirectorySymlinkTo(linkPath: string, targetPath: string): Promise<boolean> {
  let existing: Awaited<ReturnType<typeof lstat>>
  try {
    existing = await lstat(linkPath)
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') {
      return false
    }
    throw error
  }
  if (!existing.isSymbolicLink()) {
    return false
  }

  try {
    const currentTarget = await readlink(linkPath)
    return path.resolve(path.dirname(linkPath), currentTarget) === path.resolve(targetPath)
  } catch (error) {
    if (getErrnoCode(error) === 'EINVAL' || getErrnoCode(error) === 'ENOENT') {
      return false
    }
    throw error
  }
}

const OPEN_CODE_PROFILE_SYMLINK_LOCK_OPTIONS = {
  stale: 30_000,
  update: 5_000,
  realpath: false,
  retries: {
    retries: 120,
    minTimeout: 25,
    maxTimeout: 250,
  },
}

async function ensureDirectorySymlink(linkPath: string, targetPath: string): Promise<void> {
  await mkdir(targetPath, { recursive: true })
  await mkdir(path.dirname(linkPath), { recursive: true })

  const lockPath = `${linkPath}.prepare-lock`
  await writeFile(lockPath, '', { flag: 'a' })
  const release = await lockfile.lock(lockPath, OPEN_CODE_PROFILE_SYMLINK_LOCK_OPTIONS)

  try {
    await ensureDirectorySymlinkUnlocked(linkPath, targetPath)
  } finally {
    await release()
  }
}

async function copyDirectoryContentsPreservingExisting(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  const entries = await readdir(sourcePath, { withFileTypes: true })
  for (const entry of entries) {
    const sourceEntry = path.join(sourcePath, entry.name)
    const targetEntry = path.join(targetPath, entry.name)

    if (entry.isDirectory()) {
      await mkdir(targetEntry, { recursive: true }).catch(error => {
        if (getErrnoCode(error) !== 'EEXIST') {
          throw error
        }
      })
      const targetStat = await lstat(targetEntry).catch(error => {
        if (getErrnoCode(error) === 'ENOENT') {
          return null
        }
        throw error
      })
      if (targetStat?.isDirectory() && !targetStat.isSymbolicLink()) {
        await copyDirectoryContentsPreservingExisting(sourceEntry, targetEntry)
      }
      continue
    }

    if (entry.isSymbolicLink()) {
      const linkTarget = await readlink(sourceEntry)
      await symlink(linkTarget, targetEntry).catch(error => {
        if (getErrnoCode(error) !== 'EEXIST') {
          throw error
        }
      })
      continue
    }

    if (entry.isFile()) {
      await copyFile(sourceEntry, targetEntry, fsConstants.COPYFILE_EXCL).catch(error => {
        if (getErrnoCode(error) !== 'EEXIST') {
          throw error
        }
      })
    }
  }
}

async function preserveRealDirectoryContents(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  const sourceStat = await lstat(sourcePath).catch(error => {
    if (getErrnoCode(error) === 'ENOENT') {
      return null
    }
    throw error
  })
  if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) {
    return
  }

  const migrationLockPath = `${targetPath}.migration-lock`
  await writeFile(migrationLockPath, '', { flag: 'a' })
  const release = await lockfile.lock(migrationLockPath, OPEN_CODE_PROFILE_SYMLINK_LOCK_OPTIONS)
  try {
    await copyDirectoryContentsPreservingExisting(sourcePath, targetPath)
  } finally {
    await release()
  }
}

async function ensureDirectorySymlinkUnlocked(
  linkPath: string,
  targetPath: string,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await isDirectorySymlinkTo(linkPath, targetPath)) {
      return
    }

    try {
      await symlink(targetPath, linkPath, 'dir')
      return
    } catch (error) {
      if (getErrnoCode(error) !== 'EEXIST') {
        throw error
      }
      if (await isDirectorySymlinkTo(linkPath, targetPath)) {
        return
      }
    }

    await preserveRealDirectoryContents(linkPath, targetPath)
    await rm(linkPath, { recursive: true, force: true }).catch(error => {
      const code = getErrnoCode(error)
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error
      }
      // Another process may replace the directory with the desired symlink while
      // rm is traversing it. Treat that shape change as a retryable race.
    })
  }

  if (await isDirectorySymlinkTo(linkPath, targetPath)) {
    return
  }

  try {
    await symlink(targetPath, linkPath, 'dir')
    return
  } catch (error) {
    if (getErrnoCode(error) === 'EEXIST' && await isDirectorySymlinkTo(linkPath, targetPath)) {
      return
    }
    throw error
  }
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
      [GITHUB_COPILOT_PROVIDER_ID]: GITHUB_COPILOT_FALLBACK_PROVIDER_CONFIG,
      ...getOpenCodeCuratedSubscriptionProviderConfigs(),
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

  applyOpenCodeModelLimitOverrides(config, options.modelOutputLimitOverrides)

  if (appMcpConfig) {
    config.mcp = {
      [OPEN_CODE_APP_MCP_SERVER_NAME]: appMcpConfig,
    }
  }

  return config
}

export function applyOpenCodeModelLimitOverrides(
  config: Record<string, unknown>,
  overrides: OpenCodePrepareProfileOptions['modelOutputLimitOverrides'],
): void {
  for (const override of overrides ?? []) {
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

export function applyOpenCodeManagedSubscriptionPlugins(
  config: Record<string, unknown>,
): void {
  const configuredPlugins = Array.isArray(config.plugin)
    ? config.plugin.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : []
  config.plugin = [
    ...new Set([
      ...configuredPlugins,
      ...getOpenCodeManagedSubscriptionPluginPackages(),
    ]),
  ]
}

export async function repairEmptyOpenCodeManagedPluginCaches(
  xdgCacheHome: string,
): Promise<void> {
  const packagesRoot = path.join(xdgCacheHome, 'opencode', 'packages')
  await Promise.all(
    getOpenCodeManagedSubscriptionPluginPackages().map(async packageSpec => {
      const packageCachePath = path.join(packagesRoot, packageSpec)
      let entries: string[]
      try {
        entries = await readdir(packageCachePath)
      } catch (error) {
        if (getErrnoCode(error) === 'ENOENT') {
          return
        }
        throw error
      }
      // OpenCode can leave this directory empty if the app closes during the
      // first package install. Its resolver then treats the path as cached and
      // never retries, so remove only the provably empty managed cache entry.
      if (entries.length === 0) {
        await rm(packageCachePath, { recursive: true, force: true })
      }
    }),
  )
}

export async function areOpenCodeManagedPluginCachesReady(
  xdgCacheHome: string,
): Promise<boolean> {
  const packagesRoot = path.join(xdgCacheHome, 'opencode', 'packages')
  const readiness = await Promise.all(
    getOpenCodeManagedSubscriptionPluginPackages().map(packageSpec =>
      fileExists(path.join(packagesRoot, packageSpec, 'package.json')),
    ),
  )
  return readiness.every(Boolean)
}

interface OpenCodeNativeCliCredentialBridge {
  binPath: string
  cursorAgentExecutablePath: string
  kiroCliExecutablePath: string
  hostHomePath: string
}

type KiroCliAuthProbe = (
  executablePath: string,
  platform: NodeJS.Platform,
  environment?: NodeJS.ProcessEnv,
) => Promise<boolean>

interface KiroCliWhoamiResult {
  error?: unknown
  stdout?: Buffer | string | null
  stderr?: Buffer | string | null
}

type CursorAgentAuthProbe = (
  executablePath: string,
  platform: NodeJS.Platform,
  environment?: NodeJS.ProcessEnv,
) => Promise<boolean>

const CURSOR_AGENT_AUTH_MARKER = 'cursor-agent'
const CURSOR_AGENT_AUTH_MARKER_TTL_MS = 30 * 60 * 1000
const CURSOR_AGENT_AUTH_MARKER_REFRESH_SKEW_MS = 60 * 1000

function extractFirstBalancedJsonObject(value: string): string | null {
  const start = value.indexOf('{')
  if (start < 0) {
    return null
  }

  let depth = 0
  let escaped = false
  let inString = false
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
    } else if (character === '{') {
      depth += 1
    } else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        return value.slice(start, index + 1)
      }
    }
  }

  return null
}

function hasAuthenticatedKiroAccount(value: Buffer | string | null | undefined): boolean {
  const json = extractFirstBalancedJsonObject(value?.toString() ?? '')
  if (!json) {
    return false
  }

  try {
    const parsed = JSON.parse(json) as { accountType?: unknown }
    return typeof parsed.accountType === 'string' && parsed.accountType.trim().length > 0
  } catch {
    return false
  }
}

export function isKiroCliWhoamiAuthenticated(result: KiroCliWhoamiResult): boolean {
  // whoami can emit valid account JSON even when the process reports a non-zero
  // status. The account payload, not the exit status, is the auth authority.
  return hasAuthenticatedKiroAccount(result.stdout)
    || hasAuthenticatedKiroAccount(result.stderr)
}

const probeCursorAgentAuth: CursorAgentAuthProbe = async (executablePath, platform, environment) =>
  await new Promise<boolean>(resolve => {
    execFile(
      executablePath,
      ['status'],
      {
        env: environment,
        timeout: 15_000,
        windowsHide: true,
        shell: platform === 'win32',
      },
      (error, stdout, stderr) => {
        resolve(!error && /\blogged in\b/i.test(`${stdout}\n${stderr}`))
      },
    )
  })

const probeKiroCliAuth: KiroCliAuthProbe = async (executablePath, platform, environment) =>
  await new Promise<boolean>(resolve => {
    execFile(
      executablePath,
      ['whoami', '--format', 'json'],
      {
        env: environment,
        timeout: 15_000,
        windowsHide: true,
        shell: platform === 'win32',
      },
      (error, stdout, stderr) => {
        resolve(isKiroCliWhoamiAuthenticated({ error, stdout, stderr }))
      },
    )
  })

function isCursorAgentAuthMarker(credential: Record<string, unknown> | null): boolean {
  return credential?.type === 'api' && credential.key === CURSOR_AGENT_AUTH_MARKER
}

function isFreshCursorAgentAuthMarker(
  credential: Record<string, unknown> | null,
  now: number,
): boolean {
  return Boolean(
    isCursorAgentAuthMarker(credential)
      && typeof credential?.expires === 'number'
      && credential.expires > now + CURSOR_AGENT_AUTH_MARKER_REFRESH_SKEW_MS,
  )
}

export async function ensureOpenCodeCursorPluginAuthCredential(input: {
  globalAuthPath: string
  managedAuthPath: string
  cursorAgentExecutablePath: string
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
  probe?: CursorAgentAuthProbe
  now?: () => number
}): Promise<boolean> {
  const now = (input.now ?? Date.now)()
  const [globalCredential, managedCredential] = await Promise.all([
    readOpenCodeAuthCredential({ authPath: input.globalAuthPath, providerId: 'cursor-acp' }),
    readOpenCodeAuthCredential({ authPath: input.managedAuthPath, providerId: 'cursor-acp' }),
  ])
  const explicitCredential = [globalCredential, managedCredential].find(
    credential => credential && !isCursorAgentAuthMarker(credential),
  )
  if (explicitCredential) {
    await Promise.all([
      globalCredential === explicitCredential
        ? Promise.resolve()
        : upsertOpenCodeAuthCredential({
            authPath: input.globalAuthPath,
            providerId: 'cursor-acp',
            credential: explicitCredential,
          }),
      managedCredential === explicitCredential
        ? Promise.resolve()
        : upsertOpenCodeAuthCredential({
            authPath: input.managedAuthPath,
            providerId: 'cursor-acp',
            credential: explicitCredential,
          }),
    ])
    return false
  }


  const freshMarker = [globalCredential, managedCredential].find(credential =>
    isFreshCursorAgentAuthMarker(credential, now)
  )
  if (freshMarker) {
    await Promise.all([
      JSON.stringify(globalCredential) === JSON.stringify(freshMarker)
        ? Promise.resolve()
        : upsertOpenCodeAuthCredential({
            authPath: input.globalAuthPath,
            providerId: 'cursor-acp',
            credential: freshMarker,
          }),
      JSON.stringify(managedCredential) === JSON.stringify(freshMarker)
        ? Promise.resolve()
        : upsertOpenCodeAuthCredential({
            authPath: input.managedAuthPath,
            providerId: 'cursor-acp',
            credential: freshMarker,
          }),
    ])
    return false
  }

  const authenticated = await (input.probe ?? probeCursorAgentAuth)(
    input.cursorAgentExecutablePath,
    input.platform ?? process.platform,
    input.environment,
  ).catch(() => false)
  if (!authenticated) {
    await Promise.all([
      isCursorAgentAuthMarker(globalCredential)
        ? removeOpenCodeAuthCredential({
            authPath: input.globalAuthPath,
            providerId: 'cursor-acp',
          })
        : Promise.resolve(),
      isCursorAgentAuthMarker(managedCredential)
        ? removeOpenCodeAuthCredential({
            authPath: input.managedAuthPath,
            providerId: 'cursor-acp',
          })
        : Promise.resolve(),
    ])
    return false
  }

  const credential = {
    type: 'api',
    key: CURSOR_AGENT_AUTH_MARKER,
    expires: now + CURSOR_AGENT_AUTH_MARKER_TTL_MS,
  }
  await Promise.all([
    JSON.stringify(globalCredential) === JSON.stringify(credential)
      ? Promise.resolve()
      : upsertOpenCodeAuthCredential({
          authPath: input.globalAuthPath,
          providerId: 'cursor-acp',
          credential,
        }),
    JSON.stringify(managedCredential) === JSON.stringify(credential)
      ? Promise.resolve()
      : upsertOpenCodeAuthCredential({
          authPath: input.managedAuthPath,
          providerId: 'cursor-acp',
          credential,
        }),
  ])
  return !isCursorAgentAuthMarker(globalCredential) || !isCursorAgentAuthMarker(managedCredential)
}

export async function ensureOpenCodeKiroPluginAuthCredential(input: {
  globalAuthPath: string
  managedAuthPath: string
  kiroCliExecutablePath: string
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
  probe?: KiroCliAuthProbe
  now?: () => number
}): Promise<boolean> {
  const now = (input.now ?? Date.now)()
  const [globalCredential, managedCredential] = await Promise.all([
    readOpenCodeAuthCredential({ authPath: input.globalAuthPath, providerId: 'kiro' }),
    readOpenCodeAuthCredential({ authPath: input.managedAuthPath, providerId: 'kiro' }),
  ])
  const existingCredential = globalCredential ?? managedCredential
  const authenticated = await (input.probe ?? probeKiroCliAuth)(
    input.kiroCliExecutablePath,
    input.platform ?? process.platform,
    input.environment,
  ).catch(() => false)
  if (!authenticated) {
    if (existingCredential) {
      await Promise.all([
        removeOpenCodeAuthCredential({ authPath: input.globalAuthPath, providerId: 'kiro' }),
        removeOpenCodeAuthCredential({ authPath: input.managedAuthPath, providerId: 'kiro' }),
      ])
    }
    return false
  }

  const existingExpiry =
    typeof existingCredential?.expires === 'number' ? existingCredential.expires : null
  const existingCredentialIsFresh = Boolean(
    existingCredential
      && existingExpiry !== null
      && existingExpiry > now + 5 * 60 * 1000,
  )
  if (existingCredential && existingCredentialIsFresh) {
    await Promise.all([
      JSON.stringify(globalCredential) === JSON.stringify(existingCredential)
        ? Promise.resolve()
        : upsertOpenCodeAuthCredential({
            authPath: input.globalAuthPath,
            providerId: 'kiro',
            credential: existingCredential,
          }),
      JSON.stringify(managedCredential) === JSON.stringify(existingCredential)
        ? Promise.resolve()
        : upsertOpenCodeAuthCredential({
            authPath: input.managedAuthPath,
            providerId: 'kiro',
            credential: existingCredential,
          }),
    ])
    return false
  }

  // opencode-kiro only needs an OAuth presence marker to run its provider
  // options loader. Real authentication and refresh remain owned by kiro-cli.
  const credential = {
    type: 'oauth',
    access: 'authenticated',
    refresh: '',
    expires: now + 8 * 60 * 60 * 1000,
  }
  await Promise.all([
    upsertOpenCodeAuthCredential({
      authPath: input.globalAuthPath,
      providerId: 'kiro',
      credential,
    }),
    upsertOpenCodeAuthCredential({
      authPath: input.managedAuthPath,
      providerId: 'kiro',
      credential,
    }),
  ])
  return true
}

function quotePosixShellValue(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function escapeWindowsBatchValue(value: string): string {
  return value.replaceAll('%', '%%')
}

export async function ensureOpenCodeNativeCliCredentialBridge(
  profileRootPath: string,
  hostEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<OpenCodeNativeCliCredentialBridge> {
  const hostHomePath = (
    platform === 'win32'
      ? hostEnv.USERPROFILE?.trim() || hostEnv.HOME?.trim()
      : hostEnv.HOME?.trim() || hostEnv.USERPROFILE?.trim()
  ) || os.homedir()
  const hostPath = hostEnv.PATH ?? ''
  const cursorAgentCommand = hostEnv.CURSOR_AGENT_EXECUTABLE?.trim() || 'cursor-agent'
  const binPath = path.join(profileRootPath, 'native-subscription-cli-bin')
  await mkdir(binPath, { recursive: true })
  const cursorResourceExhaustedPreloadPath = path.join(
    binPath,
    'cursor-resource-exhausted-preload.cjs',
  )
  await writeFile(
    cursorResourceExhaustedPreloadPath,
    buildCursorAgentResourceExhaustedPreloadScript(),
    { encoding: 'utf8', mode: 0o600 },
  )

  const writeBridge = async (command: 'cursor-agent' | 'kiro-cli'): Promise<string> => {
    const hostCommand = command === 'cursor-agent' ? cursorAgentCommand : command
    if (platform === 'win32') {
      const bridgePath = path.join(binPath, `${command}.cmd`)
      const content = [
        '@echo off',
        `set "HOME=${escapeWindowsBatchValue(hostHomePath)}"`,
        `set "USERPROFILE=${escapeWindowsBatchValue(hostHomePath)}"`,
        'set "XDG_CONFIG_HOME="',
        'set "XDG_DATA_HOME="',
        'set "XDG_CACHE_HOME="',
        `set "PATH=${escapeWindowsBatchValue(hostPath)}"`,
        ...(command === 'cursor-agent'
          ? [
              `if not "%${CURSOR_RESOURCE_EXHAUSTED_PATCH_DISABLED_ENV}%"=="1" set "AGENT_TEAMS_CURSOR_ORIGINAL_NODE_OPTIONS=%NODE_OPTIONS%"`,
              `if not "%${CURSOR_RESOURCE_EXHAUSTED_PATCH_DISABLED_ENV}%"=="1" set "NODE_OPTIONS=--require="${escapeWindowsBatchValue(cursorResourceExhaustedPreloadPath)}" %NODE_OPTIONS%"`,
            ]
          : []),
        `call "${escapeWindowsBatchValue(hostCommand)}" %*`,
        'exit /b %ERRORLEVEL%',
        '',
      ].join('\r\n')
      await writeFile(bridgePath, content, 'utf8')
      return bridgePath
    }

    const bridgePath = path.join(binPath, command)
    const content = [
      '#!/bin/sh',
      `export HOME=${quotePosixShellValue(hostHomePath)}`,
      `export USERPROFILE=${quotePosixShellValue(hostHomePath)}`,
      'unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME',
      `export PATH=${quotePosixShellValue(hostPath)}`,
      ...(command === 'cursor-agent'
          ? [
            `if [ "\${${CURSOR_RESOURCE_EXHAUSTED_PATCH_DISABLED_ENV}:-}" != "1" ]; then`,
            '  export AGENT_TEAMS_CURSOR_ORIGINAL_NODE_OPTIONS="${NODE_OPTIONS:-}"',
            `  export NODE_OPTIONS=${quotePosixShellValue(`--require="${cursorResourceExhaustedPreloadPath}"`)}" \${NODE_OPTIONS:-}"`,
            'fi',
          ]
        : []),
      `exec ${quotePosixShellValue(hostCommand)} "$@"`,
      '',
    ].join('\n')
    await writeFile(bridgePath, content, 'utf8')
    await chmod(bridgePath, 0o700)
    return bridgePath
  }

  const [cursorAgentExecutablePath, kiroCliExecutablePath] = await Promise.all([
    writeBridge('cursor-agent'),
    writeBridge('kiro-cli'),
  ])
  return { binPath, cursorAgentExecutablePath, kiroCliExecutablePath, hostHomePath }
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

function getOpenCodeConfigImportPaths(env: NodeJS.ProcessEnv, sourceHomePath: string, workingDirectory: string): string[] {
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim() || path.join(sourceHomePath, '.config')
  const candidates = [
    path.join(sourceHomePath, '.config', 'opencode', 'opencode.json'),
    path.join(sourceHomePath, '.config', 'opencode', 'opencode.jsonc'),
    // An explicit XDG config is closer to the invoking runtime than the
    // canonical user config and must win model/provider conflicts.
    path.join(xdgConfigHome, 'opencode', 'opencode.json'),
    path.join(xdgConfigHome, 'opencode', 'opencode.jsonc'),
  ]
  const explicitConfigPath = env.OPENCODE_CONFIG?.trim()
  if (explicitConfigPath) {
    candidates.push(path.resolve(workingDirectory, explicitConfigPath))
  }
  return Array.from(new Set(candidates.map(candidate => path.resolve(workingDirectory, candidate))))
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
  sourceHomePath: string,
  workingDirectory: string,
): Promise<Record<string, unknown>> {
  let importedConfig: Record<string, unknown> = {}
  for (const configPath of getOpenCodeConfigImportPaths(env, sourceHomePath, workingDirectory)) {
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

export interface OpenCodeProfilePreparationInput {
  projectPath: string
  paths: { data: string; cache: string }
  sourceHomePath: string
  workingDirectory: string
  sourceAuthPaths: readonly string[]
  globalAuthPath: string
  environment: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  appMcpConfig: OpenCodeMcpServerConfig | null
  options: OpenCodePrepareProfileOptions
}

const profilePreparationLocks = new Map<string, Promise<void>>()
export async function listPreparedAuthPaths(dataRoot: string): Promise<string[]> {
    const profilesRootPath = path.join(dataRoot, 'opencode', 'profiles')
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

export async function withOpenCodeProfilePreparationLock<T>(
    profileRootKey: string,
    operation: () => Promise<T>,
    abortSignal?: AbortSignal,
  ): Promise<T> {
    const previous = profilePreparationLocks.get(profileRootKey)
    let release!: () => void
    const current = new Promise<void>(resolve => {
      release = resolve
    })
    profilePreparationLocks.set(profileRootKey, current)

    let waitCompleted = false
    let releaseDeferredUntilPrevious = false
    try {
      await raceOpenCodeAbortSignal(runAfterSettled(previous), abortSignal)
      waitCompleted = true
      if (abortSignal?.aborted) throwOpenCodeAbortReason(abortSignal)
      return await operation()
    } catch (error) {
      if (!waitCompleted && previous) {
        releaseDeferredUntilPrevious = true
        void runAfterSettled(previous).then(() => {
          release()
          if (profilePreparationLocks.get(profileRootKey) === current) {
            profilePreparationLocks.delete(profileRootKey)
          }
        })
      }
      throw error
    } finally {
      if (!releaseDeferredUntilPrevious) {
        release()
        if (profilePreparationLocks.get(profileRootKey) === current) {
          profilePreparationLocks.delete(profileRootKey)
        }
      }
    }
  }

/** Real preparation, with no desktop resolver or prepared-result callback. */
export async function prepareOpenCodeProfile(input: OpenCodeProfilePreparationInput): Promise<OpenCodePreparedProfile> {
  validatePreparationInput(input)
  return withOpenCodeProfilePreparationLock(
    hashString(input.projectPath).slice(0, 16),
    () => prepareOpenCodeProfileUnderLock(input),
    input.options.abortSignal,
  )
}

function validatePreparationInput(input: OpenCodeProfilePreparationInput): void {
  const resolvedProjectPath = input.projectPath
  if (!path.isAbsolute(resolvedProjectPath) || path.normalize(resolvedProjectPath) !== resolvedProjectPath) {
    throw new Error('opencode_preparation_project_path')
  }
  for (const value of [input.paths.data, input.paths.cache, input.sourceHomePath, input.workingDirectory, input.globalAuthPath, ...input.sourceAuthPaths]) {
    if (!path.isAbsolute(value) || path.normalize(value) !== value) throw new Error('opencode_preparation_input_path')
  }
  const managedAuthPath = path.join(input.paths.data, 'opencode', 'profiles',
    hashString(resolvedProjectPath).slice(0, 16), 'data', 'opencode', 'auth.json')
  if (resolveOpenCodeAuthCoordinationPath(input.globalAuthPath) !== resolveOpenCodeAuthCoordinationPath(managedAuthPath)) {
    throw new Error('opencode_preparation_auth_authority')
  }
}

/** Internal desktop adapter entry: caller must already hold the shared project queue. */
export async function prepareOpenCodeProfileUnderLock(input: OpenCodeProfilePreparationInput): Promise<OpenCodePreparedProfile> {
  validatePreparationInput(input)
  const resolvedProjectPath = input.projectPath
  const options = input.options
  const profileRootKey = hashString(resolvedProjectPath).slice(0, 16)
  try {
    if (options.abortSignal?.aborted) throwOpenCodeAbortReason(options.abortSignal)
    const profileRootPath = path.join(
      input.paths.data,
      'opencode',
      'profiles',
      profileRootKey,
    )
    const { projectBehaviorFingerprint, behaviorSources } =
      await collectProjectBehaviorMetadata(resolvedProjectPath)
    const managedRuntimePreferences = await readOpenCodeManagedRuntimePreferences(profileRootPath)
    const globalRuntimePreferences = await readOpenCodeGlobalManagedRuntimePreferences(
      input.paths.data,
    )
    const effectiveManagedDefaultModelId =
      managedRuntimePreferences.defaultModelId ?? globalRuntimePreferences.defaultModelId
    const effectiveManagedDefaultSource = managedRuntimePreferences.defaultModelId
      ? 'project' as const
      : globalRuntimePreferences.defaultModelId
        ? 'all_projects' as const
        : null
    const effectiveModelLimitOverrides = {
      ...globalRuntimePreferences.modelLimitOverrides,
      ...managedRuntimePreferences.modelLimitOverrides,
    }
    const importedRuntimeConfig = await readSafeOpenCodeRuntimeConfigImport(input.environment, input.sourceHomePath, input.workingDirectory)
    const importedConfigDefaultModelId =
      typeof importedRuntimeConfig.model === 'string'
        ? importedRuntimeConfig.model.trim() || null
        : null
    const appMcpConfig =
      options.includeAppMcp === false
        ? null
        : input.appMcpConfig
    if (options.abortSignal?.aborted) throwOpenCodeAbortReason(options.abortSignal)
    const effectiveModelOutputLimitOverrides = [
      ...Object.entries(effectiveModelLimitOverrides).map(([modelId, override]) => ({
        modelId,
        contextTokens: override.contextTokens,
        outputTokens: override.outputTokens,
      })),
      ...(options.modelOutputLimitOverrides ?? []),
    ]
    const managedConfig = deepMergeOpenCodeConfig(
      importedRuntimeConfig,
      buildManagedConfig(appMcpConfig, {
        allowAutoUpdate: isOpenCodeAutoUpdateAllowed(input.environment),
        defaultModelId: effectiveManagedDefaultModelId,
        toolApprovalMode: options.toolApprovalMode,
      }),
    )
    applyOpenCodeModelLimitOverrides(managedConfig, effectiveModelOutputLimitOverrides)
    if (options.includeManagedSubscriptionPlugins !== false) {
      applyOpenCodeManagedSubscriptionPlugins(managedConfig)
    }
    applyManagedPathEnvironmentToMcpConfig(managedConfig, {
      [CLAUDE_MULTIMODEL_DATA_HOME_ENV]: input.paths.data,
      [CLAUDE_MULTIMODEL_CACHE_HOME_ENV]: input.paths.cache,
    })
    const managedConfigFingerprint = buildManagedConfigFingerprint(managedConfig)
    const homePath = path.join(profileRootPath, 'home')
    const tmpPath = path.join(profileRootPath, 'tmp')
    const xdgConfigHome = path.join(profileRootPath, 'config')
    const xdgDataHome = path.join(profileRootPath, 'data')
    const xdgCacheHome = path.join(input.paths.cache, 'opencode', 'shared-cache')
    const sharedNpmCachePath = path.join(xdgCacheHome, 'npm')
    const sharedToolCachePath = path.join(xdgCacheHome, 'tools')
    const sharedOpenCodeNodeModulesPath = path.join(xdgCacheHome, 'config-node_modules')
    const profileOpenCodeNodeModulesPath = path.join(xdgConfigHome, 'opencode', 'node_modules')
    const managedAuthPath = path.join(xdgDataHome, 'opencode', 'auth.json')
    const globalAuthPath = input.globalAuthPath
    const sourceAuthSources = await Promise.all(
      input.sourceAuthPaths.map(async sourceAuthPath => {
        const exists = await fileExists(sourceAuthPath)
        return {
          path: sourceAuthPath,
          fingerprint: exists ? await readFingerprint(sourceAuthPath) : null,
        }
      }),
    )
    if (options.abortSignal?.aborted) throwOpenCodeAbortReason(options.abortSignal)

    await Promise.all([
      mkdir(homePath, { recursive: true }),
      mkdir(tmpPath, { recursive: true }),
      mkdir(xdgConfigHome, { recursive: true }),
      mkdir(path.join(xdgDataHome, 'opencode'), { recursive: true }),
      mkdir(xdgCacheHome, { recursive: true }),
      mkdir(sharedNpmCachePath, { recursive: true }),
      mkdir(sharedToolCachePath, { recursive: true }),
    ])
    let nativeCliCredentialBridge: OpenCodeNativeCliCredentialBridge | null = null
    if (options.includeManagedSubscriptionPlugins !== false) {
      await repairEmptyOpenCodeManagedPluginCaches(xdgCacheHome)
      nativeCliCredentialBridge = await ensureOpenCodeNativeCliCredentialBridge(profileRootPath, { ...input.environment, HOME: input.sourceHomePath, USERPROFILE: input.sourceHomePath }, input.platform)
    }
    await ensureDirectorySymlink(profileOpenCodeNodeModulesPath, sharedOpenCodeNodeModulesPath)
    if (options.abortSignal?.aborted) throwOpenCodeAbortReason(options.abortSignal)

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
    await reconcileOpenCodeManagedAuthStores({
      sourceAuthPaths: authSourcePaths,
      globalAuthPath,
      managedAuthPath,
      peerManagedAuthPaths: await listPreparedAuthPaths(input.paths.data),
      abortSignal: options.abortSignal,
    })
    if (nativeCliCredentialBridge) {
      await Promise.all([
        ensureOpenCodeCursorPluginAuthCredential({
          globalAuthPath,
          managedAuthPath,
          cursorAgentExecutablePath: nativeCliCredentialBridge.cursorAgentExecutablePath,
          platform: input.platform,
          environment: input.environment,
        }),
        ensureOpenCodeKiroPluginAuthCredential({
          globalAuthPath,
          managedAuthPath,
          kiroCliExecutablePath: nativeCliCredentialBridge.kiroCliExecutablePath,
          platform: input.platform,
          environment: input.environment,
        }),
      ])
    }
    if (options.abortSignal?.aborted) throwOpenCodeAbortReason(options.abortSignal)

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
        const sourceStores = await Promise.all(authSourcePaths.map(readOpenCodeAuthStore))
        const expectedAuth = mergeOpenCodeManagedAuthSources({
          sourceAuthPaths: authSourcePaths,
          sourceStores,
          globalAuthPath,
        })
        return doesOpenCodeAuthStoreIncludeSource({ source: expectedAuth, managed })
          ? 'ok' as const
          : 'stale' as const
      } catch {
        return 'stale' as const
      }
    })()

    const env: NodeJS.ProcessEnv = {
      ...input.environment,
      HOME: homePath,
      USERPROFILE: homePath,
      TMPDIR: tmpPath,
      TMP: tmpPath,
      TEMP: tmpPath,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: xdgDataHome,
      XDG_CACHE_HOME: xdgCacheHome,
      NPM_CONFIG_CACHE: sharedNpmCachePath,
      PLAYWRIGHT_BROWSERS_PATH: path.join(sharedToolCachePath, 'ms-playwright'),
      PUPPETEER_CACHE_DIR: path.join(sharedToolCachePath, 'puppeteer'),
      PIP_CACHE_DIR: path.join(sharedToolCachePath, 'pip'),
      UV_CACHE_DIR: path.join(sharedToolCachePath, 'uv'),
      npm_config_devdir: path.join(sharedToolCachePath, 'node-gyp'),
      [CLAUDE_MULTIMODEL_DATA_HOME_ENV]: input.paths.data,
      [CLAUDE_MULTIMODEL_CACHE_HOME_ENV]: input.paths.cache,
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify(managedConfig),
    }
    if (nativeCliCredentialBridge) {
      env.PATH = [nativeCliCredentialBridge.binPath, input.environment.PATH]
        .filter((value): value is string => Boolean(value))
        .join(path.delimiter)
      env.CURSOR_ACP_HOME_DIR =
        input.environment.CURSOR_ACP_HOME_DIR?.trim() || nativeCliCredentialBridge.hostHomePath
      env.CURSOR_AGENT_EXECUTABLE =
        nativeCliCredentialBridge.cursorAgentExecutablePath
    }
    delete env.OPENCODE_CONFIG
    if (options.abortSignal?.aborted) throwOpenCodeAbortReason(options.abortSignal)

    return {
      projectPath: resolvedProjectPath,
      profileRootKey,
      profileRootPath,
      projectDefaultModelId: managedRuntimePreferences.defaultModelId,
      allProjectsDefaultModelId: globalRuntimePreferences.defaultModelId,
      importedConfigDefaultModelId,
      effectiveManagedDefaultModelId,
      effectiveManagedDefaultSource,
      projectBehaviorFingerprint,
      behaviorSources,
      managedConfig,
      managedConfigFingerprint,
      homePath,
      tmpPath,
      xdgConfigHome,
      xdgDataHome,
      xdgCacheHome,
      globalAuthPath,
      managedAuthPath,
      sourceAuthPath: sourceAuthSources.findLast(source => source.fingerprint)?.path ?? null,
      sourceAuthSources: sourceAuthSources.map(source => ({ ...source })),
      sourceAuthFingerprint,
      managedAuthFingerprint,
      authState,
      env: applyOpenCodeAutoUpdatePolicy(env),
    }
  } catch (error) {
    if (options.abortSignal?.aborted && error === options.abortSignal.reason) throw error
    // Parser/OS errors may quote private configuration, paths, or auth contents.
    throw new Error('opencode_preparation_failed')
  }
}
