import { createHash } from 'node:crypto'
import { constants, lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { writeFileAtomic } from '../../utils/atomicWrite.js'
import type {
  LaunchedCapabilityRun,
  LaunchedCapabilityStore,
} from '../teamLifecycleOwner/OpenCodeTeamLifecycleLane.js'
import { fsyncFileAndParent } from './HostedTaskMutationWal.js'

export const HOSTED_OPENCODE_LAUNCH_CAPABILITY_DIRECTORY = 'hosted-opencode-launch-capabilities'

const MAX_RECORD_BYTES = 4096

type LaunchCapabilityRecord = LaunchedCapabilityRun & {
  schemaVersion: 1
  capabilitySnapshotId: string
}

/**
 * One private file per OpenCode lane under the admitted team root, so a run an
 * Owner adopts after a crash keeps delivering to and reconciling on its
 * retained host. The value is not a secret: the bridge still binds it to the
 * live host, so a wrong record can only fail closed.
 */
export class HostedOpenCodeLaunchCapabilityStore implements LaunchedCapabilityStore {
  readonly #directory: string
  readonly #teamId: string

  constructor(canonicalTeamRoot: string) {
    this.#directory = join(canonicalTeamRoot, HOSTED_OPENCODE_LAUNCH_CAPABILITY_DIRECTORY)
    this.#teamId = basename(canonicalTeamRoot)
  }

  async read(run: LaunchedCapabilityRun): Promise<string | null> {
    if (run.teamId !== this.#teamId) return null
    const record = await this.#readRecord(run.laneId)
    return record && record.laneId === run.laneId && record.runId === run.runId
      ? record.capabilitySnapshotId
      : null
  }

  async write(run: LaunchedCapabilityRun & { capabilitySnapshotId: string }): Promise<void> {
    if (run.teamId !== this.#teamId || !/^opencode:[a-f0-9]{32}$/.test(run.capabilitySnapshotId)) {
      throw new TypeError('Hosted OpenCode launch capability does not belong to this team')
    }
    const record: LaunchCapabilityRecord = { schemaVersion: 1, teamId: run.teamId, laneId: run.laneId,
      runId: run.runId, capabilitySnapshotId: run.capabilitySnapshotId }
    const path = this.#path(run.laneId)
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    await writeFileAtomic(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
    await fsyncFileAndParent(path)
  }

  /** Removes only this run's record; a later run's record stays. */
  async remove(run: LaunchedCapabilityRun): Promise<void> {
    const record = await this.#readRecord(run.laneId)
    if (record && record.teamId === run.teamId && record.runId === run.runId) {
      await rm(this.#path(run.laneId), { force: true })
    }
  }

  #path(laneId: string): string {
    return join(this.#directory, `${createHash('sha256').update(laneId).digest('hex').slice(0, 32)}.json`)
  }

  async #readRecord(laneId: string): Promise<LaunchCapabilityRecord | null> {
    const path = this.#path(laneId)
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!handle) return null
    let value: unknown
    try {
      const [stat, linked] = await Promise.all([handle.stat(), lstat(path)])
      if (!stat.isFile() || !linked.isFile() || stat.dev !== linked.dev || stat.ino !== linked.ino ||
        stat.size > MAX_RECORD_BYTES || (stat.mode & 0o077) !== 0 ||
        (process.getuid?.() !== undefined && stat.uid !== process.getuid()) ||
        await realpath(path) !== path) throw new Error('Unsafe hosted OpenCode launch capability file')
      value = JSON.parse(await handle.readFile('utf8'))
    } finally { await handle.close() }
    const record = value as Partial<LaunchCapabilityRecord> | null
    return record?.schemaVersion === 1 && record.teamId === this.#teamId &&
      typeof record.laneId === 'string' && typeof record.runId === 'string' &&
      typeof record.capabilitySnapshotId === 'string' &&
      /^opencode:[a-f0-9]{32}$/.test(record.capabilitySnapshotId)
      ? record as LaunchCapabilityRecord
      : null
  }
}
