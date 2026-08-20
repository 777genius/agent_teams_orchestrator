import { describe, expect, test } from 'bun:test'

import {
  AtomicFakeFileSystem,
  Barrier,
  PortableOpenCodeAcceptanceHarness,
  canonicalBytes,
  createTrapPorts,
  proofFor,
  selectionFor,
  validateLedger,
} from './PortableOpenCodeAcceptanceHarness.js'

import type { MemberCapability, Proof, Selection, UnsafeVariant } from './PortableOpenCodeAcceptanceHarness.js'

async function scenario(
  run: (harness: PortableOpenCodeAcceptanceHarness, ports: ReturnType<typeof createTrapPorts>) => Promise<void> | void,
  variant?: UnsafeVariant,
): Promise<void> {
  const ports = createTrapPorts()
  const harness = await PortableOpenCodeAcceptanceHarness.create({ ports, variant })
  try {
    await run(harness, ports)
  } finally {
    await harness.cleanup()
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function observe<T>(promise: Promise<T>): Promise<'pending' | 'fulfilled' | 'rejected'> {
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending'
  void promise.then(() => { state = 'fulfilled' }, () => { state = 'rejected' })
  await flush()
  return state
}

function denialMutations(selection: Selection): Array<{ proof: Proof; nonce: string; label: string }> {
  const mutations: Array<keyof Selection> = [
    'project', 'provider', 'model', 'profile', 'config', 'auth', 'binary', 'plugin', 'cacheGeneration', 'mcp',
  ]
  const result = mutations.map(field => {
    const proof = proofFor(selection)
    if (field === 'provider') proof.provider = 'kiro'
    else if (field === 'cacheGeneration') proof.cacheGeneration += 1
    else (proof as unknown as Record<string, unknown>)[field] = `${selection[field]}-mutated`
    return { proof, nonce: 'raw-nonce', label: field }
  })
  result.push({ proof: { ...proofFor(selection), appMcp: false as true }, nonce: 'raw-nonce', label: 'MCP' })
  result.push({ proof: proofFor(selection, 'raw-nonce-mutated'), nonce: 'raw-nonce', label: 'raw nonce' })
  return result
}

/** One parameterized contract is also run against deliberately unsafe coordinators below. */
async function runCommonAcceptanceContract(variant?: UnsafeVariant): Promise<void> {
  await scenario(async (harness, ports) => {
    const selection = selectionFor(harness.projects.primary)
    const profileHang = ports.hang('profile')
    const lockHang = ports.hang('lock')
    const writeHang = ports.hang('write')
    ports.hang('cli:kiro')
    ports.hang('plugin:kiro')

    await harness.adapter.catalog(selection, ['model-a'])
    const status = await harness.adapter.status(selection)
    if (status.state !== 'fresh') throw new Error('constant status route did not observe durable catalog')
    if (ports.calls.some(call => call.purpose === 'status')) throw new Error('passive status reached a mutating/hanging port')
    profileHang.resolve(); lockHang.resolve(); writeHang.resolve()

    const collisionProof = proofFor({ ...selection, model: 'left', profile: 'right|tail' })
    const collisionSelection = { ...selection, model: 'left|right', profile: 'tail' }
    await harness.adapter.catalog(collisionSelection, ['collision-model'])
    const collision = await harness.adapter.launch(collisionSelection, collisionProof, 'raw-nonce')
    if (collision.ok || collision.capability !== null) throw new Error('structured proof identity accepted delimiter collision')

    const denied = await harness.adapter.launch(selection, proofFor({ ...selection, auth: 'wrong-auth' }), 'raw-nonce')
    if (denied.ok || denied.capability !== null) throw new Error('proof denial leaked a member/host capability')
    const membersBefore = harness.ledger.events.filter(event => event.effect === 'member').length
    try { await harness.createMembers(denied.capability, [1]) } catch {}
    if (harness.ledger.events.filter(event => event.effect === 'member').length !== membersBefore) throw new Error('denied capability created members')
    if (ports.processes.alive.size !== 0) throw new Error('denied proof retained a host process')

    ports.fs.corrupt(`${harness.sandboxPath}/state/coordinator.json`)
    const restarted = harness.restart()
    if ((await restarted.adapter.status(selection)).state !== 'unknown') throw new Error('restart reused shared maps instead of parsing durable bytes')

    const root = ports.processes.spawn(null)
    const child = ports.processes.spawn(root)
    const grandchild = ports.processes.spawn(child, true)
    restarted.cleanupTree(root)
    if ([root, child, grandchild].some(pid => ports.processes.alive.has(pid))) throw new Error('cleanup only logged; process tree remains alive')

    const retry = restarted.retryCatalog(selection, 100, 10)
    await flush()
    ports.scheduler.advanceTo(90)
    await retry
    if (ports.deferredCliAttempts[0]?.cancelCount !== 1 || !ports.deferredCliAttempts[0]?.cancelled) {
      throw new Error('deadline only logged cancellation; active operation retained authority')
    }
  }, variant)
}

describe('portable parameterized OpenCode acceptance contract', () => {
  test('three public purpose routes call injected ports and preserve status/catalog/launch command boundaries', async () => {
    await scenario(async (harness, ports) => {
      const selection = selectionFor(harness.projects.primary)
      const profileHang = ports.hang('profile')
      const lockHang = ports.hang('lock')
      const writeHang = ports.hang('write')
      ports.hang('cli:kiro')
      ports.hang('plugin:kiro')

      expect(await harness.adapter.status(selection)).toEqual({ state: 'unknown', generation: null })
      expect(ports.calls).toEqual([])
      const passiveBefore = {
        writes: ports.fs.writes.length,
        processes: ports.processes.alive.size,
        profile: ports.calls.filter(call => call.port === 'profile').length,
        lock: ports.calls.filter(call => call.port === 'lock').length,
        host: ports.calls.filter(call => call.port === 'host').length,
      }
      await harness.adapter.status(selection)
      expect({
        writes: ports.fs.writes.length,
        processes: ports.processes.alive.size,
        profile: ports.calls.filter(call => call.port === 'profile').length,
        lock: ports.calls.filter(call => call.port === 'lock').length,
        host: ports.calls.filter(call => call.port === 'host').length,
      }).toEqual(passiveBefore)
      await harness.adapter.catalog(selection, ['deepinfra/model'])
      expect(await harness.adapter.status(selection)).toEqual({ state: 'fresh', generation: 1 })
      expect(ports.calls).toEqual([{
        port: 'cli:deepinfra', purpose: 'catalog', provider: 'deepinfra', detail: 'models --provider deepinfra',
      }])
      profileHang.resolve(); lockHang.resolve(); writeHang.resolve()
      const launch = await harness.adapter.launch(selection, proofFor(selection), 'raw-nonce')
      expect(launch.ok).toBe(true)
      expect(ports.calls.map(call => call.port)).toEqual([
        'cli:deepinfra', 'profile', 'lock', 'write', 'plugin:deepinfra', 'host',
      ])
      expect(ports.calls.some(call => call.detail?.includes('--verbose') || call.detail?.includes('full'))).toBe(false)
      expect(ports.calls.some(call => call.detail?.includes('prewarm'))).toBe(false)
      expect(ports.calls.some(call => call.port === 'plugin:kiro' || call.port === 'plugin:cursor')).toBe(false)
      expect(harness.ledger.events.filter(event => event.effect === 'route').map(event => event.action)).toEqual([
        'status', 'status', 'catalog', 'status', 'launch',
      ])
    })
  })

  test('selected/unrelated provider CLI and plugin hangs are isolated behind the real ports', async () => {
    await scenario(async (harness, ports) => {
      const selection = selectionFor(harness.projects.primary)
      const kiroCli = ports.hang('cli:kiro')
      const cursorPlugin = ports.hang('plugin:cursor')
      await harness.adapter.catalog(selection, ['deepinfra/model'])
      const result = await harness.adapter.launch(selection, proofFor(selection), 'raw-nonce')
      expect(result.ok).toBe(true)
      expect(ports.calls.filter(call => call.provider !== 'deepinfra')).toEqual([])
      kiroCli.cancel(); cursorPlugin.cancel()
    })
  })

  test('selected catalog route stays pending at its callable CLI port and settles after release within the virtual deadline', async () => {
    await scenario(async (harness, ports) => {
      const selection = selectionFor(harness.projects.primary)
      const selected = ports.hang('cli:deepinfra')
      const kiro = ports.hang('cli:kiro')
      const cursor = ports.hang('plugin:cursor')
      let deadlineFired = false
      ports.scheduler.at(50, () => selected.resolve())
      ports.scheduler.at(100, () => { deadlineFired = true })
      const running = harness.adapter.catalog(selection, ['deepinfra/model'])
      expect(await observe(running)).toBe('pending')
      ports.scheduler.advanceTo(49)
      expect(await observe(running)).toBe('pending')
      ports.scheduler.advanceTo(50)
      await expect(running).resolves.toBeUndefined()
      expect(deadlineFired).toBe(false)
      expect(ports.calls.filter(call => call.provider !== 'deepinfra')).toEqual([])
      expect(kiro.cancelCount).toBe(0)
      expect(cursor.cancelCount).toBe(0)
    })
  })

  test('selected launch route stays pending at its callable plugin port and settles after release within the virtual deadline', async () => {
    await scenario(async (harness, ports) => {
      const selection = selectionFor(harness.projects.primary)
      await harness.adapter.catalog(selection, ['deepinfra/model'])
      const selected = ports.hang('plugin:deepinfra')
      const kiro = ports.hang('plugin:kiro')
      const cursor = ports.hang('cli:cursor')
      let deadlineFired = false
      ports.scheduler.at(70, () => selected.resolve())
      ports.scheduler.at(100, () => { deadlineFired = true })
      const running = harness.adapter.launch(selection, proofFor(selection), 'raw-nonce')
      expect(await observe(running)).toBe('pending')
      ports.scheduler.advanceTo(69)
      expect(await observe(running)).toBe('pending')
      ports.scheduler.advanceTo(70)
      await expect(running).resolves.toMatchObject({ ok: true })
      expect(deadlineFired).toBe(false)
      expect(ports.calls.filter(call => call.provider !== 'deepinfra')).toEqual([])
      expect(kiro.cancelCount).toBe(0)
      expect(cursor.cancelCount).toBe(0)
    })
  })

  test('proof denial returns no usable token, releases the host, and every identity mutation has zero member effects', async () => {
    await scenario(async (harness, ports) => {
      const selection = selectionFor(harness.projects.primary)
      await harness.adapter.catalog(selection, ['deepinfra/model'])
      for (const mutation of denialMutations(selection)) {
        const before = harness.ledger.events.filter(event => event.effect === 'member').length
        const result = await harness.adapter.launch(selection, mutation.proof, mutation.nonce)
        expect(result, mutation.label).toMatchObject({ ok: false, capability: null })
        await expect(harness.createMembers(result.capability, [1]), mutation.label).rejects.toThrow('proof-authorized')
        expect(harness.ledger.events.filter(event => event.effect === 'member')).toHaveLength(before)
      }
      expect(ports.processes.alive.size).toBe(0)
      expect(harness.ledger.events.filter(event => event.effect === 'proof' && !event.accepted)).toHaveLength(12)
      expect(harness.ledger.events.filter(event => event.effect === 'host' && event.action === 'release')).toHaveLength(12)
    })
  })

  test('opaque member authority rejects null and forged, copied, frozen, proxied, and prototype-shaped capabilities with zero effects', async () => {
    await scenario(async harness => {
      const selection = selectionFor(harness.projects.primary)
      await harness.adapter.catalog(selection, ['deepinfra/model'])
      const launch = await harness.adapter.launch(selection, proofFor(selection), 'raw-nonce')
      if (!launch.ok) throw new Error('fixture launch failed')
      const forged: Array<MemberCapability | null | undefined> = [
        null,
        undefined,
        {} as MemberCapability,
        { ...launch.capability } as MemberCapability,
        Object.freeze({}) as MemberCapability,
        new Proxy(launch.capability, {}),
        Object.create(launch.capability) as MemberCapability,
      ]
      const before = harness.ledger.events.filter(event => event.effect === 'member').length
      for (const candidate of forged) {
        await expect(harness.createMembers(candidate, [91])).rejects.toThrow('proof-authorized')
        expect(harness.ledger.events.filter(event => event.effect === 'member')).toHaveLength(before)
      }
    })
  })

  test('canonical structured bytes reject delimiter collisions and are sensitive to every launch field', () => {
    const selection = selectionFor('/sandbox/project')
    const baseline = canonicalBytes(selection)
    expect(canonicalBytes({ ...selection, model: 'left|right', profile: 'tail' }))
      .not.toEqual(canonicalBytes({ ...selection, model: 'left', profile: 'right|tail' }))
    for (const mutation of denialMutations(selection)) {
      const { nonce: _nonce, appMcp: _mcp, ...mutated } = mutation.proof
      if (mutation.label !== 'MCP' && mutation.label !== 'raw nonce') expect(canonicalBytes(mutated), mutation.label).not.toEqual(baseline)
    }
  })

  test('atomic bytes survive a wholly new coordinator; corruption fails closed; abrupt crash retains host ownership', async () => {
    await scenario(async (harness, ports) => {
      const selection = selectionFor(harness.projects.primary)
      await harness.adapter.catalog(selection, ['deepinfra/model'])
      const launch = await harness.adapter.launch(selection, proofFor(selection), 'raw-nonce')
      expect(launch.ok).toBe(true)
      if (!launch.ok) throw new Error('fixture launch failed')
      await harness.createMemberUntilRemote(launch.capability, 11)
      const liveBeforeCrash = [...ports.processes.alive]
      harness.crash()
      expect(ports.processes.alive).toEqual(new Set(liveBeforeCrash))
      const restarted = harness.restart()
      expect(await restarted.adapter.status(selection)).toEqual({ state: 'fresh', generation: 1 })
      expect(restarted.ledger.events).toContainEqual(expect.objectContaining({ effect: 'host', action: 'reconcile-retained', alive: true }))
      expect(ports.processes.alive).toEqual(new Set(liveBeforeCrash))
      expect(restarted.reconcileClaims()).toBe(1)
      expect(restarted.reconcileClaims()).toBe(0)
      expect(ports.calls.filter(call => call.port === 'remote-create' && call.detail === '11')).toHaveLength(1)
      expect(restarted.ledger.events.filter(event => event.effect === 'member' && event.action === 'reconcile')).toHaveLength(1)

      restarted.ports.fs.corrupt(`${harness.sandboxPath}/state/coordinator.json`)
      expect(await restarted.restart().adapter.status(selection)).toEqual({ state: 'unknown', generation: null })
    })
  })

  test('true Promise.all claim race uses a controlled barrier and remotely creates exactly once', async () => {
    await scenario(async (harness, ports) => {
      const selection = selectionFor(harness.projects.primary)
      await harness.adapter.catalog(selection, ['deepinfra/model'])
      const first = await harness.adapter.launch(selection, proofFor(selection), 'raw-nonce')
      const second = await harness.adapter.launch(selection, proofFor(selection), 'raw-nonce')
      if (!first.ok || !second.ok) throw new Error('fixture launch failed')
      const barrier = new Barrier(2)
      const results = await Promise.all([
        harness.createMembers(first.capability, [7], barrier),
        harness.createMembers(second.capability, [7], barrier),
      ])
      expect(barrier.arrivals).toBe(2)
      expect(results.flat()).toEqual([7])
      expect(ports.calls.filter(call => call.port === 'remote-create')).toHaveLength(1)
      expect(harness.ledger.events.filter(event => event.effect === 'member' && event.action === 'remote-create')).toHaveLength(1)
    })
  })

  test('supervisor proves PID liveness transitions, TERM-ignore escalation, and descendants cleanup', async () => {
    await scenario((harness, ports) => {
      const root = ports.processes.spawn(null)
      const child = ports.processes.spawn(root)
      const grandchild = ports.processes.spawn(child, true)
      expect(ports.processes.alive).toEqual(new Set([root, child, grandchild]))
      harness.cleanupTree(root)
      expect(ports.processes.alive.size).toBe(0)
      expect(harness.ledger.events).toContainEqual(expect.objectContaining({ action: 'TERM', pid: grandchild, alive: true }))
      expect(harness.ledger.events).toContainEqual(expect.objectContaining({ action: 'KILL', pid: grandchild, alive: false }))
    })
  })

  test('one monotonic absolute deadline drives actual retry cancellation, late suppression, and cleanup reserve', async () => {
    await scenario(async (harness, ports) => {
      const selection = selectionFor(harness.projects.primary)
      const running = harness.retryCatalog(selection, 100, 10)
      await flush()
      expect(ports.deferredCliAttempts).toHaveLength(1)
      ports.scheduler.advanceTo(30)
      ports.deferredCliAttempts[0]!.reject(new Error('transient'))
      await flush()
      expect(ports.deferredCliAttempts).toHaveLength(2)
      ports.scheduler.advanceTo(90)
      expect(await running).toEqual({ attempts: 2, timedOut: true })
      expect(ports.deferredCliAttempts[1]!.cancelled).toBe(true)
      expect(ports.deferredCliAttempts[1]!.cancelCount).toBe(1)
      ports.scheduler.advanceTo(99)
      ports.deferredCliAttempts[1]!.resolve()
      await flush()
      expect(ports.deferredCliAttempts[1]!.lateCompletionCount).toBe(1)
      expect(ports.calls.filter(call => call.detail === 'retry-catalog')).toHaveLength(2)
      expect(harness.ledger.events).toContainEqual(expect.objectContaining({ effect: 'deadline', action: 'cancel', at: 90, attempt: 2 }))
      expect(harness.ledger.events).toContainEqual(expect.objectContaining({ action: 'cleanup-reserve', at: 90 }))
      expect(harness.ledger.events).toContainEqual(expect.objectContaining({ action: 'late-completion-ignored', attempt: 2 }))
      expect(harness.ledger.events).not.toContainEqual(expect.objectContaining({ action: 'accepted-completion', attempt: 2 }))
      expect(ports.scheduler.now).toBe(99)
    })
  })

  test('externally observed ledger validates schema, populates effect dimensions, and redacts sentinel secrets and paths', async () => {
    await scenario(async harness => {
      const sentinels = [
        'SENTINEL-PROJECT-PATH', 'SENTINEL-MODEL', 'SENTINEL-PROFILE', 'SENTINEL-CONFIG',
        'SENTINEL-AUTH', 'SENTINEL-BINARY', 'SENTINEL-PLUGIN', 'SENTINEL-MCP', 'SENTINEL-NONCE',
      ]
      const selection = selectionFor(`${harness.projects.primary}/${sentinels[0]}`, {
        model: sentinels[1], profile: sentinels[2], config: sentinels[3], auth: sentinels[4],
        binary: sentinels[5], plugin: sentinels[6], mcp: sentinels[7],
      })
      await harness.adapter.catalog(selection, ['model'])
      const launch = await harness.adapter.launch(selection, proofFor(selection, sentinels[8]), sentinels[8])
      if (!launch.ok) throw new Error('fixture launch failed')
      await harness.createMembers(launch.capability, [1])
      const root = harness.ports.processes.spawn(null, true)
      harness.cleanupTree(root)
      const bytes = harness.machineLedgerBytes()
      const json = new TextDecoder().decode(bytes)
      const observed = JSON.parse(json)
      validateLedger(observed)
      for (const sentinel of sentinels) expect(json).not.toContain(sentinel)
      const effects = new Set(observed.events.map((event: { effect: string }) => event.effect))
      for (const effect of ['route', 'cli', 'persistence', 'profile', 'lock', 'write', 'plugin', 'host', 'proof', 'member', 'process']) {
        expect(effects.has(effect), effect).toBe(true)
      }
    })
  })

  test('ledger validator rejects unknown fields, malformed enums/types/hashes, nonsequential IDs, and oversized collections', () => {
    const valid = {
      schema: 1,
      events: [{
        seq: 1,
        purpose: 'status',
        effect: 'route',
        action: 'status',
        projectHash: `h:${'a'.repeat(64)}`,
        provider: 'deepinfra',
      }],
    }
    expect(() => validateLedger(structuredClone(valid))).not.toThrow()
    const mutations: unknown[] = [
      { ...valid, extra: true },
      { ...valid, schema: '1' },
      { ...valid, events: 'not-an-array' },
      { ...valid, events: [{ ...valid.events[0], extra: true }] },
      { ...valid, events: [{ ...valid.events[0], seq: 2 }] },
      { ...valid, events: [{ ...valid.events[0], purpose: 'prepare' }] },
      { ...valid, events: [{ ...valid.events[0], effect: 'network' }] },
      { ...valid, events: [{ ...valid.events[0], action: 'arbitrary' }] },
      { ...valid, events: [{ ...valid.events[0], action: 7 }] },
      { ...valid, events: [{ ...valid.events[0], projectHash: 'h:abc' }] },
      { ...valid, events: [{ ...valid.events[0], projectHash: `h:${'G'.repeat(64)}` }] },
      { ...valid, events: [{ ...valid.events[0], provider: 'openrouter' }] },
      { ...valid, events: [{ ...valid.events[0], pid: -1 }] },
      { ...valid, events: [{ ...valid.events[0], accepted: 'true' }] },
      { ...valid, events: Array.from({ length: 10_001 }, (_, index) => ({ ...valid.events[0], seq: index + 1 })) },
    ]
    for (const mutation of mutations) expect(() => validateLedger(mutation)).toThrow()
  })

  test('safe callable-port adapter satisfies the common acceptance contract', async () => {
    await expect(runCommonAcceptanceContract()).resolves.toBeUndefined()
  })

  for (const variant of [
    'constant-status', 'proof-leaking-host', 'delimiter-collision', 'shared-map-restart', 'log-only-cleanup', 'log-only-cancel',
  ] as const) {
    test(`mutation sensitivity: ${variant} fails the same acceptance contract`, async () => {
      await expect(runCommonAcceptanceContract(variant)).rejects.toThrow()
    })
  }

  test('atomic fake filesystem serializes bytes rather than sharing maps', () => {
    const fs = new AtomicFakeFileSystem()
    fs.atomicWrite('/state', new TextEncoder().encode('{"generation":1}'))
    const rebooted = fs.rebootedDevice()
    const bytes = rebooted.read('/state')!
    bytes[0] = 0
    expect(new TextDecoder().decode(rebooted.read('/state')!)).toBe('{"generation":1}')
    expect(fs.writes).toEqual([{ pathHash: expect.stringMatching(/^h:/), bytes: 16 }])
  })
})
