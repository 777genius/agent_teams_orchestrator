import { createHash } from 'node:crypto'
import { constants, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProductOwnerEffectFence } from './HostedProductOwnerBoundEnvelope.js'

const TEAM_IDENTITY_FILE = 'team.identity.json'
const MAX_TEAM_IDENTITY_BYTES = 4 * 1024

/**
 * Product's fence names the exact published team identity file. A team that was tombstoned and
 * re-published under the same directory, or a request for another team, no longer matches it.
 */
export function createHostedTeamIdentityFenceVerifier(input: {
  claudeRoot: string
  legacyKey: string
  teamId: string
}): (fence: ProductOwnerEffectFence) => Promise<boolean> {
  const path = join(input.claudeRoot, 'teams', input.legacyKey, TEAM_IDENTITY_FILE)
  return async fence => {
    try {
      const bytes = await readBoundedFile(path)
      if (createHash('sha256').update(bytes).digest('hex') !== fence.identityChecksum) return false
      const value = JSON.parse(bytes.toString('utf8')) as { schemaVersion?: unknown; teamId?: unknown }
      return value.schemaVersion === 1 && value.teamId === input.teamId
    } catch {
      return false
    }
  }
}

async function readBoundedFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MAX_TEAM_IDENTITY_BYTES) throw new Error('Unsafe hosted team identity file')
    const bytes = await handle.readFile()
    if (bytes.byteLength !== stat.size) throw new Error('Hosted team identity file changed while read')
    return bytes
  } finally {
    await handle.close()
  }
}
