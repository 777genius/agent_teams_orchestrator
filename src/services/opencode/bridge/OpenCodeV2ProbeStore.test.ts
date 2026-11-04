import { expect, test } from 'bun:test'
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertLegacyOpenCodeV2ProbePreEffect, ensureOpenCodeV2ProbeStore } from './OpenCodeV2ProbeStore.js'

test.skipIf(process.platform === 'win32')('legacy owned 0755 shared ancestors retain permissions while V2 store remains 0700', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-probe-store-')))
  try {
    await chmod(root, 0o755); await mkdir(path.join(root, 'opencode'), { mode: 0o755 })
    const store = await ensureOpenCodeV2ProbeStore(root)
    expect((await lstat(root)).mode & 0o777).toBe(0o755)
    expect((await lstat(path.join(root, 'opencode'))).mode & 0o777).toBe(0o755)
    expect((await lstat(path.join(root, 'opencode/v2'))).mode & 0o777).toBe(0o700)
    expect((await lstat(store.probeRoot)).mode & 0o777).toBe(0o700)
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const unsafe of ['shared-root', 'shared-opencode', 'private-v2', 'symlink'] as const) {
  test.skipIf(process.platform === 'win32')(`probe store rejects ${unsafe} instead of chmod or adoption`, async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-probe-store-')))
    try {
      await mkdir(path.join(root, 'opencode'), { mode: 0o700 })
      if (unsafe === 'shared-root') await chmod(root, 0o777)
      if (unsafe === 'shared-opencode') await chmod(path.join(root, 'opencode'), 0o777)
      if (unsafe === 'private-v2') await mkdir(path.join(root, 'opencode/v2'), { mode: 0o755 })
      if (unsafe === 'symlink') {
        await mkdir(path.join(root, 'other'), { mode: 0o700 })
        await symlink(path.join(root, 'other'), path.join(root, 'opencode/v2'))
      }
      await expect(ensureOpenCodeV2ProbeStore(root)).rejects.toThrow('probe_store_foreign')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}

for (const scenario of ['original', 'chmod-after', 'changed-marker', 'symlink-marker'] as const) {
  test.skipIf(process.platform !== 'darwin')(`legacy historical pre-effect proof: ${scenario}`, async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-legacy-proof-')))
    try {
      await chmod(root, 0o755)
      const privateRoot = path.join(root, 'opencode/v2/provider-connections')
      await mkdir(privateRoot, { recursive: true, mode: 0o700 })
      const marker = path.join(privateRoot, 'intent.json'), saved = { state: 'pending', providerId: 'test' }
      await writeFile(marker, JSON.stringify(saved), { mode: 0o600 })
      if (scenario === 'chmod-after') { await chmod(root, 0o700); await chmod(root, 0o755) }
      if (scenario === 'changed-marker') await writeFile(marker, JSON.stringify({ ...saved, providerId: 'other' }))
      if (scenario === 'symlink-marker') { await rm(marker); await symlink(path.join(privateRoot, 'absent'), marker) }
      if (scenario === 'original') await assertLegacyOpenCodeV2ProbePreEffect(root, marker, saved)
      else await expect(assertLegacyOpenCodeV2ProbePreEffect(root, marker, saved)).rejects.toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}
