import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { OpenCodeLedgerBridgeService } from './OpenCodeLedgerBridgeService.js'
import { OpenCodeOfflineSessionReader } from './OpenCodeOfflineSessionReader.js'
import { OpenCodeSessionStore } from './OpenCodeSessionStore.js'
import { OpenCodeSnapshotEvidenceProviderService } from './OpenCodeSnapshotEvidenceProvider.js'
import { OpenCodeSnapshotGitStoreReader } from './OpenCodeSnapshotGitStoreReader.js'

import type { OpenCodeSessionRecord } from './types.js'

let tempDir = ''
let homeDir = ''
let previousHome: string | undefined
const LEDGER_CLI_FIXTURE_E2E_TIMEOUT_MS = 15_000
const SNAPSHOT_PROJECT_ID = 'project-fixture'

class FixtureOpenCodeOfflineSessionReader extends OpenCodeOfflineSessionReader {
  constructor(private readonly dbPath: string) {
    super()
  }

  override resolveDbPath(): string {
    return this.dbPath
  }
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-ledger-fixture-e2e-'))
  homeDir = path.join(tempDir, 'home')
  await mkdir(homeDir, { recursive: true })
  previousHome = process.env.HOME
  process.env.HOME = homeDir
})

afterEach(async () => {
  if (previousHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = previousHome
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
  }
})

function sessionRecord(input: {
  sessionId: string
  memberName: string
  workspaceRoot: string
}): OpenCodeSessionRecord {
  return {
    teamId: 'fixture-team',
    laneId: `secondary:opencode:${input.memberName}`,
    memberName: input.memberName,
    providerId: 'opencode',
    selectedModel: 'openai/gpt-5.4',
    projectPath: input.workspaceRoot,
    profileRootKey: 'fixture-profile',
    hostKey: 'host-key',
    resolvedBehaviorFingerprint: 'behavior-v1',
    opencodeSessionId: input.sessionId,
    lastCanonicalCursor: null,
    lastKnownRawStatus: null,
    lastKnownDurableState: 'idle',
    sourceAuthFingerprint: null,
    managedAuthFingerprint: null,
    projectBehaviorFingerprint: 'behavior-v1',
    staleReason: null,
    createdAt: '2026-04-26T10:00:00.000Z',
    updatedAt: '2026-04-26T10:00:00.000Z',
  }
}

function messageData(id: string, parentID?: string): Record<string, unknown> {
  return parentID ? { id, parentID } : { id }
}

