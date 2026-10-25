import { expect, test } from 'bun:test'
import { assertOpenCodeV2ExecutionReady } from './OpenCodeV2ExecutionReadiness.js'
import { openCodeV2QualifiedVersions, openCodeV2LaunchRefusal } from '../compatibility/OpenCodeV2Registry.js'

test('status refuses what every execution here would refuse, before the catalog read', async () => {
  let launcherChecks = 0
  const refusingLauncher = async () => { launcherChecks++; throw new Error('execution_containment_launcher_unsupported') }
  // A version out of range or not qualified on this platform is refused on every platform.
  await expect(assertOpenCodeV2ExecutionReady('9.9.9', 'darwin-arm64', refusingLauncher)).rejects.toThrow('opencode_v2_version_out_of_range')
  const linuxVersion = openCodeV2QualifiedVersions().find(version => openCodeV2LaunchRefusal(version, 'linux-x64') === null)!
  const unqualifiedOnArm = openCodeV2QualifiedVersions().find(version => openCodeV2LaunchRefusal(version, 'linux-arm64') !== null)
  if (unqualifiedOnArm) await expect(assertOpenCodeV2ExecutionReady(unqualifiedOnArm, 'linux-arm64', refusingLauncher)).rejects.toThrow('opencode_v2_version_unqualified')
  expect(launcherChecks).toBe(0)
  // On Linux a qualified version still needs the sandbox launcher; elsewhere it is not consulted.
  await expect(assertOpenCodeV2ExecutionReady(linuxVersion, 'linux-x64', refusingLauncher)).rejects.toThrow('execution_containment_launcher_unsupported')
  expect(launcherChecks).toBe(1)
  const darwinVersion = openCodeV2QualifiedVersions().find(version => openCodeV2LaunchRefusal(version, 'darwin-arm64') === null)!
  await expect(assertOpenCodeV2ExecutionReady(darwinVersion, 'darwin-arm64', refusingLauncher)).resolves.toBeUndefined()
  await expect(assertOpenCodeV2ExecutionReady(linuxVersion, 'linux-x64', async () => undefined)).resolves.toBeUndefined()
  expect(launcherChecks).toBe(1)
})
