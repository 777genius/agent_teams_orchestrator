import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE,
  OpenCodeOfflineSessionReader,
} from './OpenCodeOfflineSessionReader.js'

import type { OpenCodeSessionRecord } from './types.js'

let tempDir = ''
let dbPath = ''

class FixtureOpenCodeOfflineSessionReader extends OpenCodeOfflineSessionReader {
  constructor(private readonly fixtureDbPath: string) {
    super()
  }

  override resolveDbPath(): string {
    return this.fixtureDbPath
  }
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-offline-reader-'))
  dbPath = path.join(tempDir, 'opencode.db')
  await mkdir(path.dirname(dbPath), { recursive: true })
})

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
  }
})

function sessionRecord(): OpenCodeSessionRecord {
  return {
    teamId: 'team-a',
    laneId: 'primary',
    memberName: 'bob',
    providerId: 'opencode',
    selectedModel: 'openai/gpt-5.4',
    projectPath: tempDir,
    profileRootKey: 'fixture-profile',
    hostKey: 'host-key',
    resolvedBehaviorFingerprint: 'behavior-v1',
    opencodeSessionId: 'session-1',
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

function createSchema(db: Database): void {
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
}

function insertMessage(db: Database, id: string, data: string, time = 1000): void {
  db.query(
    'insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)',
  ).run(id, 'session-1', time, null, data)
}

function insertPart(db: Database, id: string, messageId: string, data: string, time = 1000): void {
  db.query(
    'insert into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)',
  ).run(id, messageId, 'session-1', time, null, data)
}

async function readFixture() {
  return await new FixtureOpenCodeOfflineSessionReader(dbPath).readSession(sessionRecord())
}

describe('OpenCodeOfflineSessionReader schema drift sentinel', () => {
  test('marks missing required columns as unsupported history shape', async () => {
    const db = new Database(dbPath)
    try {
      db.exec(`
        create table message (
          id text primary key,
          session_id text not null,
          time_created integer not null
        );
        create table part (
          id text primary key,
          message_id text not null,
          session_id text not null,
          time_created integer not null,
          data text not null
        );
      `)
    } finally {
      db.close()
    }

    const result = await readFixture()

    expect(result?.historyShape).toBe('unsupported')
    expect(result?.diagnostics.join('\n')).toContain(OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE)
    expect(result?.rawParts).toEqual([])
  })

  test('marks invalid JSON rows as unsupported history shape', async () => {
    const db = new Database(dbPath)
    try {
      createSchema(db)
      insertMessage(db, 'message-1', '{')
      insertPart(db, 'part-1', 'message-1', JSON.stringify({ type: 'text', text: 'hello' }))
    } finally {
      db.close()
    }

    const result = await readFixture()

    expect(result?.historyShape).toBe('unsupported')
    expect(result?.diagnostics.join('\n')).toContain(OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE)
  })

  test('marks unrecognizable toolpart shape as unsupported history shape', async () => {
    const db = new Database(dbPath)
    try {
      createSchema(db)
      insertMessage(db, 'message-1', JSON.stringify({ id: 'message-1' }))
      insertPart(db, 'part-1', 'message-1', JSON.stringify({ type: 'tool', state: {} }))
    } finally {
      db.close()
    }

    const result = await readFixture()

    expect(result?.historyShape).toBe('unsupported')
    expect(result?.diagnostics.join('\n')).toContain('missing tool name')
  })

  test('does not reject a session because an errored write toolpart has invalid empty input', async () => {
    const db = new Database(dbPath)
    try {
      createSchema(db)
      insertMessage(db, 'message-1', JSON.stringify({ id: 'message-1' }))
      insertPart(
        db,
        'part-valid-write',
        'message-1',
        JSON.stringify({
          type: 'tool',
          tool: 'write',
          state: {
            status: 'completed',
            input: {
              filePath: '/repo/src/index.ts',
              content: 'export const ok = true\n',
            },
          },
        }),
      )
      insertPart(
        db,
        'part-invalid-write',
        'message-1',
        JSON.stringify({
          type: 'tool',
          tool: 'write',
          state: {
            status: 'error',
            input: {},
            error: 'The write tool was called with invalid arguments.',
          },
        }),
      )
    } finally {
      db.close()
    }

    const result = await readFixture()

    expect(result?.historyShape).toBe('supported')
    expect(result?.rawParts.map(part => part.id).sort()).toEqual(['part-invalid-write', 'part-valid-write'])
    expect(result?.diagnostics.join('\n')).not.toContain('missing state/input/filePath')
  })

  test('caps oversized rows without treating the whole schema as unsupported', async () => {
    const db = new Database(dbPath)
    try {
      createSchema(db)
      insertMessage(db, 'message-1', JSON.stringify({ id: 'message-1' }))
      insertPart(db, 'part-large', 'message-1', JSON.stringify({ type: 'text', text: 'x'.repeat(3 * 1024 * 1024) }))
      insertPart(db, 'part-valid', 'message-1', JSON.stringify({ type: 'text', text: 'ok' }))
    } finally {
      db.close()
    }

    const result = await readFixture()

    expect(result?.historyShape).toBe('supported')
    expect(result?.rawParts.map(part => part.id)).toEqual(['part-valid'])
    expect(result?.diagnostics.join('\n')).toContain('exceeded JSON size cap')
  })
})