function hashFast(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

function runGit(args: string[], cwd: string): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

function userTextPart(text: string): Record<string, unknown> {
  return { type: 'text', text }
}

function writeToolPart(input: {
  filePath: string
  content: string
  exists: boolean
  status?: 'completed' | 'error'
  callID: string
}): Record<string, unknown> {
  return {
    type: 'tool',
    tool: 'write',
    callID: input.callID,
    state: {
      status: input.status ?? 'completed',
      input: {
        filePath: input.filePath,
        content: input.content,
      },
      metadata: {
        exists: input.exists,
        truncated: false,
      },
      time: { end: 1_000 },
    },
  }
}

function editToolPart(input: {
  filePath: string
  oldString: string
  newString: string
  status?: 'completed' | 'error'
  callID: string
}): Record<string, unknown> {
  return {
    type: 'tool',
    tool: 'edit',
    callID: input.callID,
    state: {
      status: input.status ?? 'completed',
      input: {
        filePath: input.filePath,
        oldString: input.oldString,
        newString: input.newString,
      },
      metadata: {
        truncated: false,
      },
      time: { end: 1_100 },
    },
  }
}

function applyPatchToolPart(input: {
  patch: string
  status?: 'completed' | 'error'
  callID: string
}): Record<string, unknown> {
  return {
    type: 'tool',
    tool: 'apply_patch',
    callID: input.callID,
    state: {
      status: input.status ?? 'completed',
      input: {
        patch: input.patch,
      },
      metadata: {
        truncated: false,
      },
      time: { end: 1_200 },
    },
  }
}

function snapshotStepPart(kind: 'step-start' | 'step-finish', snapshot: string): Record<string, unknown> {
  return {
    type: kind,
    snapshot,
  }
}

function insertMessage(db: Database, input: {
  id: string
  sessionId: string
  time: number
  data: Record<string, unknown>
}): void {
  db.query(
    'insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)',
  ).run(input.id, input.sessionId, input.time, null, JSON.stringify(input.data))
}

function insertPart(db: Database, input: {
  id: string
  messageId: string
  sessionId: string
  time: number
  data: Record<string, unknown>
}): void {
  db.query(
    'insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)',
  ).run(input.id, input.messageId, input.sessionId, input.time, null, JSON.stringify(input.data))
}

async function createOpenCodeSqliteFixture(dataDir: string, workspaceRoot: string): Promise<string> {
  const dbPath = path.join(
    dataDir,
    'opencode',
    'profiles',
    'fixture-profile',
    'data',
    'opencode',
    'opencode.db',
  )
  await mkdir(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  try {
    db.exec(`
      create table project (
        id text primary key,
        worktree text,
        vcs text
      );
      create table session (
        id text primary key,
        project_id text,
        directory text
      );
      create table message (
        id text primary key,
        session_id text not null,
        time_created integer not null,
        time_updated integer,
        data text not null
      );
      create table part (
        id text primary key,
        message_id text not null,
        session_id text not null,
        time_created integer not null,
        time_updated integer,
        data text not null
      );
    `)
    db.query('insert into project (id, worktree, vcs) values (?, ?, ?)').run(
      SNAPSHOT_PROJECT_ID,
      workspaceRoot,
      'git',
    )
    for (const sessionId of ['session-bob', 'session-tom', 'session-ambiguous']) {
      db.query('insert into session (id, project_id, directory) values (?, ?, ?)').run(
        sessionId,
        SNAPSHOT_PROJECT_ID,
        workspaceRoot,
      )
    }

    const deliveryPrompt = (
      inboundMessageId: string,
      memberName: string,
      taskRefs = [{ taskId: 'task-1', displayId: 'abc12345', teamName: 'fixture-team' }],
    ) => [
      '<opencode_app_message_delivery>',
      `<opencode_delivery_context>${JSON.stringify({
        schemaVersion: 1,
        kind: 'opencode-delivery-context',
        teamName: 'fixture-team',
        memberName,
        laneId: `secondary:opencode:${memberName}`,
        inboundMessageId,
        taskRefs,
      })}</opencode_delivery_context>`,
      '</opencode_app_message_delivery>',
      '',
      '<opencode_inbound_app_message>',
      'Implement the assigned task.',
      '</opencode_inbound_app_message>',
    ].join('\n')
    const bobTaskPrompt = deliveryPrompt('bob-user-1', 'bob')
    const tomTaskPrompt = deliveryPrompt('tom-user-1', 'tom')
    const ambiguousPrompt = deliveryPrompt('amb-user-1', 'sam', [
      { taskId: 'task-1', displayId: 'abc12345', teamName: 'fixture-team' },
      { taskId: 'task-2', displayId: 'def67890', teamName: 'fixture-team' },
    ])

    insertMessage(db, { id: 'bob-user-1', sessionId: 'session-bob', time: 900, data: messageData('bob-user-1') })
    insertPart(db, { id: 'bob-user-part-1', messageId: 'bob-user-1', sessionId: 'session-bob', time: 900, data: userTextPart(bobTaskPrompt) })
    insertMessage(db, { id: 'bob-assistant-1', sessionId: 'session-bob', time: 1_000, data: messageData('bob-assistant-1', 'bob-user-1') })
    insertPart(db, {
      id: 'bob-0001-write-index',
      messageId: 'bob-assistant-1',
      sessionId: 'session-bob',
      time: 1_000,
      data: writeToolPart({
        filePath: path.join(workspaceRoot, '227', 'index.html'),
        content: '<main>v1</main>\n',
        exists: false,
        callID: 'call-bob-index',
      }),
    })
    insertPart(db, {
      id: 'bob-0002-write-state',
      messageId: 'bob-assistant-1',
      sessionId: 'session-bob',
      time: 1_010,
      data: writeToolPart({
        filePath: path.join(workspaceRoot, '227', 'state.js'),
        content: 'export const step = 1;\n',
        exists: false,
        callID: 'call-bob-state',
      }),
    })
    insertPart(db, {
      id: 'bob-0003-edit-state',
      messageId: 'bob-assistant-1',
      sessionId: 'session-bob',
      time: 1_020,
      data: editToolPart({
        filePath: path.join(workspaceRoot, '227', 'state.js'),
        oldString: 'step = 1',
        newString: 'step = 2',
        callID: 'call-bob-edit-state',
      }),
    })
    insertPart(db, {
      id: 'bob-error-edit-state',
      messageId: 'bob-assistant-1',
      sessionId: 'session-bob',
      time: 1_030,
      data: editToolPart({
        filePath: path.join(workspaceRoot, '227', 'state.js'),
        oldString: 'step = 2',
        newString: 'step = 3',
        status: 'error',
        callID: 'call-bob-error-edit-state',
      }),
    })

    insertMessage(db, { id: 'tom-user-1', sessionId: 'session-tom', time: 2_000, data: messageData('tom-user-1') })
    insertPart(db, { id: 'tom-user-part-1', messageId: 'tom-user-1', sessionId: 'session-tom', time: 2_000, data: userTextPart(tomTaskPrompt) })
    insertMessage(db, { id: 'tom-assistant-1', sessionId: 'session-tom', time: 2_100, data: messageData('tom-assistant-1', 'tom-user-1') })
    insertPart(db, {
      id: 'tom-write-index-existing',
      messageId: 'tom-assistant-1',
      sessionId: 'session-tom',
      time: 2_100,
      data: writeToolPart({
        filePath: path.join(workspaceRoot, '227', 'index.html'),
        content: '<main>tom</main>\n',
        exists: true,
        callID: 'call-tom-index',
      }),
    })

    insertMessage(db, { id: 'amb-user-1', sessionId: 'session-ambiguous', time: 3_000, data: messageData('amb-user-1') })
    insertPart(db, { id: 'amb-user-part-1', messageId: 'amb-user-1', sessionId: 'session-ambiguous', time: 3_000, data: userTextPart(ambiguousPrompt) })
    insertMessage(db, { id: 'amb-assistant-1', sessionId: 'session-ambiguous', time: 3_100, data: messageData('amb-assistant-1', 'amb-user-1') })
    insertPart(db, {
      id: 'amb-write',
      messageId: 'amb-assistant-1',
      sessionId: 'session-ambiguous',
      time: 3_100,
      data: writeToolPart({
        filePath: path.join(workspaceRoot, '227', 'ambiguous.js'),
        content: 'export const ambiguous = true;\n',
        exists: false,
        callID: 'call-ambiguous',
      }),
    })
  } finally {
    db.close()
  }
  return dbPath
}

function writeSnapshotTree(gitDir: string, workspaceRoot: string): string {
  runGit(['--git-dir', gitDir, '--work-tree', workspaceRoot, 'add', '--all'], tempDir)
  return runGit(['--git-dir', gitDir, '--work-tree', workspaceRoot, 'write-tree'], tempDir)
}

async function createOpenCodeSnapshotGitStoreFixture(input: {
  dbPath: string
  workspaceRoot: string
  includeSnapshotOnlyEdit?: boolean
  includeUnattributedSnapshotFile?: boolean
  includeNewlinePathEdit?: boolean
  includeWriteOverwrite?: boolean
  includeApplyPatchDelete?: boolean
}): Promise<{ fromSnapshot: string; toSnapshot: string; gitDir: string }> {
  const profileDataDir = path.dirname(input.dbPath)
  const gitDir = path.join(profileDataDir, 'snapshot', SNAPSHOT_PROJECT_ID, hashFast(input.workspaceRoot))
  await mkdir(gitDir, { recursive: true })
  runGit(['--git-dir', gitDir, '--work-tree', input.workspaceRoot, 'init'], tempDir)
  runGit(['--git-dir', gitDir, '--work-tree', input.workspaceRoot, 'config', 'core.autocrlf', 'false'], tempDir)

  if (input.includeSnapshotOnlyEdit) {
    await mkdir(path.join(input.workspaceRoot, '227'), { recursive: true })
    await writeFile(path.join(input.workspaceRoot, '227', 'snapshot-only.js'), 'export const snapshot = 1;\n', 'utf8')
  }
  if (input.includeUnattributedSnapshotFile) {
    await mkdir(path.join(input.workspaceRoot, '227'), { recursive: true })
    await writeFile(path.join(input.workspaceRoot, '227', 'formatter-only.js'), 'export const formatted = 1;\n', 'utf8')
  }
  if (input.includeNewlinePathEdit) {
    await mkdir(path.join(input.workspaceRoot, '227'), { recursive: true })
    await writeFile(path.join(input.workspaceRoot, '227', 'new\nline.js'), 'export const newlinePath = 1;\n', 'utf8')
  }
  if (input.includeWriteOverwrite) {
    await mkdir(path.join(input.workspaceRoot, '227'), { recursive: true })
    await writeFile(path.join(input.workspaceRoot, '227', 'rewrite.js'), 'export const rewrite = 1;\n', 'utf8')
  }
  if (input.includeApplyPatchDelete) {
    await mkdir(path.join(input.workspaceRoot, '227'), { recursive: true })
    await writeFile(path.join(input.workspaceRoot, '227', 'delete-me.js'), 'export const remove = 1;\n', 'utf8')
  }
  const fromSnapshot = writeSnapshotTree(gitDir, input.workspaceRoot)
  await mkdir(path.join(input.workspaceRoot, '227'), { recursive: true })
  await writeFile(path.join(input.workspaceRoot, '227', 'index.html'), '<main>v1</main>\n', 'utf8')
  await writeFile(path.join(input.workspaceRoot, '227', 'state.js'), 'export const step = 2;\n', 'utf8')
  if (input.includeSnapshotOnlyEdit) {
    await writeFile(path.join(input.workspaceRoot, '227', 'snapshot-only.js'), 'export const snapshot = 2;\n', 'utf8')
  }
  if (input.includeUnattributedSnapshotFile) {
    await writeFile(path.join(input.workspaceRoot, '227', 'formatter-only.js'), 'export const formatted = 2;\n', 'utf8')
  }
  if (input.includeNewlinePathEdit) {
    await writeFile(path.join(input.workspaceRoot, '227', 'new\nline.js'), 'export const newlinePath = 2;\n', 'utf8')
  }
  if (input.includeWriteOverwrite) {
    await writeFile(path.join(input.workspaceRoot, '227', 'rewrite.js'), 'export const rewrite = 2;\n', 'utf8')
  }
  if (input.includeApplyPatchDelete) {
    await rm(path.join(input.workspaceRoot, '227', 'delete-me.js'))
  }
  const toSnapshot = writeSnapshotTree(gitDir, input.workspaceRoot)

  const db = new Database(input.dbPath)
  try {
    insertPart(db, {
      id: '000-step-start',
      messageId: 'bob-assistant-1',
      sessionId: 'session-bob',
      time: 995,
      data: snapshotStepPart('step-start', fromSnapshot),
    })
    insertPart(db, {
      id: 'zzz-step-finish',
      messageId: 'bob-assistant-1',
      sessionId: 'session-bob',
      time: 1_095,
      data: snapshotStepPart('step-finish', toSnapshot),
    })
    if (input.includeNewlinePathEdit) {
      insertPart(db, {
        id: 'zzzz-patch-newline-corrupt',
        messageId: 'bob-assistant-1',
        sessionId: 'session-bob',
        time: 1_096,
        data: {
          type: 'patch',
          hash: fromSnapshot,
          files: [
            path.join(input.workspaceRoot, '227', 'new').replace(/\\/g, '/'),
            'line.js',
          ],
        },
      })
    }
  } finally {
    db.close()
  }

  return { fromSnapshot, toSnapshot, gitDir }
}

async function insertSnapshotOnlyEditToolpart(dbPath: string, workspaceRoot: string): Promise<void> {
  const db = new Database(dbPath)
  try {
    insertPart(db, {
      id: 'bob-edit-snapshot-only',
      messageId: 'bob-assistant-1',
      sessionId: 'session-bob',
      time: 1_025,
      data: editToolPart({
        filePath: path.join(workspaceRoot, '227', 'snapshot-only.js'),
        oldString: 'snapshot = 1',
        newString: 'snapshot = 2',
        callID: 'call-bob-edit-snapshot-only',
      }),
    })
  } finally {
    db.close()
  }
}

async function insertNewlinePathSnapshotEditToolpart(dbPath: string, workspaceRoot: string): Promise<void> {
  const db = new Database(dbPath)
  try {
    insertPart(db, {
      id: 'bob-edit-newline-path',
      messageId: 'bob-assistant-1',
      sessionId: 'session-bob',
      time: 1_026,
      data: editToolPart({
        filePath: path.join(workspaceRoot, '227', 'new\nline.js'),
        oldString: 'newlinePath = 1',
        newString: 'newlinePath = 2',
        callID: 'call-bob-edit-newline-path',
      }),
    })
  } finally {
    db.close()
  }
}

async function insertSnapshotWriteOverwriteToolpart(dbPath: string, workspaceRoot: string): Promise<void> {
  const db = new Database(dbPath)
  try {
    insertPart(db, {
      id: 'bob-write-rewrite',
      messageId: 'bob-assistant-1',
      sessionId: 'session-bob',
      time: 1_027,
      data: writeToolPart({
        filePath: path.join(workspaceRoot, '227', 'rewrite.js'),
        content: 'export const rewrite = 2;\n',
        exists: true,
        callID: 'call-bob-write-rewrite',
      }),
    })
  } finally {
    db.close()
  }
}

async function insertSnapshotApplyPatchDeleteToolpart(dbPath: string): Promise<void> {
  const db = new Database(dbPath)
  try {
    insertPart(db, {
      id: 'bob-apply-patch-delete',
      messageId: 'bob-assistant-1',
      sessionId: 'session-bob',
      time: 1_028,
      data: applyPatchToolPart({
        patch: [
          '*** Begin Patch',
          '*** Delete File: 227/delete-me.js',
          '-export const remove = 1;',
          '*** End Patch',
        ].join('\n'),
        callID: 'call-bob-apply-patch-delete',
      }),
    })
  } finally {
    db.close()
  }
}

async function insertBinaryLargeMetadataToolparts(dbPath: string, workspaceRoot: string): Promise<void> {
  const db = new Database(dbPath)
  try {
    insertPart(db, {
      id: 'bob-edit-binary',
      messageId: 'bob-assistant-1',
      sessionId: 'session-bob',
      time: 1_029,
      data: editToolPart({
        filePath: path.join(workspaceRoot, '227', 'asset.bin'),
        oldString: 'binary-before',
        newString: 'binary-after',
        callID: 'call-bob-edit-binary',
      }),
    })
    insertPart(db, {
      id: 'bob-edit-large',
      messageId: 'bob-assistant-1',
      sessionId: 'session-bob',
      time: 1_030,
      data: editToolPart({
        filePath: path.join(workspaceRoot, '227', 'large.txt'),
        oldString: 'large-before',
        newString: 'large-after',
        callID: 'call-bob-edit-large',
      }),
    })
  } finally {
    db.close()
  }
}

async function insertSnapshotWindowPartsOnly(dbPath: string, input: {
  fromSnapshot?: string
  toSnapshot?: string
} = {}): Promise<void> {
  const db = new Database(dbPath)
  try {
    insertPart(db, {
      id: '000-step-start',
      messageId: 'bob-assistant-1',
      sessionId: 'session-bob',
      time: 995,
      data: snapshotStepPart(
        'step-start',
        input.fromSnapshot ?? '1111111111111111111111111111111111111111',
      ),
    })
    insertPart(db, {
      id: 'zzz-step-finish',
      messageId: 'bob-assistant-1',
      sessionId: 'session-bob',
      time: 1_095,
      data: snapshotStepPart(
        'step-finish',
        input.toSnapshot ?? '2222222222222222222222222222222222222222',
      ),
    })
  } finally {
    db.close()
  }
}

async function insertSameSessionOtherTaskToolpart(dbPath: string, workspaceRoot: string): Promise<void> {
  const db = new Database(dbPath)
  try {
    const taskTwoPrompt = [
      '<opencode_app_message_delivery>',
      `<opencode_delivery_context>${JSON.stringify({
        schemaVersion: 1,
        kind: 'opencode-delivery-context',
        teamName: 'fixture-team',
        memberName: 'bob',
        laneId: 'secondary:opencode:bob',
        inboundMessageId: 'bob-user-2',
        taskRefs: [
          { taskId: 'task-2', displayId: 'def67890', teamName: 'fixture-team' },
        ],
      })}</opencode_delivery_context>`,
      '</opencode_app_message_delivery>',
      '',
      '<opencode_inbound_app_message>',
      'Implement the second task.',
      '</opencode_inbound_app_message>',
    ].join('\n')
    insertMessage(db, { id: 'bob-user-2', sessionId: 'session-bob', time: 4_000, data: messageData('bob-user-2') })
    insertPart(db, { id: 'bob-user-part-2', messageId: 'bob-user-2', sessionId: 'session-bob', time: 4_000, data: userTextPart(taskTwoPrompt) })
    insertMessage(db, { id: 'bob-assistant-2', sessionId: 'session-bob', time: 4_100, data: messageData('bob-assistant-2', 'bob-user-2') })
    insertPart(db, {
      id: 'bob-task2-write',
      messageId: 'bob-assistant-2',
      sessionId: 'session-bob',
      time: 4_100,
      data: writeToolPart({
        filePath: path.join(workspaceRoot, '227', 'other-task.js'),
        content: 'export const otherTask = true;\n',
        exists: false,
        callID: 'call-bob-task2',
      }),
    })
  } finally {
    db.close()
  }
}

async function createFixtureSessionStore(dataDir: string, workspaceRoot: string): Promise<OpenCodeSessionStore> {
  const store = new OpenCodeSessionStore(path.join(dataDir, 'opencode', 'session-store.json'))
  await store.upsert(sessionRecord({ sessionId: 'session-bob', memberName: 'bob', workspaceRoot }))
  await store.upsert(sessionRecord({ sessionId: 'session-tom', memberName: 'tom', workspaceRoot }))
  await store.upsert(sessionRecord({ sessionId: 'session-ambiguous', memberName: 'sam', workspaceRoot }))
  return store
}

async function createFixtureDeliveryContext(): Promise<{ deliveryContextPath: string; deliveryContextHash: string }> {
  const contextDir = await mkdtemp(path.join(tempDir, 'claude-team-opencode-ledger-context-'))
  await chmod(contextDir, 0o700).catch(() => undefined)
  const filePath = path.join(contextDir, 'delivery-context.json')
  const rawContext = `${JSON.stringify({
    schemaVersion: 1,
    teamName: 'fixture-team',
    taskId: 'task-1',
    records: [
      {
        memberName: 'bob',
        laneId: 'secondary:opencode:bob',
        runtimeSessionId: 'session-bob',
        inboxMessageId: 'bob-user-1',
        deliveredUserMessageId: null,
        observedAssistantMessageId: null,
        prePromptCursor: null,
        postPromptCursor: null,
        taskRefs: [
          { taskId: 'task-1', displayId: 'abc12345', teamName: 'fixture-team' },
        ],
      },
      {
        memberName: 'tom',
        laneId: 'secondary:opencode:tom',
        runtimeSessionId: 'session-tom',
        inboxMessageId: 'tom-user-1',
        deliveredUserMessageId: null,
        observedAssistantMessageId: null,
        prePromptCursor: null,
        postPromptCursor: null,
        taskRefs: [
          { taskId: 'task-1', displayId: 'abc12345', teamName: 'fixture-team' },
        ],
      },
    ],
  })}\n`
  await writeFile(
    filePath,
    rawContext,
    { encoding: 'utf8', mode: 0o600 },
  )
  return {
    deliveryContextPath: filePath,
    deliveryContextHash: createHash('sha256').update(rawContext).digest('hex'),
  }
}

async function createMismatchedFixtureDeliveryContext(): Promise<{ deliveryContextPath: string; deliveryContextHash: string }> {
  const contextDir = await mkdtemp(path.join(tempDir, 'claude-team-opencode-ledger-context-'))
  await chmod(contextDir, 0o700).catch(() => undefined)
  const filePath = path.join(contextDir, 'delivery-context.json')
  const rawContext = `${JSON.stringify({
    schemaVersion: 1,
    teamName: 'fixture-team',
    taskId: 'task-1',
    records: [
      {
        memberName: 'bob',
        laneId: 'secondary:opencode:bob',
        runtimeSessionId: 'session-bob',
        inboxMessageId: 'bob-user-missing',
        deliveredUserMessageId: 'bob-user-missing',
        observedAssistantMessageId: null,
        prePromptCursor: null,
        postPromptCursor: null,
        taskRefs: [
          { taskId: 'task-1', displayId: 'abc12345', teamName: 'fixture-team' },
        ],
      },
    ],
  })}\n`
  await writeFile(
    filePath,
    rawContext,
    { encoding: 'utf8', mode: 0o600 },
  )
  return {
    deliveryContextPath: filePath,
    deliveryContextHash: createHash('sha256').update(rawContext).digest('hex'),
  }
}

function envPathsDataDirForHome(home: string): string {
  const appName = 'claude-multimodel-nodejs'
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', appName)
  }
  if (process.platform === 'win32') {
    return path.join(home, 'AppData', 'Local', appName, 'Data')
  }
  return path.join(home, '.local', 'share', appName)
}

function childEnvForHome(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
  }
}

