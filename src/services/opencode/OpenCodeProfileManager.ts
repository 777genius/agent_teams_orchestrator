import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, type Dirent } from 'node:fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readlink,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
  realpath,
  type FileHandle,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { getCwd } from '../../utils/cwd.js'
import { safeParseJSONC } from '../../utils/json.js'
import * as lockfile from '../../utils/lockfile.js'
import {
  applyOpenCodeAutoUpdatePolicy,
  isOpenCodeAutoUpdateAllowed,
} from './OpenCodeAutoUpdatePolicy.js'
import {
  OPEN_CODE_APP_MCP_SERVER_NAME,
  resolveOpenCodeAppMcpLaunchConfig,
} from './OpenCodeMcpManager.js'
import {
  getOpenCodeCuratedSubscriptionProviderConfigs,
  getOpenCodeManagedSubscriptionPluginPackages,
} from './OpenCodeCuratedSubscriptionCatalog.js'
import {
  OpenCodeSafePublicationDirectory,
  withOpenCodeSafePublicationDirectory,
} from './OpenCodeSafePublication.js'
import {
  doesOpenCodeAuthStoreIncludeSource,
  fanOutOpenCodeOAuthCredential,
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
  resolveClaudeMultimodelPaths,
} from './OpenCodeManagedPaths.js'
import {
  raceOpenCodeAbortSignal,
  throwOpenCodeAbortReason,
} from './OpenCodeRuntimeDeadline.js'
import { resolveOpenCodeBinaryPath } from './OpenCodeBinaryResolver.js'
import {
  canonicalSerializeOpenCodePolicyIdentity,
  planScopedProfile,
  resolveOpenCodeOperationPolicy,
  type OpenCodePreservedPlugin,
} from './OpenCodeOperationPolicy.js'

export { planScopedProfile } from './OpenCodeOperationPolicy.js'
import { canonicalizeOpenCodeProviderId } from './OpenCodeProviderIdentity.js'
import {
  buildCursorAgentResourceExhaustedPreloadScript,
  CURSOR_RESOURCE_EXHAUSTED_PATCH_DISABLED_ENV,
} from './OpenCodeCursorResourceExhaustedPatch.js'
import type {
  OpenCodeMcpServerConfig,
  OpenCodePrepareProfileOptions,
  OpenCodePreparedProfile,
  OpenCodeScopedPreparedProfile,
  OpenCodePlanScopedProfileInput,
  OpenCodeScopedProfilePlanContract,
  OpenCodeToolApprovalMode,
} from './types.js'

export const OPEN_CODE_TEAMMATE_AGENT_NAME = 'teammate'
export const OPEN_CODE_TEAMMATE_BOOTSTRAP_AGENT_NAME = 'teammate-bootstrap'
export const OPEN_CODE_MODEL_PROBE_AGENT_NAME = 'teammate-model-probe'
export const OPEN_CODE_SCOPED_PROFILE_LAYOUT_GENERATION = '1'

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

/** Pure ownership rule shared by runtime validation and non-root fixtures. */
export function isOpenCodeManagedPathComponentOwnershipValid(
  componentPath: string,
  ownershipBoundaryPath: string,
  metadata: { uid: number; mode: number },
  currentUid: number,
): boolean {
  const component = path.resolve(componentPath)
  const boundary = path.resolve(ownershipBoundaryPath)
  const relative = path.relative(boundary, component)
  const insideBoundary = relative === ''
    || (relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative))
  return !insideBoundary
    || (metadata.uid === currentUid && (metadata.mode & 0o022) === 0)
}

async function assertCanonicalOwnedPathComponents(
  targetPath: string,
  ownershipBoundaryPath: string,
): Promise<void> {
  const resolved = path.resolve(targetPath)
  const ownershipBoundary = path.resolve(ownershipBoundaryPath)
  const relative = path.relative(ownershipBoundary, resolved)
  if (relative !== '' && (
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  )) {
    throw new Error('OpenCode scoped managed ownership boundary is invalid [redacted]')
  }
  const parsed = path.parse(resolved)
  const relativeParts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)
  let current = parsed.root
  for (const part of relativeParts) {
    current = path.join(current, part)
    const metadata = await lstat(current).catch(error => {
      if (getErrnoCode(error) === 'ENOENT') return null
      throw error
    })
    if (!metadata) break
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('OpenCode scoped managed path ancestry is not canonical [redacted]')
    }
    if (typeof process.getuid === 'function') {
      if (!isOpenCodeManagedPathComponentOwnershipValid(
        current,
        ownershipBoundary,
        metadata,
        process.getuid(),
      )) {
        throw new Error('OpenCode scoped managed path ancestry is not safely app-owned [redacted]')
      }
    }
  }
}

async function ensureWindowsManagedDirectoryPath(
  resolved: string,
  ownershipBoundary: string,
  afterComponentOpened?: (componentPath: string) => void | Promise<void>,
): Promise<void> {
  const parsed = path.parse(resolved)
  const relativeParts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)

  const inspectThrough = async (target: string): Promise<void> => {
    const targetParts = target.slice(parsed.root.length).split(path.sep).filter(Boolean)
    let current = parsed.root
    for (const part of targetParts) {
      current = path.join(current, part)
      const metadata = await lstat(current).catch(error => {
        if (getErrnoCode(error) === 'ENOENT') return null
        throw error
      })
      if (!metadata) {
        throw new Error('OpenCode scoped managed path ancestry changed during creation [redacted]')
      }
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error('OpenCode scoped managed path ancestry is not canonical [redacted]')
      }
      if (typeof process.getuid === 'function' && !isOpenCodeManagedPathComponentOwnershipValid(
        current,
        ownershipBoundary,
        metadata,
        process.getuid(),
      )) {
        throw new Error('OpenCode scoped managed path ancestry is not safely app-owned [redacted]')
      }
    }
  }

  const walk = async (createMissing: boolean, notify: boolean): Promise<bigint[]> => {
    const identities: bigint[] = []
    let current = parsed.root
    for (const part of relativeParts) {
      const parent = current
      current = path.join(parent, part)
      await inspectThrough(parent)
      let metadata = await lstat(current, { bigint: true }).catch(error => {
        if (getErrnoCode(error) === 'ENOENT') return null
        throw error
      })
      if (!metadata) {
        if (!createMissing) {
          throw new Error('OpenCode scoped managed path ancestry changed during creation [redacted]')
        }
        try {
          await mkdir(current, { mode: 0o700 })
        } catch (error) {
          if (getErrnoCode(error) !== 'EEXIST') throw error
        }
        metadata = await lstat(current, { bigint: true }).catch(error => {
          throw new Error('OpenCode scoped managed path ancestry changed during creation [redacted]', {
            cause: error,
          })
        })
      }
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error('OpenCode scoped managed path ancestry is not canonical [redacted]')
      }
      if (notify) await afterComponentOpened?.(current)
      identities.push(metadata.dev, metadata.ino)
    }
    return identities
  }

  const createdIdentities = await walk(true, true)
  const reachableIdentities = await walk(false, false)
  if (createdIdentities.length !== reachableIdentities.length
    || createdIdentities.some((identity, index) => identity !== reachableIdentities[index])) {
    throw new Error('OpenCode scoped managed path ancestry changed during creation [redacted]')
  }
}

/**
 * Creates a managed directory one component at a time relative to a held
 * no-follow directory descriptor. The optional callback is a deterministic
 * adversarial-test seam; production callers omit it.
 */
export async function ensureOpenCodeManagedDirectoryPath(
  targetPath: string,
  ownershipBoundaryPath: string,
  afterComponentOpened?: (componentPath: string) => void | Promise<void>,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const resolved = path.resolve(targetPath)
  const ownershipBoundary = path.resolve(ownershipBoundaryPath)
  const relative = path.relative(ownershipBoundary, resolved)
  if (relative !== '' && (
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  )) {
    throw new Error('OpenCode scoped managed ownership boundary is invalid [redacted]')
  }
  if (platform === 'win32') {
    // Node does not expose mkdirat/openat on Windows. Walk one component at a
    // time without recursive mkdir, reject reparse-point ancestry, and verify
    // that every component retains the same file identity across a second walk.
    await ensureWindowsManagedDirectoryPath(resolved, ownershipBoundary, afterComponentOpened)
    return
  }

  const descriptorRoot = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'
  const parsed = path.parse(resolved)
  const relativeParts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)
  const openDirectory = (directoryPath: string): Promise<FileHandle> => open(
    directoryPath,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0),
  )
  const walk = async (createMissing: boolean, notify: boolean): Promise<bigint[]> => {
    let parent = await openDirectory(parsed.root)
    try {
      let logicalPath = parsed.root
      for (const part of relativeParts) {
        logicalPath = path.join(logicalPath, part)
        const descriptorChild = path.join(descriptorRoot, String(parent.fd), part)
        let child: FileHandle | null = null
        try {
          child = await openDirectory(descriptorChild)
        } catch (error) {
          if (!createMissing || getErrnoCode(error) !== 'ENOENT') {
            throw new Error('OpenCode scoped managed path ancestry is not canonical [redacted]', {
              cause: error,
            })
          }
          try {
            await mkdir(descriptorChild, { mode: 0o700 })
          } catch (mkdirError) {
            if (getErrnoCode(mkdirError) !== 'EEXIST') throw mkdirError
          }
          child = await openDirectory(descriptorChild).catch(error => {
            throw new Error('OpenCode scoped managed path ancestry changed during creation [redacted]', {
              cause: error,
            })
          })
        }
        try {
          const metadata = await child.stat({ bigint: true })
          if (!metadata.isDirectory() || (
            typeof process.getuid === 'function'
            && !isOpenCodeManagedPathComponentOwnershipValid(
              logicalPath,
              ownershipBoundary,
              { uid: Number(metadata.uid), mode: Number(metadata.mode) },
              process.getuid(),
            )
          )) {
            throw new Error('OpenCode scoped managed path ancestry is not safely app-owned [redacted]')
          }
          if (notify) await afterComponentOpened?.(logicalPath)
          await parent.close()
          parent = child
          child = null
        } finally {
          await child?.close().catch(() => undefined)
        }
      }
      const metadata = await parent.stat({ bigint: true })
      return [metadata.dev, metadata.ino]
    } finally {
      await parent.close().catch(() => undefined)
    }
  }

  const createdIdentity = await walk(true, true)
  const reachableIdentity = await walk(false, false)
  if (createdIdentity[0] !== reachableIdentity[0] || createdIdentity[1] !== reachableIdentity[1]) {
    throw new Error('OpenCode scoped managed path ancestry changed during creation [redacted]')
  }
}

async function readRegularFileNoFollow(filePath: string): Promise<Buffer | null> {
  let handle: import('node:fs/promises').FileHandle
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return null
    throw error
  }
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error('OpenCode scoped managed file is not regular [redacted]')
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

const PROJECT_BEHAVIOR_FILES = [
  'opencode.json',
  'opencode.jsonc',
  'AGENTS.md',
  'CLAUDE.md',
  'CLAUDE.local.md',
  '.claude/CLAUDE.md',
  '.github/copilot-instructions.md',
  '.opencode/opencode.json',
  '.opencode/opencode.jsonc',
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
  '.claude/rules',
  '.cursor/rules',
] as const

async function collectBehaviorDirectoryEntries(
  rootPath: string,
  relativeDir: string,
  excludeRuntimeDirectories = true,
  includeMode = false,
): Promise<string[]> {
  const absoluteDir = path.join(rootPath, relativeDir)
  if (!(await fileExists(absoluteDir))) {
    return []
  }
  const rootMetadata = await lstat(absoluteDir)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`OpenCode behavior directory has unsupported type (symlinks are not allowed): ${relativeDir}`)
  }

  const entries: string[] = []
  const walk = async (currentDir: string): Promise<void> => {
    const currentMetadata = await lstat(currentDir)
    if (!currentMetadata.isDirectory() || currentMetadata.isSymbolicLink()) {
      throw new Error('OpenCode behavior directory changed during capture')
    }
    const dirents = await readdir(currentDir, { withFileTypes: true })
    dirents.sort((left, right) => left.name.localeCompare(right.name))

    for (const dirent of dirents) {
      if (dirent.name === '.DS_Store' || dirent.name === '.git'
        || (excludeRuntimeDirectories && dirent.name === 'node_modules')) {
        continue
      }

      const nextPath = path.join(currentDir, dirent.name)
      if (dirent.isDirectory()) {
        const directoryMetadata = await lstat(nextPath)
        if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
          throw new Error('OpenCode behavior directory changed during capture')
        }
        await walk(nextPath)
        continue
      }
      if (!dirent.isFile()) {
        throw new Error(
          `OpenCode behavior entry has unsupported type (symlinks are not allowed): ${path.relative(rootPath, nextPath)}`,
        )
      }

      const relativePath = path.relative(rootPath, nextPath)
      const handle = await open(nextPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      const [content, metadata] = await Promise.all([handle.readFile(), handle.stat()])
        .finally(() => handle.close())
      entries.push(includeMode
        ? `${relativePath}:${metadata.mode & 0o777}:${hashBuffer(content)}`
        : `${relativePath}:${hashBuffer(content)}`)
    }
  }

  await walk(absoluteDir)
  return entries
}

