import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { OpenCodeLaunchAttempt, OpenCodeOperationHostAcquisitionCleanupError,
  OpenCodeOperationHostAcquisitionSettledError,
  validateOpenCodeLaunchResponseRoster,
  type OpenCodeLaunchAttemptPorts } from './OpenCodeLaunchAttempt.js'
import { projectOpenCodeLaunchAttemptResponse } from './OpenCodeLaunchAttemptProduction.js'
import { decodeOpenCodeLaunchAttemptResponse } from './OpenCodeBridgeContractV2.js'
import {
  OpenCodeLaunchAttemptStore,
  deriveOpenCodeLaunchNamespacePaths,
  OpenCodeLaunchFileJournalPersistence,
  OpenCodeLaunchPoisonedLeaseError,
  type OpenCodeLaunchJournalPersistence,
  type OpenCodeLaunchStoreContext,
} from './OpenCodeLaunchAttemptStore.js'
import type {
  OpenCodeLaunchAttemptRequest,
  OpenCodeLaunchAttemptResponse,
  OpenCodeLaunchMemberLinkage,
  OpenCodeOpaqueIdentity,
  OpenCodeRetainedHostIdentity,
} from './OpenCodeBridgeContractV2.js'

const attemptId = '123e4567-e89b-42d3-a456-426614174000'
const hash = 'a'.repeat(64)
const oid = (character: string) => `sha256:${character.repeat(64)}` as OpenCodeOpaqueIdentity
const members = [oid('1'), oid('2')]
const host: OpenCodeRetainedHostIdentity = {
  hostKeyIdentity: oid('b'), processId: 410, processStartedAtMs: 991, profileScopeIdentity: oid('c'),
}
const request = (generation = 1): OpenCodeLaunchAttemptRequest => ({
  launchContractVersion: 1,
  launchAttempt: {
    attemptId, payloadHash: hash, generation, proofNonce: 'AAAAAAAAAAAAAAAAAAAAAA',
    parent: { sessionIdentity: oid('d'), messageIdentity: oid('e') },
    providerId: 'anthropic', modelId: 'anthropic/claude-sonnet-4-5',
    requiredMcpTools: ['mcp__app__team'], requireFreshRetainedHostProof: true,
  },
})

const linkage = (memberIdentity: OpenCodeOpaqueIdentity, offset = 0): OpenCodeLaunchMemberLinkage => ({
  memberIdentity,
  sessionIdentity: oid(offset ? '7' : memberIdentity === members[0] ? '3' : '8'),
  bootstrapMessageIdentity: oid(offset ? '9' : memberIdentity === members[0] ? '4' : '6'),
  commitIdentity: oid(offset ? '0' : memberIdentity === members[0] ? '5' : '7'),
})

class MemoryPersistence implements OpenCodeLaunchJournalPersistence {
  bytes: Uint8Array | null = null
  fence = 0
  writes = 0
  acquisitions = 0
  async read() { return this.bytes?.slice() ?? null }
  async replaceAndSync(bytes: Uint8Array) { this.bytes = bytes.slice(); this.writes += 1 }
  async readFence() { return this.fence || null }
  async compareAndSwapFence(expected: number, next: number) {
    if (this.fence !== expected || next !== expected + 1) throw new Error('fence CAS mismatch')
    this.fence = next
  }
  async acquireExclusive(
    _context: OpenCodeLaunchStoreContext,
  ): Promise<(context?: OpenCodeLaunchStoreContext) => Promise<void>> {
    this.acquisitions += 1
    return async () => undefined
  }
  json() { return this.bytes ? JSON.parse(new TextDecoder().decode(this.bytes)) : null }
}

function proofResponse(generation: number, nonceHash = hash, verifiedAt = 1): OpenCodeLaunchAttemptResponse {
  return {
    launchAttempt: {
      contractVersion: 1, attemptId, idempotencyKey: 'attemptId', payloadHash: hash, generation,
      inputDigest: 'e'.repeat(64), immutableDigest: 'f'.repeat(64),
      outcome: 'succeeded', phase: 'complete', startedAt: 0, absoluteDeadlineAt: 10_000,
      workDeadlineAt: 9_000, cleanupReserveMs: 1_000, elapsedMs: 1,
      providerId: 'anthropic', modelId: 'anthropic/claude-sonnet-4-5', profilePurpose: 'launch_attempt',
      projectIdentity: oid('2'), profileIdentity: oid('c'), configIdentity: oid('b'),
      authIdentity: oid('a'), pluginPolicyIdentity: oid('f'), cacheIdentity: oid('0'),
      binaryIdentity: oid('d'),
      retainedHostIdentity: host,
    },
    proof: {
      generation, attemptId, parent: request(generation).launchAttempt.parent,
      providerId: 'anthropic', modelId: 'anthropic/claude-sonnet-4-5', retainedHostIdentity: host,
      observedMcpTools: ['mcp__app__team'], nonceHash,
      sessionIdentity: oid('8'), promptMessageIdentity: oid('9'), assistantMessageIdentity: oid('a'),
      verifiedAt, authorizationSource: 'fresh_live_attempt', cacheUsed: false,
    },
    members: { committed: [], failed: [], pending: [], cleanupPending: [] },
  }
}

function setup(options: {
  initialNow?: number
  generation?: number
  proof?: (response: OpenCodeLaunchAttemptResponse) => void
  proofIdentities?: Partial<{ authIdentity: OpenCodeOpaqueIdentity; configIdentity: OpenCodeOpaqueIdentity; binaryIdentity: OpenCodeOpaqueIdentity }>
  proofObservation?: Partial<Awaited<ReturnType<OpenCodeLaunchAttemptPorts['proof']['observeRetainedProofState']>>>
  materialize?: (member: OpenCodeOpaqueIdentity) => ReturnType<OpenCodeLaunchAttemptPorts['sessions']['createBootstrapAndCommit']>
  authoritative?: Map<string, OpenCodeLaunchMemberLinkage | null>
  claim?: OpenCodeLaunchAttemptPorts['sessions']['claimMemberMutation']
  transition?: OpenCodeLaunchAttemptPorts['sessions']['transitionMemberClaim']
} = {}) {
  const persistence = new MemoryPersistence()
  let now = options.initialNow ?? 0
  const calls: string[] = []
  const cleaned: OpenCodeOpaqueIdentity[][] = []
  const deadlines: number[] = []
  const ports: OpenCodeLaunchAttemptPorts = {
    clock: { monotonicNow: () => now },
    profile: { createSelectedProviderProfile: async ({ deadlineAtMs }) => {
      calls.push('profile'); deadlines.push(deadlineAtMs)
      return { purpose: 'launch_attempt', providerId: 'anthropic', projectIdentity: oid('2'), profileIdentity: oid('c'),
        pluginPolicyIdentity: oid('f'), cacheIdentity: oid('0'), authIdentity: oid('a'),
        configIdentity: oid('b'), binaryIdentity: oid('d') }
    } },
    host: {
      acquireOperationHost: async ({ deadlineAtMs }) => { calls.push('host'); deadlines.push(deadlineAtMs); return host },
      releaseOperationHost: async () => { calls.push('release') },
    },
    mcp: { verifyAppMcp: async ({ deadlineAtMs }) => {
      calls.push('mcp'); deadlines.push(deadlineAtMs)
      return { host, observedTools: ['mcp__app__team'] }
    } },
    proof: {
      runFreshExactModelProof: async ({ deadlineAtMs, request: proofRequest }) => {
        calls.push('proof'); deadlines.push(deadlineAtMs)
        const nonceHash = createHash('sha256').update(proofRequest.launchAttempt.proofNonce).digest('hex')
        const response = proofResponse(proofRequest.launchAttempt.generation, nonceHash, now + 1); options.proof?.(response)
        now += 2
        return { response, authIdentity: oid('a'), configIdentity: oid('b'), binaryIdentity: oid('d'),
          ...options.proofIdentities }
      },
      observeRetainedProofState: async ({ deadlineAtMs, request: observedRequest }) => {
        calls.push('proof-observe'); deadlines.push(deadlineAtMs)
        return { host,
          nonceHash: createHash('sha256').update(observedRequest.launchAttempt.proofNonce).digest('hex'),
          providerId: 'anthropic', modelId: 'anthropic/claude-sonnet-4-5', mcpConnected: true,
          observedTools: ['mcp__app__team'], profileIdentity: oid('c'), pluginPolicyIdentity: oid('f'),
          cacheIdentity: oid('0'), authIdentity: oid('a'), configIdentity: oid('b'), binaryIdentity: oid('d'),
          ...options.proofObservation }
      },
    },
    sessions: {
      readMemberLinkage: async ({ memberIdentity }) => {
        calls.push(`read:${memberIdentity}`)
        return options.authoritative?.get(memberIdentity) ?? null
      },
      claimMemberMutation: options.claim ?? (async () => 'claimed'),
      transitionMemberClaim: options.transition ?? (async input =>
        input.transition === 'commit' ? 'committed' : 'cancelled'),
      createBootstrapAndCommit: async input => {
        const { memberIdentity } = input
        calls.push(`create:${memberIdentity}`)
        await input.revalidateBeforeCommit()
        const result = await (options.materialize?.(memberIdentity) ?? Promise.resolve({
          outcome: 'applied', linkage: linkage(memberIdentity), owned: { memberIdentity },
        } as const))
        if (result.outcome === 'applied' && await input.commitIfClaimLive(result.linkage) !== 'committed') {
          return { outcome: 'unknown_transport', owned: result.owned }
        }
        return result
      },
    },
    ownership: {
      abortOwned: async ({ resources }) => { calls.push(`abort:${resources.memberIdentity}`) },
      cleanupOwned: async ({ resources }) => { cleaned.push(resources.map(item => item.memberIdentity)); return 'complete' },
    },
    deadline: { run: async (operation, deadlineAtMs, signal) => {
      if (signal.aborted || now >= deadlineAtMs) throw new Error('deadline')
      const result = await operation
      if (signal.aborted || now >= deadlineAtMs) throw new Error('deadline')
      return result
    } },
  }
  const store = new OpenCodeLaunchAttemptStore(persistence)
  return {
    persistence, calls, cleaned, deadlines, ports,
    store, launch: new OpenCodeLaunchAttempt(store, ports),
    setNow(value: number) { now = value },
  }
}

