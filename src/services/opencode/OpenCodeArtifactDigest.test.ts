import { expect, test } from 'bun:test'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  prepareOpenCodeArtifactDigestToken,
  resolveOpenCodeArtifactDigest,
} from './OpenCodeArtifactDigest.js'

test('pins stable OpenCode artifact bytes and rejects mismatch or inode rotation', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-artifact-digest-'))
  const binaryPath = path.join(tempDir, 'opencode')
  try {
    await writeFile(binaryPath, 'accepted-opencode-artifact')
    const digest = resolveOpenCodeArtifactDigest(binaryPath)
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(resolveOpenCodeArtifactDigest(binaryPath)).toBe(digest)
    expect(prepareOpenCodeArtifactDigestToken(`sha256:${'0'.repeat(64)}`, binaryPath)).toBeNull()

    const stable = prepareOpenCodeArtifactDigestToken(digest!, binaryPath)
    expect(stable?.consume()).toBe(true)
    expect(stable?.consume()).toBe(false)

    const rotated = prepareOpenCodeArtifactDigestToken(digest!, binaryPath)
    const replacement = `${binaryPath}.replacement`
    await writeFile(replacement, 'accepted-opencode-artifact')
    await rename(replacement, binaryPath)
    expect(rotated?.consume()).toBe(false)

    await writeFile(binaryPath, 'substituted-opencode-artifact')
    expect(prepareOpenCodeArtifactDigestToken(digest!, binaryPath)).toBeNull()
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})
