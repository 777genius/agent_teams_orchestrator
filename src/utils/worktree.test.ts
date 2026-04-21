import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { resetStateForTests, setCwdState, setOriginalCwd } from '../bootstrap/state.js'
import {
  cleanupStaleAgentWorktrees,
  createTeammateWorktree,
  removeAgentWorktree,
} from './worktree.js'

let repoDir = ''
let remoteDir = ''

function runGit(args: string[], cwd = repoDir): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
  }
  return result.stdout.trim()
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

async function makeHeadReachableFromRemote(): Promise<void> {
  remoteDir = await mkdtemp(join(tmpdir(), 'teammate-worktree-remote-'))
  runGit(['init', '--bare'], remoteDir)
  runGit(['remote', 'add', 'origin', remoteDir], repoDir)
  runGit(['push', '-u', 'origin', 'HEAD:main'], repoDir)
}

describe('createTeammateWorktree', () => {
  beforeEach(async () => {
    resetStateForTests()
    repoDir = await mkdtemp(join(tmpdir(), 'teammate-worktree-'))
    runGit(['init'], repoDir)
    runGit(['config', 'user.email', 'tests@example.com'], repoDir)
    runGit(['config', 'user.name', 'Teammate Worktree Tests'], repoDir)
    await writeFile(join(repoDir, 'tracked.txt'), 'committed\n', 'utf8')
    runGit(['add', '.'], repoDir)
    runGit(['commit', '-m', 'initial'], repoDir)
    setOriginalCwd(repoDir)
    setCwdState(repoDir)
  })

  afterEach(async () => {
    resetStateForTests()
    if (repoDir) {
      await rm(repoDir, { recursive: true, force: true })
      repoDir = ''
    }
    if (remoteDir) {
      await rm(remoteDir, { recursive: true, force: true })
      remoteDir = ''
    }
  })

  test('creates from current HEAD and warns without copying dirty leader changes', async () => {
    const head = runGit(['rev-parse', 'HEAD'], repoDir)
    await writeFile(join(repoDir, 'tracked.txt'), 'dirty\n', 'utf8')

    const worktree = await createTeammateWorktree('team-atlas-alice-test')

    expect(worktree.headCommit).toBe(head)
    expect(worktree.gitRoot).toBe(repoDir)
    expect(worktree.baseWorkspaceRoot).toBe(repoDir)
    expect(worktree.dirtyLeaderWarning).toContain('uncommitted changes')
    expect(await readFile(join(worktree.worktreePath, 'tracked.txt'), 'utf8')).toBe(
      'committed\n',
    )

    await removeAgentWorktree(
      worktree.worktreePath,
      worktree.worktreeBranch,
      worktree.gitRoot,
      worktree.hookBased,
    )
  })

  test('stale cleanup removes clean teammate worktrees', async () => {
    await makeHeadReachableFromRemote()
    const worktree = await createTeammateWorktree('team-atlas-alice-12345678')

    const removed = await cleanupStaleAgentWorktrees(new Date(Date.now() + 1000))

    expect(removed).toBe(1)
    expect(await pathExists(worktree.worktreePath)).toBe(false)
  })

  test('stale cleanup preserves teammate worktrees with untracked files', async () => {
    await makeHeadReachableFromRemote()
    const worktree = await createTeammateWorktree('team-atlas-bob-12345678')
    const untrackedPath = join(worktree.worktreePath, 'untracked.txt')
    await writeFile(untrackedPath, 'keep me\n', 'utf8')

    const removed = await cleanupStaleAgentWorktrees(new Date(Date.now() + 1000))

    expect(removed).toBe(0)
    expect(await pathExists(untrackedPath)).toBe(true)

    await removeAgentWorktree(
      worktree.worktreePath,
      worktree.worktreeBranch,
      worktree.gitRoot,
      worktree.hookBased,
    )
  })
})