describe('OpenCodeLaunchAttempt exact proof and deadlines', () => {
  test.each([
    ['nonce', (value: OpenCodeLaunchAttemptResponse) => { value.proof!.nonceHash = 'b'.repeat(64) }],
    ['provider', (value: OpenCodeLaunchAttemptResponse) => { value.proof!.providerId = 'openai' }],
    ['model', (value: OpenCodeLaunchAttemptResponse) => { value.proof!.modelId = 'other' }],
    ['parent', (value: OpenCodeLaunchAttemptResponse) => { value.proof!.parent.messageIdentity = oid('f') }],
    ['MCP', (value: OpenCodeLaunchAttemptResponse) => { value.proof!.observedMcpTools = [] }],
    ['host key', (value: OpenCodeLaunchAttemptResponse) => { value.proof!.retainedHostIdentity = { ...host, hostKeyIdentity: oid('e') } }],
    ['host PID', (value: OpenCodeLaunchAttemptResponse) => { value.proof!.retainedHostIdentity = { ...host, processId: 411 } }],
    ['host birth', (value: OpenCodeLaunchAttemptResponse) => { value.proof!.retainedHostIdentity = { ...host, processStartedAtMs: 992 } }],
    ['host profile scope', (value: OpenCodeLaunchAttemptResponse) => {
      value.proof!.retainedHostIdentity = { ...host, profileScopeIdentity: oid('e') }
    }],
    ['profile', (value: OpenCodeLaunchAttemptResponse) => { value.launchAttempt.profileIdentity = oid('2') }],
    ['generation', (value: OpenCodeLaunchAttemptResponse) => { value.proof!.generation = 0 }],
    ['cache', (value: OpenCodeLaunchAttemptResponse) => { (value.proof as any).cacheUsed = true }],
  ])('rejects %s mismatch before member intent or session', async (_name, mutate) => {
    const subject = setup({ proof: mutate })
    const result = await subject.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })
    expect(result.status).toBe('failed')
    expect(subject.calls.some(call => call.startsWith('create:'))).toBe(false)
    expect(subject.persistence.json().events).toEqual([])
  })

  test('durably publishes a proof-null terminal failure so an exact duplicate never reruns setup', async () => {
    const subject = setup({ proof: response => { response.proof!.providerId = 'openai' } })
    const first = await subject.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })
    expect(first.status).toBe('failed')
    expect(first.durableFinalResponse).toMatchObject({
      launchAttempt: { outcome: 'failed' },
      failure: { code: 'contract_violation', sideEffectsStarted: false },
    })
    expect(first.durableFinalResponse?.proof).toBeUndefined()
    const inventedAuthority = structuredClone(first.durableFinalResponse!)
    inventedAuthority.launchAttempt.projectIdentity = oid('e')
    expect(decodeOpenCodeLaunchAttemptResponse(inventedAuthority)).toMatchObject({ ok: false })
    const calls = subject.calls.length
    const replay = await subject.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })
    expect(replay.durableFinalResponse).toEqual(first.durableFinalResponse)
    expect(subject.calls).toHaveLength(calls)
  })

  test('publishes a profile preparation exception at its true frozen-clock timestamp', async () => {
    const subject = setup()
    subject.ports.profile.createSelectedProviderProfile = async () => {
      throw new Error('noncanonical Windows profile path')
    }

    const result = await subject.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })

    expect(result).toMatchObject({
      status: 'failed', failurePhase: 'profile_prepare', failureAtMs: 0,
      durableFinalResponse: {
        launchAttempt: { elapsedMs: 0 },
        failure: { code: 'contract_violation', phase: 'profile_prepare' },
      },
    })
    expect(subject.persistence.json().finalResponse).toEqual(result.durableFinalResponse)

    const replay = await new OpenCodeLaunchAttempt(
      new OpenCodeLaunchAttemptStore(subject.persistence), subject.ports,
    ).run({ request: request(), members, requestedBudgetMs: 10_000 })
    expect(replay).toMatchObject({ failurePhase: 'profile_prepare', failureAtMs: 0 })
    expect(replay.durableFinalResponse).toEqual(result.durableFinalResponse)
  })

  test('projects a proof-null profile preparation failure relative to a nonzero monotonic start', async () => {
    const subject = setup({ initialNow: 1_000_000 })
    subject.ports.profile.createSelectedProviderProfile = async () => {
      throw new Error('noncanonical Windows profile path')
    }

    const result = await subject.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })

    expect(result).toMatchObject({
      status: 'failed', failurePhase: 'profile_prepare', failureAtMs: 1_000_000,
      durableFinalResponse: {
        launchAttempt: { startedAt: 1_000_000, elapsedMs: 0 },
        failure: { code: 'contract_violation', phase: 'profile_prepare' },
      },
    })
    expect(subject.persistence.json().finalResponse).toEqual(result.durableFinalResponse)

    const replay = await new OpenCodeLaunchAttempt(
      new OpenCodeLaunchAttemptStore(subject.persistence), subject.ports,
    ).run({ request: request(), members, requestedBudgetMs: 10_000 })
    expect(replay).toMatchObject({ failureAtMs: 1_000_000 })
    expect(replay.durableFinalResponse).toEqual(result.durableFinalResponse)
  })

  test.each([
    ['ambiguous thrown transport', async () => { throw new Error('transport failed') }, 'member_unknown'],
    ['known member failure', async (member: OpenCodeOpaqueIdentity) => ({
      outcome: 'known_failure' as const, failure: 'pre_side_effect_transport' as const,
      externalEffect: false as const, owned: { memberIdentity: member },
    }), 'member_failed'],
  ])('captures %s before delayed member persistence', async (_name, materialize, terminalEvent) => {
    const subject = setup({ materialize: async member => {
      subject.setNow(1_037)
      return materialize(member)
    } })
    const replace = subject.persistence.replaceAndSync.bind(subject.persistence)
    subject.persistence.replaceAndSync = async bytes => {
      await replace(bytes)
      const journal = JSON.parse(new TextDecoder().decode(bytes))
      if (journal.events.at(-1)?.type === terminalEvent) subject.setNow(1_500)
    }

    const result = await subject.launch.run({
      request: request(), members: [members[0]], requestedBudgetMs: 10_000,
    })

    expect(result.failureAtMs).toBe(1_037)
    expect(result.durableFinalResponse?.launchAttempt.elapsedMs).toBe(1_037)
    expect(subject.persistence.json().events.some((event: any) => event.type === terminalEvent)).toBe(true)
  })

  test('retains a later provider phase and failure timestamp across cleanup failure', async () => {
    const subject = setup()
    subject.ports.mcp.verifyAppMcp = async () => {
      subject.setNow(37)
      throw new Error('MCP validation failed')
    }
    subject.ports.host.releaseOperationHost = async () => {
      subject.setNow(500)
      throw new Error('host cleanup failed')
    }

    const result = await subject.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })

    expect(result).toMatchObject({
      status: 'failed', cleanup: 'timed_out', failurePhase: 'provider_live_validate', failureAtMs: 37,
      durableFinalResponse: {
        launchAttempt: { elapsedMs: 37 },
        failure: { code: 'contract_violation', phase: 'provider_live_validate' },
      },
    })
  })

  test.each([
    ['missing roster identity', (value: OpenCodeLaunchAttemptResponse) => { value.members.committed.pop() }],
    ['invented roster identity', (value: OpenCodeLaunchAttemptResponse) => {
      value.members.committed[0]!.memberIdentity = oid('e')
    }],
    ['overlapping roster partitions', (value: OpenCodeLaunchAttemptResponse) => {
      value.members.pending.push(value.members.committed[0]!.memberIdentity)
    }],
    ['committed cleanup identity', (value: OpenCodeLaunchAttemptResponse) => {
      value.members.cleanupPending.push(value.members.committed[0]!.memberIdentity)
    }],
    ['unrelated cleanup identity', (value: OpenCodeLaunchAttemptResponse) => {
      value.members.cleanupPending.push(oid('f'))
    }],
    ['duplicate cleanup identity', (value: OpenCodeLaunchAttemptResponse) => {
      const identity = value.members.committed.pop()!.memberIdentity
      value.members.pending.push(identity)
      value.members.cleanupPending.push(identity, identity)
    }],
    ['wrong parent linkage', (value: OpenCodeLaunchAttemptResponse) => {
      value.proof!.parent.messageIdentity = oid('f')
    }],
  ] as const)('rejects Desktop V1 %s against the authoritative roster', async (_name, mutate) => {
    const subject = setup()
    const result = await subject.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })
    const response = structuredClone(result.durableFinalResponse!)
    mutate(response)
    expect(() => validateOpenCodeLaunchResponseRoster(response, members, request().launchAttempt.parent)).toThrow()
  })

  test('accepts cleanup correlation for failed or pending roster identities only', async () => {
    const subject = setup()
    const result = await subject.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })
    const pendingResponse = structuredClone(result.durableFinalResponse!)
    const pendingIdentity = pendingResponse.members.committed.pop()!.memberIdentity
    pendingResponse.members.pending.push(pendingIdentity)
    pendingResponse.members.cleanupPending = [pendingIdentity]
    expect(() => validateOpenCodeLaunchResponseRoster(
      pendingResponse, members, request().launchAttempt.parent,
    )).not.toThrow()

    const failedResponse = structuredClone(result.durableFinalResponse!)
    const failedIdentity = failedResponse.members.committed.pop()!.memberIdentity
    failedResponse.members.failed.push({
      memberIdentity: failedIdentity,
      failure: {
        code: 'deadline_after_partial', origin: 'deadline', retryDisposition: 'continuation',
        retryable: true, phase: 'member_materialize', sideEffectsStarted: true,
        exhaustionScope: 'member',
      },
    })
    failedResponse.members.cleanupPending = [failedIdentity]
    expect(() => validateOpenCodeLaunchResponseRoster(
      failedResponse, members, request().launchAttempt.parent,
    )).not.toThrow()
  })

  test('uses capped phase deadlines and one absolute deadline with positive cleanup reserve', async () => {
    const subject = setup()
    const acquisitionDeadlines: number[] = []
    subject.persistence.acquireExclusive = async context => {
      acquisitionDeadlines.push(context.deadlineAtMs)
      return async () => undefined
    }
    const result = await subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 10_000 })
    expect(acquisitionDeadlines).toEqual([9_000])
    expect(subject.deadlines).toEqual([9_000, 9_000, 9_000, 9_000, 9_000, 9_000, 9_000, 9_000])
    expect(result.workDeadlineAtMs).toBe(9_000)
    expect(result.absoluteDeadlineAtMs).toBe(10_000)
    expect(result.absoluteDeadlineAtMs - result.workDeadlineAtMs).toBe(1_000)
  })

  test.each(['authIdentity', 'configIdentity', 'binaryIdentity'] as const)(
    'invalidates proof after %s changes', async field => {
      const subject = setup({ proofIdentities: { [field]: oid('e') } })
      const result = await subject.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })
      expect(result.status).toBe('failed')
      expect(subject.calls.some(call => call.startsWith('create:'))).toBe(false)
    },
  )

  test.each([
    ['MCP disconnected', { mcpConnected: false }],
    ['proof nonce drift', { nonceHash: 'e'.repeat(64) }],
    ['MCP tools dropped', { observedTools: [] as string[] }],
    ['provider drift', { providerId: 'openai' }],
    ['model drift', { modelId: 'other' }],
    ['profile drift', { profileIdentity: oid('e') }],
    ['auth drift', { authIdentity: oid('e') }],
    ['config drift', { configIdentity: oid('e') }],
    ['binary drift', { binaryIdentity: oid('e') }],
    ['plugin drift', { pluginPolicyIdentity: oid('e') }],
    ['cache drift', { cacheIdentity: oid('e') }],
  ] as const)('revalidates %s immediately before member creation', async (_name, proofObservation) => {
    const subject = setup({ proofObservation })
    const result = await subject.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })
    expect(result.status).toBe('failed')
    expect(subject.calls.some(call => call.startsWith('create:'))).toBe(false)
    expect(subject.persistence.json().events).toEqual([])
  })

  test('rejects a stale verifiedAt proof while accepting the canonical caller challenge', async () => {
    const stale = setup({ proof: response => { response.proof!.verifiedAt = 0 } })
    expect((await stale.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })).status).toBe('failed')
    expect(stale.persistence.json().events).toEqual([])

    const canonical = setup()
    expect((await canonical.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })).status)
      .toBe('succeeded')
  })

  test.each([
    ['verifiedAt after proof completion', (value: OpenCodeLaunchAttemptResponse) => { value.proof!.verifiedAt = 3 }],
    ['profile purpose', (value: OpenCodeLaunchAttemptResponse) => { value.launchAttempt.profilePurpose = 'other' }],
    ['extra MCP observation', (value: OpenCodeLaunchAttemptResponse) => { value.proof!.observedMcpTools.push('mcp__app__extra') }],
  ])('rejects non-exact frozen %s expectation', async (_name, mutate) => {
    const subject = setup({ proof: mutate })
    const result = await subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 10_000 })
    expect(result.status).toBe('failed')
    expect(subject.calls.some(call => call.startsWith('create:'))).toBe(false)
  })

  test('snapshots ordered member input and binds the locally computed digest into ledger fencing', async () => {
    let claimInput: Parameters<OpenCodeLaunchAttemptPorts['sessions']['claimMemberMutation']>[0] | undefined
    const subject = setup({ claim: async input => { claimInput = input; return 'claimed' } })
    const mutable = [members[0]]
    const running = subject.launch.run({ request: request(), members: mutable, requestedBudgetMs: 10_000 })
    mutable.push(members[1])
    const result = await running
    expect(result.committed.map(item => item.memberIdentity)).toEqual([members[0]])
    expect(claimInput).toMatchObject({ attemptId, payloadHash: hash, generation: 1, fence: 1, memberIdentity: members[0] })
    expect(claimInput?.inputDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(claimInput?.inputDigest).not.toBe(hash)
  })

  test('digests the complete decoded launch input, including the exact proof nonce, mode and member order', async () => {
    const captured: string[] = []
    const firstRequest = request()
    const first = setup({ claim: async input => { captured.push(input.inputDigest); return 'claimed' } })
    await first.launch.run({ request: firstRequest, members, requestedBudgetMs: 10_000 })
    const expected = createHash('sha256').update(JSON.stringify({
      contractVersion: 1, attemptId, payloadHash: hash, generation: 1,
      parent: firstRequest.launchAttempt.parent, providerId: 'anthropic', modelId: 'anthropic/claude-sonnet-4-5',
      requiredMcpTools: ['mcp__app__team'], proofNonce: firstRequest.launchAttempt.proofNonce,
      requireFreshRetainedHostProof: true, mode: 'begin',
      requestedBudgetMs: 10_000, effectiveBudgetMs: 10_000, members,
    })).digest('hex')
    expect(captured[0]).toBe(expected)

    const same = setup({ claim: async input => { captured.push(input.inputDigest); return 'claimed' } })
    await same.launch.run({ request: structuredClone(firstRequest), members, requestedBudgetMs: 10_000 })
    expect(captured[2]).toBe(captured[0])

    const changedNonce = setup({ claim: async input => { captured.push(input.inputDigest); return 'claimed' } })
    const nonceRequest = structuredClone(firstRequest)
    nonceRequest.launchAttempt.proofNonce = 'BBBBBBBBBBBBBBBBBBBBBA'
    await changedNonce.launch.run({ request: nonceRequest, members, requestedBudgetMs: 10_000 })
    expect(captured[4]).not.toBe(captured[0])

    const reordered = setup({ claim: async input => { captured.push(input.inputDigest); return 'claimed' } })
    await reordered.launch.run({ request: structuredClone(firstRequest), members: [...members].reverse(), requestedBudgetMs: 10_000 })
    expect(captured[6]).not.toBe(captured[0])

    const changedToken = setup({ claim: async input => { captured.push(input.inputDigest); return 'claimed' } })
    const changedRequest = structuredClone(firstRequest)
    changedRequest.launchAttempt.continuationToken = 'opaque-continuation-two'
    await expect(changedToken.launch.run({ request: changedRequest, members, requestedBudgetMs: 10_000 }))
      .rejects.toMatchObject({ field: 'launchAttempt.continuationToken' })
    expect(captured).toHaveLength(8)
  })

  test('passes the complete durable identity and a live tombstone check into materialization', async () => {
    const subject = setup()
    const original = subject.ports.sessions.createBootstrapAndCommit
    let observed: Parameters<typeof original>[0] | undefined
    subject.ports.sessions.createBootstrapAndCommit = async input => { observed = input; return original(input) }
    const result = await subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 10_000 })
    expect(result.status).toBe('succeeded')
    expect(observed).toMatchObject({
      attemptId, payloadHash: hash, generation: 1, fence: 1, memberIdentity: members[0],
    })
    expect(observed?.inputDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(observed?.claimToken.startsWith(`${observed.acquisitionToken}.`)).toBe(true)
    expect(subject.persistence.json().events[0].claimToken).toBe(observed?.claimToken)
    await expect(observed!.revalidateBeforeCommit()).rejects.toMatchObject({ code: 'fenced' })
  })

  test('binds normalized requested/effective budget and rejects a 10s to 20s replay', async () => {
    const authoritative = new Map<string, OpenCodeLaunchMemberLinkage | null>()
    const subject = setup({ authoritative })
    const first = await subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 10_000 })
    authoritative.set(members[0], first.committed[0]!)
    const proofs = subject.calls.filter(call => call === 'proof').length
    await expect(subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 20_000 }))
      .rejects.toMatchObject({ code: 'foreign' })
    expect(subject.calls.filter(call => call === 'proof')).toHaveLength(proofs)
  })

  test('fails closed when an atomic ledger commit fences a late mutation', async () => {
    const subject = setup({ transition: async input => input.transition === 'commit' ? 'fenced' : 'cancelled' })
    const result = await subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 10_000 })
    expect(result.failure?.kind).toBe('unknown_transport_after_side_effect')
    expect(result.committed).toEqual([])
    expect(subject.persistence.json().events.map((event: any) => event.type)).toEqual([
      'member_intent', 'member_unknown', 'cleanup',
    ])
  })

  test('cancels a never-resolving ledger claim with the attempt signal and unchanged deadline', async () => {
    const cancellation = new AbortController()
    let entered!: () => void
    const claimEntered = new Promise<void>(resolve => { entered = resolve })
    let observedDeadline: number | undefined
    let observedSignal: AbortSignal | undefined
    const subject = setup({ claim: input => {
      observedDeadline = input.deadlineAtMs; observedSignal = input.signal; entered()
      return new Promise(() => undefined)
    } })
    subject.ports.deadline.run = async (operation, _deadline, signal) => Promise.race([
      operation,
      new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    ])
    const running = subject.launch.run({
      request: request(), members: [members[0]], requestedBudgetMs: 10_000, signal: cancellation.signal,
    })
    await claimEntered
    cancellation.abort(new Error('cancelled'))
    const result = await running
    expect(result.status).toBe('reconciliation_required')
    expect(result.failure).toMatchObject({
      kind: 'unknown_transport_after_side_effect', retryDisposition: 'never', sideEffectsStarted: true,
    })
    expect(observedDeadline).toBeLessThanOrEqual(9_000)
    expect(observedSignal?.aborted).toBe(true)
    expect(subject.persistence.json().events.map((event: any) => event.type)).toEqual(['member_intent', 'member_unknown'])
  })

  test('publishes and immediately projects a cancelled final while cleanup is retained, then passively replays it', async () => {
    const cancellation = new AbortController()
    const subject = setup()
    let proofObservationEntered!: () => void
    const atProofObservation = new Promise<void>(resolve => { proofObservationEntered = resolve })
    subject.ports.proof.observeRetainedProofState = async () => {
      proofObservationEntered()
      return new Promise<never>(() => undefined)
    }
    let cleanupStarted = false
    let settleCleanup!: () => void
    const physicalCleanup = new Promise<'complete'>(resolve => { settleCleanup = () => resolve('complete') })
    subject.ports.ownership.cleanupOwned = async () => {
      cleanupStarted = true
      return physicalCleanup
    }
    subject.ports.deadline.run = async (operation, _deadline, signal) => {
      if (cleanupStarted) throw new Error('cleanup deadline expired')
      return Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          const abort = () => reject(signal.reason)
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
        }),
      ])
    }

    const running = subject.launch.run({
      request: request(), members: [members[0]], requestedBudgetMs: 10_000, signal: cancellation.signal,
    })
    await atProofObservation
    cancellation.abort(new Error('cancelled behind retained cleanup'))
    const cancelled = await running
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.cleanup).toBe('timed_out')
    expect(cancelled.durableFinalResponse).toMatchObject({
      launchAttempt: { outcome: 'cancelled' }, failure: { code: 'cancelled' },
    })
    expect(subject.persistence.json().finalResponse).toEqual(cancelled.durableFinalResponse)
    expect(subject.calls.some(call => call.startsWith('create:'))).toBe(false)
    expect(subject.calls).not.toContain('release')

    const acquisitionsBeforeProjection = subject.persistence.acquisitions
    expect(projectOpenCodeLaunchAttemptResponse(cancelled)).toEqual(cancelled.durableFinalResponse)
    expect(subject.persistence.acquisitions).toBe(acquisitionsBeforeProjection)

    const activeCalls = subject.calls.filter(call => call === 'profile' || call === 'host'
      || call === 'mcp' || call === 'proof' || call === 'proof-observe'
      || call.startsWith('read:') || call.startsWith('create:')).length
    const restarted = new OpenCodeLaunchAttempt(
      new OpenCodeLaunchAttemptStore(subject.persistence), subject.ports)
    const replay = await restarted.run({
      request: request(), members: [members[0]], requestedBudgetMs: 10_000,
    })
    expect(replay.status).toBe('cancelled')
    expect(replay.durableFinalResponse).toEqual(cancelled.durableFinalResponse)
    expect(subject.calls.filter(call => call === 'profile' || call === 'host'
      || call === 'mcp' || call === 'proof' || call === 'proof-observe'
      || call.startsWith('read:') || call.startsWith('create:'))).toHaveLength(activeCalls)
    expect(subject.calls).not.toContain('release')

    settleCleanup()
    await physicalCleanup
    await Bun.sleep(0)
    expect(subject.calls).toContain('release')
  })

  test('does not reset the deadline and catches timeout immediately after an intent transition', async () => {
    const subject = setup({ materialize: async member => {
      subject.setNow(9_000)
      return { outcome: 'applied', linkage: linkage(member), owned: { memberIdentity: member } }
    } })
    const result = await subject.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })
    expect(result.status).toBe('reconciliation_required')
    expect(result.absoluteDeadlineAtMs).toBe(10_000)
    expect(subject.persistence.json().events.map((event: any) => event.type)).toEqual(['member_intent', 'member_unknown'])
  })

  test('times out immediately before the intent persistence transition', async () => {
    const subject = setup({ proof: () => subject.setNow(9_000) })
    const result = await subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 10_000 })
    expect(result.status).toBe('failed')
    expect(result).toMatchObject({
      failurePhase: 'retained_host_mcp_proof', failureAtMs: 9_002,
      durableFinalResponse: {
        launchAttempt: { elapsedMs: 9_002 },
        failure: { code: 'deadline_before_partial', phase: 'retained_host_mcp_proof' },
      },
    })
    expect(subject.persistence.json().events).toEqual([])
    expect(subject.calls.some(call => call.startsWith('create:'))).toBe(false)
  })

  test('preserves a durable applied transition when the work deadline expires immediately after fsync', async () => {
    const subject = setup()
    const replace = subject.persistence.replaceAndSync.bind(subject.persistence)
    subject.persistence.replaceAndSync = async bytes => {
      await replace(bytes)
      const journal = JSON.parse(new TextDecoder().decode(bytes))
      if (journal.events.at(-1)?.type === 'member_applied') subject.setNow(9_000)
    }
    const result = await subject.launch.run({
      request: request(), members, requestedBudgetMs: 10_000,
    })
    expect(result.status).toBe('partial')
    expect(result.failure?.kind).toBe('deadline_after_partial')
    expect(result.committed).toEqual([linkage(members[0])])
    expect(result.continuationToken).toMatch(/^opencode-launch-continuation-v1\./)
    expect(subject.persistence.json().finalResponse).toMatchObject({
      launchAttempt: { outcome: 'partial' },
      members: { pending: [members[1]], continuationToken: result.continuationToken },
    })
    expect(subject.persistence.json().events.map((event: any) => event.type)).toEqual([
      'member_intent', 'member_applied',
    ])
  })
})

