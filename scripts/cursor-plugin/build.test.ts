import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { buildCursorPluginArtifact, CURSOR_PLUGIN_SOURCE_SHA256 } from './build.js'

test('builds an importable artifact reproducibly without changing the pinned source', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cursor-artifact-test-'))
  const sourcePath = path.join(import.meta.dir, 'node_modules/@rama_nigg/open-cursor/src/plugin.ts')
  const original = await readFile(sourcePath, 'utf8')
  try {
    const first = await buildCursorPluginArtifact(path.join(temp, 'first'))
    const second = await buildCursorPluginArtifact(path.join(temp, 'second'))
    expect(await readFile(first, 'utf8')).toBe(await readFile(second, 'utf8'))
    const manifest = JSON.parse(await readFile(path.join(temp, 'first/manifest.json'), 'utf8'))
    expect(manifest.sourceSha256).toBe(CURSOR_PLUGIN_SOURCE_SHA256)
    expect(manifest.artifactSha256).toBe(createHash('sha256').update(await readFile(first)).digest('hex'))
    expect(await readdir(path.join(temp, 'first'))).not.toContain('node_modules')
    expect(typeof (await import(pathToFileURL(first).href)).default).toBe('function')
    expect(await readFile(sourcePath, 'utf8')).toBe(original)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}, 30_000)
