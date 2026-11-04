import { openCodeV2CurrentPlatform, openCodeV2LaunchRefusal } from '../compatibility/OpenCodeV2Registry.js'

/** What refuses a V2 execution here before any child starts: the version's platform
 * qualification. Throws the coded refusal. A catalog read does not need it, so status
 * checks this before it reports a catalog a launch cannot use. */
export async function assertOpenCodeV2ExecutionReady(version: unknown, platform = openCodeV2CurrentPlatform()): Promise<void> {
  const refusal = openCodeV2LaunchRefusal(version, platform)
  if (refusal) throw new Error(refusal)
}
