import { Database } from 'bun:sqlite'
import envPaths from 'env-paths'
import { stat } from 'node:fs/promises'
import path from 'node:path'

import type { OpenCodeMessage, OpenCodeSessionRecord } from './types.js'

export type OpenCodeSqliteMessageRow = {
  id: string
  session_id: string
  time_created: number
  time_updated: number | null
  dataLengthBytes: number
  data: string
}

export type OpenCodeSqlitePartRow = {
  id: string
  message_id: string
  session_id: string
  time_created: number
  time_updated: number | null
  dataLengthBytes: number
  data: string
}

export type OpenCodeOfflineSessionReadResult = {
  source: 'opencode-sqlite'
  dbPath: string
  dbFingerprint: OpenCodeSqliteFingerprint
  historyShape?: 'supported' | 'unsupported'
  rawMessages: OpenCodeSqliteMessageRow[]
  rawParts: OpenCodeSqlitePartRow[]
  messages: OpenCodeMessage[]
  diagnostics: string[]
}

export type OpenCodeSqliteFingerprint = {
  dbMtimeMs: number
  dbSizeBytes: number
  walMtimeMs?: number
  walSizeBytes?: number
}

const MAX_OPENCODE_MESSAGES_PER_SESSION = 20_000
const MAX_OPENCODE_PARTS_PER_SESSION = 80_000
const MAX_OPENCODE_MESSAGE_JSON_BYTES = 256 * 1024
const MAX_OPENCODE_PART_JSON_BYTES = 2 * 1024 * 1024
export const OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE = 'unsupported-opencode-history-shape'

class UnsupportedOpenCodeHistoryShapeError extends Error {}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function safeParseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(raw))
  } catch {
    return null
  }
}

function isSafeProfileRootKey(value: string): boolean {
  return (
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/).some(segment => segment === '..' || segment === '')
  )
}

async function readSqliteFingerprint(dbPath: string): Promise<OpenCodeSqliteFingerprint | null> {
  try {
    const dbStat = await stat(dbPath)
    if (!dbStat.isFile()) {
      return null
    }
    const fingerprint: OpenCodeSqliteFingerprint = {
      dbMtimeMs: dbStat.mtimeMs,
      dbSizeBytes: dbStat.size,
    }
    try {
      const walStat = await stat(`${dbPath}-wal`)
      if (walStat.isFile()) {
        fingerprint.walMtimeMs = walStat.mtimeMs
        fingerprint.walSizeBytes = walStat.size
      }
    } catch {
      // WAL is optional.
    }
    return fingerprint
  } catch {
    return null
  }
}

