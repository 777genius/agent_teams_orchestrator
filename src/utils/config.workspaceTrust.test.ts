import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { findCanonicalGitRoot, findGitRoot } from './git.js'
import {
  getGlobalConfig,
  isPathTrusted,
  saveGlobalConfig,
  type GlobalConfig,
  type ProjectConfig,
} from './config.js'
import { normalizePathForConfigKey } from './path.js'

let tempDir = ''
let originalGlobalConfig: GlobalConfig

function trustedProjectConfig(existing?: ProjectConfig): ProjectConfig {
  return {
    allowedTools: [],
    mcpContextUris: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    projectOnboardingSeenCount: 0,
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
    ...(existing ?? {}),
    hasTrustDialogAccepted: true,
  }
}

beforeEach(async () => {
  originalGlobalConfig = structuredClone(getGlobalConfig())
  tempDir = await mkdtemp(join(tmpdir(), 'config-workspace-trust-'))
})

afterEach(async () => {
  saveGlobalConfig(current => ({
    ...current,
    projects: originalGlobalConfig.projects,
    teammateMode: originalGlobalConfig.teammateMode,
  }))
  findGitRoot.cache.clear()
  findCanonicalGitRoot.cache.clear()
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = ''
  }
})

describe('workspace trust config lookup', () => {
  async function createTrustedRepo(): Promise<{ repoDir: string; repoKey: string }> {
    const repoDir = join(tempDir, 'repo')
    await mkdir(join(repoDir, '.git'), { recursive: true })

    const repoRealpath = await realpath(repoDir)
    const repoKey = normalizePathForConfigKey(repoRealpath)
    saveGlobalConfig(current => ({
      ...current,
      projects: {
        [repoKey]: trustedProjectConfig(current.projects?.[repoKey]),
      },
    }))
    return { repoDir: repoRealpath, repoKey }
  }

  async function createValidatedWorktree(repoDir: string, name: string): Promise<string> {
    const worktreeDir = join(tempDir, 'worktrees', name)
    const worktreeGitDir = join(repoDir, '.git', 'worktrees', name)
    await mkdir(dirname(worktreeDir), { recursive: true })
    await mkdir(worktreeDir, { recursive: true })
    await mkdir(worktreeGitDir, { recursive: true })
    await writeFile(join(worktreeDir, '.git'), `gitdir: ${worktreeGitDir}\n`, 'utf8')
    await writeFile(join(worktreeGitDir, 'commondir'), '../..\n', 'utf8')
    await writeFile(join(worktreeGitDir, 'gitdir'), `${join(worktreeDir, '.git')}\n`, 'utf8')
    return await realpath(worktreeDir)
  }

  test('trusts a valid git worktree when Claude persisted trust under the canonical repo root', async () => {
    const { repoDir, repoKey } = await createTrustedRepo()
    const worktreeRealpath = await createValidatedWorktree(repoDir, 'alice')
    const worktreeKey = normalizePathForConfigKey(worktreeRealpath)

    expect(worktreeKey).not.toBe(repoKey)
    expect(findCanonicalGitRoot(worktreeRealpath)).toBe(repoDir)

    expect(isPathTrusted(worktreeRealpath)).toBe(true)
  })

  test('does not trust a forged gitdir pointer to a trusted repository', async () => {
    const { repoDir } = await createTrustedRepo()
    const forgedDir = join(tempDir, 'forged')
    await mkdir(forgedDir, { recursive: true })
    await writeFile(join(forgedDir, '.git'), `gitdir: ${join(repoDir, '.git')}\n`, 'utf8')

    expect(findCanonicalGitRoot(forgedDir)).not.toBe(repoDir)
    expect(isPathTrusted(forgedDir)).toBe(false)
  })

  test('does not trust borrowed worktree metadata from a trusted repository', async () => {
    const { repoDir } = await createTrustedRepo()
    const forgedDir = join(tempDir, 'forged-borrowed')
    const borrowedWorktreeGitDir = join(repoDir, '.git', 'worktrees', 'alice')
    await mkdir(forgedDir, { recursive: true })
    await mkdir(borrowedWorktreeGitDir, { recursive: true })
    await writeFile(join(forgedDir, '.git'), `gitdir: ${borrowedWorktreeGitDir}\n`, 'utf8')
    await writeFile(join(borrowedWorktreeGitDir, 'commondir'), '../..\n', 'utf8')
    await writeFile(join(borrowedWorktreeGitDir, 'gitdir'), `${join(repoDir, '.git')}\n`, 'utf8')

    expect(findCanonicalGitRoot(forgedDir)).not.toBe(repoDir)
    expect(isPathTrusted(forgedDir)).toBe(false)
  })
})
