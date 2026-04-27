import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { OpenCodeLedgerBridgeService } from './OpenCodeLedgerBridgeService.js'
import { OpenCodeOfflineSessionReader } from './OpenCodeOfflineSessionReader.js'
import { OpenCodeSessionStore } from './OpenCodeSessionStore.js'

import type { OpenCodeSessionRecord } from './types.js'

let tempDir = ''
let homeDir = ''
let previousHome: string | undefined

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
      id: 'bob-write-index',
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
      id: 'bob-write-state',
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
      id: 'bob-edit-state',
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

async function createFixtureSessionStore(dataDir: string, workspaceRoot: string): Promise<OpenCodeSessionStore> {
  const store = new OpenCodeSessionStore(path.join(dataDir, 'opencode', 'session-store.json'))
  await store.upsert(sessionRecord({ sessionId: 'session-bob', memberName: 'bob', workspaceRoot }))
  await store.upsert(sessionRecord({ sessionId: 'session-tom', memberName: 'tom', workspaceRoot }))
  await store.upsert(sessionRecord({ sessionId: 'session-ambiguous', memberName: 'sam', workspaceRoot }))
  return store
}

async function createFixtureDeliveryContext(filePath: string): Promise<string> {
  await writeFile(
    filePath,
    `${JSON.stringify({
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
    })}\n`,
    'utf8',
  )
  return filePath
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
    const deliveryContextPath = await createFixtureDeliveryContext(path.join(tempDir, 'delivery-context.json'))
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
      deliveryContextPath,
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
      confidence: 'high',
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
      deliveryContextPath,
      attributionMode: 'strict-delivery',
    })
    expect(duplicateResult.outcome).toBe('duplicates-only')
    expect(duplicateResult.importedEvents).toBe(0)
    expect((await readJsonlEvents(projectDir, 'task-1'))).toHaveLength(4)
  })

  test('CLI command recovers the same SQLite fixture through the public runtime entrypoint', async () => {
    const cliPath = path.join(process.cwd(), 'cli-dev')
    const workspaceRoot = path.join(tempDir, 'workspace-cli')
    const projectDir = path.join(tempDir, 'claude-project-cli')
    const dataDir = envPathsDataDirForHome(homeDir)
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    await createOpenCodeSqliteFixture(dataDir, workspaceRoot)
    await createFixtureSessionStore(dataDir, workspaceRoot)
    const deliveryContextPath = await createFixtureDeliveryContext(path.join(tempDir, 'delivery-context-cli.json'))

    const dryRun = spawnSync(
      cliPath,
      [
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
        deliveryContextPath,
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
      cliPath,
      [
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
        deliveryContextPath,
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
  })
})
