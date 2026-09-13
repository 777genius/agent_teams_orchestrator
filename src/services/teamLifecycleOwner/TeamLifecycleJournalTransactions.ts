import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { ProcessOwnershipStoreContext } from '@agent-teams/owner-anchor-library'

import { writeFileAtomic } from '../../utils/atomicWrite.js'
import * as lockfile from '../../utils/lockfile.js'
import { fsyncFileAndParent } from '../hostedControl/HostedTaskMutationWal.js'
import {
  assertDurableStateCapacity,
  cloneJson,
  parseDurableStateJson,
  stringifyDurableState,
  TEAM_LIFECYCLE_STATE_MAX_BYTES,
  type DurableStateV5,
  validateDurableStateForWrite,
} from './TeamLifecycleDurableState.js'

export interface TeamLifecycleJournalTransactionPort {
  read<T>(transform: (state: Readonly<DurableStateV5>) => T, context?: ProcessOwnershipStoreContext): Promise<T>
  update<T>(transform: (state: DurableStateV5) => { state: DurableStateV5; value: T }, context?: ProcessOwnershipStoreContext): Promise<T>
}

export type TeamLifecycleJournalTransactionOptions = Readonly<{
  beforePublication?: () => void
  afterAtomicReplace?: () => void
  fsync?: (path: string) => Promise<void>
}>

/**
 * The only physical transaction owner for lifecycle state. Transform callbacks are synchronous and
 * run under the cross-process lock; awaiting or re-entering this port from a callback is rejected.
 */
export class TeamLifecycleJournalTransactions implements TeamLifecycleJournalTransactionPort {
  readonly #initializationMarkerPath: string
  readonly #options: TeamLifecycleJournalTransactionOptions
  #tail: Promise<void> = Promise.resolve()
  #insideTransform = false

  constructor(readonly statePath: string, options: TeamLifecycleJournalTransactionOptions = {}) {
    if (!isAbsolute(statePath) || statePath.includes('\0')) throw new TypeError('Team lifecycle state path must be absolute')
    this.#initializationMarkerPath = `${statePath}.initialized`
    this.#options = options
  }

