import { describe, expect, test } from 'bun:test'
import {
  coordinateStrictLaunch,
  type StrictAttemptIdentity,
  type StrictCommittedMember,
  type StrictHost,
  type StrictHostLease,
  type StrictLaunchPorts,
  type StrictLaunchRequest,
  type StrictLaunchScheduler,
  type StrictLaunchStatus,
  type StrictMaterializedMember,
  type StrictMember,
  type StrictPortResult,
  type StrictProof,
  type StrictProofRequest,
  type StrictResource,
} from './OpenCodeStrictLaunchCoordinator'

type Projection = {
  member: string
  source: 'existing' | 'new'
  nested: { label: string }
}

const identity = { attemptId: 'attempt-7', generation: 3 }
const lease = { leaseId: 'lease-7', expectedHostId: 'retained-host' }
const members: StrictMember[] = [
  { memberId: 'one', memberFingerprint: 'member-fp-one' },
  { memberId: 'two', memberFingerprint: 'member-fp-two' },
]

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function drain(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

async function drainUntil(ready: () => boolean): Promise<void> {
  for (let index = 0; index < 200 && !ready(); index += 1) await Promise.resolve()
  if (!ready()) throw new Error('expected transition was not reached')
}

class ManualScheduler implements StrictLaunchScheduler {
  time = 0
  private waits: Array<{
    deadline: number
    resolve: () => void
    reject: (error: Error) => void
    signal: AbortSignal
  }> = []

  now(): number { return this.time }

  waitUntil(deadline: number, signal: AbortSignal): Promise<void> {
    if (this.time >= deadline) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const wait = { deadline, resolve, reject, signal }
      this.waits.push(wait)
      signal.addEventListener('abort', () => reject(new Error('timer aborted')), { once: true })
    })
  }

  advanceTo(time: number): void {
    this.time = time
    const ready = this.waits.filter(wait => !wait.signal.aborted && wait.deadline <= time)
    this.waits = this.waits.filter(wait => !ready.includes(wait))
    for (const wait of ready) wait.resolve()
  }
}

function proof(overrides: Partial<StrictProof> = {}): StrictProof {
  return {
    ...identity,
    nonce: 'nonce-7',
    hostId: lease.expectedHostId,
    providerId: 'provider',
    modelId: 'model',
    behaviorFingerprint: 'behavior',
    mcpTools: ['tool-a', 'tool-b'],
    ...overrides,
  }
}

function resource(
  resourceId: string,
  committed: boolean,
  overrides: Partial<StrictAttemptIdentity> = {},
): StrictResource {
  return { ...identity, resourceId, committed, ...overrides }
}

function materialized(member: StrictMember): StrictMaterializedMember<Projection> {
  return {
    ...identity,
    ...member,
    behaviorFingerprint: 'behavior',
    projection: { member: member.memberId, source: 'new', nested: { label: member.memberId } },
    resource: resource(`resource-${member.memberId}`, true),
  }
}

function committed(member: StrictMember): StrictCommittedMember<Projection> {
  return {
    ...member,
    behaviorFingerprint: 'behavior',
    projection: { member: member.memberId, source: 'existing', nested: { label: member.memberId } },
  }
}

function request(
  scheduler: ManualScheduler,
  controller = new AbortController(),
): StrictLaunchRequest<string, string> {
  return {
    ...identity,
    nonce: 'nonce-7',
    providerId: 'provider',
    modelId: 'model',
    behaviorFingerprint: 'behavior',
    mcpTools: ['tool-a', 'tool-b'],
    members: members.map(member => ({ ...member })),
    workContext: 'work',
    cleanupContext: 'cleanup',
    hostLease: { ...lease },
    deadlineAt: 100,
    cleanupReserveMs: 20,
    signal: controller.signal,
    scheduler,
  }
}

