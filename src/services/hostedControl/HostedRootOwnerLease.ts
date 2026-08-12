import { constants, lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import * as lockfile from '../../utils/lockfile.js'

export class HostedRootOwnerLease {
  readonly #anchor: string
  #release: (() => Promise<void>) | null = null

  constructor(private readonly canonicalTeamRoot: string) {
    this.#anchor = join(canonicalTeamRoot, '.hosted-control-owner-anchor')
  }

  async acquire(): Promise<void> {
    if (this.#release) throw new Error('Hosted root owner lease is already held')
    const handle = await open(this.#anchor, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600)
    try {
      const [stat, current] = await Promise.all([handle.stat(), lstat(this.#anchor)])
      if (!stat.isFile() || !current.isFile() || current.isSymbolicLink() || stat.dev !== current.dev || stat.ino !== current.ino ||
        (stat.mode & 0o077) !== 0 || (process.getuid?.() !== undefined && stat.uid !== process.getuid?.())) {
        throw new Error('Unsafe hosted root owner lease anchor')
      }
      await handle.sync()
    } finally { await handle.close() }
    try {
      this.#release = await lockfile.lock(this.#anchor, {
        realpath: false, retries: 0, stale: 60_000,
        lockfilePath: join(this.canonicalTeamRoot, '.hosted-control-owner.lease'),
      })
    } catch { throw new Error('Hosted root already has an active owner') }
  }

  async release(): Promise<void> {
    const release = this.#release
    this.#release = null
    await release?.()
  }
}