describe('OpenCodeLaunchAttempt partial success, ambiguity, continuation and cleanup', () => {
  test.each(['contract_violation', 'attempt_budget_exhausted'] as const)(
    'preserves partial %s taxonomy and never issues a forbidden continuation', async failure => {
      const subject = setup({ materialize: async member => member === members[0]
        ? { outcome: 'applied', linkage: linkage(member), owned: { memberIdentity: member } }
        : { outcome: 'known_failure', failure, externalEffect: false, owned: { memberIdentity: member } } })
      const result = await subject.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })
      expect(result.status).toBe('partial')
      expect(result.failure?.kind).toBe(failure)
      expect(result.continuationToken).toBeUndefined()
      expect(subject.persistence.json().finalResponse.members.continuationToken).toBeUndefined()
    },
  )

  test('tombstones a timeout after claim and never authorizes a continuation resend from absence', async () => {
    let creates = 0
    const authoritative = new Map<string, OpenCodeLaunchMemberLinkage | null>()
    const subject = setup({ authoritative, materialize: async member => {
      creates += 1
      if (creates === 1) subject.setNow(9_000)
      return { outcome: 'applied', linkage: linkage(member), owned: { memberIdentity: member } }
    } })
    const first = await subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 10_000 })
    expect(first.status).toBe('reconciliation_required')
    expect(first).toMatchObject({ attemptId, payloadHash: hash, generation: 1 })
    expect(first.continuationToken).toBeUndefined()
    expect(subject.persistence.json().events.map((event: any) => event.type)).toEqual(['member_intent', 'member_unknown'])
    subject.setNow(500)
    const continuedRequest = request(2)
    await expect(subject.launch.run({
      request: continuedRequest, members: [members[0]], continuation: true, requestedBudgetMs: 10_000,
    })).rejects.toMatchObject({ field: 'launchAttempt.continuationToken' })
    expect(creates).toBe(1)
    expect(subject.persistence.json().events.map((event: any) => event.type)).toEqual([
      'member_intent', 'member_unknown',
    ])
  })

  test('preserves member 1 when member 2 is known-failed and never schedules beyond it', async () => {
    let memberTwoAttempts = 0
    const authoritative = new Map<string, OpenCodeLaunchMemberLinkage | null>()
    const subject = setup({ authoritative, materialize: async member => member === members[0]
      ? { outcome: 'applied', linkage: linkage(member), owned: { memberIdentity: member } }
      : ++memberTwoAttempts === 1
        ? { outcome: 'known_failure', failure: 'pre_side_effect_transport', externalEffect: false,
          owned: { memberIdentity: member, childOwnershipIdentity: oid('a'), grandchildOwnershipIdentities: [oid('b')] } }
        : { outcome: 'applied', linkage: linkage(member), owned: { memberIdentity: member } } })
    const result = await subject.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })
    expect(result.status).toBe('partial')
    expect(result).toMatchObject({ attemptId, payloadHash: hash, generation: 1 })
    expect(result.continuationToken).toMatch(/^opencode-launch-continuation-v1\.[A-Za-z0-9_-]+$/)
    expect(result.committed.map(item => item.memberIdentity)).toEqual([members[0]])
    expect(result.failure).toMatchObject({
      kind: 'pre_side_effect_transport', retryDisposition: 'automatic', sideEffectsStarted: false,
    })
    const projected = projectOpenCodeLaunchAttemptResponse(result)
    expect(decodeOpenCodeLaunchAttemptResponse(projected)).toMatchObject({
      ok: true,
      value: { kind: 'v2', response: { launchAttempt: {
        attemptId, payloadHash: hash, generation: 1,
        inputDigest: result.inputDigest, immutableDigest: result.immutableDigest,
      }, members: {
        committed: [{ memberIdentity: members[0] }],
        failed: [{ memberIdentity: members[1] }],
        pending: [], continuationToken: result.continuationToken,
      } } },
    })
    expect(subject.calls).not.toContain(`abort:${members[0]}`)
    expect(subject.cleaned).toEqual([[members[1]]])
    expect(subject.persistence.json().events.map((event: any) => event.type)).toEqual([
      'member_intent', 'member_applied', 'member_intent', 'member_failed', 'cleanup',
    ])
    authoritative.set(members[0], result.committed[0]!)
    const proofCount = subject.calls.filter(call => call === 'proof').length
    const replay = await subject.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })
    expect(replay.status).toBe('partial')
    expect(replay.continuationToken).toBe(result.continuationToken)
    expect(subject.calls.filter(call => call === 'proof')).toHaveLength(proofCount)
    const continuedRequest = request(2)
    continuedRequest.launchAttempt.continuationToken = result.continuationToken
    const continued = await subject.launch.run({
      request: continuedRequest, members, continuation: true, requestedBudgetMs: 10_000,
    })
    expect(continued.status).toBe('succeeded')
    expect(continued).toMatchObject({ attemptId, payloadHash: hash, generation: 2 })
    expect(continued.continuationToken).toBeUndefined()
    expect(continued.committed.map(item => item.memberIdentity)).toEqual(members)
    expect(subject.calls.filter(call => call === 'proof')).toHaveLength(2)
  })

  test('derives cleanup pending from the authoritative generation and persists the committed continuation', async () => {
    let memberTwoAttempts = 0
    const authoritative = new Map<string, OpenCodeLaunchMemberLinkage | null>()
    const subject = setup({ authoritative, materialize: async member => member === members[0]
      ? { outcome: 'applied', linkage: linkage(member), owned: { memberIdentity: member } }
      : ++memberTwoAttempts === 1
        ? { outcome: 'known_failure', failure: 'pre_side_effect_transport', externalEffect: false,
          owned: { memberIdentity: member } }
        : { outcome: 'applied', linkage: linkage(member), owned: { memberIdentity: member } } })
    let cleanupAttempts = 0
    subject.ports.ownership.cleanupOwned = async () => ++cleanupAttempts === 1 ? 'timed_out' : 'complete'

    const first = await subject.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })
    expect(first.status).toBe('partial')
    expect(first.failed.map(item => item.memberIdentity)).toEqual([members[1]])
    expect(first.pending).toEqual([])
    expect(first.cleanupPending).toEqual([members[1]])
    expect(first.durableFinalResponse?.members.cleanupPending).toEqual([members[1]])
    expect(subject.persistence.json().finalResponse.members.cleanupPending).toEqual([members[1]])
    authoritative.set(members[0], first.committed[0]!)

    const continuedRequest = request(2)
    continuedRequest.launchAttempt.continuationToken = first.continuationToken
    const continued = await subject.launch.run({
      request: continuedRequest, members, continuation: true, requestedBudgetMs: 10_000,
    })
    expect(continued.status).toBe('succeeded')
    expect(continued.committed.map(item => item.memberIdentity)).toEqual(members)
    expect(continued.failed).toEqual([])
    expect(continued.pending).toEqual([])
    expect(continued.cleanupPending).toEqual([])
    const encoded = projectOpenCodeLaunchAttemptResponse(continued)
    expect(decodeOpenCodeLaunchAttemptResponse(encoded)).toMatchObject({
      ok: true,
      value: { kind: 'v2', response: { members: {
        committed: [{ memberIdentity: members[0] }, { memberIdentity: members[1] }],
        failed: [], pending: [], cleanupPending: [],
      } } },
    })
    expect(subject.persistence.json().finalResponse).toEqual(encoded)
    expect(subject.persistence.json().events.map((event: any) => [event.generation, event.type])).toEqual([
      [1, 'member_intent'], [1, 'member_applied'], [1, 'member_intent'], [1, 'member_failed'], [1, 'cleanup'],
      [2, 'member_reconciled_absent'], [2, 'member_intent'], [2, 'member_applied'],
    ])
  })

  test('rejects forged and stale continuation tokens before advancing the durable generation', async () => {
    const authoritative = new Map<string, OpenCodeLaunchMemberLinkage | null>()
    const subject = setup({ authoritative, materialize: async member => member === members[0]
      ? { outcome: 'applied', linkage: linkage(member), owned: { memberIdentity: member } }
      : { outcome: 'known_failure', failure: 'pre_side_effect_transport', externalEffect: false,
        owned: { memberIdentity: member } } })
    const first = await subject.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })
    authoritative.set(members[0], first.committed[0]!)

    const forged = request(2)
    forged.launchAttempt.continuationToken = 'forged'
    await expect(subject.launch.run({ request: forged, members, continuation: true,
      requestedBudgetMs: 10_000 })).rejects.toMatchObject({ field: 'launchAttempt.continuationToken' })
    expect(subject.persistence.json()).toMatchObject({ generation: 1, fence: 1 })

    const valid = request(2)
    valid.launchAttempt.continuationToken = first.continuationToken
    const second = await subject.launch.run({ request: valid, members, continuation: true,
      requestedBudgetMs: 10_000 })
    expect(second.status).toBe('partial')
    expect(second.continuationToken).not.toBe(first.continuationToken)
    expect(second).toMatchObject({ attemptId, payloadHash: hash, generation: 2 })

    const stale = request(3)
    stale.launchAttempt.continuationToken = first.continuationToken
    await expect(subject.launch.run({ request: stale, members, continuation: true,
      requestedBudgetMs: 10_000 })).rejects.toMatchObject({ field: 'launchAttempt.continuationToken' })
    expect(subject.persistence.json()).toMatchObject({ generation: 2, fence: 2 })
  })

  test('records unknown, stops, and permits reconciliation but never an absent-ledger resend', async () => {
    let invocations = 0
    const authoritative = new Map<string, OpenCodeLaunchMemberLinkage | null>()
    const subject = setup({ authoritative, materialize: async member => {
      invocations += 1
      return invocations === 1
        ? { outcome: 'unknown_transport', owned: { memberIdentity: member } }
        : { outcome: 'applied', linkage: linkage(member), owned: { memberIdentity: member } }
    } })
    const first = await subject.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })
    expect(first.failure?.kind).toBe('unknown_transport_after_side_effect')
    expect(first.continuationToken).toBeUndefined()
    expect(invocations).toBe(1)
    subject.setNow(500)
    const continuedRequest = request(2)
    await expect(subject.launch.run({ request: continuedRequest, members,
      continuation: true, requestedBudgetMs: 10_000 }))
      .rejects.toMatchObject({ field: 'launchAttempt.continuationToken' })
    expect(invocations).toBe(1)
    expect(subject.calls).not.toContain(`read:${members[0]}`)
    expect(subject.persistence.json().events.map((event: any) => event.type)).not.toContain('member_reconciled_absent')
  })

  test('restart rejects a claimless pre-existing projection and keeps durable outcome conservative', async () => {
    const subject = setup({ materialize: async member => member === members[0]
      ? { outcome: 'applied', linkage: linkage(member), owned: { memberIdentity: member } }
      : { outcome: 'unknown_transport', owned: { memberIdentity: member } } })
    const replace = subject.persistence.replaceAndSync.bind(subject.persistence)
    let rejectUnknown = true
    subject.persistence.replaceAndSync = async bytes => {
      const journal = JSON.parse(new TextDecoder().decode(bytes))
      if (rejectUnknown && journal.events.at(-1)?.type === 'member_unknown') {
        throw new Error('simulated crash after member_intent')
      }
      await replace(bytes)
    }
    await expect(subject.launch.run({ request: request(), members, requestedBudgetMs: 10_000 }))
      .rejects.toThrow()
    expect(subject.persistence.json().events.map((event: any) => event.type)).toEqual([
      'member_intent', 'member_applied', 'member_intent',
    ])

    rejectUnknown = false
    subject.ports.sessions.readMemberLinkage = async ({ memberIdentity }) =>
      memberIdentity === members[0] ? linkage(memberIdentity) : null
    subject.ports.sessions.createBootstrapAndCommit = async () => ({
      outcome: 'known_failure', failure: 'contract_violation', externalEffect: false,
    })
    const restarted = await subject.launch.run({
      request: request(), members, requestedBudgetMs: 10_000,
    })
    expect(restarted.status).toBe('partial')
    expect(restarted.committed).toEqual([linkage(members[0])])
    expect(restarted.continuationToken).toBeUndefined()
    expect(restarted.failure).toMatchObject({
      kind: 'contract_violation', retryDisposition: 'never', sideEffectsStarted: false,
    })
    expect(subject.persistence.json().events.map((event: any) => event.type)).toEqual([
      'member_intent', 'member_applied', 'member_intent', 'member_reconciled_absent',
      'member_intent', 'member_failed',
    ])
  })

  test('keeps an exact durable reconciliation final passive when projection truth later appears', async () => {
    const authoritative = new Map<string, OpenCodeLaunchMemberLinkage | null>()
    const subject = setup({ authoritative, materialize: async member => ({
      outcome: 'unknown_transport', owned: { memberIdentity: member },
    }) })
    let reconciliationIdentity: Parameters<OpenCodeLaunchAttemptPorts['sessions']['readMemberLinkage']>[0] | undefined
    subject.ports.sessions.readMemberLinkage = async input => {
      reconciliationIdentity = input
      return authoritative.get(input.memberIdentity) ?? null
    }
    const first = await subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 10_000 })
    authoritative.set(members[0], linkage(members[0]))
    const beforeCreates = subject.calls.filter(call => call.startsWith('create:')).length
    const continuedRequest = request()
    const continued = await subject.launch.run({
      request: continuedRequest, members: [members[0]], requestedBudgetMs: 10_000,
    })
    expect(continued.status).toBe('reconciliation_required')
    expect(continued.committed).toEqual([])
    const originalClaim = subject.persistence.json().events.find((event: any) => event.type === 'member_intent')
    expect(originalClaim).toBeDefined()
    expect(reconciliationIdentity).toBeUndefined()
    expect(subject.calls.filter(call => call.startsWith('create:'))).toHaveLength(beforeCreates)
    expect(subject.persistence.json().events.map((event: any) => event.type)).not.toContain('member_reconciled_applied')
  })

  test('preserves committed member 1 when member 2 has unknown transport', async () => {
    const subject = setup({ materialize: async member => member === members[0]
      ? { outcome: 'applied', linkage: linkage(member), owned: { memberIdentity: member } }
      : { outcome: 'unknown_transport', owned: { memberIdentity: member } } })
    const result = await subject.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })
    expect(result.status).toBe('reconciliation_required')
    expect(result.committed).toEqual([linkage(members[0])])
    expect(result.failure).toMatchObject({
      kind: 'unknown_transport_after_side_effect', retryDisposition: 'never', sideEffectsStarted: true,
    })
    expect(subject.calls).not.toContain(`abort:${members[0]}`)
  })

  test('idempotently replays an already committed launch only with exact ledger agreement', async () => {
    const authoritative = new Map<string, OpenCodeLaunchMemberLinkage | null>()
    const subject = setup({ authoritative })
    const first = await subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 10_000 })
    authoritative.set(members[0], first.committed[0]!)
    const creates = subject.calls.filter(call => call.startsWith('create:')).length
    const replay = await subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 10_000 })
    expect(replay.status).toBe('succeeded')
    expect(replay).toMatchObject({ attemptId, payloadHash: hash, generation: 1 })
    expect(replay.continuationToken).toBeUndefined()
    expect(replay.committed).toEqual(first.committed)
    expect(subject.calls.filter(call => call.startsWith('create:'))).toHaveLength(creates)
    expect(subject.calls.filter(call => call === 'proof')).toHaveLength(1)
  })

  test('rejects replay with a different ordered member payload before any new proof or mutation', async () => {
    const authoritative = new Map<string, OpenCodeLaunchMemberLinkage | null>()
    const subject = setup({ authoritative })
    const first = await subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 10_000 })
    authoritative.set(members[0], first.committed[0]!)
    const proofs = subject.calls.filter(call => call === 'proof').length
    await expect(subject.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })).rejects.toMatchObject({
      code: 'foreign',
    })
    expect(subject.calls.filter(call => call === 'proof')).toHaveLength(proofs)
  })

  test('rejects continuation member/config drift while preserving the original committed roster', async () => {
    const authoritative = new Map<string, OpenCodeLaunchMemberLinkage | null>()
    const subject = setup({ authoritative })
    const first = await subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 10_000 })
    authoritative.set(members[0], first.committed[0]!)
    const proofs = subject.calls.filter(call => call === 'proof').length
    const driftRequest = request(2)
    driftRequest.launchAttempt.continuationToken = 'forged-for-immutable-member-drift'
    await expect(subject.launch.run({
      request: driftRequest, members, continuation: true, requestedBudgetMs: 10_000,
    })).rejects.toMatchObject({ field: 'launchAttempt.continuationToken' })
    const changedConfig = request(2)
    changedConfig.launchAttempt.continuationToken = 'forged-for-immutable-config-drift'
    changedConfig.launchAttempt.modelId = 'anthropic/claude-opus-4-1'
    await expect(subject.launch.run({
      request: changedConfig, members: [members[0]], continuation: true, requestedBudgetMs: 10_000,
    })).rejects.toMatchObject({ field: 'launchAttempt.continuationToken' })
    expect(subject.calls.filter(call => call === 'proof')).toHaveLength(proofs)
    expect(subject.persistence.json()).toMatchObject({ generation: 1, fence: 1 })
  })

  test('ignores a late applied completion after cancellation and cleans registered owned descendants', async () => {
    const cancellation = new AbortController()
    const owned = { memberIdentity: members[0], lockOwnershipIdentity: oid('a'),
      httpOwnershipIdentity: oid('b'), childOwnershipIdentity: oid('c'),
      grandchildOwnershipIdentities: [oid('d')] }
    const subject = setup()
    let abortedOwned: typeof owned | undefined
    let cleanupOwned: typeof owned[] | undefined
    subject.ports.ownership.abortOwned = async ({ resources }) => { abortedOwned = resources as typeof owned }
    subject.ports.ownership.cleanupOwned = async input => {
      cleanupOwned = input.resources as typeof owned[]
      expect(input.deadlineAtMs).toBe(10_000)
      expect(input.attemptSignal.aborted).toBe(true)
      return 'complete'
    }
    subject.ports.sessions.createBootstrapAndCommit = async input => {
      input.registerOwned(owned)
      cancellation.abort(new Error('cancelled'))
      return { outcome: 'applied', linkage: linkage(input.memberIdentity), owned }
    }
    const result = await subject.launch.run({
      request: request(), members: [members[0]], requestedBudgetMs: 10_000, signal: cancellation.signal,
    })
    await Bun.sleep(0)
    expect(result.status).toBe('reconciliation_required')
    expect(result.failure?.kind).toBe('unknown_transport_after_side_effect')
    expect(result.committed).toEqual([])
    expect(subject.persistence.json().events.map((event: any) => event.type)).toEqual([
      'member_intent', 'member_unknown', 'cleanup',
    ])
    expect(abortedOwned).toEqual(owned)
    expect(cleanupOwned).toEqual([owned])
  })

  test('returns after a durable tombstone but retains ownership until the late materializer settles', async () => {
    const cancellation = new AbortController()
    const subject = setup()
    let entered!: () => void
    const materializerEntered = new Promise<void>(resolve => { entered = resolve })
    let finish!: (value: Awaited<ReturnType<OpenCodeLaunchAttemptPorts['sessions']['createBootstrapAndCommit']>>) => void
    const physical = new Promise<Awaited<ReturnType<OpenCodeLaunchAttemptPorts['sessions']['createBootstrapAndCommit']>>>(
      resolve => { finish = resolve },
    )
    let durableCheck!: () => Promise<void>
    let cleanupEntered!: () => void
    const atCleanup = new Promise<void>(resolve => { cleanupEntered = resolve })
    let finishCleanup!: () => void
    const physicalCleanup = new Promise<void>(resolve => { finishCleanup = resolve })
    let cleanupCalls = 0
    subject.ports.ownership.cleanupOwned = async ({ resources }) => {
      cleanupCalls += 1
      expect(resources.map(item => item.memberIdentity)).toEqual([members[0]])
      cleanupEntered()
      await physicalCleanup
      return 'complete'
    }
    subject.ports.sessions.createBootstrapAndCommit = input => {
      input.registerOwned({ memberIdentity: input.memberIdentity, childOwnershipIdentity: oid('a') })
      durableCheck = input.revalidateBeforeCommit
      entered()
      return physical
    }
    let callerDeadlineExpired = false
    subject.ports.deadline.run = async (operation, _deadline, signal) => {
      if (callerDeadlineExpired) throw new Error('original absolute deadline expired')
      return Promise.race([
        operation,
        new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
      ])
    }
    const running = subject.launch.run({
      request: request(), members: [members[0]], requestedBudgetMs: 10_000, signal: cancellation.signal,
    })
    await materializerEntered
    cancellation.abort(new Error('cancelled'))
    const result = await running
    await Bun.sleep(0)
    expect(result.failure).toMatchObject({
      kind: 'unknown_transport_after_side_effect', retryDisposition: 'never', sideEffectsStarted: true,
    })
    expect(result.cleanup).toBe('timed_out')
    expect(result.pending).toEqual([members[0]])
    expect(result.cleanupPending).toEqual([members[0]])
    expect(result.durableFinalResponse?.members.cleanupPending).toEqual([members[0]])
    expect(decodeOpenCodeLaunchAttemptResponse(result.durableFinalResponse)).toMatchObject({
      ok: true,
      value: { kind: 'v2', response: { members: {
        committed: [], failed: [], pending: [members[0]], cleanupPending: [members[0]],
      } } },
    })
    expect(subject.persistence.json().events.map((event: any) => event.type)).toEqual([
      'member_intent', 'member_unknown',
    ])
    const publishedFinal = structuredClone(subject.persistence.json().finalResponse)
    expect(projectOpenCodeLaunchAttemptResponse(result)).toEqual(result.durableFinalResponse)
    expect(subject.persistence.acquisitions).toBe(1)
    let reacquired = false
    const blockedReacquisition = subject.store.inspect({ attemptId, payloadHash: hash,
      inputDigest: result.inputDigest }).then(value => { reacquired = true; return value })
    await Bun.sleep(0)
    expect(reacquired).toBe(false)
    expect(subject.persistence.acquisitions).toBe(1)
    expect(subject.calls).not.toContain('release')
    expect(subject.cleaned).toEqual([])
    expect(cleanupCalls).toBe(0)
    await expect(durableCheck()).rejects.toMatchObject({ code: 'fenced' })
    callerDeadlineExpired = true
    subject.setNow(result.absoluteDeadlineAtMs)
    finish({ outcome: 'applied', linkage: linkage(members[0]), owned: { memberIdentity: members[0] } })
    await physical
    await atCleanup
    expect(cleanupCalls).toBe(1)
    expect(subject.calls).not.toContain('release')
    finishCleanup()
    await physicalCleanup
    await Bun.sleep(0)
    expect((await blockedReacquisition)?.finalResponse).toEqual(publishedFinal)
    expect(subject.persistence.acquisitions).toBe(2)
    expect(subject.calls.filter(call => call === 'release')).toHaveLength(1)
    expect(result.committed).toEqual([])
    expect(subject.persistence.json().finalResponse).toEqual(publishedFinal)
    expect(subject.persistence.json().events.at(-1)).toMatchObject({
      type: 'member_unknown', memberIdentity: members[0],
    })
    expect(subject.persistence.json().cleanupState).toBe('incomplete')
    callerDeadlineExpired = false
    subject.setNow(2)
    const restarted = new OpenCodeLaunchAttempt(new OpenCodeLaunchAttemptStore(subject.persistence), subject.ports)
    const replay = await restarted.run({
      request: request(), members: [members[0]], requestedBudgetMs: 10_000,
    })
    expect(replay.cleanup).toBe('timed_out')
    expect(replay.cleanupPending).toEqual([members[0]])
    expect(replay.durableFinalResponse?.members.cleanupPending).toEqual([members[0]])
  })

  test('production projection returns and replays a durable partial at the exhausted work deadline', async () => {
    const subject = setup()
    subject.ports.sessions.createBootstrapAndCommit = async input => {
      await input.revalidateBeforeCommit()
      const applied = { outcome: 'applied' as const, linkage: linkage(input.memberIdentity),
        owned: { memberIdentity: input.memberIdentity } }
      expect(await input.commitIfClaimLive(applied.linkage)).toBe('committed')
      subject.setNow(9_000)
      return applied
    }
    const result = await subject.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })
    expect(result.status).toBe('partial')
    expect(result.failure?.kind).toBe('deadline_after_partial')
    expect(result.committed).toEqual([linkage(members[0])])
    const writes = subject.persistence.writes
    const acquisitions = subject.persistence.acquisitions
    expect(projectOpenCodeLaunchAttemptResponse(result)).toEqual(result.durableFinalResponse)
    expect(subject.persistence.writes).toBe(writes)
    expect(subject.persistence.acquisitions).toBe(acquisitions)

    subject.setNow(1)
    const replay = await new OpenCodeLaunchAttempt(
      new OpenCodeLaunchAttemptStore(subject.persistence), subject.ports,
    ).run({ request: request(), members, requestedBudgetMs: 10_000 })
    expect(replay.durableFinalResponse).toEqual(result.durableFinalResponse)
    expect(subject.calls.filter(call => call.startsWith('create:'))).toHaveLength(0)
  })

  test('FileJournal returns a durable partial and releases its lease through the cleanup reserve', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'opencode-work-exhaustion-'))
    const journalPath = path.join(directory, 'launch-attempts', `${attemptId}.journal`)
    const persistence = new OpenCodeLaunchFileJournalPersistence(journalPath)
    const acquiredDeadlines: number[] = []
    const releasedDeadlines: number[] = []
    const acquire = persistence.acquireExclusive.bind(persistence)
    persistence.acquireExclusive = async context => {
      acquiredDeadlines.push(context.deadlineAtMs)
      const release = await acquire(context)
      return async releaseContext => {
        releasedDeadlines.push(releaseContext!.deadlineAtMs)
        await release(releaseContext)
      }
    }
    const subject = setup()
    subject.ports.sessions.createBootstrapAndCommit = async input => {
      await input.revalidateBeforeCommit()
      const applied = { outcome: 'applied' as const, linkage: linkage(input.memberIdentity),
        owned: { memberIdentity: input.memberIdentity } }
      expect(await input.commitIfClaimLive(applied.linkage)).toBe('committed')
      subject.setNow(9_000)
      return applied
    }
    try {
      const result = await new OpenCodeLaunchAttempt(
        new OpenCodeLaunchAttemptStore(persistence), subject.ports,
      ).run({ request: request(), members, requestedBudgetMs: 10_000 })
      expect(result.status).toBe('partial')
      expect(result.failure?.kind).toBe('deadline_after_partial')
      expect(result.committed).toEqual([linkage(members[0])])
      expect(result.durableFinalResponse).toMatchObject({ launchAttempt: { outcome: 'partial' } })
      expect(acquiredDeadlines).toEqual([9_000])
      expect(releasedDeadlines).toEqual([10_000])
      const durable = await new OpenCodeLaunchAttemptStore(
        new OpenCodeLaunchFileJournalPersistence(journalPath),
      ).snapshotReadOnly({ attemptId, payloadHash: hash, inputDigest: result.inputDigest,
        immutableDigest: result.immutableDigest }, {
        deadlineAtMs: 10_000, monotonicNow: () => 9_000, signal: new AbortController().signal,
      })
      expect(durable?.finalResponse).toEqual(result.durableFinalResponse)
      expect(durable?.events.map(event => event.type)).toEqual(['member_intent', 'member_applied'])
      await expect(stat(deriveOpenCodeLaunchNamespacePaths(journalPath, path).lock))
        .rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test('FileJournal fails closed when final persistence reaches the absolute deadline and reaps its lease', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'opencode-absolute-exhaustion-'))
    const journalPath = path.join(directory, 'launch-attempts', `${attemptId}.journal`)
    const persistence = new OpenCodeLaunchFileJournalPersistence(journalPath)
    const subject = setup()
    subject.ports.sessions.createBootstrapAndCommit = async input => {
      await input.revalidateBeforeCommit()
      const applied = { outcome: 'applied' as const, linkage: linkage(input.memberIdentity),
        owned: { memberIdentity: input.memberIdentity } }
      expect(await input.commitIfClaimLive(applied.linkage)).toBe('committed')
      subject.setNow(10_000)
      return applied
    }
    try {
      const running = new OpenCodeLaunchAttempt(
        new OpenCodeLaunchAttemptStore(persistence), subject.ports,
      ).run({ request: request(), members, requestedBudgetMs: 10_000 })
      await expect(running).rejects.toMatchObject({ code: 'fenced' })
      const lock = deriveOpenCodeLaunchNamespacePaths(journalPath, path).lock
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try { await stat(lock); await Bun.sleep(1) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
          throw error
        }
      }
      await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
      const durable = await new OpenCodeLaunchAttemptStore(
        new OpenCodeLaunchFileJournalPersistence(journalPath),
      ).snapshotReadOnly({ attemptId, payloadHash: hash }, {
        deadlineAtMs: 10_000, monotonicNow: () => 0, signal: new AbortController().signal,
      })
      expect(durable?.events.map(event => event.type)).toEqual(['member_intent', 'member_applied'])
      expect(durable?.finalResponse).toBeUndefined()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test('retains the host when deferred physical cleanup rejects and never starts cleanup twice', async () => {
    const cancellation = new AbortController()
    const subject = setup()
    let materializerEntered!: () => void
    const atMaterializer = new Promise<void>(resolve => { materializerEntered = resolve })
    let finishMember!: () => void
    const physicalMember = new Promise<void>(resolve => { finishMember = resolve })
    let cleanupEntered!: () => void
    const atCleanup = new Promise<void>(resolve => { cleanupEntered = resolve })
    let rejectCleanup!: (error: Error) => void
    const physicalCleanup = new Promise<'complete' | 'timed_out'>((_, reject) => { rejectCleanup = reject })
    let cleanupCalls = 0
    subject.ports.sessions.createBootstrapAndCommit = async input => {
      input.registerOwned({ memberIdentity: input.memberIdentity, childOwnershipIdentity: oid('a') })
      materializerEntered()
      await physicalMember
      return { outcome: 'applied', linkage: linkage(input.memberIdentity), owned: { memberIdentity: input.memberIdentity } }
    }
    subject.ports.ownership.cleanupOwned = () => {
      cleanupCalls += 1
      cleanupEntered()
      return physicalCleanup
    }
    subject.ports.deadline.run = async (operation, _deadline, signal) => Promise.race([
      operation,
      new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    ])
    const running = subject.launch.run({
      request: request(), members: [members[0]], requestedBudgetMs: 10_000, signal: cancellation.signal,
    })
    await atMaterializer
    cancellation.abort(new Error('cancelled'))
    const result = await running
    expect(result.cleanup).toBe('timed_out')
    expect(result.pending).toEqual([members[0]])
    expect(result.cleanupPending).toEqual([members[0]])
    expect(result.durableFinalResponse?.members.cleanupPending).toEqual([members[0]])
    expect(decodeOpenCodeLaunchAttemptResponse(result.durableFinalResponse)).toMatchObject({
      ok: true,
      value: { kind: 'v2', response: { members: {
        committed: [], failed: [], pending: [members[0]], cleanupPending: [members[0]],
      } } },
    })
    const publishedFinal = structuredClone(subject.persistence.json().finalResponse)
    expect(cleanupCalls).toBe(0)
    expect(subject.calls).not.toContain('release')

    finishMember()
    await physicalMember
    await atCleanup
    expect(cleanupCalls).toBe(1)
    expect(subject.calls).not.toContain('release')

    rejectCleanup(new Error('owned descendant survived cleanup'))
    await physicalCleanup.catch(() => undefined)
    await Bun.sleep(0)
    expect(cleanupCalls).toBe(1)
    expect(subject.calls).not.toContain('release')
    expect(subject.persistence.json().finalResponse).toEqual(publishedFinal)
    expect(subject.persistence.json().events.at(-1)).toMatchObject({
      type: 'member_unknown', memberIdentity: members[0],
    })
    expect(subject.persistence.json().cleanupState).toBe('incomplete')
    const restarted = new OpenCodeLaunchAttempt(new OpenCodeLaunchAttemptStore(subject.persistence), subject.ports)
    const replay = await restarted.run({
      request: request(), members: [members[0]], requestedBudgetMs: 10_000,
    })
    expect(replay.cleanup).toBe('timed_out')
    expect(replay.cleanupPending).toEqual([members[0]])
    expect(replay.durableFinalResponse?.members.cleanupPending).toEqual([members[0]])
  })

  test('atomically aborts the live claim so a cancelled late materializer cannot commit', async () => {
    const cancellation = new AbortController()
    let liveToken: string | undefined
    let commitCalls = 0
    let lateCommit!: (linkage: OpenCodeLaunchMemberLinkage) => Promise<'committed' | 'fenced' | 'unknown'>
    let entered!: () => void
    const materializerEntered = new Promise<void>(resolve => { entered = resolve })
    const subject = setup({
      claim: async input => { liveToken = input.claimToken; return 'claimed' },
      transition: async input => {
        if (input.transition === 'cancel') {
          if (liveToken !== input.claimToken) return 'fenced'
          liveToken = undefined
          return 'cancelled'
        }
        commitCalls += 1
        return liveToken === input.claimToken ? 'committed' : 'fenced'
      },
    })
    subject.ports.sessions.createBootstrapAndCommit = input => {
      lateCommit = input.commitIfClaimLive
      input.registerOwned({ memberIdentity: input.memberIdentity })
      entered()
      return new Promise(() => undefined)
    }
    subject.ports.deadline.run = async (operation, _deadline, signal) => Promise.race([
      operation,
      new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    ])
    const running = subject.launch.run({
      request: request(), members: [members[0]], requestedBudgetMs: 10_000, signal: cancellation.signal,
    })
    await materializerEntered
    cancellation.abort(new Error('cancelled'))
    const result = await running
    expect(result.failure).toMatchObject({ kind: 'unknown_transport_after_side_effect', sideEffectsStarted: true })
    expect(liveToken).toBeUndefined()
    await expect(lateCommit(linkage(members[0]))).rejects.toThrow('cancelled')
    expect(commitCalls).toBe(0)
    expect(subject.persistence.json().events.map((event: any) => event.type)).toEqual([
      'member_intent', 'member_unknown',
    ])
    expect(subject.calls).not.toContain('release')
    expect(subject.cleaned).toEqual([])
  })

  test('cancellation wins the durable claim CAS while the exact commit transition is blocked', async () => {
    const cancellation = new AbortController()
    let liveToken: string | undefined
    let commitEntered!: () => void
    const atCommitCas = new Promise<void>(resolve => { commitEntered = resolve })
    let unblockCommit!: () => void
    const commitGate = new Promise<void>(resolve => { unblockCommit = resolve })
    const transitions: string[] = []
    const subject = setup({
      claim: async input => { liveToken = input.claimToken; return 'claimed' },
      transition: async input => {
        transitions.push(input.transition)
        if (input.transition === 'cancel') {
          if (liveToken !== input.claimToken) return 'fenced'
          liveToken = undefined
          unblockCommit()
          return 'cancelled'
        }
        commitEntered()
        await commitGate
        return liveToken === input.claimToken ? 'committed' : 'fenced'
      },
    })
    subject.ports.sessions.createBootstrapAndCommit = async input => {
      input.registerOwned({ memberIdentity: input.memberIdentity })
      const commit = await input.commitIfClaimLive(linkage(input.memberIdentity))
      return commit === 'committed'
        ? { outcome: 'applied', linkage: linkage(input.memberIdentity), owned: { memberIdentity: input.memberIdentity } }
        : { outcome: 'unknown_transport', owned: { memberIdentity: input.memberIdentity } }
    }
    subject.ports.deadline.run = async (operation, _deadline, signal) => Promise.race([
      operation,
      new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    ])
    const running = subject.launch.run({
      request: request(), members: [members[0]], requestedBudgetMs: 10_000, signal: cancellation.signal,
    })
    await atCommitCas
    cancellation.abort(new Error('cancelled during commit CAS'))
    const result = await running
    expect(transitions).toEqual(['commit', 'cancel'])
    expect(liveToken).toBeUndefined()
    expect(result.failure).toMatchObject({ kind: 'unknown_transport_after_side_effect', retryDisposition: 'never' })
    expect(result.committed).toEqual([])
    expect(subject.persistence.json().events.map((event: any) => event.type)).toEqual([
      'member_intent', 'member_unknown', 'cleanup',
    ])
  })

  test('gives unknown precedence while preserving a member committed inside a never-settling transport', async () => {
    const cancellation = new AbortController()
    const owned = { memberIdentity: members[0], childOwnershipIdentity: oid('a') }
    const subject = setup()
    let committedInside!: () => void
    const commitReached = new Promise<void>(resolve => { committedInside = resolve })
    subject.ports.sessions.createBootstrapAndCommit = async input => {
      input.registerOwned(owned)
      expect(await input.commitIfClaimLive(linkage(input.memberIdentity))).toBe('committed')
      committedInside()
      return new Promise(() => undefined)
    }
    subject.ports.deadline.run = async (operation, _deadline, signal) => Promise.race([
      operation,
      new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    ])
    const running = subject.launch.run({
      request: request(), members: [members[0]], requestedBudgetMs: 10_000, signal: cancellation.signal,
    })
    await commitReached
    cancellation.abort(new Error('cancelled after durable commit'))
    const result = await running
    expect(result.status).toBe('reconciliation_required')
    expect(result.failure).toMatchObject({
      kind: 'unknown_transport_after_side_effect', retryDisposition: 'never', sideEffectsStarted: true,
    })
    expect(result.committed).toEqual([linkage(members[0])])
    expect(subject.calls).not.toContain(`abort:${members[0]}`)
    expect(subject.calls).not.toContain('release')
    expect(subject.cleaned).toEqual([])
    expect(subject.persistence.json().events.map((event: any) => event.type)).toEqual([
      'member_intent', 'member_applied',
    ])
  })

  test('returns bounded but holds the physical completion barrier when the unknown tombstone cannot persist', async () => {
    const cancellation = new AbortController()
    const subject = setup()
    const replace = subject.persistence.replaceAndSync.bind(subject.persistence)
    subject.persistence.replaceAndSync = async bytes => {
      const journal = JSON.parse(new TextDecoder().decode(bytes))
      if (journal.events.at(-1)?.type === 'member_unknown') throw new Error('journal unavailable')
      await replace(bytes)
    }
    let entered!: () => void
    const materializerEntered = new Promise<void>(resolve => { entered = resolve })
    let finish!: () => void
    const physical = new Promise<void>(resolve => { finish = resolve })
    let cleanupStarted = false
    subject.ports.sessions.createBootstrapAndCommit = async input => {
      input.registerOwned({ memberIdentity: input.memberIdentity, childOwnershipIdentity: oid('a') })
      entered()
      await physical
      return { outcome: 'applied', linkage: linkage(input.memberIdentity), owned: { memberIdentity: input.memberIdentity } }
    }
    subject.ports.ownership.cleanupOwned = async () => { cleanupStarted = true; return 'complete' }
    subject.ports.deadline.run = async (operation, _deadline, signal) => Promise.race([
      operation,
      new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    ])
    const running = subject.launch.run({
      request: request(), members: [members[0]], requestedBudgetMs: 10_000, signal: cancellation.signal,
    })
    await materializerEntered
    cancellation.abort(new Error('cancelled'))
    await expect(running).rejects.toThrow('journal unavailable')
    expect(cleanupStarted).toBe(false)
    expect(subject.calls).not.toContain('release')
    finish()
    await physical
    await Bun.sleep(0)
    expect(cleanupStarted).toBe(true)
    expect(subject.calls).toContain('release')
    // The failed authoritative write poisons the journal lease, so later cleanup metadata is
    // deliberately not published as authority; safety comes from the completion barrier.
    expect(subject.persistence.json().events.map((event: any) => event.type)).toEqual(['member_intent'])
  })

  test('returns at the deadline but retains the operation host until an ambiguous journal publication settles', async () => {
    const cancellation = new AbortController()
    const subject = setup()
    const replace = subject.persistence.replaceAndSync.bind(subject.persistence)
    let publicationEntered!: () => void
    const atPublication = new Promise<void>(resolve => { publicationEntered = resolve })
    let settlePublication!: () => void
    const publicationGate = new Promise<void>(resolve => { settlePublication = resolve })
    subject.persistence.replaceAndSync = async bytes => {
      const journal = JSON.parse(new TextDecoder().decode(bytes))
      if (journal.events.at(-1)?.type === 'member_applied') {
        publicationEntered()
        await publicationGate
      }
      await replace(bytes)
    }
    const running = subject.launch.run({
      request: request(), members: [members[0]], requestedBudgetMs: 10_000, signal: cancellation.signal,
    })
    await atPublication
    cancellation.abort(new Error('cancelled during journal publication'))
    await expect(running).rejects.toBeInstanceOf(OpenCodeLaunchPoisonedLeaseError)
    expect(subject.calls).not.toContain('release')
    settlePublication()
    await publicationGate
    await Bun.sleep(0)
    expect(subject.calls).toContain('release')
  })

  test('replays a committed durable final without consulting a divergent projection store', async () => {
    const authoritative = new Map<string, OpenCodeLaunchMemberLinkage | null>()
    const subject = setup({ authoritative })
    await subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 10_000 })
    const reads = subject.calls.filter(call => call.startsWith('read:')).length
    authoritative.set(members[0], linkage(members[0], 1))
    const replay = await subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 10_000 })
    expect(replay.status).toBe('succeeded')
    expect(subject.calls.filter(call => call.startsWith('read:'))).toHaveLength(reads)
    expect(subject.calls.filter(call => call.startsWith('create:'))).toHaveLength(1)
  })

  test('recovers a crash immediately before final response publication without a fresh launch', async () => {
    const authoritative = new Map<string, OpenCodeLaunchMemberLinkage | null>()
    const subject = setup({ authoritative })
    const replace = subject.persistence.replaceAndSync.bind(subject.persistence)
    subject.persistence.replaceAndSync = async bytes => {
      const journal = JSON.parse(new TextDecoder().decode(bytes))
      if (journal.finalResponse) throw new Error('crash:before-final-response')
      await replace(bytes)
    }
    await expect(subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 10_000 }))
      .rejects.toThrow('crash:before-final-response')
    expect(subject.persistence.json()).toMatchObject({ acceptedProofResponse: { launchAttempt: { attemptId } } })
    expect(subject.persistence.json().finalResponse).toBeUndefined()
    authoritative.set(members[0], linkage(members[0]))
    subject.persistence.replaceAndSync = replace

    const recovered = await subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 10_000 })
    const projected = projectOpenCodeLaunchAttemptResponse(recovered)
    expect(decodeOpenCodeLaunchAttemptResponse(projected)).toMatchObject({ ok: true, value: { kind: 'v2' } })
    expect(subject.persistence.json().finalResponse).toEqual(projected)
    expect(subject.calls.filter(call => call.startsWith('create:'))).toHaveLength(1)
    expect(subject.calls.filter(call => call === 'proof')).toHaveLength(1)
  })

  test('reuses the durable accepted proof after a partial-roster crash and progresses the remainder', async () => {
    const authoritative = new Map<string, OpenCodeLaunchMemberLinkage | null>()
    const subject = setup({ authoritative })
    const first = await subject.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })
    const journal = subject.persistence.json()
    journal.events = journal.events.filter((event: any) => event.memberIdentity === members[0])
    journal.finalResponse = undefined
    subject.persistence.bytes = new TextEncoder().encode(JSON.stringify(journal))
    authoritative.set(members[0], first.committed[0]!)
    const proofs = subject.calls.filter(call => call === 'proof').length
    const creates = subject.calls.filter(call => call.startsWith('create:')).length

    const replay = await subject.launch.run({ request: request(), members, requestedBudgetMs: 10_000 })
    expect(replay.status).toBe('succeeded')
    expect(subject.calls.filter(call => call === 'proof')).toHaveLength(proofs)
    expect(subject.calls.filter(call => call.startsWith('create:'))).toHaveLength(creates + 1)
    expect(replay.acceptedProofResponse?.proof).toEqual(journal.acceptedProofResponse.proof)
  })

  test('persists and exactly replays the request correlation digest through proof and final response', async () => {
    const digest = '7'.repeat(64)
    const correlatedRequest = request()
    correlatedRequest.launchAttempt.requestCorrelationDigest = digest
    const subject = setup({ proof: response => {
      response.launchAttempt.requestCorrelationDigest = digest
      response.proof!.requestCorrelationDigest = digest
    } })

    const first = await subject.launch.run({
      request: correlatedRequest, members: [members[0]], requestedBudgetMs: 10_000,
    })
    expect(first.acceptedProofResponse).toMatchObject({
      launchAttempt: { requestCorrelationDigest: digest },
      proof: { requestCorrelationDigest: digest },
    })
    expect(first.durableFinalResponse).toMatchObject({
      launchAttempt: { requestCorrelationDigest: digest },
      proof: { requestCorrelationDigest: digest },
    })
    const effects = subject.calls.filter(call => call === 'profile' || call === 'host'
      || call === 'proof' || call.startsWith('create:')).length

    const replay = await subject.launch.run({
      request: correlatedRequest, members: [members[0]], requestedBudgetMs: 10_000,
    })
    expect(replay.durableFinalResponse).toEqual(first.durableFinalResponse)
    expect(subject.calls.filter(call => call === 'profile' || call === 'host'
      || call === 'proof' || call.startsWith('create:'))).toHaveLength(effects)
  })

  test('echoes the request correlation digest in a proof-null terminal failure', async () => {
    const digest = '6'.repeat(64)
    const correlatedRequest = request()
    correlatedRequest.launchAttempt.requestCorrelationDigest = digest
    const subject = setup()
    subject.ports.profile.createSelectedProviderProfile = async () => {
      throw new Error('fake profile preparation failure')
    }

    const failed = await subject.launch.run({
      request: correlatedRequest, members: [members[0]], requestedBudgetMs: 10_000,
    })
    expect(failed.status).toBe('failed')
    expect(failed.durableFinalResponse).toMatchObject({
      launchAttempt: { requestCorrelationDigest: digest },
    })
    expect(failed.durableFinalResponse?.proof).toBeUndefined()
  })

  test('replays the exact authoritative response after a crash immediately after publication', async () => {
    const authoritative = new Map<string, OpenCodeLaunchMemberLinkage | null>()
    const subject = setup({ authoritative })
    const replace = subject.persistence.replaceAndSync.bind(subject.persistence)
    subject.persistence.replaceAndSync = async bytes => {
      const journal = JSON.parse(new TextDecoder().decode(bytes))
      await replace(bytes)
      if (journal.finalResponse) throw new Error('crash:after-final-response')
    }
    await expect(subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 10_000 }))
      .rejects.toThrow('crash:after-final-response')
    const authoritativeResponse = structuredClone(subject.persistence.json().finalResponse)
    expect(decodeOpenCodeLaunchAttemptResponse(authoritativeResponse)).toMatchObject({
      ok: true, value: { kind: 'v2' },
    })
    // The session projection remains absent; exact final replay must not inspect it.
    subject.persistence.replaceAndSync = replace
    const passiveCalls = subject.calls.filter(call => call === 'profile' || call === 'host'
      || call === 'mcp' || call === 'proof' || call.startsWith('proof-observe')
      || call.startsWith('read:') || call.startsWith('create:')).length

    const replay = await subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 10_000 })
    expect(projectOpenCodeLaunchAttemptResponse(replay)).toEqual(authoritativeResponse)
    expect(subject.calls.filter(call => call === 'profile' || call === 'host'
      || call === 'mcp' || call === 'proof' || call.startsWith('proof-observe')
      || call.startsWith('read:') || call.startsWith('create:'))).toHaveLength(passiveCalls)
    expect(subject.calls.filter(call => call.startsWith('create:'))).toHaveLength(1)
    expect(subject.calls.filter(call => call === 'proof')).toHaveLength(1)
  })

  test('a different nonce cannot replay a durable proof and reaches no launch port', async () => {
    const subject = setup()
    await subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 10_000 })
    const calls = subject.calls.length
    const changed = request()
    changed.launchAttempt.proofNonce = 'BBBBBBBBBBBBBBBBBBBBBA'

    await expect(subject.launch.run({ request: changed, members: [members[0]], requestedBudgetMs: 10_000 }))
      .rejects.toMatchObject({ code: 'foreign' })
    expect(subject.calls).toHaveLength(calls)
  })

  test('rejects a decoder-valid stored final whose proof is not correlated to the canonical nonce', async () => {
    const subject = setup()
    await subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 10_000 })
    const journal = subject.persistence.json()
    journal.acceptedProofResponse.proof.nonceHash = 'b'.repeat(64)
    journal.finalResponse.proof.nonceHash = 'b'.repeat(64)
    subject.persistence.bytes = new TextEncoder().encode(JSON.stringify(journal))
    const calls = subject.calls.length

    await expect(subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 10_000 }))
      .rejects.toMatchObject({ field: 'proof.nonceHash' })
    expect(subject.calls).toHaveLength(calls)
  })

  test('reports bounded cleanup timeout at the unchanged absolute deadline', async () => {
    const subject = setup({ materialize: async member => ({
      outcome: 'known_failure', failure: 'pre_side_effect_transport', externalEffect: false,
      owned: { memberIdentity: member },
    }) })
    subject.ports.ownership.cleanupOwned = async () => {
      subject.setNow(10_000)
      return new Promise(() => undefined)
    }
    await expect(subject.launch.run({
      request: request(), members: [members[0]], requestedBudgetMs: 10_000,
    })).rejects.toThrow()
    expect(subject.persistence.json().events.at(-1)).toMatchObject({ type: 'member_failed' })
    expect(subject.persistence.json().finalResponse).toBeUndefined()
  })

  test('releases the exact acquired host with a live cleanup context after pre-proof MCP failure', async () => {
    const subject = setup()
    let released: OpenCodeRetainedHostIdentity | undefined
    let releasedObligationId: string | undefined
    let cleanupSignal: AbortSignal | undefined
    const exactObligationId = '77777777-7777-4777-8777-777777777777'
    subject.ports.host.reserveOperationHostCleanup = async () => ({ obligationId: exactObligationId,
      reservationDigest: '7'.repeat(64) })
    subject.ports.mcp.verifyAppMcp = async () => { throw new Error('fake MCP configuration failure') }
    subject.ports.host.releaseOperationHost = async input => {
      released = input.host
      releasedObligationId = input.cleanupObligationId
      cleanupSignal = input.signal
      subject.calls.push('release')
    }
    const result = await subject.launch.run({
      request: request(), members: [members[0]], requestedBudgetMs: 10_000,
    })
    expect(result.status).toBe('failed')
    expect(released).toEqual(host)
    expect(releasedObligationId).toBe(exactObligationId)
    expect(cleanupSignal?.aborted).toBe(false)
    expect(subject.calls.some(call => call.startsWith('create:'))).toBe(false)
  })

  test('returns at the absolute deadline when physical host release never settles', async () => {
    const subject = setup()
    let releaseSignal: AbortSignal | undefined
    let releaseCalls = 0
    subject.ports.host.releaseOperationHost = input => {
      releaseCalls += 1
      releaseSignal = input.signal
      subject.setNow(input.deadlineAtMs)
      return new Promise<void>(() => undefined)
    }
    await expect(subject.launch.run({
      request: request(), members: [members[0]], requestedBudgetMs: 10_000,
    })).rejects.toMatchObject({ code: 'fenced' })
    expect(releaseSignal?.aborted).toBe(true)
    expect(subject.persistence.json().finalResponse).toBeUndefined()
    subject.setNow(1)
    await expect(subject.launch.run({
      request: request(), members: [members[0]], requestedBudgetMs: 10_000, deadlineAtMs: 2,
    })).rejects.toMatchObject({ code: 'fenced' })
    expect(releaseCalls).toBe(1)
  })

  test('self-releases a host acquired immediately after abort and never publishes false cleanup', async () => {
    const cancellation = new AbortController()
    let resolveAcquire!: (value: OpenCodeRetainedHostIdentity) => void
    let acquireEntered!: () => void
    const atAcquire = new Promise<void>(resolve => { acquireEntered = resolve })
    const physicalAcquire = new Promise<OpenCodeRetainedHostIdentity>(resolve => { resolveAcquire = resolve })
    let releaseEntered!: () => void
    const atRelease = new Promise<void>(resolve => { releaseEntered = resolve })
    let rejectRelease!: (error: Error) => void
    const physicalRelease = new Promise<void>((_, reject) => { rejectRelease = reject })
    const subject = setup()
    subject.ports.host.acquireOperationHost = async () => { acquireEntered(); return physicalAcquire }
    subject.ports.host.releaseOperationHost = async () => { releaseEntered(); return physicalRelease }
    subject.ports.deadline.run = async (operation, _deadline, signal) => Promise.race([
      operation,
      new Promise<never>((_, reject) => signal.addEventListener('abort',
        () => reject(signal.reason), { once: true })),
    ])

    const running = subject.launch.run({ request: request(), members: [members[0]],
      requestedBudgetMs: 10_000, signal: cancellation.signal })
    await atAcquire
    cancellation.abort(new Error('cancel immediately before acquisition resolution'))
    resolveAcquire(host)
    const result = await running
    await atRelease
    expect(result.cleanup).toBe('timed_out')
    expect(subject.persistence.json().cleanupState).toBe('incomplete')
    expect(subject.calls).not.toContain('mcp')

    rejectRelease(new Error('late physical release rejected'))
    await physicalRelease.catch(() => undefined)
    await Bun.sleep(0)
    expect(subject.persistence.json().cleanupState).toBe('incomplete')
  })

  test('bounds a host acquired after the absolute deadline and retains incomplete replay state', async () => {
    let resolveAcquire!: (value: OpenCodeRetainedHostIdentity) => void
    let acquireEntered!: () => void
    const atAcquire = new Promise<void>(resolve => { acquireEntered = resolve })
    const acquisition = new Promise<OpenCodeRetainedHostIdentity>(resolve => { resolveAcquire = resolve })
    const releaseInputs: Array<{ deadlineAtMs: number; signal: AbortSignal; lateSettlement?: true }> = []
    const physicalRelease = new Promise<void>(() => undefined)
    const subject = setup()
    subject.ports.host.acquireOperationHost = async () => { acquireEntered(); return acquisition }
    subject.ports.host.releaseOperationHost = async input => {
      releaseInputs.push({ deadlineAtMs: input.deadlineAtMs, signal: input.signal,
        lateSettlement: input.lateSettlement })
      return physicalRelease
    }

    const running = subject.launch.run({
      request: request(), members: [members[0]], requestedBudgetMs: 10_000,
    })
    await atAcquire
    subject.setNow(10_000)
    resolveAcquire(host)
    await running.catch(() => undefined)
    await Bun.sleep(0)

    expect(releaseInputs).toHaveLength(1)
    expect(releaseInputs[0]?.deadlineAtMs).toBe(10_000)
    expect(releaseInputs[0]?.lateSettlement).toBe(true)
    expect(releaseInputs[0]?.signal.aborted).toBe(true)
    expect(subject.persistence.json().cleanupState).not.toBe('complete')
    expect(subject.persistence.json().finalResponse).toBeUndefined()
  })

  test('persists incomplete cleanup when acquisition rejects after unproved fallback release', async () => {
    const subject = setup()
    subject.ports.host.acquireOperationHost = async () => {
      throw new OpenCodeOperationHostAcquisitionCleanupError(new Error('release resisted TERM'))
    }
    const result = await subject.launch.run({
      request: request(), members: [members[0]], requestedBudgetMs: 10_000,
    })
    expect(result.cleanup).toBe('timed_out')
    expect(subject.persistence.json()).toMatchObject({
      cleanupState: 'incomplete',
      finalResponse: { members: { cleanupPending: [] } },
    })
    subject.ports.host.reconcileOperationHost = async () => 'incomplete'
    const replay = await new OpenCodeLaunchAttempt(
      new OpenCodeLaunchAttemptStore(subject.persistence), subject.ports).run({
        request: request(), members: [members[0]], requestedBudgetMs: 10_000,
      })
    expect(replay.cleanup).toBe('timed_out')
    expect(subject.persistence.json().cleanupState).toBe('incomplete')
  })

  test('binds the exact completed receipt before accepting publication-fallback cleanup proof', async () => {
    const subject = setup()
    const reservation = { obligationId: '123e4567-e89b-42d3-a456-426614174499',
      reservationDigest: 'a'.repeat(64) }
    const completed = { ...reservation, receiptIdentityDigest: 'b'.repeat(64) }
    subject.ports.host.reserveOperationHostCleanup = async () => reservation
    subject.ports.host.acquireOperationHost = async () => {
      throw new OpenCodeOperationHostAcquisitionSettledError(completed,
        new Error('receipt publication crossed the caller deadline'))
    }
    const result = await subject.launch.run({
      request: request(), members: [members[0]], requestedBudgetMs: 10_000,
    })
    expect(result.cleanup).toBe('complete')
    expect(subject.persistence.json()).toMatchObject({
      cleanupState: 'complete',
      hostCleanupObligationIds: [reservation.obligationId],
      hostCleanupObligations: [completed],
    })
  })

  test('accepts an immediately resolved host synchronously and uses the normal one-shot release path', async () => {
    const cancellation = new AbortController()
    let acquireEntered!: () => void
    const atAcquire = new Promise<void>(resolve => { acquireEntered = resolve })
    let resolveAcquire!: (value: OpenCodeRetainedHostIdentity) => void
    const physicalAcquire = new Promise<OpenCodeRetainedHostIdentity>(resolve => { resolveAcquire = resolve })
    let mcpEntered!: () => void
    const atMcp = new Promise<void>(resolve => { mcpEntered = resolve })
    const subject = setup()
    subject.ports.host.acquireOperationHost = async () => { acquireEntered(); return physicalAcquire }
    subject.ports.mcp.verifyAppMcp = async () => {
      mcpEntered()
      await new Promise<never>((_, reject) => cancellation.signal.addEventListener('abort',
        () => reject(cancellation.signal.reason), { once: true }))
      return { host, observedTools: ['mcp__app__team'] }
    }
    subject.ports.deadline.run = async (operation, _deadline, signal) => Promise.race([
      operation,
      new Promise<never>((_, reject) => signal.addEventListener('abort',
        () => reject(signal.reason), { once: true })),
    ])

    const running = subject.launch.run({ request: request(), members: [members[0]],
      requestedBudgetMs: 10_000, signal: cancellation.signal })
    await atAcquire
    resolveAcquire(host)
    await atMcp
    cancellation.abort(new Error('cancel immediately after acquisition resolution'))
    const result = await running
    expect(result.cleanup).toBe('complete')
    expect(subject.calls.filter(call => call === 'release')).toHaveLength(1)
    expect(subject.persistence.json().cleanupState).toBe('complete')
  })

  test('classifies acquisition once after asynchronous durable binding and never releases an accepted host early', async () => {
    const cancellation = new AbortController()
    const subject = setup()
    const obligation = { obligationId: '123e4567-e89b-42d3-a456-426614174488',
      reservationDigest: '8'.repeat(64) }
    const binding = { ...obligation, receiptIdentityDigest: '9'.repeat(64) }
    let publishBinding!: () => void
    const bindingPublished = new Promise<void>(resolve => { publishBinding = resolve })
    let bindingRead!: () => void
    const atBindingRead = new Promise<void>(resolve => { bindingRead = resolve })
    let mcpEntered!: () => void
    const atMcp = new Promise<void>(resolve => { mcpEntered = resolve })
    subject.ports.host.reserveOperationHostCleanup = async () => obligation
    subject.ports.host.acquireOperationHost = async () => host
    subject.ports.host.readOperationHostCleanupBinding = async () => {
      bindingRead()
      await bindingPublished
      return binding
    }
    subject.ports.mcp.verifyAppMcp = async () => {
      mcpEntered()
      await new Promise<never>((_, reject) => cancellation.signal.addEventListener('abort',
        () => reject(cancellation.signal.reason), { once: true }))
      return { host, observedTools: ['mcp__app__team'] }
    }
    subject.ports.deadline.run = async (operation, _deadline, signal) => Promise.race([
      operation,
      new Promise<never>((_, reject) => signal.addEventListener('abort',
        () => reject(signal.reason), { once: true })),
    ])

    const running = subject.launch.run({ request: request(), members: [members[0]],
      requestedBudgetMs: 10_000, signal: cancellation.signal })
    await atBindingRead
    await Bun.sleep(0)
    expect(subject.calls).not.toContain('release')
    publishBinding()
    await atMcp
    expect(subject.calls).not.toContain('release')
    cancellation.abort(new Error('finish accepted-host regression'))
    const result = await running
    expect(result.cleanup).toBe('complete')
    expect(subject.calls.filter(call => call === 'release')).toHaveLength(1)
    expect(subject.persistence.json().hostCleanupObligations).toEqual([binding])
  })

  test('self-releases when the deadline expires immediately before acquisition resolution', async () => {
    let entered!: () => void
    const atAcquire = new Promise<void>(resolve => { entered = resolve })
    let resolveAcquire!: (value: OpenCodeRetainedHostIdentity) => void
    const acquisition = new Promise<OpenCodeRetainedHostIdentity>(resolve => { resolveAcquire = resolve })
    const subject = setup()
    subject.ports.host.acquireOperationHost = async () => { entered(); return acquisition }
    const running = subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 10_000 })
    await atAcquire
    subject.setNow(9_000)
    resolveAcquire(host)
    const result = await running
    expect(result.status).toBe('failed')
    expect(subject.calls).not.toContain('mcp')
    expect(subject.calls.filter(call => call === 'release')).toHaveLength(1)
    expect(subject.persistence.json().cleanupState).toBe('complete')
  })

  test('releases the accepted host when the deadline expires immediately after acquisition', async () => {
    const subject = setup()
    subject.ports.mcp.verifyAppMcp = async () => {
      subject.setNow(9_000)
      return { host, observedTools: ['mcp__app__team'] }
    }
    const result = await subject.launch.run({
      request: request(), members: [members[0]], requestedBudgetMs: 10_000,
    })
    expect(result.status).toBe('failed')
    expect(subject.calls.filter(call => call === 'release')).toHaveLength(1)
    expect(subject.persistence.json().cleanupState).toBe('complete')
  })

  test('promotes host-only incomplete cleanup only after exact replay reconciliation', async () => {
    const subject = setup()
    await subject.launch.run({ request: request(), members: [members[0]], requestedBudgetMs: 10_000 })
    const journal = subject.persistence.json()
    journal.cleanupState = 'incomplete'
    subject.persistence.bytes = new TextEncoder().encode(JSON.stringify(journal))
    let reconciliations = 0
    subject.ports.host.reconcileOperationHost = async input => {
      reconciliations += 1
      expect(input).toMatchObject({ attemptId, payloadHash: hash, generation: 1 })
      return 'complete'
    }
    const replay = await new OpenCodeLaunchAttempt(
      new OpenCodeLaunchAttemptStore(subject.persistence), subject.ports).run({
        request: request(), members: [members[0]], requestedBudgetMs: 10_000,
      })
    expect(replay.cleanup).toBe('complete')
    expect(reconciliations).toBe(1)
    expect(subject.persistence.json().cleanupState).toBe('complete')
  })
})
