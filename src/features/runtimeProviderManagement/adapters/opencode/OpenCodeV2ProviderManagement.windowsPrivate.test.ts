import { test, expect, spyOn } from 'bun:test'
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import * as privateDirectories from '../../../../services/opencode/profile/OpenCodePrivateDirectories.js'
import * as nativeIdentity from '../../../../services/opencode/compatibility/OpenCodeNativeIdentity.js'
import * as profileManager from '../../../../services/opencode/OpenCodeProfileManager.js'
import { loadOpenCodeV2ProviderModels } from './OpenCodeV2ProviderManagement.js'

// Regression: the V2 provider catalog created <data>/opencode/v2/provider-profiles with a
// default mkdir. On an elevated or UAC-less Windows admin that leaves the Administrators
// group as owner of the shared opencode and v2 directories, and the execution-probe store
// later refuses them (execution_owner_not_private:private_acl_owner).
test('Windows V2 provider catalog creates its namespace and profile only through private directories', async () => {
  const data = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-provider-private-')))
  const previous = process.env.CLAUDE_MULTIMODEL_DATA_HOME
  const originalPlatform = process.platform
  const calls: { directories: string[]; exclusive: string[] }[] = []
  const stop = new Error('TEST-stop-after-private-profile')
  const spies = [
    spyOn(privateDirectories, 'ensureWindowsPrivateDirectories').mockImplementation(async (directories, exclusive = []) => {
      calls.push({ directories: [...directories], exclusive: [...exclusive] })
      // Stand in for the native private creation of the namespace; stop before the profile.
      if (calls.length === 1) await mkdir(directories.at(-1)!, { recursive: true })
      if (calls.length === 2) throw stop
    }),
    spyOn(nativeIdentity, 'inspectOpenCodeReadSelection').mockImplementation(async () =>
      ({ native: { version: '2.1.4' }, policy: { generation: 'v2' } }) as never),
    spyOn(profileManager, 'canonicalizeOpenCodeProjectPath').mockImplementation(async () => data),
    spyOn(profileManager, 'resolveOpenCodeV2CatalogProfileScope').mockImplementation(async () => ({}) as never),
  ]
  try {
    process.env.CLAUDE_MULTIMODEL_DATA_HOME = data
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const result = await loadOpenCodeV2ProviderModels({ runtimeId: 'opencode', providerId: 'openrouter', projectPath: data } as never)
    expect(result.ok).toBe(false)
    const parent = path.join(data, 'opencode/v2/provider-profiles')
    expect(calls[0]).toEqual({ directories: [data, path.join(data, 'opencode'), path.join(data, 'opencode', 'v2'), parent], exclusive: [] })
    const root = calls[1]!.exclusive[0]!
    expect(calls[1]!.exclusive).toEqual([root])
    expect(path.dirname(root)).toBe(parent)
    expect(path.basename(root)).toMatch(/^catalog-[0-9a-f-]{36}$/)
    expect(calls[1]!.directories).toEqual([root,
      ...['home', 'config', 'data', 'cache', 'state', 'tmp', 'appdata', 'localappdata'].map(name => path.join(root, name)),
      path.join(root, 'config', 'opencode'), path.join(root, 'data', 'opencode')])
    // The profile never reached the disk through a default mkdir.
    expect(await readdir(parent)).toEqual([])
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    for (const spy of spies) spy.mockRestore()
    if (previous === undefined) delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
    else process.env.CLAUDE_MULTIMODEL_DATA_HOME = previous
    await rm(data, { recursive: true, force: true })
  }
})
