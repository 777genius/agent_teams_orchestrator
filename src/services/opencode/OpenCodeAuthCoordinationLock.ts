import { boundedPathsIdentity, validateOpenCodeBoundedPaths, assertBoundedAuthObjects, boundedCoordinationDatabase, type OpenCodeBoundedExecutionPaths } from './OpenCodeBoundedPaths.js'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { createRequire } from 'node:module'
import type { Database } from 'bun:sqlite'

const requireSqlite = createRequire(import.meta.url)

// Keep the same SQLite transaction/lease algorithm for Bun and selected Node ESM.
// Node requires its built-in DatabaseSync (Node >=22.13); no alternate lock authority.
function createCoordinationDatabase(databasePath: string): Database {
  if ('Bun' in globalThis) {
    const { Database: BunDatabase } = requireSqlite('bun:sqlite') as typeof import('bun:sqlite')
    return new BunDatabase(databasePath, { create: true, strict: true })
  }
  const { DatabaseSync } = requireSqlite('node:sqlite') as { DatabaseSync: new (path: string) => {
    exec(sql: string): void; prepare(sql: string): unknown; close(): void
  } }
  const db = new DatabaseSync(databasePath)
  return { exec: (sql: string) => db.exec(sql), query: (sql: string) => db.prepare(sql),
    close: () => db.close() } as unknown as Database
}

import {
  throwOpenCodeAbortReason,
  waitForOpenCodeAbortableDelay,
} from './OpenCodeRuntimeDeadline.js'

const AUTH_COORDINATION_LOCK_KEY = 'auth-store'
const AUTH_COORDINATION_LOCK_TIMEOUT_MS = 300_000
const AUTH_COORDINATION_LOCK_RETRY_MS = 25
const AUTH_COORDINATION_LOCK_RELEASE_TIMEOUT_MS = 10_000

type AuthCoordinationLockRow = {
  ownerId: string
  pid: number
}

type AuthCoordinationLease = {
  logicalAuthority: string
  boundedIdentity: string | null
  active: boolean
}

const heldCoordinationLocks = new AsyncLocalStorage<
  ReadonlyMap<string, AuthCoordinationLease>
>()

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
}

function isSqliteBusy(error: unknown): boolean {
  return isNodeErrorWithCode(error, 'SQLITE_BUSY')
    || (error instanceof Error && /database is locked/i.test(error.message))
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  if (pid === process.pid) {
    return true
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isNodeErrorWithCode(error, 'ESRCH')
  }
}

export function resolveOpenCodeAuthCoordinationPath(filePath: string): string {
  const resolved = path.resolve(filePath)
  const profileMarker = `${path.sep}opencode${path.sep}profiles${path.sep}`
  const profileMarkerIndex = resolved.indexOf(profileMarker)
  if (profileMarkerIndex < 0) {
    return resolved
  }
  return path.join(resolved.slice(0, profileMarkerIndex), 'opencode', 'auth.json')
}

export function getCoordinationDatabasePath(authPath: string, boundedPaths?: OpenCodeBoundedExecutionPaths): string {
  if (boundedPaths) return boundedCoordinationDatabase(authPath, boundedPaths)
  return `${resolveOpenCodeAuthCoordinationPath(authPath)}.agent-teams-coordination.sqlite`
}

function openCoordinationDatabase(databasePath: string): Database {
  const database = createCoordinationDatabase(databasePath)
  database.exec('PRAGMA busy_timeout = 0')
  return database
}

function rollbackQuietly(database: Database): void {
  try {
    database.exec('ROLLBACK')
  } catch {
    // The transaction may not have started when another process owns SQLite's write lock.
  }
}