async function publishImmutableUserPluginSnapshot(
  sourcePath: string,
  targetPath: string,
  expectedEntries: readonly string[],
): Promise<void> {
  const publicationDirectory = await OpenCodeSafePublicationDirectory.open(path.dirname(targetPath))
  targetPath = publicationDirectory.child(path.basename(targetPath))
  try {
  const verifyTarget = async (): Promise<boolean> => {
    const metadata = await lstat(targetPath).catch(() => null)
    if (!metadata) return false
    if (metadata.isSymbolicLink()) {
      // Migrate the former app-managed link without touching its user-owned target.
      await rm(targetPath, { force: true })
      return false
    }
    if (!metadata.isDirectory()) {
      throw new Error('OpenCode managed user plugin snapshot has unsupported type')
    }
    const actual = await collectBehaviorDirectoryEntries(
      path.dirname(targetPath), path.basename(targetPath), false,
    )
    if (canonicalSerializeOpenCodePolicyIdentity(actual)
      !== canonicalSerializeOpenCodePolicyIdentity(expectedEntries)) {
      throw new Error('OpenCode managed user plugin snapshot fingerprint mismatch')
    }
    return true
  }
  if (await verifyTarget()) return

  const temporaryPath = `${targetPath}.snapshot-${process.pid}-${randomUUID()}`
  const copiedEntries: string[] = []
  const copyDirectory = async (sourceDirectory: string, targetDirectory: string): Promise<void> => {
    const sourceMetadata = await lstat(sourceDirectory)
    if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
      throw new Error('OpenCode user plugin directory changed during snapshot')
    }
    await mkdir(targetDirectory, { mode: 0o700 })
    const dirents = await readdir(sourceDirectory, { withFileTypes: true })
    dirents.sort((left, right) => left.name.localeCompare(right.name))
    for (const dirent of dirents) {
      if (dirent.name === '.DS_Store' || dirent.name === '.git' || dirent.name === 'node_modules') continue
      const sourceEntry = path.join(sourceDirectory, dirent.name)
      const targetEntry = path.join(targetDirectory, dirent.name)
      if (dirent.isDirectory()) {
        await copyDirectory(sourceEntry, targetEntry)
        continue
      }
      if (!dirent.isFile()) {
        throw new Error('OpenCode user plugin entry changed to an unsupported type during snapshot')
      }
      const sourceHandle = await open(sourceEntry, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      try {
        const metadata = await sourceHandle.stat()
        if (!metadata.isFile()) {
          throw new Error('OpenCode user plugin entry is not a regular file')
        }
        const bytes = await sourceHandle.readFile()
        const relativePath = path.relative(sourcePath, sourceEntry)
        copiedEntries.push(`${path.join('plugins', relativePath)}:${hashBuffer(bytes)}`)
        await writeFile(targetEntry, bytes, { flag: 'wx', mode: 0o400 })
      } finally {
        await sourceHandle.close()
      }
    }
    await chmod(targetDirectory, 0o500)
  }

  try {
    await copyDirectory(sourcePath, temporaryPath)
    if (canonicalSerializeOpenCodePolicyIdentity(copiedEntries)
      !== canonicalSerializeOpenCodePolicyIdentity(expectedEntries)) {
      throw new Error('OpenCode user plugin bytes changed during snapshot')
    }
    await rename(temporaryPath, targetPath).catch(async error => {
      if (getErrnoCode(error) !== 'EEXIST' || !(await verifyTarget())) throw error
    })
    await verifyTarget()
  } finally {
    await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined)
  }
  } finally {
    await publicationDirectory.close()
  }
}

async function publishImmutablePluginDependencySnapshot(
  targetPath: string,
  plugins: OpenCodePlanScopedProfileInput['evidence']['plugins'],
): Promise<void> {
  const publicationDirectory = await OpenCodeSafePublicationDirectory.open(path.dirname(targetPath))
  targetPath = publicationDirectory.child(path.basename(targetPath))
  try {
  const entries = new Map<string, { bytes: Buffer; mode: 0o400 | 0o500 }>()
  for (const plugin of plugins) {
    for (const entry of plugin.immutableTreeEntries) {
      const relativePath = entry.path.replaceAll('\\', '/')
      const bytes = Buffer.from(entry.bytesBase64, 'base64')
      const previous = entries.get(relativePath)
      if (previous && (
        previous.mode !== entry.mode || !previous.bytes.equals(bytes)
      )) throw new Error('OpenCode scoped plugin dependency snapshot collision')
      entries.set(relativePath, { bytes, mode: entry.mode })
    }
  }
  const verify = async (): Promise<boolean> => {
    const metadata = await lstat(targetPath).catch(() => null)
    if (!metadata) return false
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('OpenCode plugin dependency snapshot has unsupported type')
    }
    const actual = await collectBehaviorDirectoryEntries(
      path.dirname(targetPath), path.basename(targetPath), false, true,
    )
    const expected = Array.from(entries, ([relativePath, entry]) =>
      `${path.join(path.basename(targetPath), relativePath)}:${entry.mode}:${hashBuffer(entry.bytes)}`,
    ).sort()
    if (canonicalSerializeOpenCodePolicyIdentity(actual)
      !== canonicalSerializeOpenCodePolicyIdentity(expected)) {
      throw new Error('OpenCode plugin dependency snapshot fingerprint mismatch')
    }
    return true
  }
  if (await verify()) return
  const temporaryPath = `${targetPath}.dependencies-${process.pid}-${randomUUID()}`
  try {
    await mkdir(temporaryPath, { mode: 0o700 })
    for (const [relativePath, entry] of entries) {
      const destination = path.join(temporaryPath, relativePath)
      if (!destination.startsWith(`${temporaryPath}${path.sep}`)) {
        throw new Error('OpenCode plugin dependency snapshot path escaped its root')
      }
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
      await writeFile(destination, entry.bytes, { flag: 'wx', mode: entry.mode })
    }
    const freeze = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await freeze(path.join(directory, entry.name))
      }
      await chmod(directory, 0o500)
    }
    await freeze(temporaryPath)
    await rename(temporaryPath, targetPath).catch(async error => {
      if (getErrnoCode(error) !== 'EEXIST' || !(await verify())) throw error
    })
    await verify()
  } finally {
    await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined)
  }
  } finally {
    await publicationDirectory.close()
  }
}

type ProjectBehaviorFileIdentity = {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

type ProjectBehaviorDirectoryIdentity = {
  dev: bigint
  ino: bigint
}

type OpenCodeProjectBehaviorCapture = {
  projectBehaviorFingerprint: string
  behaviorSources: string[]
  behaviorEntryManifest: string[]
  resolvedProjectPath: string
  fdRoot: string
  rootHandle: FileHandle | null
  directories: Map<string, { handle: FileHandle; identity: ProjectBehaviorDirectoryIdentity }>
  directoryEntryManifests: Map<string, string[]>
  files: Map<string, { parentDirectory: string; name: string; identity: ProjectBehaviorFileIdentity }>
  close(): Promise<void>
}

function sameProjectBehaviorDirectoryIdentity(
  actual: { isDirectory(): boolean; dev: bigint; ino: bigint },
  expected: ProjectBehaviorDirectoryIdentity,
): boolean {
  return actual.isDirectory() && actual.dev === expected.dev && actual.ino === expected.ino
}

function sameProjectBehaviorFileIdentity(
  actual: {
    isFile(): boolean
    dev: bigint
    ino: bigint
    size: bigint
    mtimeNs: bigint
    ctimeNs: bigint
  },
  expected: ProjectBehaviorFileIdentity,
): boolean {
  return actual.isFile()
    && actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.size === expected.size
    && actual.mtimeNs === expected.mtimeNs
    && actual.ctimeNs === expected.ctimeNs
}

async function captureProjectBehaviorMetadata(
  projectPath: string,
): Promise<OpenCodeProjectBehaviorCapture> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error('OpenCode descriptor-relative project capture is unsupported [redacted]')
  }
  const fdRoot = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'
  const resolvedProjectPath = path.resolve(projectPath)
  const directories = new Map<
    string,
    { handle: FileHandle; identity: ProjectBehaviorDirectoryIdentity }
  >()
  const files = new Map<
    string,
    { parentDirectory: string; name: string; identity: ProjectBehaviorFileIdentity }
  >()
  const directoryEntryManifests = new Map<string, string[]>()
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await Promise.all(Array.from(directories.values(), ({ handle }) =>
      handle.close().catch(() => undefined)))
    directories.clear()
  }
  let rootHandle: FileHandle
  try {
    rootHandle = await open(
      resolvedProjectPath,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0),
    )
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') {
      return {
        projectBehaviorFingerprint: hashString(''),
        behaviorSources: [],
        behaviorEntryManifest: [],
        resolvedProjectPath,
        fdRoot,
        rootHandle: null,
        directories,
        directoryEntryManifests,
        files,
        close,
      }
    }
    throw error
  }
  const rootMetadata = await rootHandle.stat({ bigint: true })
  if (!rootMetadata.isDirectory()) {
    await rootHandle.close()
    throw new Error('OpenCode project behavior root is not a directory')
  }
  directories.set('', {
    handle: rootHandle,
    identity: { dev: rootMetadata.dev, ino: rootMetadata.ino },
  })
  const entries: string[] = []
  const behaviorSources = new Set<string>()
  const openDirectoryComponents = async (components: readonly string[]): Promise<FileHandle | null> => {
    let relativeDirectory = ''
    let current = rootHandle
    for (const component of components) {
      relativeDirectory = relativeDirectory
        ? path.join(relativeDirectory, component)
        : component
      const retained = directories.get(relativeDirectory)
      if (retained) {
        current = retained.handle
        continue
      }
      let next: FileHandle
      try {
        next = await open(
          path.join(fdRoot, String(current.fd), component),
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0),
        )
      } catch (error) {
        if (getErrnoCode(error) === 'ENOENT') return null
        throw new Error('OpenCode project behavior path contains a link or unsupported component')
      }
      const metadata = await next.stat({ bigint: true })
      if (!metadata.isDirectory()) {
        await next.close()
        throw new Error('OpenCode project behavior path contains a link or unsupported component')
      }
      directories.set(relativeDirectory, {
        handle: next,
        identity: { dev: metadata.dev, ino: metadata.ino },
      })
      current = next
    }
    return current
  }
  const captureFile = async (
    parent: FileHandle,
    parentDirectory: string,
    name: string,
    relativePath: string,
    allowMissing = false,
  ): Promise<boolean> => {
    let child: FileHandle
    try {
      child = await open(
        path.join(fdRoot, String(parent.fd), name),
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      )
    } catch (error) {
      if (allowMissing && getErrnoCode(error) === 'ENOENT') return false
      throw new Error('OpenCode project behavior path contains a link or unsupported component', {
        cause: error,
      })
    }
    try {
      const before = await child.stat({ bigint: true })
      if (!before.isFile()) throw new Error('OpenCode project behavior entry is not regular')
      const bytes = await child.readFile()
      const after = await child.stat({ bigint: true })
      const identity = {
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mtimeNs: before.mtimeNs,
        ctimeNs: before.ctimeNs,
      }
      if (!sameProjectBehaviorFileIdentity(after, identity)) {
        throw new Error('OpenCode project behavior entry changed during capture')
      }
      entries.push(`file:${relativePath}:${hashBuffer(bytes)}`)
      behaviorSources.add(relativePath)
      files.set(relativePath, { parentDirectory, name, identity })
      return true
    } finally {
      await child.close()
    }
  }
  const captureDirectory = async (directory: FileHandle, relativeDir: string): Promise<void> => {
    const dirents = await readdir(path.join(fdRoot, String(directory.fd)), { withFileTypes: true })
    dirents.sort((left, right) => left.name.localeCompare(right.name))
    const entryManifest: string[] = []
    entries.push(`directory:${relativeDir}`)
    for (const dirent of dirents) {
      if (dirent.name === '.DS_Store' || dirent.name === '.git' || dirent.name === 'node_modules') continue
      const relativePath = path.join(relativeDir, dirent.name)
      const childPath = path.join(fdRoot, String(directory.fd), dirent.name)
      if (dirent.isDirectory()) {
        entryManifest.push(`directory:${dirent.name}`)
        const child = await open(
          childPath,
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0),
        ).catch(() => { throw new Error('OpenCode project behavior path contains a link or unsupported component') })
        const metadata = await child.stat({ bigint: true })
        if (!metadata.isDirectory()) {
          await child.close()
          throw new Error('OpenCode project behavior path contains a link or unsupported component')
        }
        const previous = directories.get(relativePath)
        if (previous) {
          await child.close()
          if (!sameProjectBehaviorDirectoryIdentity(metadata, previous.identity)) {
            throw new Error('OpenCode project behavior directory changed during capture')
          }
          await captureDirectory(previous.handle, relativePath)
        } else {
          directories.set(relativePath, {
            handle: child,
            identity: { dev: metadata.dev, ino: metadata.ino },
          })
          await captureDirectory(child, relativePath)
        }
      } else {
        if (!dirent.isFile()) throw new Error('OpenCode project behavior path contains a link or unsupported component')
        entryManifest.push(`file:${dirent.name}`)
        await captureFile(directory, relativeDir, dirent.name, relativePath)
      }
    }
    directoryEntryManifests.set(relativeDir, entryManifest.sort())
  }

  try {
    for (const relativePath of PROJECT_BEHAVIOR_FILES) {
      const parts = relativePath.split('/').filter(Boolean)
      const parent = parts.length > 1 ? await openDirectoryComponents(parts.slice(0, -1)) : rootHandle
      if (!parent) continue
      try {
        await captureFile(
          parent,
          parts.slice(0, -1).join(path.sep),
          parts.at(-1)!,
          relativePath,
          true,
        )
      } catch (error) {
        throw new Error(
          `OpenCode behavior file has unsupported type (symlinks are not allowed): ${relativePath}`,
          { cause: error },
        )
      }
    }

    for (const relativeDir of PROJECT_BEHAVIOR_DIRS) {
      const directory = await openDirectoryComponents(relativeDir.split('/').filter(Boolean))
      if (!directory) continue
      await captureDirectory(directory, relativeDir)
    }
  } catch (error) {
    await close()
    throw error
  }

  entries.sort()

  return {
    projectBehaviorFingerprint: hashString(entries.join('\n')),
    behaviorSources: Array.from(behaviorSources).sort(),
    behaviorEntryManifest: entries,
    resolvedProjectPath,
    fdRoot,
    rootHandle,
    directories,
    directoryEntryManifests,
    files,
    close,
  }
}

