import { expect, test } from 'bun:test'
import { chmod, mkdtemp, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  OPEN_CODE_ARTIFACT_MAX_BYTES,
  prepareOpenCodeArtifactDigestToken,
  resolveOpenCodeArtifactDigest,
  resolveExecutingOpenCodeArtifactDigest,
} from './OpenCodeArtifactDigest.js'

test('pins stable OpenCode artifact bytes and rejects mismatch or inode rotation', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-artifact-digest-'))
  const binaryPath = path.join(tempDir, 'opencode')
  try {
    await writeFile(binaryPath, 'accepted-opencode-artifact', { mode: 0o755 })
    const digest = resolveOpenCodeArtifactDigest(binaryPath)
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(resolveOpenCodeArtifactDigest(binaryPath)).toBe(digest)
    expect(prepareOpenCodeArtifactDigestToken(`sha256:${'0'.repeat(64)}`, binaryPath)).toBeNull()

    const stable = prepareOpenCodeArtifactDigestToken(digest!, binaryPath)
    expect(stable?.consume()).toBe(true)
    expect(stable?.consume()).toBe(false)

    const rotated = prepareOpenCodeArtifactDigestToken(digest!, binaryPath)
    const replacement = `${binaryPath}.replacement`
    await writeFile(replacement, 'accepted-opencode-artifact', { mode: 0o755 })
    await rename(replacement, binaryPath)
    expect(rotated?.consume()).toBe(false)

    await writeFile(binaryPath, 'substituted-opencode-artifact')
    expect(prepareOpenCodeArtifactDigestToken(digest!, binaryPath)).toBeNull()
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

test('publishes no authority for non-Linux, symlink, writable, or oversized launchers', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-artifact-policy-'))
  const binaryPath = path.join(tempDir, 'opencode')
  try {
    await writeFile(binaryPath, 'direct-executable', { mode: 0o755 })
    expect(resolveOpenCodeArtifactDigest(binaryPath, { platform: 'darwin' })).toBeNull()
    expect(resolveOpenCodeArtifactDigest(binaryPath, { platform: 'win32' })).toBeNull()
    const indirect = path.join(tempDir, 'opencode-link')
    await symlink(binaryPath, indirect)
    expect(resolveOpenCodeArtifactDigest(indirect)).toBeNull()
    await chmod(binaryPath, 0o775)
    expect(resolveOpenCodeArtifactDigest(binaryPath)).toBeNull()
    await chmod(binaryPath, 0o755)
    expect(resolveOpenCodeArtifactDigest(binaryPath, { maxBytes: 16 })).toBeNull()
    expect(OPEN_CODE_ARTIFACT_MAX_BYTES).toBe(256 * 1024 * 1024)
  } finally { await rm(tempDir, { recursive: true, force: true }) }
})

test('accepts the reviewed size boundary and rejects mutation after preparation', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-artifact-boundary-'))
  const binaryPath = path.join(tempDir, 'opencode')
  try {
    await writeFile(binaryPath, '1234567890abcdef', { mode: 0o755 })
    await truncate(binaryPath, 16)
    const digest = resolveOpenCodeArtifactDigest(binaryPath, { maxBytes: 16 })
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    const token = prepareOpenCodeArtifactDigestToken(digest!, binaryPath, { maxBytes: 16 })
    await writeFile(binaryPath, 'fedcba0987654321', { mode: 0o755 })
    expect(token?.consume()).toBe(false)
  } finally { await rm(tempDir, { recursive: true, force: true }) }
})

test('opens the Linux executed image directly from procfs', () => {
  expect(resolveExecutingOpenCodeArtifactDigest(process.pid)).toMatch(/^sha256:[0-9a-f]{64}$/)
  expect(resolveExecutingOpenCodeArtifactDigest(process.pid, { platform: 'darwin' })).toBeNull()
})