function tryAcquireCoordinationLock(input: {
  databasePath: string
  ownerId: string
}): boolean {
  const database = openCoordinationDatabase(input.databasePath)
  try {
    database.exec('BEGIN IMMEDIATE')
    database.exec(`
      CREATE TABLE IF NOT EXISTS agent_teams_auth_locks (
        lock_key TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL
      )
    `)
    const current = database.query<AuthCoordinationLockRow, [string]>(`
      SELECT owner_id AS ownerId, pid
      FROM agent_teams_auth_locks
      WHERE lock_key = ?
    `).get(AUTH_COORDINATION_LOCK_KEY)

    if (current && isProcessAlive(current.pid)) {
      database.exec('ROLLBACK')
      return false
    }

    if (current) {
      database.query(`
        DELETE FROM agent_teams_auth_locks
        WHERE lock_key = ? AND owner_id = ?
      `).run(AUTH_COORDINATION_LOCK_KEY, current.ownerId)
    }
    database.query(`
      INSERT INTO agent_teams_auth_locks (lock_key, owner_id, pid, created_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(AUTH_COORDINATION_LOCK_KEY, input.ownerId, process.pid, Date.now())
    database.exec('COMMIT')
    return true
  } catch (error) {
    rollbackQuietly(database)
    if (isSqliteBusy(error)) {
      return false
    }
    throw error
  } finally {
    database.close(false)
  }
}

function tryReleaseCoordinationLock(input: {
  databasePath: string
  ownerId: string
}): boolean {
  const database = openCoordinationDatabase(input.databasePath)
  try {
    database.exec('BEGIN IMMEDIATE')
    database.query(`
      DELETE FROM agent_teams_auth_locks
      WHERE lock_key = ? AND owner_id = ?
    `).run(AUTH_COORDINATION_LOCK_KEY, input.ownerId)
    database.exec('COMMIT')
    return true
  } catch (error) {
    rollbackQuietly(database)
    if (isSqliteBusy(error)) {
      return false
    }
    throw error
  } finally {
    database.close(false)
  }
}

async function releaseCoordinationLock(input: {
  databasePath: string
  ownerId: string
  deadlineMs: number
  description: string
}): Promise<void> {
  for (;;) {
    if (tryReleaseCoordinationLock(input)) {
      return
    }
    if (Date.now() >= input.deadlineMs) {
      throw new Error(`Timed out releasing ${input.description}`)
    }
    await delay(AUTH_COORDINATION_LOCK_RETRY_MS)
  }
}

export async function withOpenCodeAuthCoordinationLock<T>(input: {
  authPath: string
  boundedPaths?: OpenCodeBoundedExecutionPaths
  operation: () => Promise<T>
  timeoutMs?: number
  description?: string
  abortSignal?: AbortSignal
}): Promise<T> {
  if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
  if (input.boundedPaths) input = { ...input, boundedPaths: validateOpenCodeBoundedPaths(input.boundedPaths) }
  const databasePath = getCoordinationDatabasePath(input.authPath, input.boundedPaths)
  const inheritedLocks = heldCoordinationLocks.getStore()
  const logicalAuthority = resolveOpenCodeAuthCoordinationPath(input.authPath)
  const boundedIdentity = input.boundedPaths ? boundedPathsIdentity(input.boundedPaths) : null
  for (const [heldPath, lease] of inheritedLocks ?? []) {
    if (lease.active && lease.logicalAuthority === logicalAuthority
      && (heldPath !== databasePath || lease.boundedIdentity !== boundedIdentity)) throw new Error('opencode_bounded_coordination_mismatch')
  }
  if (inheritedLocks?.get(databasePath)?.active) {
    if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
    return input.operation()
  }

  if (input.boundedPaths) await assertBoundedAuthObjects(input.boundedPaths)
  await mkdir(path.dirname(databasePath), { recursive: true })
  const timeoutMs = Math.max(1, input.timeoutMs ?? AUTH_COORDINATION_LOCK_TIMEOUT_MS)
  const deadlineMs = Date.now() + timeoutMs
  const description = input.description ?? 'OpenCode auth coordination lock'
  const ownerId = randomUUID()

  for (;;) {
    if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
    if (tryAcquireCoordinationLock({ databasePath, ownerId })) {
      break
    }
    if (Date.now() >= deadlineMs) {
      throw new Error(`Timed out waiting for ${description}`)
    }
    await waitForOpenCodeAbortableDelay(
      AUTH_COORDINATION_LOCK_RETRY_MS,
      input.abortSignal,
    )
  }

  const lease: AuthCoordinationLease = { active: true, logicalAuthority, boundedIdentity }
  const activeLocks = new Map(inheritedLocks)
  activeLocks.set(databasePath, lease)
  try {
    if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
    return await heldCoordinationLocks.run(activeLocks, input.operation)
  } finally {
    lease.active = false
    await releaseCoordinationLock({
      databasePath,
      ownerId,
      deadlineMs: Date.now() + Math.min(timeoutMs, AUTH_COORDINATION_LOCK_RELEASE_TIMEOUT_MS),
      description,
    })
  }
}
