import { openCodeV2CurrentPlatform, openCodeV2LaunchRefusal } from '../compatibility/OpenCodeV2Registry.js'
import { qualifyLinuxSystemLauncher } from './OpenCodeV2ExecutionLauncher.js'

/** What refuses a V2 execution here before any child starts: the version's platform
 * qualification and, on Linux, the bwrap launcher. Throws the coded refusal. A catalog read
 * needs neither, so status checks this before it reports a catalog a launch cannot use. */
export async function assertOpenCodeV2ExecutionReady(version: unknown, platform = openCodeV2CurrentPlatform(),
  qualifyLauncher: () => Promise<unknown> = qualifyLinuxSystemLauncher): Promise<void> {
  const refusal = openCodeV2LaunchRefusal(version, platform)
  if (refusal) throw new Error(refusal)
  if (platform.startsWith('linux-')) await qualifyLauncher()
}
