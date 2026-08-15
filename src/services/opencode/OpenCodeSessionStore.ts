import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import * as lockfile from '../../utils/lockfile.js'
import { writeJsonFileAtomic } from '../../utils/atomicWrite.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  hostedApprovalRuntimeBindingFences,
  type HostedApprovalRuntimeBindingMutationFence,
} from '../hostedControl/HostedApprovalRuntimeBindingFence.js'
import { resolveClaudeMultimodelPaths } from './OpenCodeManagedPaths.js'

import type { OpenCodeSessionRecord } from './types.js'

type SessionStoreShape = {
  schemaVersion: 1
  records: Record<string, OpenCodeSessionRecord>
}

type UpsertResult = 'created' | 'updated' | 'unchanged'
const MAX_EFFECT_STORE_BYTES = 16 * 1024 * 1024

const LOCK_OPTIONS = {
  retries: {
    retries: 30,
    minTimeout: 5,
    maxTimeout: 100,
  },
}

function buildRecordKey(record: Pick<OpenCodeSessionRecord, 'teamId' | 'laneId' | 'memberName'>): string {
  return `${record.teamId}::${record.laneId ?? 'primary'}::${record.memberName}`
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

export class OpenCodeSessionStore {
  private readonly filePath: string
  private readonly lockPath: string

  private readonly bindingMutationFence: HostedApprovalRuntimeBindingMutationFence

  constructor(
    filePath?: string,
    bindingMutationFence: HostedApprovalRuntimeBindingMutationFence = hostedApprovalRuntimeBindingFences,
  ) {
    const paths = resolveClaudeMultimodelPaths()
    this.filePath = filePath ?? path.join(paths.data, 'opencode', 'session-store.json')
    this.lockPath = `${this.filePath}.lock`
    this.bindingMutationFence = bindingMutationFence
  }

  private async ensureParentDir(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
  }

  private async ensureLockFile(): Promise<void> {
    await this.ensureParentDir()
    await writeFile(this.lockPath, '', { flag: 'a' })
  }

  private async withStoreLock<T>(callback: () => Promise<T>): Promise<T> {
    await this.ensureLockFile()

    let release: (() => Promise<void>) | undefined
    try {
      release = await lockfile.lock(this.lockPath, LOCK_OPTIONS)
      return await callback()
    } finally {
      if (release) {
        await release()
      }
    }
  }

  private async readStore(): Promise<SessionStoreShape> {
    if (!(await fileExists(this.filePath))) {
      return {
        schemaVersion: 1,
        records: {},
      }
    }

    const content = await readFile(this.filePath, 'utf8')
    const parsed = JSON.parse(content) as SessionStoreShape
    if (parsed.schemaVersion !== 1 || typeof parsed.records !== 'object' || parsed.records === null) {
      return {
        schemaVersion: 1,
        records: {},
      }
    }

    return parsed
  }

  private async writeStore(store: SessionStoreShape): Promise<void> {
    await writeJsonFileAtomic(this.filePath, store, { indent: 2 })
  }

  async list(): Promise<OpenCodeSessionRecord[]> {
    const store = await this.readStore()
    return Object.values(store.records)
  }

  async get(teamId: string, laneIdOrMemberName: string, memberName?: string): Promise<OpenCodeSessionRecord | null> {
    const laneId = memberName ? laneIdOrMemberName : 'primary'
    const normalizedMemberName = memberName ?? laneIdOrMemberName
    const store = await this.readStore()
    return store.records[buildRecordKey({ teamId, laneId, memberName: normalizedMemberName })] ?? null
  }

  /**
   * Produces a monotonic, one-use proof of the exact persisted session image.
   * The synchronous consume step is intentionally suitable for the final
   * provider invocation edge: no promise or event-loop turn separates it from
   * the caller's POST invocation.
   */
  async prepareEffectToken(
    teamId: string,
    laneId: string,
    memberName: string,
    expectedRecord: OpenCodeSessionRecord,
  ): Promise<{ consume(): boolean } | null> {
    const expectedImage = jsonStringify(expectedRecord)
    let fd = -1
    try {
      fd = openSync(this.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const opened = fstatSync(fd)
      const linked = lstatSync(this.filePath)
      if (!opened.isFile() || !linked.isFile() || linked.isSymbolicLink() ||
        opened.dev !== linked.dev || opened.ino !== linked.ino ||
        opened.size < 2 || opened.size > MAX_EFFECT_STORE_BYTES ||
        realpathSync(this.filePath) !== path.resolve(this.filePath)) {
        closeSync(fd)
        return null
      }
      const raw = Buffer.alloc(opened.size)
      if (readSync(fd, raw, 0, raw.length, 0) !== raw.length) {
        closeSync(fd)
        return null
      }
      const parsed = JSON.parse(raw.toString('utf8')) as SessionStoreShape
      const record = parsed.schemaVersion === 1
        ? parsed.records?.[buildRecordKey({ teamId, laneId, memberName })]
        : undefined
      if (!record || record.toolApprovalMode !== 'manual' ||
        jsonStringify(record) !== expectedImage) {
        closeSync(fd)
        return null
      }
      const expectedStoreImage = raw.toString('utf8')
      const identity = { dev: opened.dev, ino: opened.ino, size: opened.size }
      const ownedFd = fd
      fd = -1
      let consumed = false
      return {
        consume: () => {
          if (consumed) return false
          consumed = true
          try {
            const current = fstatSync(ownedFd)
            const linkedBefore = lstatSync(this.filePath)
            if (!current.isFile() || !linkedBefore.isFile() || linkedBefore.isSymbolicLink() ||
              current.dev !== identity.dev || current.ino !== identity.ino ||
              linkedBefore.dev !== identity.dev || linkedBefore.ino !== identity.ino ||
              current.size !== identity.size ||
              realpathSync(this.filePath) !== path.resolve(this.filePath)) return false
            const currentRaw = Buffer.alloc(current.size)
            const complete = readSync(ownedFd, currentRaw, 0, currentRaw.length, 0) === currentRaw.length
            const linkedAfter = lstatSync(this.filePath)
            return complete && linkedAfter.isFile() && !linkedAfter.isSymbolicLink() &&
              linkedAfter.dev === identity.dev && linkedAfter.ino === identity.ino &&
              realpathSync(this.filePath) === path.resolve(this.filePath) &&
              currentRaw.toString('utf8') === expectedStoreImage
          } catch {
            return false
          } finally {
            closeSync(ownedFd)
          }
        },
      }
    } catch {
      if (fd >= 0) closeSync(fd)
      return null
    }
  }

  async upsert(record: OpenCodeSessionRecord): Promise<UpsertResult> {
    return this.bindingMutationFence.withTeamBindingMutation(record.teamId, async () =>
      await this.withStoreLock(async () => {
        const store = await this.readStore()
        const key = buildRecordKey(record)
        const previous = store.records[key]

        if (previous && jsonStringify(previous) === jsonStringify(record)) {
          return 'unchanged'
        }

        store.records[key] = record
        await this.writeStore(store)
        return previous ? 'updated' : 'created'
      }),
    )
  }

  async markStale(
    teamId: string,
    laneIdOrMemberName: string,
    memberNameOrStaleReason: string,
    staleReasonMaybe?: string,
  ): Promise<OpenCodeSessionRecord | null> {
    const laneId = staleReasonMaybe ? laneIdOrMemberName : 'primary'
    const memberName = staleReasonMaybe ? memberNameOrStaleReason : laneIdOrMemberName
    const staleReason = staleReasonMaybe ?? memberNameOrStaleReason
    return this.bindingMutationFence.withTeamBindingMutation(teamId, async () =>
      await this.withStoreLock(async () => {
        const store = await this.readStore()
        const key = buildRecordKey({ teamId, laneId, memberName })
        const previous = store.records[key]
        if (!previous) {
          return null
        }

        if (previous.staleReason === staleReason) {
          return previous
        }

        const next: OpenCodeSessionRecord = {
          ...previous,
          staleReason,
          updatedAt: new Date().toISOString(),
        }

        store.records[key] = next
        await this.writeStore(store)
        return next
      }),
    )
  }

  async delete(teamId: string, laneIdOrMemberName: string, memberName?: string): Promise<boolean> {
    const laneId = memberName ? laneIdOrMemberName : 'primary'
    const normalizedMemberName = memberName ?? laneIdOrMemberName
    return this.bindingMutationFence.withTeamBindingMutation(teamId, async () =>
      await this.withStoreLock(async () => {
        const store = await this.readStore()
        const key = buildRecordKey({ teamId, laneId, memberName: normalizedMemberName })
        if (!store.records[key]) {
          return false
        }

        delete store.records[key]
        await this.writeStore(store)
        return true
      }),
    )
  }
}

export const openCodeSessionStore = new OpenCodeSessionStore()
