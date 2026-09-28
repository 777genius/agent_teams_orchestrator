import { randomUUID } from 'node:crypto'
import { linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, closeSync, unlinkSync, writeSync, type Stats } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The agent-teams-controller file lock (Product agent-teams-controller/src/internal/fileLock.js),
 * byte-compatible so Owner and MCP controller writers exclude each other: the `<resource>.lock`
 * PID/time/token record, the `-transition-v2` gate and the optional `pidns:` owner line. Only the
 * wait between attempts is asynchronous.
 */
const ACQUIRE_TIMEOUT_MS = 5_000
const RETRY_INTERVAL_MS = 20

export class ControllerFileLockTimeoutError extends Error {
  constructor(resource: string) {
    super(`File lock timeout: ${resource}`)
    this.name = 'ControllerFileLockTimeoutError'
  }
}

let ownPidNamespace: string | null | undefined

function currentPidNamespace(): string | null {
  if (ownPidNamespace === undefined) {
    ownPidNamespace = null
    if (process.platform === 'linux') {
      try {
        const link = /^pid:\[([1-9][0-9]*)\]$/.exec(readlinkSync('/proc/self/ns/pid'))
        ownPidNamespace = link ? link[1]! : null
      } catch {
        // Without procfs the records stay PID-only, exactly like the controller.
      }
    }
  }
  return ownPidNamespace
}

function ownerNamespaceLine(): string {
  const namespace = currentPidNamespace()
  return namespace === null ? '' : `pidns:${namespace}\n`
}

function isOwnerAlive(pid: number, namespace: string | undefined): boolean {
  // A PID recorded in another namespace cannot be probed from here; it stays live.
  if (namespace !== undefined && namespace !== currentPidNamespace()) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function codeOf(error: unknown): string | undefined { return (error as NodeJS.ErrnoException).code }
function statOrMissing(name: string): Stats | null {
  try { return lstatSync(name) } catch (error) { if (codeOf(error) === 'ENOENT') return null; throw error }
}
function readOrMissing(name: string): string | null {
  try { return readFileSync(name, 'utf8') } catch (error) { if (codeOf(error) === 'ENOENT') return null; throw error }
}
function unlinkOrMissing(name: string): void {
  try { unlinkSync(name) } catch (error) { if (codeOf(error) !== 'ENOENT') throw error }
}
function removeEmptyGate(gate: string): void {
  try { rmdirSync(gate) } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(codeOf(error) ?? '')) throw error
  }
}
function parsePid(value: string): number | null {
  if (!/^[1-9][0-9]*$/.test(value)) return null
  const pid = Number(value)
  return Number.isSafeInteger(pid) ? pid : null
}
function writeComplete(name: string, content: string): void {
  const fd = openSync(name, 'wx')
  try {
    const bytes = Buffer.from(content, 'utf8')
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset)
      if (written <= 0) throw new Error(`Unable to complete file lock candidate: ${name}`)
      offset += written
    }
  } finally {
    closeSync(fd)
  }
}

function recoverGate(gate: string): void {
  let entries: string[]
  try { entries = readdirSync(gate) } catch (error) { if (codeOf(error) === 'ENOENT') return; throw error }
  if (entries.length === 0) { removeEmptyGate(gate); return }
  if (entries.length !== 1) return
  const entry = entries[0]!
  const match = /^owner-([1-9][0-9]*)-((?:strict[-:])?[a-f0-9-]{36})$/.exec(entry)
  if (!match) return
  const pid = parsePid(match[1]!)
  if (pid === null) return
  const ownerPath = join(gate, entry)
  if (!statOrMissing(ownerPath)?.isFile()) return
  const prefix = `file-lock-transition-v2\n${pid}\n${match[2]}\n`
  const content = readOrMissing(ownerPath)
  if (!content?.startsWith(prefix)) return
  const owner = /^(?:pidns:([1-9][0-9]*)\n)?$/.exec(content.slice(prefix.length))
  if (!owner || isOwnerAlive(pid, owner[1])) return
  unlinkOrMissing(ownerPath)
  removeEmptyGate(gate)
}

