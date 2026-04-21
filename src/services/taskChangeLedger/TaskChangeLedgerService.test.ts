import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { mkdtemp, readFile, rm, writeFile, mkdir, unlink } from 'fs/promises'
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
  completeDeferredTaskChangeShellSnapshot,
  deferTaskChangeShellSnapshot,
  finishTaskChangeShellSnapshot,
  maybeBeginTaskChangeShellSnapshot,
} from './TaskChangeLedgerService.js'
import { clearDynamicTeamContext, setDynamicTeamContext } from '../../utils/teammate.js'

let repoDir = ''
let sessionId = 'session-1'

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

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const raw = await readFile(filePath, 'utf8')
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as T)
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
  return isWindowsReservedArtifactSegment(encoded)
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
  repoDir = await createGitRepo()
  setRepoContext(repoDir)
})

afterEach(async () => {
  getRuntimeBoardTaskExecutionStore().clearForTests()
  clearDynamicTeamContext()
  if (repoDir) {
    await rm(repoDir, { recursive: true, force: true })
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

    deferTaskChangeShellSnapshot('bg-task-1', snapshot)
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
