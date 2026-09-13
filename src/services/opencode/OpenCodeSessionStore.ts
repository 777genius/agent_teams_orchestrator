import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
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

export type OpenCodeHostedSessionIdentity = Readonly<{
  teamId: string
  laneId: string
  memberName: string
}>

export type OpenCodeHostedMetadataResult =
  | Readonly<{ status: 'applied' }>
  | Readonly<{ status: 'conflict'; current: Readonly<OpenCodeSessionRecord> | null }>
  | Readonly<{ status: 'unavailable'; cause: unknown; publication: 'not_started' | 'unknown' }>

export type OpenCodeHostedSessionPublicationStore = Readonly<{
  readExact(key: OpenCodeHostedSessionIdentity): Promise<Readonly<OpenCodeSessionRecord> | null>
  compareAndSwap(input: Readonly<{
    key: OpenCodeHostedSessionIdentity
    expected: Readonly<OpenCodeSessionRecord> | null
    next: Readonly<OpenCodeSessionRecord> | null
  }>): Promise<OpenCodeHostedMetadataResult>
}>

const hostedPublicationStores = new WeakMap<OpenCodeSessionStore, OpenCodeHostedSessionPublicationStore>()
const hostedPublicationStoreOwners = new WeakMap<OpenCodeHostedSessionPublicationStore, OpenCodeSessionStore>()

function snapshotRecord(record: Readonly<OpenCodeSessionRecord>): Readonly<OpenCodeSessionRecord> {
  return Object.freeze(structuredClone(record))
}

function exactRecordImage(record: Readonly<OpenCodeSessionRecord> | null): string | null {
  if (record === null) return null
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]))
    }
    return value
  }
  return jsonStringify(canonicalize(record))
}

function validateHostedIdentity(value: OpenCodeHostedSessionIdentity): OpenCodeHostedSessionIdentity {
  const copy = { teamId: value.teamId, laneId: value.laneId, memberName: value.memberName }
  for (const [name, component] of Object.entries(copy)) {
    if (!component || component !== component.trim() || component.includes('::')) {
      throw new Error(`OpenCode hosted session ${name} is not canonical`)
    }
  }
  return Object.freeze(copy)
}

function validateHostedRecord(
  key: OpenCodeHostedSessionIdentity,
  value: Readonly<OpenCodeSessionRecord>,
): Readonly<OpenCodeSessionRecord> {
  const nullableString = (candidate: unknown): candidate is string | null =>
    candidate === null || typeof candidate === 'string'
  const optionalString = (candidate: unknown): candidate is string | undefined =>
    candidate === undefined || typeof candidate === 'string'
  const optionalNullableString = (candidate: unknown): candidate is string | null | undefined =>
    candidate === undefined || nullableString(candidate)
  const durableStates = new Set(['idle', 'running', 'retrying', 'blocked', 'error', 'reply_pending', 'unknown'])
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.providerId !== 'opencode' ||
    value.teamId !== key.teamId || (value.laneId ?? 'primary') !== key.laneId ||
    value.memberName !== key.memberName || !value.opencodeSessionId?.trim() ||
    !value.hostKey?.trim() || !value.profileRootKey?.trim() || !value.projectPath?.trim() ||
    !value.selectedModel?.trim() || !value.projectBehaviorFingerprint?.trim() ||
    !value.createdAt?.trim() || !value.updatedAt?.trim() ||
    !optionalString(value.laneId) || !optionalNullableString(value.runId) ||
    !optionalString(value.selectedVariant) ||
    !optionalNullableString(value.openCodeArtifactDigest) ||
    (typeof value.openCodeArtifactDigest === 'string' && !value.openCodeArtifactDigest.startsWith('sha256:')) ||
    (value.toolApprovalMode !== undefined && value.toolApprovalMode !== 'auto' && value.toolApprovalMode !== 'manual') ||
    (value.runtimePid !== undefined && (!Number.isSafeInteger(value.runtimePid) || value.runtimePid <= 0)) ||
    !nullableString(value.resolvedBehaviorFingerprint) ||
    !nullableString(value.lastCanonicalCursor) || !nullableString(value.lastKnownRawStatus) ||
    (value.lastKnownDurableState !== null && !durableStates.has(value.lastKnownDurableState)) ||
    !nullableString(value.sourceAuthFingerprint) ||
    !nullableString(value.managedAuthFingerprint) || !optionalString(value.managedConfigFingerprint) ||
    !optionalString(value.opencodeVersion) ||
    (value.bootstrapMode !== undefined && value.bootstrapMode !== 'app_managed_context' &&
      value.bootstrapMode !== 'model_tool_checkin') ||
    (value.bootstrapEvidenceSource !== undefined &&
      value.bootstrapEvidenceSource !== 'app_managed_bootstrap' &&
      value.bootstrapEvidenceSource !== 'runtime_bootstrap_checkin') ||
    !nullableString(value.staleReason)) {
    throw new Error('OpenCode hosted session record does not match its exact identity')
  }
  if (value.appManagedBootstrap !== undefined) {
    const bootstrap = value.appManagedBootstrap
    if (!bootstrap || typeof bootstrap !== 'object' || bootstrap.schemaVersion !== 1 ||
      !bootstrap.messageID?.trim() || !bootstrap.contextHash?.trim() ||
      !bootstrap.briefingHash?.trim() || !bootstrap.injectionVerifiedAt?.trim() ||
      !optionalString(bootstrap.model) || !optionalString(bootstrap.agent)) {
      throw new Error('OpenCode hosted session bootstrap metadata is malformed')
    }
  }
  return snapshotRecord(value)
}