function acquireGate(gate: string, token: string): string | null {
  if (statOrMissing(gate)?.isDirectory()) { recoverGate(gate); return null }
  const candidate = `${gate}.candidate-${process.pid}-${randomUUID()}`
  const entry = `owner-${process.pid}-${token}`
  mkdirSync(candidate)
  let published = false
  try {
    writeComplete(join(candidate, entry), `file-lock-transition-v2\n${process.pid}\n${token}\n${ownerNamespaceLine()}`)
    try {
      renameSync(candidate, gate)
      published = true
      return entry
    } catch (error) {
      const code = codeOf(error)
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
      recoverGate(gate)
      return null
    }
  } finally {
    if (!published) { unlinkOrMissing(join(candidate, entry)); rmdirSync(candidate) }
  }
}

function readLockInfo(lockPath: string): { stat: Stats; content: string | null } | null {
  const stat = statOrMissing(lockPath)
  if (!stat) return null
  return { stat, content: stat.isFile() ? readOrMissing(lockPath) : null }
}

function recoverDataLock(lockPath: string): void {
  const observed = readLockInfo(lockPath)
  // A directory lock belongs to proper-lockfile owners; only its runtime may release it.
  if (!observed || observed.stat.isDirectory() || !observed.stat.isFile() || observed.content === null) return
  const record = /^([1-9][0-9]*)\n[0-9]+\n(?:[^\n]+\n(?:pidns:([1-9][0-9]*)\n)?)?$/.exec(observed.content)
  const pid = record ? parsePid(record[1]!) : null
  if (pid === null || isOwnerAlive(pid, record?.[2])) return
  const current = readLockInfo(lockPath)
  if (current && current.stat.dev === observed.stat.dev && current.stat.ino === observed.stat.ino &&
    current.stat.birthtimeMs === observed.stat.birthtimeMs && current.content === observed.content) unlinkOrMissing(lockPath)
}

function releaseLock(lockPath: string, token: string): void {
  const lines = readLockInfo(lockPath)?.content?.split('\n')
  if (lines?.[0] === String(process.pid) && lines[2] === token) unlinkOrMissing(lockPath)
}

function tryAcquire(lockPath: string, token: string): boolean {
  mkdirSync(dirname(lockPath), { recursive: true })
  const gate = `${lockPath}-transition-v2`
  const entry = acquireGate(gate, token)
  if (entry === null) return false
  let published = false
  try {
    try {
      recoverDataLock(lockPath)
      if (statOrMissing(lockPath)) return false
      const candidate = `${lockPath}.candidate-${process.pid}-${randomUUID()}`
      try {
        writeComplete(candidate, `${process.pid}\n${Date.now()}\n${token}\n${ownerNamespaceLine()}`)
        try { linkSync(candidate, lockPath); published = true } catch (error) { if (codeOf(error) !== 'EEXIST') throw error }
      } finally {
        unlinkOrMissing(candidate)
      }
      return published
    } finally {
      unlinkOrMissing(join(gate, entry))
      removeEmptyGate(gate)
    }
  } catch (error) {
    if (published) releaseLock(lockPath, token)
    throw error
  }
}

/** Holds `<resource>.lock` exactly as the controller's withFileLockSync would. */
export async function withControllerFileLock<T>(
  resource: string,
  run: () => Promise<T>,
  options: { acquireTimeoutMs?: number; retryIntervalMs?: number } = {},
): Promise<T> {
  const lockPath = `${resource}.lock`
  const deadline = Date.now() + (options.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS)
  const retryIntervalMs = options.retryIntervalMs ?? RETRY_INTERVAL_MS
  const token = randomUUID()
  while (!tryAcquire(lockPath, token)) {
    if (Date.now() >= deadline) throw new ControllerFileLockTimeoutError(resource)
    await new Promise(resolve => setTimeout(resolve, Math.min(retryIntervalMs, Math.max(0, deadline - Date.now()))))
  }
  try {
    return await run()
  } finally {
    releaseLock(lockPath, token)
  }
}
