import { expect, test } from 'bun:test'
import { assertOpenCodeV2ExecutionReady } from './OpenCodeV2ExecutionReadiness.js'
import { openCodeV2QualifiedVersions, openCodeV2LaunchRefusal } from '../compatibility/OpenCodeV2Registry.js'

test('status refuses what every execution here would refuse, before the catalog read', async () => {
  // A version out of range or not qualified on this platform is refused on every platform.
  await expect(assertOpenCodeV2ExecutionReady('9.9.9', 'darwin-arm64')).rejects.toThrow('opencode_v2_version_out_of_range')
  const unqualifiedOnArm = openCodeV2QualifiedVersions().find(version => openCodeV2LaunchRefusal(version, 'linux-arm64') !== null)
  if (unqualifiedOnArm) await expect(assertOpenCodeV2ExecutionReady(unqualifiedOnArm, 'linux-arm64')).rejects.toThrow('opencode_v2_version_unqualified')
  // A qualified version needs nothing else: V2 runs as an ordinary process.
  for (const platform of ['linux-x64', 'darwin-arm64'] as const) {
    const version = openCodeV2QualifiedVersions().find(candidate => openCodeV2LaunchRefusal(candidate, platform) === null)!
    await expect(assertOpenCodeV2ExecutionReady(version, platform)).resolves.toBeUndefined()
  }
})