export function retainHostedSessionPublicationStore(
  store: OpenCodeSessionStore,
): OpenCodeHostedSessionPublicationStore {
  const capability = hostedPublicationStores.get(store)
  if (!capability || hostedPublicationStoreOwners.get(capability) !== store) {
    throw new Error('OpenCode hosted session publication requires the actual store implementation')
  }
  return capability
}

export function isHostedSessionPublicationStoreFor(
  capability: OpenCodeHostedSessionPublicationStore,
  store: object,
): boolean {
  const owner = hostedPublicationStoreOwners.get(capability)
  return owner === store && owner !== undefined && hostedPublicationStores.get(owner) === capability
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
  readonly #filePath: string
  readonly #lockPath: string

  readonly #bindingMutationFence: HostedApprovalRuntimeBindingMutationFence
  readonly #hostedPublicationFaults: Readonly<{
    beforeRename?: () => Promise<void>
    afterRename?: () => Promise<void>
    afterLockReleaseForTest?: () => Promise<void>
  }>

  constructor(
    filePath?: string,
    bindingMutationFence: HostedApprovalRuntimeBindingMutationFence = hostedApprovalRuntimeBindingFences,
    hostedPublicationFaults: Readonly<{
      beforeRename?: () => Promise<void>
      afterRename?: () => Promise<void>
      afterLockReleaseForTest?: () => Promise<void>
    }> = {},
  ) {
    this.#filePath = filePath ?? path.join(resolveClaudeMultimodelPaths().data, 'opencode', 'session-store.json')
    this.#lockPath = `${this.#filePath}.lock`
    this.#bindingMutationFence = bindingMutationFence
    this.#hostedPublicationFaults = Object.freeze({ ...hostedPublicationFaults })
    if (new.target === OpenCodeSessionStore) {
      const capability = Object.freeze({
        readExact: (key: OpenCodeHostedSessionIdentity) => this.#readHostedExact(key),
        compareAndSwap: (input: Readonly<{
          key: OpenCodeHostedSessionIdentity
          expected: Readonly<OpenCodeSessionRecord> | null
          next: Readonly<OpenCodeSessionRecord> | null
        }>) => this.#compareAndSwapHosted(input),
      })
      hostedPublicationStores.set(this, capability)
      hostedPublicationStoreOwners.set(capability, this)
    }
  }

  async #ensureParentDir(): Promise<void> {
    await mkdir(path.dirname(this.#filePath), { recursive: true })
  }

  async #ensureLockFile(): Promise<void> {
    await this.#ensureParentDir()
    await writeFile(this.#lockPath, '', { flag: 'a' })
  }

  async #withStoreLock<T>(callback: () => Promise<T>): Promise<T> {
    await this.#ensureLockFile()

    let release: (() => Promise<void>) | undefined
    try {
      release = await lockfile.lock(this.#lockPath, LOCK_OPTIONS)
      return await callback()
    } finally {
      if (release) {
        await release()
      }
    }
  }

  private async readStore(): Promise<SessionStoreShape> {
    if (!(await fileExists(this.#filePath))) {
      return {
        schemaVersion: 1,
        records: {},
      }
    }

    const content = await readFile(this.#filePath, 'utf8')
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
    await writeJsonFileAtomic(this.#filePath, store, { indent: 2 })
  }

  async #readStoreStrict(): Promise<SessionStoreShape> {
    let content: string
    try {
      content = await readFile(this.#filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, records: {} }
      throw error
    }
    const parsed: unknown = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('OpenCode hosted session store root is malformed')
    }
    const candidate = parsed as Partial<SessionStoreShape>
    if (candidate.schemaVersion !== 1 || !candidate.records ||
      typeof candidate.records !== 'object' || Array.isArray(candidate.records)) {
      throw new Error('OpenCode hosted session store schema is unavailable')
    }
    for (const [storedKey, record] of Object.entries(candidate.records)) {
      if (!record || typeof record !== 'object' || buildRecordKey(record) !== storedKey) {
        throw new Error('OpenCode hosted session store contains a malformed record')
      }
      validateHostedIdentity({
        teamId: record.teamId,
        laneId: record.laneId ?? 'primary',
        memberName: record.memberName,
      })
      validateHostedRecord({ teamId: record.teamId, laneId: record.laneId ?? 'primary', memberName: record.memberName }, record)
    }
    return candidate as SessionStoreShape
  }

  async #writeStoreHosted(store: SessionStoreShape, publication: { renamed: boolean }): Promise<void> {
    await this.#ensureParentDir()
    const temporaryPath = path.join(path.dirname(this.#filePath), `.${path.basename(this.#filePath)}.${process.pid}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporaryPath, `${jsonStringify(store, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      await this.#hostedPublicationFaults.beforeRename?.()
      await rename(temporaryPath, this.#filePath)
      publication.renamed = true
      await this.#hostedPublicationFaults.afterRename?.()
    } finally {
      await unlink(temporaryPath).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
  }

  async #readHostedExact(keyInput: OpenCodeHostedSessionIdentity): Promise<Readonly<OpenCodeSessionRecord> | null> {
    const key = validateHostedIdentity(keyInput)
    return this.#withStoreLock(async () => {
      const store = await this.#readStoreStrict()
      const record = store.records[buildRecordKey(key)]
      return record ? validateHostedRecord(key, record) : null
    })
  }

  async #compareAndSwapHosted(input: Readonly<{
    key: OpenCodeHostedSessionIdentity
    expected: Readonly<OpenCodeSessionRecord> | null
    next: Readonly<OpenCodeSessionRecord> | null
  }>): Promise<OpenCodeHostedMetadataResult> {
    let key: OpenCodeHostedSessionIdentity
    let expected: Readonly<OpenCodeSessionRecord> | null
    let next: Readonly<OpenCodeSessionRecord> | null
    try {
      key = validateHostedIdentity(input.key)
      expected = input.expected === null ? null : validateHostedRecord(key, input.expected)
      next = input.next === null ? null : validateHostedRecord(key, input.next)
    } catch (cause) {
      return Object.freeze({ status: 'unavailable', cause, publication: 'not_started' })
    }
    const publication = { renamed: false }
    try {
      return await this.#bindingMutationFence.withTeamBindingMutation(key.teamId, async () => {
        const result = await this.#withStoreLock(async () => {
          const store = await this.#readStoreStrict()
          const recordKey = buildRecordKey(key)
          const current = store.records[recordKey]
            ? validateHostedRecord(key, store.records[recordKey]!)
            : null
          if (exactRecordImage(current) !== exactRecordImage(expected)) {
            return Object.freeze({ status: 'conflict', current })
          }
          if (next === null) delete store.records[recordKey]
          else store.records[recordKey] = structuredClone(next)
          await this.#writeStoreHosted(store, publication)
          return Object.freeze({ status: 'applied' })
        })
        await this.#hostedPublicationFaults.afterLockReleaseForTest?.()
        return result
      })
    } catch (cause) {
      return Object.freeze({
        status: 'unavailable',
        cause,
        publication: publication.renamed ? 'unknown' : 'not_started',
      })
    }
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
      fd = openSync(this.#filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const opened = fstatSync(fd)
      const linked = lstatSync(this.#filePath)
      if (!opened.isFile() || !linked.isFile() || linked.isSymbolicLink() ||
        opened.dev !== linked.dev || opened.ino !== linked.ino ||
        opened.size < 2 || opened.size > MAX_EFFECT_STORE_BYTES ||
        realpathSync(this.#filePath) !== path.resolve(this.#filePath)) {
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
            const linkedBefore = lstatSync(this.#filePath)
            if (!current.isFile() || !linkedBefore.isFile() || linkedBefore.isSymbolicLink() ||
              current.dev !== identity.dev || current.ino !== identity.ino ||
              linkedBefore.dev !== identity.dev || linkedBefore.ino !== identity.ino ||
              current.size !== identity.size ||
              realpathSync(this.#filePath) !== path.resolve(this.#filePath)) return false
            const currentRaw = Buffer.alloc(current.size)
            const complete = readSync(ownedFd, currentRaw, 0, currentRaw.length, 0) === currentRaw.length
            const linkedAfter = lstatSync(this.#filePath)
            return complete && linkedAfter.isFile() && !linkedAfter.isSymbolicLink() &&
              linkedAfter.dev === identity.dev && linkedAfter.ino === identity.ino &&
              realpathSync(this.#filePath) === path.resolve(this.#filePath) &&
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
    return this.#bindingMutationFence.withTeamBindingMutation(record.teamId, async () =>
      await this.#withStoreLock(async () => {
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
    return this.#bindingMutationFence.withTeamBindingMutation(teamId, async () =>
      await this.#withStoreLock(async () => {
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
    return this.#bindingMutationFence.withTeamBindingMutation(teamId, async () =>
      await this.#withStoreLock(async () => {
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
