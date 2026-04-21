import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import envPaths from 'env-paths'

import { getCwd } from '../../utils/cwd.js'
import type { OpenCodePreparedProfile } from './types.js'

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function hashBuffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
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

export function buildManagedConfig(): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    default_agent: 'teammate',
    share: 'disabled',
    autoupdate: false,
    snapshot: false,
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
        },
      },
    },
    // Keep project/global plugin config untouched. OpenCode merges inline config as overrides,
    // so setting plugin here would shadow user and project extension points.
  }
}

export class OpenCodeProfileManager {
  private readonly paths = envPaths('claude-multimodel')

  private getSourceAuthPath(): string {
    const xdgDataHome =
      process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share')
    return path.join(xdgDataHome, 'opencode', 'auth.json')
  }

  private getProjectPath(projectPath?: string | null): string {
    return path.resolve(projectPath?.trim() || getCwd())
  }

  private getProfileRootKey(projectPath: string): string {
    return hashString(projectPath).slice(0, 16)
  }

  async prepareProfile(projectPath?: string | null): Promise<OpenCodePreparedProfile> {
    const resolvedProjectPath = this.getProjectPath(projectPath)
    const profileRootKey = this.getProfileRootKey(resolvedProjectPath)
    const { projectBehaviorFingerprint, behaviorSources } =
      await collectProjectBehaviorMetadata(resolvedProjectPath)
    const managedConfig = buildManagedConfig()
    const managedConfigFingerprint = hashString(JSON.stringify(managedConfig))
    const profileRootPath = path.join(
      this.paths.data,
      'opencode',
      'profiles',
      profileRootKey,
    )
    const homePath = path.join(profileRootPath, 'home')
    const xdgConfigHome = path.join(profileRootPath, 'config')
    const xdgDataHome = path.join(profileRootPath, 'data')
    const xdgCacheHome = path.join(this.paths.cache, 'opencode', 'shared-cache')
    const managedAuthPath = path.join(xdgDataHome, 'opencode', 'auth.json')
    const sourceAuthPath = this.getSourceAuthPath()

    await Promise.all([
      mkdir(homePath, { recursive: true }),
      mkdir(xdgConfigHome, { recursive: true }),
      mkdir(path.join(xdgDataHome, 'opencode'), { recursive: true }),
      mkdir(xdgCacheHome, { recursive: true }),
    ])

    const sourceAuthExists = await fileExists(sourceAuthPath)
    const sourceAuthFingerprint = sourceAuthExists
      ? await readFingerprint(sourceAuthPath)
      : null
    const managedAuthFingerprintBefore = await readFingerprint(managedAuthPath)

    if (
      sourceAuthExists &&
      sourceAuthFingerprint &&
      sourceAuthFingerprint !== managedAuthFingerprintBefore
    ) {
      const sourceAuthContent = await readFile(sourceAuthPath, 'utf8')
      await writeFile(managedAuthPath, sourceAuthContent, 'utf8')
    }

    const managedAuthFingerprint = await readFingerprint(managedAuthPath)

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
      managedAuthPath,
      sourceAuthPath: sourceAuthExists ? sourceAuthPath : null,
      sourceAuthFingerprint,
      managedAuthFingerprint,
      authState: !managedAuthFingerprint
        ? 'missing'
        : !sourceAuthFingerprint || sourceAuthFingerprint === managedAuthFingerprint
          ? 'ok'
          : 'stale',
      env: {
        ...process.env,
        HOME: homePath,
        USERPROFILE: homePath,
        XDG_CONFIG_HOME: xdgConfigHome,
        XDG_DATA_HOME: xdgDataHome,
        XDG_CACHE_HOME: xdgCacheHome,
        OPENCODE_DISABLE_CLAUDE_CODE: '1',
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
        OPENCODE_CONFIG_CONTENT: JSON.stringify(managedConfig),
      },
    }
  }
}

export const openCodeProfileManager = new OpenCodeProfileManager()