class FakePorts implements StrictLaunchPorts<string, string, Projection> {
  events: string[] = []
  signals: AbortSignal[] = []
  proofResult: StrictPortResult<StrictProof> = { kind: 'ok', value: proof() }
  acquireResult: StrictPortResult<StrictHost> = {
    kind: 'ok', value: { hostId: lease.expectedHostId },
  }
  existing = new Map<string, StrictCommittedMember<Projection>>()
  materializeResults = new Map<string, StrictPortResult<StrictMaterializedMember<Projection>>>()
  releaseCalls: Array<{ lease: StrictHostLease; keepAlive: boolean; signal: AbortSignal }> = []
  cleanupCalls: Array<{
    resources: StrictResource[]
    signal: AbortSignal
    abortedAtCall: boolean
  }> = []

  snapshotProjection(projection: Projection): Projection {
    return { ...projection, nested: { ...projection.nested } }
  }

  async acquireHost(
    _context: string,
    _identity: StrictAttemptIdentity,
    hostLease: StrictHostLease,
    signal: AbortSignal,
  ): Promise<StrictPortResult<StrictHost>> {
    this.events.push(`acquire:${hostLease.leaseId}`)
    this.signals.push(signal)
    return this.acquireResult
  }

  async requestProof(
    _context: string,
    _host: StrictHost,
    _request: StrictProofRequest,
    signal: AbortSignal,
  ): Promise<StrictPortResult<StrictProof>> {
    this.events.push('proof')
    this.signals.push(signal)
    return this.proofResult
  }

  async findCommitted(
    _context: string,
    member: StrictMember,
    signal: AbortSignal,
  ): Promise<StrictPortResult<StrictCommittedMember<Projection> | null>> {
    this.events.push(`find:${member.memberId}`)
    this.signals.push(signal)
    return { kind: 'ok', value: this.existing.get(member.memberId) ?? null }
  }

  async projectCommitted(
    _context: string,
    member: StrictCommittedMember<Projection>,
    signal: AbortSignal,
  ): Promise<StrictPortResult<void>> {
    this.events.push(`project:${member.memberId}`)
    this.signals.push(signal)
    return { kind: 'ok', value: undefined }
  }

  async materialize(
    _context: string,
    _host: StrictHost,
    member: StrictMember,
    _identity: StrictAttemptIdentity,
    signal: AbortSignal,
  ): Promise<StrictPortResult<StrictMaterializedMember<Projection>>> {
    this.events.push(`materialize:${member.memberId}`)
    this.signals.push(signal)
    return this.materializeResults.get(member.memberId) ?? {
      kind: 'ok', value: materialized(member),
    }
  }

  async cleanup(
    _context: string,
    resources: StrictResource[],
    signal: AbortSignal,
  ): Promise<void> {
    this.events.push('cleanup')
    this.cleanupCalls.push({ resources, signal, abortedAtCall: signal.aborted })
    this.signals.push(signal)
  }

  async releaseHost(
    _context: string,
    hostLease: StrictHostLease,
    keepAlive: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    this.events.push('release')
    this.releaseCalls.push({ lease: hostLease, keepAlive, signal })
    this.signals.push(signal)
  }
}

