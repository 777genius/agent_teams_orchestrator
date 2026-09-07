import { expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { stageCursorManagedAssets } from '../../../scripts/cursor-plugin/stage.js'
import {
  CURSOR_MANAGED_ASSET_ROOT_ENV,
  resolveOpenCodeCursorManagedAssets,
} from './OpenCodeCursorManagedAssets.js'

const resolve = (root: string, overrides: Record<string, unknown> = {}) =>
  resolveOpenCodeCursorManagedAssets({
    env: { [CURSOR_MANAGED_ASSET_ROOT_ENV]: root, PATH: process.env.PATH }, ...overrides,
  })

test('refuses platforms the ownership barrier was never proven on', async () => {
  for (const [platform, arch] of [['win32', 'x64'], ['linux', 'x64'], ['darwin', 'ia32']] as const) {
    expect(await resolve('/nonexistent', { platform, arch }))
      .toEqual({ available: false, reason: 'unsupported_platform' })
  }
})

test('reports missing staging instead of degrading to an unmanaged Cursor launch', async () => {
  expect(await resolveOpenCodeCursorManagedAssets({ env: {}, platform: 'darwin', arch: 'arm64' }))
    .toEqual({ available: false, reason: 'not_staged' })
  const empty = await mkdtemp(path.join(os.tmpdir(), 'cursor-assets-empty-'))
  try {
    expect(await resolve(empty, { platform: 'darwin', arch: 'arm64' }))
      .toEqual({ available: false, reason: 'not_staged' })
  } finally {
    await rm(empty, { recursive: true, force: true })
  }
})

test.skipIf(process.platform !== 'darwin')('accepts only staging that still matches its manifests', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-assets-'))
  try {
    await stageCursorManagedAssets(root)
    const first = await resolve(root)
    expect(first.available).toBe(true)
    if (!first.available) return
    expect(first.assets.pluginEntryPath).toBe(path.join(root, 'plugin/dist/plugin-entry.js'))
    expect(first.assets.supervisorPath).toBe(path.join(root, 'native/supervisor.mjs'))
    expect(path.isAbsolute(first.assets.interpreterPath)).toBe(true)
    expect(first.assets.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    // Identical staging of the same sources must produce the same readiness identity.
    const again = await mkdtemp(path.join(os.tmpdir(), 'cursor-assets-again-'))
    try {
      await stageCursorManagedAssets(again)
      const repeat = await resolve(again)
      expect(repeat.available && repeat.assets.fingerprint).toBe(first.assets.fingerprint)
    } finally {
      await rm(again, { recursive: true, force: true })
    }
    expect(await resolve(root, { arch: 'x64' })).toEqual({ available: false, reason: 'native_asset_mismatch' })

    const supervisorPath = path.join(root, 'native/supervisor.mjs')
    const supervisor = await readFile(supervisorPath)
    await writeFile(supervisorPath, Buffer.concat([supervisor, Buffer.from('\n// tampered\n')]))
    expect(await resolve(root)).toEqual({ available: false, reason: 'native_asset_mismatch' })
    await writeFile(supervisorPath, supervisor)
    expect((await resolve(root)).available).toBe(true)

    const entrypoint = path.join(root, 'plugin/dist/plugin-entry.js')
    const artifact = await readFile(entrypoint)
    await writeFile(entrypoint, Buffer.concat([artifact, Buffer.from('\n// tampered\n')]))
    expect(await resolve(root)).toEqual({ available: false, reason: 'plugin_artifact_mismatch' })
    await writeFile(entrypoint, artifact)

    await chmod(path.join(root, 'native/gate'), 0o600)
    expect(await resolve(root)).toEqual({ available: false, reason: 'native_asset_mismatch' })
    await chmod(path.join(root, 'native/gate'), 0o700)
    // Without a real interpreter the bridge cannot run the supervisor at all.
    expect(await resolveOpenCodeCursorManagedAssets({
      env: { [CURSOR_MANAGED_ASSET_ROOT_ENV]: root, PATH: '' },
    })).toEqual({ available: false, reason: 'no_interpreter' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60000)
