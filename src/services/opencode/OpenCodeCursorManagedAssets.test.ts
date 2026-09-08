import { expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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

test.skipIf(process.platform !== 'darwin')('accepts only staging that still matches its manifest', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-assets-'))
  try {
    await stageCursorManagedAssets(root)
    const first = await resolve(root)
    expect(first.available).toBe(true)
    if (!first.available) return
    expect(first.assets.pluginEntryPath).toBe(path.join(await realpath(root), 'plugin/dist/plugin-entry.js'))
    expect(first.assets.mcpToolPath).toBe(path.join(await realpath(root), 'plugin/dist/cli/mcptool.js'))
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

    // A tampered artifact, and a tampered CLI, must both fail closed.
    for (const relative of ['plugin/dist/plugin-entry.js', 'plugin/dist/cli/mcptool.js']) {
      const target = path.join(root, relative)
      const original = await readFile(target)
      await writeFile(target, Buffer.concat([original, Buffer.from('\n// tampered\n')]))
      expect(await resolve(root)).toEqual({ available: false, reason: 'plugin_artifact_mismatch' })
      await writeFile(target, original)
    }
    expect((await resolve(root)).available).toBe(true)

    // Without an interpreter the profile shim cannot run the CLI at all.
    expect(await resolveOpenCodeCursorManagedAssets({
      env: { [CURSOR_MANAGED_ASSET_ROOT_ENV]: root, PATH: '', AGENT_TEAMS_CURSOR_SUPERVISOR_NODE: path.join(root, 'missing-interpreter') },
    })).toEqual({ available: false, reason: 'no_interpreter' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60000)

// Synthetic bytes are never imported or executed, including hostile fixtures.
test('confines both assets and protects every descendant; allows a protected top-level link', async () => {
  const { createHash } = await import('node:crypto')
  const { mkdir, chmod, symlink } = await import('node:fs/promises')
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-asset-security-'))
  const hash = createHash('sha256').update('synthetic').digest('hex')
  const manifest = { schema: 1, backend: 'cursor-agent', entrypoint: 'dist/plugin.js',
    mcpToolEntrypoint: 'dist/cli.js', artifactSha256: hash, mcpToolSha256: hash }
  const check = (target = root) => resolve(target, { platform: 'darwin', arch: 'arm64' })
  const publish = (value: unknown) => writeFile(path.join(root, 'plugin/manifest.json'), JSON.stringify(value))
  try {
    await mkdir(path.join(root, 'plugin/dist'), { recursive: true, mode: 0o700 })
    for (const name of ['plugin.js', 'cli.js']) await writeFile(path.join(root, 'plugin/dist', name), 'synthetic')
    await publish(manifest)
    expect((await check()).available).toBe(true)
    for (const field of ['entrypoint', 'mcpToolEntrypoint']) {
      for (const invalid of ['../../outside.js', '/tmp/outside.js', 'dist/../dist/cli.js']) {
        await publish({ ...manifest, [field]: invalid })
        expect(await check()).toEqual({ available: false, reason: 'plugin_artifact_mismatch' })
      }
    }
    await publish(manifest)
    for (const target of ['plugin', 'plugin/dist', 'plugin/dist/plugin.js', 'plugin/dist/cli.js', 'plugin/manifest.json']) {
      await chmod(path.join(root, target), 0o777)
      expect(await check()).toEqual({ available: false, reason: 'plugin_artifact_mismatch' })
      await chmod(path.join(root, target), 0o700)
    }
    await symlink(root, `${root}-link`)
    expect((await check(`${root}-link`)).available).toBe(true)
    await symlink(path.join(root, 'plugin/dist'), path.join(root, 'plugin/link'))
    await publish({ ...manifest, mcpToolEntrypoint: 'link/cli.js' })
    expect(await check()).toEqual({ available: false, reason: 'plugin_artifact_mismatch' })
    await publish(manifest)
    await rm(path.join(root, 'plugin/dist/cli.js'))
    await symlink(path.join(root, 'plugin/dist/plugin.js'), path.join(root, 'plugin/dist/cli.js'))
    expect(await check()).toEqual({ available: false, reason: 'plugin_artifact_mismatch' })
  } finally {
    await rm(`${root}-link`, { force: true })
    await rm(root, { recursive: true, force: true })
  }
})
