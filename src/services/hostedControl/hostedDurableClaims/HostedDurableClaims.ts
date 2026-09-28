import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, join, parse, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import type { HostedContainerAttemptClaims, HostedContainerLaneBinding } from '../../teamLifecycleOwner/HostedContainerOpenCodeLane.js'
import { hostedMemberAttempt, type HostedMemberAttempt, type HostedMemberDelivery,
  type HostedMemberSessionClaims } from '../hostedLaneSession/HostedMemberSessionBridge.js'

const HEX = /^[0-9a-f]{64}$/
const HANDLE = /^opencode_[0-9a-f]{32}$/
const GENERATION = /^[0-9a-f]{32}$/
const DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const MAX_RECORD_BYTES = 8_192
type JsonRecord = Record<string, unknown>

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function object(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function exact(value: unknown, keys: string[]): value is JsonRecord {
  return object(value) && Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key))
}

/** The caller supplies an existing, trusted Owner-private directory, never a workspace path. */
class PrivateClaimDirectory {
  readonly path: string

  constructor(path: string) {
    if (!isAbsolute(path) || resolve(path) !== path) throw new TypeError('Claim directory must be an absolute canonical path')
    this.path = path
  }

  async #root() {
    const root = parse(this.path).root
    let current = root
    for (const segment of this.path.slice(root.length).split(sep).filter(Boolean)) {
      current = join(current, segment)
      const stat = await lstat(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe hosted claim directory')
    }
    const handle = await open(this.path, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await handle.stat()
      const currentStat = await lstat(this.path)
      if (!stat.isDirectory() || !currentStat.isDirectory() || stat.dev !== currentStat.dev ||
        stat.ino !== currentStat.ino || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
        throw new Error('Hosted claim directory must be Owner-private')
      }
      return handle
    } catch (error) { await handle.close(); throw error }
  }

  async #assertRootStable(root: FileHandle): Promise<void> {
    const [opened, current] = await Promise.all([root.stat(), lstat(this.path)])
    if (!current.isDirectory() || current.isSymbolicLink() || opened.dev !== current.dev ||
      opened.ino !== current.ino || opened.uid !== process.getuid?.() ||
      (opened.mode & 0o077) !== 0) throw new Error('Hosted claim directory substituted')
  }

  async read(name: string): Promise<JsonRecord | null> {
    const root = await this.#root()
    try {
      const path = join(this.path, name)
      let file
      try { file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          await this.#assertRootStable(root)
          return null
        }
        throw error
      }
      try {
        const stat = await file.stat()
        const pathStat = await lstat(path)
        if (!stat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink() ||
          stat.dev !== pathStat.dev || stat.ino !== pathStat.ino || stat.nlink !== 1 ||
          stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 ||
          stat.size < 1 || stat.size > MAX_RECORD_BYTES) throw new Error('Unsafe hosted claim record')
        const text = await file.readFile('utf8')
        const value: unknown = JSON.parse(text)
        if (!object(value)) throw new Error('Invalid hosted claim record')
        await this.#assertRootStable(root)
        return value
      } finally { await file.close() }
    } finally { await root.close() }
  }

  async create(name: string, value: JsonRecord): Promise<boolean> {
    const root = await this.#root()
    const path = join(this.path, name)
    let file
    try {
      try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0), 0o600) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw error
      }
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() ||
          (stat.mode & 0o077) !== 0) throw new Error('Unsafe hosted claim record')
        const text = JSON.stringify(value)
        if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new Error('Hosted claim record too large')
        await file.writeFile(text)
        await file.sync()
        const current = await lstat(path)
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== stat.dev ||
          current.ino !== stat.ino) throw new Error('Hosted claim record substituted')
        await this.#assertRootStable(root)
        await root.sync()
        return true
      } finally { await file.close() }
    } finally { await root.close() }
  }
}

function laneInput(input: { key: string; fingerprint: string }): void {
  if (!HEX.test(input.key) || !HEX.test(input.fingerprint)) throw new TypeError('Invalid hosted lane claim')
}

function binding(input: HostedContainerLaneBinding): void {
  const legacyIds = /^run_[0-9a-f]{64}$/.test(input.runId) &&
    /^team_[0-9a-f]{64}$/.test(input.teamId) && /^lane_[0-9a-f]{64}$/.test(input.laneId)
  const canonicalIds = /^run_[0-9a-f]{32}$/.test(input.runId) &&
    /^team_[0-9a-f]{32}$/.test(input.teamId) && /^lane_[0-9a-f]{32}$/.test(input.laneId)
  if (!exact(input, ['key', 'fingerprint', 'operationId', 'runId', 'teamId', 'laneId',
    'memberId', 'memberName', 'model', 'promptSha256']) ||
    !HEX.test(input.key) || !HEX.test(input.fingerprint) || !HEX.test(input.promptSha256) ||
    !/^start_[0-9a-f]{64}$/.test(input.operationId) ||
    !/^member_[0-9a-f]{32}$/.test(input.memberId) ||
    (!legacyIds && !canonicalIds) ||
    typeof input.memberName !== 'string' || !input.memberName || input.memberName.length > 128 ||
    typeof input.model !== 'string' || !input.model || input.model.length > 256) {
    throw new TypeError('Invalid hosted container binding')
  }
}

