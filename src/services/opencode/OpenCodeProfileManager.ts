import { createHash } from 'node:crypto'
import { lstat, mkdir, readlink, readdir, readFile, rm, stat, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Dirent } from 'node:fs'

import { getCwd } from '../../utils/cwd.js'
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
  readOpenCodeAuthStore,
  syncOpenCodeManagedAuthStore,
} from './OpenCodeAuthStore.js'
import {
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
} from './types.js'

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

async function ensureDirectorySymlink(linkPath: string, targetPath: string): Promise<void> {
  await mkdir(targetPath, { recursive: true })
  await mkdir(path.dirname(linkPath), { recursive: true })

  try {
    const existing = await lstat(linkPath)
    if (existing.isSymbolicLink()) {
      const currentTarget = await readlink(linkPath)
      const resolvedTarget = path.resolve(path.dirname(linkPath), currentTarget)
      if (resolvedTarget === targetPath) {
        return
      }
    }
    await rm(linkPath, { recursive: true, force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  try {
    await symlink(targetPath, linkPath, 'dir')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
    const currentTarget = await readlink(linkPath)
    const resolvedTarget = path.resolve(path.dirname(linkPath), currentTarget)
    if (resolvedTarget !== targetPath) {
      throw error
    }
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
  } = {},
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    default_agent: 'teammate',
    share: 'disabled',
    snapshot: true,
    agent: {
      teammate: {
        mode: 'primary',
        description: 'Managed teammate agent for claude-multimodel runtime orchestration.',
        permission: {
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
        },
      },
      'teammate-bootstrap': {
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
    if (key === 'environment') {
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

  async prepareProfile(
    projectPath?: string | null,
    options: OpenCodePrepareProfileOptions = {},
  ): Promise<OpenCodePreparedProfile> {
    const resolvedProjectPath = this.getProjectPath(projectPath)
    const profileRootKey = this.getProfileRootKey(resolvedProjectPath)
    const profileRootPath = path.join(
      this.paths.data,
      'opencode',
      'profiles',
      profileRootKey,
    )
    const { projectBehaviorFingerprint, behaviorSources } =
      await collectProjectBehaviorMetadata(resolvedProjectPath)
    const managedRuntimePreferences = await readOpenCodeManagedRuntimePreferences(profileRootPath)
    const managedConfig = buildManagedConfig(await this.resolveManagedAppMcpConfig(), {
      allowAutoUpdate: isOpenCodeAutoUpdateAllowed(process.env),
      defaultModelId: managedRuntimePreferences.defaultModelId,
      modelOutputLimitOverrides: options.modelOutputLimitOverrides,
    })
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
    await ensureDirectorySymlink(profileOpenCodeNodeModulesPath, sharedOpenCodeNodeModulesPath)

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
    for (const authSourcePath of orderOpenCodeAuthSyncSources({
      globalAuthPath,
      globalAuthFingerprint,
      sourceAuthSources,
    })) {
      await syncOpenCodeManagedAuthStore({
        sourceAuthPath: authSourcePath,
        managedAuthPath,
      })
    }

    const managedAuthFingerprint = await readFingerprint(managedAuthPath)
    const authState = await (async () => {
      if (!managedAuthFingerprint) {
        return 'missing' as const
      }
      const authSourcePaths = orderOpenCodeAuthSyncSources({
        globalAuthPath,
        globalAuthFingerprint,
        sourceAuthSources,
      })
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

    return {
      projectPath: resolvedProjectPath,
      profileRootKey,
      profileRootPath,
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
      env: applyOpenCodeAutoUpdatePolicy({
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
      }),
    }
  }
}

export const openCodeProfileManager = new OpenCodeProfileManager()