function cliDevCommand(): { command: string; prefixArgs: string[] } {
  if (process.platform === 'win32') {
    return {
      command: process.execPath,
      prefixArgs: [path.join(process.cwd(), 'dist', 'local-cli-dev', 'cli.js')],
    }
  }
  return {
    command: path.join(process.cwd(), 'cli-dev'),
    prefixArgs: [],
  }
}

function runCliBackfill(input: {
  projectDir: string
  workspaceRoot: string
  deliveryContext: { deliveryContextPath: string; deliveryContextHash: string }
  dryRun?: boolean
}) {
  const cliDev = cliDevCommand()
  return spawnSync(
    cliDev.command,
    [
      ...cliDev.prefixArgs,
      'runtime',
      'opencode-ledger-backfill',
      '--json',
      '--team',
      'fixture-team',
      '--task',
      'task-1',
      '--task-display-id',
      'abc12345',
      '--project-dir',
      input.projectDir,
      '--workspace-root',
      input.workspaceRoot,
      '--delivery-context',
      input.deliveryContext.deliveryContextPath,
      '--delivery-context-hash',
      input.deliveryContext.deliveryContextHash,
      '--attribution-mode',
      'strict-delivery',
      ...(input.dryRun === true ? ['--dry-run'] : []),
    ],
    {
      cwd: process.cwd(),
      env: childEnvForHome(homeDir),
      encoding: 'utf8',
    },
  )
}

async function readJsonlEvents(projectDir: string, taskId: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(
    path.join(projectDir, '.board-task-changes', 'events', `${encodeURIComponent(taskId)}.jsonl`),
    'utf8',
  )
  return raw.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

async function readTaskChangeBundle(projectDir: string, taskId: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(
      path.join(projectDir, '.board-task-changes', 'bundles', `${encodeURIComponent(taskId)}.json`),
      'utf8',
    ),
  ) as Record<string, unknown>
}

async function readTaskChangeFreshness(projectDir: string, taskId: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(
      path.join(projectDir, '.board-task-change-freshness', `${encodeURIComponent(taskId)}.json`),
      'utf8',
    ),
  ) as Record<string, unknown>
}

