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

function createIdentitySchema(db: Database): void {
  db.exec(`
    create table session (
      id text primary key,
      project_id text,
      directory text
    );
    create table project (
      id text primary key,
      worktree text,
      vcs text
    );
  `)
}

function insertSessionIdentity(db: Database, options?: {
  projectId?: string | null
  directory?: string | null
  worktree?: string | null
  vcs?: string | null
}): void {
  const projectId = options?.projectId === undefined ? 'project-1' : options.projectId
  const directory = options?.directory === undefined ? tempDir : options.directory
  db.query('insert into session (id, project_id, directory) values (?, ?, ?)').run(
    'session-1',
    projectId,
    directory,
  )
  if (projectId !== null) {
    db.query('insert into project (id, worktree, vcs) values (?, ?, ?)').run(
      projectId,
      options?.worktree === undefined ? tempDir : options.worktree,
      options?.vcs === undefined ? 'git' : options.vcs,
    )
  }
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

  test('does not reject a session because one completed write toolpart has unsupported input shape', async () => {
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
        'part-malformed-write',
        'message-1',
        JSON.stringify({
          type: 'tool',
          tool: 'write',
          state: {
            status: 'completed',
            input: {
              content: 'missing path',
            },
          },
        }),
      )
    } finally {
      db.close()
    }

    const result = await readFixture()

    expect(result?.historyShape).toBe('supported')
    expect(result?.rawParts.map(part => part.id).sort()).toEqual(['part-malformed-write', 'part-valid-write'])
    expect(result?.diagnostics.join('\n')).toContain(
      'OpenCode SQLite write toolpart part-malformed-write has unsupported state/input/filePath shape; it will be skipped.',
    )
    expect(result?.diagnostics.join('\n')).not.toContain(OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE)
  })

  test('does not reject a session because a completed apply_patch toolpart has an unknown input shape', async () => {
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
        'part-unknown-apply-patch',
        'message-1',
        JSON.stringify({
          type: 'tool',
          tool: 'apply_patch',
          state: {
            status: 'completed',
            input: {
              command: 'diff --git a/src/index.ts b/src/index.ts',
            },
          },
        }),
      )
    } finally {
      db.close()
    }

    const result = await readFixture()

    expect(result?.historyShape).toBe('supported')
    expect(result?.rawParts.map(part => part.id).sort()).toEqual([
      'part-unknown-apply-patch',
      'part-valid-write',
    ])
    expect(result?.diagnostics.join('\n')).toContain(
      'OpenCode SQLite apply_patch toolpart part-unknown-apply-patch has unsupported state/input/patch shape; it will be skipped.',
    )
    expect(result?.diagnostics.join('\n')).not.toContain(OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE)
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

  test('extracts snapshot step parts, patch parts, identity, and message-local windows', async () => {
    const db = new Database(dbPath)
    try {
      createSchema(db)
      createIdentitySchema(db)
      insertSessionIdentity(db)
      insertMessage(db, 'assistant-1', JSON.stringify({ id: 'assistant-1', role: 'assistant' }))
      insertPart(db, 'part-001-start', 'assistant-1', JSON.stringify({
        type: 'step-start',
        snapshot: '1111111111111111111111111111111111111111',
      }), 1000)
      insertPart(db, 'part-002-patch', 'assistant-1', JSON.stringify({
        type: 'patch',
        hash: '1111111111111111111111111111111111111111',
        files: ['src/index.ts'],
      }), 1000)
      insertPart(db, 'part-003-finish', 'assistant-1', JSON.stringify({
        type: 'step-finish',
        snapshot: '2222222222222222222222222222222222222222',
      }), 1000)
    } finally {
      db.close()
    }

    const result = await readFixture()

    expect(result?.historyShape).toBe('supported')
    expect(result?.sessionIdentity).toMatchObject({
      sessionId: 'session-1',
      projectId: 'project-1',
      directory: tempDir,
      snapshotEvidenceSupported: true,
      unsupportedReasons: [],
    })
    expect(result?.sessionIdentity?.project).toEqual({
      id: 'project-1',
      worktree: tempDir,
      vcs: 'git',
    })
    expect(result?.snapshotStepParts.map(part => [part.kind, part.partId, part.partOrder])).toEqual([
      ['step-start', 'part-001-start', 0],
      ['step-finish', 'part-003-finish', 2],
    ])
    expect(result?.patchParts).toEqual([
      {
        partId: 'part-002-patch',
        messageId: 'assistant-1',
        sessionId: 'session-1',
        partOrder: 1,
        timeCreated: 1000,
        hash: '1111111111111111111111111111111111111111',
        files: ['src/index.ts'],
        relativeFiles: ['src/index.ts'],
      },
    ])
    expect(result?.snapshotWindows).toEqual([
      {
        windowId: 'assistant-1:part-001-start->part-003-finish',
        messageId: 'assistant-1',
        sessionId: 'session-1',
        fromSnapshot: '1111111111111111111111111111111111111111',
        toSnapshot: '2222222222222222222222222222222222222222',
        startPartId: 'part-001-start',
        finishPartId: 'part-003-finish',
        startPartOrder: 0,
        finishPartOrder: 2,
      },
    ])
  })

  test('normalizes OpenCode patch files to safe project-relative paths', async () => {
    const db = new Database(dbPath)
    const outsidePath = path.join(path.dirname(tempDir), 'outside.ts')
    try {
      createSchema(db)
      createIdentitySchema(db)
      insertSessionIdentity(db)
      insertMessage(db, 'assistant-1', JSON.stringify({ id: 'assistant-1', role: 'assistant' }))
      insertPart(db, 'part-patch', 'assistant-1', JSON.stringify({
        type: 'patch',
        hash: '1111111111111111111111111111111111111111',
        files: [
          path.join(tempDir, 'src/index.ts').replace(/\\/g, '/'),
          'src/relative.ts',
          outsidePath.replace(/\\/g, '/'),
        ],
      }), 1000)
    } finally {
      db.close()
    }

    const result = await readFixture()

    expect(result?.historyShape).toBe('supported')
    expect(result?.patchParts).toEqual([
      {
        partId: 'part-patch',
        messageId: 'assistant-1',
        sessionId: 'session-1',
        partOrder: 0,
        timeCreated: 1000,
        hash: '1111111111111111111111111111111111111111',
        files: [
          path.join(tempDir, 'src/index.ts').replace(/\\/g, '/'),
          'src/relative.ts',
          outsidePath.replace(/\\/g, '/'),
        ],
        relativeFiles: ['src/index.ts', 'src/relative.ts'],
      },
    ])
    expect(result?.diagnostics.join('\n')).toContain('snapshot-patch-part-unsafe-path')
  })

  test('keeps malformed snapshot parts diagnostic-only without rejecting toolpart history', async () => {
    const db = new Database(dbPath)
    try {
      createSchema(db)
      insertMessage(db, 'assistant-1', JSON.stringify({ id: 'assistant-1', role: 'assistant' }))
      insertPart(db, 'part-start', 'assistant-1', JSON.stringify({ type: 'step-start' }))
      insertPart(db, 'part-patch', 'assistant-1', JSON.stringify({ type: 'patch', files: ['src/a.ts'] }))
      insertPart(db, 'part-tool', 'assistant-1', JSON.stringify({
        type: 'tool',
        tool: 'write',
        state: {
          status: 'completed',
          input: {
            filePath: path.join(tempDir, 'src/a.ts'),
            content: 'ok',
          },
        },
      }))
    } finally {
      db.close()
    }

    const result = await readFixture()

    expect(result?.historyShape).toBe('supported')
    expect(result?.snapshotStepParts).toEqual([])
    expect(result?.patchParts).toEqual([])
    expect(result?.rawParts.map(part => part.id).sort()).toEqual(['part-patch', 'part-start', 'part-tool'])
    expect(result?.diagnostics.join('\n')).toContain('snapshot-window-missing')
    expect(result?.diagnostics.join('\n')).toContain('snapshot-patch-part-malformed')
    expect(result?.diagnostics.join('\n')).not.toContain(OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE)
  })

  test('treats missing project table as snapshot-unsupported but keeps history supported', async () => {
    const db = new Database(dbPath)
    try {
      createSchema(db)
      db.exec(`
        create table session (
          id text primary key,
          project_id text,
          directory text
        );
      `)
      db.query('insert into session (id, project_id, directory) values (?, ?, ?)').run(
        'session-1',
        'missing-project',
        tempDir,
      )
      insertMessage(db, 'message-1', JSON.stringify({ id: 'message-1' }))
    } finally {
      db.close()
    }

    const result = await readFixture()

    expect(result?.historyShape).toBe('supported')
    expect(result?.sessionIdentity?.snapshotEvidenceSupported).toBe(false)
    expect(result?.sessionIdentity?.unsupportedReasons).toContain('snapshot-project-identity-missing')
    expect(result?.diagnostics.join('\n')).toContain('snapshot-project-identity-missing')
    expect(result?.diagnostics.join('\n')).not.toContain(OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE)
  })

  test('marks non-git projects as snapshot unsupported without dropping messages', async () => {
    const db = new Database(dbPath)
    try {
      createSchema(db)
      createIdentitySchema(db)
      insertSessionIdentity(db, { vcs: 'none' })
      insertMessage(db, 'message-1', JSON.stringify({ id: 'message-1' }))
    } finally {
      db.close()
    }

    const result = await readFixture()

    expect(result?.historyShape).toBe('supported')
    expect(result?.messages).toHaveLength(1)
    expect(result?.sessionIdentity?.snapshotEvidenceSupported).toBe(false)
    expect(result?.sessionIdentity?.unsupportedReasons).toContain('snapshot-project-not-git')
  })

  test('marks project worktree mismatch and session directory outside worktree as snapshot unsupported', async () => {
    const db = new Database(dbPath)
    const otherWorktree = path.join(tempDir, 'other-worktree')
    try {
      createSchema(db)
      createIdentitySchema(db)
      insertSessionIdentity(db, {
        worktree: otherWorktree,
        directory: path.join(tempDir, 'outside-session-dir'),
      })
      insertMessage(db, 'message-1', JSON.stringify({ id: 'message-1' }))
    } finally {
      db.close()
    }

    const result = await readFixture()

    expect(result?.historyShape).toBe('supported')
    expect(result?.sessionIdentity?.snapshotEvidenceSupported).toBe(false)
    expect(result?.sessionIdentity?.unsupportedReasons).toEqual(
      expect.arrayContaining([
        'snapshot-session-directory-outside-worktree',
        'snapshot-project-worktree-mismatch',
      ]),
    )
    expect(result?.diagnostics.join('\n')).toContain('snapshot-session-directory-outside-worktree')
    expect(result?.diagnostics.join('\n')).toContain('snapshot-project-worktree-mismatch')
  })

  test('pairs multiple snapshot windows by message-local part id order instead of timestamp', async () => {
    const db = new Database(dbPath)
    try {
      createSchema(db)
      createIdentitySchema(db)
      insertSessionIdentity(db)
      insertMessage(db, 'assistant-1', JSON.stringify({ id: 'assistant-1', role: 'assistant' }))
      insertPart(db, 'part-003-finish-a', 'assistant-1', JSON.stringify({
        type: 'step-finish',
        snapshot: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }), 1000)
      insertPart(db, 'part-001-start-a', 'assistant-1', JSON.stringify({
        type: 'step-start',
        snapshot: '1111111111111111111111111111111111111111',
      }), 1000)
      insertPart(db, 'part-004-start-b', 'assistant-1', JSON.stringify({
        type: 'step-start',
        snapshot: '2222222222222222222222222222222222222222',
      }), 1000)
      insertPart(db, 'part-005-finish-b', 'assistant-1', JSON.stringify({
        type: 'step-finish',
        snapshot: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }), 1000)
    } finally {
      db.close()
    }

    const result = await readFixture()

    expect(result?.snapshotWindows.map(window => [
      window.startPartId,
      window.finishPartId,
      window.fromSnapshot,
      window.toSnapshot,
    ])).toEqual([
      [
        'part-001-start-a',
        'part-003-finish-a',
        '1111111111111111111111111111111111111111',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ],
      [
        'part-004-start-b',
        'part-005-finish-b',
        '2222222222222222222222222222222222222222',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      ],
    ])
  })
})
