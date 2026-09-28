import { expect, test } from 'bun:test'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function fixture(marked = true) {
  const host = { hostKey: 'host', pid: 100, processStartedAtMs: 10, baseUrl: 'http://127.0.0.1:1234' }
  const owner = { teamId: 'team', memberName: 'lead', runId: 'run', sessionId: 'session' }
  const key = `team::primary::lead::session:${owner.sessionId}`
  let registry: any = { schemaVersion: 1, hosts: { host: {
    ...host, ...(marked ? { cursorAgentReapContractVersion: 1 } : {}), leases: {
      [key]: { ...owner, leaseKey: key, laneId: 'primary', createdAt: 'birth', updatedAt: 'birth' },
    },
  } } }
  const manager = new OpenCodeHostManager({ persistentRegistryPath: '/mock/registry', processAttributionDirectory: null })
  // In-memory durable snapshots and a serialized gate; no filesystem or processes.
  const ports = manager as any
  let tail = Promise.resolve()
  ports.withPersistentRegistryLock = (callback: () => Promise<unknown>) => {
    const result = tail.then(callback)
    tail = result.then(() => undefined, () => undefined)
    return result
  }
  ports.readPersistentRegistryUnlocked = async () => structuredClone(registry)
  ports.writePersistentRegistryUnlocked = async (value: unknown) => { registry = structuredClone(value) }
  ports.hasPendingOAuthHost = async () => false
  let kills = 0
  const reap = () => ports.withPersistentRegistryLock(async () => {
    const record = registry.hosts.host
    // The raw reaper's admission predicate, before any native port is invoked.
    if (record.cursorAgentReapContractVersion === 1 && Object.keys(record.leases).length === 0) kills++
  })
  return { manager, host, owner, key, reap, registry: () => registry, kills: () => kills }
}

test('delayed submission survives exact release and concurrent pins never restore authority', async () => {
  const f = fixture()
  const submitting = deferred(), resume = deferred(), transported = deferred(), finish = deferred()
  const first = f.manager.withHostOperation(f.host, f.owner, async () => {
    submitting.resolve()
    await resume.promise // onPromptSubmitting
    transported.resolve() // delayed transport dispatch
    await finish.promise
  })
  await submitting.promise
  const secondEntered = deferred(), secondFinish = deferred()
  const second = f.manager.withHostOperation(f.host, f.owner, async () => {
    secondEntered.resolve(); await secondFinish.promise
  })
  await secondEntered.promise
  expect(Object.keys(f.registry().hosts.host.leases)).toHaveLength(3)
  expect(await f.manager.releaseHostLeaseStrict('host', { ...f.owner, runId: 'other' })).toBe(false)
  expect(await f.manager.releaseHostLeaseStrict('host', f.owner)).toBe(true)
  await f.reap()
  expect(f.kills()).toBe(0)
  expect(Object.keys(f.registry().hosts.host.leases)).toHaveLength(2)
  resume.resolve()
  await transported.promise
  await f.reap()
  expect(f.kills()).toBe(0)
  finish.resolve(); await first
  secondFinish.resolve(); await second
  expect(f.registry().hosts.host.leases).toEqual({})
  expect(f.registry().hosts.host.cursorAgentReapContractVersion).toBeUndefined()
  await f.reap()
  expect(f.kills()).toBe(0)
})

test('ordinary completion preserves eligibility but never promotes old generations', async () => {
  for (const marked of [true, false]) {
    const f = fixture(marked)
    await f.manager.withHostOperation(f.host, f.owner, async () => 1)
    expect(Object.keys(f.registry().hosts.host.leases)).toEqual([f.key])
    expect(f.registry().hosts.host.cursorAgentReapContractVersion).toBe(marked ? 1 : undefined)
    await f.manager.releaseHostLeaseStrict('host', f.owner)
    await f.reap()
    expect(f.kills()).toBe(marked ? 1 : 0)
  }
})

test('missing admission evidence never invokes callback; callback failure revokes authority', async () => {
  const f = fixture()
  await f.manager.releaseHostLeaseStrict('host', f.owner)
  let dispatched = false
  await expect(f.manager.withHostOperation(f.host, f.owner, async () => { dispatched = true })).rejects.toThrow()
  expect(dispatched).toBe(false)
  await expect(f.manager.withHostOperation(f.host, null, async () => { throw new Error('transport uncertain') })).rejects.toThrow()
  expect(f.registry().hosts.host.cursorAgentReapContractVersion).toBeUndefined()
  expect(f.registry().hosts.host.leases).toEqual({})
})
