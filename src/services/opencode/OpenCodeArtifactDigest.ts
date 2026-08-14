import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import path from 'node:path'

import { resolveOpenCodeBinaryPath } from './OpenCodeBinaryResolver.js'

export type OpenCodeArtifactDigest = `sha256:${string}`

const OPEN_CODE_ARTIFACT_DIGEST = /^sha256:[0-9a-f]{64}$/
/** Deliberately bounds synchronous hashing at startup/effect edges. */
export const OPEN_CODE_ARTIFACT_MAX_BYTES = 256 * 1024 * 1024
const OPEN_CODE_ARTIFACT_HASH_CHUNK_BYTES = 1024 * 1024

type ArtifactMetadata = {
  dev: number | bigint
  ino: number | bigint
  mode: number
  uid: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

type ArtifactOptions = {
  platform?: NodeJS.Platform
  maxBytes?: number
}

function metadata(stat: ReturnType<typeof fstatSync>): ArtifactMetadata {
  return {
    dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, size: stat.size,
    mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
  }
}

function sameMetadata(left: ArtifactMetadata, right: ArtifactMetadata): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
}

function trustedExecutable(stat: ReturnType<typeof fstatSync>, maxBytes: number): boolean {
  const uid = process.getuid?.()
  return stat.isFile() && stat.size >= 1 && stat.size <= maxBytes &&
    // Root- or runtime-owned files are acceptable, but no less-trusted principal may mutate them.
    (uid === undefined || stat.uid === 0 || stat.uid === uid) && (stat.mode & 0o022) === 0 &&
    (stat.mode & 0o111) !== 0
}

function digestFdStable(fd: number, before: ArtifactMetadata, maxBytes: number): OpenCodeArtifactDigest | null {
  if (!Number.isSafeInteger(before.size) || before.size < 1 || before.size > maxBytes) return null
  const hash = createHash('sha256')
  const chunk = Buffer.allocUnsafe(Math.min(before.size, OPEN_CODE_ARTIFACT_HASH_CHUNK_BYTES))
  let offset = 0
  while (offset < before.size) {
    const length = Math.min(chunk.byteLength, before.size - offset)
    const read = readSync(fd, chunk, 0, length, offset)
    if (read !== length) return null
    hash.update(chunk.subarray(0, read))
    offset += read
  }
  return sameMetadata(before, metadata(fstatSync(fd))) ? `sha256:${hash.digest('hex')}` : null
}

function openInstalledArtifact(binaryPath: string, options: ArtifactOptions = {}) {
  if ((options.platform ?? process.platform) !== 'linux' || !path.isAbsolute(binaryPath)) return null
  const maxBytes = options.maxBytes ?? OPEN_CODE_ARTIFACT_MAX_BYTES
  let fd = -1
  try {
    const linked = lstatSync(binaryPath)
    // This release proves only a direct Linux executable. Symlinks, scripts selected
    // through an interpreter, and wrapper/indirect launch paths publish no authority.
    if (linked.isSymbolicLink() || !linked.isFile()) return null
    fd = openSync(binaryPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    if (!trustedExecutable(opened, maxBytes) || opened.dev !== linked.dev || opened.ino !== linked.ino) return null
    const before = metadata(opened)
    const digest = digestFdStable(fd, before, maxBytes)
    const afterLinked = lstatSync(binaryPath)
    if (!digest || afterLinked.isSymbolicLink() || afterLinked.dev !== before.dev ||
      afterLinked.ino !== before.ino || !sameMetadata(before, metadata(fstatSync(fd)))) return null
    const result = { fd, identity: before, digest, maxBytes }
    fd = -1
    return result
  } catch { return null } finally { if (fd >= 0) closeSync(fd) }
}

function openExecutingArtifact(pid: number, options: ArtifactOptions = {}) {
  if ((options.platform ?? process.platform) !== 'linux' || !Number.isSafeInteger(pid) || pid < 1) return null
  const maxBytes = options.maxBytes ?? OPEN_CODE_ARTIFACT_MAX_BYTES
  let fd = -1
  try {
    // Opening procfs directly pins the executed inode; never readlink then reopen a path.
    fd = openSync(`/proc/${pid}/exe`, constants.O_RDONLY)
    const opened = fstatSync(fd)
    if (!trustedExecutable(opened, maxBytes)) return null
    const before = metadata(opened)
    const digest = digestFdStable(fd, before, maxBytes)
    if (!digest) return null
    const result = { fd, identity: before, digest, maxBytes }
    fd = -1
    return result
  } catch { return null } finally { if (fd >= 0) closeSync(fd) }
}

export function resolveOpenCodeArtifactDigest(
  binaryPath: string | null = resolveOpenCodeBinaryPath(),
  options: ArtifactOptions = {},
): OpenCodeArtifactDigest | null {
  if (!binaryPath) return null
  const opened = openInstalledArtifact(binaryPath, options)
  if (!opened) return null
  try { return opened.digest } finally { closeSync(opened.fd) }
}

export function resolveExecutingOpenCodeArtifactDigest(
  pid: number,
  options: ArtifactOptions = {},
): OpenCodeArtifactDigest | null {
  const opened = openExecutingArtifact(pid, options)
  if (!opened) return null
  try { return opened.digest } finally { closeSync(opened.fd) }
}

export function prepareOpenCodeArtifactDigestToken(
  expectedDigest: string,
  binaryPath: string | null = resolveOpenCodeBinaryPath(),
  options: ArtifactOptions = {},
): { consume(): boolean } | null {
  if (!OPEN_CODE_ARTIFACT_DIGEST.test(expectedDigest) || !binaryPath) return null
  const opened = openInstalledArtifact(binaryPath, options)
  if (!opened || opened.digest !== expectedDigest) { if (opened) closeSync(opened.fd); return null }
  let consumed = false
  return { consume: () => {
    if (consumed) return false
    consumed = true
    try {
      const current = fstatSync(opened.fd)
      const linked = lstatSync(binaryPath)
      return trustedExecutable(current, opened.maxBytes) && !linked.isSymbolicLink() &&
        linked.dev === opened.identity.dev && linked.ino === opened.identity.ino &&
        sameMetadata(opened.identity, metadata(current)) &&
        digestFdStable(opened.fd, opened.identity, opened.maxBytes) === expectedDigest
    } catch { return false } finally { closeSync(opened.fd) }
  } }
}

export function prepareExecutingOpenCodeArtifactDigestToken(
  pid: number,
  expectedDigest: string,
  options: ArtifactOptions = {},
): { consume(): boolean } | null {
  if (!OPEN_CODE_ARTIFACT_DIGEST.test(expectedDigest)) return null
  const opened = openExecutingArtifact(pid, options)
  if (!opened || opened.digest !== expectedDigest) { if (opened) closeSync(opened.fd); return null }
  let consumed = false
  return { consume: () => {
    if (consumed) return false
    consumed = true
    try {
      const current = fstatSync(opened.fd)
      return trustedExecutable(current, opened.maxBytes) && sameMetadata(opened.identity, metadata(current)) &&
        digestFdStable(opened.fd, opened.identity, opened.maxBytes) === expectedDigest
    } catch { return false } finally { closeSync(opened.fd) }
  } }
}