export class OpenCodeOfflineSessionReader {
  resolveDbPath(profileRootKey: string): string | null {
    if (!isSafeProfileRootKey(profileRootKey)) {
      return null
    }
    const profileRoot = path.join(envPaths('claude-multimodel').data, 'opencode', 'profiles')
    const dbPath = path.resolve(
      profileRoot,
      profileRootKey,
      'data',
      'opencode',
      'opencode.db',
    )
    const relativePath = path.relative(profileRoot, dbPath)
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return null
    }
    return dbPath
  }

  async readSession(record: OpenCodeSessionRecord): Promise<OpenCodeOfflineSessionReadResult | null> {
    const diagnostics: string[] = []
    const dbPath = this.resolveDbPath(record.profileRootKey)
    if (!dbPath) {
      diagnostics.push('OpenCode profileRootKey is unsafe; skipped SQLite read.')
      return null
    }
    const initialFingerprint = await readSqliteFingerprint(dbPath)
    if (!initialFingerprint) {
      return null
    }

    const db = new Database(dbPath, { readonly: true })
    let transactionOpen = false
    try {
      db.exec('PRAGMA query_only = ON')
      db.exec('PRAGMA busy_timeout = 1000')
      this.assertSchema(db)
      db.exec('BEGIN')
      transactionOpen = true
      const rawMessages = db.query(
        'select id, session_id, time_created, time_updated, length(cast(data as blob)) as dataLengthBytes, data from message where session_id = ? order by time_created asc, id asc limit ?',
      ).all(record.opencodeSessionId, MAX_OPENCODE_MESSAGES_PER_SESSION + 1) as OpenCodeSqliteMessageRow[]
      const rawParts = db.query(
        'select id, message_id, session_id, time_created, time_updated, length(cast(data as blob)) as dataLengthBytes, data from part where session_id = ? order by time_created asc, id asc limit ?',
      ).all(record.opencodeSessionId, MAX_OPENCODE_PARTS_PER_SESSION + 1) as OpenCodeSqlitePartRow[]
      db.exec('COMMIT')
      transactionOpen = false

      if (rawMessages.length > MAX_OPENCODE_MESSAGES_PER_SESSION) {
        diagnostics.push(`OpenCode SQLite message cap exceeded for ${record.opencodeSessionId}.`)
        return {
          source: 'opencode-sqlite',
          dbPath,
          dbFingerprint: initialFingerprint,
          historyShape: 'supported',
          rawMessages: [],
          rawParts: [],
          messages: [],
          diagnostics,
        }
      }
      if (rawParts.length > MAX_OPENCODE_PARTS_PER_SESSION) {
        diagnostics.push(`OpenCode SQLite part cap exceeded for ${record.opencodeSessionId}.`)
        return {
          source: 'opencode-sqlite',
          dbPath,
          dbFingerprint: initialFingerprint,
          historyShape: 'supported',
          rawMessages: [],
          rawParts: [],
          messages: [],
          diagnostics,
        }
      }

      const messages = rawMessages.filter(row => {
        if (row.dataLengthBytes > MAX_OPENCODE_MESSAGE_JSON_BYTES) {
          diagnostics.push(`OpenCode SQLite message row ${row.id} exceeded JSON size cap.`)
          return false
        }
        return true
      })
      const parts = rawParts.filter(row => {
        if (row.dataLengthBytes > MAX_OPENCODE_PART_JSON_BYTES) {
          diagnostics.push(`OpenCode SQLite part row ${row.id} exceeded JSON size cap.`)
          return false
        }
        return true
      })

      if (!this.validateHistoryShape(messages, parts, diagnostics)) {
        diagnostics.push(`${OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE}: OpenCode SQLite history shape is not supported by this ledger bridge.`)
        return {
          source: 'opencode-sqlite',
          dbPath,
          dbFingerprint: initialFingerprint,
          historyShape: 'unsupported',
          rawMessages: [],
          rawParts: [],
          messages: [],
          diagnostics,
        }
      }

      const finalFingerprint = await readSqliteFingerprint(dbPath)
      if (
        finalFingerprint &&
        (
          finalFingerprint.dbMtimeMs !== initialFingerprint.dbMtimeMs ||
          finalFingerprint.dbSizeBytes !== initialFingerprint.dbSizeBytes ||
          finalFingerprint.walMtimeMs !== initialFingerprint.walMtimeMs ||
          finalFingerprint.walSizeBytes !== initialFingerprint.walSizeBytes
        )
      ) {
        diagnostics.push('OpenCode SQLite file changed while snapshot was read; using transaction snapshot.')
      }

      return {
        source: 'opencode-sqlite',
        dbPath,
        dbFingerprint: finalFingerprint ?? initialFingerprint,
        historyShape: 'supported',
        rawMessages: messages,
        rawParts: parts,
        messages: this.normalizeMessages(messages, parts, diagnostics),
        diagnostics,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      diagnostics.push(
        error instanceof UnsupportedOpenCodeHistoryShapeError
          ? `${OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE}: ${message}`
          : `OpenCode SQLite read failed - ${message}`,
      )
      return {
        source: 'opencode-sqlite',
        dbPath,
        dbFingerprint: initialFingerprint,
        historyShape: error instanceof UnsupportedOpenCodeHistoryShapeError ? 'unsupported' : 'supported',
        rawMessages: [],
        rawParts: [],
        messages: [],
        diagnostics,
      }
    } finally {
      if (transactionOpen) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // Best-effort cleanup before closing the read-only handle.
        }
      }
      db.close()
    }
  }

  private assertSchema(db: Database): void {
    const messageColumns = new Set(
      (db.query('pragma table_info(message)').all() as Array<{ name: string }>).map(row => row.name),
    )
    const partColumns = new Set(
      (db.query('pragma table_info(part)').all() as Array<{ name: string }>).map(row => row.name),
    )
    for (const column of ['id', 'session_id', 'time_created', 'time_updated', 'data']) {
      if (!messageColumns.has(column)) {
        throw new UnsupportedOpenCodeHistoryShapeError(`OpenCode SQLite message.${column} missing`)
      }
    }
    for (const column of ['id', 'message_id', 'session_id', 'time_created', 'time_updated', 'data']) {
      if (!partColumns.has(column)) {
        throw new UnsupportedOpenCodeHistoryShapeError(`OpenCode SQLite part.${column} missing`)
      }
    }
  }

  private validateHistoryShape(
    messages: OpenCodeSqliteMessageRow[],
    parts: OpenCodeSqlitePartRow[],
    diagnostics: string[],
  ): boolean {
    let supported = true
    for (const row of messages) {
      if (!safeParseJsonRecord(row.data)) {
        diagnostics.push(`${OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE}: OpenCode SQLite message row ${row.id} contains invalid JSON.`)
        supported = false
      }
    }
    for (const row of parts) {
      const parsed = safeParseJsonRecord(row.data)
      if (!parsed) {
        diagnostics.push(`${OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE}: OpenCode SQLite part row ${row.id} contains invalid JSON.`)
        supported = false
        continue
      }
      if (parsed.type !== 'tool') {
        continue
      }
      const tool = asString(parsed.tool)
      if (!tool) {
        diagnostics.push(`${OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE}: OpenCode SQLite toolpart ${row.id} missing tool name.`)
        supported = false
        continue
      }
      if (tool !== 'write' && tool !== 'edit') {
        continue
      }
      const state = asRecord(parsed.state)
      const input = asRecord(state?.input)
      if (!state || !input || !asString(input.filePath)) {
        diagnostics.push(`${OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE}: OpenCode SQLite ${tool} toolpart ${row.id} missing state/input/filePath.`)
        supported = false
      }
    }
    return supported
  }

  private normalizeMessages(
    rows: OpenCodeSqliteMessageRow[],
    parts: OpenCodeSqlitePartRow[],
    diagnostics: string[],
  ): OpenCodeMessage[] {
    const partsByMessage = new Map<string, Record<string, unknown>[]>()
    for (const part of parts) {
      const parsed = safeParseJsonRecord(part.data)
      if (!parsed) {
        diagnostics.push(`OpenCode SQLite part row ${part.id} contains invalid JSON.`)
        continue
      }
      parsed.id = part.id
      const bucket = partsByMessage.get(part.message_id) ?? []
      bucket.push(parsed)
      partsByMessage.set(part.message_id, bucket)
    }

    const messages: OpenCodeMessage[] = []
    for (const row of rows) {
      const info = safeParseJsonRecord(row.data)
      if (!info) {
        diagnostics.push(`OpenCode SQLite message row ${row.id} contains invalid JSON.`)
        continue
      }
      info.id = row.id
      messages.push({
        info,
        parts: partsByMessage.get(row.id) ?? [],
      })
    }
    return messages
  }
}

export const openCodeOfflineSessionReader = new OpenCodeOfflineSessionReader()
