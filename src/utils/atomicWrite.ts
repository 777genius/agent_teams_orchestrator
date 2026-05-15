import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const ATOMIC_RENAME_MAX_ATTEMPTS = 8
const ATOMIC_RENAME_RETRY_BASE_DELAY_MS = 40
const ATOMIC_RENAME_RETRY_MAX_DELAY_MS = 250
const ATOMIC_RENAME_RETRY_JITTER_MS = 25
const RETRYABLE_RENAME_ERROR_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

type AtomicWriteDeps = {
  mkdir: typeof fs.mkdir
  writeFile: typeof fs.writeFile
  rename: typeof fs.rename
  copyFile: typeof fs.copyFile
  unlink: typeof fs.unlink
  rm: typeof fs.rm
  sleep: (ms: number) => Promise<void>
  now: () => number
  randomId: () => string
  getRetryDelayMs: (attemptIndex: number) => number
}

type AtomicWriteOptions = {
  encoding?: BufferEncoding
  mode?: number
  deps?: Partial<AtomicWriteDeps>
}

type AtomicJsonWriteOptions = AtomicWriteOptions & {
  indent?: number | string
}

function getErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return null
  }
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function isRetryableRenameError(error: unknown): boolean {
  const code = getErrorCode(error)
  return code ? RETRYABLE_RENAME_ERROR_CODES.has(code) : false
}

function isCrossDeviceRenameError(error: unknown): boolean {
  return getErrorCode(error) === 'EXDEV'
}

function defaultRetryDelayMs(attemptIndex: number): number {
  const attempt = attemptIndex + 1
  const backoff = Math.min(
    ATOMIC_RENAME_RETRY_MAX_DELAY_MS,
    ATOMIC_RENAME_RETRY_BASE_DELAY_MS * attempt,
  )
  return backoff + Math.floor(Math.random() * (ATOMIC_RENAME_RETRY_JITTER_MS + 1))
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function resolveDeps(overrides?: Partial<AtomicWriteDeps>): AtomicWriteDeps {
  return {
    mkdir: overrides?.mkdir ?? fs.mkdir,
    writeFile: overrides?.writeFile ?? fs.writeFile,
    rename: overrides?.rename ?? fs.rename,
    copyFile: overrides?.copyFile ?? fs.copyFile,
    unlink: overrides?.unlink ?? fs.unlink,
    rm: overrides?.rm ?? fs.rm,
    sleep: overrides?.sleep ?? defaultSleep,
    now: overrides?.now ?? Date.now,
    randomId: overrides?.randomId ?? randomUUID,
    getRetryDelayMs: overrides?.getRetryDelayMs ?? defaultRetryDelayMs,
  }
}

async function renameWithRetry(
  tempPath: string,
  finalPath: string,
  deps: AtomicWriteDeps,
): Promise<void> {
  for (let attemptIndex = 0; attemptIndex < ATOMIC_RENAME_MAX_ATTEMPTS; attemptIndex += 1) {
    try {
      await deps.rename(tempPath, finalPath)
      return
    } catch (error) {
      const hasAttemptsLeft = attemptIndex + 1 < ATOMIC_RENAME_MAX_ATTEMPTS
      if (!hasAttemptsLeft || !isRetryableRenameError(error)) {
        throw error
      }
      await deps.sleep(deps.getRetryDelayMs(attemptIndex))
    }
  }
}

async function moveFileIntoPlace(
  tempPath: string,
  finalPath: string,
  deps: AtomicWriteDeps,
): Promise<void> {
  try {
    await renameWithRetry(tempPath, finalPath, deps)
    return
  } catch (error) {
    if (!isCrossDeviceRenameError(error)) {
      throw error
    }
  }

  await deps.copyFile(tempPath, finalPath)
  await deps.unlink(tempPath).catch(() => undefined)
}

export async function writeFileAtomic(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const deps = resolveDeps(options.deps)
  const tempPath = join(
    dirname(filePath),
    `${basename(filePath)}.tmp.${process.pid}.${deps.now()}.${deps.randomId()}`,
  )

  try {
    await deps.mkdir(dirname(filePath), { recursive: true })
    await deps.writeFile(tempPath, content, {
      encoding: options.encoding ?? 'utf8',
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    })
    await moveFileIntoPlace(tempPath, filePath, deps)
  } catch (error) {
    await deps.rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  options: AtomicJsonWriteOptions = {},
): Promise<void> {
  const serialized = JSON.stringify(value, null, options.indent)
  if (serialized === undefined) {
    throw new Error(`Cannot atomically write non-JSON value to ${filePath}`)
  }
  await writeFileAtomic(filePath, serialized, options)
}
