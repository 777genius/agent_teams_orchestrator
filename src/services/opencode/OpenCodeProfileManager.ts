import { readProcessStartTimeMs } from '../../utils/processKill.js'
import { publishNativeCliFile } from './OpenCodeNativeCliPublication.js'
import { resolveOpenCodeBinaryPath } from './OpenCodeBinaryResolver.js'
import { OPEN_CODE_MANAGED_HOST_CONFIG_GENERATION, buildOpenCodeHostTransportIdentity, resolveOpenCodeBinaryHostIdentity } from './OpenCodeHostIdentity.js'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants, type Dirent } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  readlink,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { getCwd } from '../../utils/cwd.js'
import { safeParseJSONC } from '../../utils/json.js'
import * as lockfile from '../../utils/lockfile.js'
import { ensureOpenCodeDirectory } from './ensureOpenCodeDirectory.js'
import {
  applyOpenCodeAutoUpdatePolicy,
  isOpenCodeAutoUpdateAllowed,
} from './OpenCodeAutoUpdatePolicy.js'
import {
  isHostedAppMcpAuthorityInstalled,
  OPEN_CODE_APP_MCP_SERVER_NAME,
  resolveOpenCodeAppMcpLaunchConfig,
  type ResolvedAppMcpLaunchConfig,
} from './OpenCodeMcpManager.js'
import {
  getOpenCodeCuratedSubscriptionProviderConfigs,
  getOpenCodeManagedSubscriptionPluginPackages,
} from './OpenCodeCuratedSubscriptionCatalog.js'
import {
  doesOpenCodeAuthStoreIncludeSource,
  fanOutOpenCodeOAuthCredential,
  materializeOpenCodeSelectedAuthCredential,
  mergeOpenCodeManagedAuthSources,
  readOpenCodeSavedAuthStore,
  readOpenCodeCommittedOAuthProbeRotation,
  readOpenCodeCommittedOAuthSessionRotation,
  sameOpenCodeOAuthSessionAuthority,
  reconcileOpenCodeManagedAuthStores,
  readOpenCodeAuthCredential,
  readOpenCodeAuthStore,
  removeOpenCodeAuthCredential,
  upsertOpenCodeAuthCredential,
  isValidOpenCodeOAuthCredential,
  withOpenCodeOwnedOAuthRefresh,
  recoverOpenCodeOwnedOAuthSave,
  openCodeOAuthSaveReceiptPath,
  OpenCodeOAuthPublicationRevokedError,
  type OpenCodeOAuthNativeSessionOwner,
  type OpenCodeOAuthSaveOwner,
  type OpenCodeAuthCredential,
  type OpenCodeOAuthNativeProbeOwner,
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
import {
  raceOpenCodeAbortSignal,
  throwOpenCodeAbortReason,
  waitForOpenCodeAbortableDelay,
} from './OpenCodeRuntimeDeadline.js'
import {
  type OpenCodeCursorManagedAssets,
  resolveOpenCodeCursorManagedAssets,
} from './OpenCodeCursorManagedAssets.js'
import {
  applyCursorManagedProxyEndpoint,
  CURSOR_MANAGED_PROXY_PORT_ENV,
  reserveCursorManagedProxyPort,
} from './OpenCodeCursorManagedPort.js'
import {
  buildCursorReadinessFingerprint,
  CURSOR_NATIVE_ENV_KEYS,
  resolveCursorAgentExecutable,
  resolveCurrentCursorNativeAuthority,
  resolveCursorExecutableIdentity,
  cursorNativeSelectedIdentity,
  reconcileCursorNativeAuthority,
} from './OpenCodeCursorNativeAuthority.js'
import { parseOpenCodeProviderScopedModelRef } from './OpenCodeModelRef.js'
import { planOpenCodeProfilePolicy } from './OpenCodeProfilePolicy.js'
import {
  canonicalizeOpenCodeProviderId,
  isLiteralLoopbackOpenCodeUrl,
  isLocalInexactOpenCodeLaunchProviderId,
} from './OpenCodeProviderIdentity.js'
import { buildCursorAgentResourceExhaustedPreloadScript } from './OpenCodeCursorResourceExhaustedPatch.js'
import { buildCursorAgentAttributionPreloadScript } from './OpenCodeProcessAttributionStore.js'
import type {
  OpenCodeHostHandle,
  OpenCodeMcpServerConfig,
  OpenCodePrepareProfileOptions,
  OpenCodePreparedProfile,
  OpenCodeProfilePurpose,
  OpenCodeProfileScope,
  OpenCodeSessionRecord,
  OpenCodeToolApprovalMode,
} from './types.js'

import { OPEN_CODE_TEAMMATE_AGENT_NAME, OPEN_CODE_TEAMMATE_BOOTSTRAP_AGENT_NAME, OPEN_CODE_MODEL_PROBE_AGENT_NAME } from './OpenCodeAgentNames.js'
export { OPEN_CODE_TEAMMATE_AGENT_NAME, OPEN_CODE_TEAMMATE_BOOTSTRAP_AGENT_NAME, OPEN_CODE_MODEL_PROBE_AGENT_NAME } from './OpenCodeAgentNames.js'

const ATLAS_CLOUD_PROVIDER_ID = 'atlascloud'
const GITHUB_COPILOT_PROVIDER_ID = 'github-copilot'
const OPEN_CODE_SCOPE_CONFIG_CONTENT_ENV =
  'CLAUDE_MULTIMODEL_OPENCODE_SCOPE_CONFIG_CONTENT'
const OPEN_CODE_SCOPE_APP_MCP_LAUNCH_CONFIG_ENV =
  'CLAUDE_MULTIMODEL_OPENCODE_SCOPE_APP_MCP_LAUNCH_CONFIG'
const OPEN_CODE_SCOPE_ENVIRONMENT_ENV =
  'CLAUDE_MULTIMODEL_OPENCODE_SCOPE_ENVIRONMENT'
const OPEN_CODE_PROFILE_RUNTIME_OVERRIDE_KEYS = [
  'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'XDG_CACHE_HOME', 'NPM_CONFIG_CACHE', 'PLAYWRIGHT_BROWSERS_PATH',
  'PUPPETEER_CACHE_DIR', 'PIP_CACHE_DIR', 'UV_CACHE_DIR', 'npm_config_devdir',
  'OPENCODE_DISABLE_CLAUDE_CODE',
  'PATH', 'CURSOR_ACP_HOME_DIR', 'CURSOR_AGENT_EXECUTABLE', 'CURSOR_CONFIG_DIR', 'NODE_OPTIONS',
] as const

// Copilot Free and Student can expose only GitHub's Auto picker, which OpenCode
// cannot currently execute through an explicit model id. Seed a current lightweight
// explicit model so provider discovery and verification can return an actionable
// limitation instead of hiding the authenticated provider. The seed does not grant
// model access; availability still depends on the account and live discovery.
const GITHUB_COPILOT_FALLBACK_PROVIDER_CONFIG = {
  name: 'GitHub Copilot',
  npm: '@ai-sdk/github-copilot',
  api: 'https://api.githubcopilot.com',
  models: {
    'gpt-5.6-luna': {
      name: 'GPT-5.6 Luna',
      family: 'gpt-5.6-luna',
      attachment: true,
      reasoning: true,
      tool_call: true,
      structured_output: true,
      temperature: false,
      limit: {
        context: 1_050_000,
        input: 922_000,
        output: 128_000,
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

export async function canonicalizeOpenCodeProjectPath(
  projectPath?: string | null,
): Promise<string> {
  const resolved = path.normalize(path.resolve(projectPath?.trim() || getCwd()))
  try {
    return path.normalize(await realpath(resolved))
  } catch (error) {
    const code = getErrnoCode(error)
    if (
      code === 'ENOENT' ||
      code === 'ENOTDIR' ||
      code === 'EACCES' ||
      code === 'ELOOP' ||
      code === 'EPERM'
    ) {
      return resolved
    }
    throw error
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function findCanonicalProviderConfig(
  providers: Record<string, unknown>,
  providerId: string,
): { key: string; config: Record<string, unknown> } | null {
  const exact = providers[providerId]
  if (exact && typeof exact === 'object' && !Array.isArray(exact)) {
    return { key: providerId, config: exact as Record<string, unknown> }
  }

  const canonical = canonicalizeOpenCodeProviderId(providerId)
  if (canonical !== providerId) {
    const canonicalExact = providers[canonical]
    if (canonicalExact && typeof canonicalExact === 'object' && !Array.isArray(canonicalExact)) {
      return { key: canonical, config: canonicalExact as Record<string, unknown> }
    }
  }

  for (const [key, value] of Object.entries(providers)) {
    if (key === providerId || key === canonical) continue
    if (canonicalizeOpenCodeProviderId(key) !== canonical) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    return { key, config: value as Record<string, unknown> }
  }
  return null
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
    write: 'allow',
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

function downgradeAllowToAsk(value: unknown): unknown {
  if (value === 'allow') return 'ask'
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, downgradeAllowToAsk(entry)]),
  )
}

const OPEN_CODE_TOOL_LESS_MODEL_PROBE_AGENT = {
  mode: 'primary',
  description: 'Minimal model execution probe agent with tools disabled.',
  tools: {
    '*': false,
  },
  permission: {
    '*': 'deny',
  },
} as const

// OpenCode Zen answers free-tier requests that carry no standard tool set with a 403
// FreeTierError (anomalyco/opencode#49580), while the real teammate passes. Only for Zen does
// the probe send the auto-mode teammate tool set, every "allow" downgraded to "ask" so any
// call surfaces as a permission request the probe rejects. Manual-mode hosts keep the
// tool-less probe: OpenCode stores "always" approvals per instance and they override "ask",
// so a tool the user approved for a teammate there could otherwise run during a probe.
// Every other provider keeps the tool-less probe as well, so its prompt stays small.
function buildOpenCodeModelProbeAgent(input: {
  managedProviderId: string | null | undefined
  toolApprovalMode: OpenCodeToolApprovalMode | undefined
}): Record<string, unknown> {
  const providerId = input.managedProviderId
    ? canonicalizeOpenCodeProviderId(input.managedProviderId)
    : null
  if (providerId !== 'opencode' || (input.toolApprovalMode ?? 'auto') !== 'auto') {
    return structuredClone(OPEN_CODE_TOOL_LESS_MODEL_PROBE_AGENT) as Record<string, unknown>
  }
  return {
    mode: 'primary',
    description: 'Model execution probe agent that carries the teammate tool set but cannot run any of it.',
    permission: downgradeAllowToAsk(buildOpenCodeTeammatePermission('auto')),
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

async function acquireProfileSymlinkLock(
  lockPath: string,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  // Keep the existing bounded retry policy, but do not leave proper-lockfile's
  // retry queue running after the caller's deadline expires.
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throwOpenCodeAbortReason(signal)
    try {
      const release = await lockfile.lock(lockPath, {
        ...OPEN_CODE_PROFILE_SYMLINK_LOCK_OPTIONS,
        retries: 0,
      })
      if (signal?.aborted) {
        await release()
        throwOpenCodeAbortReason(signal)
      }
      return release
    } catch (error) {
      if (signal?.aborted) throwOpenCodeAbortReason(signal)
      if (getErrnoCode(error) !== 'ELOCKED' || attempt >= 120) throw error
      await waitForOpenCodeAbortableDelay(Math.min(25 * 2 ** attempt, 250), signal)
    }
  }
}

type ProfileSymlinkOptions = {
  abortSignal?: AbortSignal
  enterStep?: (label: string) => void
}

export async function ensureDirectorySymlink(
  linkPath: string,
  targetPath: string,
  options: ProfileSymlinkOptions = {},
): Promise<void> {
  if (options.abortSignal?.aborted) throwOpenCodeAbortReason(options.abortSignal)
  await ensureOpenCodeDirectory(targetPath)
  await ensureOpenCodeDirectory(path.dirname(linkPath))

  const lockPath = `${linkPath}.prepare-lock`
  await writeFile(lockPath, '', { flag: 'a' })
  options.enterStep?.('wait for node_modules symlink lock')
  const release = await acquireProfileSymlinkLock(lockPath, options.abortSignal)

  try {
    await ensureDirectorySymlinkUnlocked(linkPath, targetPath, options)
  } finally {
    await release()
  }
}

async function copyDirectoryContentsPreservingExisting(
  sourcePath: string,
  targetPath: string,
  options: ProfileSymlinkOptions,
): Promise<void> {
  if (options.abortSignal?.aborted) throwOpenCodeAbortReason(options.abortSignal)
  const entries = await readdir(sourcePath, { withFileTypes: true })
  const targetEntries = new Map((await readdir(targetPath, { withFileTypes: true }))
    .map(entry => [entry.name, entry]))
  for (const entry of entries) {
    if (options.abortSignal?.aborted) throwOpenCodeAbortReason(options.abortSignal)
    const sourceEntry = path.join(sourcePath, entry.name)
    const targetEntry = path.join(targetPath, entry.name)
    const existing = targetEntries.get(entry.name)
    // Existing files/symlinks always win. Still descend into real directories
    // to preserve missing nested files; COPYFILE_EXCL remains the race guard.
    if (existing && (!entry.isDirectory() || !existing.isDirectory())) continue

    if (entry.isDirectory()) {
      await ensureOpenCodeDirectory(targetEntry).catch(error => {
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
        await copyDirectoryContentsPreservingExisting(sourceEntry, targetEntry, options)
      }
      continue
    }

    if (entry.isSymbolicLink()) {
      const linkTarget = await readlink(sourceEntry)
      if (options.abortSignal?.aborted) throwOpenCodeAbortReason(options.abortSignal)
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
  options: ProfileSymlinkOptions,
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
  if (options.abortSignal?.aborted) throwOpenCodeAbortReason(options.abortSignal)
  await writeFile(migrationLockPath, '', { flag: 'a' })
  options.enterStep?.('wait for shared node_modules migration lock')
  const release = await acquireProfileSymlinkLock(migrationLockPath, options.abortSignal)
  try {
    options.enterStep?.('merge legacy node_modules directory')
    await copyDirectoryContentsPreservingExisting(sourcePath, targetPath, options)
  } finally {
    await release()
  }
}

async function ensureDirectorySymlinkUnlocked(
  linkPath: string,
  targetPath: string,
  options: ProfileSymlinkOptions,
): Promise<void> {
  let replacementStarted = false
  const finishReplacement = () => {
    if (options.abortSignal?.aborted) throwOpenCodeAbortReason(options.abortSignal)
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!replacementStarted) finishReplacement()
    if (await isDirectorySymlinkTo(linkPath, targetPath)) {
      finishReplacement()
      return
    }

    try {
      if (!replacementStarted) finishReplacement()
      await symlink(targetPath, linkPath, 'dir')
      finishReplacement()
      return
    } catch (error) {
      if (getErrnoCode(error) !== 'EEXIST') {
        throw error
      }
      if (await isDirectorySymlinkTo(linkPath, targetPath)) {
        finishReplacement()
        return
      }
    }

    await preserveRealDirectoryContents(linkPath, targetPath,
      replacementStarted ? { ...options, abortSignal: undefined } : options)
    options.enterStep?.('replace legacy node_modules directory')
    if (!replacementStarted) finishReplacement()
    // Once removal starts, finish the bounded replacement before observing
    // cancellation. Otherwise an abort during rm leaves node_modules missing.
    replacementStarted = true
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
    finishReplacement()
    return
  }

  try {
    if (!replacementStarted) finishReplacement()
    await symlink(targetPath, linkPath, 'dir')
    finishReplacement()
    return
  } catch (error) {
    if (getErrnoCode(error) === 'EEXIST' && await isDirectorySymlinkTo(linkPath, targetPath)) {
      finishReplacement()
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

export async function collectProjectBehaviorMetadata(
  projectPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
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
    const fingerprint = relativePath === 'opencode.json' || relativePath === 'opencode.jsonc'
      ? hashString(JSON.stringify(redactConfigIdentity(
          safeParseJSONC(content.toString('utf8')),
          env,
        )))
      : hashBuffer(content)
    entries.push(`${relativePath}:${fingerprint}`)
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
    managedProviderId?: string | null
    modelOutputLimitOverrides?: OpenCodePrepareProfileOptions['modelOutputLimitOverrides']
    toolApprovalMode?: OpenCodeToolApprovalMode
  } = {},
): Record<string, unknown> {
  const managedProviders: Record<string, unknown> = {
    [ATLAS_CLOUD_PROVIDER_ID]: ATLAS_CLOUD_PROVIDER_CONFIG,
    [GITHUB_COPILOT_PROVIDER_ID]: GITHUB_COPILOT_FALLBACK_PROVIDER_CONFIG,
    ...getOpenCodeCuratedSubscriptionProviderConfigs(),
  }
  const selectedManagedProviderId = options.managedProviderId?.trim()
  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    default_agent: OPEN_CODE_TEAMMATE_AGENT_NAME,
    share: 'disabled',
    snapshot: true,
    provider: selectedManagedProviderId
      ? (managedProviders[selectedManagedProviderId]
        ? { [selectedManagedProviderId]: managedProviders[selectedManagedProviderId] }
        : {})
      : managedProviders,
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
      [OPEN_CODE_MODEL_PROBE_AGENT_NAME]: buildOpenCodeModelProbeAgent({
        managedProviderId: selectedManagedProviderId,
        toolApprovalMode: options.toolApprovalMode,
      }),
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

const OPEN_CODE_SCOPE_PLACEHOLDER_MODEL_IDS = new Set([
  'catalog',
  'oauth-authority',
])

const LOCAL_OPENCODE_SELECTED_MODEL_CONTEXT_LIMIT = 32_768
const LOCAL_OPENCODE_SELECTED_MODEL_OUTPUT_LIMIT = 4_096

function readPositiveOpenCodeModelLimit(value: unknown): {
  context: number
  output: number
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const context = typeof record.context === 'number' && Number.isFinite(record.context) && record.context > 0
    ? Math.floor(record.context)
    : null
  const output = typeof record.output === 'number' && Number.isFinite(record.output) && record.output > 0
    ? Math.floor(record.output)
    : null
  if (context == null && output == null) return null
  return {
    context: context ?? LOCAL_OPENCODE_SELECTED_MODEL_CONTEXT_LIMIT,
    output: output ?? LOCAL_OPENCODE_SELECTED_MODEL_OUTPUT_LIMIT,
  }
}

function buildSelectedLocalOpenCodeModelSeed(
  existingModels: Record<string, unknown>,
): Record<string, unknown> {
  for (const value of Object.values(existingModels)) {
    const limit = readPositiveOpenCodeModelLimit(
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>).limit
        : null,
    )
    if (limit) {
      return { tool_call: true, limit }
    }
  }
  return {
    tool_call: true,
    limit: {
      context: LOCAL_OPENCODE_SELECTED_MODEL_CONTEXT_LIMIT,
      output: LOCAL_OPENCODE_SELECTED_MODEL_OUTPUT_LIMIT,
    },
  }
}

function selectedLocalOpenCodeModelNeedsSeed(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true
  const record = value as Record<string, unknown>
  return record.tool_call !== true || readPositiveOpenCodeModelLimit(record.limit) == null
}

function enrichSelectedLocalOpenCodeModel(
  value: unknown,
  seed: Record<string, unknown>,
): Record<string, unknown> {
  const current = value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
  if (current.tool_call !== true) current.tool_call = true
  if (!readPositiveOpenCodeModelLimit(current.limit)) current.limit = seed.limit
  return current
}

/**
 * User OpenCode config can pin an Ollama/LM Studio models allowlist. Imported
 * as-is, that list hides later local models and launch probes hang after
 * `ProviderModelNotFoundError`. Add the selected model without shrinking a
 * live-discovery provider (empty models map), and keep tool-calling plus a
 * usable context window so local teammates can actually invoke write/bash.
 */
export function ensureSelectedOpenCodeModelInImportedConfig(
  config: Record<string, unknown>,
  selectedModel: string,
  purpose: OpenCodeProfilePurpose,
): void {
  if (purpose === 'catalog') return
  const parsed = parseOpenCodeProviderScopedModelRef(selectedModel)
  if (!parsed || OPEN_CODE_SCOPE_PLACEHOLDER_MODEL_IDS.has(parsed.modelId)) return
  const providerId = canonicalizeOpenCodeProviderId(parsed.providerId)
  if (!isLocalInexactOpenCodeLaunchProviderId(providerId)) return

  const providers = asRecord(config.provider)
  const found = findCanonicalProviderConfig(providers, providerId)
    ?? findCanonicalProviderConfig(providers, parsed.providerId)
  if (!found) return
  const models = asRecord(found.config.models)
  if (!hasOwnRecordKeys(models)) return
  const current = Object.prototype.hasOwnProperty.call(models, parsed.modelId)
    ? models[parsed.modelId]
    : undefined
  if (current !== undefined && !selectedLocalOpenCodeModelNeedsSeed(current)) {
    return
  }

  const seed = buildSelectedLocalOpenCodeModelSeed(models)
  const nextProviders = { ...providers }
  if (found.key !== providerId) delete nextProviders[found.key]
  nextProviders[providerId] = {
    ...found.config,
    models: {
      ...models,
      [parsed.modelId]: enrichSelectedLocalOpenCodeModel(current, seed),
    },
  }
  config.provider = nextProviders
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
    if (key === 'plugin' && Array.isArray(value)) {
      merged[key] = Array.from(new Set([
        ...(Array.isArray(existing) ? existing : []),
        ...value,
      ]))
      continue
    }
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
  managedPlugins = getOpenCodeManagedSubscriptionPluginPackages(),
): void {
  const configuredPlugins = Array.isArray(config.plugin)
    ? config.plugin.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : []
  config.plugin = [
    ...new Set([
      ...configuredPlugins.filter(plugin =>
        !getOpenCodeManagedSubscriptionPluginPackages().includes(plugin)
        || managedPlugins.includes(plugin)),
      ...managedPlugins,
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
  /** The unwrapped native command, stable across profile preparations. */
  cursorAgentHostCommand: string
  kiroCliExecutablePath: string
  hostHomePath: string
}

type KiroCliAuthProbe = (
  executablePath: string,
  platform: NodeJS.Platform,
  abortSignal?: AbortSignal,
) => Promise<boolean>

interface KiroCliWhoamiResult {
  error?: unknown
  stdout?: Buffer | string | null
  stderr?: Buffer | string | null
}

type CursorAgentAuthProbe = (
  executablePath: string,
  platform: NodeJS.Platform,
  abortSignal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
) => Promise<boolean>

const CURSOR_SIGNED_OUT_PATTERN = /\bnot logged in\b|"authenticated"\s*:\s*false/i
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

const probeCursorAgentAuth: CursorAgentAuthProbe = async (executablePath, platform, abortSignal, env) =>
  await new Promise<boolean>(resolve => {
    execFile(
      executablePath,
      ['status'],
      {
        env,
        signal: abortSignal,
        timeout: 15_000,
        windowsHide: true,
        shell: platform === 'win32',
      },
      (error, stdout, stderr) => {
        // "Not logged in" also contains "logged in": a signed-out CLI must not pass.
        const output = `${stdout}\n${stderr}`
        resolve(!error && /\blogged in\b/i.test(output) && !CURSOR_SIGNED_OUT_PATTERN.test(output))
      },
    )
  })

const probeKiroCliAuth: KiroCliAuthProbe = async (executablePath, platform, abortSignal) =>
  await new Promise<boolean>(resolve => {
    execFile(
      executablePath,
      ['whoami', '--format', 'json'],
      {
        signal: abortSignal,
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
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  probe?: CursorAgentAuthProbe
  now?: () => number
  abortSignal?: AbortSignal
}): Promise<boolean> {
  if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
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
            abortSignal: input.abortSignal,
            providerId: 'cursor-acp',
            credential: explicitCredential,
          }),
      managedCredential === explicitCredential
        ? Promise.resolve()
        : upsertOpenCodeAuthCredential({
            authPath: input.managedAuthPath,
            abortSignal: input.abortSignal,
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
            abortSignal: input.abortSignal,
            providerId: 'cursor-acp',
            credential: freshMarker,
          }),
      JSON.stringify(managedCredential) === JSON.stringify(freshMarker)
        ? Promise.resolve()
        : upsertOpenCodeAuthCredential({
            authPath: input.managedAuthPath,
            abortSignal: input.abortSignal,
            providerId: 'cursor-acp',
            credential: freshMarker,
          }),
    ])
    return false
  }

  const authenticated = await (input.probe ?? probeCursorAgentAuth)(
    input.cursorAgentExecutablePath,
    input.platform ?? process.platform,
    input.abortSignal,
    input.env,
  ).catch(() => false)
  if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
  if (!authenticated) {
    await Promise.all([
      isCursorAgentAuthMarker(globalCredential)
        ? removeOpenCodeAuthCredential({
            authPath: input.globalAuthPath,
            abortSignal: input.abortSignal,
            providerId: 'cursor-acp',
          })
        : Promise.resolve(),
      isCursorAgentAuthMarker(managedCredential)
        ? removeOpenCodeAuthCredential({
            authPath: input.managedAuthPath,
            abortSignal: input.abortSignal,
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
          abortSignal: input.abortSignal,
          providerId: 'cursor-acp',
          credential,
        }),
    JSON.stringify(managedCredential) === JSON.stringify(credential)
      ? Promise.resolve()
      : upsertOpenCodeAuthCredential({
          authPath: input.managedAuthPath,
          abortSignal: input.abortSignal,
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
  probe?: KiroCliAuthProbe
  now?: () => number
  abortSignal?: AbortSignal
}): Promise<boolean> {
  if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
  const now = (input.now ?? Date.now)()
  const [globalCredential, managedCredential] = await Promise.all([
    readOpenCodeAuthCredential({ authPath: input.globalAuthPath, providerId: 'kiro' }),
    readOpenCodeAuthCredential({ authPath: input.managedAuthPath, providerId: 'kiro' }),
  ])
  const existingCredential = globalCredential ?? managedCredential
  const authenticated = await (input.probe ?? probeKiroCliAuth)(
    input.kiroCliExecutablePath,
    input.platform ?? process.platform,
    input.abortSignal,
  ).catch(() => false)
  if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
  if (!authenticated) {
    if (existingCredential) {
      await Promise.all([
        removeOpenCodeAuthCredential({ authPath: input.globalAuthPath, providerId: 'kiro', abortSignal: input.abortSignal }),
        removeOpenCodeAuthCredential({ authPath: input.managedAuthPath, providerId: 'kiro', abortSignal: input.abortSignal }),
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
            abortSignal: input.abortSignal,
            providerId: 'kiro',
            credential: existingCredential,
          }),
      JSON.stringify(managedCredential) === JSON.stringify(existingCredential)
        ? Promise.resolve()
        : upsertOpenCodeAuthCredential({
            authPath: input.managedAuthPath,
            abortSignal: input.abortSignal,
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
      abortSignal: input.abortSignal,
      providerId: 'kiro',
      credential,
    }),
    upsertOpenCodeAuthCredential({
      authPath: input.managedAuthPath,
      abortSignal: input.abortSignal,
      providerId: 'kiro',
      credential,
    }),
  ])
  return true
}

export async function ensureOpenCodeNativePluginAuthCredentials(input: {
  selectedProviderId?: string | null
  prepareCursor: () => Promise<unknown>
  prepareKiro: () => Promise<unknown>
}): Promise<void> {
  const selectedProviderId = input.selectedProviderId
    ? canonicalizeOpenCodeProviderId(input.selectedProviderId)
    : null

  if (selectedProviderId === 'cursor-acp') {
    await input.prepareCursor()
    return
  }
  if (selectedProviderId === 'kiro') {
    await input.prepareKiro()
    return
  }
  if (selectedProviderId) {
    return
  }

  await Promise.all([
    input.prepareCursor(),
    input.prepareKiro(),
  ])
}

function quotePosixShellValue(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function escapeWindowsBatchValue(value: string): string {
  return value.replaceAll('%', '%%')
}

/** Keeps the unscoped plugin list in step with the scoped policy override. */
function substituteCursorManagedPlugin(
  plugins: readonly string[],
  assets: OpenCodeCursorManagedAssets | null,
): string[] {
  if (!assets) return [...plugins]
  return plugins.map(plugin =>
    plugin.startsWith('@rama_nigg/open-cursor') ? assets.pluginEntryPath : plugin)
}

// Reverify each preparation: negative results, restaging and interpreter changes
// must agree with the uncached strict launch gates.
export async function resolveManagedCursorAssets(
  runtimeEnv: NodeJS.ProcessEnv,
): Promise<OpenCodeCursorManagedAssets | null> {
  const result = await resolveOpenCodeCursorManagedAssets({ env: runtimeEnv })
  return result.available ? result.assets : null
}

async function managedCursorAssetsIdentity(assets: OpenCodeCursorManagedAssets): Promise<string> {
  return hashString(JSON.stringify([assets.fingerprint, assets.pluginEntryPath, assets.mcpToolPath,
    await resolveCursorExecutableIdentity(assets.interpreterPath)]))
}

export function buildCursorHostGeneration(input: {
  assetsIdentity: string; nativeIdentity: string; scopeToken: string; configFingerprint: string
  projectPath: string; profileRootKey: string; projectBehaviorFingerprint: string
  binaryHostIdentity: string; transportIdentity: string
}): string {
  return hashString(JSON.stringify([input.assetsIdentity, input.nativeIdentity,
    input.scopeToken, input.configFingerprint, input.projectPath, input.profileRootKey,
    input.projectBehaviorFingerprint, input.binaryHostIdentity, input.transportIdentity,
    OPEN_CODE_MANAGED_HOST_CONFIG_GENERATION]))
}

// CURSOR_CONFIG_DIR isolates native model persistence, not native MCP discovery.
// Derive it before account probing so strict scope and execution share one env.
export function managedCursorNativeEnvironment(
  env: NodeJS.ProcessEnv, dataPath: string, projectPath: string,
): NodeJS.ProcessEnv {
  return { ...env, CURSOR_CONFIG_DIR: path.join(dataPath, 'opencode',
    'cursor-native-config', hashString(projectPath)), }
}

/** Pin the cancellation route reviewed in the staged transport fixture. */
export function applyCursorManagedExecutionEnvironment(env: NodeJS.ProcessEnv): void {
  Object.assign(env, {
    CURSOR_ACP_BACKEND: 'cursor-agent', CURSOR_ACP_AGENT_POOL: 'false',
    CURSOR_ACP_SESSION_RESUME: 'false', CURSOR_ACP_REUSE_EXISTING_PROXY: 'false',
    CURSOR_ACP_TOOL_LOOP_MODE: 'opencode', CURSOR_ACP_PROVIDER_BOUNDARY: 'v1',
    CURSOR_ACP_MODEL_AUTO_REFRESH: 'false',
  })
}

/**
 * Node parses NODE_OPTIONS itself and treats a backslash inside a quoted value
 * as an escape, so a quoted Windows path arrives with its separators removed and
 * the preload cannot be resolved. Quotes still have to stay for paths with
 * spaces, so the separators become the form Windows node also accepts.
 */
export function buildCursorAgentPreloadRequireOption(
  preloadPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const requirePath = platform === 'win32' ? preloadPath.replaceAll('\\', '/') : preloadPath
  return `--require="${requirePath}"`
}

/**
 * Operator kill switch for the preload as a whole. It is deliberately separate
 * from AGENT_TEAMS_CURSOR_RESOURCE_EXHAUSTED_PATCH_DISABLED, which turns off the
 * classification patch inside a preload that still runs: this one stops the shim
 * from injecting anything, which is the only escape hatch left once the
 * injection is no longer gated on the classification flag.
 */
export const CURSOR_PRELOAD_DISABLED_ENV = 'AGENT_TEAMS_CURSOR_PRELOAD_DISABLED'

const CURSOR_PRELOAD_FILE_NAME = 'cursor-agent-preload.cjs'
/** The cmd variable the Windows shim resolves the preload into. */
const WINDOWS_CURSOR_PRELOAD_VARIABLE = 'AGENT_TEAMS_CURSOR_PRELOAD'

/**
 * One preload file, two responsibilities. A second --require would make the
 * NODE_OPTIONS restore order load-bearing, and the attribution block has to run
 * first because the classification block owns that restore. The strict-mode
 * directive is emitted once here: only the first statement of a file is a
 * directive, so a second copy further down would be a plain string expression.
 */
export function buildCursorAgentPreloadScript(): string {
  return [
    "'use strict'",
    buildCursorAgentAttributionPreloadScript(),
    buildCursorAgentResourceExhaustedPreloadScript(),
  ].join('\n')
}

/**
 * The Windows shim resolves the preload from its own directory rather than from
 * a path written into the file. cmd.exe renders the file through the console OEM
 * code page, so a profile path with non-ASCII characters arrives mojibake'd and
 * would never resolve; %~dp0 is expanded from the real invocation path instead.
 * A preload that is missing or unreadable degrades to no preload, because node
 * aborts a process whose --require cannot be resolved.
 */
function buildWindowsCursorPreloadLines(): string[] {
  const variable = WINDOWS_CURSOR_PRELOAD_VARIABLE
  return [
    `set "${variable}=%~dp0${CURSOR_PRELOAD_FILE_NAME}"`,
    `set "${variable}=%${variable}:\\=/%"`,
    `if "%${CURSOR_PRELOAD_DISABLED_ENV}%"=="1" set "${variable}="`,
    `if not exist "%${variable}%" set "${variable}="`,
    `if defined ${variable} set "AGENT_TEAMS_CURSOR_ORIGINAL_NODE_OPTIONS=%NODE_OPTIONS%"`,
    `if defined ${variable} set "NODE_OPTIONS=${
      buildCursorAgentPreloadRequireOption(`%${variable}%`, 'win32')
    } %NODE_OPTIONS%"`,
    `set "${variable}="`,
  ]
}

function buildPosixCursorPreloadLines(
  preloadPath: string,
  platform: NodeJS.Platform,
): string[] {
  return [
    `if [ "\${${CURSOR_PRELOAD_DISABLED_ENV}:-}" != "1" ] && [ -r ${
      quotePosixShellValue(preloadPath)
    } ]; then`,
    '  export AGENT_TEAMS_CURSOR_ORIGINAL_NODE_OPTIONS="${NODE_OPTIONS:-}"',
    `  export NODE_OPTIONS=${
      quotePosixShellValue(buildCursorAgentPreloadRequireOption(preloadPath, platform))
    }" \${NODE_OPTIONS:-}"`,
    'fi',
  ]
}

export async function ensureOpenCodeNativeCliCredentialBridge(
  profileRootPath: string,
  hostEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cursorManagedAssets: OpenCodeCursorManagedAssets | null = null,
  managedConfigPath: string | null = null,
): Promise<OpenCodeNativeCliCredentialBridge> {
  const hostHomePath = (
    platform === 'win32'
      ? hostEnv.USERPROFILE?.trim() || hostEnv.HOME?.trim()
      : hostEnv.HOME?.trim() || hostEnv.USERPROFILE?.trim()
  ) || os.homedir()
  const hostPath = hostEnv.PATH ?? ''
  const resolvedCursorCommand = platform === 'win32' && !cursorManagedAssets
    ? hostEnv.CURSOR_AGENT_EXECUTABLE?.trim() ?? 'cursor-agent'
    : await resolveCursorAgentExecutable(hostEnv)
  const cursorAgentCommand = resolvedCursorCommand
    ?? path.join(profileRootPath, 'missing-native-cursor-agent')
  if (cursorManagedAssets && !resolvedCursorCommand) {
    throw new Error('Managed Cursor requires an absolute native executable')
  }
  const binPath = path.join(profileRootPath, 'native-subscription-cli-bin')
  await ensureOpenCodeDirectory(binPath)
  const cursorAgentPreloadPath = path.join(binPath, CURSOR_PRELOAD_FILE_NAME)
  await publishNativeCliFile(cursorAgentPreloadPath, buildCursorAgentPreloadScript(), 0o600)

  // The plugin registers OpenCode MCP servers as tools, but an agent can only
  // reach them through the plugin's own mcptool CLI. A global npm install would
  // provide it; a bundled artifact does not, so the profile ships its own shim.
  if (cursorManagedAssets && platform !== 'win32') {
    const shimPath = path.join(binPath, 'mcptool')
    await publishNativeCliFile(shimPath, [
      '#!/bin/sh',
      `exec ${quotePosixShellValue(cursorManagedAssets.interpreterPath)}`
        + ` ${quotePosixShellValue(cursorManagedAssets.mcpToolPath)} "$@"`,
      '',
    ].join('\n'), 0o700)
  }

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
        ...(command === 'cursor-agent' ? buildWindowsCursorPreloadLines() : []),
        `call "${escapeWindowsBatchValue(hostCommand)}" %*`,
        'exit /b %ERRORLEVEL%',
        '',
      ].join('\r\n')
      await publishNativeCliFile(bridgePath, content, 0o700)
      return bridgePath
    }

    const bridgePath = path.join(binPath, command)
    const content = [
      '#!/bin/sh',
      `export HOME=${quotePosixShellValue(hostHomePath)}`,
      `export USERPROFILE=${quotePosixShellValue(hostHomePath)}`,
      ...(command === 'cursor-agent'
        ? CURSOR_NATIVE_ENV_KEYS.filter(key => key !== 'PATH').map(key => hostEnv[key] === undefined
          ? `unset ${key}` : `export ${key}=${quotePosixShellValue(hostEnv[key]!)}`)
        : ['unset XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME']),
      command === 'cursor-agent' && cursorManagedAssets
        // Native execution is absolute, so our mcptool can safely win PATH.
        ? `export PATH=${quotePosixShellValue(`${binPath}${path.delimiter}${hostPath}`)}`
        : `export PATH=${quotePosixShellValue(hostPath)}`,
      ...(command === 'cursor-agent' && managedConfigPath
        // The bridge clears XDG_*, so mcptool needs the config named outright or
        // it would resolve the user's own OpenCode config instead of this profile.
        ? [`export OPENCODE_CONFIG=${quotePosixShellValue(managedConfigPath)}`]
        : []),
      ...(command === 'cursor-agent'
        ? buildPosixCursorPreloadLines(cursorAgentPreloadPath, platform)
        : []),
      `exec ${quotePosixShellValue(hostCommand)} "$@"`,
      '',
    ].join('\n')
    await publishNativeCliFile(bridgePath, content, 0o700)
    return bridgePath
  }

  const [cursorAgentExecutablePath, kiroCliExecutablePath] = await Promise.all([
    writeBridge('cursor-agent'),
    writeBridge('kiro-cli'),
  ])
  return {
    binPath, cursorAgentExecutablePath, kiroCliExecutablePath, hostHomePath,
    cursorAgentHostCommand: cursorAgentCommand,
  }
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

  const plugins = Array.isArray(source.plugin)
    ? source.plugin.filter((plugin): plugin is string =>
        typeof plugin === 'string' && plugin.trim().length > 0)
    : []
  if (plugins.length > 0) {
    safe.plugin = plugins
  }

  return safe
}

function getOpenCodeConfigImportPaths(env: NodeJS.ProcessEnv): string[] {
  const snapshotHomePath = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir()
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim() || path.join(snapshotHomePath, '.config')
  const candidates = Array.from(new Set([
    path.join(snapshotHomePath, '.config', 'opencode', 'opencode.json'),
    path.join(snapshotHomePath, '.config', 'opencode', 'opencode.jsonc'),
    // An explicit XDG config is closer to the invoking runtime than the
    // canonical user config and must win model/provider conflicts.
    path.join(xdgConfigHome, 'opencode', 'opencode.json'),
    path.join(xdgConfigHome, 'opencode', 'opencode.jsonc'),
  ]))
  const explicitConfigPath = env.OPENCODE_CONFIG?.trim()
  if (explicitConfigPath) {
    candidates.push(path.isAbsolute(explicitConfigPath)
      ? path.normalize(explicitConfigPath)
      : path.resolve(snapshotHomePath, explicitConfigPath))
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
  const importedFiles = await Promise.all(
    getOpenCodeConfigImportPaths(env).map(readSafeOpenCodeRuntimeConfigFile),
  )
  for (const importedFile of importedFiles) {
    importedConfig = deepMergeOpenCodeConfig(
      importedConfig,
      importedFile,
    )
  }

  importedConfig = deepMergeOpenCodeConfig(
    importedConfig,
    pickSafeOpenCodeRuntimeConfig(safeParseJSONC(env.OPENCODE_CONFIG_CONTENT)),
  )

  return importedConfig
}

async function readProjectOpenCodeRuntimeConfig(projectPath: string): Promise<Record<string, unknown>> {
  let config: Record<string, unknown> = {}
  const configs = await Promise.all(
    ['opencode.json', 'opencode.jsonc'].map(name =>
      readSafeOpenCodeRuntimeConfigFile(path.join(projectPath, name))),
  )
  for (const projectConfig of configs) {
    config = deepMergeOpenCodeConfig(
      config,
      projectConfig,
    )
  }
  return config
}

const SECRET_IDENTITY_KEY = /(?:^|[-_.])(api[-_.]?key|token|secret|password|authorization|proxy[-_.]?authorization|credential|cookie|set[-_.]?cookie|auth)(?:$|[-_.])/i
const ENV_REFERENCE = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

function isClassifiedIdentityKey(key: string): boolean {
  return SECRET_IDENTITY_KEY.test(key)
}

function resolveIdentityEnvironment(
  value: string,
  env: NodeJS.ProcessEnv,
  bindClassifiedReferences = false,
): string {
  return value.replace(ENV_REFERENCE, (reference, bracedName: string, shellName: string) => {
    const name = bracedName || shellName
    if (bindClassifiedReferences) {
      let state: 'missing' | 'empty' | 'present' | 'error'
      let effectiveValue: string | undefined
      try {
        effectiveValue = env[name]
        state = effectiveValue === undefined ? 'missing' : effectiveValue === '' ? 'empty' : 'present'
      } catch {
        state = 'error'
      }
      return `[env-secret:${semanticSecretIdentity('config-secret-env-reference', {
        syntax: bracedName ? 'opencode' : 'shell',
        name,
        state,
        ...(state === 'present' ? { value: effectiveValue } : {}),
      })}]`
    }
    if (isClassifiedIdentityKey(name)) return '[redacted-env]'
    return env[name] ?? reference
  })
}

function redactConfigIdentity(
  value: unknown,
  env: NodeJS.ProcessEnv,
  classified = false,
): unknown {
  if (classified) return secretIdentity(value, env)
  if (Array.isArray(value)) return value.map(item => redactConfigIdentity(item, env))
  if (typeof value === 'string') {
    const resolved = resolveIdentityEnvironment(value, env)
    if (!/^https?:\/\//i.test(resolved)) return resolved
    try {
      const url = new URL(resolved)
      if (url.username) url.username = secretIdentity(url.username, env)
      if (url.password) url.password = secretIdentity(url.password, env)
      const query = Array.from(url.searchParams.entries())
        .map(([key, queryValue]) => [
          key,
          isClassifiedIdentityKey(key)
            ? secretIdentity(queryValue, env)
            : resolveIdentityEnvironment(queryValue, env),
        ] as const)
        .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
          leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
      url.search = ''
      for (const [key, queryValue] of query) url.searchParams.append(key, queryValue)
      url.hash = ''
      return url.toString()
    } catch {
      return resolved
    }
  }
  if (!value || typeof value !== 'object') return value
  return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>(
    (result, key) => {
      result[key] = redactConfigIdentity(
        (value as Record<string, unknown>)[key],
        env,
        isClassifiedIdentityKey(key),
      )
      return result
    },
    {},
  )
}

type OpenCodeEffectiveConfigSnapshot = Readonly<{
  projectPath: string
  importedRuntimeConfig: Readonly<Record<string, unknown>>
  cursorAssetsIdentity?: string | null
  runtimeEnv: Readonly<NodeJS.ProcessEnv>
  managedPaths: Readonly<ReturnType<typeof resolveClaudeMultimodelPaths>>
  scopeIdentity: Readonly<{
    purpose: OpenCodeProfilePurpose
    providerId: string
    configFingerprint: string
    selectedAuthIdentity: 'absent' | 'error' | `known:${string}`
  }>
  selectedAuthCredential: Awaited<ReturnType<typeof readOpenCodeAuthCredential>>
  authoritySourceFingerprint: string
  appMcpLaunchConfig: Readonly<ResolvedAppMcpLaunchConfig> | null
}>

const openCodeEffectiveConfigSnapshots = new Map<string, OpenCodeEffectiveConfigSnapshot>()
const ownedOAuthSessionProfiles = new WeakMap<OpenCodePreparedProfile, { record: OpenCodeSessionRecord; profile: OpenCodePreparedProfile }>()
const OPEN_CODE_SEMANTIC_SECRET_IDENTITY_DOMAIN =
  'agent-teams.opencode.semantic-secret-identity/v2'

function freezeConfigSnapshot<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeConfigSnapshot(child)
    Object.freeze(value)
  }
  return value
}

// Cross-process equality needs no stored key: the identity is a versioned,
// domain-separated digest of canonical typed JSON. It is secret-safe for the
// high-entropy credentials/config secrets supported here, but is deliberately
// not a password KDF and must never be used to conceal low-entropy user input.
function semanticSecretIdentity(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([OPEN_CODE_SEMANTIC_SECRET_IDENTITY_DOMAIN, domain, value]) ?? '')
    .digest('hex')
}

function buildScopeIdentity(scope: OpenCodeProfileScope): {
  purpose: OpenCodeProfilePurpose
  providerId: string
  configFingerprint: string
  selectedAuthIdentity: OpenCodeIdentityComponent
} {
  return {
    purpose: scope.purpose,
    providerId: scope.providerId,
    configFingerprint: scope.configFingerprint,
    selectedAuthIdentity: scope.selectedAuthIdentity,
  }
}

function buildScopedProfileRootKey(projectPath: string, scope: Pick<OpenCodeProfileScope, 'scopeToken'>): string {
  // The token binds the complete effective snapshot. The narrower config/auth
  // tuple can be identical for distinct tokens. Keep scoped stores out of legacy
  // OAuth peer reconciliation, including in a later bridge process.
  return `scope-${hashString(JSON.stringify({ projectPath, scopeToken: scope.scopeToken }))}`
}

function isolateScopedRuntimeConfig(
  config: Record<string, unknown>,
  providerId: string,
  purpose: OpenCodeProfilePurpose,
): Record<string, unknown> {
  const selectedProvider = findCanonicalProviderConfig(asRecord(config.provider), providerId)
  const selectedManagedPlugins = planOpenCodeProfilePolicy({
    purpose, providerId, configFingerprint: 'isolation',
    selectedAuthIdentity: 'absent', scopeToken: 'isolation',
  }).managedSubscriptionPlugins
  const isolated: Record<string, unknown> = purpose === 'launch_runtime'
    ? deepMergeOpenCodeConfig({}, config)
    : {}
  isolated.provider = selectedProvider
    ? { [providerId]: selectedProvider.config }
    : {}
  for (const key of ['model', 'small_model'] as const) {
    const value = typeof config[key] === 'string' ? config[key].trim() : ''
    if (value.startsWith(`${providerId}/`)) isolated[key] = value
  }
  const configuredPlugins = Array.isArray(config.plugin)
    ? config.plugin.filter((plugin): plugin is string => typeof plugin === 'string')
    : []
  isolated.plugin = purpose === 'launch_runtime'
    ? configuredPlugins.filter(plugin =>
        !getOpenCodeManagedSubscriptionPluginPackages().includes(plugin)
        || selectedManagedPlugins.includes(plugin))
    : [...selectedManagedPlugins]
  return isolated
}

function enforceScopedProviderIsolation(
  config: Record<string, unknown>,
  providerId: string,
  managedPlugins: readonly string[],
): void {
  const selectedProvider = findCanonicalProviderConfig(asRecord(config.provider), providerId)
  config.provider = selectedProvider ? { [providerId]: selectedProvider.config } : {}
  for (const key of ['model', 'small_model'] as const) {
    const value = typeof config[key] === 'string' ? config[key].trim() : ''
    if (!value.startsWith(`${providerId}/`)) delete config[key]
  }
  applyOpenCodeManagedSubscriptionPlugins(config, [...managedPlugins])
}

function secretIdentity(value: unknown, env: NodeJS.ProcessEnv): string {
  const resolve = (item: unknown): unknown => {
    if (typeof item === 'string') return resolveIdentityEnvironment(item, env, true)
    if (Array.isArray(item)) return item.map(resolve)
    if (!item || typeof item !== 'object') return item
    return Object.keys(item as Record<string, unknown>).sort().reduce<Record<string, unknown>>(
      (result, key) => {
        result[key] = resolve((item as Record<string, unknown>)[key])
        return result
      },
      {},
    )
  }
  return `[secret:${semanticSecretIdentity('config-secret', resolve(value))}]`
}

function selectedProviderApiKeyIdentity(
  providerId: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const envName = `${providerId.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_API_KEY`
  const value = env[envName]
  return value === undefined
    ? null
    : semanticSecretIdentity('selected-provider-api-key-environment', { providerId, value })
}

const OPEN_CODE_AUTHORITY_FILE_MAX_BYTES = 1024 * 1024
const OPEN_CODE_PROVIDER_AUTHORITY_FAMILIES = Object.freeze({
  bedrock: Object.freeze({
    providerIds: Object.freeze(['amazon-bedrock', 'aws-bedrock', 'bedrock']),
    environmentNames: Object.freeze([
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_SHARED_CREDENTIALS_FILE',
    ]),
  }),
  vertex: Object.freeze({
    providerIds: Object.freeze(['google-vertex', 'vertex']),
    environmentNames: Object.freeze(['GOOGLE_APPLICATION_CREDENTIALS']),
  }),
  azure: Object.freeze({
    providerIds: Object.freeze(['azure', 'azure-openai']),
    environmentNames: Object.freeze([
      'AZURE_API_KEY',
      'AZURE_OPENAI_API_KEY',
      'AZURE_AUTH_LOCATION',
    ]),
  }),
})

type OpenCodeProviderAuthorityFamily = keyof typeof OPEN_CODE_PROVIDER_AUTHORITY_FAMILIES

function getOpenCodeProviderAuthorityFamily(
  providerId: string,
): OpenCodeProviderAuthorityFamily | null {
  for (const [family, contract] of Object.entries(OPEN_CODE_PROVIDER_AUTHORITY_FAMILIES)) {
    if ((contract.providerIds as readonly string[]).includes(providerId)) {
      return family as OpenCodeProviderAuthorityFamily
    }
  }
  return null
}

function isStrictAuthorityPurpose(purpose: OpenCodeProfilePurpose): boolean {
  return purpose === 'execution_probe' || purpose === 'launch_runtime'
}

type OpenCodeAuthlessAuthorityMode = 'builtin_free' | 'configured_authless'

// Keep this strict authority allowlist aligned with the credential-free local
// provider classes in OpenCodeModelAccessPolicy. Extension-backed providers are
// deliberately omitted because strict scopes reject them before this point.
const OPEN_CODE_STRICT_AUTHLESS_PROVIDER_IDS = new Set([
  'atomic-chat',
  'llama.cpp',
  'llamacpp',
  'lmstudio',
  'lm-studio',
  'local',
  'ollama',
  'vllm',
])

function resolveOpenCodeAuthlessAuthorityMode(input: {
  providerId: string
  selectedModel: string
  providerConfig: unknown
}): OpenCodeAuthlessAuthorityMode | null {
  const selectedModel = input.selectedModel.trim()
  const separatorIndex = selectedModel.indexOf('/')
  const modelId = separatorIndex > 0 ? selectedModel.slice(separatorIndex + 1) : ''
  if (input.providerId === 'opencode' && modelId.length > 0) {
    // Only binds "no credential" to this exact model; it does not authorize the
    // model. OpenCodeModelAccessPolicy decides access from the live Zen catalog:
    // launchTeam runs assertOpenCodeSelectedModelLaunchAccess before creating any
    // session, so a paid or unknown Zen model without a key is refused there.
    // Later session recreation (e.g. stale records in sendMessage) only reuses a
    // model that already passed that gate, and an authless scope holds no
    // credential to leak. A static list here went stale every time Zen added a
    // free model. The mode string stays 'builtin_free' so existing scope
    // fingerprints do not rotate.
    return 'builtin_free'
  }

  if (OPEN_CODE_STRICT_AUTHLESS_PROVIDER_IDS.has(input.providerId)) return 'configured_authless'

  const providerConfig = asRecord(input.providerConfig)
  const options = asRecord(providerConfig?.options)
  return providerConfig?.npm === '@ai-sdk/openai-compatible'
    && isLiteralLoopbackOpenCodeUrl(options?.baseURL ?? options?.baseUrl)
    ? 'configured_authless'
    : null
}

type OpenCodeAuthoritySourceBinding = {
  fingerprint: string
  fullyBound: boolean
  hasStaticCredential: boolean
}

function readEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): { state: 'missing' | 'empty' | 'present' | 'error'; value?: string } {
  try {
    const value = env[name]
    return value === undefined
      ? { state: 'missing' }
      : value === '' ? { state: 'empty' } : { state: 'present', value }
  } catch {
    return { state: 'error' }
  }
}

async function bindAuthorityFile(value: string): Promise<{
  state: 'not-file' | 'bound' | 'error'
  digest?: string
}> {
  try {
    const before = await stat(value)
    if (!before.isFile()) return { state: 'error' }
    if (before.size > OPEN_CODE_AUTHORITY_FILE_MAX_BYTES) return { state: 'error' }
    const bytes = await readFile(value)
    if (bytes.byteLength > OPEN_CODE_AUTHORITY_FILE_MAX_BYTES) return { state: 'error' }
    return {
      state: 'bound',
      digest: createHash('sha256').update(bytes).digest('hex'),
    }
  } catch (error) {
    const code = getErrnoCode(error)
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? { state: 'not-file' }
      : { state: 'error' }
  }
}

async function bindSelectedProviderAuthoritySources(input: {
  providerId: string
  providerConfig: unknown
  env: NodeJS.ProcessEnv
  projectPath: string
}): Promise<OpenCodeAuthoritySourceBinding> {
  const sources: unknown[] = []
  let fullyBound = true
  let hasStaticCredential = false
  let awsOptionsAccessKeyBound = false
  let awsOptionsSecretKeyBound = false
  let azureOptionsApiKeyBound = false
  let genericOptionsCredentialBound = false
  const family = getOpenCodeProviderAuthorityFamily(input.providerId)
  const supportsGenericStaticCredential = family === null
    && input.providerId !== 'kiro' && input.providerId !== 'cursor-acp'
  const familyContract = family === null
    ? null
    : OPEN_CODE_PROVIDER_AUTHORITY_FAMILIES[family]

  const bindEnv = async (
    name: string,
    pathKeys: readonly string[],
    syntax: string,
    required = true,
  ): Promise<boolean> => {
    const effective = readEnvironmentValue(input.env, name)
    if (effective.state !== 'present') {
      if (required || effective.state === 'error') fullyBound = false
      sources.push({ name, syntax, pathKeys, state: effective.state })
      return false
    }
    const file = await bindAuthorityFile(path.isAbsolute(effective.value!)
      ? effective.value!
      : path.resolve(input.projectPath, effective.value!))
    const expectsFile = pathKeys.some(key => /(?:(?:^|[-_.])(?:file|path)|(?:File|Path))$/.test(key))
      || name.endsWith('_FILE') || name === 'GOOGLE_APPLICATION_CREDENTIALS'
      || name === 'AZURE_AUTH_LOCATION'
    if (file.state === 'error' || (expectsFile && file.state !== 'bound')) {
      fullyBound = false
      sources.push({ name, syntax, pathKeys, state: 'file-error' })
      return false
    }
    if (file.state === 'bound') {
      sources.push({ name, syntax, pathKeys, state: 'file', digest: file.digest })
      // File-backed values are useful for cache/catalog identity only. A path,
      // symlink, metadata container, or atomically replaced file is never a
      // strict execution authority.
      fullyBound = false
      return false
    } else {
      sources.push({
        name, syntax, pathKeys, state: 'value',
        digest: semanticSecretIdentity('selected-provider-environment-value', effective.value),
      })
    }
    return true
  }

  const visit = async (value: unknown, pathKeys: string[]): Promise<void> => {
    if (Array.isArray(value)) {
      for (const item of value) await visit(item, pathKeys)
      return
    }
    if (typeof value === 'string') {
      const matches = Array.from(value.matchAll(ENV_REFERENCE))
      let valueBound = value.length > 0
      for (const match of matches) {
        valueBound = await bindEnv(
          match[1] || match[2]!, pathKeys, match[1] ? 'opencode' : 'shell',
        ) && valueBound
      }
      const isFileLocation = pathKeys.some(key =>
        /(?:(?:^|[-_.])(?:file|path)|(?:File|Path))$/.test(key))
      if (matches.length === 0 && value.length > 0 && isFileLocation) {
        const file = await bindAuthorityFile(path.isAbsolute(value)
          ? value
          : path.resolve(input.projectPath, value))
        sources.push({
          kind: 'config-file', pathKeys, state: file.state,
          ...(file.state === 'bound' ? { digest: file.digest } : {}),
        })
        fullyBound = false
        valueBound = false
      } else if (matches.length === 0 && value.length > 0
        && pathKeys.length === 2 && pathKeys[0] === 'options'
        && ((supportsGenericStaticCredential
          && (pathKeys[1] === 'apiKey' || pathKeys[1] === 'authorization'))
          || (family === 'azure' && pathKeys[1] === 'apiKey')
          || (family === 'bedrock'
            && (pathKeys[1] === 'accessKeyId' || pathKeys[1] === 'secretAccessKey')))) {
        const file = await bindAuthorityFile(path.isAbsolute(value)
          ? value
          : path.resolve(input.projectPath, value))
        if (file.state === 'bound' || file.state === 'error') {
          sources.push({
            kind: 'config-credential-file', pathKeys, state: file.state,
            ...(file.state === 'bound' ? { digest: file.digest } : {}),
          })
          fullyBound = false
          valueBound = false
        }
      }
      if (family === 'bedrock' && pathKeys.length === 2 && pathKeys[0] === 'options') {
        if (pathKeys[1] === 'accessKeyId') awsOptionsAccessKeyBound = valueBound
        if (pathKeys[1] === 'secretAccessKey') awsOptionsSecretKeyBound = valueBound
      }
      if (family === 'azure' && pathKeys.length === 2
        && pathKeys[0] === 'options' && pathKeys[1] === 'apiKey') {
        azureOptionsApiKeyBound = valueBound
      }
      if (supportsGenericStaticCredential && pathKeys.length === 2 && pathKeys[0] === 'options'
        && (pathKeys[1] === 'apiKey' || pathKeys[1] === 'authorization')) {
        genericOptionsCredentialBound = valueBound && value.length > 0
      }
      return
    }
    if (!value || typeof value !== 'object') return
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      await visit((value as Record<string, unknown>)[key], [...pathKeys, key])
    }
  }
  await visit(input.providerConfig, [])

  if (supportsGenericStaticCredential) {
    const directApiKeyName =
      `${input.providerId.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_API_KEY`
    // OpenCode's generic selected-provider contract consumes this exact key.
    const directApiKeyBound = await bindEnv(directApiKeyName, ['directApiKey'], 'ambient', false)
    hasStaticCredential = directApiKeyBound || genericOptionsCredentialBound
  }
  if (family === 'bedrock' && familyContract) {
    const [accessKeyName, secretKeyName, sessionTokenName, sharedFileName] =
      familyContract.environmentNames
    const accessKeyBound = await bindEnv(accessKeyName!, ['familyAccessKeyId'], 'ambient', false)
    const secretKeyBound = await bindEnv(secretKeyName!, ['familySecretAccessKey'], 'ambient', false)
    await bindEnv(sessionTokenName!, ['familySessionToken'], 'ambient', false)
    await bindEnv(sharedFileName!, ['ambientFile'], 'ambient', false)
    if ((accessKeyBound && secretKeyBound)
      || (awsOptionsAccessKeyBound && awsOptionsSecretKeyBound)) hasStaticCredential = true
  }
  if (family === 'vertex' && familyContract) {
    await bindEnv(familyContract.environmentNames[0]!, ['ambientFile'], 'ambient', false)
  }
  if (family === 'azure' && familyContract) {
    let azureEnvironmentApiKeyBound = false
    for (const name of familyContract.environmentNames.filter(name => name.endsWith('_API_KEY'))) {
      azureEnvironmentApiKeyBound = await bindEnv(name, ['familyApiKey'], 'ambient', false)
        || azureEnvironmentApiKeyBound
    }
    const authLocationName = familyContract.environmentNames.find(name => name.endsWith('_LOCATION'))
    if (authLocationName) await bindEnv(authLocationName, ['ambientFile'], 'ambient', false)
    hasStaticCredential = azureEnvironmentApiKeyBound || azureOptionsApiKeyBound
  }

  return {
    fingerprint: semanticSecretIdentity('selected-provider-authority-sources', sources),
    fullyBound,
    hasStaticCredential,
  }
}

type OpenCodeScopeResolutionInput = {
  projectPath?: string | null
  purpose: OpenCodeProfilePurpose
  selectedModel: string
  env?: NodeJS.ProcessEnv
  // Authority refresh reads scope without publishing a preparation snapshot.
  cacheSnapshot?: boolean
  isOAuthNativeSessionSettled?: (owner: OpenCodeOAuthNativeSessionOwner) => Promise<boolean>
  isOAuthNativeSessionUnsubmitted?: (owner: OpenCodeOAuthNativeSessionOwner) => Promise<boolean>
  isOAuthNativeProbeSettled?: (owner: OpenCodeOAuthNativeProbeOwner) => Promise<boolean>
  oauthSessionToRelease?: OpenCodeSessionRecord
}

function scopeSourceEnvironment(inputEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const retainedScopeEnvironment = asRecord(safeParseJSONC(
    inputEnv[OPEN_CODE_SCOPE_ENVIRONMENT_ENV],
  ))
  const envSnapshot = { ...inputEnv }
  for (const [key, value] of Object.entries(retainedScopeEnvironment)) {
    if (value === null) delete envSnapshot[key]
    else if (typeof value === 'string') envSnapshot[key] = value
  }
  return envSnapshot
}

export async function resolveOpenCodeProfileScope(input: OpenCodeScopeResolutionInput): Promise<OpenCodeProfileScope> {
  await recoverOpenCodeScopedOAuth(input)
  return resolveOpenCodeProfileScopeInternal(input)
}

function isForeignOpenCodeOAuthHarvestSkip(error: unknown): boolean {
  const code = getErrnoCode(error)
  if (code === 'EACCES' || code === 'ELOOP' || code === 'EPERM') {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('another project')
}

async function peekOpenCodeOAuthSaveAdmission(globalAuthPath: string): Promise<{
  owner: OpenCodeOAuthSaveOwner
  predecessor: OpenCodeAuthCredential
} | null> {
  try {
    const raw = JSON.parse(await readFile(openCodeOAuthSaveReceiptPath(globalAuthPath), 'utf8')) as {
      owner?: OpenCodeOAuthSaveOwner
      predecessor?: OpenCodeAuthCredential
    }
    if (!raw.owner?.projectPath || !raw.predecessor) {
      return null
    }
    return { owner: raw.owner, predecessor: raw.predecessor }
  } catch {
    return null
  }
}

async function recoverOpenCodeScopedOAuth(input: OpenCodeScopeResolutionInput): Promise<void> {
  // Catalog and provider tests must not fail-close on a leftover launch receipt
  // from another project. Owner catalog/probe still completes a pending
  // publication through recoverOpenCodeOwnedOAuthSave under the auth-store lock.
  // Authority comparisons explicitly use cacheSnapshot:false and stay read-only.
  // Fresh launch resolution can finish an already proven native publication;
  // it cannot create provenance from an old managed auth file.
  if (input.cacheSnapshot !== false && input.selectedModel.split('/')[0]?.trim().toLowerCase() === 'xai') {
    const env = scopeSourceEnvironment(input.env ?? process.env)
    const managedPaths = resolveClaudeMultimodelPaths(env)
    const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir()
    const globalAuthPath = path.join(managedPaths.data, 'opencode', 'auth.json')
    if (input.purpose === 'catalog' || input.purpose === 'execution_probe') {
      const pending = await peekOpenCodeOAuthSaveAdmission(globalAuthPath)
      if (pending) {
        try {
          const projectPath = await canonicalizeOpenCodeProjectPath(input.projectPath)
          if (
            projectPath !== pending.owner.projectPath &&
            !await isOpenCodeOAuthPublicationScopeCurrent(
              pending.owner,
              pending.predecessor,
              env,
              projectPath,
            )
          ) {
            return
          }
        } catch (error) {
          if (isForeignOpenCodeOAuthHarvestSkip(error)) {
            return
          }
          throw error
        }
      }
    }
    try {
    await recoverOpenCodeOwnedOAuthSave({
      globalAuthPath, env,
      assertRetirementAuthority: async owner => {
        if (await canonicalizeOpenCodeProjectPath(input.projectPath) !== owner.projectPath) {
          throw new Error('OpenCode OAuth retirement belongs to another project; original admission retained')
        }
      },
      sessionToRelease: input.oauthSessionToRelease,
      sourceAuthPaths: Array.from(new Set([globalAuthPath,
        path.join(env.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share'), 'opencode', 'auth.json'),
        path.join(home, '.local', 'share', 'opencode', 'auth.json'),
      ])),
      isNativeProbeSettled: input.isOAuthNativeProbeSettled ?? (async owner => {
        const { OpenCodeExecutionProbe } = await import('./OpenCodeExecutionProbe.js')
        return new OpenCodeExecutionProbe().isOwnedOAuthNativeProbeSettled(owner, managedPaths.data)
      }),
      isNativeSessionSettled: input.isOAuthNativeSessionSettled ?? (async owner => {
        const [{ OpenCodeSessionBridge }, { OpenCodeHostManager }, { OpenCodeSessionStore }] = await Promise.all([
          import('./OpenCodeSessionBridge.js'), import('./OpenCodeHostManager.js'), import('./OpenCodeSessionStore.js'),
        ])
        return new OpenCodeSessionBridge({
          oauthRecoveryDataRoot: managedPaths.data,
          hostManager: new OpenCodeHostManager({ persistentRegistryPath: path.join(managedPaths.data, 'opencode', 'host-registry.json') }),
          sessionStore: new OpenCodeSessionStore(path.join(managedPaths.data, 'opencode', 'session-store.json')),
        }).isOwnedOAuthNativeSessionSettled(owner)
      }),
      isNativeSessionUnsubmitted: input.isOAuthNativeSessionUnsubmitted ?? (async owner => {
        const [{ OpenCodeSessionBridge }, { OpenCodeHostManager }, { OpenCodeSessionStore }] = await Promise.all([
          import('./OpenCodeSessionBridge.js'), import('./OpenCodeHostManager.js'), import('./OpenCodeSessionStore.js'),
        ])
        return new OpenCodeSessionBridge({
          oauthRecoveryDataRoot: managedPaths.data,
          hostManager: new OpenCodeHostManager({ persistentRegistryPath: path.join(managedPaths.data, 'opencode', 'host-registry.json') }),
          sessionStore: new OpenCodeSessionStore(path.join(managedPaths.data, 'opencode', 'session-store.json')),
        }).isOwnedOAuthNativeSessionSettled(owner, true)
      }),
      isNativeProbeUnsubmitted: async owner => {
        const { OpenCodeExecutionProbe } = await import('./OpenCodeExecutionProbe.js')
        return new OpenCodeExecutionProbe().isOwnedOAuthNativeProbeSettled(owner, managedPaths.data, true)
      },
      assertOwner: async (owner, predecessor, managedAuthPath) => {
        const projectPath = await canonicalizeOpenCodeProjectPath(input.projectPath)
        if (projectPath !== owner.projectPath
          && !await isOpenCodeOAuthPublicationScopeCurrent(owner, predecessor, env, projectPath)) {
          throw new Error('OpenCode OAuth restart admission belongs to another project; original completion retained')
        }
        const expectedPath = path.join(managedPaths.data, 'opencode', 'profiles',
          buildScopedProfileRootKey(owner.projectPath, owner), 'data', 'opencode', 'auth.json')
        if (managedAuthPath !== expectedPath) {
          throw new Error('OpenCode OAuth pending saved publication managed owner changed')
        }
        if (!await isOpenCodeOAuthPublicationScopeCurrent(owner, predecessor, env)) {
          if (!owner.credentialBinding) {
            throw new Error('OpenCode OAuth recovery binding unavailable for changed launch scope; original admission retained')
          }
          throw new OpenCodeOAuthPublicationRevokedError('OpenCode OAuth pending saved publication source scope changed')
        }
      },
    })
    } catch (error) {
      if (
        (input.purpose === 'catalog' || input.purpose === 'execution_probe') &&
        isForeignOpenCodeOAuthHarvestSkip(error)
      ) {
        return
      }
      throw error
    }
  }
}

// Read-only publication comparison. Substitution is limited to the proven
// predecessor; it cannot prepare a profile or select the successor recursively.
export async function isOpenCodeOAuthPublicationScopeCurrent(
  owner: OpenCodeOAuthSaveOwner, predecessor: OpenCodeAuthCredential, env: NodeJS.ProcessEnv,
  admissionProjectPath?: string,
): Promise<boolean> {
  if (owner.launchCredential) {
    if (!isValidOpenCodeOAuthCredential(owner.launchCredential)
      || owner.launchCredential.accountId !== predecessor.accountId) return false
    predecessor = owner.launchCredential
  }
  const binding = owner.credentialBinding
  if (binding && (binding.version !== 1 || binding.scopeToken !== owner.scopeToken
    || !/^[a-f0-9]{64}$/.test(binding.fingerprint))) {
    throw new Error('OpenCode OAuth recovery binding is invalid')
  }
  let currentBinding: OpenCodeOAuthSaveOwner['credentialBinding']
  const scope = await resolveOpenCodeProfileScopeInternal({
    projectPath: owner.projectPath, purpose: owner.purpose,
    selectedModel: 'xai/oauth-authority', env, cacheSnapshot: false,
  }, predecessor, value => { currentBinding = value })
  return scope.scopeToken === owner.scopeToken
    || !!binding && currentBinding?.fingerprint === binding.fingerprint
      && (admissionProjectPath === undefined || admissionProjectPath === owner.projectPath)
}

async function resolveOpenCodeProfileScopeInternal(
  input: OpenCodeScopeResolutionInput,
  // Private substitution for proven OAuth lineage. Ordinary comparison never
  // caches; only exact owned-session reconstruction captures a config snapshot.
  recoveryPredecessor?: OpenCodeAuthCredential,
  captureCredentialBinding?: (binding: NonNullable<OpenCodeOAuthSaveOwner['credentialBinding']>) => void,
  captureSnapshot?: (snapshot: OpenCodeEffectiveConfigSnapshot) => void,
): Promise<OpenCodeProfileScope> {
  const envSnapshot = scopeSourceEnvironment(input.env ?? process.env)
  const projectPath = await canonicalizeOpenCodeProjectPath(input.projectPath)
  if (isStrictAuthorityPurpose(input.purpose)
    && canonicalizeOpenCodeProviderId(input.selectedModel.split('/')[0] ?? '') === 'cursor-acp') {
    Object.assign(envSnapshot, managedCursorNativeEnvironment(
      envSnapshot, resolveClaudeMultimodelPaths(envSnapshot).data, projectPath,
    ))
    await mkdir(envSnapshot.CURSOR_CONFIG_DIR!, { recursive: true, mode: 0o700 })
  }
  const env = Object.freeze(envSnapshot)
  const snapshotHomePath = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir()
  const snapshotManagedPaths = resolveClaudeMultimodelPaths(env)
  const providerId = canonicalizeOpenCodeProviderId(input.selectedModel.split('/')[0] ?? '')
  if (!providerId) {
    throw new Error(`OpenCode model must be provider-scoped, received "${input.selectedModel}"`)
  }
  if (isStrictAuthorityPurpose(input.purpose)
    && (providerId === 'kiro' || providerId === 'cursor-acp')) {
    // Cursor is admitted only once the staged managed assets verify: they carry
    // the ownership barrier and the Stop control that make a terminal Stop
    // provable. Unstaged Cursor, and Kiro, stay blocked.
    const managedCursor = providerId === 'cursor-acp'
      ? await resolveOpenCodeCursorManagedAssets({ env })
        .catch(error => ({ available: false as const, reason: `probe_failed:${String(error).slice(0, 60)}` }))
      : { available: false as const, reason: 'provider_has_no_managed_path' }
    if (!managedCursor.available) {
      // The reason is the whole difference between "this build ships no assets"
      // and "the environment hid the interpreter", and both used to read alike.
      throw new Error(
        `OpenCode ${input.purpose} does not support extension-bound provider ${providerId}`
        + ` (managed path unavailable: ${managedCursor.reason})`,
      )
    }
  }
  const imported = env[OPEN_CODE_SCOPE_CONFIG_CONTENT_ENV]
    ? pickSafeOpenCodeRuntimeConfig(safeParseJSONC(env[OPEN_CODE_SCOPE_CONFIG_CONTENT_ENV]))
    : await readSafeOpenCodeRuntimeConfigImport(env)
  const project = await readProjectOpenCodeRuntimeConfig(projectPath)
  const mergedRuntimeConfig = deepMergeOpenCodeConfig(imported, project)
  const importedRuntimeConfig = input.purpose === 'catalog' || input.purpose === 'launch_runtime'
    ? isolateScopedRuntimeConfig(mergedRuntimeConfig, providerId, input.purpose)
    : mergedRuntimeConfig
  ensureSelectedOpenCodeModelInImportedConfig(
    importedRuntimeConfig,
    input.selectedModel,
    input.purpose,
  )
  const effective = deepMergeOpenCodeConfig(
    importedRuntimeConfig,
    buildManagedConfig(null, { managedProviderId: providerId }),
  )
  const selectedProviderConfig = asRecord(effective.provider)[providerId] ?? null
  const authoritySources = await bindSelectedProviderAuthoritySources({
    providerId,
    providerConfig: selectedProviderConfig,
    env,
    projectPath,
  })
  const identity = redactConfigIdentity({
    providerId,
    provider: selectedProviderConfig,
    model: effective.model ?? null,
    small_model: effective.small_model ?? null,
    plugin: effective.plugin ?? null,
  }, env)
  const xdgDataHome = env.XDG_DATA_HOME?.trim() || path.join(snapshotHomePath, '.local', 'share')
  const selectedAuth = recoveryPredecessor ? { credential: recoveryPredecessor,
    identity: authCredentialIdentity('xai', recoveryPredecessor) } : await readSelectedAuthFromSources({
    providerId, env, admissionProjectPath: projectPath,
    globalAuthPath: path.join(snapshotManagedPaths.data, 'opencode', 'auth.json'),
    sourcePaths: Array.from(new Set([
      path.join(snapshotManagedPaths.data, 'opencode', 'auth.json'),
      path.join(xdgDataHome, 'opencode', 'auth.json'),
      path.join(snapshotHomePath, '.local', 'share', 'opencode', 'auth.json'),
    ])),
  })
  if (isStrictAuthorityPurpose(input.purpose) && !authoritySources.fullyBound) {
    throw new Error('OpenCode strict profile authority source is unavailable')
  }
  const selectedAuthIsCredential = isValidatedStrictAuthCredential(providerId, selectedAuth.credential)
  if (isStrictAuthorityPurpose(input.purpose) && selectedAuth.identity === 'error') {
    throw new Error('OpenCode strict profile selected authentication is unavailable')
  }
  const authlessAuthorityMode = isStrictAuthorityPurpose(input.purpose)
    // Cursor's loopback adapter is native-authenticated, not authless. Otherwise
    // its first marker write changes configured_authless to null and rotates
    // config/scope identity even while the native account remains unchanged.
    && providerId !== 'cursor-acp'
    && selectedAuth.credential === null
    && !authoritySources.hasStaticCredential
    ? resolveOpenCodeAuthlessAuthorityMode({
        providerId,
        selectedModel: input.selectedModel,
        providerConfig: selectedProviderConfig,
      })
    : null
  // The Cursor marker credential is deliberately not proof. A live native account
  // probe is, and it is only consulted when the managed assets verify.
  const cursorCandidate = isStrictAuthorityPurpose(input.purpose)
    && providerId === 'cursor-acp'
  const cursorAssets = cursorCandidate ? await resolveManagedCursorAssets(env) : null
  const cursorAssetsReady = cursorAssets !== null
  const cursorAssetsIdentity = cursorAssets ? await managedCursorAssetsIdentity(cursorAssets) : null
  const cursorNative = cursorAssetsReady ? await resolveCurrentCursorNativeAuthority(env) : null
  const cursorNativeAuthorized = cursorNative !== null
  if (cursorCandidate && !cursorNativeAuthorized) {
    throw new Error('OpenCode strict Cursor profile requires current native authentication')
  }
  const selectedAuthIdentity = cursorNative?.identity ?? selectedAuth.identity
  if (
    isStrictAuthorityPurpose(input.purpose)
    && !selectedAuthIsCredential
    && !authoritySources.hasStaticCredential
    && authlessAuthorityMode === null
    && !cursorNativeAuthorized
  ) {
    // Which of the three conditions failed is the difference between "stage the
    // assets", "sign in to Cursor" and "this provider needs a credential".
    const cursorDetail = !cursorCandidate
      ? 'not_cursor_native_candidate'
      : !cursorAssetsReady ? 'managed_assets_unavailable' : 'cursor_account_not_authorized'
    throw new Error(
      `OpenCode strict profile requires explicit selected authentication (${cursorDetail})`,
    )
  }
  const authlessAuthorityFingerprint = authlessAuthorityMode === null
    ? null
    : semanticSecretIdentity('authless-profile-authority', {
        mode: authlessAuthorityMode,
        providerId,
        selectedModel: input.selectedModel.trim(),
      })
  const authoritySourceFingerprint = semanticSecretIdentity('selected-provider-authority', {
    sourceFingerprint: authoritySources.fingerprint,
    authlessAuthorityFingerprint,
    ...(cursorAssetsIdentity ? { cursorAssetsIdentity } : {}),
  })
  // Hosted launches always re-derive the config from the signed descriptor.
  const retainedAppMcpLaunchConfig = isHostedAppMcpAuthorityInstalled()
    ? null
    : safeParseJSONC(env[OPEN_CODE_SCOPE_APP_MCP_LAUNCH_CONFIG_ENV]) as ResolvedAppMcpLaunchConfig | null
  const appMcpLaunchConfig = input.purpose === 'launch_runtime'
    ? retainedAppMcpLaunchConfig ?? await resolveOpenCodeAppMcpLaunchConfig({ env }).then(resolved => {
        const managedConfig = buildManagedConfig(resolved.config)
        applyManagedPathEnvironmentToMcpConfig(managedConfig, {
          [CLAUDE_MULTIMODEL_DATA_HOME_ENV]: snapshotManagedPaths.data,
          [CLAUDE_MULTIMODEL_CACHE_HOME_ENV]: snapshotManagedPaths.cache,
        })
        return {
          source: resolved.source,
          config: (
            asRecord(managedConfig.mcp)[OPEN_CODE_APP_MCP_SERVER_NAME]
          ) as OpenCodeMcpServerConfig,
        }
      })
    : null
  const appMcpLaunchIdentity = redactConfigIdentity(appMcpLaunchConfig, env)
  const configFingerprint = hashString(JSON.stringify({
    identity,
    authoritySourceFingerprint,
    managedPaths: snapshotManagedPaths,
    appMcpLaunchIdentity,
  }))
  // The token is persisted in session and host identities, so it must survive a
  // one-shot bridge process exit. Bind only the effective, redacted inputs that
  // can affect this scoped profile; the local snapshot map below still proves
  // that callers in this process possess the exact prepared snapshot.
  const scopeToken = semanticSecretIdentity('profile-scope', {
    projectPath,
    purpose: input.purpose,
    providerId,
    configFingerprint,
    selectedAuthIdentity,
    effectiveConfigSnapshot: redactConfigIdentity(importedRuntimeConfig, env),
    selectedProviderApiKeyIdentity: selectedProviderApiKeyIdentity(providerId, env),
    authoritySourceFingerprint,
    managedPaths: snapshotManagedPaths,
    appMcpLaunchIdentity,
  })
  if (captureCredentialBinding) {
    // This is credential admission, not host reuse. Bind every scope input,
    // changing only the port of an otherwise identical local app control URL.
    const credentialMcp = structuredClone(appMcpLaunchConfig)
    let restartEligible = false
    if (credentialMcp?.config.type === 'local') {
      const localEnv = credentialMcp.config.environment
      const control = localEnv?.CLAUDE_TEAM_CONTROL_URL
      const authorityRoot = localEnv?.AGENT_TEAMS_MCP_CLAUDE_DIR
      if (localEnv && control && authorityRoot && path.isAbsolute(authorityRoot)) {
        try {
          const url = new URL(control)
          if (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
            && !url.username && !url.password && !control.includes('#') && url.port !== '0') {
            restartEligible = true
            url.port = ''
            localEnv.CLAUDE_TEAM_CONTROL_URL = url.toString()
          }
        } catch { /* No restart relaxation for an invalid endpoint. */ }
      }
    }
    captureCredentialBinding({ version: 1, scopeToken,
      fingerprint: semanticSecretIdentity('oauth-credential-authority-v1', {
        projectPath, purpose: input.purpose, providerId, identity,
        selectedAuthIdentity, authoritySourceFingerprint,
        effectiveConfigSnapshot: redactConfigIdentity(importedRuntimeConfig, env),
        selectedProviderApiKeyIdentity: selectedProviderApiKeyIdentity(providerId, env),
        managedPaths: snapshotManagedPaths,
        sourceRoots: { home: snapshotHomePath, xdgDataHome },
        appMcpLaunchIdentity: redactConfigIdentity(credentialMcp, env),
        // Shared redaction may erase invalid URL details (notably fragments).
        // Only eligible local endpoints may compare across distinct full scopes.
        ...(!restartEligible ? { exactScopeToken: scopeToken } : {}),
      }),
    })
  }
  const scope: OpenCodeProfileScope = {
    purpose: input.purpose,
    providerId,
    configFingerprint,
    selectedAuthIdentity,
    scopeToken,
  }
  if (captureSnapshot || !recoveryPredecessor && input.cacheSnapshot !== false && !openCodeEffectiveConfigSnapshots.has(scopeToken)) {
    const snapshot = freezeConfigSnapshot({
      projectPath,
      importedRuntimeConfig,
      runtimeEnv: env,
      cursorAssetsIdentity,
      managedPaths: snapshotManagedPaths,
      scopeIdentity: buildScopeIdentity(scope),
      selectedAuthCredential: selectedAuth.credential,
      authoritySourceFingerprint,
      appMcpLaunchConfig,
    })
    if (captureSnapshot) captureSnapshot(snapshot)
    else openCodeEffectiveConfigSnapshots.set(scopeToken, snapshot)
  }
  return scope
}

export async function assertOpenCodePreparedProfileScope(
  profile: OpenCodePreparedProfile,
  projectPath?: string | null,
): Promise<void> {
  if (!profile.profileScope) return
  const snapshot = openCodeEffectiveConfigSnapshots.get(profile.scopeToken ?? '')
  if (
    !snapshot
    || profile.scopeToken !== profile.profileScope.scopeToken
    || JSON.stringify(snapshot.scopeIdentity)
      !== JSON.stringify(buildScopeIdentity(planOpenCodeProfilePolicy(profile.profileScope).scope))
    || profile.canonicalProjectPath !== snapshot.projectPath
  ) {
    throw new Error('OpenCode prepared profile scope token is invalid or expired')
  }
  const currentCanonicalPath = await canonicalizeOpenCodeProjectPath(projectPath ?? profile.projectPath)
  if (currentCanonicalPath !== snapshot.projectPath) {
    throw new Error('OpenCode prepared profile canonical project path changed')
  }
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

export function buildManagedConfigFingerprint(
  managedConfig: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return hashString(JSON.stringify(redactConfigIdentity(
    normalizeManagedConfigForFingerprint(managedConfig),
    env,
  )))
}

/**
 * Per-section fingerprints of the same config the whole fingerprint covers.
 * A stale session otherwise reports only "some hash changed", which is exactly
 * the question a launch failure leaves you asking.
 */
export function buildManagedConfigSectionFingerprints(
  managedConfig: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(Object.keys(managedConfig).sort().map(section =>
    [section, buildManagedConfigFingerprint({ [section]: managedConfig[section] }, env)]))
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

type OpenCodeIdentityComponent = 'absent' | 'error' | `known:${string}`

function authCredentialIdentity(
  providerId: string,
  credential: unknown,
): OpenCodeIdentityComponent {
  return credential === null
    ? 'absent'
    : `known:${semanticSecretIdentity('selected-auth', {
        providerId: canonicalizeOpenCodeProviderId(providerId),
        credential: redactConfigIdentity(credential, {}),
      })}`
}

function isValidatedStrictAuthCredential(providerId: string, credential: unknown): boolean {
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)) return false
  const record = credential as Record<string, unknown>
  if (record.type === 'api') {
    const key = typeof record.key === 'string' ? record.key.trim() : ''
    return Boolean(key) && !(providerId === 'cursor-acp' && key === 'cursor-agent')
  }
  if (record.type === 'oauth') {
    const access = typeof record.access === 'string' ? record.access.trim() : ''
    const refresh = typeof record.refresh === 'string' ? record.refresh.trim() : ''
    const token = typeof record.token === 'string' ? record.token.trim() : ''
    if (providerId === 'kiro' && access === 'authenticated' && !refresh && !token) return false
    return Boolean(access || refresh || token)
  }
  return false
}

async function readSelectedAuthFromSources(input: {
  admissionProjectPath?: string
  env?: NodeJS.ProcessEnv
  providerId: string
  sourcePaths: readonly string[]
  globalAuthPath: string
}): Promise<{
  credential: Awaited<ReturnType<typeof readOpenCodeAuthCredential>>
  identity: OpenCodeIdentityComponent
}> {
  let selected: Awaited<ReturnType<typeof readOpenCodeAuthCredential>> = null
  try {
    const sourceStores = await Promise.all(input.sourcePaths.map(readOpenCodeAuthStore))
    const sources = {
      sourceAuthPaths: input.sourcePaths,
      sourceStores, env: input.env, admissionProjectPath: input.admissionProjectPath,
      globalAuthPath: input.globalAuthPath,
    }
    const merged = input.providerId === 'xai'
      ? await readOpenCodeSavedAuthStore(sources)
      : mergeOpenCodeManagedAuthSources(sources)
    selected = merged[input.providerId] ?? null
    return { credential: selected, identity: authCredentialIdentity(input.providerId, selected) }
  } catch {
    return { credential: null, identity: 'error' }
  }
}

async function readSelectedManagedAuthIdentity(
  managedAuthPath: string,
  providerId: string,
): Promise<OpenCodeIdentityComponent> {
  try {
    return authCredentialIdentity(providerId, await readOpenCodeAuthCredential({
      authPath: managedAuthPath,
      providerId,
    }))
  } catch {
    return 'error'
  }
}

export class OpenCodeProfileManager {
  private static readonly profilePreparationLocks = new Map<string, Promise<void>>()

  private get paths() {
    return resolveClaudeMultimodelPaths()
  }

  private getSourceAuthPaths(
    env: NodeJS.ProcessEnv = process.env,
    homePath = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir(),
  ): string[] {
    const xdgDataHome =
      env.XDG_DATA_HOME?.trim() || path.join(homePath, '.local', 'share')
    return Array.from(new Set([
      path.join(xdgDataHome, 'opencode', 'auth.json'),
      // Bridge/live-test processes can intentionally set XDG_DATA_HOME to an
      // isolated runtime directory. Always include the canonical user OpenCode
      // auth store as the highest-priority source so a fresh `opencode auth`
      // login can override stale app-global OAuth credentials.
      path.join(homePath, '.local', 'share', 'opencode', 'auth.json'),
    ]))
  }

  getGlobalAuthPath(dataPath = this.paths.data): string {
    return path.join(dataPath, 'opencode', 'auth.json')
  }

  async listManagedAuthPaths(dataPath = this.paths.data): Promise<string[]> {
    const profilesRootPath = path.join(dataPath, 'opencode', 'profiles')
    let entries: Dirent[]
    try {
      entries = await readdir(profilesRootPath, { withFileTypes: true })
    } catch {
      return []
    }

    return entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('scope-'))
      .map(entry => path.join(profilesRootPath, entry.name, 'data', 'opencode', 'auth.json'))
      .sort((left, right) => left.localeCompare(right))
  }

  async fanOutOAuthCredential(providerId: string, sourceAuthPath: string): Promise<void> {
    await fanOutOpenCodeOAuthCredential({
      providerId,
      sourceAuthPath,
      targetAuthPaths: [this.getGlobalAuthPath(), ...(await this.listManagedAuthPaths())],
    })
  }

  private async scopedOAuthAuthority(profile: OpenCodePreparedProfile) {
    await assertOpenCodePreparedProfileScope(profile)
    const snapshot = openCodeEffectiveConfigSnapshots.get(profile.scopeToken ?? '')
    const scope = profile.profileScope
    if (!snapshot || !scope || scope.providerId !== 'xai') {
      throw new Error('OpenCode OAuth refresh requires an exact scoped snapshot')
    }
    const rootKey = buildScopedProfileRootKey(snapshot.projectPath, scope)
    const managedAuthPath = path.join(snapshot.managedPaths.data, 'opencode', 'profiles',
      rootKey, 'data', 'opencode', 'auth.json')
    if (profile.profileRootKey !== rootKey || profile.managedAuthPath !== managedAuthPath) {
      throw new Error('OpenCode OAuth refresh managed scope path changed')
    }
    const globalAuthPath = this.getGlobalAuthPath(snapshot.managedPaths.data)
    const sourceAuthPaths = Array.from(new Set([
      globalAuthPath, ...this.getSourceAuthPaths(snapshot.runtimeEnv),
    ]))
    return { snapshot, scope, managedAuthPath, globalAuthPath, sourceAuthPaths }
  }

  async finishOwnedOAuthBeforeSessionRelease(
    record: OpenCodeSessionRecord,
    isSettled?: (owner: OpenCodeOAuthNativeSessionOwner) => Promise<boolean>,
  ): Promise<void> {
    if (record.profileScope?.providerId !== 'xai') return
    const snapshot = openCodeEffectiveConfigSnapshots.get(record.profileScope.scopeToken)
    await recoverOpenCodeScopedOAuth({
      projectPath: record.projectPath, purpose: record.profileScope.purpose,
      selectedModel: record.selectedModel, env: snapshot?.runtimeEnv ?? process.env,
      oauthSessionToRelease: record, isOAuthNativeSessionSettled: isSettled,
    })
  }

  async readSavedOAuthCredential(profile: OpenCodePreparedProfile) {
    const authority = await this.scopedOAuthAuthority(profile)
    const selected = await readSelectedAuthFromSources({
      providerId: authority.scope.providerId, env: authority.snapshot.runtimeEnv,
      admissionProjectPath: authority.snapshot.projectPath,
      sourcePaths: authority.sourceAuthPaths,
      globalAuthPath: authority.globalAuthPath,
    })
    if (selected.identity === 'error') throw new Error('OpenCode OAuth saved authority is unavailable')
    return selected.credential
  }

  async getOAuthRefreshEnvironment(profile: OpenCodePreparedProfile): Promise<NodeJS.ProcessEnv> {
    return { ...(await this.scopedOAuthAuthority(profile)).snapshot.runtimeEnv }
  }

  async readCompletedSessionOAuthRotation(record: OpenCodeSessionRecord, env: NodeJS.ProcessEnv = process.env) {
    record = structuredClone(record)
    if (record.profileScope?.purpose !== 'launch_runtime' || record.profileScope.providerId !== 'xai'
      || record.stoppedAt || record.staleReason || !record.runId) return null
    const runtimeEnv = scopeSourceEnvironment(env)
    const data = resolveClaudeMultimodelPaths(runtimeEnv).data
    const globalAuthPath = this.getGlobalAuthPath(data)
    const managedAuthPath = path.join(data, 'opencode', 'profiles', record.profileRootKey, 'data', 'opencode', 'auth.json')
    const input = { globalAuthPath, managedAuthPath, env: runtimeEnv, record,
      sourceAuthPaths: Array.from(new Set([globalAuthPath, ...this.getSourceAuthPaths(runtimeEnv)])) }
    const rotation = await readOpenCodeCommittedOAuthSessionRotation(input)
    if (!rotation) return null
    const scopeInput = { projectPath: record.projectPath, purpose: 'launch_runtime' as const,
      selectedModel: record.selectedModel, env: runtimeEnv, cacheSnapshot: false }
    // Exact scope alone must not bypass a missing or forged retained binding.
    // Recompute it from the proven original launch credential and current inputs.
    let binding: OpenCodeOAuthSaveOwner['credentialBinding']
    const launchScope = await resolveOpenCodeProfileScopeInternal(scopeInput, rotation.predecessor,
      value => { binding = value })
    if (!isDeepStrictEqual(launchScope, record.profileScope)
      || !isDeepStrictEqual(binding, rotation.credentialBinding)) return null
    await this.assertSessionRefreshOwner(record, rotation.nativeSession, data)
    return isDeepStrictEqual(await readOpenCodeCommittedOAuthSessionRotation(input), rotation) ? rotation : null
  }

  private async assertSessionRefreshOwner(record: OpenCodeSessionRecord, native: OpenCodeOAuthNativeSessionOwner, data: string) {
    const [{ OpenCodeSessionStore }, { OpenCodeHostManager }] = await Promise.all([
      import('./OpenCodeSessionStore.js'), import('./OpenCodeHostManager.js'),
    ])
    const current = await new OpenCodeSessionStore(path.join(data, 'opencode', 'session-store.json'))
      .get(record.teamId, record.laneId ?? 'primary', record.memberName)
    if (!current || !sameOpenCodeOAuthSessionAuthority(current, record) || current.stoppedAt || current.staleReason) {
      throw new Error('OpenCode OAuth session refresh authority changed; relaunch the lane')
    }
    const endpoint = await new OpenCodeHostManager({ persistentRegistryPath: path.join(data, 'opencode', 'host-registry.json') })
      .resolveOwnedSessionEndpoint(record.hostKey, { teamId: record.teamId, laneId: record.laneId,
        memberName: record.memberName, runId: record.runId, sessionId: record.opencodeSessionId,
        projectPath: record.projectPath, expectedProcessStartedAtMs: native.processStartedAtMs })
    if (endpoint.pid !== native.pid || endpoint.baseUrl !== native.baseUrl) {
      throw new Error('OpenCode OAuth session refresh process changed')
    }
  }

  async prepareOwnedOAuthSessionProfile(record: OpenCodeSessionRecord, signal?: AbortSignal) {
    const rotation = await this.readCompletedSessionOAuthRotation(record)
    if (!rotation) return null
    let snapshot: OpenCodeEffectiveConfigSnapshot | undefined
    const scope = await resolveOpenCodeProfileScopeInternal({ projectPath: record.projectPath,
      selectedModel: record.selectedModel, purpose: 'launch_runtime', cacheSnapshot: false },
      rotation.predecessor, undefined, value => { snapshot = value })
    if (!snapshot || !isDeepStrictEqual(scope, record.profileScope)) return null
    // Reconstruct the original config only. This snapshot never materializes C0
    // into native auth; preparation below checks the committed successor instead.
    openCodeEffectiveConfigSnapshots.set(scope.scopeToken, snapshot)
    const profile = await this.prepareProfileInternal(record.projectPath, {
      profileScope: scope, toolApprovalMode: record.toolApprovalMode ?? 'auto', abortSignal: signal,
    }, record)
    if (!isDeepStrictEqual(await this.readCompletedSessionOAuthRotation(record), rotation)) {
      throw new Error('OpenCode OAuth session refresh changed during preparation')
    }
    ownedOAuthSessionProfiles.set(profile, { record: structuredClone(record), profile: structuredClone(profile) })
    return profile
  }

  hasOwnedOAuthSessionProfile(record: OpenCodeSessionRecord, profile: OpenCodePreparedProfile): boolean {
    const proof = ownedOAuthSessionProfiles.get(profile)
    return !!proof && sameOpenCodeOAuthSessionAuthority(proof.record, record) && isDeepStrictEqual(proof.profile, profile)
  }

  async readCompletedReadinessOAuthRotation(
    host: OpenCodeHostHandle,
    selectedModel: string,
    currentScope: OpenCodeProfileScope,
    completedProbe: OpenCodeOAuthNativeProbeOwner,
  ) {
    if (host.profile.profileScope?.purpose !== 'launch_runtime'
      || host.profile.profileScope.providerId !== 'xai'
      || !selectedModel.startsWith('xai/') || !host.processStartedAtMs
      || host.profileRootKey !== host.profile.profileRootKey
      || host.projectPath !== host.profile.canonicalProjectPath) return null
    const nativeProbe = { projectPath: host.profile.canonicalProjectPath, scopeToken: host.profile.scopeToken!,
      profileRootKey: host.profileRootKey, hostKey: host.hostKey, baseUrl: host.baseUrl,
      pid: host.pid, processStartedAtMs: host.processStartedAtMs, selectedModel,
      sessionId: completedProbe.sessionId, messageId: completedProbe.messageId }
    if (!nativeProbe.sessionId || !nativeProbe.messageId
      || !isDeepStrictEqual(completedProbe, nativeProbe)) return null
    const authority = await this.scopedOAuthAuthority(host.profile)
    const predecessor = authority.snapshot.selectedAuthCredential
    if (!isValidOpenCodeOAuthCredential(predecessor)) return null
    const rotation = await readOpenCodeCommittedOAuthProbeRotation({
      ...authority, env: authority.snapshot.runtimeEnv, predecessor,
      nativeProbe,
    })
    if (!rotation) return null
    const input = { projectPath: authority.snapshot.projectPath, selectedModel,
      purpose: authority.scope.purpose, env: host.profile.env, cacheSnapshot: false }
    // Unlike restart credential admission, readiness requires the exact full
    // scope (including MCP port), substituting only proven credential bytes.
    const before = await resolveOpenCodeProfileScopeInternal(input, rotation.predecessor)
    const after = await resolveOpenCodeProfileScopeInternal(input, rotation.successor)
    return isDeepStrictEqual(before, authority.scope) && isDeepStrictEqual(after, currentScope)
      && await readProcessStartTimeMs(nativeProbe.pid) === nativeProbe.processStartedAtMs
      ? rotation : null
  }

  // This wraps controlled, settled native work; it never blesses a credential
  // discovered by scanning profiles. Source paths come from the resolver's
  // retained environment, including when this manager's ambient data root differs.
  async withOwnedOAuthRefresh<T>(input: {
    profile: OpenCodePreparedProfile
    sessionRecord?: OpenCodeSessionRecord
    assertHostOwnership: () => Promise<void>
    operation: (armNativeSession: (owner: OpenCodeOAuthNativeSessionOwner) => Promise<void>,
      armNativeProbe: (owner: OpenCodeOAuthNativeProbeOwner) => Promise<void>) => Promise<T>
    isNativeSettled?: (value: T) => boolean
    isNativeDefinitelyUnsubmitted?: (value: T) => boolean
    allowNativeContinuation?: boolean
    abortSignal?: AbortSignal
  }): Promise<T> {
    const sessionRecord = input.sessionRecord ? structuredClone(input.sessionRecord) : undefined
    const captured = structuredClone(input.profile)
    const authority = await this.scopedOAuthAuthority(input.profile)
    const launchCredential = authority.snapshot.selectedAuthCredential
    const rotation = sessionRecord
      ? await this.readCompletedSessionOAuthRotation(sessionRecord, authority.snapshot.runtimeEnv) : null
    const predecessor = rotation?.successor ?? launchCredential
    if (rotation && (!isDeepStrictEqual(sessionRecord?.profileScope, authority.scope)
      || sessionRecord?.profileRootKey !== captured.profileRootKey
      || !isDeepStrictEqual(launchCredential, rotation.predecessor))) {
      throw new Error('OpenCode OAuth continuation does not match the prepared session')
    }
    const assertPublicationOwnership = async () => {
      if (!isDeepStrictEqual(input.profile, captured)) {
        throw new Error('OpenCode OAuth prepared host profile changed')
      }
      await input.assertHostOwnership()
      if (isValidOpenCodeOAuthCredential(predecessor)) {
        const originalScope = await resolveOpenCodeProfileScopeInternal({
          projectPath: authority.snapshot.projectPath, selectedModel: 'xai/oauth-authority',
          purpose: authority.scope.purpose, env: authority.snapshot.runtimeEnv, cacheSnapshot: false,
        }, launchCredential!)
        if (originalScope.scopeToken !== authority.scope.scopeToken) {
          throw new OpenCodeOAuthPublicationRevokedError('OpenCode OAuth publication source configuration changed')
        }
      }
    }
    const assertOwnership = async () => {
      await assertPublicationOwnership()
      const current = await resolveOpenCodeProfileScope({
        projectPath: authority.snapshot.projectPath,
        selectedModel: `${authority.scope.providerId}/oauth-authority`,
        purpose: authority.scope.purpose,
        env: authority.snapshot.runtimeEnv,
        cacheSnapshot: false,
      })
      // This runs before publication, while saved authority must still be C0.
      // Include the complete effective snapshot token, not just its narrower
      // selected config/auth tuple. Publication never reseals this old profile.
      const expectedScope = rotation ? await resolveOpenCodeProfileScopeInternal({
        projectPath: authority.snapshot.projectPath, selectedModel: 'xai/oauth-authority',
        purpose: authority.scope.purpose, env: authority.snapshot.runtimeEnv, cacheSnapshot: false,
      }, predecessor!) : authority.scope
      if (!isDeepStrictEqual(current, expectedScope)) {
        throw new OpenCodeOAuthPublicationRevokedError('OpenCode OAuth source scope changed')
      }
    }
    if (!isValidOpenCodeOAuthCredential(predecessor)) {
      if (predecessor?.type === 'oauth') throw new Error('OpenCode OAuth predecessor is malformed')
      await assertOwnership()
      return input.operation(async () => {}, async () => {})
    }
    let credentialBinding: OpenCodeOAuthSaveOwner['credentialBinding']
    await resolveOpenCodeProfileScopeInternal({
      projectPath: authority.snapshot.projectPath, selectedModel: 'xai/oauth-authority',
      purpose: authority.scope.purpose, env: authority.snapshot.runtimeEnv, cacheSnapshot: false,
    }, launchCredential!, binding => { credentialBinding = binding })
    if (credentialBinding?.scopeToken !== authority.scope.scopeToken) {
      throw new Error('OpenCode OAuth admission source configuration changed')
    }
    return withOpenCodeOwnedOAuthRefresh({
      ...authority, env: authority.snapshot.runtimeEnv,
      providerId: authority.scope.providerId,
      predecessor,
      assertOwnership,
      assertPublicationOwnership,
      expectedOperationId: rotation?.operationId,
      operation: (armSession, armProbe) => input.operation(async native => {
        if (rotation && (!sessionRecord || !sameOpenCodeOAuthSessionAuthority(native.record, sessionRecord)
          || native.baseUrl !== rotation.nativeSession.baseUrl || native.pid !== rotation.nativeSession.pid
          || native.processStartedAtMs !== rotation.nativeSession.processStartedAtMs)) {
          throw new Error('OpenCode OAuth continuation native owner changed')
        }
        const { OpenCodeSessionStore } = await import('./OpenCodeSessionStore.js')
        const records = await new OpenCodeSessionStore(path.join(authority.snapshot.managedPaths.data,
          'opencode', 'session-store.json')).list()
        const candidates = rotation
          ? rotation.nativeSession.sessionAuthorities! : records
        const sessionAuthorities: OpenCodeSessionRecord[] = []
        for (const record of records) {
          if (record.hostKey !== native.record.hostKey || record.runtimePid !== native.pid
            || record.profileRootKey !== native.record.profileRootKey
            || !isDeepStrictEqual(record.profileScope, native.record.profileScope)
            || record.stoppedAt || record.staleReason
            || !candidates.some(candidate => sameOpenCodeOAuthSessionAuthority(candidate, record))) continue
          await this.assertSessionRefreshOwner(record, native, authority.snapshot.managedPaths.data)
          sessionAuthorities.push(record)
        }
        if (!sessionAuthorities.some(record => sameOpenCodeOAuthSessionAuthority(record, native.record))) {
          if (rotation) throw new Error('OpenCode OAuth native admission session authority changed')
          // Legacy/injected owners retain their existing single-session receipt;
          // absence of persisted cohort evidence never authorizes peer reuse.
          const singleSession = { ...native }
          delete singleSession.sessionAuthorities
          await armSession(singleSession)
          return
        }
        await armSession({ ...native, sessionAuthorities })
      }, armProbe),
      isNativeSettled: input.isNativeSettled,
      isNativeDefinitelyUnsubmitted: input.isNativeDefinitelyUnsubmitted,
      allowNativeContinuation: input.allowNativeContinuation,
      recoveryOwner: authority.scope.purpose === 'catalog' ? undefined : {
        projectPath: authority.snapshot.projectPath, purpose: authority.scope.purpose,
        scopeToken: authority.scope.scopeToken, credentialBinding,
        ...(rotation ? { launchCredential: rotation.predecessor } : {}),
      },
      abortSignal: input.abortSignal,
    })
  }

  async readCatalogSelectedAuthIdentity(input: {
    projectPath?: string | null
    profileScope: OpenCodeProfileScope
  }): Promise<{
    source: OpenCodeIdentityComponent
    managed: OpenCodeIdentityComponent
    preferences: OpenCodeIdentityComponent
  }> {
    const projectPath = await canonicalizeOpenCodeProjectPath(input.projectPath)
    const policy = planOpenCodeProfilePolicy(input.profileScope)
    const snapshot = openCodeEffectiveConfigSnapshots.get(policy.scope.scopeToken)
    const managedPaths = snapshot?.managedPaths ?? this.paths
    const runtimeEnv = snapshot?.runtimeEnv ?? process.env
    const snapshotHome = runtimeEnv.HOME?.trim() || runtimeEnv.USERPROFILE?.trim() || os.homedir()
    const profileRootKey = buildScopedProfileRootKey(projectPath, policy.scope)
    const managedAuthPath = path.join(
      managedPaths.data,
      'opencode',
      'profiles',
      profileRootKey,
      'data',
      'opencode',
      'auth.json',
    )
    const sourcePaths = Array.from(new Set([
      this.getGlobalAuthPath(managedPaths.data),
      ...this.getSourceAuthPaths(runtimeEnv, snapshotHome),
    ]))
    const [source, managed, preferences] = await Promise.all([
      readSelectedAuthFromSources({
        providerId: policy.scope.providerId, env: runtimeEnv, admissionProjectPath: projectPath,
        sourcePaths,
        globalAuthPath: this.getGlobalAuthPath(managedPaths.data),
      }),
      readSelectedManagedAuthIdentity(managedAuthPath, policy.scope.providerId),
      Promise.all([
        readOpenCodeManagedRuntimePreferences(path.dirname(path.dirname(path.dirname(managedAuthPath)))),
        readOpenCodeGlobalManagedRuntimePreferences(managedPaths.data),
      ]).then(value => `known:${hashString(JSON.stringify(value))}` as const).catch(() => 'error' as const),
    ])
    return { source: source.identity, managed, preferences }
  }

  private getProfileRootKey(projectPath: string): string {
    return hashString(projectPath).slice(0, 16)
  }

  private async resolveManagedAppMcpConfig(
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<OpenCodeMcpServerConfig | null> {
    try {
      return (await resolveOpenCodeAppMcpLaunchConfig({ env })).config
    } catch {
      return null
    }
  }

  private async withProfilePreparationLock<T>(
    profileRootKey: string,
    operation: () => Promise<T>,
    abortSignal?: AbortSignal,
  ): Promise<T> {
    const previous = OpenCodeProfileManager.profilePreparationLocks.get(profileRootKey)
    let release!: () => void
    const current = new Promise<void>(resolve => {
      release = resolve
    })
    OpenCodeProfileManager.profilePreparationLocks.set(profileRootKey, current)

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
          if (OpenCodeProfileManager.profilePreparationLocks.get(profileRootKey) === current) {
            OpenCodeProfileManager.profilePreparationLocks.delete(profileRootKey)
          }
        })
      }
      throw error
    } finally {
      if (!releaseDeferredUntilPrevious) {
        release()
        if (OpenCodeProfileManager.profilePreparationLocks.get(profileRootKey) === current) {
          OpenCodeProfileManager.profilePreparationLocks.delete(profileRootKey)
        }
      }
    }
  }

  async prepareProfile(projectPath?: string | null, options: OpenCodePrepareProfileOptions = {}): Promise<OpenCodePreparedProfile> {
    return this.prepareProfileInternal(projectPath, options)
  }

  private async prepareProfileInternal(
    projectPath?: string | null,
    options: OpenCodePrepareProfileOptions = {},
    ownedSession?: OpenCodeSessionRecord,
  ): Promise<OpenCodePreparedProfile> {
    let leaveStep: (() => void) | undefined
    const enterStep = (label: string): void => {
      leaveStep?.()
      leaveStep = options.progress?.enterStep(`prepare managed OpenCode profile: ${label}`)
    }
    enterStep('resolve project and scope')
    try {
    // Cursor executes its own shell tool, so OpenCode's permission rules never
    // see the call and manual approval cannot be honoured. Measured: with
    // approval set to manual the command still ran and no request was raised.
    // Refusing is the honest answer; silently running everything is not.
    if (options.toolApprovalMode === 'manual'
      && options.profileScope
      && canonicalizeOpenCodeProviderId(options.profileScope.providerId) === 'cursor-acp') {
      throw new Error(
        'Cursor runs its own tools, so manual tool approval cannot be enforced for it. '
        + 'Choose automatic approval for this team, or a different provider.',
      )
    }
    const configSnapshot = options.profileScope
      ? openCodeEffectiveConfigSnapshots.get(options.profileScope.scopeToken)
      : undefined
    if (options.profileScope && !configSnapshot) {
      throw new Error('OpenCode scoped profile preparation requires an exact resolver-issued snapshot')
    }
    if (
      options.profileScope
      && JSON.stringify(configSnapshot?.scopeIdentity)
        !== JSON.stringify(buildScopeIdentity(planOpenCodeProfilePolicy(options.profileScope).scope))
    ) {
      throw new Error('OpenCode scoped profile preparation token does not match its snapshot')
    }
    const currentProjectPath = await canonicalizeOpenCodeProjectPath(projectPath)
    if (configSnapshot && currentProjectPath !== configSnapshot.projectPath) {
      throw new Error('OpenCode scoped profile canonical project path changed')
    }
    const resolvedProjectPath = configSnapshot?.projectPath ?? currentProjectPath
    const managedPaths = configSnapshot?.managedPaths ?? this.paths
    let runtimeEnv = configSnapshot?.runtimeEnv ?? process.env
    const snapshotHome = runtimeEnv.HOME?.trim() || runtimeEnv.USERPROFILE?.trim() || os.homedir()
    // Verified staging is the only switch that turns on the managed Cursor path.
    // Anything unavailable keeps the upstream plugin and today's launch behaviour.
    const wantsCursorManagedAssets = options.profileScope
      ? canonicalizeOpenCodeProviderId(options.profileScope.providerId) === 'cursor-acp'
      : options.includeManagedSubscriptionPlugins !== false
    // Generic inventory may run without Cursor installed. Only an explicitly
    // selected Cursor scope may enter the strict managed path without its CLI.
    const cursorManagedAssets = wantsCursorManagedAssets
      && (options.profileScope || await resolveCursorAgentExecutable(runtimeEnv))
      ? await resolveManagedCursorAssets(runtimeEnv)
      : null
    if (cursorManagedAssets) {
      runtimeEnv = managedCursorNativeEnvironment(runtimeEnv, managedPaths.data, resolvedProjectPath)
      await mkdir(runtimeEnv.CURSOR_CONFIG_DIR!, { recursive: true, mode: 0o700 })
    }
    const policy = options.profileScope
      ? planOpenCodeProfilePolicy(options.profileScope, {
          cursorManagedPlugin: cursorManagedAssets?.pluginEntryPath ?? null,
        })
      : null
    const profileRootKey = policy
      ? buildScopedProfileRootKey(resolvedProjectPath, policy.scope)
      : this.getProfileRootKey(resolvedProjectPath)
    enterStep('wait for profile preparation lock')
    return await this.withProfilePreparationLock(profileRootKey, async () => {
    if (options.abortSignal?.aborted) throwOpenCodeAbortReason(options.abortSignal)
    enterStep('fingerprint project behavior')
    const profileRootPath = path.join(
      managedPaths.data,
      'opencode',
      'profiles',
      profileRootKey,
    )
    const { projectBehaviorFingerprint, behaviorSources } =
      await collectProjectBehaviorMetadata(
        resolvedProjectPath,
        configSnapshot?.runtimeEnv ?? process.env,
      )
    enterStep('read preferences and build config')
    const managedRuntimePreferences = await readOpenCodeManagedRuntimePreferences(profileRootPath)
    const globalRuntimePreferences = await readOpenCodeGlobalManagedRuntimePreferences(
      managedPaths.data,
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
    const importedRuntimeConfig = configSnapshot
      ? deepMergeOpenCodeConfig({}, configSnapshot.importedRuntimeConfig as Record<string, unknown>)
      : await readSafeOpenCodeRuntimeConfigImport(process.env)
    if (policy && !configSnapshot) {
      Object.assign(importedRuntimeConfig, deepMergeOpenCodeConfig(
        importedRuntimeConfig,
        await readProjectOpenCodeRuntimeConfig(resolvedProjectPath),
      ))
    }
    if (!policy) {
      // Keep the legacy inline overlay unchanged. Scoped profiles preserve user
      // plugin entries before adding only the selected provider's managed plugin.
      delete importedRuntimeConfig.plugin
    }
    const importedConfigDefaultModelId =
      typeof importedRuntimeConfig.model === 'string'
        ? importedRuntimeConfig.model.trim() || null
        : null
    const appMcpConfig = policy
      ? (policy.includeAppMcp ? configSnapshot!.appMcpLaunchConfig?.config ?? null : null)
      : options.includeAppMcp === false
        ? null
        : await this.resolveManagedAppMcpConfig(runtimeEnv)
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
        allowAutoUpdate: isOpenCodeAutoUpdateAllowed(configSnapshot?.runtimeEnv ?? process.env),
        defaultModelId: effectiveManagedDefaultModelId,
        managedProviderId: policy?.scope.providerId,
        toolApprovalMode: options.toolApprovalMode,
      }),
    )
    applyOpenCodeModelLimitOverrides(managedConfig, effectiveModelOutputLimitOverrides)
    const managedSubscriptionPlugins = policy?.managedSubscriptionPlugins
      ?? (options.includeManagedSubscriptionPlugins === false
        ? []
        : substituteCursorManagedPlugin(
          getOpenCodeManagedSubscriptionPluginPackages(),
          cursorManagedAssets,
        ))
    if (policy || managedSubscriptionPlugins.length > 0) {
      applyOpenCodeManagedSubscriptionPlugins(managedConfig, [...managedSubscriptionPlugins])
    }
    if (policy?.scope.purpose === 'catalog' || policy?.scope.purpose === 'launch_runtime') {
      enforceScopedProviderIsolation(
        managedConfig,
        policy.scope.providerId,
        managedSubscriptionPlugins,
      )
    }
    // Retained per profile so the managed config fingerprint stays stable across
    // preparations and an existing host keeps serving the same endpoint.
    const cursorNative = cursorManagedAssets
      ? await resolveCurrentCursorNativeAuthority(runtimeEnv, options.abortSignal) : null
    const strictCursor = policy && isStrictAuthorityPurpose(policy.scope.purpose)
      && canonicalizeOpenCodeProviderId(policy.scope.providerId) === 'cursor-acp'
    if (strictCursor && (!cursorManagedAssets || !cursorNative
      || await managedCursorAssetsIdentity(cursorManagedAssets) !== configSnapshot?.cursorAssetsIdentity
      || cursorNative.identity !== policy.scope.selectedAuthIdentity)) {
      throw new Error('OpenCode strict Cursor native authority changed before preparation')
    }
    applyManagedPathEnvironmentToMcpConfig(managedConfig, {
      [CLAUDE_MULTIMODEL_DATA_HOME_ENV]: managedPaths.data,
      [CLAUDE_MULTIMODEL_CACHE_HOME_ENV]: managedPaths.cache,
    })
    // A retained endpoint belongs to the stable host generation, excluding port.
    // Old live hosts keep their own state when account/config/assets change.
    const cursorHostBinaryPath = cursorManagedAssets ? resolveOpenCodeBinaryPath() : null
    const cursorHostBinaryIdentity = cursorManagedAssets
      ? cursorHostBinaryPath ? await resolveOpenCodeBinaryHostIdentity(cursorHostBinaryPath) : 'missing-binary'
      : null
    const cursorGeneration = cursorManagedAssets ? buildCursorHostGeneration({
      assetsIdentity: await managedCursorAssetsIdentity(cursorManagedAssets),
      nativeIdentity: cursorNative?.identity ?? 'absent',
      scopeToken: policy?.scope.scopeToken ?? profileRootKey,
      configFingerprint: buildManagedConfigFingerprint(managedConfig, runtimeEnv),
      projectPath: resolvedProjectPath, profileRootKey, projectBehaviorFingerprint,
      binaryHostIdentity: cursorHostBinaryIdentity!,
      transportIdentity: buildOpenCodeHostTransportIdentity(managedConfig),
    }) : null
    const cursorManagedStatePath = cursorGeneration
      ? path.join(profileRootPath, 'cursor-managed', cursorGeneration) : null
    const cursorManagedProxyPort = cursorManagedStatePath
      ? await reserveCursorManagedProxyPort(path.join(cursorManagedStatePath, 'proxy-port.json'))
      : null
    if (cursorManagedProxyPort) {
      applyCursorManagedProxyEndpoint(managedConfig, cursorManagedProxyPort)
    }
    const managedConfigFingerprint = buildManagedConfigFingerprint(
      managedConfig,
      configSnapshot?.runtimeEnv ?? process.env,
    )
    const homePath = path.join(profileRootPath, 'home')
    const tmpPath = path.join(profileRootPath, 'tmp')
    const xdgConfigHome = path.join(profileRootPath, 'config')
    const xdgDataHome = path.join(profileRootPath, 'data')
    const xdgCacheHome = path.join(managedPaths.cache, 'opencode', 'shared-cache')
    const sharedNpmCachePath = path.join(xdgCacheHome, 'npm')
    const sharedToolCachePath = path.join(xdgCacheHome, 'tools')
    const sharedOpenCodeNodeModulesPath = path.join(xdgCacheHome, 'config-node_modules')
    const profileOpenCodeNodeModulesPath = path.join(xdgConfigHome, 'opencode', 'node_modules')
    const workingDirectoryPath = policy?.scope.purpose === 'catalog'
      ? path.join(profileRootPath, 'catalog-workspace')
      : resolvedProjectPath
    const managedAuthPath = path.join(xdgDataHome, 'opencode', 'auth.json')
    const globalAuthPath = this.getGlobalAuthPath(managedPaths.data)
    enterStep('fingerprint auth sources')
    const sourceAuthSources = await Promise.all(
      this.getSourceAuthPaths(runtimeEnv, snapshotHome).map(async sourceAuthPath => {
        const exists = await fileExists(sourceAuthPath)
        return {
          path: sourceAuthPath,
          fingerprint: exists ? await readFingerprint(sourceAuthPath) : null,
        }
      }),
    )
    if (options.abortSignal?.aborted) throwOpenCodeAbortReason(options.abortSignal)

    enterStep('create profile directories')
    await Promise.all([
      ensureOpenCodeDirectory(homePath),
      ensureOpenCodeDirectory(tmpPath),
      ensureOpenCodeDirectory(xdgConfigHome),
      ensureOpenCodeDirectory(path.join(xdgDataHome, 'opencode')),
      ensureOpenCodeDirectory(xdgCacheHome),
      ensureOpenCodeDirectory(sharedNpmCachePath),
      ensureOpenCodeDirectory(sharedToolCachePath),
      ensureOpenCodeDirectory(workingDirectoryPath),
    ])
    let nativeCliCredentialBridge: OpenCodeNativeCliCredentialBridge | null = null
    if (managedSubscriptionPlugins.length > 0 && policy?.reconcileAuth !== false) {
      enterStep('repair plugin caches and native bridge')
      await repairEmptyOpenCodeManagedPluginCaches(xdgCacheHome)
      // The plugin's MCP bridge reads servers from a config file, not from
      // OPENCODE_CONFIG_CONTENT. Without this file it discovers nothing and the
      // agent has no Agent Teams tools at all.
      const managedConfigPath = cursorManagedAssets
        ? path.join(xdgConfigHome, 'opencode', 'opencode.json')
        : null
      if (managedConfigPath) {
        // Only the sections the bridge actually reads. OpenCode merges this file
        // with OPENCODE_CONFIG_CONTENT, and `plugin` is an array, so writing the
        // whole config appended the plugin a second time and the launch readiness
        // authority rejected the host on selected_config_match:plugin. Objects
        // merge by key and stay identical; arrays do not.
        const bridgeConfig = Object.fromEntries(
          (['mcp', 'agent'] as const)
            .filter(section => managedConfig[section] && !Array.isArray(managedConfig[section]))
            .map(section => [section, managedConfig[section]]),
        )
        await mkdir(path.dirname(managedConfigPath), { recursive: true })
        await writeFile(
          managedConfigPath,
          `${JSON.stringify(bridgeConfig, null, 2)}\n`,
          { encoding: 'utf8', mode: 0o600 },
        )
      }
      nativeCliCredentialBridge = await ensureOpenCodeNativeCliCredentialBridge(
        cursorManagedStatePath ?? profileRootPath,
        { ...runtimeEnv, ...(cursorNative ? { CURSOR_AGENT_EXECUTABLE: cursorNative.executablePath } : {}) },
        process.platform,
        cursorManagedAssets,
        managedConfigPath,
      )
    }
    enterStep('coordinate shared node_modules')
    await ensureDirectorySymlink(profileOpenCodeNodeModulesPath, sharedOpenCodeNodeModulesPath, {
      abortSignal: options.abortSignal,
      enterStep,
    })
    if (options.abortSignal?.aborted) throwOpenCodeAbortReason(options.abortSignal)

    enterStep('reconcile managed auth stores')
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
    let selectedSourceAuthIdentity: OpenCodeIdentityComponent | undefined
    if (policy) {
      selectedSourceAuthIdentity = configSnapshot!.scopeIdentity.selectedAuthIdentity
      const continuation = ownedSession ? await this.readCompletedSessionOAuthRotation(ownedSession, runtimeEnv) : null
      if (ownedSession && (!continuation || ownedSession.profileRootKey !== profileRootKey
        || !isDeepStrictEqual(ownedSession.profileScope, policy.scope)
        || !isDeepStrictEqual(configSnapshot!.selectedAuthCredential, continuation.predecessor))) {
        throw new Error('OpenCode OAuth continuation publication changed')
      }
      if (!continuation) await materializeOpenCodeSelectedAuthCredential({
        abortSignal: options.abortSignal,
        authPath: managedAuthPath,
        providerId: policy.scope.providerId,
        credential: configSnapshot!.selectedAuthCredential,
      })
    } else {
      await reconcileOpenCodeManagedAuthStores({
        sourceAuthPaths: authSourcePaths,
        globalAuthPath,
        managedAuthPath,
        peerManagedAuthPaths: await this.listManagedAuthPaths(managedPaths.data),
        abortSignal: options.abortSignal,
      })
    }
    // A stale readiness answer must not survive a Cursor account switch or a
    // replaced binary, which the auth marker's TTL alone cannot notice.
    let cursorReadinessFingerprint: string | null = null
    if (nativeCliCredentialBridge && cursorManagedStatePath && cursorManagedProxyPort) {
      enterStep('bind native Cursor authority')
      const authority = await reconcileCursorNativeAuthority({
        statePath: path.join(cursorManagedStatePath, 'native-authority.json'),
        executablePath: nativeCliCredentialBridge.cursorAgentHostCommand,
        env: runtimeEnv,
        dedupeMs: 0,
        abortSignal: options.abortSignal,
      }).catch(() => ({ authority: null, state: 'signed-out' as const }))
      if (strictCursor && (!authority.authority
        || cursorNativeSelectedIdentity(authority.authority) !== policy!.scope.selectedAuthIdentity)) {
        throw new Error('OpenCode strict Cursor native authority changed during preparation')
      }
      if (authority.authority && cursorManagedAssets) {
        cursorReadinessFingerprint = buildCursorReadinessFingerprint({
          authority: authority.authority,
          assetsFingerprint: cursorManagedAssets.fingerprint,
          profileScopeToken: policy?.scope.scopeToken ?? profileRootKey,
          managedConfigFingerprint,
          proxyPort: cursorManagedProxyPort,
        })
      }
    }
    if (nativeCliCredentialBridge) {
      enterStep('probe native provider credentials')
      await ensureOpenCodeNativePluginAuthCredentials({
        selectedProviderId: policy?.scope.providerId,
        prepareCursor: () => ensureOpenCodeCursorPluginAuthCredential({
          abortSignal: options.abortSignal,
          globalAuthPath,
          managedAuthPath,
          cursorAgentExecutablePath: nativeCliCredentialBridge.cursorAgentExecutablePath,
          env: runtimeEnv,
        }),
        prepareKiro: () => ensureOpenCodeKiroPluginAuthCredential({
          abortSignal: options.abortSignal,
          globalAuthPath,
          managedAuthPath,
          kiroCliExecutablePath: nativeCliCredentialBridge.kiroCliExecutablePath,
        }),
      })
    }
    if (options.abortSignal?.aborted) throwOpenCodeAbortReason(options.abortSignal)

    enterStep('verify auth and finalize environment')
    const managedAuthFingerprint = await readFingerprint(managedAuthPath)
    const finalCursorNative = strictCursor
      ? await resolveCurrentCursorNativeAuthority(runtimeEnv, options.abortSignal) : null
    if (strictCursor && (!finalCursorNative || finalCursorNative.identity !== selectedSourceAuthIdentity)) {
      throw new Error('OpenCode strict Cursor native authority changed at finalization')
    }
    const selectedManagedAuthIdentity = policy
      ? strictCursor ? finalCursorNative!.identity
        : await readSelectedManagedAuthIdentity(managedAuthPath, policy.scope.providerId)
      : undefined
    const authState = await (async () => {
      if (policy) {
        return selectedSourceAuthIdentity === selectedManagedAuthIdentity ? 'ok' as const : 'stale' as const
      }
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
      ...runtimeEnv,
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
      [CLAUDE_MULTIMODEL_DATA_HOME_ENV]: managedPaths.data,
      [CLAUDE_MULTIMODEL_CACHE_HOME_ENV]: managedPaths.cache,
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify(managedConfig),
      ...(configSnapshot ? {
        [OPEN_CODE_SCOPE_CONFIG_CONTENT_ENV]: JSON.stringify(configSnapshot.importedRuntimeConfig),
        [OPEN_CODE_SCOPE_APP_MCP_LAUNCH_CONFIG_ENV]: JSON.stringify(
          configSnapshot.appMcpLaunchConfig,
        ),
        [OPEN_CODE_SCOPE_ENVIRONMENT_ENV]: JSON.stringify(Object.fromEntries(
          OPEN_CODE_PROFILE_RUNTIME_OVERRIDE_KEYS.map(key => [key, runtimeEnv[key] ?? null]),
        )),
      } : {}),
    }
    delete env.AGENT_TEAMS_CURSOR_HOST_BINARY_IDENTITY
    if (cursorHostBinaryIdentity) env.AGENT_TEAMS_CURSOR_HOST_BINARY_IDENTITY = cursorHostBinaryIdentity
    delete env.AGENT_TEAMS_CURSOR_READINESS
    delete env[CURSOR_MANAGED_PROXY_PORT_ENV]
    if (cursorManagedAssets) applyCursorManagedExecutionEnvironment(env)
    if (nativeCliCredentialBridge) {
      env.PATH = [nativeCliCredentialBridge.binPath, runtimeEnv.PATH]
        .filter((value): value is string => Boolean(value))
        .join(path.delimiter)
      env.CURSOR_ACP_HOME_DIR =
        runtimeEnv.CURSOR_ACP_HOME_DIR?.trim() || nativeCliCredentialBridge.hostHomePath
      env.CURSOR_AGENT_EXECUTABLE =
        nativeCliCredentialBridge.cursorAgentExecutablePath
    }
    if (cursorManagedProxyPort) {
      env[CURSOR_MANAGED_PROXY_PORT_ENV] = String(cursorManagedProxyPort)
      if (cursorReadinessFingerprint) {
        env.AGENT_TEAMS_CURSOR_READINESS = cursorReadinessFingerprint
      }
    }
    delete env.OPENCODE_CONFIG
    if (options.abortSignal?.aborted) throwOpenCodeAbortReason(options.abortSignal)

    return {
      projectPath: resolvedProjectPath,
      canonicalProjectPath: resolvedProjectPath,
      workingDirectoryPath,
      scopeToken: policy?.scope.scopeToken ?? null,
      profileRootKey,
      profileRootPath,
      profileScope: policy?.scope ?? null,
      appMcpLaunchSource: configSnapshot?.appMcpLaunchConfig?.source ?? null,
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
      selectedSourceAuthIdentity,
      selectedManagedAuthIdentity,
      authoritySourceFingerprint: configSnapshot?.authoritySourceFingerprint ?? null,
      authState,
      env: applyOpenCodeAutoUpdatePolicy(env),
    }
    }, options.abortSignal)
    } finally {
      leaveStep?.()
    }
  }
}

export const openCodeProfileManager = new OpenCodeProfileManager()