export async function collectProjectBehaviorMetadata(projectPath: string): Promise<{
  projectBehaviorFingerprint: string
  behaviorSources: string[]
  behaviorEntryManifest: string[]
}> {
  const capture = await captureProjectBehaviorMetadata(projectPath)
  try {
    return {
      projectBehaviorFingerprint: capture.projectBehaviorFingerprint,
      behaviorSources: capture.behaviorSources,
      behaviorEntryManifest: capture.behaviorEntryManifest,
    }
  } finally {
    await capture.close()
  }
}

async function publishImmutableProjectBehaviorSnapshot(
  capture: OpenCodeProjectBehaviorCapture | null,
  targetPath: string,
  expectedEntries: readonly string[],
  testHooks?: {
    afterCaptureBeforeCopy?: () => void | Promise<void>
    afterTemporaryTreeVerified?: (temporaryPath: string) => void | Promise<void>
    afterRenameBeforeFinalVerify?: (targetPath: string) => void | Promise<void>
  },
): Promise<void> {
  const publicationDirectory = await OpenCodeSafePublicationDirectory.open(path.dirname(targetPath))
  targetPath = publicationDirectory.child(path.basename(targetPath))
  try {
  const expectedFiles = new Map<string, string>()
  const expectedDirectories = new Set<string>()
  for (const entry of expectedEntries) {
    if (entry.startsWith('directory:')) {
      expectedDirectories.add(entry.slice('directory:'.length))
      continue
    }
    if (!entry.startsWith('file:')) {
      throw new Error('OpenCode project behavior manifest entry type is invalid')
    }
    const separator = entry.lastIndexOf(':')
    const relativePath = entry.slice('file:'.length, separator)
    const digest = entry.slice(separator + 1)
    if (!relativePath || !/^[a-f0-9]{64}$/.test(digest) || expectedFiles.has(relativePath)) {
      throw new Error('OpenCode project behavior manifest entry is invalid')
    }
    expectedFiles.set(relativePath, digest)
  }
  const targetName = (relativeSource: string): string => {
    if (relativeSource === 'opencode.json' || relativeSource === 'opencode.jsonc') {
      return path.join('_source-config', `root-${relativeSource}`)
    }
    if (relativeSource === '.opencode/opencode.json' || relativeSource === '.opencode/opencode.jsonc') {
      return path.join('_source-config', `project-${path.basename(relativeSource)}`)
    }
    return relativeSource.startsWith('.opencode/')
      ? relativeSource.slice('.opencode/'.length)
      : relativeSource
  }
  const expectedTargetDigests = new Map(Array.from(expectedFiles, ([relativeSource, digest]) => [
    targetName(relativeSource), digest,
  ]))
  const expectedTargetDirectories = new Set<string>([
    '',
    ...Array.from(expectedDirectories, targetName),
  ])
  for (const relativeTarget of expectedTargetDigests.keys()) {
    let directory = path.dirname(relativeTarget)
    while (directory !== '.') {
      expectedTargetDirectories.add(directory)
      const parent = path.dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null
  const descriptorRoot = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'
  if (currentUid === null) {
    throw new Error('OpenCode immutable project behavior ownership verification is unsupported')
  }
  const verifyTree = async (rootPath: string): Promise<ProjectBehaviorDirectoryIdentity | null> => {
    let root: FileHandle
    try {
      root = await open(
        rootPath,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0),
      )
    } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') return null
      throw new Error('OpenCode immutable project behavior snapshot has unsupported type', {
        cause: error,
      })
    }
    const actualFiles: string[] = []
    const actualDirectories: string[] = []
    const walk = async (directory: FileHandle, relativeDirectory: string): Promise<void> => {
      const directoryMetadata = await directory.stat({ bigint: true })
      if (!directoryMetadata.isDirectory()
        || Number(directoryMetadata.uid) !== currentUid
        || (Number(directoryMetadata.mode) & 0o777) !== 0o500) {
        throw new Error('OpenCode immutable project behavior snapshot directory ownership or mode mismatch')
      }
      actualDirectories.push(relativeDirectory)
      const entries = await readdir(
        path.join(descriptorRoot, String(directory.fd)),
        { withFileTypes: true },
      )
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        const relativeEntry = relativeDirectory
          ? path.join(relativeDirectory, entry.name)
          : entry.name
        const descriptorEntry = path.join(descriptorRoot, String(directory.fd), entry.name)
        if (entry.isDirectory()) {
          const child = await open(
            descriptorEntry,
            fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0),
          ).catch(error => {
            throw new Error('OpenCode immutable project behavior snapshot contains unsupported entries', {
              cause: error,
            })
          })
          try { await walk(child, relativeEntry) } finally { await child.close() }
          continue
        }
        if (!entry.isFile()) {
          throw new Error('OpenCode immutable project behavior snapshot contains unsupported entries')
        }
        const child = await open(
          descriptorEntry,
          fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
        ).catch(error => {
          throw new Error('OpenCode immutable project behavior snapshot contains unsupported entries', {
            cause: error,
          })
        })
        try {
          const before = await child.stat({ bigint: true })
          if (!before.isFile()
            || Number(before.uid) !== currentUid
            || (Number(before.mode) & 0o777) !== 0o400) {
            throw new Error('OpenCode immutable project behavior snapshot file ownership or mode mismatch')
          }
          const bytes = await child.readFile()
          const after = await child.stat({ bigint: true })
          if (before.dev !== after.dev || before.ino !== after.ino
            || before.size !== after.size || before.mtimeNs !== after.mtimeNs
            || before.ctimeNs !== after.ctimeNs) {
            throw new Error('OpenCode immutable project behavior snapshot changed during verification')
          }
          if (hashBuffer(bytes) !== expectedTargetDigests.get(relativeEntry)) {
            throw new Error('OpenCode immutable project behavior snapshot fingerprint mismatch')
          }
          actualFiles.push(relativeEntry)
        } finally {
          await child.close()
        }
      }
    }
    try {
      const rootMetadata = await root.stat({ bigint: true })
      await walk(root, '')
      const expectedFiles = Array.from(expectedTargetDigests.keys()).sort()
      if (canonicalSerializeOpenCodePolicyIdentity(actualFiles.sort())
        !== canonicalSerializeOpenCodePolicyIdentity(expectedFiles)) {
        throw new Error('OpenCode immutable project behavior snapshot contains unexpected entries')
      }
      if (canonicalSerializeOpenCodePolicyIdentity(actualDirectories.sort())
        !== canonicalSerializeOpenCodePolicyIdentity(
          Array.from(expectedTargetDirectories).sort(),
        )) {
        throw new Error('OpenCode immutable project behavior snapshot contains unexpected directories')
      }
      return { dev: rootMetadata.dev, ino: rootMetadata.ino }
    } finally {
      await root.close()
    }
  }
  const verify = async (): Promise<boolean> => (await verifyTree(targetPath)) !== null
  if (await verify()) return
  if (!capture) {
    throw new Error('OpenCode immutable project behavior snapshot is missing')
  }
  const temporaryPath = `${targetPath}.snapshot-${process.pid}-${randomUUID()}`
  let publishedIdentity: ProjectBehaviorDirectoryIdentity | null = null
  let renamedFinalIdentity: ProjectBehaviorDirectoryIdentity | null = null
  const revalidateDirectoryChain = async (relativeDirectory: string): Promise<void> => {
    if (!capture.rootHandle) {
      throw new Error('OpenCode project behavior root disappeared before materialization')
    }
    const components = relativeDirectory.split(path.sep).filter(Boolean)
    let current = await open(
      capture.resolvedProjectPath,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0),
    ).catch(error => {
      throw new Error('OpenCode project behavior ancestry changed before materialization', {
        cause: error,
      })
    })
    try {
      const rootExpected = capture.directories.get('')!
      if (!sameProjectBehaviorDirectoryIdentity(
        await current.stat({ bigint: true }), rootExpected.identity,
      )) throw new Error('OpenCode project behavior ancestry changed before materialization')
      let relative = ''
      for (const component of components) {
        relative = relative ? path.join(relative, component) : component
        const expectedDirectory = capture.directories.get(relative)
        if (!expectedDirectory) {
          throw new Error('OpenCode project behavior capture is incomplete')
        }
        const next = await open(
          path.join(capture.fdRoot, String(current.fd), component),
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0),
        ).catch(error => {
          throw new Error('OpenCode project behavior ancestry changed before materialization', {
            cause: error,
          })
        })
        const metadata = await next.stat({ bigint: true })
        await current.close()
        current = next
        if (!sameProjectBehaviorDirectoryIdentity(metadata, expectedDirectory.identity)) {
          throw new Error('OpenCode project behavior ancestry changed before materialization')
        }
      }
    } finally {
      await current.close().catch(() => undefined)
    }
  }
  const readCapturedFile = async (relativeSource: string, digest: string): Promise<Buffer> => {
    const capturedFile = capture.files.get(relativeSource)
    if (!capturedFile) throw new Error('OpenCode project behavior capture is incomplete')
    const parent = capture.directories.get(capturedFile.parentDirectory)
    if (!parent) throw new Error('OpenCode project behavior capture is incomplete')
    await revalidateDirectoryChain(capturedFile.parentDirectory)
    if (!sameProjectBehaviorDirectoryIdentity(
      await parent.handle.stat({ bigint: true }), parent.identity,
    )) throw new Error('OpenCode project behavior retained directory changed before materialization')
    const handle = await open(
      path.join(capture.fdRoot, String(parent.handle.fd), capturedFile.name),
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    ).catch(error => {
      throw new Error('OpenCode project behavior entry changed before materialization', {
        cause: error,
      })
    })
    try {
      const before = await handle.stat({ bigint: true })
      if (!sameProjectBehaviorFileIdentity(before, capturedFile.identity)) {
        throw new Error('OpenCode project behavior entry changed before materialization')
      }
      const bytes = await handle.readFile()
      const after = await handle.stat({ bigint: true })
      if (!sameProjectBehaviorFileIdentity(after, capturedFile.identity)
        || hashBuffer(bytes) !== digest) {
        throw new Error('OpenCode project behavior changed while being materialized')
      }
      await revalidateDirectoryChain(capturedFile.parentDirectory)
      return bytes
    } finally {
      await handle.close()
    }
  }
  const revalidateCapturedDirectoryEntrySets = async (): Promise<void> => {
    const manifests = Array.from(capture.directoryEntryManifests)
      .sort(([left], [right]) => {
        const depth = left.split(path.sep).length - right.split(path.sep).length
        return depth || left.localeCompare(right)
      })
    for (const [relativeDirectory, expectedManifest] of manifests) {
      await revalidateDirectoryChain(relativeDirectory)
      const retained = capture.directories.get(relativeDirectory)
      if (!retained || !sameProjectBehaviorDirectoryIdentity(
        await retained.handle.stat({ bigint: true }), retained.identity,
      )) throw new Error('OpenCode project behavior directory changed before materialization')
      const actualManifest = (await readdir(
        path.join(capture.fdRoot, String(retained.handle.fd)),
        { withFileTypes: true },
      ))
        .filter(entry => entry.name !== '.DS_Store' && entry.name !== '.git' && entry.name !== 'node_modules')
        .map(entry => entry.isDirectory()
          ? `directory:${entry.name}`
          : entry.isFile() ? `file:${entry.name}` : `unsupported:${entry.name}`)
        .sort((left, right) => left.localeCompare(right))
      if (canonicalSerializeOpenCodePolicyIdentity(actualManifest)
        !== canonicalSerializeOpenCodePolicyIdentity(expectedManifest)) {
        throw new Error('OpenCode project behavior directory entry set changed before materialization')
      }
    }
  }
  const freezeTree = async (directory: FileHandle): Promise<void> => {
    const entries = await readdir(
      path.join(capture.fdRoot, String(directory.fd)),
      { withFileTypes: true },
    )
    for (const entry of entries) {
      const descriptorEntry = path.join(capture.fdRoot, String(directory.fd), entry.name)
      if (entry.isDirectory()) {
        const child = await open(
          descriptorEntry,
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0),
        )
        try { await freezeTree(child) } finally { await child.close() }
      } else if (entry.isFile()) {
        const child = await open(
          descriptorEntry,
          fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
        )
        try { await child.chmod(0o400) } finally { await child.close() }
      } else {
        throw new Error('OpenCode temporary project behavior snapshot contains unsupported entries')
      }
    }
    await directory.chmod(0o500)
  }
  const quarantineInvalidCurrentPublication = async (): Promise<void> => {
    // The failed verifier is authoritative for the pathname as it exists now,
    // not for the temporary inode that was renamed there earlier. A competing
    // preparer may have replaced our publication while the final verification
    // was in flight. Preserve a replacement that already verifies, otherwise
    // quarantine the exact current inode under the publication lock so an
    // immediate retry does not inherit a poisoned final path.
    try {
      if (await verify()) return
    } catch {
      // Capture and quarantine the invalid current target below.
    }
    // lstat deliberately captures the path entry itself, including a regular
    // file or symlink replacement, without following it. The publication lock
    // excludes cooperating writers between this receipt and the rename.
    const currentMetadata = await lstat(targetPath, { bigint: true }).catch(() => null)
    if (!currentMetadata) return
    const currentIdentity: ProjectBehaviorDirectoryIdentity = {
      dev: currentMetadata.dev,
      ino: currentMetadata.ino,
    }
    const quarantinePath = `${targetPath}.incomplete-${process.pid}-${randomUUID()}`
    await rename(targetPath, quarantinePath)
    const quarantinedMetadata = await lstat(quarantinePath, { bigint: true }).catch(() => null)
    if (!quarantinedMetadata) {
      throw new Error('OpenCode incomplete project snapshot quarantine disappeared')
    }
    if (!sameProjectBehaviorDirectoryIdentity(quarantinedMetadata, currentIdentity)) {
      throw new Error('OpenCode incomplete project snapshot quarantine identity changed')
    }
    await rm(quarantinePath, { recursive: true, force: true })
  }
  try {
    await mkdir(temporaryPath, { mode: 0o700 })
    await testHooks?.afterCaptureBeforeCopy?.()
    await revalidateCapturedDirectoryEntrySets()
    for (const relativeDirectory of Array.from(expectedTargetDirectories).sort()) {
      if (relativeDirectory) {
        await mkdir(path.join(temporaryPath, relativeDirectory), { recursive: true, mode: 0o700 })
      }
    }
    for (const [relativeSource, digest] of expectedFiles) {
      const relativeTarget = targetName(relativeSource)
      const targetFile = path.join(temporaryPath, relativeTarget)
      await mkdir(path.dirname(targetFile), { recursive: true, mode: 0o700 })
      await writeFile(targetFile, await readCapturedFile(relativeSource, digest), {
        flag: 'wx', mode: 0o400,
      })
    }
    await revalidateCapturedDirectoryEntrySets()
    const temporaryRoot = await open(
      temporaryPath,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0),
    )
    try { await freezeTree(temporaryRoot) } finally { await temporaryRoot.close() }
    publishedIdentity = await verifyTree(temporaryPath)
    if (!publishedIdentity) throw new Error('OpenCode temporary project behavior snapshot disappeared')
    await testHooks?.afterTemporaryTreeVerified?.(temporaryPath)
    const sourceIdentityBeforeRename = await verifyTree(temporaryPath)
    if (!sourceIdentityBeforeRename
      || sourceIdentityBeforeRename.dev !== publishedIdentity.dev
      || sourceIdentityBeforeRename.ino !== publishedIdentity.ino) {
      throw new Error('OpenCode temporary project behavior snapshot pathname changed before publication')
    }
    let renamed = false
    await rename(temporaryPath, targetPath).then(() => {
      renamed = true
    }).catch(async error => {
      if (!['EEXIST', 'ENOTEMPTY'].includes(getErrnoCode(error) ?? '') || !(await verify())) throw error
      publishedIdentity = null
    })
    if (renamed) {
      const renamedRoot = await open(
        targetPath,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0),
      ).catch(() => null)
      if (!renamedRoot) throw new Error('OpenCode immutable project behavior snapshot disappeared after publication')
      try {
        const renamedMetadata = await renamedRoot.stat({ bigint: true })
        renamedFinalIdentity = { dev: renamedMetadata.dev, ino: renamedMetadata.ino }
      } finally {
        await renamedRoot.close()
      }
      if (renamedFinalIdentity.dev !== publishedIdentity.dev
        || renamedFinalIdentity.ino !== publishedIdentity.ino) {
        throw new Error('OpenCode temporary project behavior snapshot inode changed during publication')
      }
      await testHooks?.afterRenameBeforeFinalVerify?.(targetPath)
    }
    const finalIdentity = await verifyTree(targetPath)
    if (!finalIdentity) {
      throw new Error('OpenCode immutable project behavior snapshot disappeared after publication')
    }
    if (renamed && (finalIdentity.dev !== publishedIdentity!.dev
      || finalIdentity.ino !== publishedIdentity!.ino)) {
      throw new Error('OpenCode immutable project behavior snapshot inode changed after publication')
    }
  } catch (error) {
    try {
      await quarantineInvalidCurrentPublication()
    } catch (quarantineError) {
      throw new Error('OpenCode invalid project snapshot quarantine failed', {
        cause: quarantineError,
      })
    }
    throw error
  } finally {
    await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined)
  }
  } finally {
    await publicationDirectory.close()
  }
}

