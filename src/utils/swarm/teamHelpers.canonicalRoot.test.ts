import { describe, expect, test } from 'bun:test'
import {
  readTeamFileAtCanonicalRoot,
  withTeamFileLockAtCanonicalRoot,
  writeTeamFileAtCanonicalRoot,
  type TeamFile,
} from './teamHelpers.js'

const team = (name: string): TeamFile => ({
  name,
  createdAt: 1,
  leadAgentId: `team-lead@${name}`,
  members: [],
})

describe('canonical-root helper authority dispatch', () => {
  test('raw canonical paths cannot mint read, lock, or standalone-write authority', async () => {
    const root = '/tmp/unregistered-canonical-team-root'
    await expect(readTeamFileAtCanonicalRoot(root, 'atlas'))
      .rejects.toThrow('No current host-issued canonical lock authority')
    await expect(withTeamFileLockAtCanonicalRoot(root, 'atlas', async () => undefined))
      .rejects.toThrow('No current host-issued canonical lock authority')
    await expect(writeTeamFileAtCanonicalRoot(root, 'atlas', team('atlas')))
      .rejects.toThrow('No current host-issued canonical lock authority')
  })

  test('canonical helper source has no legacy generation fallback or cleanup claim', async () => {
    const source = await Bun.file(new URL('./teamHelpers.ts', import.meta.url)).text()
    // Include the resolver wrapper used by every canonical entrypoint. Slicing
    // at the exported lock helper omitted that wrapper and made this source
    // assertion claim the resolver was absent even though it was immediately
    // above the slice.
    const canonicalStart = source.indexOf('function canonicalAuthority')
    const desktopStart = source.indexOf('const TEAM_FILE_LOCK_STALE_MS')
    const canonical = source.slice(canonicalStart, desktopStart)
    expect(canonical).toContain('resolveCanonicalTeamLockAuthority')
    expect(canonical).toContain('withCanonicalTeamLock')
    expect(canonical).not.toContain('cleanupOwnedFile')
    expect(canonical).not.toContain('withTeamFileLockInRoot')
    expect(canonical).not.toContain('.config.lock.acquire-')
  })
})
