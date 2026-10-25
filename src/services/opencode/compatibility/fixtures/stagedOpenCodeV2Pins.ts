import manifest from '../../../../../package.json' with { type: 'json' }
import { openCodeV2GraphPackages, openCodeV2StagedVersions, type OpenCodeV2Pin } from '../OpenCodeV2Registry.js'
import type { CurrentClient, FloorClient } from '../OpenCodeV2WireTypes.js'

/** TEST fixture: every graph the install manifest stages, so tests cover each version. */
export const stagedOpenCodeV2Pins: readonly OpenCodeV2Pin[] = openCodeV2StagedVersions(manifest.dependencies)

/** TEST fixture: the selected version's own installed client module. */
export async function stagedOpenCodeV2Client(pin: OpenCodeV2Pin): Promise<typeof FloorClient & typeof CurrentClient> {
  return import(openCodeV2GraphPackages(pin).client)
}