/** Deterministic descriptor/publication regression seam; production uses the same internals. */
export async function publishOpenCodeProjectBehaviorSnapshotForTest(
  projectPath: string,
  targetPath: string,
  testHooks?: {
    afterCaptureBeforeCopy?: () => void | Promise<void>
    afterTemporaryTreeVerified?: (temporaryPath: string) => void | Promise<void>
    afterRenameBeforeFinalVerify?: (targetPath: string) => void | Promise<void>
  },
): Promise<void> {
  const capture = await captureProjectBehaviorMetadata(projectPath)
  try {
    await publishImmutableProjectBehaviorSnapshot(
      capture,
      targetPath,
      capture.behaviorEntryManifest,
      testHooks,
    )
  } finally {
    await capture.close()
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
  cursorAgentExecutablePath: string | null
  kiroCliExecutablePath: string | null
  hostHomePath: string
}

interface OpenCodeFullNativeCliCredentialBridge extends OpenCodeNativeCliCredentialBridge {
  cursorAgentExecutablePath: string
  kiroCliExecutablePath: string
}

type KiroCliAuthProbe = (
  executablePath: string,
  platform: NodeJS.Platform,
) => Promise<boolean>

interface KiroCliWhoamiResult {
  error?: unknown
  stdout?: Buffer | string | null
  stderr?: Buffer | string | null
}

type CursorAgentAuthProbe = (
  executablePath: string,
  platform: NodeJS.Platform,
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

const probeCursorAgentAuth: CursorAgentAuthProbe = async (executablePath, platform) =>
  await new Promise<boolean>(resolve => {
    execFile(
      executablePath,
      ['status'],
      {
        timeout: 15_000,
        windowsHide: true,
        shell: platform === 'win32',
      },
      (error, stdout, stderr) => {
        resolve(!error && /\blogged in\b/i.test(`${stdout}\n${stderr}`))
      },
    )
  })

const probeKiroCliAuth: KiroCliAuthProbe = async (executablePath, platform) =>
  await new Promise<boolean>(resolve => {
    execFile(
      executablePath,
      ['whoami', '--format', 'json'],
      {
        timeout: 15_000,
        windowsHide: true,
        shell: platform === 'win32',
      },
      (error, stdout, stderr) => {
        resolve(isKiroCliWhoamiAuthenticated({ error, stdout, stderr }))
      },
    )
  })

export async function probeNativeCredentialIdentity(
  providerId: 'kiro' | 'cursor-acp',
  executablePath: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): Promise<{ reportsAuthenticated: boolean; accountIdentity: string | null }> {
  const args = providerId === 'kiro' ? ['whoami', '--format', 'json'] : ['status']
  return new Promise(resolve => {
    execFile(executablePath, args, {
      timeout: 15_000,
      windowsHide: true,
      shell: platform === 'win32',
      env: environment,
    }, (error, stdout, stderr) => {
      const reportsAuthenticated = providerId === 'kiro'
        ? isKiroCliWhoamiAuthenticated({ error, stdout, stderr })
        : !error && /\blogged in\b/i.test(`${stdout}\n${stderr}`)
      const accountIdentity = resolveOpenCodeNativeAccountIdentity(providerId, stdout, stderr)
      resolve({
        // A generic "logged in"/account-type response is not an account
        // identity. It may authorize an interactive CLI, but cannot safely
        // key a retained provider-scoped host.
        reportsAuthenticated,
        accountIdentity,
      })
    })
  })
}

/**
 * Extracts only provider-specific stable account identifiers. The raw value is
 * immediately hashed and is never returned or persisted.
 */
export function resolveOpenCodeNativeAccountIdentity(
  providerId: 'kiro' | 'cursor-acp',
  stdout: Buffer | string | null | undefined,
  stderr: Buffer | string | null | undefined,
): string | null {
  for (const output of [stdout, stderr]) {
    const json = extractFirstBalancedJsonObject(output?.toString() ?? '')
    if (!json) continue
    try {
      const source = JSON.parse(json) as Record<string, unknown>
      const fields = providerId === 'kiro'
        ? ['accountId', 'userId', 'subject']
        : ['accountId', 'userId', 'subject', 'email', 'sub']
      const stable = Object.fromEntries(fields.flatMap(field => {
        const value = source[field]
        return typeof value === 'string' && value.trim() ? [[field, value.trim()]] : []
      }))
      if (Object.keys(stable).length > 0) return canonicalFingerprint({ providerId, stable })
    } catch {
      // Malformed output is never identity evidence.
    }
  }
  return null
}

function isCursorAgentAuthMarker(credential: Record<string, unknown> | null): boolean {
  return credential?.type === 'api' && credential.key === CURSOR_AGENT_AUTH_MARKER
}

function isKiroCliAuthMarker(credential: Record<string, unknown> | null): boolean {
  return credential?.type === 'oauth'
    && credential.access === 'authenticated'
    && credential.refresh === ''
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

async function publishImmutableBridgeFile(
  filePath: string,
  content: string,
  mode: number,
): Promise<void> {
  await withOpenCodeSafePublicationDirectory(path.dirname(filePath), directory =>
    directory.publishImmutableFile(path.basename(filePath), content, mode))
}

export async function fingerprintOpenCodeNativeCredentialBridge(
  bridge: OpenCodeScopedPreparedProfile['nativeCredentialBridge'],
): Promise<string> {
  if (!bridge) return canonicalFingerprint(null)
  const expectedNames = bridge.providerId === 'kiro'
    ? [path.basename(bridge.executablePath)]
    : [path.basename(bridge.executablePath), 'cursor-resource-exhausted-preload.cjs']
  const entries = await readdir(bridge.binPath, { withFileTypes: true })
  if (
    entries.some(entry => !entry.isFile() || !expectedNames.includes(entry.name))
    || entries.length !== expectedNames.length
  ) {
    throw new Error('OpenCode native credential bridge contains unexpected entries')
  }
  return canonicalFingerprint(await Promise.all(expectedNames.sort().map(async name => {
    const filePath = path.join(bridge.binPath, name)
    const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    try {
      const metadata = await handle.stat()
      if (!metadata.isFile()) {
        throw new Error('OpenCode native credential bridge is not a regular file')
      }
      return { name, digest: hashBuffer(await handle.readFile()) }
    } finally {
      await handle.close()
    }
  })))
}

export function ensureOpenCodeNativeCliCredentialBridge(
  profileRootPath: string,
  hostEnv?: NodeJS.ProcessEnv,
  platform?: NodeJS.Platform,
): Promise<OpenCodeFullNativeCliCredentialBridge>
export function ensureOpenCodeNativeCliCredentialBridge(
  profileRootPath: string,
  hostEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  selectedProviderId: 'kiro' | 'cursor-acp',
): Promise<OpenCodeNativeCliCredentialBridge>
export async function ensureOpenCodeNativeCliCredentialBridge(
  profileRootPath: string,
  hostEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  selectedProviderId: 'kiro' | 'cursor-acp' | null = null,
): Promise<OpenCodeNativeCliCredentialBridge> {
  const hostHomePath = (
    platform === 'win32'
      ? hostEnv.USERPROFILE?.trim() || hostEnv.HOME?.trim()
      : hostEnv.HOME?.trim() || hostEnv.USERPROFILE?.trim()
  ) || os.homedir()
  const hostPath = hostEnv.PATH ?? ''
  const cursorAgentCommand = hostEnv.CURSOR_AGENT_EXECUTABLE?.trim() || 'cursor-agent'
  const binPath = path.join(profileRootPath, 'native-subscription-cli-bin')
  await ensureOpenCodeManagedDirectoryPath(profileRootPath, profileRootPath)
  const existingBin = await lstat(binPath).catch(error => {
    if (getErrnoCode(error) === 'ENOENT') return null
    throw error
  })
  if (existingBin && (!existingBin.isDirectory() || existingBin.isSymbolicLink())) {
    throw new Error('OpenCode native credential bridge parent is not canonical [redacted]')
  }
  if (!existingBin) await ensureOpenCodeManagedDirectoryPath(binPath, profileRootPath)
  await assertCanonicalOwnedPathComponents(binPath, profileRootPath)
  const cursorResourceExhaustedPreloadPath = path.join(binPath, 'cursor-resource-exhausted-preload.cjs')
  if (selectedProviderId === null || selectedProviderId === 'cursor-acp') {
    await publishImmutableBridgeFile(
      cursorResourceExhaustedPreloadPath,
      buildCursorAgentResourceExhaustedPreloadScript(),
      0o400,
    )
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
      await publishImmutableBridgeFile(bridgePath, content, 0o500)
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
    await publishImmutableBridgeFile(bridgePath, content, 0o500)
    return bridgePath
  }

  const [cursorAgentExecutablePath, kiroCliExecutablePath] = await Promise.all([
    selectedProviderId === null || selectedProviderId === 'cursor-acp'
      ? writeBridge('cursor-agent')
      : Promise.resolve(null),
    selectedProviderId === null || selectedProviderId === 'kiro'
      ? writeBridge('kiro-cli')
      : Promise.resolve(null),
  ])
  await chmod(binPath, 0o500)
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

function getOpenCodeConfigImportPaths(env: NodeJS.ProcessEnv): string[] {
  const canonicalHome = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir()
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim() || path.join(canonicalHome, '.config')
  const candidates = [
    path.join(canonicalHome, '.config', 'opencode', 'opencode.json'),
    path.join(canonicalHome, '.config', 'opencode', 'opencode.jsonc'),
    // An explicit XDG config is closer to the invoking runtime than the
    // canonical user config and must win model/provider conflicts.
    path.join(xdgConfigHome, 'opencode', 'opencode.json'),
    path.join(xdgConfigHome, 'opencode', 'opencode.jsonc'),
  ]
  const explicitConfigPath = env.OPENCODE_CONFIG?.trim()
  if (explicitConfigPath) {
    candidates.push(path.resolve(explicitConfigPath))
  }
  return Array.from(new Set(candidates.map(candidate => path.resolve(candidate))))
}

function readInlineConfiguredPlugins(
  value: string | undefined,
  provenance: OpenCodePreservedPlugin['provenance'],
): OpenCodePreservedPlugin[] {
  const parsed = asRecord(safeParseJSONC(value))
  return (Array.isArray(parsed.plugin) ? parsed.plugin : [])
    .filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
    .map(spec => ({ spec: spec.trim(), provenance }))
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

async function normalizeScopedProjectPath(projectPath?: string | null): Promise<string> {
  const resolved = path.resolve(projectPath?.trim() || getCwd())
  const canonical = await realpath(resolved).catch(() => resolved)
  const normalized = path.normalize(canonical)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * Provider inputs that OpenCode and its provider SDKs may inherit from this
 * process. Values are never returned or persisted; only the canonical digest
 * participates in profile and host identity.
 */
export const OPEN_CODE_MATERIAL_PROVIDER_ENV_ALLOWLIST = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'CEREBRAS_API_KEY',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'COHERE_API_KEY',
  'DEEPINFRA_API_KEY',
  'DEEPSEEK_API_KEY',
  'FIREWORKS_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENROUTER_API_KEY',
  'PERPLEXITY_API_KEY',
  'SAMBANOVA_API_KEY',
  'TOGETHER_AI_API_KEY',
  'VERTEX_PROJECT',
  'XAI_API_KEY',
] as const

/** Non-provider variables required to execute a child without inheriting the app's whole environment. */
export const OPEN_CODE_SCOPED_EXECUTION_ENV_ALLOWLIST = [
  'PATH',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'LANG',
  'LC_ALL',
  'TZ',
] as const

function selectScopedInheritedEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {}
  for (const key of [
    ...OPEN_CODE_SCOPED_EXECUTION_ENV_ALLOWLIST,
    ...OPEN_CODE_MATERIAL_PROVIDER_ENV_ALLOWLIST,
  ]) {
    if (env[key] !== undefined) selected[key] = env[key]
  }
  return selected
}

export function fingerprintOpenCodeScopedInheritedEnvironment(env: NodeJS.ProcessEnv): string {
  // Digest exactly the inherited subset. This makes every caller-controlled
  // byte passed to the provider runtime part of durable profile/host identity.
  return canonicalFingerprint(Object.fromEntries(
    [...OPEN_CODE_SCOPED_EXECUTION_ENV_ALLOWLIST, ...OPEN_CODE_MATERIAL_PROVIDER_ENV_ALLOWLIST]
      .map(key => [key, env[key] ?? null]),
  ))
}

async function readConfiguredPlugins(
  filePath: string,
  provenance: OpenCodePreservedPlugin['provenance'],
): Promise<OpenCodePreservedPlugin[]> {
  try {
    const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const bytes = await handle.readFile().finally(() => handle.close())
    const parsed = asRecord(safeParseJSONC(bytes.toString('utf8')))
    return (Array.isArray(parsed.plugin) ? parsed.plugin : [])
      .filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
      .map(spec => ({ spec: spec.trim(), provenance }))
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT' || getErrnoCode(error) === 'ENOTDIR') return []
    throw new Error('OpenCode plugin config must be a readable regular file without symlinks')
  }
}

async function collectScopedPreservedPlugins(
  projectPath: string,
  env: NodeJS.ProcessEnv,
): Promise<OpenCodePreservedPlugin[]> {
  const candidates = getScopedPluginConfigCandidates(projectPath, env)
  return [
    ...(await Promise.all(
      candidates.map(([filePath, provenance]) => readConfiguredPlugins(filePath, provenance)),
    )).flat(),
    ...readInlineConfiguredPlugins(env.OPENCODE_CONFIG_CONTENT, 'environment'),
  ]
}

function getScopedPluginConfigCandidates(
  projectPath: string,
  env: NodeJS.ProcessEnv,
): Array<readonly [string, OpenCodePreservedPlugin['provenance']]> {
  return [
    ...getOpenCodeConfigImportPaths(env).map(configPath => [configPath, 'user'] as const),
    [path.join(projectPath, 'opencode.json'), 'project'],
    [path.join(projectPath, 'opencode.jsonc'), 'project'],
    [path.join(projectPath, '.opencode', 'opencode.json'), 'project'],
    [path.join(projectPath, '.opencode', 'opencode.jsonc'), 'project'],
  ]
}

async function fingerprintScopedBinary(binaryPath: string): Promise<string> {
  const handle = await open(path.resolve(binaryPath), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error(`OpenCode binary is not a file: ${binaryPath}`)
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error('OpenCode binary changed while being verified')
    }
    return hashBuffer(bytes)
  } finally {
    await handle.close()
  }
}

async function publishImmutableNativeExecutable(
  sourcePath: string,
  profileRootPath: string,
  fingerprint: string,
): Promise<string> {
  const sourceHandle = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  let bytes: Buffer | null = null
  try {
    const before = await sourceHandle.stat({ bigint: true })
    if (!before.isFile()) throw new Error('OpenCode native executable is not a regular file')
    bytes = await sourceHandle.readFile()
    const after = await sourceHandle.stat({ bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || hashBuffer(bytes) !== fingerprint) {
      throw new Error('OpenCode native executable changed while being captured')
    }
  } finally {
    await sourceHandle.close()
  }
  if (!bytes) throw new Error('OpenCode native executable could not be captured')
  const root = path.join(profileRootPath, 'native-executables')
  const targetDirectory = path.join(root, fingerprint)
  await ensureOpenCodeManagedDirectoryPath(targetDirectory, profileRootPath)
  for (const directory of [profileRootPath, root, targetDirectory]) {
    const metadata = await lstat(directory)
    const canonical = await realpath(directory).catch(() => null)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== path.resolve(directory)
      || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())) {
      throw new Error('OpenCode native executable parent is not canonical and app-owned')
    }
  }
  const targetPath = path.join(targetDirectory, path.basename(sourcePath))
  await withOpenCodeSafePublicationDirectory(targetDirectory, directory =>
    directory.publishImmutableFile(path.basename(targetPath), bytes!, 0o500))
  await chmod(targetDirectory, 0o500)
  if (await fingerprintScopedBinary(targetPath) !== fingerprint) {
    throw new Error('OpenCode immutable native executable verification failed')
  }
  return targetPath
}

function canonicalFingerprint(value: unknown): string {
  return hashString(canonicalSerializeOpenCodePolicyIdentity(value))
}

function cloneAndDeepFreezeScopedInput<T>(value: T): T {
  const clone = (entry: unknown, ancestors: Set<object>): unknown => {
    if (entry === null || typeof entry !== 'object') return entry
    if (ancestors.has(entry)) {
      throw new Error('OpenCode scoped input must not contain cycles')
    }
    const prototype = Object.getPrototypeOf(entry)
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(entry)) {
      throw new Error('OpenCode scoped input must contain only plain immutable evidence')
    }
    const nextAncestors = new Set(ancestors).add(entry)
    const copy: object = Array.isArray(entry)
      ? entry.map(item => clone(item, nextAncestors))
      : Object.fromEntries(Object.entries(entry).map(([key, item]) => [
          key, clone(item, nextAncestors),
        ]))
    return Object.freeze(copy)
  }
  return clone(value, new Set()) as T
}

function stripScopedBridgePath(
  value: string | undefined,
  bridgeBinPath: string | undefined,
): string | undefined {
  if (!value || !bridgeBinPath) return value
  if (value === bridgeBinPath) return undefined
  return value.startsWith(`${bridgeBinPath}${path.delimiter}`)
    ? value.slice(bridgeBinPath.length + path.delimiter.length)
    : value
}

async function resolveNativeTargetExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | null> {
  const hasPathSeparator = command.includes('/') || command.includes('\\')
  const candidates = hasPathSeparator
    ? [path.resolve(command)]
    : (env.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap(directory => {
        const base = path.join(directory, command)
        return platform === 'win32'
          ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map(extension =>
              base.toLowerCase().endsWith(extension.toLowerCase()) ? base : `${base}${extension}`)
          : [base]
      })
  for (const candidate of candidates) {
    const metadata = await stat(candidate).catch(() => null)
    if (metadata?.isFile()) return await realpath(candidate).catch(() => path.resolve(candidate))
  }
  return null
}

async function fingerprintNativeAccountEvidence(
  providerId: string | null,
  hostHomePath: string,
): Promise<{ fingerprint: string; definitive: boolean }> {
  const relativeEntries = providerId === 'cursor-acp'
    ? ['.cursor/auth.json', '.cursor/cli-config.json', '.cursor-agent/auth.json']
    : providerId === 'kiro'
      ? ['.aws/credentials', '.aws/config', '.aws/sso/cache', '.aws/amazonq/cache', '.kiro/credentials.json']
      : []
  const definitiveCredentialEntries = new Set(providerId === 'cursor-acp'
    ? ['.cursor/auth.json', '.cursor-agent/auth.json']
    : [])
  const evidence: Array<{ path: string; digest: string | null }> = []
  let definitive = false
  for (const relativeEntry of relativeEntries) {
    const absoluteEntry = path.join(hostHomePath, relativeEntry)
    const metadata = await lstat(absoluteEntry).catch(() => null)
    if (!metadata) {
      evidence.push({ path: relativeEntry, digest: null })
    } else if (metadata.isFile() && !metadata.isSymbolicLink()) {
      const bytes = await readFile(absoluteEntry)
      evidence.push({ path: relativeEntry, digest: hashBuffer(bytes) })
      definitive ||= definitiveCredentialEntries.has(relativeEntry) && bytes.length > 0
    } else if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      const entries = await collectBehaviorDirectoryEntries(
        path.dirname(absoluteEntry),
        path.basename(absoluteEntry),
      )
      evidence.push({ path: relativeEntry, digest: canonicalFingerprint(entries) })
      definitive ||= definitiveCredentialEntries.has(relativeEntry) && entries.length > 0
    } else {
      throw new Error('OpenCode native credential evidence has unsupported type')
    }
  }
  return { fingerprint: canonicalFingerprint({ providerId, evidence }), definitive }
}

export function fingerprintOpenCodeScopedExecutionEnvironment(env: NodeJS.ProcessEnv): string {
  return canonicalFingerprint(Object.fromEntries(
    Object.keys(env).sort().map(key => [key, env[key] ?? null]),
  ))
}

export async function revalidateOpenCodeScopedPreparedProfileInputs(
  profile: OpenCodeScopedPreparedProfile,
): Promise<void> {
  const expectedInheritedEnvironment = {
    ...profile.env,
    PATH: stripScopedBridgePath(profile.env.PATH, profile.nativeCredentialBridge?.binPath),
  }
  const manifestFingerprint = canonicalFingerprint(profile.expectedEntryManifest)
  if (manifestFingerprint !== profile.expectedEntryManifestFingerprint) {
    throw new Error('OpenCode scoped entry manifest identity mismatch')
  }
  const projectSnapshotPath = path.join(
    profile.profileRootPath,
    profile.expectedEntryManifest.projectBehaviorSnapshotPath,
  )
  const projectSnapshotMetadata = await lstat(projectSnapshotPath).catch(() => null)
  if (!projectSnapshotMetadata?.isDirectory() || projectSnapshotMetadata.isSymbolicLink()) {
    throw new Error('OpenCode immutable project behavior snapshot is missing')
  }
  await publishImmutableProjectBehaviorSnapshot(
    null,
    projectSnapshotPath,
    profile.expectedEntryManifest.projectBehaviorEntryManifest,
  )
  const userPluginEntries = await collectBehaviorDirectoryEntries(
    path.join(profile.xdgConfigHome, 'opencode'),
    'plugins',
  )
  const pluginDependencyEntries = profile.expectedEntryManifest.pluginDependencyEntries
    ? await collectBehaviorDirectoryEntries(
        path.dirname(profile.pluginNodeModulesPath),
        path.basename(profile.pluginNodeModulesPath),
        false,
        true,
      )
    : null
  const authBytes = await readRegularFileNoFollow(profile.managedAuthPath).catch(() => null)
  let authBaselineFingerprint: string | null = null
  if (authBytes) {
    try {
      authBaselineFingerprint = canonicalFingerprint(JSON.parse(authBytes.toString()))
    } catch {
      authBaselineFingerprint = null
    }
  }
  if (
    canonicalSerializeOpenCodePolicyIdentity(userPluginEntries)
      !== canonicalSerializeOpenCodePolicyIdentity(profile.expectedEntryManifest.userPluginEntries)
    || (pluginDependencyEntries !== null
      && canonicalSerializeOpenCodePolicyIdentity(pluginDependencyEntries)
        !== canonicalSerializeOpenCodePolicyIdentity(
          profile.expectedEntryManifest.pluginDependencyEntries,
        ))
    || !authBytes
    || hashBuffer(authBytes) !== profile.managedAuthFingerprint
    || authBaselineFingerprint !== profile.selectedAuthBaselineFingerprint
    || await fingerprintOpenCodeNativeCredentialBridge(profile.nativeCredentialBridge)
      !== profile.nativeCredentialBridgeFingerprint
    || fingerprintOpenCodeScopedExecutionEnvironment(profile.env)
      !== profile.executionEnvironmentFingerprint
    || (profile.nativeCredentialHostHomePath !== null
      && fingerprintOpenCodeScopedInheritedEnvironment(process.env)
        !== fingerprintOpenCodeScopedInheritedEnvironment(expectedInheritedEnvironment))
  ) throw new Error('OpenCode scoped entry inputs changed after preparation')

  const hostHomePath = profile.nativeCredentialHostHomePath
  if (profile.nativeCredentialBridge) {
    const targetFingerprint = profile.nativeTargetExecutablePath
      ? await fingerprintScopedBinary(profile.nativeTargetExecutablePath).catch(() => canonicalFingerprint(null))
      : canonicalFingerprint(null)
    if (
      targetFingerprint !== profile.nativeTargetExecutableFingerprint
      || (hostHomePath !== null
        && (await fingerprintNativeAccountEvidence(profile.providerId!, hostHomePath)).fingerprint
          !== profile.nativeAccountEvidenceFingerprint)
    ) throw new Error('OpenCode native account or executable evidence changed after preparation')
  }
}

export class OpenCodeProfileManager {
  private static readonly profilePreparationLocks = new Map<string, Promise<void>>()

  private readonly paths = resolveClaudeMultimodelPaths()

  planScopedProfile(input: OpenCodePlanScopedProfileInput): OpenCodeScopedProfilePlanContract {
    return planScopedProfile(input)
  }

  private getSourceAuthPaths(): string[] {
    const canonicalHome = process.env.HOME?.trim()
      || process.env.USERPROFILE?.trim()
      || os.homedir()
    const xdgDataHome =
      process.env.XDG_DATA_HOME?.trim() || path.join(canonicalHome, '.local', 'share')
    return Array.from(new Set([
      path.join(xdgDataHome, 'opencode', 'auth.json'),
      // Bridge/live-test processes can intentionally set XDG_DATA_HOME to an
      // isolated runtime directory. Always include the canonical user OpenCode
      // auth store as the highest-priority source so a fresh `opencode auth`
      // login can override stale app-global OAuth credentials.
      path.join(canonicalHome, '.local', 'share', 'opencode', 'auth.json'),
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

  async fanOutOAuthCredential(providerId: string, sourceAuthPath: string): Promise<void> {
    await fanOutOpenCodeOAuthCredential({
      providerId,
      sourceAuthPath,
      targetAuthPaths: [this.getGlobalAuthPath(), ...(await this.listManagedAuthPaths())],
    })
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

  /**
   * Additive S1 entry point. It intentionally shares no fallback with
   * prepareProfile: invalid plans fail before any managed directory or lock is
   * created, and preparation writes only the selected provider's staged auth.
   */
  async prepareScopedProfile(
    plan: OpenCodePlanScopedProfileInput,
    expectedPlan: OpenCodeScopedProfilePlanContract,
  ): Promise<OpenCodeScopedPreparedProfile> {
    // These are caller-owned objects. Snapshot both synchronously before the
    // first await and deliberately shadow the parameters so no continuation
    // can observe caller mutation after preparation yields.
    plan = cloneAndDeepFreezeScopedInput(plan)
    expectedPlan = cloneAndDeepFreezeScopedInput(expectedPlan)
    if (!plan || typeof plan !== 'object') {
      throw new Error('OpenCode scoped profile plan is required')
    }
    // The plan gate is intentionally the first operation after shallow shape
    // validation. It cannot touch the filesystem or environment and therefore
    // rejects a wrong expected digest before canonicalization or publication.
    if (!expectedPlan) {
      throw new Error('OpenCode scoped preparation requires expectedPlan')
    }
    const actualPlan = planScopedProfile(plan)
    if (
      canonicalSerializeOpenCodePolicyIdentity(actualPlan)
        !== canonicalSerializeOpenCodePolicyIdentity(expectedPlan)
    ) {
      throw new Error('OpenCode scoped expected plan mismatch [redacted]')
    }
    if (![
      'passive-status',
      'provider-catalog',
      'provider-connect',
      'execution-probe',
      'launch',
      'session-resume',
      'legacy-diagnostic',
    ].includes(plan.purpose)) {
      throw new Error(`Unsupported OpenCode operation purpose: ${String(plan.purpose)}`)
    }
    if (plan.purpose === 'passive-status') {
      throw new Error('OpenCode passive-status must not prepare a profile')
    }
    if (plan.purpose === 'legacy-diagnostic') {
      throw new Error('OpenCode legacy-diagnostic cannot prepare a scoped profile')
    }
    const runtimeInstanceId = plan.runtimeInstanceId?.trim()
    if (!runtimeInstanceId) {
      throw new Error('OpenCode scoped profile requires runtimeInstanceId')
    }
    const providerId = plan.providerId?.trim()
      ? canonicalizeOpenCodeProviderId(plan.providerId)
      : null
    if (!providerId) {
      throw new Error(`OpenCode operation ${plan.purpose} requires a providerId`)
    }
    const profileLayoutGeneration = OPEN_CODE_SCOPED_PROFILE_LAYOUT_GENERATION
    const modelId = plan.modelId?.trim() || null
    if (
      (plan.purpose === 'execution-probe'
        || plan.purpose === 'launch'
        || plan.purpose === 'session-resume')
      && !modelId
    ) {
      throw new Error(`OpenCode operation ${plan.purpose} requires a modelId`)
    }
    // Capture once: identity derivation, credential finalization, bridge
    // publication, and child inheritance must all observe the same inputs.
    const hostEnvironment = { ...process.env }

    const projectPath = await normalizeScopedProjectPath(plan.projectPath)
    const binaryPath = resolveOpenCodeBinaryPath()
    if (!binaryPath) throw new Error('OpenCode binary is required for scoped profile preparation')
    await Promise.all([
      assertCanonicalOwnedPathComponents(this.paths.data, this.paths.data),
      assertCanonicalOwnedPathComponents(this.paths.cache, this.paths.cache),
      assertCanonicalOwnedPathComponents(path.join(this.paths.data, 'opencode'), this.paths.data),
      assertCanonicalOwnedPathComponents(path.join(this.paths.cache, 'opencode'), this.paths.cache),
    ])
    const earlyPreparationLockRoot = path.join(
      this.paths.data,
      'opencode',
      'scoped-preparation-locks',
    )
    await ensureOpenCodeManagedDirectoryPath(earlyPreparationLockRoot, this.paths.data)
    const earlyPreparationLockPath = path.join(
      earlyPreparationLockRoot,
      `${canonicalFingerprint({ projectPath, purpose: plan.purpose, providerId, modelId })}.lock`,
    )
    const earlyLockDirectory = await OpenCodeSafePublicationDirectory.open(earlyPreparationLockRoot)
    const earlyLockName = path.basename(earlyPreparationLockPath)
    await earlyLockDirectory.ensureRegularFile(earlyLockName).catch(async error => {
      await earlyLockDirectory.close()
      throw error
    })
    const releaseEarlyPreparationLock = await lockfile.lock(
      earlyLockDirectory.child(earlyLockName),
      OPEN_CODE_PROFILE_SYMLINK_LOCK_OPTIONS,
    ).catch(async error => {
      await earlyLockDirectory.close()
      throw error
    })
    let behaviorCapture: OpenCodeProjectBehaviorCapture | null = null
    try {
    const userConfigRoot = hostEnvironment.XDG_CONFIG_HOME?.trim()
      || path.join(os.homedir(), '.config')
    const userPluginDirectory = path.join(userConfigRoot, 'opencode', 'plugins')
    behaviorCapture = await captureProjectBehaviorMetadata(projectPath)
    const behavior = behaviorCapture
    const [binaryFingerprint, preservedPlugins, automaticUserPluginEntries] = await Promise.all([
      fingerprintScopedBinary(binaryPath),
      collectScopedPreservedPlugins(projectPath, hostEnvironment),
      collectBehaviorDirectoryEntries(path.join(userConfigRoot, 'opencode'), 'plugins'),
    ])
    const automaticUserPluginFingerprint = canonicalFingerprint(automaticUserPluginEntries)
    if (expectedPlan && (
      expectedPlan.canonicalProjectPathFingerprint !== canonicalFingerprint(projectPath)
      || expectedPlan.projectBehaviorFingerprint !== behavior.projectBehaviorFingerprint
      || expectedPlan.binaryFingerprint !== binaryFingerprint
      || expectedPlan.profileLayoutFingerprint !== canonicalFingerprint(profileLayoutGeneration)
      || expectedPlan.automaticUserPluginFingerprint !== automaticUserPluginFingerprint
    )) throw new Error('OpenCode scoped planned project or binary evidence drifted [redacted]')
    const pluginConfigCandidates = getScopedPluginConfigCandidates(projectPath, hostEnvironment)
    const configuredPluginsWithoutInline = (await Promise.all(
      pluginConfigCandidates.map(([configPath, provenance]) =>
        readConfiguredPlugins(configPath, provenance)),
    )).flat()
    const nativeCredentialHostHomePath = (
      process.platform === 'win32'
        ? hostEnvironment.USERPROFILE?.trim() || hostEnvironment.HOME?.trim()
        : hostEnvironment.HOME?.trim() || hostEnvironment.USERPROFILE?.trim()
    ) || os.homedir()
    const nativeTargetCommand = providerId === 'cursor-acp'
      ? hostEnvironment.CURSOR_AGENT_EXECUTABLE?.trim() || 'cursor-agent'
      : providerId === 'kiro' ? 'kiro-cli' : null
    const nativeTargetSourceExecutablePath = nativeTargetCommand
      ? await resolveNativeTargetExecutable(nativeTargetCommand, hostEnvironment, process.platform)
      : null
    if (nativeTargetCommand && !nativeTargetSourceExecutablePath) {
      throw new Error('OpenCode selected native provider executable could not be resolved')
    }
    const nativeTargetExecutableFingerprint = nativeTargetSourceExecutablePath
      ? await fingerprintScopedBinary(nativeTargetSourceExecutablePath)
      : canonicalFingerprint(null)
    const nativeProofExecutablePath = nativeTargetSourceExecutablePath
      ? await publishImmutableNativeExecutable(
          nativeTargetSourceExecutablePath,
          path.join(this.paths.data, 'opencode', 'scoped-native-proof'),
          nativeTargetExecutableFingerprint,
        )
      : null
    const nativeAccountEvidence = await fingerprintNativeAccountEvidence(
      providerId,
      nativeCredentialHostHomePath,
    )
    const nativeAccountEvidenceFingerprint = nativeAccountEvidence.fingerprint
    const expectedEntryManifest = {
      projectBehaviorFingerprint: behavior.projectBehaviorFingerprint,
      projectBehaviorSnapshotPath: 'project-behavior',
      projectBehaviorEntryManifest: behavior.behaviorEntryManifest,
      userPluginDirectory,
      userPluginEntries: automaticUserPluginEntries,
      pluginConfigs: pluginConfigCandidates.map(([configPath, provenance]) => ({
        path: configPath,
        provenance,
      })),
      preservedPlugins,
      preservedPluginsFingerprint: canonicalFingerprint(configuredPluginsWithoutInline),
      inlinePluginsFingerprint: canonicalFingerprint(
        readInlineConfiguredPlugins(hostEnvironment.OPENCODE_CONFIG_CONTENT, 'environment'),
      ),
      pluginDependencyFingerprint: expectedPlan?.pluginFingerprint ?? null,
      pluginDependencyEntries: 'evidence' in plan
        ? Array.from(new Set(plan.evidence.plugins.flatMap(plugin =>
            plugin.immutableTreeEntries.map(entry =>
              `${path.join('node_modules', entry.path.replaceAll('\\', '/'))}:${entry.mode}:${hashBuffer(
                Buffer.from(entry.bytesBase64, 'base64'),
              )}`,
            ),
          ))).sort()
        : undefined,
    }
    const expectedEntryManifestFingerprint = canonicalFingerprint(expectedEntryManifest)
    const globalAuthPath = this.getGlobalAuthPath()
    const sourceAuthPaths = Array.from(new Set([globalAuthPath, ...this.getSourceAuthPaths()]))
    const sourceStores = await Promise.all(sourceAuthPaths.map(readOpenCodeAuthStore))
    const mergedAuth = mergeOpenCodeManagedAuthSources({
      sourceAuthPaths,
      sourceStores,
      globalAuthPath,
    })
    const selectedCredentialCandidate = providerId ? mergedAuth[providerId.toLowerCase()] : undefined
    const selectedCredential = (
      (providerId === 'kiro' && isKiroCliAuthMarker(selectedCredentialCandidate ?? null))
      || (providerId === 'cursor-acp' && isCursorAgentAuthMarker(selectedCredentialCandidate ?? null))
    ) ? undefined : selectedCredentialCandidate
    const selectedAuth = selectedCredential && providerId
      ? { [providerId.toLowerCase()]: selectedCredential }
      : {}
    let scopedSelectedAuth = selectedAuth
    let nativeCredentialProofFingerprint = canonicalFingerprint(null)
    let nativeAccountIdentityFingerprint = selectedCredential
      ? canonicalFingerprint({ providerId, selectedAuth })
      : canonicalFingerprint(null)
    const nativeProofProviderId: 'kiro' | 'cursor-acp' | null = providerId === 'kiro'
      ? 'kiro'
      : providerId === 'cursor-acp'
        ? 'cursor-acp'
        : null
    if (nativeProofProviderId && (nativeProofProviderId === 'kiro' || !selectedCredential)) {
      const nativeCommand = nativeProofExecutablePath!
      const nativeBytesBeforeProof = await fingerprintScopedBinary(nativeCommand)
      if (nativeBytesBeforeProof !== nativeTargetExecutableFingerprint) {
        throw new Error('OpenCode native provider executable changed before account proof')
      }
      const nativeProof = await probeNativeCredentialIdentity(
        nativeProofProviderId,
        nativeCommand,
        process.platform,
        hostEnvironment,
      ).catch(() => ({ reportsAuthenticated: false, accountIdentity: null }))
      const nativeBytesAfterProof = await fingerprintScopedBinary(nativeCommand)
      if (nativeBytesAfterProof !== nativeTargetExecutableFingerprint) {
        throw new Error('OpenCode native provider executable changed during account proof')
      }
      // Credential/cache presence (especially generic AWS state) is rotation
      // evidence only. It can never turn an ambiguous Kiro whoami response
      // into a durable provider-account identity.
      const hasDefinitiveIdentity = nativeProof.accountIdentity !== null
      nativeCredentialProofFingerprint = canonicalFingerprint({
        providerId,
        accountIdentity: nativeProof.accountIdentity,
        credentialEvidence: nativeAccountEvidence.definitive ? nativeAccountEvidenceFingerprint : null,
      })
      nativeAccountIdentityFingerprint = nativeProof.accountIdentity
        ? canonicalFingerprint({ providerId, accountIdentity: nativeProof.accountIdentity })
        : canonicalFingerprint(null)
      if (nativeProof.reportsAuthenticated && hasDefinitiveIdentity) {
        // These are stable presence markers, not bearer credentials. A stable
        // value makes concurrent preparations converge on one immutable auth
        // artifact while account/key material still separates through hashes.
        if (!selectedCredential) {
          scopedSelectedAuth = providerId === 'kiro'
            ? { kiro: { type: 'oauth', access: 'authenticated', refresh: '', expires: Number.MAX_SAFE_INTEGER } }
            : { 'cursor-acp': { type: 'api', key: CURSOR_AGENT_AUTH_MARKER, expires: Number.MAX_SAFE_INTEGER } }
        }
      } else {
        throw new Error('OpenCode native provider authenticated account identity could not be established')
      }
    }
    const selectedAuthBaselineFingerprint = canonicalFingerprint(scopedSelectedAuth)
    const nativeBridgeInputFingerprint = canonicalFingerprint(
      providerId === 'kiro' || providerId === 'cursor-acp'
        ? {
            providerId,
            platform: process.platform,
            home: process.platform === 'win32'
              ? hostEnvironment.USERPROFILE?.trim() || hostEnvironment.HOME?.trim() || os.homedir()
              : hostEnvironment.HOME?.trim() || hostEnvironment.USERPROFILE?.trim() || os.homedir(),
            path: hostEnvironment.PATH ?? '',
            cursorAgentExecutable: providerId === 'cursor-acp'
              ? hostEnvironment.CURSOR_AGENT_EXECUTABLE?.trim() || 'cursor-agent'
              : null,
            credentialProof: nativeCredentialProofFingerprint,
            accountEvidence: nativeAccountEvidenceFingerprint,
            targetExecutable: nativeTargetExecutableFingerprint,
          }
        : null,
    )
    let importedRuntimeConfig = await readSafeOpenCodeRuntimeConfigImport(hostEnvironment)
    for (const [configPath, provenance] of pluginConfigCandidates) {
      if (provenance !== 'project') continue
      importedRuntimeConfig = deepMergeOpenCodeConfig(
        importedRuntimeConfig,
        await readSafeOpenCodeRuntimeConfigFile(configPath),
      )
    }
    const policyPreservedPlugins = preservedPlugins
    const providerEnvironmentFingerprint = canonicalFingerprint({
      inherited: fingerprintOpenCodeScopedInheritedEnvironment(hostEnvironment),
      nativeBridgeInputs: nativeBridgeInputFingerprint,
      finalEnvironmentInputs: {
        npmConfigCache: path.join(this.paths.cache, 'opencode', 'package-downloads'),
        multimodelDataHome: this.paths.data,
        multimodelCacheHome: this.paths.cache,
        disableAutoUpdate: applyOpenCodeAutoUpdatePolicy({ ...hostEnvironment })
          .OPENCODE_DISABLE_AUTOUPDATE ?? null,
      },
    })
    const policySeed = canonicalFingerprint({
      purpose: plan.purpose,
      providerId,
    })
    const initialFingerprints = {
      project: canonicalFingerprint({
        projectPath,
        projectBehaviorFingerprint: behavior.projectBehaviorFingerprint,
      }),
      model: canonicalFingerprint(modelId),
      policy: policySeed,
      plugin: canonicalFingerprint({
        preservedPlugins,
        automaticUserPluginEntries,
        automaticUserPluginFingerprint,
        dependencySnapshot: expectedPlan?.pluginFingerprint ?? null,
      }),
      version: canonicalFingerprint({
        specs: preservedPlugins.map(plugin => plugin.spec),
        dependencySnapshot: expectedPlan?.pluginFingerprint ?? null,
      }),
      config: canonicalFingerprint(importedRuntimeConfig),
      auth: selectedAuthBaselineFingerprint,
      environment: providerEnvironmentFingerprint,
      binary: binaryFingerprint,
      layout: expectedPlan
        ? canonicalFingerprint({ profileLayoutGeneration, planDigest: expectedPlan.digest })
        : canonicalFingerprint(profileLayoutGeneration),
    }
    const preliminaryPolicy = resolveOpenCodeOperationPolicy({
      purpose: plan.purpose,
      providerId,
      preservedPlugins: policyPreservedPlugins,
      fingerprints: initialFingerprints,
    })
    const appMcpConfig = preliminaryPolicy.appMcp === 'enabled'
      ? await this.resolveManagedAppMcpConfig()
      : null
    const managedConfig = deepMergeOpenCodeConfig(
      importedRuntimeConfig,
      buildManagedConfig(appMcpConfig, {
        allowAutoUpdate: isOpenCodeAutoUpdateAllowed(hostEnvironment),
        defaultModelId: modelId,
        toolApprovalMode: preliminaryPolicy.toolApproval === 'auto' ? 'auto' : undefined,
      }),
    )
    if (preliminaryPolicy.toolApproval === 'none') {
      managedConfig.agent = Object.fromEntries(
        Object.entries(asRecord(managedConfig.agent)).map(([agentName, rawAgent]) => [
          agentName,
          {
            ...asRecord(rawAgent),
            tools: { '*': false },
            permission: { '*': 'deny' },
          },
        ]),
      )
    }
    if (providerId) {
      const providers = asRecord(managedConfig.provider)
      managedConfig.provider = providers[providerId]
        ? { [providerId]: providers[providerId] }
        : {}
    }
    managedConfig.plugin = expectedPlan
      ? expectedPlan.plugins.map(plugin => plugin.executionSpecifier)
      : preliminaryPolicy.plugins.map(plugin => plugin.spec)
    const managedConfigFingerprint = buildManagedConfigFingerprint(managedConfig)
    const policy = resolveOpenCodeOperationPolicy({
      purpose: plan.purpose,
      providerId,
      preservedPlugins: policyPreservedPlugins,
      fingerprints: {
        ...initialFingerprints,
        plugin: canonicalFingerprint({
          plugins: preliminaryPolicy.plugins,
          automaticUserPluginEntries,
          dependencySnapshot: expectedPlan?.pluginFingerprint ?? null,
        }),
        version: canonicalFingerprint({
          specs: preliminaryPolicy.plugins.map(plugin => plugin.spec),
          dependencySnapshot: expectedPlan?.pluginFingerprint ?? null,
        }),
        config: managedConfigFingerprint,
      },
    })
    if (!policy.identity.profileKey || !policy.identity.pluginKey || !policy.identity.cacheKey) {
      throw new Error(`OpenCode operation ${plan.purpose} cannot prepare a scoped profile`)
    }
    if (expectedPlan && 'evidence' in plan) {
      const materialPlugins = policy.plugins.map(policyPlugin => {
        const evidencePlugin = plan.evidence.plugins.find(plugin =>
          plugin.spec.trim() === policyPlugin.spec
          && plugin.provenance === policyPlugin.provenance)
        return evidencePlugin
          ? expectedPlan.plugins.find(plugin =>
              plugin.spec === evidencePlugin.spec.trim()
              && plugin.provenance === evidencePlugin.provenance) ?? null
          : null
      })
      if (
        materialPlugins.some(plugin => plugin === null)
        || canonicalSerializeOpenCodePolicyIdentity(materialPlugins)
          !== canonicalSerializeOpenCodePolicyIdentity(expectedPlan.plugins)
        || expectedPlan.providerEnvironmentFingerprint !== providerEnvironmentFingerprint
        || expectedPlan.selectedAuthFingerprint !== selectedAuthBaselineFingerprint
        || expectedPlan.nativeAccountIdentityFingerprint !== nativeAccountIdentityFingerprint
        || expectedPlan.nativeTargetExecutableFingerprint !== nativeTargetExecutableFingerprint
        || expectedPlan.configFingerprint !== managedConfigFingerprint
      ) throw new Error('OpenCode scoped planned material evidence drifted [redacted]')
    }

    const profileScopeIdentity = canonicalFingerprint(policy.identity.canonicalInput)
    const profileRootKey = profileScopeIdentity
    const profileRootPath = path.join(this.paths.data, 'opencode', 'scoped-profiles', profileRootKey)
    const homePath = path.join(profileRootPath, 'home')
    const tmpPath = path.join(profileRootPath, 'tmp')
    const xdgConfigHome = path.join(profileRootPath, 'config')
    const xdgDataHome = path.join(profileRootPath, 'data')
    const xdgCacheHome = path.join(
      this.paths.cache,
      'opencode',
      'scoped',
      policy.identity.cacheKey.split(':').at(-1)!,
    )
    const pluginNodeModulesPath = path.join(xdgConfigHome, 'opencode', 'node_modules')
    const managedAuthPath = path.join(xdgDataHome, 'opencode', 'auth.json')
    const preparationLockPath = path.join(profileRootPath, `prepare-${policy.identity.operationKey.split(':').at(-1)!}.lock`)

    return await this.withProfilePreparationLock(profileScopeIdentity, async () => {
      await ensureOpenCodeManagedDirectoryPath(homePath, this.paths.data)
      await ensureOpenCodeManagedDirectoryPath(tmpPath, this.paths.data)
      await ensureOpenCodeManagedDirectoryPath(
        path.join(xdgConfigHome, 'opencode'), this.paths.data,
      )
      await ensureOpenCodeManagedDirectoryPath(path.dirname(managedAuthPath), this.paths.data)
      await ensureOpenCodeManagedDirectoryPath(xdgCacheHome, this.paths.cache)
      await assertCanonicalOwnedPathComponents(pluginNodeModulesPath, this.paths.data)
      const projectBehaviorSnapshotPath = path.join(
        profileRootPath,
        expectedEntryManifest.projectBehaviorSnapshotPath,
      )
      const scopedLockDirectory = await OpenCodeSafePublicationDirectory.open(
        path.dirname(preparationLockPath),
      )
      const scopedLockName = path.basename(preparationLockPath)
      await scopedLockDirectory.ensureRegularFile(scopedLockName).catch(async error => {
        await scopedLockDirectory.close()
        throw error
      })
      const releaseScopedLock = await lockfile.lock(
        scopedLockDirectory.child(scopedLockName),
        OPEN_CODE_PROFILE_SYMLINK_LOCK_OPTIONS,
      ).catch(async error => {
        await scopedLockDirectory.close()
        throw error
      })
      try {
        // No user/project bytes are published before the cross-process lock.
        // Contending preparers therefore cannot expose a half-owned snapshot.
        // Re-derive every immutable tree fingerprint, package closure,
        // resolved identity, digest, and host key at the publication boundary.
        // Only the authorized expected-plan snapshot may authorize these bytes.
        const publicationPlan = planScopedProfile(plan)
        if (
          canonicalSerializeOpenCodePolicyIdentity(publicationPlan)
            !== canonicalSerializeOpenCodePolicyIdentity(expectedPlan)
        ) throw new Error('OpenCode scoped publication evidence drifted [redacted]')
        if (automaticUserPluginEntries.length > 0) {
          await publishImmutableUserPluginSnapshot(
            userPluginDirectory,
            path.join(xdgConfigHome, 'opencode', 'plugins'),
            automaticUserPluginEntries,
          )
        }
        if (expectedPlan && 'evidence' in plan) {
          // Materialize only caller-captured regular bytes. No package manager,
          // mutable cache, lifecycle hook, network or original project path is
          // available to the scoped host.
          await publishImmutablePluginDependencySnapshot(
            pluginNodeModulesPath,
            plan.evidence.plugins,
          )
        }
        await publishImmutableProjectBehaviorSnapshot(
          behaviorCapture,
          projectBehaviorSnapshotPath,
          expectedEntryManifest.projectBehaviorEntryManifest,
        )
        const nativeTargetExecutablePath = nativeProofExecutablePath
          ? await publishImmutableNativeExecutable(
              nativeProofExecutablePath,
              profileRootPath,
              nativeTargetExecutableFingerprint,
            )
          : null
        let nativeCredentialBridge: OpenCodeScopedPreparedProfile['nativeCredentialBridge'] = null
        const nativeBridgeProviderId: 'kiro' | 'cursor-acp' | null = providerId === 'kiro'
          ? 'kiro'
          : providerId === 'cursor-acp'
            ? 'cursor-acp'
            : null
        if (nativeBridgeProviderId) {
          const bridgeHostEnvironment = { ...hostEnvironment }
          if (nativeBridgeProviderId === 'cursor-acp') {
            bridgeHostEnvironment.CURSOR_AGENT_EXECUTABLE = nativeTargetExecutablePath!
          } else {
            bridgeHostEnvironment.PATH = `${path.dirname(nativeTargetExecutablePath!)}${path.delimiter}${hostEnvironment.PATH ?? ''}`
          }
          const bridge = await ensureOpenCodeNativeCliCredentialBridge(
            profileRootPath,
            bridgeHostEnvironment,
            process.platform,
            nativeBridgeProviderId,
          )
          const executablePath = nativeBridgeProviderId === 'kiro'
            ? bridge.kiroCliExecutablePath!
            : bridge.cursorAgentExecutablePath!
          nativeCredentialBridge = {
            providerId: nativeBridgeProviderId,
            binPath: bridge.binPath,
            executablePath,
          }
        }
        const managedAuthContent = JSON.stringify(scopedSelectedAuth, null, 2)
        const managedAuthFingerprint = await withOpenCodeSafePublicationDirectory(
          path.dirname(managedAuthPath),
          async directory => {
            await directory.writeFileAtomic(
              path.basename(managedAuthPath), managedAuthContent, 0o600, plan.abortSignal,
            )
            const managedAuthHandle = await open(
              directory.child(path.basename(managedAuthPath)),
              fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
            )
            try {
              const managedAuthBytes = await managedAuthHandle.readFile()
              if (
                canonicalFingerprint(JSON.parse(managedAuthBytes.toString()))
                  !== selectedAuthBaselineFingerprint
              ) throw new Error('OpenCode scoped auth artifact changed before binding')
              return hashBuffer(managedAuthBytes)
            } finally {
              await managedAuthHandle.close()
            }
          },
        )
        const nativeCredentialBridgeFingerprint = await fingerprintOpenCodeNativeCredentialBridge(
          nativeCredentialBridge,
        )
        const env: NodeJS.ProcessEnv = applyOpenCodeAutoUpdatePolicy({
          ...selectScopedInheritedEnvironment(hostEnvironment),
          HOME: homePath,
          USERPROFILE: homePath,
          TMPDIR: tmpPath,
          TMP: tmpPath,
          TEMP: tmpPath,
          XDG_CONFIG_HOME: xdgConfigHome,
          XDG_DATA_HOME: xdgDataHome,
          XDG_CACHE_HOME: xdgCacheHome,
          NPM_CONFIG_CACHE: path.join(this.paths.cache, 'opencode', 'package-downloads'),
          [CLAUDE_MULTIMODEL_DATA_HOME_ENV]: this.paths.data,
          [CLAUDE_MULTIMODEL_CACHE_HOME_ENV]: this.paths.cache,
          OPENCODE_DISABLE_CLAUDE_CODE: '1',
          OPENCODE_CONFIG_CONTENT: JSON.stringify(managedConfig),
          OPENCODE_CONFIG_DIR: projectBehaviorSnapshotPath,
          OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        })
        delete env.OPENCODE_CONFIG
        if (nativeCredentialBridge) {
          env.PATH = hostEnvironment.PATH
            ? `${nativeCredentialBridge.binPath}${path.delimiter}${hostEnvironment.PATH}`
            : nativeCredentialBridge.binPath
          if (nativeCredentialBridge.providerId === 'cursor-acp') {
            env.CURSOR_AGENT_EXECUTABLE = nativeCredentialBridge.executablePath
          } else {
            delete env.CURSOR_AGENT_EXECUTABLE
          }
        }
        const executionEnvironmentFingerprint = fingerprintOpenCodeScopedExecutionEnvironment(env)
        const preparedProfile: OpenCodeScopedPreparedProfile = {
          scopeSchema: 'opencode-scoped-profile-v1',
          policy,
          purpose: policy.purpose,
          providerId: policy.providerScope.kind === 'provider' ? policy.providerScope.providerId : null,
          modelId,
          runtimeInstanceId,
          canonicalProjectPathFingerprint: canonicalFingerprint(projectPath),
          executionProjectPath: projectBehaviorSnapshotPath,
          profileLayoutGeneration,
          scopedPlanDigest: expectedPlan.digest,
          plannedHostKey: expectedPlan.expectedHostKey,
          operationKey: policy.identity.operationKey,
          profileKey: policy.identity.profileKey!,
          pluginKey: policy.identity.pluginKey!,
          cacheKey: policy.identity.cacheKey!,
          profileScopeIdentity,
          selectedAuthBaselineFingerprint,
          providerEnvironmentFingerprint,
          nativeCredentialBridgeInputFingerprint: nativeBridgeInputFingerprint,
          nativeCredentialBridgeFingerprint,
          nativeTargetExecutableFingerprint,
          nativeTargetExecutablePath,
          nativeCredentialHostHomePath: nativeTargetCommand ? nativeCredentialHostHomePath : null,
          nativeAccountEvidenceFingerprint,
          executionEnvironmentFingerprint,
          expectedEntryManifest,
          expectedEntryManifestFingerprint,
          automaticUserPluginFingerprint,
          binaryPath: await realpath(binaryPath).catch(() => path.resolve(binaryPath)),
          binaryFingerprint,
          pluginNodeModulesPath,
          preparationLockPath,
          projectPath,
          profileRootKey,
          profileRootPath,
          projectBehaviorFingerprint: behavior.projectBehaviorFingerprint,
          behaviorSources: behavior.behaviorSources,
          managedConfig,
          managedConfigFingerprint,
          homePath,
          tmpPath,
          xdgConfigHome,
          xdgDataHome,
          xdgCacheHome,
          globalAuthPath,
          managedAuthPath,
          sourceAuthPath: null,
          sourceAuthFingerprint: selectedAuthBaselineFingerprint,
          managedAuthFingerprint,
          authState: Object.keys(scopedSelectedAuth).length > 0 ? 'ok' : 'missing',
          nativeCredentialBridge,
          env,
        }
        return preparedProfile
      } finally {
        await releaseScopedLock()
        await scopedLockDirectory.close()
      }
    })
    } finally {
      await behaviorCapture?.close()
      await releaseEarlyPreparationLock()
      await earlyLockDirectory.close()
    }
  }

  /** @deprecated Compatibility only; scoped callers must use prepareScopedProfile. */
  async prepareProfile(
    projectPath?: string | null,
    options: OpenCodePrepareProfileOptions = {},
  ): Promise<OpenCodePreparedProfile> {
    const resolvedProjectPath = this.getProjectPath(projectPath)
    const profileRootKey = this.getProfileRootKey(resolvedProjectPath)
    return this.withProfilePreparationLock(profileRootKey, async () => {
    if (options.abortSignal?.aborted) throwOpenCodeAbortReason(options.abortSignal)
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
    const effectiveModelLimitOverrides = {
      ...globalRuntimePreferences.modelLimitOverrides,
      ...managedRuntimePreferences.modelLimitOverrides,
    }
    const importedRuntimeConfig = await readSafeOpenCodeRuntimeConfigImport(process.env)
    const appMcpConfig =
      options.includeAppMcp === false
        ? null
        : await this.resolveManagedAppMcpConfig()
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
        allowAutoUpdate: isOpenCodeAutoUpdateAllowed(process.env),
        defaultModelId: effectiveManagedDefaultModelId,
        toolApprovalMode: options.toolApprovalMode,
      }),
    )
    applyOpenCodeModelLimitOverrides(managedConfig, effectiveModelOutputLimitOverrides)
    if (options.includeManagedSubscriptionPlugins !== false) {
      applyOpenCodeManagedSubscriptionPlugins(managedConfig)
    }
    applyManagedPathEnvironmentToMcpConfig(managedConfig, {
      [CLAUDE_MULTIMODEL_DATA_HOME_ENV]: this.paths.data,
      [CLAUDE_MULTIMODEL_CACHE_HOME_ENV]: this.paths.cache,
    })
    const managedConfigFingerprint = buildManagedConfigFingerprint(managedConfig)
    const homePath = path.join(profileRootPath, 'home')
    const tmpPath = path.join(profileRootPath, 'tmp')
    const xdgConfigHome = path.join(profileRootPath, 'config')
    const xdgDataHome = path.join(profileRootPath, 'data')
    const xdgCacheHome = path.join(this.paths.cache, 'opencode', 'shared-cache')
    const sharedNpmCachePath = path.join(xdgCacheHome, 'npm')
    const sharedToolCachePath = path.join(xdgCacheHome, 'tools')
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
      nativeCliCredentialBridge = await ensureOpenCodeNativeCliCredentialBridge(profileRootPath)
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
      peerManagedAuthPaths: await this.listManagedAuthPaths(),
      abortSignal: options.abortSignal,
    })
    if (nativeCliCredentialBridge) {
      await Promise.all([
        ensureOpenCodeCursorPluginAuthCredential({
          globalAuthPath,
          managedAuthPath,
          cursorAgentExecutablePath: nativeCliCredentialBridge.cursorAgentExecutablePath!,
        }),
        ensureOpenCodeKiroPluginAuthCredential({
          globalAuthPath,
          managedAuthPath,
          kiroCliExecutablePath: nativeCliCredentialBridge.kiroCliExecutablePath!,
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
      ...process.env,
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
      [CLAUDE_MULTIMODEL_DATA_HOME_ENV]: this.paths.data,
      [CLAUDE_MULTIMODEL_CACHE_HOME_ENV]: this.paths.cache,
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify(managedConfig),
    }
    if (nativeCliCredentialBridge) {
      env.PATH = [nativeCliCredentialBridge.binPath, process.env.PATH]
        .filter((value): value is string => Boolean(value))
        .join(path.delimiter)
      env.CURSOR_ACP_HOME_DIR =
        process.env.CURSOR_ACP_HOME_DIR?.trim() || nativeCliCredentialBridge.hostHomePath
      env.CURSOR_AGENT_EXECUTABLE =
        nativeCliCredentialBridge.cursorAgentExecutablePath!
    }
    delete env.OPENCODE_CONFIG
    if (options.abortSignal?.aborted) throwOpenCodeAbortReason(options.abortSignal)

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
      tmpPath,
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
    }, options.abortSignal)
  }
}

export const openCodeProfileManager = new OpenCodeProfileManager()
