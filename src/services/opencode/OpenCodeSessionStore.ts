import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import envPaths from 'env-paths'

import * as lockfile from '../../utils/lockfile.js'
import { jsonStringify } from '../../utils/slowOperations.js'

import type { OpenCodeSessionRecord } from './types.js'

type SessionStoreShape = {
  schemaVersion: 1
  records: Record<string, OpenCodeSessionRecord>
}

type UpsertResult = 'created' | 'updated' | 'unchanged'

const LOCK_OPTIONS = {
  retries: {
    retries: 30,
    minTimeout: 5,
    maxTimeout: 100,
  },
}

function buildRecordKey(record: Pick<OpenCodeSessionRecord, 'teamId' | 'memberName'>): string {
  return `${record.teamId}::${record.memberName}`
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

  constructor(filePath?: string) {
    const paths = envPaths('claude-multimodel')
    this.filePath = filePath ?? path.join(paths.data, 'opencode', 'session-store.json')
    this.lockPath = `${this.filePath}.lock`
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
    await this.ensureParentDir()
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    await writeFile(tempPath, jsonStringify(store, null, 2) + '\n', 'utf8')
    await rename(tempPath, this.filePath)
  }

  async list(): Promise<OpenCodeSessionRecord[]> {
    const store = await this.readStore()
    return Object.values(store.records)
  }

  async get(teamId: string, memberName: string): Promise<OpenCodeSessionRecord | null> {
    const store = await this.readStore()
    return store.records[buildRecordKey({ teamId, memberName })] ?? null
  }

  async upsert(record: OpenCodeSessionRecord): Promise<UpsertResult> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey(record)
      const previous = store.records[key]

      if (previous && jsonStringify(previous) === jsonStringify(record)) {
        return 'unchanged'
      }

      store.records[key] = record
      await this.writeStore(store)
      return previous ? 'updated' : 'created'
    })
  }

  async markStale(
    teamId: string,
    memberName: string,
    staleReason: string,
  ): Promise<OpenCodeSessionRecord | null> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey({ teamId, memberName })
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
    })
  }

  async delete(teamId: string, memberName: string): Promise<boolean> {
    return this.withStoreLock(async () => {
      const store = await this.readStore()
      const key = buildRecordKey({ teamId, memberName })
      if (!store.records[key]) {
        return false
      }

      delete store.records[key]
      await this.writeStore(store)
      return true
    })
  }
}

export const openCodeSessionStore = new OpenCodeSessionStore()