describe('OpenCode Ledger Bridge real fixture E2E', () => {
  test('imports real SQLite session-store fixture into ledger artifacts idempotently', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace')
    const projectDir = path.join(tempDir, 'claude-project')
    const dataDir = path.join(tempDir, 'fixture-data')
    const deliveryContext = await createFixtureDeliveryContext()
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    const dbPath = await createOpenCodeSqliteFixture(dataDir, workspaceRoot)
    await stat(dbPath)
    const sessionStore = await createFixtureSessionStore(dataDir, workspaceRoot)
    const bridge = new OpenCodeLedgerBridgeService(
      sessionStore,
      new FixtureOpenCodeOfflineSessionReader(dbPath),
    )

    const result = await bridge.backfill({
      teamName: 'fixture-team',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...deliveryContext,
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('imported')
    expect(result.attributionMode).toBe('strict-delivery')
    expect(result.scannedSessions).toBe(2)
    expect(result.importedEvents).toBe(4)
    expect(result.notices).toEqual([])

    const events = await readJsonlEvents(projectDir, 'task-1')
    expect(events).toHaveLength(4)
    expect(events.map(event => event.source)).toEqual([
      'opencode_toolpart_write',
      'opencode_toolpart_write',
      'opencode_toolpart_edit',
      'opencode_toolpart_write',
    ])
    expect(events.find(event => event.sourcePartId === 'bob-error-edit-state')).toBeUndefined()
    expect(events.find(event => event.sourcePartId === 'amb-write')).toBeUndefined()
    expect(events.find(event => event.sourcePartId === 'tom-write-index-existing')).toMatchObject({
      operation: 'modify',
      confidence: 'medium',
      beforeState: {
        exists: true,
        unavailableReason: 'opencode-before-content-unavailable',
      },
    })

    const bundle = await readTaskChangeBundle(projectDir, 'task-1')
    expect(bundle).toMatchObject({
      schemaVersion: 2,
      source: 'task-change-ledger',
      bundleKind: 'summary',
      taskId: 'task-1',
      integrity: 'ok',
      eventCount: 4,
      totalFiles: 2,
    })
    expect('events' in bundle).toBe(false)
    const files = bundle.files as Array<Record<string, unknown>>
    expect(files.map(file => file.relativePath).sort()).toEqual(['227/index.html', '227/state.js'])
    expect(files.find(file => file.relativePath === '227/state.js')).toMatchObject({
      eventCount: 2,
      latestOperation: 'modify',
      createdInTask: true,
      reviewability: 'full-text',
      memberNames: ['bob'],
    })
    expect(files.find(file => file.relativePath === '227/index.html')).toMatchObject({
      eventCount: 2,
      latestOperation: 'modify',
      createdInTask: true,
      memberNames: ['bob', 'tom'],
    })
    expect(await readTaskChangeFreshness(projectDir, 'task-1')).toMatchObject({
      schemaVersion: 2,
      source: 'task-change-ledger',
      taskId: 'task-1',
      eventCount: 4,
      integrity: 'ok',
      bundleSchemaVersion: 2,
      bundleKind: 'summary',
    })

    const duplicateResult = await bridge.backfill({
      teamName: 'fixture-team',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...deliveryContext,
      attributionMode: 'strict-delivery',
    })
    expect(duplicateResult.outcome).toBe('duplicates-only')
    expect(duplicateResult.importedEvents).toBe(0)
    expect((await readJsonlEvents(projectDir, 'task-1'))).toHaveLength(4)
  })

  test('does not import same-session toolparts from a different delivered task', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace-same-session')
    const projectDir = path.join(tempDir, 'claude-project-same-session')
    const dataDir = path.join(tempDir, 'fixture-data-same-session')
    const deliveryContext = await createFixtureDeliveryContext()
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    const dbPath = await createOpenCodeSqliteFixture(dataDir, workspaceRoot)
    await insertSameSessionOtherTaskToolpart(dbPath, workspaceRoot)
    const sessionStore = await createFixtureSessionStore(dataDir, workspaceRoot)
    const bridge = new OpenCodeLedgerBridgeService(
      sessionStore,
      new FixtureOpenCodeOfflineSessionReader(dbPath),
    )

    const result = await bridge.backfill({
      teamName: 'fixture-team',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...deliveryContext,
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('imported')
    expect(result.importedEvents).toBe(4)
    expect(result.diagnostics.join('\n')).toContain(
      'OpenCode toolpart bob-task2-write skipped because no delivery record matched its parent message.',
    )
    const events = await readJsonlEvents(projectDir, 'task-1')
    expect(events.some(event => event.sourcePartId === 'bob-task2-write')).toBe(false)
    expect(events.some(event => event.relativePath === '227/other-task.js')).toBe(false)
    const bundle = await readTaskChangeBundle(projectDir, 'task-1')
    const files = bundle.files as Array<Record<string, unknown>>
    expect(files.some(file => file.relativePath === '227/other-task.js')).toBe(false)
  })

  test('imports source-driven OpenCode snapshot evidence from SQLite step windows and snapshot git store', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace-snapshot')
    const projectDir = path.join(tempDir, 'claude-project-snapshot')
    const dataDir = path.join(tempDir, 'fixture-data-snapshot')
    const deliveryContext = await createFixtureDeliveryContext()
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    const dbPath = await createOpenCodeSqliteFixture(dataDir, workspaceRoot)
    await insertSnapshotOnlyEditToolpart(dbPath, workspaceRoot)
    await insertNewlinePathSnapshotEditToolpart(dbPath, workspaceRoot)
    await insertSnapshotWriteOverwriteToolpart(dbPath, workspaceRoot)
    const snapshotStore = await createOpenCodeSnapshotGitStoreFixture({
      dbPath,
      workspaceRoot,
      includeSnapshotOnlyEdit: true,
      includeUnattributedSnapshotFile: true,
      includeNewlinePathEdit: true,
      includeWriteOverwrite: true,
    })
    await stat(snapshotStore.gitDir)
    const sessionStore = await createFixtureSessionStore(dataDir, workspaceRoot)
    const offlineReader = new FixtureOpenCodeOfflineSessionReader(dbPath)
    const bridge = new OpenCodeLedgerBridgeService(
      sessionStore,
      offlineReader,
      undefined,
      undefined,
      new OpenCodeSnapshotEvidenceProviderService(
        new OpenCodeSnapshotGitStoreReader({ offlineSessionReader: offlineReader }),
      ),
    )

    const result = await bridge.backfill({
      teamName: 'fixture-team',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...deliveryContext,
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('imported')
    expect(result.snapshotShapeFingerprint).toBe('opencode-snapshot-git-store-v2')
    expect(result.importedEvents).toBe(7)
    expect(result.diagnostics.join('\n')).toContain('OpenCode snapshot evidence skipped because SQLite snapshot windows are unavailable.')
    expect(result.diagnostics.join('\n')).toContain(
      'snapshot-path-not-touched: 227/formatter-only.js was present in snapshot diff but not in toolpart touched paths.',
    )
    expect(result.diagnostics.join('\n')).toContain(
      'snapshot-patch-files-mismatch: OpenCode patch.files did not include touched path 227/new\nline.js; using raw snapshot diff as path proof.',
    )
    const diagnosticsText = result.diagnostics.join('\n')
    for (const sensitiveText of [
      '<main>v1</main>',
      '<main>tom</main>',
      'export const snapshot = 1',
      'export const snapshot = 2',
      'snapshot = 1',
      'snapshot = 2',
    ]) {
      expect(diagnosticsText).not.toContain(sensitiveText)
    }

    const events = await readJsonlEvents(projectDir, 'task-1')
    expect(events.some(event => event.relativePath === '227/formatter-only.js')).toBe(false)
    const snapshotOnlyEdit = events.find(event => event.sourcePartId === 'bob-edit-snapshot-only')
    expect(snapshotOnlyEdit).toMatchObject({
      source: 'opencode_toolpart_edit',
      confidence: 'high',
      evidenceProof: 'inverse-edit-chain',
      operation: 'modify',
      beforeState: { exists: true },
      afterState: { exists: true },
    })
    expect(snapshotOnlyEdit?.snapshotId).toBeTruthy()
    expect(snapshotOnlyEdit?.snapshotSource).toBe('opencode')
    expect((snapshotOnlyEdit?.before as { sha256?: string } | undefined)?.sha256).toBeTruthy()
    expect((snapshotOnlyEdit?.after as { sha256?: string } | undefined)?.sha256).toBeTruthy()
    const newlinePathEdit = events.find(event => event.sourcePartId === 'bob-edit-newline-path')
    expect(newlinePathEdit).toMatchObject({
      source: 'opencode_toolpart_edit',
      relativePath: '227/new\nline.js',
      confidence: 'high',
      evidenceProof: 'inverse-edit-chain',
      operation: 'modify',
    })
    expect(newlinePathEdit?.snapshotId).toBeTruthy()
    const rewriteWrite = events.find(event => event.sourcePartId === 'bob-write-rewrite')
    expect(rewriteWrite).toMatchObject({
      source: 'opencode_toolpart_write',
      relativePath: '227/rewrite.js',
      confidence: 'high',
      evidenceProof: 'opencode-snapshot',
      operation: 'modify',
      beforeState: { exists: true },
      afterState: { exists: true },
    })
    expect(rewriteWrite?.snapshotId).toBeTruthy()
    expect(rewriteWrite?.snapshotSource).toBe('opencode')

    const bundle = await readTaskChangeBundle(projectDir, 'task-1')
    const files = bundle.files as Array<Record<string, unknown>>
    expect(files.some(file => file.relativePath === '227/formatter-only.js')).toBe(false)
    const snapshotOnlyFile = files.find(file => file.relativePath === '227/snapshot-only.js')
    expect(snapshotOnlyFile).toMatchObject({
      latestOperation: 'modify',
      createdInTask: false,
      reviewability: 'full-text',
      contentAvailability: 'full-text',
      latestBeforeHash: (snapshotOnlyEdit?.before as { sha256?: string } | undefined)?.sha256,
      latestAfterHash: (snapshotOnlyEdit?.after as { sha256?: string } | undefined)?.sha256,
    })
    expect(files.find(file => file.relativePath === '227/new\nline.js')).toMatchObject({
      latestOperation: 'modify',
      createdInTask: false,
      reviewability: 'full-text',
      contentAvailability: 'full-text',
      latestBeforeHash: (newlinePathEdit?.before as { sha256?: string } | undefined)?.sha256,
      latestAfterHash: (newlinePathEdit?.after as { sha256?: string } | undefined)?.sha256,
    })
    expect(files.find(file => file.relativePath === '227/rewrite.js')).toMatchObject({
      latestOperation: 'modify',
      createdInTask: false,
      reviewability: 'full-text',
      contentAvailability: 'full-text',
      latestBeforeHash: (rewriteWrite?.before as { sha256?: string } | undefined)?.sha256,
      latestAfterHash: (rewriteWrite?.after as { sha256?: string } | undefined)?.sha256,
    })

    const duplicateResult = await bridge.backfill({
      teamName: 'fixture-team',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...deliveryContext,
      attributionMode: 'strict-delivery',
    })
    expect(duplicateResult.outcome).toBe('duplicates-only')
    expect((await readJsonlEvents(projectDir, 'task-1'))).toHaveLength(7)
  })

  test('degrades to visible metadata-only changes when snapshot gitdir is missing', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace-missing-snapshot')
    const projectDir = path.join(tempDir, 'claude-project-missing-snapshot')
    const dataDir = path.join(tempDir, 'fixture-data-missing-snapshot')
    const deliveryContext = await createFixtureDeliveryContext()
    await mkdir(path.join(workspaceRoot, '227'), { recursive: true })
    await mkdir(projectDir, { recursive: true })
    const dbPath = await createOpenCodeSqliteFixture(dataDir, workspaceRoot)
    await insertSnapshotOnlyEditToolpart(dbPath, workspaceRoot)
    await insertSnapshotWindowPartsOnly(dbPath)
    await writeFile(path.join(workspaceRoot, '227', 'snapshot-only.js'), 'export const snapshot = 2;\n', 'utf8')
    const sessionStore = await createFixtureSessionStore(dataDir, workspaceRoot)
    const offlineReader = new FixtureOpenCodeOfflineSessionReader(dbPath)
    const bridge = new OpenCodeLedgerBridgeService(
      sessionStore,
      offlineReader,
      undefined,
      undefined,
      new OpenCodeSnapshotEvidenceProviderService(
        new OpenCodeSnapshotGitStoreReader({ offlineSessionReader: offlineReader }),
      ),
    )

    const result = await bridge.backfill({
      teamName: 'fixture-team',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...deliveryContext,
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('imported')
    expect(result.importedEvents).toBe(5)
    expect(result.diagnostics.join('\n')).toContain('snapshot-gitdir-missing:')
    const events = await readJsonlEvents(projectDir, 'task-1')
    const degradedEvent = events.find(event => event.sourcePartId === 'bob-edit-snapshot-only')
    expect(degradedEvent).toMatchObject({
      source: 'opencode_toolpart_edit',
      relativePath: '227/snapshot-only.js',
      evidenceProof: 'metadata-only-fallback',
      beforeState: {
        exists: true,
        unavailableReason: 'opencode-edit-baseline-not-captured',
      },
      afterState: {
        exists: true,
      },
    })
    expect((degradedEvent?.afterState as { sha256?: string } | undefined)?.sha256).toBeTruthy()
    expect(degradedEvent?.snapshotId).toBeUndefined()
    const bundle = await readTaskChangeBundle(projectDir, 'task-1')
    const files = bundle.files as Array<Record<string, unknown>>
    expect(files.find(file => file.relativePath === '227/snapshot-only.js')).toMatchObject({
      latestOperation: 'modify',
      reviewability: 'metadata-only',
      contentAvailability: 'hash-only',
    })
  })

  test('upgrades an existing metadata-only import to full-text when snapshot evidence appears', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace-upgrade')
    const projectDir = path.join(tempDir, 'claude-project-upgrade')
    const dataDir = path.join(tempDir, 'fixture-data-upgrade')
    const deliveryContext = await createFixtureDeliveryContext()
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    const dbPath = await createOpenCodeSqliteFixture(dataDir, workspaceRoot)
    await insertSnapshotOnlyEditToolpart(dbPath, workspaceRoot)
    await createOpenCodeSnapshotGitStoreFixture({
      dbPath,
      workspaceRoot,
      includeSnapshotOnlyEdit: true,
    })
    const sessionStore = await createFixtureSessionStore(dataDir, workspaceRoot)
    const offlineReader = new FixtureOpenCodeOfflineSessionReader(dbPath)

    const metadataOnlyBridge = new OpenCodeLedgerBridgeService(
      sessionStore,
      offlineReader,
    )
    const first = await metadataOnlyBridge.backfill({
      teamName: 'fixture-team',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...deliveryContext,
      attributionMode: 'strict-delivery',
    })
    expect(first.outcome).toBe('imported')
    const firstEvents = await readJsonlEvents(projectDir, 'task-1')
    const initialSnapshotOnlyEvent = firstEvents.find(event => event.sourcePartId === 'bob-edit-snapshot-only')
    expect(initialSnapshotOnlyEvent).toMatchObject({
      evidenceProof: 'metadata-only-fallback',
      beforeState: {
        exists: true,
        unavailableReason: 'opencode-edit-baseline-not-captured',
      },
    })

    const snapshotBridge = new OpenCodeLedgerBridgeService(
      sessionStore,
      offlineReader,
      undefined,
      undefined,
      new OpenCodeSnapshotEvidenceProviderService(
        new OpenCodeSnapshotGitStoreReader({ offlineSessionReader: offlineReader }),
      ),
    )
    const second = await snapshotBridge.backfill({
      teamName: 'fixture-team',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...deliveryContext,
      attributionMode: 'strict-delivery',
    })
    expect(second.outcome).toBe('imported')
    expect(second.importedEvents).toBeGreaterThanOrEqual(1)
    expect(second.snapshotShapeFingerprint).toBe('opencode-snapshot-git-store-v2')

    const upgradedEvents = await readJsonlEvents(projectDir, 'task-1')
    const snapshotOnlyEvents = upgradedEvents.filter(event => event.sourcePartId === 'bob-edit-snapshot-only')
    expect(snapshotOnlyEvents).toHaveLength(2)
    const upgradedSnapshotOnlyEvent = snapshotOnlyEvents.find(event => event.supersedesEventId)
    expect(upgradedSnapshotOnlyEvent).toMatchObject({
      evidenceProof: 'inverse-edit-chain',
      snapshotSource: 'opencode',
    })
    expect(upgradedSnapshotOnlyEvent?.snapshotId).toBeTruthy()
    expect((upgradedSnapshotOnlyEvent?.before as { sha256?: string } | undefined)?.sha256).toBeTruthy()
    expect((upgradedSnapshotOnlyEvent?.after as { sha256?: string } | undefined)?.sha256).toBeTruthy()

    const bundle = await readTaskChangeBundle(projectDir, 'task-1')
    const files = bundle.files as Array<Record<string, unknown>>
    expect(files.find(file => file.relativePath === '227/snapshot-only.js')).toMatchObject({
      latestOperation: 'modify',
      reviewability: 'full-text',
      contentAvailability: 'full-text',
      latestBeforeHash: (upgradedSnapshotOnlyEvent?.before as { sha256?: string } | undefined)?.sha256,
      latestAfterHash: (upgradedSnapshotOnlyEvent?.after as { sha256?: string } | undefined)?.sha256,
    })
  })

  test('imports apply_patch delete as full-text when snapshot evidence proves the deleted content', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace-apply-patch-delete')
    const projectDir = path.join(tempDir, 'claude-project-apply-patch-delete')
    const dataDir = path.join(tempDir, 'fixture-data-apply-patch-delete')
    const deliveryContext = await createFixtureDeliveryContext()
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    const dbPath = await createOpenCodeSqliteFixture(dataDir, workspaceRoot)
    await insertSnapshotApplyPatchDeleteToolpart(dbPath)
    await createOpenCodeSnapshotGitStoreFixture({
      dbPath,
      workspaceRoot,
      includeApplyPatchDelete: true,
    })
    const sessionStore = await createFixtureSessionStore(dataDir, workspaceRoot)
    const offlineReader = new FixtureOpenCodeOfflineSessionReader(dbPath)
    const bridge = new OpenCodeLedgerBridgeService(
      sessionStore,
      offlineReader,
      undefined,
      undefined,
      new OpenCodeSnapshotEvidenceProviderService(
        new OpenCodeSnapshotGitStoreReader({ offlineSessionReader: offlineReader }),
      ),
    )

    const result = await bridge.backfill({
      teamName: 'fixture-team',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...deliveryContext,
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('imported')
    expect(result.snapshotShapeFingerprint).toBe('opencode-snapshot-git-store-v2')
    const events = await readJsonlEvents(projectDir, 'task-1')
    const deleteEvent = events.find(event => event.sourcePartId === 'bob-apply-patch-delete')
    expect(deleteEvent).toMatchObject({
      source: 'opencode_toolpart_apply_patch',
      relativePath: '227/delete-me.js',
      operation: 'delete',
      confidence: 'high',
      evidenceProof: 'opencode-snapshot',
      snapshotSource: 'opencode',
      afterState: { exists: false },
    })
    expect(deleteEvent?.snapshotId).toBeTruthy()
    expect((deleteEvent?.before as { sha256?: string } | undefined)?.sha256).toBeTruthy()
    expect(deleteEvent?.after).toBeNull()

    const bundle = await readTaskChangeBundle(projectDir, 'task-1')
    const files = bundle.files as Array<Record<string, unknown>>
    expect(files.find(file => file.relativePath === '227/delete-me.js')).toMatchObject({
      latestOperation: 'delete',
      reviewability: 'full-text',
      contentAvailability: 'full-text',
      latestBeforeHash: (deleteEvent?.before as { sha256?: string } | undefined)?.sha256,
    })
  })

  test('CLI command recovers the same SQLite fixture through the public runtime entrypoint', async () => {
    const cliDev = cliDevCommand()
    const workspaceRoot = path.join(tempDir, 'workspace-cli')
    const projectDir = path.join(tempDir, 'claude-project-cli')
    const dataDir = envPathsDataDirForHome(homeDir)
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    await createOpenCodeSqliteFixture(dataDir, workspaceRoot)
    await createFixtureSessionStore(dataDir, workspaceRoot)
    const deliveryContext = await createFixtureDeliveryContext()

    const dryRun = spawnSync(
      cliDev.command,
      [
        ...cliDev.prefixArgs,
        'runtime',
        'opencode-ledger-backfill',
        '--json',
        '--team',
        'fixture-team',
        '--task',
        'task-1',
        '--task-display-id',
        'abc12345',
        '--project-dir',
        projectDir,
        '--workspace-root',
        workspaceRoot,
        '--delivery-context',
        deliveryContext.deliveryContextPath,
        '--delivery-context-hash',
        deliveryContext.deliveryContextHash,
        '--attribution-mode',
        'strict-delivery',
        '--dry-run',
      ],
      {
        cwd: process.cwd(),
        env: childEnvForHome(homeDir),
        encoding: 'utf8',
      },
    )

    expect(dryRun.status).toBe(0)
    expect(await readTaskChangeBundle(projectDir, 'task-1').catch(() => null)).toBeNull()
    expect((JSON.parse(dryRun.stdout) as {
      result: { outcome: string; candidateEvents: number; importedEvents: number; attributionMode: string }
    }).result).toMatchObject({
      outcome: 'manual-only',
      candidateEvents: 4,
      importedEvents: 0,
      attributionMode: 'strict-delivery',
    })

    const cli = spawnSync(
      cliDev.command,
      [
        ...cliDev.prefixArgs,
        'runtime',
        'opencode-ledger-backfill',
        '--json',
        '--team',
        'fixture-team',
        '--task',
        'task-1',
        '--task-display-id',
        'abc12345',
        '--project-dir',
        projectDir,
        '--workspace-root',
        workspaceRoot,
        '--delivery-context',
        deliveryContext.deliveryContextPath,
        '--delivery-context-hash',
        deliveryContext.deliveryContextHash,
        '--attribution-mode',
        'strict-delivery',
      ],
      {
        cwd: process.cwd(),
        env: childEnvForHome(homeDir),
        encoding: 'utf8',
      },
    )

    expect(cli.status).toBe(0)
    const stdout = JSON.parse(cli.stdout) as {
      result: { outcome: string; importedEvents: number; scannedSessions: number }
    }
    expect(stdout.result).toMatchObject({
      outcome: 'imported',
      importedEvents: 4,
      scannedSessions: 2,
      attributionMode: 'strict-delivery',
    })
    expect(await readJsonlEvents(projectDir, 'task-1')).toHaveLength(4)
    expect(await readTaskChangeBundle(projectDir, 'task-1')).toMatchObject({
      source: 'task-change-ledger',
      taskId: 'task-1',
      eventCount: 4,
      totalFiles: 2,
    })
  }, LEDGER_CLI_FIXTURE_E2E_TIMEOUT_MS)

  test('CLI command fails closed with mismatched delivery context and writes no ledger artifacts', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace-cli-mismatched-delivery')
    const projectDir = path.join(tempDir, 'claude-project-cli-mismatched-delivery')
    const dataDir = envPathsDataDirForHome(homeDir)
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    await createOpenCodeSqliteFixture(dataDir, workspaceRoot)
    await createFixtureSessionStore(dataDir, workspaceRoot)
    const deliveryContext = await createMismatchedFixtureDeliveryContext()

    const cli = runCliBackfill({ projectDir, workspaceRoot, deliveryContext })

    expect(cli.status, `stdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`).toBe(0)
    const stdout = JSON.parse(cli.stdout) as {
      result: { outcome: string; candidateEvents: number; importedEvents: number; diagnostics: string[] }
    }
    expect(stdout.result).toMatchObject({
      outcome: 'no-attribution',
      candidateEvents: 0,
      importedEvents: 0,
    })
    expect(stdout.result.diagnostics.join('\n')).toContain(
      'OpenCode toolpart bob-0001-write-index skipped because no delivery record matched its parent message.',
    )
    expect(await readTaskChangeBundle(projectDir, 'task-1').catch(() => null)).toBeNull()
    expect(await readJsonlEvents(projectDir, 'task-1').catch(() => null)).toBeNull()
  }, LEDGER_CLI_FIXTURE_E2E_TIMEOUT_MS)

  test('CLI command fails closed when requested workspace root does not match stored session workspace', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace-cli-wrong-root')
    const wrongWorkspaceRoot = path.join(tempDir, 'workspace-cli-wrong-root-other')
    const projectDir = path.join(tempDir, 'claude-project-cli-wrong-root')
    const dataDir = envPathsDataDirForHome(homeDir)
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(wrongWorkspaceRoot, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    await createOpenCodeSqliteFixture(dataDir, workspaceRoot)
    await createFixtureSessionStore(dataDir, workspaceRoot)
    const deliveryContext = await createFixtureDeliveryContext()

    const cli = runCliBackfill({
      projectDir,
      workspaceRoot: wrongWorkspaceRoot,
      deliveryContext,
    })

    expect(cli.status, `stdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`).toBe(0)
    const stdout = JSON.parse(cli.stdout) as {
      result: { outcome: string; importedEvents: number; diagnostics: string[] }
    }
    expect(stdout.result).toMatchObject({
      outcome: 'unsafe-input',
      importedEvents: 0,
    })
    expect(stdout.result.diagnostics.join('\n')).toContain(
      'OpenCode ledger backfill skipped bob/session-bob because workspace identity was not trusted.',
    )
    expect(await readTaskChangeBundle(projectDir, 'task-1').catch(() => null)).toBeNull()
    expect(await readJsonlEvents(projectDir, 'task-1').catch(() => null)).toBeNull()
  }, LEDGER_CLI_FIXTURE_E2E_TIMEOUT_MS)

  test('CLI command imports source-driven snapshot evidence through the public runtime entrypoint', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace-cli-snapshot')
    const projectDir = path.join(tempDir, 'claude-project-cli-snapshot')
    const dataDir = envPathsDataDirForHome(homeDir)
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    const dbPath = await createOpenCodeSqliteFixture(dataDir, workspaceRoot)
    await insertSnapshotOnlyEditToolpart(dbPath, workspaceRoot)
    await createOpenCodeSnapshotGitStoreFixture({
      dbPath,
      workspaceRoot,
      includeSnapshotOnlyEdit: true,
    })
    await createFixtureSessionStore(dataDir, workspaceRoot)
    const deliveryContext = await createFixtureDeliveryContext()

    const cli = runCliBackfill({ projectDir, workspaceRoot, deliveryContext })

    expect(cli.status).toBe(0)
    const stdout = JSON.parse(cli.stdout) as {
      result: {
        outcome: string
        importedEvents: number
        scannedSessions: number
        snapshotShapeFingerprint?: string
      }
    }
    expect(stdout.result).toMatchObject({
      outcome: 'imported',
      importedEvents: 5,
      scannedSessions: 2,
      snapshotShapeFingerprint: 'opencode-snapshot-git-store-v2',
    })
    const events = await readJsonlEvents(projectDir, 'task-1')
    const snapshotOnlyEdit = events.find(event => event.sourcePartId === 'bob-edit-snapshot-only')
    expect(snapshotOnlyEdit).toMatchObject({
      source: 'opencode_toolpart_edit',
      relativePath: '227/snapshot-only.js',
      confidence: 'high',
      evidenceProof: 'inverse-edit-chain',
      snapshotSource: 'opencode',
    })
    expect(snapshotOnlyEdit?.snapshotId).toBeTruthy()
    expect((snapshotOnlyEdit?.before as { sha256?: string } | undefined)?.sha256).toBeTruthy()
    expect((snapshotOnlyEdit?.after as { sha256?: string } | undefined)?.sha256).toBeTruthy()
    const bundle = await readTaskChangeBundle(projectDir, 'task-1')
    const files = bundle.files as Array<Record<string, unknown>>
    expect(files.find(file => file.relativePath === '227/snapshot-only.js')).toMatchObject({
      latestOperation: 'modify',
      reviewability: 'full-text',
      contentAvailability: 'full-text',
      latestBeforeHash: (snapshotOnlyEdit?.before as { sha256?: string } | undefined)?.sha256,
      latestAfterHash: (snapshotOnlyEdit?.after as { sha256?: string } | undefined)?.sha256,
    })

    const duplicateCli = runCliBackfill({ projectDir, workspaceRoot, deliveryContext })
    expect(duplicateCli.status, `stdout:\n${duplicateCli.stdout}\nstderr:\n${duplicateCli.stderr}`).toBe(0)
    const duplicateStdout = JSON.parse(duplicateCli.stdout) as {
      result: { outcome: string; importedEvents: number; scannedSessions: number }
    }
    expect(duplicateStdout.result).toMatchObject({
      outcome: 'duplicates-only',
      importedEvents: 0,
      scannedSessions: 2,
    })
    expect(await readJsonlEvents(projectDir, 'task-1')).toHaveLength(events.length)
  }, LEDGER_CLI_FIXTURE_E2E_TIMEOUT_MS)

  test('CLI command does not import snapshot-only formatter noise without a matching toolpart path', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace-cli-snapshot-noise')
    const projectDir = path.join(tempDir, 'claude-project-cli-snapshot-noise')
    const dataDir = envPathsDataDirForHome(homeDir)
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    const dbPath = await createOpenCodeSqliteFixture(dataDir, workspaceRoot)
    await insertSnapshotOnlyEditToolpart(dbPath, workspaceRoot)
    await createOpenCodeSnapshotGitStoreFixture({
      dbPath,
      workspaceRoot,
      includeSnapshotOnlyEdit: true,
      includeUnattributedSnapshotFile: true,
    })
    await createFixtureSessionStore(dataDir, workspaceRoot)
    const deliveryContext = await createFixtureDeliveryContext()

    const cli = runCliBackfill({ projectDir, workspaceRoot, deliveryContext })

    expect(cli.status, `stdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`).toBe(0)
    const stdout = JSON.parse(cli.stdout) as {
      result: {
        outcome: string
        importedEvents: number
        diagnostics: string[]
        snapshotShapeFingerprint?: string
      }
    }
    expect(stdout.result).toMatchObject({
      outcome: 'imported',
      importedEvents: 5,
      snapshotShapeFingerprint: 'opencode-snapshot-git-store-v2',
    })
    expect(stdout.result.diagnostics.join('\n')).toContain(
      'snapshot-path-not-touched: 227/formatter-only.js was present in snapshot diff but not in toolpart touched paths.',
    )
    const events = await readJsonlEvents(projectDir, 'task-1')
    expect(events.some(event => event.relativePath === '227/formatter-only.js')).toBe(false)
    const bundle = await readTaskChangeBundle(projectDir, 'task-1')
    const files = bundle.files as Array<Record<string, unknown>>
    expect(files.some(file => file.relativePath === '227/formatter-only.js')).toBe(false)
    expect(files.find(file => file.relativePath === '227/snapshot-only.js')).toMatchObject({
      reviewability: 'full-text',
      contentAvailability: 'full-text',
    })
  }, LEDGER_CLI_FIXTURE_E2E_TIMEOUT_MS)

  test('CLI dry-run with snapshot evidence does not write ledger artifacts', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace-cli-snapshot-dry-run')
    const projectDir = path.join(tempDir, 'claude-project-cli-snapshot-dry-run')
    const dataDir = envPathsDataDirForHome(homeDir)
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    const dbPath = await createOpenCodeSqliteFixture(dataDir, workspaceRoot)
    await insertSnapshotOnlyEditToolpart(dbPath, workspaceRoot)
    await createOpenCodeSnapshotGitStoreFixture({
      dbPath,
      workspaceRoot,
      includeSnapshotOnlyEdit: true,
    })
    await createFixtureSessionStore(dataDir, workspaceRoot)
    const deliveryContext = await createFixtureDeliveryContext()

    const dryRun = runCliBackfill({
      projectDir,
      workspaceRoot,
      deliveryContext,
      dryRun: true,
    })

    expect(dryRun.status, `stdout:\n${dryRun.stdout}\nstderr:\n${dryRun.stderr}`).toBe(0)
    const stdout = JSON.parse(dryRun.stdout) as {
      result: {
        outcome: string
        candidateEvents: number
        importedEvents: number
        snapshotShapeFingerprint?: string
      }
    }
    expect(stdout.result).toMatchObject({
      outcome: 'manual-only',
      candidateEvents: 5,
      importedEvents: 0,
      snapshotShapeFingerprint: 'opencode-snapshot-git-store-v2',
    })
    expect(await readTaskChangeBundle(projectDir, 'task-1').catch(() => null)).toBeNull()
    expect(await readJsonlEvents(projectDir, 'task-1').catch(() => null)).toBeNull()
  }, LEDGER_CLI_FIXTURE_E2E_TIMEOUT_MS)

  test('CLI command upgrades a previous metadata-only import to full-text snapshot evidence', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace-cli-upgrade')
    const projectDir = path.join(tempDir, 'claude-project-cli-upgrade')
    const dataDir = envPathsDataDirForHome(homeDir)
    await mkdir(path.join(workspaceRoot, '227'), { recursive: true })
    await mkdir(projectDir, { recursive: true })
    const dbPath = await createOpenCodeSqliteFixture(dataDir, workspaceRoot)
    await insertSnapshotOnlyEditToolpart(dbPath, workspaceRoot)
    await writeFile(path.join(workspaceRoot, '227', 'snapshot-only.js'), 'export const snapshot = 2;\n', 'utf8')
    await createFixtureSessionStore(dataDir, workspaceRoot)
    const deliveryContext = await createFixtureDeliveryContext()

    const first = runCliBackfill({ projectDir, workspaceRoot, deliveryContext })
    expect(first.status, `stdout:\n${first.stdout}\nstderr:\n${first.stderr}`).toBe(0)
    const firstEvents = await readJsonlEvents(projectDir, 'task-1')
    const firstSnapshotOnly = firstEvents.find(event => event.sourcePartId === 'bob-edit-snapshot-only')
    expect(firstSnapshotOnly).toMatchObject({
      evidenceProof: 'metadata-only-fallback',
      beforeState: {
        exists: true,
        unavailableReason: 'opencode-edit-baseline-not-captured',
      },
    })

    await createOpenCodeSnapshotGitStoreFixture({
      dbPath,
      workspaceRoot,
      includeSnapshotOnlyEdit: true,
    })
    const second = runCliBackfill({ projectDir, workspaceRoot, deliveryContext })
    expect(second.status, `stdout:\n${second.stdout}\nstderr:\n${second.stderr}`).toBe(0)
    const secondStdout = JSON.parse(second.stdout) as {
      result: {
        outcome: string
        importedEvents: number
        snapshotShapeFingerprint?: string
      }
    }
    expect(secondStdout.result).toMatchObject({
      outcome: 'imported',
      snapshotShapeFingerprint: 'opencode-snapshot-git-store-v2',
    })
    expect(secondStdout.result.importedEvents).toBeGreaterThanOrEqual(1)
    const upgradedEvents = await readJsonlEvents(projectDir, 'task-1')
    const snapshotOnlyEvents = upgradedEvents.filter(event => event.sourcePartId === 'bob-edit-snapshot-only')
    expect(snapshotOnlyEvents).toHaveLength(2)
    const upgradedSnapshotOnly = snapshotOnlyEvents.find(event => event.supersedesEventId)
    expect(upgradedSnapshotOnly).toMatchObject({
      evidenceProof: 'inverse-edit-chain',
      snapshotSource: 'opencode',
    })
    expect(upgradedSnapshotOnly?.snapshotId).toBeTruthy()
    const bundle = await readTaskChangeBundle(projectDir, 'task-1')
    const files = bundle.files as Array<Record<string, unknown>>
    expect(files.find(file => file.relativePath === '227/snapshot-only.js')).toMatchObject({
      reviewability: 'full-text',
      contentAvailability: 'full-text',
      latestBeforeHash: (upgradedSnapshotOnly?.before as { sha256?: string } | undefined)?.sha256,
      latestAfterHash: (upgradedSnapshotOnly?.after as { sha256?: string } | undefined)?.sha256,
    })
  }, LEDGER_CLI_FIXTURE_E2E_TIMEOUT_MS)

  test('CLI command imports apply_patch delete as full-text from snapshot evidence', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace-cli-apply-patch-delete')
    const projectDir = path.join(tempDir, 'claude-project-cli-apply-patch-delete')
    const dataDir = envPathsDataDirForHome(homeDir)
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    const dbPath = await createOpenCodeSqliteFixture(dataDir, workspaceRoot)
    await insertSnapshotApplyPatchDeleteToolpart(dbPath)
    await createOpenCodeSnapshotGitStoreFixture({
      dbPath,
      workspaceRoot,
      includeApplyPatchDelete: true,
    })
    await createFixtureSessionStore(dataDir, workspaceRoot)
    const deliveryContext = await createFixtureDeliveryContext()

    const cli = runCliBackfill({ projectDir, workspaceRoot, deliveryContext })
    expect(cli.status, `stdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`).toBe(0)
    const stdout = JSON.parse(cli.stdout) as {
      result: {
        outcome: string
        importedEvents: number
        snapshotShapeFingerprint?: string
      }
    }
    expect(stdout.result).toMatchObject({
      outcome: 'imported',
      snapshotShapeFingerprint: 'opencode-snapshot-git-store-v2',
    })
    expect(stdout.result.importedEvents).toBeGreaterThanOrEqual(1)

    const events = await readJsonlEvents(projectDir, 'task-1')
    const deleteEvent = events.find(event => event.sourcePartId === 'bob-apply-patch-delete')
    expect(deleteEvent).toMatchObject({
      source: 'opencode_toolpart_apply_patch',
      relativePath: '227/delete-me.js',
      operation: 'delete',
      confidence: 'high',
      evidenceProof: 'opencode-snapshot',
      snapshotSource: 'opencode',
      afterState: { exists: false },
    })
    expect(deleteEvent?.snapshotId).toBeTruthy()
    expect((deleteEvent?.before as { sha256?: string } | undefined)?.sha256).toBeTruthy()
    const bundle = await readTaskChangeBundle(projectDir, 'task-1')
    const files = bundle.files as Array<Record<string, unknown>>
    expect(files.find(file => file.relativePath === '227/delete-me.js')).toMatchObject({
      latestOperation: 'delete',
      reviewability: 'full-text',
      contentAvailability: 'full-text',
      latestBeforeHash: (deleteEvent?.before as { sha256?: string } | undefined)?.sha256,
    })
  }, LEDGER_CLI_FIXTURE_E2E_TIMEOUT_MS)

  test('CLI command keeps binary and large OpenCode changes visible as manual-only metadata', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace-cli-binary-large')
    const projectDir = path.join(tempDir, 'claude-project-cli-binary-large')
    const dataDir = envPathsDataDirForHome(homeDir)
    await mkdir(path.join(workspaceRoot, '227'), { recursive: true })
    await mkdir(projectDir, { recursive: true })
    const dbPath = await createOpenCodeSqliteFixture(dataDir, workspaceRoot)
    await insertBinaryLargeMetadataToolparts(dbPath, workspaceRoot)
    await writeFile(path.join(workspaceRoot, '227', 'asset.bin'), Buffer.from([0, 1, 2, 3, 255]))
    await writeFile(path.join(workspaceRoot, '227', 'large.txt'), 'x'.repeat(1024 * 1024 + 1), 'utf8')
    await createFixtureSessionStore(dataDir, workspaceRoot)
    const deliveryContext = await createFixtureDeliveryContext()

    const cli = runCliBackfill({ projectDir, workspaceRoot, deliveryContext })
    expect(cli.status, `stdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`).toBe(0)
    const stdout = JSON.parse(cli.stdout) as {
      result: {
        outcome: string
        importedEvents: number
      }
    }
    expect(stdout.result).toMatchObject({
      outcome: 'imported',
    })
    expect(stdout.result.importedEvents).toBeGreaterThanOrEqual(2)

    const events = await readJsonlEvents(projectDir, 'task-1')
    const binaryEvent = events.find(event => event.sourcePartId === 'bob-edit-binary')
    const largeEvent = events.find(event => event.sourcePartId === 'bob-edit-large')
    expect(binaryEvent).toMatchObject({
      source: 'opencode_toolpart_edit',
      relativePath: '227/asset.bin',
      operation: 'modify',
      evidenceProof: 'metadata-only-fallback',
      beforeState: {
        exists: true,
        unavailableReason: 'opencode-edit-baseline-not-captured',
      },
      afterState: {
        exists: true,
        unavailableReason: 'opencode-after-content-binary',
      },
    })
    expect(largeEvent).toMatchObject({
      source: 'opencode_toolpart_edit',
      relativePath: '227/large.txt',
      operation: 'modify',
      evidenceProof: 'metadata-only-fallback',
      beforeState: {
        exists: true,
        unavailableReason: 'opencode-edit-baseline-not-captured',
      },
      afterState: {
        exists: true,
        unavailableReason: 'opencode-after-content-too-large',
      },
    })
    const bundle = await readTaskChangeBundle(projectDir, 'task-1')
    const files = bundle.files as Array<Record<string, unknown>>
    expect(files.find(file => file.relativePath === '227/asset.bin')).toMatchObject({
      latestOperation: 'modify',
      reviewability: 'metadata-only',
      contentAvailability: 'hash-only',
    })
    expect(files.find(file => file.relativePath === '227/large.txt')).toMatchObject({
      latestOperation: 'modify',
      reviewability: 'metadata-only',
      contentAvailability: 'metadata-only',
    })
  }, LEDGER_CLI_FIXTURE_E2E_TIMEOUT_MS)

  test('CLI command does not import same-session toolparts from another delivered task', async () => {
    const cliDev = cliDevCommand()
    const workspaceRoot = path.join(tempDir, 'workspace-cli-same-session')
    const projectDir = path.join(tempDir, 'claude-project-cli-same-session')
    const dataDir = envPathsDataDirForHome(homeDir)
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    const dbPath = await createOpenCodeSqliteFixture(dataDir, workspaceRoot)
    await insertSameSessionOtherTaskToolpart(dbPath, workspaceRoot)
    await createFixtureSessionStore(dataDir, workspaceRoot)
    const deliveryContext = await createFixtureDeliveryContext()

    const cli = spawnSync(
      cliDev.command,
      [
        ...cliDev.prefixArgs,
        'runtime',
        'opencode-ledger-backfill',
        '--json',
        '--team',
        'fixture-team',
        '--task',
        'task-1',
        '--task-display-id',
        'abc12345',
        '--project-dir',
        projectDir,
        '--workspace-root',
        workspaceRoot,
        '--delivery-context',
        deliveryContext.deliveryContextPath,
        '--delivery-context-hash',
        deliveryContext.deliveryContextHash,
        '--attribution-mode',
        'strict-delivery',
      ],
      {
        cwd: process.cwd(),
        env: childEnvForHome(homeDir),
        encoding: 'utf8',
      },
    )

    expect(cli.status, `stdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`).toBe(0)
    const stdout = JSON.parse(cli.stdout) as {
      result: { outcome: string; importedEvents: number; diagnostics: string[] }
    }
    expect(stdout.result).toMatchObject({
      outcome: 'imported',
      importedEvents: 4,
    })
    expect(stdout.result.diagnostics.join('\n')).toContain(
      'OpenCode toolpart bob-task2-write skipped because no delivery record matched its parent message.',
    )
    const events = await readJsonlEvents(projectDir, 'task-1')
    expect(events).toHaveLength(4)
    expect(events.some(event => event.sourcePartId === 'bob-task2-write')).toBe(false)
    const bundle = await readTaskChangeBundle(projectDir, 'task-1')
    const files = bundle.files as Array<Record<string, unknown>>
    expect(files.some(file => file.relativePath === '227/other-task.js')).toBe(false)
  }, LEDGER_CLI_FIXTURE_E2E_TIMEOUT_MS)

  test('CLI command keeps missing snapshot gitdir changes visible as metadata-only', async () => {
    const cliDev = cliDevCommand()
    const workspaceRoot = path.join(tempDir, 'workspace-cli-missing-snapshot')
    const projectDir = path.join(tempDir, 'claude-project-cli-missing-snapshot')
    const dataDir = envPathsDataDirForHome(homeDir)
    await mkdir(path.join(workspaceRoot, '227'), { recursive: true })
    await mkdir(projectDir, { recursive: true })
    const dbPath = await createOpenCodeSqliteFixture(dataDir, workspaceRoot)
    await insertSnapshotOnlyEditToolpart(dbPath, workspaceRoot)
    await insertSnapshotWindowPartsOnly(dbPath)
    await writeFile(path.join(workspaceRoot, '227', 'snapshot-only.js'), 'export const snapshot = 2;\n', 'utf8')
    await createFixtureSessionStore(dataDir, workspaceRoot)
    const deliveryContext = await createFixtureDeliveryContext()

    const cli = spawnSync(
      cliDev.command,
      [
        ...cliDev.prefixArgs,
        'runtime',
        'opencode-ledger-backfill',
        '--json',
        '--team',
        'fixture-team',
        '--task',
        'task-1',
        '--task-display-id',
        'abc12345',
        '--project-dir',
        projectDir,
        '--workspace-root',
        workspaceRoot,
        '--delivery-context',
        deliveryContext.deliveryContextPath,
        '--delivery-context-hash',
        deliveryContext.deliveryContextHash,
        '--attribution-mode',
        'strict-delivery',
      ],
      {
        cwd: process.cwd(),
        env: childEnvForHome(homeDir),
        encoding: 'utf8',
      },
    )

    expect(cli.status, `stdout:\n${cli.stdout}\nstderr:\n${cli.stderr}`).toBe(0)
    const stdout = JSON.parse(cli.stdout) as {
      result: { outcome: string; importedEvents: number; diagnostics: string[] }
    }
    expect(stdout.result).toMatchObject({
      outcome: 'imported',
      importedEvents: 5,
    })
    expect(stdout.result.diagnostics.join('\n')).toContain('snapshot-gitdir-missing:')
    const events = await readJsonlEvents(projectDir, 'task-1')
    const degradedEvent = events.find(event => event.sourcePartId === 'bob-edit-snapshot-only')
    expect(degradedEvent).toMatchObject({
      evidenceProof: 'metadata-only-fallback',
      beforeState: {
        exists: true,
        unavailableReason: 'opencode-edit-baseline-not-captured',
      },
    })
    const bundle = await readTaskChangeBundle(projectDir, 'task-1')
    const files = bundle.files as Array<Record<string, unknown>>
    expect(files.find(file => file.relativePath === '227/snapshot-only.js')).toMatchObject({
      latestOperation: 'modify',
      reviewability: 'metadata-only',
      contentAvailability: 'hash-only',
    })
  }, LEDGER_CLI_FIXTURE_E2E_TIMEOUT_MS)
})
