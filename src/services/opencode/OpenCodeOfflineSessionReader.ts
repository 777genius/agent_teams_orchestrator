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

export type OpenCodeSqliteProjectIdentity = {
  id: string
  worktree: string | null
  vcs: string | null
}

export type OpenCodeSqliteSessionIdentity = {
  sessionId: string
  projectId: string | null
  directory: string | null
  project: OpenCodeSqliteProjectIdentity | null
  snapshotEvidenceSupported: boolean
  unsupportedReasons: string[]
}

export type OpenCodeSnapshotStepPart = {
  partId: string
  messageId: string
  sessionId: string
  partOrder: number
  timeCreated: number
  kind: 'step-start' | 'step-finish'
  snapshot: string
}

export type OpenCodePatchPart = {
  partId: string
  messageId: string
  sessionId: string
  partOrder: number
  timeCreated: number
  hash: string
  files: string[]
}

export type OpenCodeSnapshotWindow = {
  windowId: string
  messageId: string
  sessionId: string
  fromSnapshot: string
  toSnapshot: string
  startPartId: string
  finishPartId: string
  startPartOrder: number
  finishPartOrder: number
}

export type OpenCodeOfflineSessionReadResult = {
  source: 'opencode-sqlite'
  dbPath: string
  dbFingerprint: OpenCodeSqliteFingerprint
  historyShape?: 'supported' | 'unsupported'
  sessionIdentity: OpenCodeSqliteSessionIdentity | null
  snapshotStepParts: OpenCodeSnapshotStepPart[]
  patchParts: OpenCodePatchPart[]
  snapshotWindows: OpenCodeSnapshotWindow[]
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

function asStringOrNull(value: unknown): string | null {
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

function isSameOrDescendantPath(childPath: string, parentPath: string): boolean {
  const rel = path.relative(parentPath, childPath)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function sameResolvedPath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right)
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
      const sessionIdentity = this.readSessionIdentity(db, record, diagnostics)
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
          sessionIdentity,
          snapshotStepParts: [],
          patchParts: [],
          snapshotWindows: [],
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
          sessionIdentity,
          snapshotStepParts: [],
          patchParts: [],
          snapshotWindows: [],
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
          sessionIdentity,
          snapshotStepParts: [],
          patchParts: [],
          snapshotWindows: [],
          rawMessages: [],
          rawParts: [],
          messages: [],
          diagnostics,
        }
      }

      const snapshotParts = this.extractSnapshotParts(parts, diagnostics)

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
        sessionIdentity,
        snapshotStepParts: snapshotParts.snapshotStepParts,
        patchParts: snapshotParts.patchParts,
        snapshotWindows: this.buildSnapshotWindows(snapshotParts.snapshotStepParts, diagnostics),
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
        sessionIdentity: null,
        snapshotStepParts: [],
        patchParts: [],
        snapshotWindows: [],
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

  private tableColumns(db: Database, tableName: 'message' | 'part' | 'session' | 'project'): Set<string> | null {
    try {
      const rows = db.query(`pragma table_info(${tableName})`).all() as Array<{ name: string }>
      if (rows.length === 0) {
        return null
      }
      return new Set(rows.map(row => row.name))
    } catch {
      return null
    }
  }

  private hasColumns(columns: Set<string> | null, required: string[]): boolean {
    return !!columns && required.every(column => columns.has(column))
  }

  private readSessionIdentity(
    db: Database,
    record: OpenCodeSessionRecord,
    diagnostics: string[],
  ): OpenCodeSqliteSessionIdentity | null {
    const sessionColumns = this.tableColumns(db, 'session')
    if (!this.hasColumns(sessionColumns, ['id', 'project_id', 'directory'])) {
      diagnostics.push('snapshot-project-identity-missing: OpenCode SQLite session identity columns are unavailable.')
      return null
    }

    try {
      const session = db.query(
        'select id, project_id, directory from session where id = ?',
      ).get(record.opencodeSessionId) as { id: string; project_id: string | null; directory: string | null } | null
      if (!session) {
        diagnostics.push('snapshot-project-identity-missing: OpenCode SQLite session row is unavailable.')
        return null
      }

      const unsupportedReasons: string[] = []
      let project: OpenCodeSqliteProjectIdentity | null = null
      if (!session.project_id) {
        unsupportedReasons.push('snapshot-project-identity-missing')
      } else {
        const projectColumns = this.tableColumns(db, 'project')
        if (!this.hasColumns(projectColumns, ['id', 'worktree', 'vcs'])) {
          unsupportedReasons.push('snapshot-project-identity-missing')
          diagnostics.push('snapshot-project-identity-missing: OpenCode SQLite project identity columns are unavailable.')
        } else {
          const projectRow = db.query(
            'select id, worktree, vcs from project where id = ?',
          ).get(session.project_id) as { id: string; worktree: string | null; vcs: string | null } | null
          if (!projectRow) {
            unsupportedReasons.push('snapshot-project-identity-missing')
            diagnostics.push('snapshot-project-identity-missing: OpenCode SQLite project row is unavailable.')
          } else {
            project = {
              id: projectRow.id,
              worktree: projectRow.worktree,
              vcs: projectRow.vcs,
            }
          }
        }
      }

      if (project?.vcs !== 'git') {
        unsupportedReasons.push('snapshot-project-not-git')
      }
      if (!project?.worktree) {
        unsupportedReasons.push('snapshot-project-identity-missing')
      }
      if (!session.directory) {
        unsupportedReasons.push('snapshot-project-identity-missing')
      }
      if (project?.worktree && session.directory && !isSameOrDescendantPath(
        path.resolve(session.directory),
        path.resolve(project.worktree),
      )) {
        unsupportedReasons.push('snapshot-session-directory-outside-worktree')
      }
      if (project?.worktree && !sameResolvedPath(record.projectPath, project.worktree)) {
        unsupportedReasons.push('snapshot-project-worktree-mismatch')
      }

      const uniqueUnsupportedReasons = [...new Set(unsupportedReasons)]
      for (const reason of uniqueUnsupportedReasons) {
        diagnostics.push(`${reason}: OpenCode snapshot session identity is not usable for full-text evidence.`)
      }

      return {
        sessionId: session.id,
        projectId: session.project_id,
        directory: session.directory,
        project,
        snapshotEvidenceSupported: uniqueUnsupportedReasons.length === 0,
        unsupportedReasons: uniqueUnsupportedReasons,
      }
    } catch (error) {
      diagnostics.push(`snapshot-project-identity-missing: OpenCode SQLite session identity read failed - ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  private extractSnapshotParts(
    parts: OpenCodeSqlitePartRow[],
    diagnostics: string[],
  ): { snapshotStepParts: OpenCodeSnapshotStepPart[]; patchParts: OpenCodePatchPart[] } {
    const snapshotStepParts: OpenCodeSnapshotStepPart[] = []
    const patchParts: OpenCodePatchPart[] = []
    const orderedByMessage = new Map<string, OpenCodeSqlitePartRow[]>()
    for (const row of parts) {
      const bucket = orderedByMessage.get(row.message_id) ?? []
      bucket.push(row)
      orderedByMessage.set(row.message_id, bucket)
    }

    const partOrderById = new Map<string, number>()
    for (const rows of orderedByMessage.values()) {
      rows.sort((left, right) => left.id.localeCompare(right.id))
      rows.forEach((row, index) => partOrderById.set(row.id, index))
    }

    for (const row of parts) {
      const parsed = safeParseJsonRecord(row.data)
      if (!parsed) {
        continue
      }
      const partOrder = partOrderById.get(row.id) ?? 0
      if (parsed.type === 'step-start' || parsed.type === 'step-finish') {
        const snapshot = asStringOrNull(parsed.snapshot)
        if (!snapshot) {
          diagnostics.push(`snapshot-window-missing: OpenCode ${parsed.type} part ${row.id} missing snapshot hash.`)
          continue
        }
        snapshotStepParts.push({
          partId: row.id,
          messageId: row.message_id,
          sessionId: row.session_id,
          partOrder,
          timeCreated: row.time_created,
          kind: parsed.type,
          snapshot,
        })
        continue
      }

      if (parsed.type === 'patch') {
        const hash = asStringOrNull(parsed.hash)
        const files = Array.isArray(parsed.files)
          ? parsed.files.filter((file): file is string => typeof file === 'string' && file.length > 0)
          : []
        if (!hash || !Array.isArray(parsed.files)) {
          diagnostics.push(`snapshot-patch-part-malformed: OpenCode patch part ${row.id} has unsupported shape.`)
          continue
        }
        patchParts.push({
          partId: row.id,
          messageId: row.message_id,
          sessionId: row.session_id,
          partOrder,
          timeCreated: row.time_created,
          hash,
          files,
        })
      }
    }

    snapshotStepParts.sort((left, right) =>
      left.messageId.localeCompare(right.messageId) ||
      left.partOrder - right.partOrder ||
      left.partId.localeCompare(right.partId)
    )
    patchParts.sort((left, right) =>
      left.messageId.localeCompare(right.messageId) ||
      left.partOrder - right.partOrder ||
      left.partId.localeCompare(right.partId)
    )

    return { snapshotStepParts, patchParts }
  }

  private buildSnapshotWindows(
    snapshotStepParts: OpenCodeSnapshotStepPart[],
    diagnostics: string[],
  ): OpenCodeSnapshotWindow[] {
    const windows: OpenCodeSnapshotWindow[] = []
    const byMessage = new Map<string, OpenCodeSnapshotStepPart[]>()
    for (const part of snapshotStepParts) {
      const bucket = byMessage.get(part.messageId) ?? []
      bucket.push(part)
      byMessage.set(part.messageId, bucket)
    }

    for (const [messageId, parts] of byMessage.entries()) {
      parts.sort((left, right) =>
        left.partOrder - right.partOrder ||
        left.partId.localeCompare(right.partId)
      )
      let openStart: OpenCodeSnapshotStepPart | null = null
      for (const part of parts) {
        if (part.kind === 'step-start') {
          if (openStart) {
            diagnostics.push(`snapshot-window-ambiguous: OpenCode step-start part ${openStart.partId} was not closed before ${part.partId}.`)
          }
          openStart = part
          continue
        }
        if (!openStart) {
          diagnostics.push(`snapshot-window-missing: OpenCode step-finish part ${part.partId} has no preceding step-start in message ${messageId}.`)
          continue
        }
        windows.push({
          windowId: `${messageId}:${openStart.partId}->${part.partId}`,
          messageId,
          sessionId: part.sessionId,
          fromSnapshot: openStart.snapshot,
          toSnapshot: part.snapshot,
          startPartId: openStart.partId,
          finishPartId: part.partId,
          startPartOrder: openStart.partOrder,
          finishPartOrder: part.partOrder,
        })
        openStart = null
      }
      if (openStart) {
        diagnostics.push(`snapshot-window-missing: OpenCode step-start part ${openStart.partId} has no following step-finish in message ${messageId}.`)
      }
    }

    return windows
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
      if (tool !== 'write' && tool !== 'edit' && tool !== 'apply_patch') {
        continue
      }
      const state = asRecord(parsed.state)
      if (!state) {
        diagnostics.push(`${OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE}: OpenCode SQLite ${tool} toolpart ${row.id} missing state.`)
        supported = false
        continue
      }
      const status = asString(state.status)?.toLowerCase()
      if (status && status !== 'completed') {
        continue
      }
      if (tool === 'apply_patch') {
        const input = asRecord(state?.input)
        if (typeof input?.patch !== 'string' || input.patch.length === 0) {
          diagnostics.push(`OpenCode SQLite apply_patch toolpart ${row.id} has unsupported state/input/patch shape; it will be skipped.`)
        }
        continue
      }
      const input = asRecord(state?.input)
      if (!input) {
        diagnostics.push(`${OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE}: OpenCode SQLite ${tool} toolpart ${row.id} missing state/input.`)
        supported = false
        continue
      }
      if (!asString(input.filePath)) {
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