describe('strict launch invariants', () => {
  test('launches only after exact proof and preserves a retained host for commits', async () => {
    const scheduler = new ManualScheduler()
    const ports = new FakePorts()
    ports.existing.set('one', committed(members[0]!))

    const result = await coordinateStrictLaunch(request(scheduler), ports)

    expect(result).toEqual({
      status: 'committed',
      committedMemberIds: ['one', 'two'],
      projections: [
        { member: 'one', source: 'existing', nested: { label: 'one' } },
        { member: 'two', source: 'new', nested: { label: 'two' } },
      ],
    })
    expect(ports.events).toEqual([
      'acquire:lease-7', 'proof', 'find:one', 'project:one',
      'find:two', 'materialize:two', 'cleanup', 'release',
    ])
    expect(ports.releaseCalls).toHaveLength(1)
    expect(ports.releaseCalls[0]?.keepAlive).toBe(true)
    expect(ports.signals.every(signal => signal instanceof AbortSignal)).toBe(true)
  })

  test('does not reuse a committed member bound to an older behavior digest', async () => {
    const scheduler = new ManualScheduler()
    const ports = new FakePorts()
    ports.existing.set('one', {
      ...committed(members[0]!),
      behaviorFingerprint: 'older-behavior',
    })

    const result = await coordinateStrictLaunch(request(scheduler), ports)

    expect(result.status).toBe('stale-result')
    expect(result.committedMemberIds).toEqual([])
    expect(ports.events).not.toContain('project:one')
    expect(ports.events).not.toContain('materialize:one')
  })

  test('invalid proof starts zero member operations and releases the host', async () => {
    const scheduler = new ManualScheduler()
    const ports = new FakePorts()
    ports.proofResult = { kind: 'ok', value: proof({ nonce: 'wrong' }) }

    const result = await coordinateStrictLaunch(request(scheduler), ports)

    expect(result.status).toBe('invalid-proof')
    expect(ports.events.some(event => event.startsWith('find:'))).toBe(false)
    expect(ports.releaseCalls[0]?.keepAlive).toBe(false)
  })

  for (const [label, override, expectedStatus] of [
    ['provider', { providerId: 'wrong' }, 'invalid-proof'],
    ['model', { modelId: 'wrong' }, 'invalid-proof'],
    ['host', { hostId: 'wrong' }, 'invalid-proof'],
    ['fingerprint', { behaviorFingerprint: 'wrong' }, 'invalid-proof'],
    ['attempt', { attemptId: 'wrong' }, 'stale-result'],
    ['generation', { generation: 99 }, 'stale-result'],
  ] as const) {
    test(`rejects proof with invalid ${label}`, async () => {
      const scheduler = new ManualScheduler()
      const ports = new FakePorts()
      ports.proofResult = { kind: 'ok', value: proof(override) }

      const result = await coordinateStrictLaunch(request(scheduler), ports)

      expect(result.status).toBe(expectedStatus)
      expect(ports.events.some(event => event.startsWith('find:'))).toBe(false)
      expect(ports.releaseCalls[0]?.keepAlive).toBe(false)
    })
  }

  test('rejects an acquired host outside the caller lease', async () => {
    const scheduler = new ManualScheduler()
    const ports = new FakePorts()
    ports.acquireResult = { kind: 'ok', value: { hostId: 'other-host' } }

    const result = await coordinateStrictLaunch(request(scheduler), ports)

    expect(result.status).toBe('stale-result')
    expect(ports.events).toEqual(['acquire:lease-7', 'cleanup', 'release'])
    expect(ports.releaseCalls[0]?.keepAlive).toBe(false)
  })

  test('known partial failure cleans only owned uncommitted resources', async () => {
    const scheduler = new ManualScheduler()
    const ports = new FakePorts()
    ports.materializeResults.set('two', {
      kind: 'failure',
      error: 'rejected',
      resources: [
        resource('owned', false), resource('committed', true),
        resource('foreign', false, { attemptId: 'other' }),
      ],
    })

    const result = await coordinateStrictLaunch(request(scheduler), ports)

    expect(result.status).toBe('failure')
    expect(result.committedMemberIds).toEqual(['one'])
    expect(ports.cleanupCalls[0]?.resources).toEqual([resource('owned', false)])
    expect(ports.releaseCalls[0]?.keepAlive).toBe(true)
  })
})