function validStoppedContainer(value: unknown, fingerprint: string): boolean {
  return exact(value, ['fingerprint', 'handle', 'generation']) &&
    value.fingerprint === fingerprint && HANDLE.test(String(value.handle)) &&
    GENERATION.test(String(value.generation))
}

function record(value: JsonRecord | null, type: string, keys: string[]): JsonRecord | null {
  if (value === null) return null
  if (!exact(value, ['version', 'type', ...keys]) || value.version !== 1 || value.type !== type) {
    throw new Error('Invalid hosted claim record')
  }
  return value
}

export class HostedDurableContainerAttemptClaims implements HostedContainerAttemptClaims {
  readonly #files: PrivateClaimDirectory
  constructor(directory: string) { this.#files = new PrivateClaimDirectory(directory) }

  async claimLane(input: { key: string; fingerprint: string }) {
    laneInput(input)
    // A missing primary with a surviving terminal marker is ambiguous, never fresh.
    await this.readLane(input.key)
    const name = `lane-${input.key}.json`
    const created = await this.#files.create(name, { version: 1, type: 'lane',
      key: input.key, fingerprint: input.fingerprint, state: 'claimed' })
    if (created && await this.#files.read(`lane-${input.key}.closed.json`)) {
      throw new Error('Orphaned hosted lane closure')
    }
    const existing = record(await this.#files.read(name), 'lane', ['key', 'fingerprint', 'state'])!
    if (existing.key !== input.key || !HEX.test(String(existing.fingerprint)) ||
      !['claimed', 'closed'].includes(String(existing.state))) throw new Error('Invalid hosted lane claim')
    return { created, fingerprint: existing.fingerprint as string }
  }

