import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildCursorNativeAssets } from './build-native.js'

test.skipIf(process.platform !== 'darwin')('stages self-contained, fingerprinted native ownership assets', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cursor-native-build-test-'))
  try {
    await buildCursorNativeAssets(temp)
    const manifest = JSON.parse(await readFile(path.join(temp, 'manifest.json'), 'utf8'))
    expect(manifest.platform).toBe(process.platform)
    expect(manifest.arch).toBe(process.arch)
    expect(Object.keys(manifest.files).sort()).toEqual(['gate', 'group-cleanup.mjs', 'preload.cjs', 'scope-sweep.mjs', 'supervisor.mjs'])
    for (const [name, hash] of Object.entries(manifest.files)) {
      const bytes = await readFile(path.join(temp, name))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(hash)
    }
    expect((await stat(path.join(temp, 'gate'))).mode & 0o777).toBe(0o700)
    const gate = Bun.spawnSync([path.join(temp, 'gate')], { env: {}, stdout: 'pipe', stderr: 'pipe' })
    expect(gate.exitCode).toBe(125)
    expect(await readFile(path.join(temp, 'supervisor.mjs'), 'utf8')).not.toContain("from '/tmp/")
    // A missing sibling module would only fail once a user machine ran teardown.
    const staged = Bun.spawnSync(['node', '--input-type=module', '-e',
      `await import(${JSON.stringify('file://' + path.join(temp, 'scope-sweep.mjs'))})`], { stdout: 'pipe', stderr: 'pipe' })
    expect(staged.exitCode).toBe(0)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}, 30_000)
