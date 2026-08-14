import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs'

import { resolveOpenCodeBinaryPath } from './OpenCodeBinaryResolver.js'

export type OpenCodeArtifactDigest = `sha256:${string}`

const OPEN_CODE_ARTIFACT_DIGEST = /^sha256:[0-9a-f]{64}$/
const OPEN_CODE_ARTIFACT_HASH_CHUNK_BYTES = 1024 * 1024

function digestOpenCodeArtifactFd(fd: number, size: number): OpenCodeArtifactDigest | null {
  if (!Number.isSafeInteger(size) || size < 1) return null
  const hash = createHash('sha256')
  const chunk = Buffer.allocUnsafe(Math.min(size, OPEN_CODE_ARTIFACT_HASH_CHUNK_BYTES))
  let offset = 0
  while (offset < size) {
    const length = Math.min(chunk.byteLength, size - offset)
    const read = readSync(fd, chunk, 0, length, offset)
    if (read !== length) return null
    hash.update(chunk.subarray(0, read))
    offset += read
  }
  return `sha256:${hash.digest('hex')}`
}

function openCanonicalOpenCodeArtifact(binaryPath: string): {
  fd: number
  canonicalPath: string
  dev: number | bigint
  ino: number | bigint
  size: number
  digest: OpenCodeArtifactDigest
} | null {
  let fd = -1
  try {
    const canonicalPath = realpathSync(binaryPath)
    fd = openSync(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    const linked = lstatSync(canonicalPath)
    const digest = opened.isFile() && linked.isFile() && !linked.isSymbolicLink() &&
      opened.dev === linked.dev && opened.ino === linked.ino
      ? digestOpenCodeArtifactFd(fd, opened.size)
      : null
    if (!digest) { closeSync(fd); return null }
    const result = {
      fd,
      canonicalPath,
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      digest,
    }
    fd = -1
    return result
  } catch {
    if (fd >= 0) closeSync(fd)
    return null
  }
}

/** Hashes the exact canonical executable bytes selected by the OpenCode resolver. */
export function resolveOpenCodeArtifactDigest(
  binaryPath: string | null = resolveOpenCodeBinaryPath(),
): OpenCodeArtifactDigest | null {
  if (!binaryPath) return null
  const opened = openCanonicalOpenCodeArtifact(binaryPath)
  if (!opened) return null
  try { return opened.digest } finally { closeSync(opened.fd) }
}

/**
 * Pins the installed executable inode and bytes for a synchronous pre-effect
 * consume. A symlink or target replacement after preparation fails closed.
 */
export function prepareOpenCodeArtifactDigestToken(
  expectedDigest: string,
  binaryPath: string | null = resolveOpenCodeBinaryPath(),
): { consume(): boolean } | null {
  if (!OPEN_CODE_ARTIFACT_DIGEST.test(expectedDigest) || !binaryPath) return null
  const opened = openCanonicalOpenCodeArtifact(binaryPath)
  if (!opened || opened.digest !== expectedDigest) {
    if (opened) closeSync(opened.fd)
    return null
  }
  let consumed = false
  return {
    consume: () => {
      if (consumed) return false
      consumed = true
      try {
        const current = fstatSync(opened.fd)
        const linked = lstatSync(opened.canonicalPath)
        return current.isFile() && linked.isFile() && !linked.isSymbolicLink() &&
          current.dev === opened.dev && current.ino === opened.ino && current.size === opened.size &&
          linked.dev === opened.dev && linked.ino === opened.ino &&
          realpathSync(binaryPath) === opened.canonicalPath &&
          digestOpenCodeArtifactFd(opened.fd, current.size) === expectedDigest
      } catch {
        return false
      } finally {
        closeSync(opened.fd)
      }
    },
  }
}
