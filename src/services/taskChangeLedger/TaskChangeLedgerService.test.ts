import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { access, mkdtemp, readFile, rm, writeFile, mkdir, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

import { setCwdState, setOriginalCwd, switchSession } from '../../bootstrap/state.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { getRuntimeBoardTaskExecutionStore } from '../boardTaskActivity/RuntimeBoardTaskExecutionStore.js'
import type { BoardTaskLocator, BoardTaskPhase } from '../boardTaskActivity/contract.js'
import {
  captureTaskChangeToolResult,
  clearDeferredTaskChangeShellSnapshotsForTests,
  completeDeferredTaskChangeShellSnapshot,
  deferTaskChangeShellSnapshot,
  finishTaskChangeShellSnapshot,
  maybeBeginTaskChangeShellSnapshot,
} from './TaskChangeLedgerService.js'
import {
  TASK_CHANGE_BASE_WORKSPACE_ROOT_ENV,
  TASK_CHANGE_LEDGER_PROJECT_DIR_ENV,
  TASK_CHANGE_WORKTREE_BRANCH_ENV,
  TASK_CHANGE_WORKTREE_DIRTY_WARNING_ENV,
  TASK_CHANGE_WORKTREE_PATH_ENV,
} from './env.js'
import { clearDynamicTeamContext, setDynamicTeamContext } from '../../utils/teammate.js'

let repoDir = ''
let sessionId = 'session-1'
let configDir = ''
let previousClaudeConfigDir: string | undefined
let previousLedgerProjectDir: string | undefined
let previousWorktreePath: string | undefined
let previousWorktreeBranch: string | undefined
let previousBaseWorkspaceRoot: string | undefined
let previousWorktreeDirtyWarning: string | undefined
const MAX_TASK_ID_ARTIFACT_SEGMENT_LENGTH = 120
setDefaultTimeout(20_000)

function runGit(args: string[], cwd = repoDir): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
  }
  return result.stdout.trim()
}

async function writeRepoFile(relativePath: string, content: string | Buffer): Promise<string> {
  const filePath = join(repoDir, relativePath)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content)
  return filePath
}

async function createGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'task-change-ledger-'))
  runGit(['init'], dir)
  runGit(['config', 'user.email', 'tests@example.com'], dir)
  runGit(['config', 'user.name', 'Task Change Ledger Tests'], dir)
  return runGit(['rev-parse', '--show-toplevel'], dir)
}

async function commitAll(message: string): Promise<void> {
  runGit(['add', '.'])
  runGit(['commit', '-m', message])
}

function setRepoContext(dir: string): void {
  repoDir = dir
  sessionId = `session-${Math.random().toString(36).slice(2)}`
  setOriginalCwd(dir)
  setCwdState(dir)
  switchSession(sessionId as never, dir)
  setDynamicTeamContext({
    agentId: 'alice@test',
    agentName: 'alice',
    teamName: 'ledger-test-team',
    planModeRequired: false,
  })
}