describe('absolute deadline, cancellation, and observation', () => {
  test('a proof which ignores abort cannot consume cleanup reserve or hang', async () => {
    const scheduler = new ManualScheduler()
    const ports = new FakePorts()
    const late = deferred<StrictPortResult<StrictProof>>()
    let proofSignal: AbortSignal | undefined
    ports.requestProof = async (_context, _host, _proof, signal) => {
      proofSignal = signal
      return late.promise
    }

    const running = coordinateStrictLaunch(request(scheduler), ports)
    await drain()
    scheduler.advanceTo(80)
    await drain()
    const result = await running

    expect(result).toMatchObject({ status: 'stopped', reason: 'deadline' })
    expect(proofSignal?.aborted).toBe(true)
    expect(ports.events).not.toContain('find:one')
    expect(ports.cleanupCalls).toHaveLength(1)
    expect(ports.releaseCalls).toHaveLength(1)

    late.reject(new Error('late proof rejection'))
    await drain()
  })

  test('a hung materialization is uncertain and preserves the lease', async () => {
    const scheduler = new ManualScheduler()
    const ports = new FakePorts()
    const late = deferred<StrictPortResult<StrictMaterializedMember<Projection>>>()
    let materializeSignal: AbortSignal | undefined
    ports.materialize = async (_context, _host, _member, _identity, signal) => {
      materializeSignal = signal
      return late.promise
    }

    const running = coordinateStrictLaunch(request(scheduler), ports)
    await drainUntil(() => materializeSignal !== undefined)
    scheduler.advanceTo(80)
    const result = await running

    expect(result.status).toBe('stopped')
    expect(ports.releaseCalls[0]?.keepAlive).toBe(true)
    late.resolve({ kind: 'ok', value: materialized(members[0]!) })
    await drain()
    expect(result.committedMemberIds).toEqual([])
  })

  test('external cancellation races a hung lookup and cleanup still gets reserve', async () => {
    const scheduler = new ManualScheduler()
    const controller = new AbortController()
    const ports = new FakePorts()
    const lookup = deferred<StrictPortResult<StrictCommittedMember<Projection> | null>>()
    let lookupSignal: AbortSignal | undefined
    ports.findCommitted = async (_context, _member, signal) => {
      lookupSignal = signal
      return lookup.promise
    }

    const running = coordinateStrictLaunch(request(scheduler, controller), ports)
    await drainUntil(() => lookupSignal !== undefined)
    controller.abort()
    const result = await running

    expect(result).toMatchObject({ status: 'stopped', reason: 'cancelled' })
    expect(lookupSignal?.aborted).toBe(true)
    expect(ports.cleanupCalls[0]?.abortedAtCall).toBe(false)
    expect(ports.releaseCalls).toHaveLength(1)
    lookup.reject(new Error('late lookup rejection'))
    await drain()
  })

  test('cleanup cannot block release past the absolute deadline', async () => {
    const scheduler = new ManualScheduler()
    const ports = new FakePorts()
    const cleanup = deferred<void>()
    let cleanupSignal: AbortSignal | undefined
    ports.acquireResult = { kind: 'failure', error: 'no host' }
    ports.cleanup = async (_context, _resources, signal) => {
      cleanupSignal = signal
      return cleanup.promise
    }

    const running = coordinateStrictLaunch(request(scheduler), ports)
    await drain()
    expect(ports.releaseCalls).toHaveLength(0)
    scheduler.advanceTo(100)
    const result = await running

    expect(result.status).toBe('failure')
    expect(cleanupSignal?.aborted).toBe(true)
    expect(ports.releaseCalls).toHaveLength(1)
    expect(ports.releaseCalls[0]?.signal.aborted).toBe(true)
    cleanup.reject(new Error('late cleanup rejection'))
    await drain()
  })

  test('release itself cannot hang the coordinator', async () => {
    const scheduler = new ManualScheduler()
    const ports = new FakePorts()
    const release = deferred<void>()
    let releaseSignal: AbortSignal | undefined
    ports.acquireResult = { kind: 'failure', error: 'no host' }
    ports.releaseHost = async (_context, _lease, _keepAlive, signal) => {
      releaseSignal = signal
      return release.promise
    }

    const running = coordinateStrictLaunch(request(scheduler), ports)
    await drain()
    scheduler.advanceTo(100)
    const result = await running

    expect(result.status).toBe('failure')
    expect(releaseSignal?.aborted).toBe(true)
    release.resolve()
    await drain()
  })

  test('deadline immediately before work performs no acquisition', async () => {
    const scheduler = new ManualScheduler()
    scheduler.advanceTo(80)
    const ports = new FakePorts()

    const result = await coordinateStrictLaunch(request(scheduler), ports)

    expect(result).toMatchObject({ status: 'stopped', reason: 'deadline' })
    expect(ports.events).toEqual(['cleanup'])
  })

  test('cancellation immediately before work performs no acquisition', async () => {
    const scheduler = new ManualScheduler()
    const controller = new AbortController()
    const ports = new FakePorts()
    controller.abort()

    const result = await coordinateStrictLaunch(request(scheduler, controller), ports)

    expect(result).toMatchObject({ status: 'stopped', reason: 'cancelled' })
    expect(ports.events).toEqual(['cleanup'])
  })

  test('cancellation after acquire prevents proof and releases exactly once', async () => {
    const scheduler = new ManualScheduler()
    const controller = new AbortController()
    const ports = new FakePorts()
    ports.acquireHost = async () => {
      controller.abort()
      return { kind: 'ok', value: { hostId: lease.expectedHostId } }
    }

    const result = await coordinateStrictLaunch(request(scheduler, controller), ports)

    expect(result).toMatchObject({ status: 'stopped', reason: 'cancelled' })
    expect(ports.events).not.toContain('proof')
    expect(ports.releaseCalls).toHaveLength(1)
  })

  test('cancellation after proof prevents lookup', async () => {
    const scheduler = new ManualScheduler()
    const controller = new AbortController()
    const ports = new FakePorts()
    ports.requestProof = async () => {
      controller.abort()
      return { kind: 'ok', value: proof() }
    }

    const result = await coordinateStrictLaunch(request(scheduler, controller), ports)

    expect(result.status).toBe('stopped')
    expect(ports.events.some(event => event.startsWith('find:'))).toBe(false)
  })

  test('cancellation after lookup prevents project and materialize', async () => {
    const scheduler = new ManualScheduler()
    const controller = new AbortController()
    const ports = new FakePorts()
    ports.existing.set('one', committed(members[0]!))
    ports.findCommitted = async (_context, member) => {
      controller.abort()
      return { kind: 'ok', value: ports.existing.get(member.memberId) ?? null }
    }

    const result = await coordinateStrictLaunch(request(scheduler, controller), ports)

    expect(result.status).toBe('stopped')
    expect(ports.events.some(event => event.startsWith('project:'))).toBe(false)
    expect(ports.events.some(event => event.startsWith('materialize:'))).toBe(false)
  })

  test('cancellation after projection prevents the next member', async () => {
    const scheduler = new ManualScheduler()
    const controller = new AbortController()
    const ports = new FakePorts()
    ports.existing.set('one', committed(members[0]!))
    ports.projectCommitted = async () => {
      controller.abort()
      return { kind: 'ok', value: undefined }
    }

    const result = await coordinateStrictLaunch(request(scheduler, controller), ports)

    expect(result.status).toBe('stopped')
    expect(result.committedMemberIds).toEqual(['one'])
    expect(ports.events).not.toContain('find:two')
  })

  test('cancellation after materialize preserves that commit and stops the next', async () => {
    const scheduler = new ManualScheduler()
    const controller = new AbortController()
    const ports = new FakePorts()
    ports.materialize = async (_context, _host, member) => {
      controller.abort()
      return { kind: 'ok', value: materialized(member) }
    }

    const result = await coordinateStrictLaunch(request(scheduler, controller), ports)

    // Cancellation wins the race; the irreversible call is treated as uncertain,
    // so its late acknowledgement is deliberately not adopted.
    expect(result.status).toBe('stopped')
    expect(result.committedMemberIds).toEqual([])
    expect(ports.releaseCalls[0]?.keepAlive).toBe(true)
    expect(ports.events).not.toContain('find:two')
  })

  test('deadline checks run after every operational transition', async () => {
    const cases = ['acquire', 'proof', 'find', 'project', 'materialize'] as const
    for (const transition of cases) {
      const scheduler = new ManualScheduler()
      const ports = new FakePorts()
      if (transition === 'project') ports.existing.set('one', committed(members[0]!))
      const advance = () => scheduler.advanceTo(80)
      if (transition === 'acquire') {
        ports.acquireHost = async () => {
          advance()
          return { kind: 'ok', value: { hostId: lease.expectedHostId } }
        }
      } else if (transition === 'proof') {
        ports.requestProof = async () => { advance(); return { kind: 'ok', value: proof() } }
      } else if (transition === 'find') {
        ports.findCommitted = async () => { advance(); return { kind: 'ok', value: null } }
      } else if (transition === 'project') {
        ports.projectCommitted = async () => { advance(); return { kind: 'ok', value: undefined } }
      } else {
        ports.materialize = async (_context, _host, member) => {
          advance()
          return { kind: 'ok', value: materialized(member) }
        }
      }

      const result = await coordinateStrictLaunch(request(scheduler), ports)

      expect(result.status).toBe('stopped')
      expect(result.reason).toBe('deadline')
      expect(ports.releaseCalls).toHaveLength(1)
    }
  })
})

