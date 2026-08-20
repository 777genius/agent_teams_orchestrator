import type {
  OpenCodePassiveClock,
  OpenCodePassiveReadResult,
  OpenCodePassiveStatusReaderPorts,
} from './OpenCodePassiveStatusReader.js'
import { createOpenCodePassiveReadFailure, createOpenCodePassiveReadSuccess, openCodePassiveInputPathIdentity } from './OpenCodePassiveStatusReader.js'

export class FakePassiveClock implements OpenCodePassiveClock {
  #now: number
  #nextId = 1
  #timers = new Map<number, { at: number; callback: () => void }>()
  constructor(now = 1_000) { this.#now = now }
  now() { return this.#now }
  schedule(callback: () => void, delayMs: number) {
    const id = this.#nextId++
    this.#timers.set(id, { at: this.#now + delayMs, callback })
    return { cancel: () => { this.#timers.delete(id) } }
  }
  advance(ms: number) {
    this.#now += ms
    for (const [id, timer] of [...this.#timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= this.#now && this.#timers.delete(id)) timer.callback()
    }
  }
  setNow(now: number) { this.#now = now }
  pendingTimers() { return this.#timers.size }
}

export function success<T>(value: T, observedAt = 900, validUntil = 2_000): OpenCodePassiveReadResult<T> {
  return createOpenCodePassiveReadSuccess(value, observedAt, validUntil)
}
export function failure(kind: 'timeout' | 'cancelled' | 'transient' | 'invalid' = 'transient') {
  return Promise.resolve(createOpenCodePassiveReadFailure(kind))
}
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
export function fakePorts(clock: FakePassiveClock, overrides: Record<string, any> = {}): OpenCodePassiveStatusReaderPorts {
  const sideEffects = new Proxy({}, { get: (_target, property) => { throw new Error(`forbidden side effect: ${String(property)}`) } })
  void sideEffects // Sentinel demonstrates no active dependency can be supplied to the constructor.
  const legacy = {
    clock,
    projectScope: { canonicalize: async (projectPath: string) => success({ canonicalPath: '/canonical/project', inputPathIdentity: openCodePassiveInputPathIdentity(projectPath) }) },
    binaryMetadata: { read: async () => success({ present: true, version: '1.2.3' }) },
    snapshots: { read: async () => success(null) },
    configMetadata: { read: async () => success({ configured: false }) },
    authMetadata: { read: async () => success({ lastConnectedAt: null }) },
    catalogMetadata: { read: async () => success({ available: false }) },
    executionMetadata: { read: async () => success({ verified: false }) },
    ...overrides,
  }
  const adapt = (port: { read: (...args: any[]) => any }) => ({
    read: (...args: any[]) => {
      const handoff = args.pop() as (result: OpenCodePassiveReadResult<unknown>) => void
      try {
        const returned = port.read(...args)
        if (returned !== null && typeof returned === 'object' && !nodeTypes.isProxy(returned) && nodeTypes.isPromise(returned)) {
          Promise.prototype.then.call(returned, handoff, () => handoff(createOpenCodePassiveReadFailure('transient')))
        } else if (returned !== undefined) handoff(createOpenCodePassiveReadFailure('invalid'))
      }
      catch { handoff(createOpenCodePassiveReadFailure('transient')) }
    },
  })
  return {
    clock,
    projectScope: { canonicalize: adapt({ read: legacy.projectScope.canonicalize }).read },
    binaryMetadata: adapt(legacy.binaryMetadata),
    snapshots: adapt(legacy.snapshots),
    configMetadata: adapt(legacy.configMetadata),
    authMetadata: adapt(legacy.authMetadata),
    catalogMetadata: adapt(legacy.catalogMetadata),
    executionMetadata: adapt(legacy.executionMetadata),
  } as OpenCodePassiveStatusReaderPorts
}

export async function flushMicrotasks(turns = 8) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve()
}
import { types as nodeTypes } from 'node:util'