  read<T>(transform: (state: Readonly<DurableStateV5>) => T, context?: ProcessOwnershipStoreContext): Promise<T> {
    return this.#serialized(context, async () => {
      const state = await this.#readExisting()
      this.#checkContext(context)
      return this.#transform(transform, cloneJson(state))
    })
  }

  update<T>(transform: (state: DurableStateV5) => { state: DurableStateV5; value: T }, context?: ProcessOwnershipStoreContext): Promise<T> {
    return this.#serialized(context, async () => {
      const current = await this.#readExisting()
      this.#checkContext(context)
      const transformed = this.#transform(transform, cloneJson(current))
      if (!transformed || typeof transformed !== 'object' || !('state' in transformed)) throw new TypeError('Invalid lifecycle transaction result')
      this.#checkContext(context)
      const next = validateDurableStateForWrite({ ...transformed.state, revision: current.revision + 1 })
      await this.#publish(next, context)
      return transformed.value
    })
  }

  /** Initializes only a genuinely absent never-initialized file. */
  initialize(state: DurableStateV5, context?: ProcessOwnershipStoreContext): Promise<DurableStateV5> {
    return this.#serialized(context, async () => {
      const existing = await this.#tryRead()
      if (existing) return existing
      if (await this.#markerExists()) throw new Error('Team lifecycle durable state disappeared after initialization')
      this.#checkContext(context)
      const initial = validateDurableStateForWrite(state)
      await this.#publish(initial, context)
      return cloneJson(initial)
    })
  }

  async exists(): Promise<boolean> {
    return lstat(this.statePath).then(() => true).catch(error => {
      if (errorCode(error) === 'ENOENT') return false
      throw error
    })
  }

  async markerExists(): Promise<boolean> { return this.#markerExists() }

  /** Publishes legacy decoding exactly once; active legacy evidence remains explicitly unresolved. */
  migrateLegacyIfNeeded(): Promise<void> {
    return this.#serialized(undefined, async () => {
      const document = await this.#tryReadDocument()
      if (!document) throw new Error('Team lifecycle durable state is not initialized')
      if (document.sourceSchemaVersion === 5) return
      const migrated = document.state
      await this.#publish(validateDurableStateForWrite({ ...migrated, revision: migrated.revision + 1 }))
    })
  }

  async #readExisting(): Promise<DurableStateV5> {
    const state = await this.#tryRead()
    if (state) return state
    if (await this.#markerExists()) throw new Error('Team lifecycle durable state disappeared after initialization')
    throw new Error('Team lifecycle durable state is not initialized')
  }

  async #tryRead(): Promise<DurableStateV5 | null> {
    return (await this.#tryReadDocument())?.state ?? null
  }

  async #tryReadDocument(): Promise<{ state: DurableStateV5; sourceSchemaVersion: unknown } | null> {
    const handle = await open(this.statePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => {
      if (errorCode(error) === 'ENOENT') return null
      throw error
    })
    if (!handle) return null
    try {
      const [stat, current] = await Promise.all([handle.stat(), lstat(this.statePath)])
      if (!stat.isFile() || !current.isFile() || current.isSymbolicLink() || stat.dev !== current.dev || stat.ino !== current.ino ||
        (stat.mode & 0o077) !== 0 || stat.size > TEAM_LIFECYCLE_STATE_MAX_BYTES ||
        (process.getuid?.() !== undefined && stat.uid !== process.getuid())) throw new Error('Unsafe team lifecycle durable state')
      const bytes = await handle.readFile('utf8')
      const raw = JSON.parse(bytes)
      return { state: parseDurableStateJson(bytes), sourceSchemaVersion: schemaVersionOf(raw) }
    } finally { await handle.close() }
  }

  async #publish(state: DurableStateV5, context?: ProcessOwnershipStoreContext): Promise<void> {
    const bytes = `${stringifyDurableState(state)}\n`
    assertDurableStateCapacity(state, Buffer.byteLength(bytes, 'utf8'))
    this.#options.beforePublication?.()
    // Validation and the final encoding can consume the last portion of a caller's budget.
    // This is the final cancellation/deadline gate before replacement can become visible.
    this.#checkContext(context)
    // Once replacement starts, durability settles before the serialization barrier is released.
    await writeFileAtomic(this.statePath, bytes, { mode: 0o600 })
    this.#options.afterAtomicReplace?.()
    await (this.#options.fsync ?? fsyncFileAndParent)(this.statePath)
    await this.#writeInitializationMarker()
  }

  async #writeInitializationMarker(): Promise<void> {
    if (await this.#markerExists()) return
    const marker = `${JSON.stringify({ schemaVersion: 1, initialized: true })}\n`
    await writeFileAtomic(this.#initializationMarkerPath, marker, { mode: 0o600 })
    await (this.#options.fsync ?? fsyncFileAndParent)(this.#initializationMarkerPath)
  }

  async #markerExists(): Promise<boolean> {
    const handle = await open(this.#initializationMarkerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => {
      if (errorCode(error) === 'ENOENT') return null
      throw error
    })
    if (!handle) return false
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size < 2 || stat.size > 1024 ||
        (process.getuid?.() !== undefined && stat.uid !== process.getuid())) throw new Error('Unsafe team lifecycle initialization marker')
      return true
    } finally { await handle.close() }
  }

  async #serialized<T>(context: ProcessOwnershipStoreContext | undefined, operation: () => Promise<T>): Promise<T> {
    if (this.#insideTransform) throw new Error('Nested lifecycle transaction from transform callback')
    const prior = this.#tail
    let release!: () => void
    this.#tail = new Promise<void>(resolve => { release = resolve })
    let unlock: (() => Promise<void>) | null = null
    try {
      await prior
      this.#checkContext(context)
      unlock = await this.#acquireLock(context)
      this.#checkContext(context)
      const result = await operation()
      const settleUnlock = unlock
      unlock = null
      await settleUnlock()
      // A successful replacement may have crossed its deadline while fsync, marker creation, or
      // unlock was settling. Its bytes are deliberately retained, but late success is unavailable.
      this.#checkContext(context)
      return result
    } finally {
      try {
        await unlock?.()
      } finally {
        // Every reservation advances the in-process queue, including entries rejected while
        // waiting and operations whose physical unlock reports a fail-closed error.
        release()
      }
    }
  }

  async #acquireLock(context?: ProcessOwnershipStoreContext): Promise<() => Promise<void>> {
    const initialRemaining = context
      ? context.deadline.expiresAt - context.clock.now()
      : 2_500
    if (initialRemaining <= 0) throw new Error('Team lifecycle transaction deadline expired')
    let retryBudget = initialRemaining
    while (true) {
      this.#checkContext(context)
      try {
        return await lockfile.lock(`${this.statePath}.owner`, {
          realpath: false,
          retries: 0,
        })
      } catch (error) {
        if (errorCode(error) !== 'ELOCKED') throw error
        const remaining = context
          ? context.deadline.expiresAt - context.clock.now()
          : retryBudget
        const delay = Math.min(5, remaining, retryBudget)
        if (delay <= 0) throw new Error('Team lifecycle transaction deadline expired')
        await new Promise<void>(resolve => setTimeout(resolve, delay))
        retryBudget -= delay
        this.#checkContext(context)
      }
    }
  }

  #transform<T, U>(transform: (state: T) => U, state: T): U {
    if (this.#insideTransform) throw new Error('Nested lifecycle transaction transform')
    this.#insideTransform = true
    try {
      const result = transform(state)
      if (result instanceof Promise) throw new TypeError('Lifecycle transaction callbacks must be synchronous')
      return result
    } finally { this.#insideTransform = false }
  }

  #checkContext(context?: ProcessOwnershipStoreContext): void {
    if (!context) return
    if (!context.failClosedPersistence && context.cancellation.isCancellationRequested()) throw new Error('Team lifecycle transaction cancelled')
    if (context.clock.now() >= context.deadline.expiresAt) throw new Error('Team lifecycle transaction deadline expired')
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function schemaVersionOf(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('schemaVersion' in value)) return undefined
  return value.schemaVersion
}