describe('immutable snapshots and uncertain leases', () => {
  test('caller mutation during acquisition cannot alter proof or member expectations', async () => {
    const scheduler = new ManualScheduler()
    const ports = new FakePorts()
    const mutable = request(scheduler)
    let receivedProof: StrictProofRequest | undefined
    ports.acquireHost = async () => {
      mutable.attemptId = 'mutated'
      mutable.generation = 99
      mutable.nonce = 'mutated'
      mutable.providerId = 'mutated'
      mutable.modelId = 'mutated'
      mutable.behaviorFingerprint = 'mutated'
      mutable.mcpTools.splice(0, 2, 'mutated')
      mutable.members[0]!.memberId = 'mutated'
      mutable.hostLease.expectedHostId = 'mutated'
      return { kind: 'ok', value: { hostId: lease.expectedHostId } }
    }
    ports.requestProof = async (_context, _host, challenge) => {
      receivedProof = challenge
      return { kind: 'ok', value: proof() }
    }

    const result = await coordinateStrictLaunch(mutable, ports)

    expect(result.status).toBe('committed')
    expect(receivedProof).toEqual({
      ...identity,
      nonce: 'nonce-7', expectedHostId: 'retained-host', providerId: 'provider',
      modelId: 'model', behaviorFingerprint: 'behavior',
      mcpTools: ['tool-a', 'tool-b'],
    })
    expect(result.committedMemberIds).toEqual(['one', 'two'])
    expect(ports.releaseCalls[0]?.lease).toEqual(lease)
  })

  test('unknown acquisition releases the caller lease exactly once without a host', async () => {
    for (const mode of ['throw', 'return'] as const) {
      const scheduler = new ManualScheduler()
      const ports = new FakePorts()
      ports.acquireHost = async () => {
        if (mode === 'throw') throw new Error('ack lost')
        return { kind: 'unknown', error: 'ack lost' }
      }

      const result = await coordinateStrictLaunch(request(scheduler), ports)

      expect(result).toMatchObject({ status: 'unknown', reason: 'ack lost' })
      expect(ports.releaseCalls).toHaveLength(1)
      expect(ports.releaseCalls[0]).toMatchObject({ lease, keepAlive: true })
    }
  })

  test('unknown materialization is never retried, is not cleaned, and keeps lease alive', async () => {
    const scheduler = new ManualScheduler()
    const ports = new FakePorts()
    let calls = 0
    ports.materialize = async () => {
      calls += 1
      return {
        kind: 'unknown', error: 'ack lost',
        resources: [resource('possibly-committed', false)],
      }
    }

    const result = await coordinateStrictLaunch(request(scheduler), ports)

    expect(result.status).toBe('unknown')
    expect(calls).toBe(1)
    expect(ports.cleanupCalls[0]?.resources).toEqual([])
    expect(ports.releaseCalls[0]?.keepAlive).toBe(true)
  })

  test('throwing snapshot for an existing commit is unknown and preserves the commit', async () => {
    const scheduler = new ManualScheduler()
    const ports = new FakePorts()
    ports.existing.set('one', committed(members[0]!))
    ports.snapshotProjection = () => { throw new Error('snapshot failed') }

    const result = await coordinateStrictLaunch(request(scheduler), ports)

    expect(result).toMatchObject({
      status: 'unknown', reason: 'snapshot failed', committedMemberIds: ['one'],
    })
    expect(ports.releaseCalls[0]?.keepAlive).toBe(true)
    expect(ports.events).not.toContain('find:two')
    expect(ports.cleanupCalls[0]?.resources).toEqual([])
  })

  test('throwing snapshot for a materialized commit is unknown and preserves the commit', async () => {
    const scheduler = new ManualScheduler()
    const ports = new FakePorts()
    ports.snapshotProjection = () => { throw new Error('snapshot failed') }

    const result = await coordinateStrictLaunch(request(scheduler), ports)

    expect(result).toMatchObject({
      status: 'unknown', reason: 'snapshot failed', committedMemberIds: ['one'],
    })
    expect(ports.releaseCalls[0]?.keepAlive).toBe(true)
    expect(ports.events).not.toContain('find:two')
    expect(ports.cleanupCalls[0]?.resources).toEqual([])
  })

  test('immediate microtask cancellation never invokes acquisition', async () => {
    const scheduler = new ManualScheduler()
    const controller = new AbortController()
    const ports = new FakePorts()

    const running = coordinateStrictLaunch(request(scheduler, controller), ports)
    controller.abort()
    const result = await running

    expect(result).toMatchObject({ status: 'stopped', reason: 'cancelled' })
    expect(ports.events).toEqual(['cleanup', 'release'])
    expect(ports.releaseCalls[0]?.keepAlive).toBe(false)
  })

  test('cancelled in-flight acquisition keeps its lease through late success and rejection', async () => {
    for (const mode of ['success', 'reject'] as const) {
      const scheduler = new ManualScheduler()
      const controller = new AbortController()
      const ports = new FakePorts()
      const late = deferred<StrictPortResult<StrictHost>>()
      let acquireSignal: AbortSignal | undefined
      ports.acquireHost = async (_context, _identity, _lease, signal) => {
        acquireSignal = signal
        return late.promise
      }

      const running = coordinateStrictLaunch(request(scheduler, controller), ports)
      await drainUntil(() => acquireSignal !== undefined)
      controller.abort()
      const result = await running

      expect(result.status).toBe('stopped')
      expect(acquireSignal?.aborted).toBe(true)
      expect(ports.releaseCalls[0]?.keepAlive).toBe(true)
      if (mode === 'success') late.resolve({ kind: 'ok', value: { hostId: lease.expectedHostId } })
      else late.reject(new Error('late acquire rejection'))
      await drain()
    }
  })

  test('scheduler callables are snapshotted before caller mutation', async () => {
    const scheduler = new ManualScheduler()
    const ports = new FakePorts()
    const running = coordinateStrictLaunch(request(scheduler), ports)
    scheduler.now = () => -1
    scheduler.waitUntil = () => new Promise(() => {})

    scheduler.advanceTo(80)
    const result = await running

    expect(result).toMatchObject({ status: 'stopped', reason: 'deadline' })
    expect(ports.events).toEqual(['acquire:lease-7', 'cleanup', 'release'])
    expect(ports.events).not.toContain('proof')
  })

  test('nested projection publication is detached from ports and original results', async () => {
    const scheduler = new ManualScheduler()
    const ports = new FakePorts()
    const mutable = committed(members[0]!)
    const projection = mutable.projection
    const projected = deferred<StrictPortResult<void>>()
    let received: StrictCommittedMember<Projection> | undefined
    ports.existing.set('one', mutable)
    const acquireHost = ports.acquireHost.bind(ports)
    ports.acquireHost = async (...args) => {
      const acquired = await acquireHost(...args)
      ports.snapshotProjection = () => { throw new Error('late seam replacement') }
      return acquired
    }
    ports.projectCommitted = async (_context, member) => {
      received = member
      member.projection.nested.label = 'project-mutated'
      return projected.promise
    }
    const input = request(scheduler)
    input.members = [members[0]!]

    const running = coordinateStrictLaunch(input, ports)
    await drainUntil(() => received !== undefined)
    mutable.memberId = 'mutated'
    mutable.memberFingerprint = 'mutated'
    projection.nested.label = 'original-mutated'
    mutable.projection = {
      member: 'mutated', source: 'existing', nested: { label: 'replacement' },
    }
    projected.resolve({ kind: 'ok', value: undefined })
    const result = await running

    expect(Object.isFrozen(received)).toBe(true)
    expect(received).toEqual({
      ...members[0]!,
      behaviorFingerprint: 'behavior',
      projection: { member: 'one', source: 'existing', nested: { label: 'project-mutated' } },
    })
    expect(result.projections).toEqual([
      { member: 'one', source: 'existing', nested: { label: 'one' } },
    ])
    expect(result.projections[0]).not.toBe(projection)
    expect(result.projections[0]).not.toBe(received?.projection)
    expect(result.committedMemberIds).toEqual(['one'])

    const materializeScheduler = new ManualScheduler()
    const materializePorts = new FakePorts()
    const created = materialized(members[0]!)
    materializePorts.materialize = async () => ({ kind: 'ok', value: created })
    materializePorts.cleanup = async () => { created.projection.nested.label = 'cleanup-mutated' }
    const materializeInput = request(materializeScheduler)
    materializeInput.members = [members[0]!]

    const materializedResult = await coordinateStrictLaunch(materializeInput, materializePorts)

    expect(materializedResult.projections).toEqual([
      { member: 'one', source: 'new', nested: { label: 'one' } },
    ])
    expect(materializedResult.projections[0]).not.toBe(created.projection)
  })

  test('owned committed resources in failures and stale returns are irreversible', async () => {
    const failureScheduler = new ManualScheduler()
    const failurePorts = new FakePorts()
    failurePorts.acquireResult = {
      kind: 'failure', error: 'partial',
      resources: [resource('committed', true), resource('uncommitted', false)],
    }
    await coordinateStrictLaunch(request(failureScheduler), failurePorts)
    expect(failurePorts.cleanupCalls[0]?.resources).toEqual([resource('uncommitted', false)])
    expect(failurePorts.releaseCalls[0]?.keepAlive).toBe(true)

    const staleScheduler = new ManualScheduler()
    const stalePorts = new FakePorts()
    stalePorts.materialize = async (_context, _host, member) => ({
      kind: 'ok', value: { ...materialized(member), memberFingerprint: 'stale' },
    })
    const input = request(staleScheduler)
    input.members = [members[0]!]
    const stale = await coordinateStrictLaunch(input, stalePorts)
    expect(stale.status).toBe('stale-result')
    expect(stalePorts.cleanupCalls[0]?.resources).toEqual([])
    expect(stalePorts.releaseCalls[0]?.keepAlive).toBe(true)
  })
})

describe('compile-visible contract', () => {
  test('materialized members carry attempt identity and failure uses one literal', () => {
    const valid: StrictMaterializedMember<Projection> = materialized(members[0]!)
    const status: StrictLaunchStatus = 'failure'
    expect(valid.attemptId).toBe(identity.attemptId)
    expect(status).toBe('failure')

    // @ts-expect-error StrictMaterializedMember requires StrictAttemptIdentity.
    const invalid: StrictMaterializedMember<Projection> = {
      ...members[0]!,
      projection: { member: 'one', source: 'new', nested: { label: 'one' } },
      resource: resource('one', true),
    }
    // @ts-expect-error The inconsistent legacy literal is intentionally rejected.
    const legacy: StrictLaunchStatus = 'failed'
    expect(invalid).toBeDefined()
    expect(legacy).toBeDefined()
  })
})