function openScope(taskId: string, phase: BoardTaskPhase = 'work', agentId = 'alice@test'): void {
  const locator: BoardTaskLocator = {
    ref: taskId,
    refKind: 'canonical',
    canonicalId: taskId,
  }
  getRuntimeBoardTaskExecutionStore().applyTransitions(sessionId, agentId, [
    { type: 'open', phase, task: locator },
  ])
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8')
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const raw = await readFile(filePath, 'utf8')
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as T)
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function runProcess(args: string[], cwd = repoDir): Promise<void> {
  const result = spawnSync(args[0]!, args.slice(1), {
    cwd,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(
      `${args.join(' ')} exited with code ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
  }
}

function getPowerShellExecutable(): string | null {
  for (const candidate of process.platform === 'win32'
    ? ['pwsh.exe', 'powershell.exe']
    : ['pwsh']) {
    const result = spawnSync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion'], {
      encoding: 'utf8',
    })
    if (result.status === 0) {
      return candidate
    }
  }
  return null
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function isWindowsReservedArtifactSegment(segment: string): boolean {
  const stem = segment.split('.')[0]?.toUpperCase() ?? ''
  return (
    !segment ||
    stem === 'CON' ||
    stem === 'PRN' ||
    stem === 'AUX' ||
    stem === 'NUL' ||
    /^COM[1-9]$/.test(stem) ||
    /^LPT[1-9]$/.test(stem)
  )
}

function encodeTaskId(taskId: string): string {
  const encoded = encodeURIComponent(taskId)
  return isWindowsReservedArtifactSegment(encoded) ||
    encoded.length > MAX_TASK_ID_ARTIFACT_SEGMENT_LENGTH
    ? `task-id-${createHash('sha256').update(taskId).digest('hex').slice(0, 32)}`
    : encoded
}

function expectedLedgerKeyPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}

function bundlePath(taskId: string): string {
  return join(repoDir, '.board-task-changes', 'bundles', `${encodeTaskId(taskId)}.json`)
}

function eventsPath(taskId: string): string {
  return join(repoDir, '.board-task-changes', 'events', `${encodeTaskId(taskId)}.jsonl`)
}

function noticesPath(taskId: string): string {
  return join(repoDir, '.board-task-changes', 'notices', `${encodeTaskId(taskId)}.jsonl`)
}

function freshnessPath(taskId: string): string {
  return join(repoDir, '.board-task-change-freshness', `${encodeTaskId(taskId)}.json`)
}

function deferredProjectSnapshotPath(backgroundTaskId: string): string {
  return join(
    repoDir,
    '.board-task-changes',
    'pending-shell-snapshots',
    `${encodeTaskId(backgroundTaskId)}.json`,
  )
}

function deferredGlobalPointerPath(backgroundTaskId: string): string {
  return join(
    configDir,
    'task-change-ledger',
    'pending-shell-snapshots',
    `${encodeTaskId(backgroundTaskId)}.json`,
  )
}

function lockDir(taskId: string): string {
  return join(repoDir, '.board-task-changes', 'locks', `${encodeTaskId(taskId)}.lock`)
}

function lockOwnerPath(taskId: string): string {
  return join(lockDir(taskId), 'owner.json')
}

function blobPath(blobRef: string): string {
  return join(repoDir, '.board-task-changes', 'blobs', blobRef)
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

beforeEach(async () => {
  getRuntimeBoardTaskExecutionStore().clearForTests()
  clearDeferredTaskChangeShellSnapshotsForTests()
  previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
  previousLedgerProjectDir = process.env[TASK_CHANGE_LEDGER_PROJECT_DIR_ENV]
  previousWorktreePath = process.env[TASK_CHANGE_WORKTREE_PATH_ENV]
  previousWorktreeBranch = process.env[TASK_CHANGE_WORKTREE_BRANCH_ENV]
  previousBaseWorkspaceRoot = process.env[TASK_CHANGE_BASE_WORKSPACE_ROOT_ENV]
  previousWorktreeDirtyWarning = process.env[TASK_CHANGE_WORKTREE_DIRTY_WARNING_ENV]
  configDir = await mkdtemp(join(tmpdir(), 'task-change-ledger-config-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
  repoDir = await createGitRepo()
  setRepoContext(repoDir)
})

afterEach(async () => {
  getRuntimeBoardTaskExecutionStore().clearForTests()
  clearDeferredTaskChangeShellSnapshotsForTests()
  clearDynamicTeamContext()
  if (repoDir) {
    await rm(repoDir, { recursive: true, force: true })
  }
  if (configDir) {
    await rm(configDir, { recursive: true, force: true })
  }
  if (previousClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir
  }
  if (previousLedgerProjectDir === undefined) {
    delete process.env[TASK_CHANGE_LEDGER_PROJECT_DIR_ENV]
  } else {
    process.env[TASK_CHANGE_LEDGER_PROJECT_DIR_ENV] = previousLedgerProjectDir
  }
  if (previousWorktreePath === undefined) {
    delete process.env[TASK_CHANGE_WORKTREE_PATH_ENV]
  } else {
    process.env[TASK_CHANGE_WORKTREE_PATH_ENV] = previousWorktreePath
  }
  if (previousWorktreeBranch === undefined) {
    delete process.env[TASK_CHANGE_WORKTREE_BRANCH_ENV]
  } else {
    process.env[TASK_CHANGE_WORKTREE_BRANCH_ENV] = previousWorktreeBranch
  }
  if (previousBaseWorkspaceRoot === undefined) {
    delete process.env[TASK_CHANGE_BASE_WORKSPACE_ROOT_ENV]
  } else {
    process.env[TASK_CHANGE_BASE_WORKSPACE_ROOT_ENV] = previousBaseWorkspaceRoot
  }
  if (previousWorktreeDirtyWarning === undefined) {
    delete process.env[TASK_CHANGE_WORKTREE_DIRTY_WARNING_ENV]
  } else {
    process.env[TASK_CHANGE_WORKTREE_DIRTY_WARNING_ENV] = previousWorktreeDirtyWarning
  }
})

describe('TaskChangeLedgerService integration', () => {
  test('captures exact write create and rewrite into bundle v2 without storing events[]', async () => {
    const agentId = 'alice@test'
    openScope('task-write', 'work', agentId)

    await captureTaskChangeToolResult({
      toolName: FILE_WRITE_TOOL_NAME,
      resultData: {
        filePath: 'src/new.ts',
        content: 'export const value = 1;\n',
        type: 'create',
      },
      toolUseId: 'tool-write-create',
      sessionId,
      agentId,
    })

    await captureTaskChangeToolResult({
      toolName: FILE_WRITE_TOOL_NAME,
      resultData: {
        filePath: 'src/new.ts',
        content: 'export const value = 2;\n',
        originalFile: 'export const value = 1;\n',
        type: 'rewrite',
      },
      toolUseId: 'tool-write-rewrite',
      sessionId,
      agentId,
    })

    const bundle = await readJson<Record<string, unknown>>(bundlePath('task-write'))
    const events = await readJsonl<Array<Record<string, unknown>>[number]>(eventsPath('task-write'))

    expect(bundle.schemaVersion).toBe(2)
    expect('events' in bundle).toBe(false)
    expect((bundle.scope as Record<string, unknown>).memberName).toBe('alice')
    expect((bundle.scope as Record<string, unknown>).primaryMemberName).toBe('alice')
    expect(
      ((bundle.scope as Record<string, unknown>).contributors as Array<Record<string, unknown>>)[0]
        ?.memberName,
    ).toBe('alice')
    expect((bundle.files as Array<Record<string, unknown>>)).toHaveLength(1)
    expect((bundle.files as Array<Record<string, unknown>>)[0]?.createdInTask).toBe(true)
    expect((bundle.files as Array<Record<string, unknown>>)[0]?.latestOperation).toBe('modify')
    expect((bundle.files as Array<Record<string, unknown>>)[0]?.changeKey).toBe(
      `path:${expectedLedgerKeyPath(join(repoDir, 'src', 'new.ts'))}`,
    )
    expect(events).toHaveLength(2)
    expect(events[0]?.memberName).toBe('alice')
    expect(events[1]?.memberName).toBe('alice')
  })

  test('writes centralized ledger artifacts while preserving worktree file metadata', async () => {
    const agentId = 'alice@test'
    const worktreeDir = await mkdtemp(join(tmpdir(), 'task-change-ledger-worktree-'))
    const dirtyWarning =
      'Leader workspace had uncommitted changes when this teammate worktree was created; the worktree starts from committed HEAD only.'
    process.env[TASK_CHANGE_LEDGER_PROJECT_DIR_ENV] = repoDir
    process.env[TASK_CHANGE_WORKTREE_PATH_ENV] = worktreeDir
    process.env[TASK_CHANGE_WORKTREE_BRANCH_ENV] = 'worktree-team-atlas-alice-12345678'
    process.env[TASK_CHANGE_BASE_WORKSPACE_ROOT_ENV] = repoDir
    process.env[TASK_CHANGE_WORKTREE_DIRTY_WARNING_ENV] = dirtyWarning
    setCwdState(worktreeDir)
    openScope('task-worktree-ledger', 'work', agentId)

    await captureTaskChangeToolResult({
      toolName: FILE_WRITE_TOOL_NAME,
      resultData: {
        filePath: 'src/worktree.ts',
        content: 'export const isolated = true;\n',
        type: 'create',
      },
      toolUseId: 'tool-worktree-write',
      sessionId,
      agentId,
    })

    const bundle = await readJson<Record<string, unknown>>(bundlePath('task-worktree-ledger'))
    const events = await readJsonl<Array<Record<string, unknown>>[number]>(
      eventsPath('task-worktree-ledger'),
    )
    const files = bundle.files as Array<Record<string, unknown>>
    const scope = bundle.scope as Record<string, unknown>

    expect(files[0]?.filePath).toBe(join(worktreeDir, 'src', 'worktree.ts'))
    expect(files[0]?.worktreePath).toBe(worktreeDir)
    expect(files[0]?.worktreeBranch).toBe('worktree-team-atlas-alice-12345678')
    expect(files[0]?.baseWorkspaceRoot).toBe(repoDir)
    expect(files[0]?.dirtyLeaderWarning).toBe(dirtyWarning)
    expect(scope.worktreePaths).toEqual([worktreeDir])
    expect(scope.worktreeBranches).toEqual(['worktree-team-atlas-alice-12345678'])
    expect(bundle.warnings).toContain(dirtyWarning)
    expect(events[0]?.workspaceRoot).toBe(worktreeDir)
    expect(events[0]?.worktreePath).toBe(worktreeDir)

    await rm(worktreeDir, { recursive: true, force: true })
  })

  test('ignores inherited worktree metadata when the workspace root is outside the worktree', async () => {
    const agentId = 'alice@test'
    const worktreeDir = await mkdtemp(join(tmpdir(), 'task-change-ledger-worktree-'))
    const outsideDir = await mkdtemp(join(tmpdir(), 'task-change-ledger-outside-'))
    const dirtyWarning =
      'Leader workspace had uncommitted changes when this teammate worktree was created; the worktree starts from committed HEAD only.'
    process.env[TASK_CHANGE_LEDGER_PROJECT_DIR_ENV] = repoDir
    process.env[TASK_CHANGE_WORKTREE_PATH_ENV] = worktreeDir
    process.env[TASK_CHANGE_WORKTREE_BRANCH_ENV] = 'worktree-team-atlas-alice-12345678'
    process.env[TASK_CHANGE_BASE_WORKSPACE_ROOT_ENV] = repoDir
    process.env[TASK_CHANGE_WORKTREE_DIRTY_WARNING_ENV] = dirtyWarning
    setCwdState(outsideDir)
    openScope('task-worktree-env-outside', 'work', agentId)

    await captureTaskChangeToolResult({
      toolName: FILE_WRITE_TOOL_NAME,
      resultData: {
        filePath: 'src/outside.ts',
        content: 'export const outside = true;\n',
        type: 'create',
      },
      toolUseId: 'tool-outside-write',
      sessionId,
      agentId,
    })

    const bundle = await readJson<Record<string, unknown>>(
      bundlePath('task-worktree-env-outside'),
    )
    const files = bundle.files as Array<Record<string, unknown>>
    const scope = bundle.scope as Record<string, unknown>

    expect(files[0]?.filePath).toBe(join(outsideDir, 'src', 'outside.ts'))
    expect(files[0]?.worktreePath).toBeUndefined()
    expect(scope.worktreePaths).toBeUndefined()
    expect(bundle.warnings).not.toContain(dirtyWarning)

    await rm(worktreeDir, { recursive: true, force: true })
    await rm(outsideDir, { recursive: true, force: true })
  })

  test('persists deferred worktree snapshot records under the centralized ledger project dir', async () => {
    const agentId = 'alice@test'
    const backgroundTaskId = 'bg-worktree-centralized'
    const worktreeDir = await createGitRepo()
    const worktreePendingPath = join(
      worktreeDir,
      '.board-task-changes',
      'pending-shell-snapshots',
      `${encodeTaskId(backgroundTaskId)}.json`,
    )
    process.env[TASK_CHANGE_LEDGER_PROJECT_DIR_ENV] = repoDir
    process.env[TASK_CHANGE_WORKTREE_PATH_ENV] = worktreeDir
    process.env[TASK_CHANGE_WORKTREE_BRANCH_ENV] = 'worktree-team-atlas-alice-12345678'
    process.env[TASK_CHANGE_BASE_WORKSPACE_ROOT_ENV] = repoDir
    setCwdState(worktreeDir)
    openScope('task-worktree-deferred-centralized', 'work', agentId)
    await mkdir(join(worktreeDir, 'src'), { recursive: true })
    await writeFile(join(worktreeDir, 'src', 'background.ts'), 'export const value = 1;\n')
    runGit(['add', '.'], worktreeDir)
    runGit(['commit', '-m', 'initial commit'], worktreeDir)

    const snapshot = await maybeBeginTaskChangeShellSnapshot({
      toolName: BASH_TOOL_NAME,
      input: { command: 'background edit src/background.ts' },
      toolUseId: 'tool-worktree-deferred',
      sessionId,
      agentId,
    })
    await deferTaskChangeShellSnapshot(backgroundTaskId, snapshot)

    expect(await pathExists(deferredProjectSnapshotPath(backgroundTaskId))).toBe(true)
    expect(await pathExists(deferredGlobalPointerPath(backgroundTaskId))).toBe(true)
    expect(await pathExists(worktreePendingPath)).toBe(false)
    const persistedPointer = await readJson<Record<string, unknown>>(
      deferredGlobalPointerPath(backgroundTaskId),
    )
    expect(persistedPointer.projectDir).toBe(repoDir)
    expect(persistedPointer.projectRecordPath).toBe(deferredProjectSnapshotPath(backgroundTaskId))
    expect(Date.parse(String(persistedPointer.expiresAt))).toBeGreaterThan(Date.now())
    const persistedRecord = await readJson<Record<string, unknown>>(
      deferredProjectSnapshotPath(backgroundTaskId),
    )
    expect((persistedRecord.snapshot as Record<string, unknown>).beforeHead).toBe(
      runGit(['rev-parse', 'HEAD'], worktreeDir),
    )
    expect((persistedRecord.snapshot as Record<string, unknown>).gitRoot).toBe(worktreeDir)
    expect((persistedRecord.snapshot as Record<string, unknown>).workspaceRoot).toBe(worktreeDir)
    expect(
      ((persistedRecord.snapshot as Record<string, unknown>).scope as Record<string, unknown>)
        .taskId,
    ).toBe('task-worktree-deferred-centralized')

    clearDeferredTaskChangeShellSnapshotsForTests()
    await writeFile(join(worktreeDir, 'src', 'background.ts'), 'export const value = 2;\n')
    expect(runGit(['status', '--porcelain'], worktreeDir)).toContain('src/background.ts')
    expect(runGit(['show', 'HEAD:src/background.ts'], worktreeDir)).toBe('export const value = 1;')
    expect(await readFile(join(worktreeDir, 'src', 'background.ts'), 'utf8')).toBe(
      'export const value = 2;\n',
    )
    await completeDeferredTaskChangeShellSnapshot(backgroundTaskId, 'succeeded')
    expect(await pathExists(deferredGlobalPointerPath(backgroundTaskId))).toBe(false)

    const events = await readJsonl<Array<Record<string, unknown>>[number]>(
      eventsPath('task-worktree-deferred-centralized'),
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.filePath).toBe(join(worktreeDir, 'src', 'background.ts'))
    expect(events[0]?.worktreePath).toBe(worktreeDir)
    expect(events[0]?.warnings).toEqual(
      expect.arrayContaining([
        'Task change ledger recovered a deferred shell snapshot from disk after in-memory state was unavailable.',
      ]),
    )
    expect(await pathExists(deferredProjectSnapshotPath(backgroundTaskId))).toBe(false)
    expect(await pathExists(deferredGlobalPointerPath(backgroundTaskId))).toBe(false)

    await rm(worktreeDir, { recursive: true, force: true })
  })

  test('keeps identical relative rename relations isolated per worktree', async () => {
    const taskId = 'task-worktree-relation-isolation'
    const worktreeA = await createGitRepo()
    const worktreeB = await createGitRepo()
    process.env[TASK_CHANGE_LEDGER_PROJECT_DIR_ENV] = repoDir
    process.env[TASK_CHANGE_BASE_WORKSPACE_ROOT_ENV] = repoDir

    for (const [index, worktreeDir] of [worktreeA, worktreeB].entries()) {
      const agentId = index === 0 ? 'alice@test' : 'bob@test'
      process.env[TASK_CHANGE_WORKTREE_PATH_ENV] = worktreeDir
      process.env[TASK_CHANGE_WORKTREE_BRANCH_ENV] =
        `worktree-team-atlas-${index === 0 ? 'alice' : 'bob'}-12345678`
      setCwdState(worktreeDir)
      openScope(taskId, 'work', agentId)
      await mkdir(join(worktreeDir, 'src'), { recursive: true })
      await writeFile(
        join(worktreeDir, 'src', 'old.ts'),
        `export const value = ${index};\n`,
        'utf8',
      )
      runGit(['add', '.'], worktreeDir)
      runGit(['commit', '-m', 'initial commit'], worktreeDir)

      const snapshot = await maybeBeginTaskChangeShellSnapshot({
        toolName: BASH_TOOL_NAME,
        input: { command: 'mv src/old.ts src/new.ts' },
        toolUseId: `tool-worktree-rename-${index}`,
        sessionId,
        agentId,
      })
      runGit(['mv', 'src/old.ts', 'src/new.ts'], worktreeDir)
      await finishTaskChangeShellSnapshot(snapshot, 'succeeded')
    }

    const bundle = await readJson<Record<string, unknown>>(bundlePath(taskId))
    const files = bundle.files as Array<Record<string, unknown>>
    expect(files).toHaveLength(2)
    const normalizeKey = (filePath: string): string => {
      const normalized = filePath.replace(/\\/g, '/')
      return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
        ? normalized.toLowerCase()
        : normalized
    }
    expect(new Set(files.map(file => file.changeKey))).toEqual(
      new Set([
        `rename:${normalizeKey(worktreeA)}:src/old.ts->src/new.ts`,
        `rename:${normalizeKey(worktreeB)}:src/old.ts->src/new.ts`,
      ]),
    )
    expect(files.map(file => file.worktreePath).sort()).toEqual(
      [worktreeA, worktreeB].sort(),
    )

    await rm(worktreeA, { recursive: true, force: true })
    await rm(worktreeB, { recursive: true, force: true })
  })

  test('uses short hashed artifact names for very long task ids', async () => {
    const agentId = 'alice@test'
    const taskId = `task-${'x'.repeat(180)}`
    openScope(taskId, 'work', agentId)

    await captureTaskChangeToolResult({
      toolName: FILE_WRITE_TOOL_NAME,
      resultData: {
        filePath: 'src/long-task.ts',
        content: 'export const longTask = true;\n',
        type: 'create',
      },
      toolUseId: 'tool-long-task-write',
      sessionId,
      agentId,
    })

    const expectedSegment = `task-id-${createHash('sha256').update(taskId).digest('hex').slice(0, 32)}`
    const bundle = await readJson<Record<string, unknown>>(bundlePath(taskId))

    expect(bundle.taskId).toBe(taskId)
    expect(encodeTaskId(taskId)).toBe(expectedSegment)
  })

  test('captures bash create/delete via deferred background completion', async () => {
    const agentId = 'alice@test'
    openScope('task-shell-background', 'work', agentId)
    await writeRepoFile('src/old.ts', 'export const oldValue = 1;\n')
    await commitAll('initial commit')

    const snapshot = await maybeBeginTaskChangeShellSnapshot({
      toolName: BASH_TOOL_NAME,
      input: { command: 'rm src/old.ts && cat > src/new.ts' },
      toolUseId: 'tool-shell-background',
      sessionId,
      agentId,
    })

    await unlink(join(repoDir, 'src', 'old.ts'))
    await writeRepoFile('src/new.ts', 'export const newValue = 2;\n')

    await deferTaskChangeShellSnapshot('bg-task-1', snapshot)
    await completeDeferredTaskChangeShellSnapshot('bg-task-1', 'succeeded')

    const bundle = await readJson<Record<string, unknown>>(bundlePath('task-shell-background'))
    const files = bundle.files as Array<Record<string, unknown>>
    const operations = new Set(files.map(file => file.latestOperation))

    expect(files).toHaveLength(2)
    expect(operations).toEqual(new Set(['create', 'delete']))
    expect(
      files.some(file => file.filePath === join(repoDir, 'src', 'old.ts') && file.deletedInTask === true),
    ).toBe(true)
    expect(
      files.some(file => file.filePath === join(repoDir, 'src', 'new.ts') && file.createdInTask === true),
    ).toBe(true)

    const events = await readJsonl<Array<Record<string, unknown>>[number]>(
      eventsPath('task-shell-background'),
    )
    expect(events).toHaveLength(2)
    expect(new Set(events.map(event => event.toolStatus))).toEqual(new Set(['succeeded']))
    expect(new Set(events.map(event => event.source))).toEqual(new Set(['shell_snapshot']))
  })

  test('persists deferred snapshot artifacts and removes them after memory completion', async () => {
    const agentId = 'alice@test'
    const backgroundTaskId = 'bg-memory-cleanup'
    openScope('task-deferred-memory-cleanup', 'work', agentId)
    await writeRepoFile('src/memory.ts', 'export const value = 1;\n')
    await commitAll('initial commit')

    const snapshot = await maybeBeginTaskChangeShellSnapshot({
      toolName: BASH_TOOL_NAME,
      input: { command: 'edit src/memory.ts' },
      toolUseId: 'tool-memory-cleanup',
      sessionId,
      agentId,
    })

    await writeRepoFile('src/memory.ts', 'export const value = 2;\n')
    await deferTaskChangeShellSnapshot(backgroundTaskId, snapshot)

    expect(await pathExists(deferredProjectSnapshotPath(backgroundTaskId))).toBe(true)
    expect(await pathExists(deferredGlobalPointerPath(backgroundTaskId))).toBe(true)

    await completeDeferredTaskChangeShellSnapshot(backgroundTaskId, 'succeeded')

    expect(await pathExists(deferredProjectSnapshotPath(backgroundTaskId))).toBe(false)
    expect(await pathExists(deferredGlobalPointerPath(backgroundTaskId))).toBe(false)

    const events = await readJsonl<Array<Record<string, unknown>>[number]>(
      eventsPath('task-deferred-memory-cleanup'),
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.toolStatus).toBe('succeeded')
  })

  test('continues memory-only when durable deferred snapshot write fails', async () => {
    const agentId = 'alice@test'
    const backgroundTaskId = 'bg-memory-only'
    openScope('task-deferred-memory-only', 'work', agentId)
    await writeRepoFile('src/memory-only.ts', 'export const value = 1;\n')
    await commitAll('initial commit')
    await writeFile(join(configDir, 'task-change-ledger'), 'not a directory', 'utf8')

    const snapshot = await maybeBeginTaskChangeShellSnapshot({
      toolName: BASH_TOOL_NAME,
      input: { command: 'edit src/memory-only.ts' },
      toolUseId: 'tool-memory-only',
      sessionId,
      agentId,
    })

    await writeRepoFile('src/memory-only.ts', 'export const value = 2;\n')
    await deferTaskChangeShellSnapshot(backgroundTaskId, snapshot)
    await completeDeferredTaskChangeShellSnapshot(backgroundTaskId, 'succeeded')

    const events = await readJsonl<Array<Record<string, unknown>>[number]>(
      eventsPath('task-deferred-memory-only'),
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.warnings).toEqual(
      expect.arrayContaining([
        'Task change ledger could not persist deferred shell snapshot; recovery is memory-only.',
      ]),
    )
    expect(await pathExists(deferredProjectSnapshotPath(backgroundTaskId))).toBe(false)
  })

  test('recovers deferred snapshot from disk and preserves snapshot options', async () => {
    const agentId = 'alice@test'
    const backgroundTaskId = 'bg-recovered-powershell'
    openScope('task-deferred-recovery', 'work', agentId)
    await writeRepoFile('src/keep.ts', 'export const keep = 1;\n')
    await writeRepoFile('src/skip.ts', 'export const skip = 1;\n')
    await commitAll('initial commit')

    const snapshot = await maybeBeginTaskChangeShellSnapshot({
      toolName: 'PowerShell',
      input: { command: 'Set-Content src/keep.ts; Set-Content src/skip.ts' },
      includeNonBashTool: true,
      toolUseId: 'tool-recovery',
      sessionId,
      agentId,
    })

    await writeRepoFile('src/keep.ts', 'export const keep = 2;\n')
    await writeRepoFile('src/skip.ts', 'export const skip = 2;\n')
    await deferTaskChangeShellSnapshot(backgroundTaskId, snapshot, {
      source: 'powershell_snapshot',
      confidence: 'medium',
      excludedFilePaths: [join(repoDir, 'src', 'skip.ts')],
    })
    clearDeferredTaskChangeShellSnapshotsForTests()

    await completeDeferredTaskChangeShellSnapshot(backgroundTaskId, 'succeeded')

    const events = await readJsonl<Array<Record<string, unknown>>[number]>(
      eventsPath('task-deferred-recovery'),
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.filePath).toBe(join(repoDir, 'src', 'keep.ts'))
    expect(events[0]?.source).toBe('powershell_snapshot')
    expect(events[0]?.confidence).toBe('medium')
    expect(events[0]?.warnings).toEqual(
      expect.arrayContaining([
        'Task change ledger recovered a deferred shell snapshot from disk after in-memory state was unavailable.',
      ]),
    )
    expect(await pathExists(deferredProjectSnapshotPath(backgroundTaskId))).toBe(false)
    expect(await pathExists(deferredGlobalPointerPath(backgroundTaskId))).toBe(false)
  })

  test('captures a real background process mutation after deferred disk recovery', async () => {
    const agentId = 'alice@test'
    const backgroundTaskId = 'bg-real-process'
    openScope('task-real-background-process', 'work', agentId)
    await writeRepoFile('src/real-process.ts', 'export const value = 1;\n')
    await commitAll('initial commit')

    const snapshot = await maybeBeginTaskChangeShellSnapshot({
      toolName: BASH_TOOL_NAME,
      input: { command: 'background process edits src/real-process.ts' },
      toolUseId: 'tool-real-process',
      sessionId,
      agentId,
    })
    await deferTaskChangeShellSnapshot(backgroundTaskId, snapshot)
    clearDeferredTaskChangeShellSnapshotsForTests()

    await runProcess([
      process.execPath,
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(
        join(repoDir, 'src', 'real-process.ts'),
      )}, 'export const value = 2;\\n')`,
    ])
    await completeDeferredTaskChangeShellSnapshot(backgroundTaskId, 'succeeded')

    const events = await readJsonl<Array<Record<string, unknown>>[number]>(
      eventsPath('task-real-background-process'),
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.filePath).toBe(join(repoDir, 'src', 'real-process.ts'))
    expect(events[0]?.toolStatus).toBe('succeeded')
    expect(events[0]?.warnings).toEqual(
      expect.arrayContaining([
        'Task change ledger recovered a deferred shell snapshot from disk after in-memory state was unavailable.',
      ]),
    )
  })

  test('captures a real PowerShell background mutation after deferred disk recovery when available', async () => {
    const powerShell = getPowerShellExecutable()
    if (!powerShell) {
      return
    }

    const agentId = 'alice@test'
    const backgroundTaskId = 'bg-real-powershell'
    openScope('task-real-powershell-process', 'work', agentId)
    await writeRepoFile('src/real-powershell.ts', 'export const value = 1;\n')
    await commitAll('initial commit')

    const snapshot = await maybeBeginTaskChangeShellSnapshot({
      toolName: 'PowerShell',
      input: { command: 'Set-Content src/real-powershell.ts' },
      includeNonBashTool: true,
      toolUseId: 'tool-real-powershell',
      sessionId,
      agentId,
    })
    await deferTaskChangeShellSnapshot(backgroundTaskId, snapshot, {
      source: 'powershell_snapshot',
    })
    clearDeferredTaskChangeShellSnapshotsForTests()

    await runProcess([
      powerShell,
      '-NoProfile',
      '-Command',
      `Start-Sleep -Milliseconds 25; Set-Content -LiteralPath ${quotePowerShellString(
        join(repoDir, 'src', 'real-powershell.ts'),
      )} -Value ${quotePowerShellString('export const value = 2;')} -NoNewline`,
    ])
    await completeDeferredTaskChangeShellSnapshot(backgroundTaskId, 'succeeded')

    const events = await readJsonl<Array<Record<string, unknown>>[number]>(
      eventsPath('task-real-powershell-process'),
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.filePath).toBe(join(repoDir, 'src', 'real-powershell.ts'))
    expect(events[0]?.source).toBe('powershell_snapshot')
    expect(events[0]?.warnings).toEqual(
      expect.arrayContaining([
        'Task change ledger recovered a deferred shell snapshot from disk after in-memory state was unavailable.',
      ]),
    )
  })

  test('does not attribute files when deferred snapshot pointer is corrupt', async () => {
    const agentId = 'alice@test'
    const backgroundTaskId = 'bg-corrupt-pointer'
    openScope('task-corrupt-pointer', 'work', agentId)
    await writeRepoFile('src/corrupt.ts', 'export const value = 1;\n')
    await commitAll('initial commit')

    const snapshot = await maybeBeginTaskChangeShellSnapshot({
      toolName: BASH_TOOL_NAME,
      input: { command: 'edit src/corrupt.ts' },
      toolUseId: 'tool-corrupt-pointer',
      sessionId,
      agentId,
    })

    await writeRepoFile('src/corrupt.ts', 'export const value = 2;\n')
    await deferTaskChangeShellSnapshot(backgroundTaskId, snapshot)
    clearDeferredTaskChangeShellSnapshotsForTests()
    await writeFile(deferredGlobalPointerPath(backgroundTaskId), '{bad-json', 'utf8')

    await completeDeferredTaskChangeShellSnapshot(backgroundTaskId, 'succeeded')

    expect(await pathExists(eventsPath('task-corrupt-pointer'))).toBe(false)
    expect(await pathExists(deferredGlobalPointerPath(backgroundTaskId))).toBe(false)
  })

  test('cleans stale deferred pointer when project snapshot record is missing', async () => {
    const agentId = 'alice@test'
    const backgroundTaskId = 'bg-missing-record'
    openScope('task-missing-record', 'work', agentId)
    await writeRepoFile('src/missing-record.ts', 'export const value = 1;\n')
    await commitAll('initial commit')

    const snapshot = await maybeBeginTaskChangeShellSnapshot({
      toolName: BASH_TOOL_NAME,
      input: { command: 'edit src/missing-record.ts' },
      toolUseId: 'tool-missing-record',
      sessionId,
      agentId,
    })

    await writeRepoFile('src/missing-record.ts', 'export const value = 2;\n')
    await deferTaskChangeShellSnapshot(backgroundTaskId, snapshot)
    clearDeferredTaskChangeShellSnapshotsForTests()
    await rm(deferredProjectSnapshotPath(backgroundTaskId), { force: true })

    await completeDeferredTaskChangeShellSnapshot(backgroundTaskId, 'succeeded')

    expect(await pathExists(eventsPath('task-missing-record'))).toBe(false)
    expect(await pathExists(deferredGlobalPointerPath(backgroundTaskId))).toBe(false)
  })

  test('ignores and cleans expired deferred snapshot records', async () => {
    const agentId = 'alice@test'
    const backgroundTaskId = 'bg-expired-record'
    openScope('task-expired-record', 'work', agentId)
    await writeRepoFile('src/expired.ts', 'export const value = 1;\n')
    await commitAll('initial commit')

    const snapshot = await maybeBeginTaskChangeShellSnapshot({
      toolName: BASH_TOOL_NAME,
      input: { command: 'edit src/expired.ts' },
      toolUseId: 'tool-expired-record',
      sessionId,
      agentId,
    })

    await writeRepoFile('src/expired.ts', 'export const value = 2;\n')
    await deferTaskChangeShellSnapshot(backgroundTaskId, snapshot)
    clearDeferredTaskChangeShellSnapshotsForTests()

    const record = await readJson<Record<string, unknown>>(
      deferredProjectSnapshotPath(backgroundTaskId),
    )
    await writeFile(
      deferredProjectSnapshotPath(backgroundTaskId),
      `${JSON.stringify({
        ...record,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      })}\n`,
      'utf8',
    )

    await completeDeferredTaskChangeShellSnapshot(backgroundTaskId, 'succeeded')

    expect(await pathExists(eventsPath('task-expired-record'))).toBe(false)
    expect(await pathExists(deferredProjectSnapshotPath(backgroundTaskId))).toBe(false)
    expect(await pathExists(deferredGlobalPointerPath(backgroundTaskId))).toBe(false)
  })

  test('lazy cleanup removes expired orphan deferred snapshots on the next defer', async () => {
    const agentId = 'alice@test'
    const orphanBackgroundTaskId = 'bg-orphan-expired'
    openScope('task-orphan-cleanup', 'work', agentId)
    await writeRepoFile('src/orphan.ts', 'export const value = 1;\n')
    await commitAll('initial commit')

    const orphanSnapshot = await maybeBeginTaskChangeShellSnapshot({
      toolName: BASH_TOOL_NAME,
      input: { command: 'edit src/orphan.ts' },
      toolUseId: 'tool-orphan',
      sessionId,
      agentId,
    })
    await deferTaskChangeShellSnapshot(orphanBackgroundTaskId, orphanSnapshot)
    clearDeferredTaskChangeShellSnapshotsForTests()

    const expiredAt = new Date(Date.now() - 1000).toISOString()
    const orphanRecord = await readJson<Record<string, unknown>>(
      deferredProjectSnapshotPath(orphanBackgroundTaskId),
    )
    const orphanPointer = await readJson<Record<string, unknown>>(
      deferredGlobalPointerPath(orphanBackgroundTaskId),
    )
    await writeJson(deferredProjectSnapshotPath(orphanBackgroundTaskId), {
      ...orphanRecord,
      expiresAt: expiredAt,
    })
    await writeJson(deferredGlobalPointerPath(orphanBackgroundTaskId), {
      ...orphanPointer,
      expiresAt: expiredAt,
    })

    const nextSnapshot = await maybeBeginTaskChangeShellSnapshot({
      toolName: BASH_TOOL_NAME,
      input: { command: 'edit src/orphan.ts again' },
      toolUseId: 'tool-orphan-next',
      sessionId,
      agentId,
    })
    await deferTaskChangeShellSnapshot('bg-orphan-next', nextSnapshot)

    expect(await pathExists(deferredProjectSnapshotPath(orphanBackgroundTaskId))).toBe(false)
    expect(await pathExists(deferredGlobalPointerPath(orphanBackgroundTaskId))).toBe(false)
    expect(await pathExists(deferredProjectSnapshotPath('bg-orphan-next'))).toBe(true)
  })

  test('does not overwrite an active durable pointer when background task ids collide', async () => {
    const agentId = 'alice@test'
    const backgroundTaskId = 'bg-collision'
    openScope('task-collision-first', 'work', agentId)
    await writeRepoFile('src/collision-first.ts', 'export const value = 1;\n')
    await commitAll('initial commit')

    const firstSnapshot = await maybeBeginTaskChangeShellSnapshot({
      toolName: BASH_TOOL_NAME,
      input: { command: 'edit src/collision-first.ts' },
      toolUseId: 'tool-collision-first',
      sessionId,
      agentId,
    })
    await deferTaskChangeShellSnapshot(backgroundTaskId, firstSnapshot)
    clearDeferredTaskChangeShellSnapshotsForTests()
    const firstRecord = await readJson<Record<string, unknown>>(
      deferredProjectSnapshotPath(backgroundTaskId),
    )

    getRuntimeBoardTaskExecutionStore().clearForTests()
    openScope('task-collision-second', 'work', agentId)
    await writeRepoFile('src/collision-second.ts', 'export const value = 1;\n')
    const secondSnapshot = await maybeBeginTaskChangeShellSnapshot({
      toolName: BASH_TOOL_NAME,
      input: { command: 'edit src/collision-second.ts' },
      toolUseId: 'tool-collision-second',
      sessionId,
      agentId,
    })

    await writeRepoFile('src/collision-second.ts', 'export const value = 2;\n')
    await deferTaskChangeShellSnapshot(backgroundTaskId, secondSnapshot)

    const firstRecordAfterCollision = await readJson<Record<string, unknown>>(
      deferredProjectSnapshotPath(backgroundTaskId),
    )
    expect(firstRecordAfterCollision).toEqual(firstRecord)

    await completeDeferredTaskChangeShellSnapshot(backgroundTaskId, 'succeeded')

    const secondEvents = await readJsonl<Array<Record<string, unknown>>[number]>(
      eventsPath('task-collision-second'),
    )
    expect(secondEvents).toHaveLength(1)
    expect(secondEvents[0]?.filePath).toBe(join(repoDir, 'src', 'collision-second.ts'))
    expect(secondEvents[0]?.warnings).toEqual(
      expect.arrayContaining([
        'Task change ledger could not persist deferred shell snapshot; recovery is memory-only.',
      ]),
    )
    expect(await pathExists(deferredProjectSnapshotPath(backgroundTaskId))).toBe(true)
    expect(await pathExists(deferredGlobalPointerPath(backgroundTaskId))).toBe(true)
  })

  test('uses safe artifact paths for reserved deferred background task ids', async () => {
    const agentId = 'alice@test'
    const backgroundTaskId = 'CON'
    const expectedSegment = `task-id-${createHash('sha256')
      .update(backgroundTaskId)
      .digest('hex')
      .slice(0, 32)}`
    openScope('task-reserved-background-id', 'work', agentId)

    const snapshot = await maybeBeginTaskChangeShellSnapshot({
      toolName: BASH_TOOL_NAME,
      input: { command: 'touch src/reserved.ts' },
      toolUseId: 'tool-reserved-background-id',
      sessionId,
      agentId,
    })

    await deferTaskChangeShellSnapshot(backgroundTaskId, snapshot)

    expect(deferredProjectSnapshotPath(backgroundTaskId)).toContain(
      `${expectedSegment}.json`,
    )
    expect(deferredGlobalPointerPath(backgroundTaskId)).toContain(
      `${expectedSegment}.json`,
    )
    expect(await pathExists(deferredProjectSnapshotPath(backgroundTaskId))).toBe(true)
    expect(await pathExists(deferredGlobalPointerPath(backgroundTaskId))).toBe(true)
  })

  test('records failed and killed statuses for deferred background snapshots', async () => {
    const agentId = 'alice@test'
    const cases: Array<['failed' | 'killed', string]> = [
      ['failed', 'task-deferred-failed'],
      ['killed', 'task-deferred-killed'],
    ]

    for (const [status, taskId] of cases) {
      getRuntimeBoardTaskExecutionStore().clearForTests()
      openScope(taskId, 'work', agentId)
      await writeRepoFile(`src/${status}.ts`, 'export const value = 1;\n')

      const snapshot = await maybeBeginTaskChangeShellSnapshot({
        toolName: BASH_TOOL_NAME,
        input: { command: `edit src/${status}.ts` },
        toolUseId: `tool-${status}`,
        sessionId,
        agentId,
      })

      await writeRepoFile(`src/${status}.ts`, 'export const value = 2;\n')
      await deferTaskChangeShellSnapshot(`bg-${status}`, snapshot)
      await completeDeferredTaskChangeShellSnapshot(`bg-${status}`, status)

      const events = await readJsonl<Array<Record<string, unknown>>[number]>(
        eventsPath(taskId),
      )
      expect(events).toHaveLength(1)
      expect(events[0]?.toolStatus).toBe(status)
    }
  })

  test('captures rename relation through powershell snapshot mode', async () => {
    const agentId = 'alice@test'
    openScope('task-powershell-rename', 'work', agentId)
    await writeRepoFile('src/old.ts', 'export const renamed = true;\n')
    await commitAll('initial commit')

    const snapshot = await maybeBeginTaskChangeShellSnapshot({
      toolName: 'PowerShell',
      input: { command: 'Rename-Item src/old.ts src/new.ts' },
      includeNonBashTool: true,
      toolUseId: 'tool-powershell',
      sessionId,
      agentId,
    })

    runGit(['mv', 'src/old.ts', 'src/new.ts'])
    await finishTaskChangeShellSnapshot(snapshot, 'succeeded', {
      source: 'powershell_snapshot',
    })

    const bundle = await readJson<Record<string, unknown>>(bundlePath('task-powershell-rename'))
    const file = (bundle.files as Array<Record<string, unknown>>)[0]
    const events = await readJsonl<Array<Record<string, unknown>>[number]>(
      eventsPath('task-powershell-rename'),
    )
    expect(bundle.totalFiles).toBe(1)
    expect(file?.filePath).toBe(join(repoDir, 'src', 'new.ts'))
    expect(file?.relation).toEqual({
      kind: 'rename',
      oldPath: 'src/old.ts',
      newPath: 'src/new.ts',
    })
    expect(file?.changeKey).toBe('rename:src/old.ts->src/new.ts')
    expect(events[0]?.source).toBe('powershell_snapshot')
  })

  test('captures copy relation through committed diff snapshots', async () => {
    const agentId = 'alice@test'
    openScope('task-copy', 'work', agentId)
    await writeRepoFile('src/base.ts', 'export const copied = true;\n')
    await commitAll('initial commit')

    const snapshot = await maybeBeginTaskChangeShellSnapshot({
      toolName: BASH_TOOL_NAME,
      input: { command: 'cp src/base.ts src/copy.ts && git add src/copy.ts && git commit' },
      toolUseId: 'tool-copy',
      sessionId,
      agentId,
    })

    await writeRepoFile('src/copy.ts', 'export const copied = true;\n')
    runGit(['add', 'src/copy.ts'])
    await commitAll('copy file')
    await finishTaskChangeShellSnapshot(snapshot, 'succeeded')

    const bundle = await readJson<Record<string, unknown>>(bundlePath('task-copy'))
    const files = bundle.files as Array<Record<string, unknown>>
    expect(files).toHaveLength(1)
    expect(files[0]?.filePath).toBe(join(repoDir, 'src', 'copy.ts'))
    expect(files[0]?.changeKey).toBe('copy:src/base.ts->src/copy.ts')
    expect(files[0]?.relation).toEqual({
      kind: 'copy',
      oldPath: 'src/base.ts',
      newPath: 'src/copy.ts',
    })

    const events = await readJsonl<Array<Record<string, unknown>>[number]>(eventsPath('task-copy'))
    expect(events).toHaveLength(1)
    expect(events[0]?.relation).toEqual({
      kind: 'copy',
      oldPath: 'src/base.ts',
      newPath: 'src/copy.ts',
    })
    const after = events[0]?.after as { blobRef?: string } | undefined
    expect(after?.blobRef).toBeDefined()
    const storedAfter = await readFile(blobPath(after!.blobRef!), 'utf8')
    expect(storedAfter).toBe('export const copied = true;\n')
  })

  test('persists binary and too-large shell changes as metadata-only states', async () => {
    const agentId = 'alice@test'
    openScope('task-binary-large', 'work', agentId)

    await writeRepoFile('fixtures/blob.bin', Buffer.from([0, 1, 2, 3]))
    await writeRepoFile('fixtures/large.txt', 'a'.repeat(1024 * 1024 + 8))
    await commitAll('initial commit')

    const snapshot = await maybeBeginTaskChangeShellSnapshot({
      toolName: BASH_TOOL_NAME,
      input: { command: 'mutate binary and large files' },
      toolUseId: 'tool-binary-large',
      sessionId,
      agentId,
    })

    await writeRepoFile('fixtures/blob.bin', Buffer.from([4, 0, 6, 7]))
    await writeRepoFile('fixtures/large.txt', 'b'.repeat(1024 * 1024 + 16))
    await finishTaskChangeShellSnapshot(snapshot, 'succeeded')

    const bundle = await readJson<Record<string, unknown>>(bundlePath('task-binary-large'))
    const files = bundle.files as Array<Record<string, unknown>>
    const binaryFile = files.find(file => file.filePath === join(repoDir, 'fixtures', 'blob.bin'))
    const largeFile = files.find(file => file.filePath === join(repoDir, 'fixtures', 'large.txt'))
    expect(binaryFile?.reviewability).toBe('metadata-only')
    expect(binaryFile?.contentAvailability).toBe('hash-only')
    expect((binaryFile?.latestAfterState as Record<string, unknown>)?.unavailableReason).toBe(
      'binary file',
    )

    expect(largeFile?.reviewability).toBe('metadata-only')
    expect(largeFile?.contentAvailability).toBe('metadata-only')
    expect(
      String((largeFile?.latestAfterState as Record<string, unknown>)?.unavailableReason),
    ).toContain('ledger limit')
  })

  test('emits notices only when multiple active scopes are open for the same actor', async () => {
    const agentId = 'alice@test'
    openScope('task-ambiguous-a', 'work', agentId)
    openScope('task-ambiguous-b', 'review', agentId)

    const written = await captureTaskChangeToolResult({
      toolName: FILE_EDIT_TOOL_NAME,
      resultData: {
        filePath: 'src/ambiguous.ts',
        originalFile: 'before\n',
        updatedFile: 'after\n',
        oldString: 'before',
        actualNewString: 'after',
      },
      toolUseId: 'tool-ambiguous',
      sessionId,
      agentId,
    })

    expect(written).toEqual([])

    const firstBundle = await readJson<Record<string, unknown>>(bundlePath('task-ambiguous-a'))
    const secondBundle = await readJson<Record<string, unknown>>(bundlePath('task-ambiguous-b'))
    expect(firstBundle.files).toEqual([])
    expect(secondBundle.files).toEqual([])
    expect(firstBundle.warnings).toEqual([
      'Task change ledger skipped attribution because multiple task scopes were active.',
    ])
    expect(secondBundle.warnings).toEqual([
      'Task change ledger skipped attribution because multiple task scopes were active.',
    ])

    const firstNotices = await readJsonl<Array<Record<string, unknown>>[number]>(
      noticesPath('task-ambiguous-a'),
    )
    const secondNotices = await readJsonl<Array<Record<string, unknown>>[number]>(
      noticesPath('task-ambiguous-b'),
    )
    expect(firstNotices[0]?.code).toBe('multi-scope-skipped')
    expect(secondNotices[0]?.code).toBe('multi-scope-skipped')
  })

  test('stores final disk bytes after post-hook mutation even when the tool failed', async () => {
    const agentId = 'alice@test'
    openScope('task-post-hook', 'work', agentId)
    const filePath = await writeRepoFile('src/post-hook.ts', 'const value=1\n')

    await writeFile(filePath, 'const value = 1;\n')

    await captureTaskChangeToolResult({
      toolName: FILE_EDIT_TOOL_NAME,
      resultData: {
        filePath,
        originalFile: 'const value=1\n',
        updatedFile: 'const value = 1\n',
        oldString: 'const value=1',
        actualNewString: 'const value = 1',
      },
      toolUseId: 'tool-post-hook',
      sessionId,
      agentId,
      toolStatus: 'failed',
      materializePostHookDiskState: true,
    })

    const events = await readJsonl<Array<Record<string, unknown>>[number]>(eventsPath('task-post-hook'))
    expect(events).toHaveLength(1)
    expect(events[0]?.toolStatus).toBe('failed')
    expect(events[0]?.confidence).toBe('high')
    expect((events[0]?.warnings as string[])[0]).toContain('PostToolUse hooks changed')

    const after = events[0]?.after as { blobRef?: string } | null
    expect(after?.blobRef).toBeDefined()
    const storedAfter = await readFile(blobPath(after!.blobRef!), 'utf8')
    expect(storedAfter).toBe('const value = 1;\n')
  })

  test('writes partial freshness when bundle materialization fails', async () => {
    const agentId = 'alice@test'
    openScope('task-partial-freshness', 'work', agentId)

    await captureTaskChangeToolResult({
      toolName: FILE_WRITE_TOOL_NAME,
      resultData: {
        filePath: 'src/first.ts',
        content: 'export const first = 1;\n',
        type: 'create',
      },
      toolUseId: 'tool-first',
      sessionId,
      agentId,
    })

    const bundleFilePath = bundlePath('task-partial-freshness')
    await rm(bundleFilePath, { recursive: true, force: true })
    await mkdir(bundleFilePath, { recursive: true })
    try {
      const written = await captureTaskChangeToolResult({
        toolName: FILE_WRITE_TOOL_NAME,
        resultData: {
          filePath: 'src/second.ts',
          content: 'export const second = 2;\n',
          type: 'create',
        },
        toolUseId: 'tool-second',
        sessionId,
        agentId,
      })

      expect(written).toEqual([])
      const freshness = await readJson<Record<string, unknown>>(freshnessPath('task-partial-freshness'))
      expect(freshness.integrity).toBe('partial')
      expect(freshness.eventCount).toBe(2)
    } finally {
      await rm(bundleFilePath, { recursive: true, force: true })
    }
  })

  test('emits a stale-lock notice when the writer lock is stolen before rebuild', async () => {
    const agentId = 'alice@test'
    openScope('task-lock-stolen', 'work', agentId)
    await mkdir(lockDir('task-lock-stolen'), { recursive: true, mode: 0o700 })
    await writeFile(
      lockOwnerPath('task-lock-stolen'),
      JSON.stringify({
        ownerId: 'stale-owner',
        pid: process.pid,
        sessionId: 'stale-session',
        taskId: 'task-lock-stolen',
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      'utf8',
    )

    await captureTaskChangeToolResult({
      toolName: FILE_WRITE_TOOL_NAME,
      resultData: {
        filePath: 'src/lock.ts',
        content: 'export const lock = true;\n',
        type: 'create',
      },
      toolUseId: 'tool-lock',
      sessionId,
      agentId,
    })

    const notices = await readJsonl<Array<Record<string, unknown>>[number]>(
      noticesPath('task-lock-stolen'),
    )
    expect(notices.some(notice => notice.code === 'writer-lock-stolen')).toBe(true)

    const bundle = await readJson<Record<string, unknown>>(bundlePath('task-lock-stolen'))
    expect(bundle.warnings).toEqual(
      expect.arrayContaining([
        'Task change ledger stole a stale writer lock before rebuilding the summary.',
      ]),
    )
  })

  test('marks the bundle recovered after malformed journal lines are encountered', async () => {
    const agentId = 'alice@test'
    openScope('task-recovered', 'work', agentId)

    await captureTaskChangeToolResult({
      toolName: FILE_WRITE_TOOL_NAME,
      resultData: {
        filePath: 'src/ok.ts',
        content: 'export const ok = true;\n',
        type: 'create',
      },
      toolUseId: 'tool-recovered-initial',
      sessionId,
      agentId,
    })

    await writeFile(eventsPath('task-recovered'), '\n{"bad-json"', {
      flag: 'a',
    })

    await captureTaskChangeToolResult({
      toolName: FILE_WRITE_TOOL_NAME,
      resultData: {
        filePath: 'src/trigger.ts',
        content: 'export const trigger = true;\n',
        type: 'create',
      },
      toolUseId: 'tool-recovered-trigger',
      sessionId,
      agentId,
    })

    const bundle = await readJson<Record<string, unknown>>(bundlePath('task-recovered'))
    expect(bundle.integrity).toBe('recovered')
    expect(bundle.warnings).toEqual(
      expect.arrayContaining(['Task change ledger recovered from malformed journal lines.']),
    )
  })

  test('projects same-timestamp events in journal append order instead of eventId order', async () => {
    const agentId = 'alice@test'
    openScope('task-append-order', 'work', agentId)

    await captureTaskChangeToolResult({
      toolName: FILE_WRITE_TOOL_NAME,
      resultData: {
        filePath: 'src/order.ts',
        content: 'export const step = 1;\n',
        type: 'create',
      },
      toolUseId: 'tool-order-create',
      sessionId,
      agentId,
    })

    await captureTaskChangeToolResult({
      toolName: FILE_WRITE_TOOL_NAME,
      resultData: {
        filePath: 'src/order.ts',
        content: 'export const step = 2;\n',
        originalFile: 'export const step = 1;\n',
        type: 'rewrite',
      },
      toolUseId: 'tool-order-rewrite',
      sessionId,
      agentId,
    })

    const existingEvents = await readJsonl<Array<Record<string, unknown>>[number]>(
      eventsPath('task-append-order'),
    )
    const rewrittenEvents = existingEvents.map((event, index) => ({
      ...event,
      timestamp: '2026-01-01T00:00:00.000Z',
      eventId: index === 0 ? 'z-event' : 'a-event',
    }))
    await writeFile(
      eventsPath('task-append-order'),
      `${rewrittenEvents.map(event => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    )

    await captureTaskChangeToolResult({
      toolName: FILE_WRITE_TOOL_NAME,
      resultData: {
        filePath: 'src/trigger.ts',
        content: 'export const trigger = 1;\n',
        type: 'create',
      },
      toolUseId: 'tool-order-trigger',
      sessionId,
      agentId,
    })

    const bundle = await readJson<Record<string, unknown>>(bundlePath('task-append-order'))
    const files = bundle.files as Array<Record<string, unknown>>
    const orderFile = files.find(file => file.filePath === join(repoDir, 'src', 'order.ts'))

    expect(orderFile).toBeDefined()
    expect(orderFile?.latestAfterHash).toBe(sha256('export const step = 2;\n'))
    expect(orderFile?.latestOperation).toBe('modify')
    expect(orderFile?.createdInTask).toBe(true)
  })

  test('falls back to status and disk evidence when HEAD rewrites to a non-descendant commit', async () => {
    const agentId = 'alice@test'
    openScope('task-non-descendant', 'work', agentId)

    await writeRepoFile('src/head.ts', 'export const base = 1;\n')
    await commitAll('base commit')
    const baseHead = runGit(['rev-parse', 'HEAD'])

    await writeRepoFile('src/head.ts', 'export const main = true;\n')
    runGit(['add', 'src/head.ts'])
    await commitAll('main commit')
    runGit(['branch', 'side', baseHead])

    const snapshot = await maybeBeginTaskChangeShellSnapshot({
      toolName: BASH_TOOL_NAME,
      input: { command: 'git checkout side && edit src/head.ts' },
      toolUseId: 'tool-non-descendant',
      sessionId,
      agentId,
    })

    runGit(['checkout', 'side'])
    await writeRepoFile('src/head.ts', 'export const side = true;\n')
    await finishTaskChangeShellSnapshot(snapshot, 'succeeded')

    const bundle = await readJson<Record<string, unknown>>(bundlePath('task-non-descendant'))
    const files = bundle.files as Array<Record<string, unknown>>
    expect(files).toHaveLength(1)
    expect(files[0]?.filePath).toBe(join(repoDir, 'src', 'head.ts'))
    expect(files[0]?.latestAfterHash).toBe(sha256('export const side = true;\n'))
    expect(bundle.warnings).toEqual(
      expect.arrayContaining([
        'Git HEAD changed but is not a descendant of the command start HEAD; committed diff skipped.',
      ]),
    )

    const events = await readJsonl<Array<Record<string, unknown>>[number]>(
      eventsPath('task-non-descendant'),
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.warnings).toEqual(
      expect.arrayContaining([
        'Git HEAD changed but is not a descendant of the command start HEAD; committed diff skipped.',
      ]),
    )
  })
})