  async closeLane(input: { key: string; fingerprint: string }) {
    laneInput(input)
    await this.readLane(input.key)
    const name = `lane-${input.key}.json`
    await this.#files.create(name, { version: 1, type: 'lane',
      key: input.key, fingerprint: input.fingerprint, state: 'closed' })
    const existing = record(await this.#files.read(name), 'lane', ['key', 'fingerprint', 'state'])!
    if (existing.key !== input.key || !HEX.test(String(existing.fingerprint)) ||
      !['claimed', 'closed'].includes(String(existing.state))) throw new Error('Invalid hosted lane claim')
    if (existing.fingerprint !== input.fingerprint) return { closed: false, fingerprint: existing.fingerprint as string }
    if (existing.state === 'claimed') {
      const marker = `lane-${input.key}.closed.json`
      await this.#files.create(marker, { version: 1, type: 'lane-closed',
        key: input.key, fingerprint: input.fingerprint })
      const closed = record(await this.#files.read(marker), 'lane-closed', ['key', 'fingerprint'])!
      if (closed.key !== input.key || closed.fingerprint !== input.fingerprint) throw new Error('Invalid hosted lane closure')
    }
    return { closed: true, fingerprint: input.fingerprint }
  }

  async readLane(key: string): Promise<string | null> {
    if (!HEX.test(key)) throw new TypeError('Invalid hosted lane key')
    const existing = record(await this.#files.read(`lane-${key}.json`), 'lane',
      ['key', 'fingerprint', 'state'])
    if (!existing) {
      if (await this.#files.read(`lane-${key}.closed.json`)) throw new Error('Orphaned hosted lane closure')
      return null
    }
    if (existing.key !== key || !HEX.test(String(existing.fingerprint)) ||
      !['claimed', 'closed'].includes(String(existing.state))) throw new Error('Invalid hosted lane claim')
    return existing.fingerprint as string
  }

  async claim(input: HostedContainerLaneBinding) {
    binding(input)
    await this.read(input)
    const name = `member-${input.key}.json`
    const created = await this.#files.create(name, { version: 1, type: 'member', binding: input })
    if (created && await this.#files.read(`member-${input.key}.stopped.json`)) {
      throw new Error('Orphaned hosted stop evidence')
    }
    const existing = record(await this.#files.read(name), 'member', ['binding'])!
    if (!object(existing.binding) || existing.binding.key !== input.key) {
      throw new Error('Invalid hosted member claim')
    }
    binding(existing.binding as HostedContainerLaneBinding)
    return { created, fingerprint: existing.binding.fingerprint as string }
  }

  async read(input: HostedContainerLaneBinding): Promise<
    { state: 'absent' } | { state: 'claimed' | 'stopped'; fingerprint: string }> {
    binding(input)
    const original = record(await this.#files.read(`member-${input.key}.json`), 'member', ['binding'])
    if (!original) {
      if (await this.#files.read(`member-${input.key}.stopped.json`)) throw new Error('Orphaned hosted stop evidence')
      return { state: 'absent' }
    }
    if (!object(original.binding) || original.binding.key !== input.key) throw new Error('Invalid hosted member claim')
    binding(original.binding as HostedContainerLaneBinding)
    const stopped = record(await this.#files.read(`member-${input.key}.stopped.json`),
      'member-stopped', ['binding', 'container'])
    if (stopped && (!isDeepStrictEqual(stopped.binding, original.binding) ||
      !validStoppedContainer(stopped.container, original.binding.fingerprint as string))) {
      throw new Error('Invalid hosted stop evidence')
    }
    return { state: stopped ? 'stopped' : 'claimed', fingerprint: original.binding.fingerprint as string }
  }

  async markStopped(input: HostedContainerLaneBinding, container: { fingerprint: string; handle: string; generation: string }) {
    binding(input)
    if (!validStoppedContainer(container, input.fingerprint)) return false
    await this.read(input)
    const original = record(await this.#files.read(`member-${input.key}.json`), 'member', ['binding'])
    if (!original || !isDeepStrictEqual(original.binding, input)) return false
    const name = `member-${input.key}.stopped.json`
    await this.#files.create(name, { version: 1, type: 'member-stopped', binding: input, container })
    const stopped = record(await this.#files.read(name), 'member-stopped', ['binding', 'container'])!
    if (!isDeepStrictEqual(stopped.binding, input) || !isDeepStrictEqual(stopped.container, container)) {
      throw new Error('Conflicting hosted stop evidence')
    }
    return true
  }
}

function validAttempt(attempt: HostedMemberAttempt): void {
  if (!object(attempt)) throw new TypeError('Invalid hosted session attempt')
  const { attemptId, ...input } = attempt
  if (!isDeepStrictEqual(hostedMemberAttempt(input as Omit<HostedMemberAttempt, 'attemptId'>), attempt)) {
    throw new TypeError('Invalid hosted session attempt')
  }
}

export class HostedDurableMemberSessionClaims implements HostedMemberSessionClaims {
  readonly #files: PrivateClaimDirectory
  constructor(directory: string) { this.#files = new PrivateClaimDirectory(directory) }

  async claimStart(attempt: HostedMemberAttempt) {
    validAttempt(attempt)
    const key = sha([attempt.teamId, attempt.runId, attempt.laneId, attempt.memberName.toLowerCase()])
    const name = `session-${key}.json`
    const created = await this.#files.create(name, { version: 1, type: 'session', key,
      attemptId: attempt.attemptId, fingerprint: attempt.planFingerprint })
    const existing = record(await this.#files.read(name), 'session', ['key', 'attemptId', 'fingerprint'])!
    if (existing.key !== key || !/^member_attempt_[0-9a-f]{64}$/.test(String(existing.attemptId)) ||
      !HEX.test(String(existing.fingerprint))) throw new Error('Invalid hosted session claim')
    // A changed generation or member admission must not obtain another Start under this stable key.
    return { created, fingerprint: existing.fingerprint as string }
  }

  async claimDelivery(delivery: HostedMemberDelivery, fingerprint: string) {
    validAttempt(delivery.attempt)
    if (!DELIVERY_ID.test(delivery.deliveryId) || !HEX.test(fingerprint) ||
      fingerprint !== sha([delivery.attempt.attemptId, delivery.deliveryId, delivery.kind,
        delivery.text, delivery.taskId, delivery.taskRevision])) throw new TypeError('Invalid hosted delivery claim')
    const key = sha(delivery.deliveryId)
    const name = `delivery-${key}.json`
    const created = await this.#files.create(name, { version: 1, type: 'delivery',
      deliveryId: delivery.deliveryId, fingerprint })
    const existing = record(await this.#files.read(name), 'delivery', ['deliveryId', 'fingerprint'])!
    if (existing.deliveryId !== delivery.deliveryId || !HEX.test(String(existing.fingerprint))) {
      throw new Error('Invalid hosted delivery claim')
    }
    return { created, fingerprint: existing.fingerprint as string }
  }

  async readDelivery(deliveryId: string) {
    if (!DELIVERY_ID.test(deliveryId)) throw new TypeError('Invalid hosted delivery ID')
    const existing = record(await this.#files.read(`delivery-${sha(deliveryId)}.json`),
      'delivery', ['deliveryId', 'fingerprint'])
    if (!existing) return null
    if (existing.deliveryId !== deliveryId || !HEX.test(String(existing.fingerprint))) {
      throw new Error('Invalid hosted delivery claim')
    }
    return { fingerprint: existing.fingerprint as string }
  }
}
