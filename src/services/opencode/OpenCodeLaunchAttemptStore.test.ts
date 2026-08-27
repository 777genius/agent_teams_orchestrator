import { afterEach, describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'

import {
  OPEN_CODE_LAUNCH_JOURNAL_MAX_BYTES,
  classifyOpenCodeDirectoryDurabilityError,
  deriveOpenCodeLaunchNamespacePaths,
  OpenCodeLaunchAttemptStore,
  OpenCodeLaunchFileJournalPersistence,
  OpenCodeLaunchJournalError,
  OpenCodeLaunchPoisonedLeaseError,
  type OpenCodeLaunchJournalPersistence,
  type OpenCodeLaunchJournalLease,
  type OpenCodeLaunchStoreContext,
} from './OpenCodeLaunchAttemptStore.js'
import type {
  OpenCodeLaunchAttemptResponse,
  OpenCodeLaunchMemberLinkage,
  OpenCodeOpaqueIdentity,
} from './OpenCodeBridgeContractV2.js'

const identity = {
  attemptId: '123e4567-e89b-42d3-a456-426614174000',
  payloadHash: 'a'.repeat(64),
}
const oid = (character: string) => `sha256:${character.repeat(64)}` as OpenCodeOpaqueIdentity
const member = oid('1')
const linkage: OpenCodeLaunchMemberLinkage = {
  memberIdentity: member, sessionIdentity: oid('2'),
  bootstrapMessageIdentity: oid('3'), commitIdentity: oid('4'),
}
const finalResponse = (): OpenCodeLaunchAttemptResponse => ({
  launchAttempt: {
    contractVersion: 1, attemptId: identity.attemptId, idempotencyKey: 'attemptId',
    payloadHash: identity.payloadHash, generation: 1, inputDigest: 'e'.repeat(64),
    immutableDigest: 'f'.repeat(64), outcome: 'reconciliation_required', phase: 'complete',
    startedAt: 0, absoluteDeadlineAt: 10_000, workDeadlineAt: 9_000,
    cleanupReserveMs: 1_000, elapsedMs: 10_000, providerId: 'anthropic',
    modelId: 'anthropic/claude-sonnet-4-5', profilePurpose: 'launch_attempt',
    projectIdentity: oid('5'), profileIdentity: oid('6'), configIdentity: oid('7'),
    authIdentity: oid('8'), pluginPolicyIdentity: oid('9'), cacheIdentity: oid('a'),
    binaryIdentity: oid('b'), retainedHostIdentity: {
      hostKeyIdentity: oid('c'), processId: 410, processStartedAtMs: 991,
      profileScopeIdentity: oid('d'),
    },
  },
  proof: {
    generation: 1, attemptId: identity.attemptId,
    parent: { sessionIdentity: oid('e'), messageIdentity: oid('f') },
    providerId: 'anthropic', modelId: 'anthropic/claude-sonnet-4-5',
    retainedHostIdentity: {
      hostKeyIdentity: oid('c'), processId: 410, processStartedAtMs: 991,
      profileScopeIdentity: oid('d'),
    },
    observedMcpTools: ['mcp__app__team'], nonceHash: '0'.repeat(64),
    sessionIdentity: oid('2'), promptMessageIdentity: oid('3'), assistantMessageIdentity: oid('4'),
    verifiedAt: 1, authorizationSource: 'fresh_live_attempt', cacheUsed: false,
  },
  members: { committed: [], failed: [], pending: [member], cleanupPending: [member] },
  failure: {
    code: 'unknown_transport_after_side_effect', origin: 'session', retryDisposition: 'never',
    retryable: false, phase: 'member_materialize', sideEffectsStarted: true,
  },
})
const leasePath = (filePath: string) => deriveOpenCodeLaunchNamespacePaths(filePath, posix).lock

async function issueContinuation(
  store: OpenCodeLaunchAttemptStore,
  currentIdentity: typeof identity & { inputDigest?: string; immutableDigest?: string; generation?: number },
): Promise<string> {
  return store.withGeneration(currentIdentity, 'replay', lease => lease.issueContinuation([member]))
}

class MemoryPersistence implements OpenCodeLaunchJournalPersistence {
  bytes: Uint8Array | null = null
  fence = 0
  activeWrites = 0
  maximumActiveWrites = 0
  async read() { return this.bytes?.slice() ?? null }
  async replaceAndSync(bytes: Uint8Array, _context?: OpenCodeLaunchStoreContext) {
    this.activeWrites += 1
    this.maximumActiveWrites = Math.max(this.maximumActiveWrites, this.activeWrites)
    await Promise.resolve()
    this.bytes = bytes.slice()
    this.activeWrites -= 1
  }
  async readFence() { return this.fence || null }
  async compareAndSwapFence(expected: number, next: number) {
    if (this.fence !== expected || next !== expected + 1) throw new OpenCodeLaunchJournalError('fenced', 'CAS mismatch')
    this.fence = next
  }
  async acquireExclusive(
    _context: OpenCodeLaunchStoreContext,
  ): Promise<(context?: OpenCodeLaunchStoreContext) => Promise<void>> { return async () => undefined }
  set(value: unknown) { this.bytes = new TextEncoder().encode(JSON.stringify(value)) }
  text() { return this.bytes ? new TextDecoder().decode(this.bytes) : '' }
}

describe('OpenCodeLaunchAttemptStore durable schema and fencing', () => {
  test('classifies native Windows directory durability errors without treating access denial as success', () => {
    expect(classifyOpenCodeDirectoryDurabilityError('win32', 'EINVAL')).toBe('explicitly_unsupported')
    expect(classifyOpenCodeDirectoryDurabilityError('win32', 'ENOTSUP')).toBe('explicitly_unsupported')
    expect(classifyOpenCodeDirectoryDurabilityError('win32', 'EISDIR')).toBe('explicitly_unsupported')
    expect(classifyOpenCodeDirectoryDurabilityError('win32', 'EACCES')).toBe('durability_failure')
    expect(classifyOpenCodeDirectoryDurabilityError('win32', 'EPERM')).toBe('durability_failure')
    expect(classifyOpenCodeDirectoryDurabilityError('win32', 'EBADF')).toBe('durability_failure')
    expect(classifyOpenCodeDirectoryDurabilityError('win32', 'EIO')).toBe('durability_failure')
  })

  test('derives the secure namespace with the injected host path strategy and no descriptor filesystem', async () => {
    expect(deriveOpenCodeLaunchNamespacePaths('/var/app/attempt.json', posix)).toMatchObject({
      directory: '/var/app', trustedRoot: '/',
    })
    expect(deriveOpenCodeLaunchNamespacePaths('C:\\App\\attempt.json', win32)).toMatchObject({
      directory: 'C:\\App',
    })
    expect(deriveOpenCodeLaunchNamespacePaths('C:\\App\\attempt.json', win32).lock.toLowerCase())
      .toBe(deriveOpenCodeLaunchNamespacePaths('c:\\app\\ATTEMPT.json', win32).lock.toLowerCase())
    expect(await readFile(new URL('./OpenCodeLaunchAttemptStore.ts', import.meta.url), 'utf8'))
      .not.toContain('/proc/')
  })
  test('atomically persists a mode-0600 file and leaves no temporary journal', async () => {
    const directory = await workspaceTemp('journal')
    const path = join(directory, 'attempt.json')
    try {
      const persistence = new OpenCodeLaunchFileJournalPersistence(path)
      await persistence.replaceAndSync(new TextEncoder().encode('{"version":1}'))
      expect(new TextDecoder().decode((await persistence.read())!)).toBe('{"version":1}')
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect((await readdir(directory)).sort()).toEqual(['attempt.json', 'attempt.json.slot0'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('fresh install creates and fsyncs a canonical mode-0700 journal directory', async () => {
    const root = await workspaceTemp('fresh-directory')
    const directory = join(root, 'opencode', 'launch-attempts')
    try {
      const persistence = new OpenCodeLaunchFileJournalPersistence(join(directory, 'attempt.json'))
      await persistence.replaceAndSync(new TextEncoder().encode('{"version":1}'))
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect(new TextDecoder().decode((await persistence.read())!)).toBe('{"version":1}')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('never loads a generation-1 candidate that completes after the generation-2 marker', async () => {
    const directory = await workspaceTemp('late-candidate')
    const path = join(directory, 'attempt.json')
    const persistence = new OpenCodeLaunchFileJournalPersistence(path)
    const generationOne = new TextEncoder().encode('{"generation":1}')
    const generationTwo = new TextEncoder().encode('{"generation":2}')
    try {
      await persistence.replaceAndSync(generationOne)
      await persistence.replaceAndSync(generationTwo)
      // Generation 1 selected slot 0 before generation 2 committed slot 1. Its late physical
      // completion can overwrite only its candidate; the separate marker remains authoritative.
      await writeFile(`${path}.slot0`, generationOne, { mode: 0o600 })
      expect(new TextDecoder().decode((await persistence.read())!)).toBe('{"generation":2}')

      // Even corruption of the marked slot fails closed rather than making stale bytes loadable.
      await writeFile(`${path}.slot1`, generationOne, { mode: 0o600 })
      await expect(persistence.read()).rejects.toMatchObject({ code: 'corrupt' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test('fails closed when the canonical journal target is a symlink', async () => {
    const directory = await workspaceTemp('target-symlink')
    const target = join(directory, 'target.json')
    const path = join(directory, 'attempt.json')
    try {
      await new OpenCodeLaunchFileJournalPersistence(target).replaceAndSync(new TextEncoder().encode('{}'))
      await symlink(target, path)
      const context = { deadlineAtMs: Date.now() + 1_000, monotonicNow: Date.now, signal: new AbortController().signal }
      await expect(new OpenCodeLaunchAttemptStore(new OpenCodeLaunchFileJournalPersistence(path))
        .inspect(identity, context)).rejects.toMatchObject({ code: 'foreign' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test('compares retained and visible identity when O_NOFOLLOW is unavailable', async () => {
    const directory = await workspaceTemp('read-fallback-swap')
    const path = join(directory, 'attempt.json')
    const foreign = join(directory, 'foreign.json')
    const displaced = join(directory, 'attempt-original.json')
    try {
      await writeFile(foreign, '{"foreign":true}', { mode: 0o600 })
      const writer = new OpenCodeLaunchFileJournalPersistence(path)
      await writer.replaceAndSync(new TextEncoder().encode('{"version":1}'))
      let swapped = false
      const reader = new OpenCodeLaunchFileJournalPersistence(path, {
        readNoFollowAvailable: false,
        afterReadHandleOpened: async openedPath => {
          if (openedPath !== path || swapped) return
          swapped = true
          await rename(path, displaced)
          await symlink(foreign, path)
        },
      })
      await expect(reader.read()).rejects.toMatchObject({ code: 'foreign' })
      expect(swapped).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test('persists paired intent/applied linkage with immutable attempt, generation and fence', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    await store.withGeneration(identity, 'begin', async lease => {
      const claimToken = await lease.claim(member)
      await lease.append({ type: 'member_applied', memberIdentity: member, linkage, claimToken })
    })
    const journal = await store.inspect(identity)
    expect(journal).toMatchObject({ version: 1, ...identity, generation: 1, fence: 1 })
    expect(journal?.events.map(event => [event.sequence, event.generation, event.fence, event.type])).toEqual([
      [1, 1, 1, 'member_intent'], [2, 1, 1, 'member_applied'],
    ])
    expect(persistence.maximumActiveWrites).toBe(1)
  })

  test('serializes concurrent generation writers and gives continuation a new fence', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    const order: string[] = []
    let release!: () => void
    let authorize!: (token: string) => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const authorization = new Promise<string>(resolve => { authorize = resolve })
    const first = store.withGeneration(identity, 'begin', async lease => {
      order.push(`begin:${lease.generation}:${lease.fence}`)
      authorize(await lease.issueContinuation([member]))
      await gate
      await lease.append({ type: 'member_intent', memberIdentity: member })
      order.push('begin:end')
    })
    const second = authorization.then(continuationToken => store.withGeneration({ ...identity,
      inputDigest: 'b'.repeat(64), generation: 2, continuationToken }, 'continue', async lease => {
      order.push(`continue:${lease.generation}:${lease.fence}`)
    }))
    while (order.length === 0) await Promise.resolve()
    expect(order).toEqual(['begin:1:1'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['begin:1:1', 'begin:end', 'continue:2:2'])
    expect((await store.inspect({ ...identity, inputDigest: 'b'.repeat(64) }))?.generation).toBe(2)
  })

  test('issues a journal-random capability bound to the exact ordered set and consumes it only once for generation two', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    const secondMember = oid('5')
    await store.withGeneration({ ...identity, inputDigest: '1'.repeat(64), immutableDigest: '2'.repeat(64) },
      'begin', async lease => {
        const token = await lease.issueContinuation([member, secondMember])
        expect(token).toMatch(/^opencode-launch-continuation-v1\.[A-Za-z0-9_-]{43}$/)
        expect(await lease.issueContinuation([member, secondMember])).toBe(token)
        await expect(lease.issueContinuation([secondMember, member])).rejects.toMatchObject({ code: 'fenced' })
      })
    const issued = (await store.inspect(identity))!.continuation!
    expect(issued.eligibleMemberIdentities).toEqual([member, secondMember])
    await expect(store.withGeneration({ ...identity, inputDigest: '3'.repeat(64), immutableDigest: '2'.repeat(64),
      generation: 2, continuationToken: 'opencode-launch-continuation-v1.forged' }, 'continue', async () => undefined))
      .rejects.toMatchObject({ code: 'fenced' })

    await store.withGeneration({ ...identity, inputDigest: '3'.repeat(64), immutableDigest: '2'.repeat(64),
      generation: 2, continuationToken: issued.token }, 'continue', async lease => {
      expect(lease.continuationEligibleMemberIdentities).toEqual([member, secondMember])
    })
    await expect(store.withGeneration({ ...identity, inputDigest: '4'.repeat(64), immutableDigest: '2'.repeat(64),
      generation: 2, continuationToken: issued.token }, 'continue', async () => undefined))
      .rejects.toMatchObject({ code: 'foreign' })
    await expect(store.withGeneration({ ...identity, inputDigest: '3'.repeat(64), immutableDigest: '2'.repeat(64),
      generation: 2, continuationToken: 'opencode-launch-continuation-v1.changed' }, 'continue', async () => undefined))
      .rejects.toMatchObject({ code: 'fenced' })
    await store.withGeneration({ ...identity, inputDigest: '3'.repeat(64), immutableDigest: '2'.repeat(64),
      generation: 2, continuationToken: issued.token }, 'continue', async lease => {
      expect(await lease.issueContinuation([secondMember])).not.toBe(issued.token)
    })
  })

  test('durably binds profile/config/auth/binary/plugin/cache identities across continuation', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    const binding = {
      profileIdentity: oid('a'), pluginPolicyIdentity: oid('b'), cacheIdentity: oid('c'),
      authIdentity: oid('d'), configIdentity: oid('e'), binaryIdentity: oid('f'),
    }
    await store.withGeneration({ ...identity, inputDigest: '1'.repeat(64), immutableDigest: '2'.repeat(64) },
      'begin', lease => lease.bindProfile(binding))
    const continuationToken = await issueContinuation(store,
      { ...identity, inputDigest: '1'.repeat(64), immutableDigest: '2'.repeat(64), generation: 1 })
    await expect(store.withGeneration({ ...identity, inputDigest: '3'.repeat(64), immutableDigest: '2'.repeat(64),
      generation: 2, continuationToken },
      'continue', lease => lease.bindProfile({ ...binding, authIdentity: oid('0') })))
      .rejects.toMatchObject({ code: 'foreign' })
    expect((await store.inspect(identity))?.profileBinding).toEqual(binding)
  })

  test('rejects a detached writer after its coordinated generation lease ends', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    let stale!: OpenCodeLaunchJournalLease
    await store.withGeneration(identity, 'begin', async lease => { stale = lease })
    const continuationToken = await issueContinuation(store, identity)
    await store.withGeneration({ ...identity, inputDigest: 'b'.repeat(64), generation: 2,
      continuationToken }, 'continue', async () => undefined)
    await expect(stale.append({ type: 'member_intent', memberIdentity: member })).rejects.toMatchObject({
      code: 'fenced',
    })
    expect((await store.inspect({ ...identity, inputDigest: 'b'.repeat(64) }))?.events).toEqual([])
  })

  test.each([
    ['invalid JSON', new TextEncoder().encode('{')],
    ['oversized', new Uint8Array(OPEN_CODE_LAUNCH_JOURNAL_MAX_BYTES + 1)],
    ['foreign attempt', new TextEncoder().encode(JSON.stringify({
      version: 1, attemptId: '123e4567-e89b-42d3-a456-426614174001', payloadHash: identity.payloadHash,
      startedAtMs: 0, totalBudgetMs: 10_000, generation: 1, fence: 1, events: [],
    }))],
  ])('fails closed for %s journal', async (_name, bytes) => {
    const persistence = new MemoryPersistence(); persistence.bytes = bytes
    await expect(new OpenCodeLaunchAttemptStore(persistence).inspect(identity)).rejects.toBeInstanceOf(
      OpenCodeLaunchJournalError,
    )
  })

  test('publishes final response and conservative cleanup truth in one durable transition', async () => {
    const persistence = new MemoryPersistence()
    const observed: Array<Record<string, unknown>> = []
    const replace = persistence.replaceAndSync.bind(persistence)
    persistence.replaceAndSync = async bytes => {
      observed.push(JSON.parse(new TextDecoder().decode(bytes)))
      await replace(bytes)
    }
    const store = new OpenCodeLaunchAttemptStore(persistence)
    const exact = { ...identity, inputDigest: 'e'.repeat(64), immutableDigest: 'f'.repeat(64) }
    const response = finalResponse()
    await store.withGeneration(exact, 'begin', lease =>
      lease.commitTerminalResponse(response, 'incomplete'))
    const terminalCandidates = observed.filter(candidate => candidate.finalResponse !== undefined)
    expect(terminalCandidates).toHaveLength(1)
    expect(terminalCandidates[0]?.cleanupState).toBe('incomplete')
    expect((await store.inspect(exact))).toMatchObject({
      cleanupState: 'incomplete', finalResponse: response,
    })
  })

  test.each([
    ['cleanup before rejected final publication', 'cleanup-first'],
    ['rejected final publication before retained cleanup', 'final-first'],
  ] as const)('preserves a publish-then-reject immutable final across %s', async (_name, order) => {
    const persistence = new MemoryPersistence()
    const replace = persistence.replaceAndSync.bind(persistence)
    let rejectPublishedFinal = true
    persistence.replaceAndSync = async bytes => {
      await replace(bytes)
      const candidate = JSON.parse(new TextDecoder().decode(bytes))
      if (candidate.finalResponse && rejectPublishedFinal) {
        rejectPublishedFinal = false
        throw new Error('deterministic publish-then-reject')
      }
    }
    const store = new OpenCodeLaunchAttemptStore(persistence)
    const exactIdentity = { ...identity, inputDigest: 'e'.repeat(64), immutableDigest: 'f'.repeat(64) }
    const publishedFinal = finalResponse()
    publishedFinal.launchAttempt.requestCorrelationDigest = '1'.repeat(64)
    publishedFinal.proof!.requestCorrelationDigest = '1'.repeat(64)
    let releaseCleanup!: () => void
    const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve })
    let deferredCleanup!: Promise<void>
    const running = store.withGeneration(exactIdentity, 'begin', async lease => {
      const claimToken = await lease.claim(member)
      await lease.append({ type: 'member_unknown', memberIdentity: member, claimToken })
      deferredCleanup = cleanupGate.then(() => lease.append({
        type: 'cleanup', memberIdentity: member, outcome: 'timed_out', claimToken,
      }))
      lease.retainUntilPhysicalSettlement(deferredCleanup)
      if (order === 'cleanup-first') {
        releaseCleanup()
        await deferredCleanup
      }
      await expect(lease.commitFinalResponse(publishedFinal))
        .rejects.toThrow('deterministic publish-then-reject')
      if (order === 'final-first') releaseCleanup()
    })
    await expect(running).rejects.toThrow('deterministic publish-then-reject')
    await deferredCleanup

    const durable = JSON.parse(persistence.text())
    expect(durable.finalResponse).toEqual(publishedFinal)
    expect(durable.events.at(-1)).toMatchObject({ type: 'cleanup', outcome: 'timed_out' })

    const restarted = new OpenCodeLaunchAttemptStore(persistence)
    expect((await restarted.inspect(exactIdentity))?.finalResponse).toEqual(publishedFinal)
    await restarted.withGeneration(exactIdentity, 'replay', async lease => {
      expect(lease.journal.finalResponse).toEqual(publishedFinal)
      const changed = structuredClone(publishedFinal)
      changed.launchAttempt.elapsedMs = 9_999
      await expect(lease.commitFinalResponse(changed)).rejects.toThrow('final response changed')
    })
    expect(JSON.parse(persistence.text())).toEqual(durable)
  })

  test('poisons an unobservable publish-then-throw final and fences retained cleanup from stale overwrite', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    const exactIdentity = { ...identity, inputDigest: 'e'.repeat(64), immutableDigest: 'f'.repeat(64) }
    await store.withGeneration(exactIdentity, 'begin', async () => undefined)
    const replace = persistence.replaceAndSync.bind(persistence)
    const read = persistence.read.bind(persistence)
    let makeObservationUnobservable = false
    persistence.replaceAndSync = async bytes => {
      await replace(bytes)
      const candidate = JSON.parse(new TextDecoder().decode(bytes))
      if (candidate.finalResponse) {
        makeObservationUnobservable = true
        throw new Error('publish succeeded but sync result was ambiguous')
      }
    }
    persistence.read = async () => {
      if (makeObservationUnobservable) {
        makeObservationUnobservable = false
        throw new Error('publication winner is unobservable')
      }
      return read()
    }
    let releaseCleanup!: () => void
    const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve })
    let retainedCleanup!: Promise<void>
    const publishedFinal = finalResponse()
    await expect(store.withGeneration(exactIdentity, 'begin', async lease => {
      const claimToken = await lease.claim(member)
      await lease.append({ type: 'member_unknown', memberIdentity: member, claimToken })
      retainedCleanup = cleanupGate.then(() => lease.append({
        type: 'cleanup', memberIdentity: member, outcome: 'timed_out', claimToken,
      }))
      lease.retainUntilPhysicalSettlement(retainedCleanup)
      await lease.commitFinalResponse(publishedFinal)
    })).rejects.toBeInstanceOf(OpenCodeLaunchPoisonedLeaseError)

    const published = JSON.parse(persistence.text())
    expect(published.finalResponse).toEqual(publishedFinal)
    expect(published.events.at(-1)).toMatchObject({ type: 'member_unknown' })
    releaseCleanup()
    await expect(retainedCleanup).rejects.toMatchObject({ code: 'fenced' })
    expect(JSON.parse(persistence.text())).toEqual(published)
    expect((await new OpenCodeLaunchAttemptStore(persistence).inspect(exactIdentity))?.finalResponse)
      .toEqual(publishedFinal)
  })

  test('rejects unpaired, noncanonical, duplicate and unknown-field records', async () => {
    const badEvents = [
      [{ type: 'member_applied', sequence: 1, generation: 1, fence: 1, memberIdentity: member, linkage }],
      [{ type: 'member_intent', sequence: 1, generation: 1, fence: 1, memberIdentity: 'member-raw' }],
      [
        { type: 'member_intent', sequence: 1, generation: 1, fence: 1, memberIdentity: member },
        { type: 'member_intent', sequence: 2, generation: 1, fence: 1, memberIdentity: member },
      ],
      [{ type: 'member_intent', sequence: 1, generation: 1, fence: 1, memberIdentity: member,
        prompt: 'do not persist me' }],
    ]
    for (const events of badEvents) {
      const persistence = new MemoryPersistence()
      persistence.set({ version: 1, ...identity, startedAtMs: 0, totalBudgetMs: 10_000,
        generation: 1, fence: 1, events })
      await expect(new OpenCodeLaunchAttemptStore(persistence).inspect(identity)).rejects.toBeInstanceOf(
        OpenCodeLaunchJournalError,
      )
    }
  })

  test('whitelist schema excludes recursive secret/path/URL/provider-body/prompt/response corpus', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    await store.withGeneration(identity, 'begin', async lease => {
      const claimToken = await lease.claim(member)
      await lease.append({ type: 'member_applied', memberIdentity: member, linkage, claimToken })
    })
    const serialized = persistence.text().toLowerCase()
    for (const forbidden of [
      'secret', 'credential', 'bearer', 'api_key', '/users/', '/root/', 'https://', 'wss://',
      'endpoint', 'providerbody', 'prompt', 'response',
    ]) expect(serialized).not.toContain(forbidden)

    const parsed = JSON.parse(serialized)
    parsed.events[0].nested = { authorization: 'Bearer abc', path: '/root/private', url: 'https://bad' }
    persistence.set(parsed)
    await expect(store.inspect(identity)).rejects.toBeInstanceOf(OpenCodeLaunchJournalError)
  })

  test('does not publish or reuse a failed durable candidate', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    let stale!: OpenCodeLaunchJournalLease
    await expect(store.withGeneration(identity, 'begin', async lease => {
      stale = lease
      const replace = persistence.replaceAndSync.bind(persistence)
      persistence.replaceAndSync = async () => { throw new Error('ambiguous fsync') }
      await lease.append({ type: 'member_intent', memberIdentity: member })
      persistence.replaceAndSync = replace
    })).rejects.toThrow('ambiguous fsync')
    expect(JSON.parse(persistence.text()).events).toEqual([])
    await expect(stale.append({ type: 'member_intent', memberIdentity: member })).rejects.toMatchObject({ code: 'fenced' })
    expect(persistence.fence).toBe(1)
    expect(await new OpenCodeLaunchAttemptStore(persistence).inspect(identity)).toMatchObject({ events: [] })
  })

  test('keeps the lease through a delayed physical replacement so generation 1 cannot complete after generation 2', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    await store.withGeneration(identity, 'begin', async () => undefined)
    const continuationToken = await issueContinuation(store, identity)
    let releasePhysical!: () => void
    let physicalEntered!: () => void
    const entered = new Promise<void>(resolve => { physicalEntered = resolve })
    const gate = new Promise<void>(resolve => { releasePhysical = resolve })
    const replace = persistence.replaceAndSync.bind(persistence)
    let delayNext = true
    persistence.replaceAndSync = async bytes => {
      if (delayNext) { delayNext = false; physicalEntered(); await gate }
      await replace(bytes)
    }
    let generationTwoEntered = false
    const first = store.withGeneration(identity, 'begin', lease =>
      lease.append({ type: 'member_intent', memberIdentity: member }))
    await entered
    const second = store.withGeneration({ ...identity, inputDigest: 'b'.repeat(64), generation: 2,
      continuationToken }, 'continue', async () => {
      generationTwoEntered = true
    })
    await Promise.resolve()
    expect(generationTwoEntered).toBe(false)
    releasePhysical()
    await Promise.all([first, second])
    expect((await store.inspect({ ...identity, inputDigest: 'b'.repeat(64) }))).toMatchObject({
      generation: 2, fence: 2,
    })
  })

  test('keeps a same-generation publish-then-throw candidate replayable', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    await store.withGeneration(identity, 'begin', async () => undefined)
    const replace = persistence.replaceAndSync.bind(persistence)
    persistence.replaceAndSync = async bytes => { await replace(bytes); throw new Error('post-publish fsync ambiguity') }
    await expect(store.withGeneration(identity, 'begin', lease =>
      lease.append({ type: 'member_intent', memberIdentity: member }))).rejects.toThrow('post-publish fsync ambiguity')
    expect(persistence.fence).toBe(1)
    expect(await store.inspect(identity)).toMatchObject({ events: [{ type: 'member_intent' }] })
  })

  test('does not require a quarantine fence for a settled same-generation replacement error', async () => {
    const persistence = new MemoryPersistence()
    let releases = 0
    persistence.acquireExclusive = async () => async () => { releases += 1 }
    const store = new OpenCodeLaunchAttemptStore(persistence)
    await store.withGeneration(identity, 'begin', async () => undefined)
    const replace = persistence.replaceAndSync.bind(persistence)
    persistence.replaceAndSync = async bytes => { await replace(bytes); throw new Error('ambiguous replacement') }
    persistence.compareAndSwapFence = async () => { throw new Error('fence unavailable') }
    await expect(store.withGeneration(identity, 'begin', lease =>
      lease.append({ type: 'member_intent', memberIdentity: member }))).rejects.toThrow('ambiguous replacement')
    expect(releases).toBe(2)
    expect(await store.inspect(identity)).toMatchObject({ events: [{ type: 'member_intent' }] })
  })

  test('accepts a journal-first generation when fence CAS publishes then throws', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    await store.withGeneration(identity, 'begin', async () => undefined)
    const continuationToken = await issueContinuation(store, identity)
    const compare = persistence.compareAndSwapFence.bind(persistence)
    let ambiguous = true
    persistence.compareAndSwapFence = async (expected, next) => {
      await compare(expected, next)
      if (ambiguous) { ambiguous = false; throw new Error('fence fsync ambiguity') }
    }
    await store.withGeneration({ ...identity, inputDigest: 'b'.repeat(64), generation: 2,
      continuationToken },
      'continue', async () => undefined)
    expect(persistence.fence).toBe(2)
    expect(JSON.parse(persistence.text())).toMatchObject({ generation: 2, fence: 2 })
    expect(await store.inspect({ ...identity, inputDigest: 'b'.repeat(64) })).toMatchObject({ generation: 2 })
  })

  test('read-only snapshot accepts journal-first anchor state without lease, repair, or publication', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    await store.withGeneration(identity, 'begin', async () => undefined)
    const before = persistence.bytes!.slice()
    persistence.fence = 0
    let acquisitions = 0
    let replacements = 0
    let fenceWrites = 0
    persistence.acquireExclusive = async () => {
      acquisitions += 1
      return async () => undefined
    }
    persistence.replaceAndSync = async () => { replacements += 1 }
    persistence.compareAndSwapFence = async () => { fenceWrites += 1 }

    expect(await store.snapshotReadOnly(identity)).toMatchObject({ generation: 1, fence: 1 })
    expect({ acquisitions, replacements, fenceWrites, fence: persistence.fence })
      .toEqual({ acquisitions: 0, replacements: 0, fenceWrites: 0, fence: 0 })
    expect(persistence.bytes).toEqual(before)
  })

  test('recovers a complete same-generation journal without consulting the fence CAS', async () => {
    const persistence = new MemoryPersistence()
    let releases = 0
    persistence.acquireExclusive = async () => async () => { releases += 1 }
    const store = new OpenCodeLaunchAttemptStore(persistence)
    await store.withGeneration(identity, 'begin', async () => undefined)
    const replace = persistence.replaceAndSync.bind(persistence)
    persistence.replaceAndSync = async bytes => { await replace(bytes); throw new Error('journal fsync ambiguity') }
    const compare = persistence.compareAndSwapFence.bind(persistence)
    persistence.compareAndSwapFence = async (expected, next) => {
      await compare(expected, next)
      throw new Error('quarantine fsync ambiguity')
    }
    await expect(store.withGeneration(identity, 'begin', lease =>
      lease.append({ type: 'member_intent', memberIdentity: member }))).rejects.toThrow('journal fsync ambiguity')
    expect(persistence.fence).toBe(1)
    expect(releases).toBe(2)
  })

  test('cannot report success after a swallowed settled append failure', async () => {
    const persistence = new MemoryPersistence()
    let releases = 0
    persistence.acquireExclusive = async () => async () => { releases += 1 }
    const store = new OpenCodeLaunchAttemptStore(persistence)
    await store.withGeneration(identity, 'begin', async () => undefined)
    const replace = persistence.replaceAndSync.bind(persistence)
    persistence.replaceAndSync = async bytes => { await replace(bytes); throw new Error('ambiguous replacement') }
    persistence.compareAndSwapFence = async () => { throw new Error('fence unavailable') }
    await expect(store.withGeneration(identity, 'begin', async lease => {
      await lease.append({ type: 'member_intent', memberIdentity: member }).catch(() => undefined)
      return 'incorrect-success'
    })).rejects.toThrow('ambiguous replacement')
    expect(releases).toBe(2)
  })

  test.each([
    ['cleanup candidate, final publish, cleanup resume', 'event'],
    ['final candidate, cleanup publish, final resume', 'finalResponse'],
  ] as const)('serializes stale same-lease %s without erasing durable authority', async (_name, pausedKind) => {
    const persistence = new MemoryPersistence()
    let armed = false
    let captured!: () => void
    let resume!: () => void
    const atCandidate = new Promise<void>(resolve => { captured = resolve })
    const candidateGate = new Promise<void>(resolve => { resume = resolve })
    const store = new OpenCodeLaunchAttemptStore(persistence, {
      afterMutationCandidateCaptured: async kind => {
        if (armed && kind === pausedKind) { armed = false; captured(); await candidateGate }
      },
    })
    const exactIdentity = { ...identity, inputDigest: 'e'.repeat(64), immutableDigest: 'f'.repeat(64) }
    const publishedFinal = finalResponse()
    let detachedAppend!: () => Promise<void>
    await store.withGeneration(exactIdentity, 'begin', async lease => {
      const claimToken = await lease.claim(member)
      await lease.append({ type: 'member_unknown', memberIdentity: member, claimToken })
      detachedAppend = () => lease.append({ type: 'cleanup', memberIdentity: member,
        outcome: 'timed_out', claimToken })
      armed = true
      const cleanup = detachedAppend()
      const commitFinal = lease.commitFinalResponse(publishedFinal)
      await atCandidate
      if (pausedKind === 'event') await commitFinal
      else await cleanup
      resume()
      await Promise.all([cleanup, commitFinal])
    })

    const durable = JSON.parse(persistence.text())
    expect(durable.finalResponse).toEqual(publishedFinal)
    expect(durable.events.map((event: any) => event.type)).toEqual([
      'member_intent', 'member_unknown', 'cleanup',
    ])
    expect(durable.events.at(-1)).toMatchObject({ outcome: 'timed_out', sequence: 3 })
    await expect(detachedAppend()).rejects.toMatchObject({ code: 'fenced' })
    expect(JSON.parse(persistence.text())).toEqual(durable)

    const restarted = new OpenCodeLaunchAttemptStore(persistence)
    expect(await restarted.inspect(exactIdentity)).toEqual(durable)
    await restarted.withGeneration(exactIdentity, 'replay', async lease => {
      expect(lease.journal.finalResponse).toEqual(publishedFinal)
      expect(lease.journal.events.at(-1)).toMatchObject({ type: 'cleanup', outcome: 'timed_out' })
    })
  })

  test('rejects fence-anchor rollback, anchor-without-journal, and impossible top-level layouts', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    await store.withGeneration(identity, 'begin', async () => undefined)
    persistence.fence = 2
    await expect(store.inspect(identity)).rejects.toMatchObject({ code: 'fenced' })
    persistence.bytes = null
    await expect(store.inspect(identity)).rejects.toMatchObject({ code: 'fenced' })
    persistence.set({ version: 1, ...identity, inputDigest: identity.payloadHash,
      startedAtMs: 0, totalBudgetMs: 300_000, generation: 1, fence: 2, events: [] })
    await expect(store.inspect(identity)).rejects.toMatchObject({ code: 'corrupt' })
  })

  test('allows authoritative reconciled-applied after an earlier-generation intent but fences invalid absent retry', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    let claimToken = ''
    await store.withGeneration(identity, 'begin', async lease => { claimToken = await lease.claim(member) })
    const continuationToken = await issueContinuation(store, identity)
    await store.withGeneration({ ...identity, inputDigest: 'b'.repeat(64), generation: 2,
      continuationToken }, 'continue', lease =>
      lease.reconcile({ type: 'member_reconciled_applied', memberIdentity: member, linkage, claimToken }))
    expect((await store.inspect({ ...identity, inputDigest: 'b'.repeat(64) }))?.events.at(-1)?.type)
      .toBe('member_reconciled_applied')

    const invalid = new MemoryPersistence()
    invalid.fence = 2
    invalid.set({ version: 1, ...identity, inputDigest: 'b'.repeat(64), startedAtMs: 0,
      totalBudgetMs: 300_000, generation: 2, fence: 2, events: [
        { type: 'member_intent', sequence: 1, generation: 1, fence: 1, memberIdentity: member },
        { type: 'member_failed', sequence: 2, generation: 1, fence: 1, memberIdentity: member,
          failure: 'rate_limited', externalEffect: false },
        { type: 'member_reconciled_absent', sequence: 3, generation: 2, fence: 2, memberIdentity: member },
      ] })
    await expect(new OpenCodeLaunchAttemptStore(invalid).inspect({ ...identity, inputDigest: 'b'.repeat(64) }))
      .rejects.toMatchObject({ code: 'corrupt' })
  })

  test('rejects symlinked parent namespaces before either retarget can acquire a split lock', async () => {
    const directory = await workspaceTemp('parent-symlink')
    const first = join(directory, 'first')
    const second = join(directory, 'second')
    const alias = join(directory, 'alias')
    await mkdir(first); await mkdir(second); await symlink(first, alias)
    const context = { deadlineAtMs: Date.now() + 10_000, monotonicNow: Date.now,
      signal: new AbortController().signal }
    try {
      await expect(new OpenCodeLaunchFileJournalPersistence(join(alias, 'attempt.json')).acquireExclusive(context))
        .rejects.toMatchObject({ code: 'foreign' })
      await rm(alias); await symlink(second, alias)
      await expect(new OpenCodeLaunchFileJournalPersistence(join(alias, 'attempt.json')).acquireExclusive(context))
        .rejects.toMatchObject({ code: 'foreign' })
      expect(await readdir(first)).toEqual([])
      expect(await readdir(second)).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test.skipIf(process.platform === 'win32')('fences a retained final directory and blocks a second store on the stable logical-path anchor', async () => {
    const outer = await workspaceTemp('final-swap-anchor')
    const parent = join(outer, 'parent')
    const live = join(parent, 'live')
    const retained = join(parent, 'retained')
    await mkdir(live, { recursive: true })
    const path = join(live, 'attempt.json')
    const context = { deadlineAtMs: Date.now() + 10_000, monotonicNow: Date.now,
      signal: new AbortController().signal }
    let entered!: () => void
    const acquired = new Promise<void>(resolve => { entered = resolve })
    let resume!: () => void
    const gate = new Promise<void>(resolve => { resume = resolve })
    let secondEntered = false
    try {
      const first = new OpenCodeLaunchAttemptStore(new OpenCodeLaunchFileJournalPersistence(path))
      const running = first.withGeneration(identity, 'begin', async lease => {
        entered(); await gate
        await lease.append({ type: 'member_intent', memberIdentity: member })
      }, context)
      await acquired
      await rename(live, retained); await mkdir(live)

      const contenderController = new AbortController()
      const contenderContext = { ...context, signal: contenderController.signal }
      let contenderAnchored!: () => void
      const anchored = new Promise<void>(resolve => { contenderAnchored = resolve })
      let secondSettled = false
      const second = new OpenCodeLaunchAttemptStore(new OpenCodeLaunchFileJournalPersistence(path, {
        afterNamespaceAnchored: async () => { contenderAnchored() },
      }))
        .withGeneration(identity, 'begin', async () => { secondEntered = true }, contenderContext)
      void second.then(() => { secondSettled = true }, () => { secondSettled = true })
      await anchored; await Bun.sleep(20)
      expect(secondSettled).toBe(false)
      contenderController.abort(new Error('stop contender'))
      await expect(second).rejects.toThrow('stop contender')
      expect(secondEntered).toBe(false)

      resume()
      await expect(running).rejects.toMatchObject({ code: 'fenced' })
      await expect(new OpenCodeLaunchAttemptStore(new OpenCodeLaunchFileJournalPersistence(path))
        .inspect(identity, context)).rejects.toMatchObject({ code: 'fenced' })

      await rm(live, { recursive: true }); await rename(retained, live)
      expect(await new OpenCodeLaunchAttemptStore(new OpenCodeLaunchFileJournalPersistence(path))
        .inspect(identity, context)).toMatchObject({ generation: 1, fence: 1 })
    } finally { await rm(outer, { recursive: true, force: true }) }
  })

  test.skipIf(process.platform === 'win32')('fences a parent swap, survives rename-back, and continues after store restart', async () => {
    const outer = await workspaceTemp('parent-swap-restart')
    const parent = join(outer, 'parent')
    const final = join(parent, 'final')
    const displaced = join(outer, 'displaced')
    await mkdir(final, { recursive: true })
    const path = join(final, 'attempt.json')
    const context = { deadlineAtMs: Date.now() + 10_000, monotonicNow: Date.now,
      signal: new AbortController().signal }
    const liveIdentity = { ...identity, startedAtMs: Date.now() }
    let entered!: () => void
    const acquired = new Promise<void>(resolve => { entered = resolve })
    let resume!: () => void
    const gate = new Promise<void>(resolve => { resume = resolve })
    try {
      const running = new OpenCodeLaunchAttemptStore(new OpenCodeLaunchFileJournalPersistence(path))
        .withGeneration(liveIdentity, 'begin', async lease => {
          await lease.issueContinuation([member])
          entered(); await gate
          await lease.revalidate(member, 'not-a-claim', context)
        }, context)
      await acquired
      await rename(parent, displaced); await mkdir(final, { recursive: true })
      resume()
      await expect(running).rejects.toMatchObject({ code: 'fenced' })
      await expect(new OpenCodeLaunchAttemptStore(new OpenCodeLaunchFileJournalPersistence(path))
        .withGeneration(liveIdentity, 'begin', async () => undefined, context)).rejects.toMatchObject({ code: 'fenced' })

      await rm(parent, { recursive: true }); await rename(displaced, parent)
      const restarted = new OpenCodeLaunchAttemptStore(new OpenCodeLaunchFileJournalPersistence(path))
      const continuationToken = (await restarted.inspect(liveIdentity, context))!.continuation!.token
      await restarted.withGeneration({ ...liveIdentity, inputDigest: 'b'.repeat(64), generation: 2,
        continuationToken }, 'continue', async lease => {
        expect(lease).toMatchObject({ generation: 2, fence: 2 })
      }, context)
      expect(await restarted.inspect({ ...identity, inputDigest: 'b'.repeat(64) }, context))
        .toMatchObject({ generation: 2, fence: 2 })
    } finally { await rm(outer, { recursive: true, force: true }) }
  })

  test('reaps a crashed owner without admitting a recreated parent namespace', async () => {
    const outer = await workspaceTemp('parent-swap-crash')
    const parent = join(outer, 'parent')
    const final = join(parent, 'final')
    const displaced = join(outer, 'displaced')
    await mkdir(final, { recursive: true })
    const path = join(final, 'attempt.json')
    const context = { deadlineAtMs: Date.now() + 10_000, monotonicNow: Date.now,
      signal: new AbortController().signal }
    const liveIdentity = { ...identity, startedAtMs: Date.now() }
    try {
      await new OpenCodeLaunchAttemptStore(new OpenCodeLaunchFileJournalPersistence(path))
        .withGeneration(liveIdentity, 'begin', async () => undefined, context)
      const crashedOwner = { version: 1, pid: 2_147_483_647, processBirth: '1', token: crypto.randomUUID() }
      await mkdir(leasePath(path), { mode: 0o700 })
      await writeFile(join(leasePath(path), 'owner.json'), JSON.stringify(crashedOwner), { mode: 0o600 })

      await rename(parent, displaced); await mkdir(final, { recursive: true })
      await expect(new OpenCodeLaunchAttemptStore(new OpenCodeLaunchFileJournalPersistence(path))
        .inspect(liveIdentity, context)).rejects.toMatchObject({ code: 'fenced' })
      await expect(stat(leasePath(path))).rejects.toMatchObject({ code: 'ENOENT' })

      await rm(parent, { recursive: true }); await rename(displaced, parent)
      expect(await new OpenCodeLaunchAttemptStore(new OpenCodeLaunchFileJournalPersistence(path))
        .inspect(liveIdentity, context)).toMatchObject({ generation: 1, fence: 1 })
    } finally { await rm(outer, { recursive: true, force: true }) }
  })

  test('trusted-root platform backend preserves Windows first-use and rejects a swapped root', async () => {
    const outer = await workspaceTemp('trusted-root-backend')
    const live = join(outer, 'live')
    const displaced = join(outer, 'displaced')
    const path = join(live, 'attempt.json')
    try {
      const firstUse = new OpenCodeLaunchFileJournalPersistence(path, { platform: 'win32' })
      await firstUse.replaceAndSync(new TextEncoder().encode('{"windows":true}'))
      expect(new TextDecoder().decode((await firstUse.read())!)).toBe('{"windows":true}')

      let swapped = false
      const guarded = new OpenCodeLaunchFileJournalPersistence(path, {
        platform: 'win32',
        afterNamespaceAnchored: async () => {
          await rename(live, displaced); await mkdir(live); swapped = true
        },
      })
      await expect(guarded.read()).rejects.toMatchObject({ code: 'fenced' })
      expect(swapped).toBe(true)
      expect(await readdir(live)).toEqual([])
    } finally { await rm(outer, { recursive: true, force: true }) }
  })

  test('propagates one retained Windows authority session to relative member-claim persistence', async () => {
    const outer = await workspaceTemp('windows-relative-authority-contract')
    const data = join(outer, 'data')
    const opencode = join(data, 'opencode')
    const attempts = join(opencode, 'launch-attempts')
    const claims = join(attempts, 'member-claims')
    await mkdir(claims, { recursive: true })
    const openedRoots: string[] = []
    const relativePaths: string[] = []
    let factoryCalls = 0
    let closeCalls = 0
    let retainedRoot = ''
    const fakeAuthority = {
      async openRoot(root: string) {
        retainedRoot = root; openedRoots.push(root)
        const value = await lstat(root)
        return { volumeSerial: String(value.dev), fileId: String(value.ino), createdPaths: [] }
      },
      async namespaceStat(relativePath: string) {
        relativePaths.push(relativePath)
        const value = await lstat(relativePath === '.' ? retainedRoot : join(retainedRoot, relativePath))
        return { volumeSerial: String(value.dev), fileId: String(value.ino), size: String(value.size),
          kind: value.isDirectory() ? 'directory' as const : 'file' as const }
      },
      async namespaceOpen(relativePath: string) {
        relativePaths.push(relativePath)
        await lstat(join(retainedRoot, relativePath))
        throw new Error('contract fake opens no files')
      },
      async openChildDirectory(_parentKey: string, key: string) {
        relativePaths.push(`retain:${key}`)
        const value = await lstat(join(retainedRoot, key))
        return { volumeSerial: String(value.dev), fileId: String(value.ino) }
      },
      async close() { closeCalls += 1 },
    }
    const factory = (() => { factoryCalls += 1; return fakeAuthority }) as never
    try {
      const attempt = new OpenCodeLaunchFileJournalPersistence(join(attempts, 'attempt.journal'), {
        platform: 'win32', windowsAuthorityFactory: factory,
      })
      const claim = attempt.createRelativePersistence(join(claims, `${'a'.repeat(64)}.claim`))
      expect(await Promise.all([attempt.read(), claim.read()])).toEqual([null, null])
      expect(factoryCalls).toBe(1)
      expect(openedRoots).toEqual([data])
      expect(relativePaths).toContain('retain:opencode')
      expect(relativePaths).toContain('retain:opencode/launch-attempts/member-claims')
      expect(relativePaths).toContain('opencode/launch-attempts')
      expect(relativePaths).toContain('opencode/launch-attempts/member-claims')
      expect(relativePaths.every(value => !value.includes(outer))).toBe(true)
      expect(closeCalls).toBe(0)
    } finally { await rm(outer, { recursive: true, force: true }) }
  })

  test.skipIf(process.platform !== 'win32')('real Windows retains journal and coordination roots across the replacement boundary', async () => {
    const outer = await workspaceTemp('windows-retained-native-authority')
    const live = join(outer, 'data', 'opencode')
    const displaced = join(outer, 'displaced')
    const journal = join(live, 'launch-attempts', 'attempt.json')
    const startedAtMs = performance.now()
    const context = { deadlineAtMs: startedAtMs + 15_000,
      monotonicNow: performance.now.bind(performance), signal: new AbortController().signal }
    const liveIdentity = { ...identity, startedAtMs, totalBudgetMs: 15_000 }
    let replacementDenied = false
    try {
      const store = new OpenCodeLaunchAttemptStore(new OpenCodeLaunchFileJournalPersistence(journal, {
        afterNamespaceAnchored: async () => {
          try { await rename(live, displaced) }
          catch { replacementDenied = true }
        },
      }))
      await store.withGeneration(liveIdentity, 'begin', async lease => {
        await lease.append({ type: 'member_intent', memberIdentity: member }, context)
      }, context)
      expect(replacementDenied).toBe(true)
    } finally { await rm(outer, { recursive: true, force: true }) }
  })

  test('trusted-root Windows backend shares authority across a final-directory swap', async () => {
    const outer = await workspaceTemp('windows-two-store-anchor')
    const parent = join(outer, 'parent')
    const live = join(parent, 'live')
    const displaced = join(parent, 'displaced')
    await mkdir(live, { recursive: true })
    const path = join(live, 'attempt.json')
    const context = { deadlineAtMs: Date.now() + 10_000, monotonicNow: Date.now,
      signal: new AbortController().signal }
    const liveIdentity = { ...identity, startedAtMs: Date.now() }
    let entered!: () => void
    const acquired = new Promise<void>(resolve => { entered = resolve })
    let resume!: () => void
    const gate = new Promise<void>(resolve => { resume = resolve })
    let contenderEntered = false
    try {
      const running = new OpenCodeLaunchAttemptStore(new OpenCodeLaunchFileJournalPersistence(path, { platform: 'win32' }))
        .withGeneration(liveIdentity, 'begin', async lease => {
          entered(); await gate
          await lease.append({ type: 'member_intent', memberIdentity: member })
        }, context)
      await acquired
      await rename(live, displaced); await mkdir(live)
      const contenderController = new AbortController()
      const contenderContext = { ...context, signal: contenderController.signal }
      let contenderAnchored!: () => void
      const anchored = new Promise<void>(resolve => { contenderAnchored = resolve })
      let contenderSettled = false
      const contender = new OpenCodeLaunchAttemptStore(new OpenCodeLaunchFileJournalPersistence(path, {
        platform: 'win32', afterNamespaceAnchored: async () => { contenderAnchored() },
      })).withGeneration(liveIdentity, 'begin', async () => { contenderEntered = true }, contenderContext)
      void contender.then(() => { contenderSettled = true }, () => { contenderSettled = true })
      await anchored; await Bun.sleep(20)
      expect(contenderSettled).toBe(false)
      contenderController.abort(new Error('stop contender'))
      await expect(contender).rejects.toThrow('stop contender')
      expect(contenderEntered).toBe(false)
      resume()
      await expect(running).rejects.toMatchObject({ code: 'fenced' })
    } finally {
      resume?.()
      await rm(outer, { recursive: true, force: true })
    }
  })

  test('rejects a pre-planted lease symlink without reading or mutating its target namespace', async () => {
    const directory = await workspaceTemp('lease-symlink')
    const target = join(directory, 'target')
    const path = join(directory, 'attempt.json')
    await mkdir(target)
    await symlink(target, leasePath(path))
    const context = { deadlineAtMs: Date.now() + 1_000, monotonicNow: Date.now,
      signal: new AbortController().signal }
    try {
      await expect(new OpenCodeLaunchFileJournalPersistence(path).acquireExclusive(context))
        .rejects.toMatchObject({ code: 'foreign' })
      expect(await readdir(target)).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test('publishes a complete token and process-birth owner atomically and releases only its token', async () => {
    const directory = await workspaceTemp('owner')
    const path = join(directory, 'attempt.json')
    const context = { deadlineAtMs: Date.now() + 10_000, monotonicNow: Date.now,
      signal: new AbortController().signal }
    try {
      const release = await new OpenCodeLaunchFileJournalPersistence(path).acquireExclusive(context)
      const owner = JSON.parse(await readFile(join(leasePath(path), 'owner.json'), 'utf8'))
      expect(owner).toMatchObject({ version: 1, pid: process.pid })
      expect(owner.token).toMatch(/^[0-9a-f-]{36}$/)
      expect(owner.processBirth).toMatch(/^\d+$/)
      expect(await readdir(leasePath(path))).toEqual(['owner.json'])
      await release(context)
      const releaseAgain = await new OpenCodeLaunchFileJournalPersistence(path).acquireExclusive(context)
      expect(JSON.parse(await readFile(join(leasePath(path), 'owner.json'), 'utf8')).processBirth).toBe(owner.processBirth)
      await releaseAgain(context)
      expect(await readdir(directory)).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test('refuses to release a lock whose durable ownership token changed', async () => {
    const directory = await workspaceTemp('owner-token')
    const path = join(directory, 'attempt.json')
    const context = { deadlineAtMs: Date.now() + 10_000, monotonicNow: Date.now,
      signal: new AbortController().signal }
    try {
      const release = await new OpenCodeLaunchFileJournalPersistence(path).acquireExclusive(context)
      const ownerPath = join(leasePath(path), 'owner.json')
      const owner = JSON.parse(await readFile(ownerPath, 'utf8'))
      await writeFile(ownerPath, JSON.stringify({ ...owner, token: 'foreign-token' }), { mode: 0o600 })
      await expect(release(context)).rejects.toMatchObject({ code: 'fenced' })
      expect((await stat(leasePath(path))).isDirectory()).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test('revalidates the full retained owner tuple immediately before removing a lease', async () => {
    const directory = await workspaceTemp('release-reacquire-race')
    const path = join(directory, 'attempt.json')
    const context = { deadlineAtMs: Date.now() + 10_000, monotonicNow: Date.now,
      signal: new AbortController().signal }
    let mutateOwner!: () => void
    const mutationPoint = new Promise<void>(resolve => { mutateOwner = resolve })
    let mutationDone!: () => void
    const gate = new Promise<void>(resolve => { mutationDone = resolve })
    const first = new OpenCodeLaunchFileJournalPersistence(path, {
      beforeLeaseDirectoryRemove: async () => { mutateOwner(); await gate },
    })
    try {
      const releaseFirst = await first.acquireExclusive(context)
      const releasing = releaseFirst(context)
      await mutationPoint
      const ownerPath = join(leasePath(path), 'owner.json')
      const owner = JSON.parse(await readFile(ownerPath, 'utf8'))
      await writeFile(ownerPath, JSON.stringify({ ...owner, processBirth: `${Number(owner.processBirth) + 1}` }))
      mutationDone()
      await expect(releasing).rejects.toMatchObject({ code: 'fenced' })
      expect(JSON.parse(await readFile(ownerPath, 'utf8')).processBirth).not.toBe(owner.processBirth)
      expect((await stat(leasePath(path))).isDirectory()).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test('release cannot remove a concurrently reacquired lease directory', async () => {
    const directory = await workspaceTemp('release-atomic-reacquire')
    const path = join(directory, 'attempt.json')
    const context = { deadlineAtMs: Date.now() + 10_000, monotonicNow: Date.now,
      signal: new AbortController().signal }
    let detached!: () => void
    const detachPoint = new Promise<void>(resolve => { detached = resolve })
    let finishRelease!: () => void
    const releaseGate = new Promise<void>(resolve => { finishRelease = resolve })
    const first = new OpenCodeLaunchFileJournalPersistence(path, {
      afterLeaseDirectoryDetach: async () => { detached(); await releaseGate },
    })
    const contender = new OpenCodeLaunchFileJournalPersistence(path)
    try {
      const releaseFirst = await first.acquireExclusive(context)
      const releasing = releaseFirst(context)
      await detachPoint

      const releaseContender = await contender.acquireExclusive(context)
      const contenderOwner = await readFile(join(leasePath(path), 'owner.json'), 'utf8')
      finishRelease()
      await releasing

      expect(await readFile(join(leasePath(path), 'owner.json'), 'utf8')).toBe(contenderOwner)
      await releaseContender(context)
      await expect(stat(leasePath(path))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      finishRelease?.()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === 'win32')('release cannot close a descriptor reused by a contending lease', async () => {
    const directory = await workspaceTemp('release-reused-descriptor')
    const path = join(directory, 'attempt.json')
    const context = { deadlineAtMs: Date.now() + 10_000, monotonicNow: Date.now,
      signal: new AbortController().signal }
    const contender = new OpenCodeLaunchFileJournalPersistence(path)
    let releaseContender: ((context?: OpenCodeLaunchStoreContext) => Promise<void>) | undefined
    const first = new OpenCodeLaunchFileJournalPersistence(path, {
      afterLeaseOwnerClose: async () => { releaseContender = await contender.acquireExclusive(context) },
    })
    try {
      const releaseFirst = await first.acquireExclusive(context)
      await releaseFirst(context)

      expect(releaseContender).toBeDefined()
      expect((await stat(leasePath(path))).isDirectory()).toBe(true)
      await releaseContender!(context)
      await expect(stat(leasePath(path))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test.skipIf(process.platform === 'win32')('physically closes retained namespace roots once after lease cleanup', async () => {
    const directory = await workspaceTemp('retained-root-close')
    const path = join(directory, 'attempt.json')
    const context = { deadlineAtMs: Date.now() + 10_000, monotonicNow: Date.now,
      signal: new AbortController().signal }
    const closedRoots: string[] = []
    const persistence = new OpenCodeLaunchFileJournalPersistence(path, {
      afterRetainedDirectoryHandleClosed: async root => {
        await expect(stat(leasePath(path))).rejects.toMatchObject({ code: 'ENOENT' })
        closedRoots.push(root)
      },
    })
    try {
      const release = await persistence.acquireExclusive(context)
      await release(context)
      await release(context)

      expect(closedRoots.sort()).toEqual([
        directory,
        deriveOpenCodeLaunchNamespacePaths(path, posix).trustedRoot,
      ].sort())
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test.skipIf(process.platform === 'win32')('closes retained namespace roots when anchoring aborts', async () => {
    const directory = await workspaceTemp('retained-root-partial')
    const path = join(directory, 'attempt.json')
    const context = { deadlineAtMs: Date.now() + 10_000, monotonicNow: Date.now,
      signal: new AbortController().signal }
    const closedRoots: string[] = []
    const persistence = new OpenCodeLaunchFileJournalPersistence(path, {
      afterNamespaceAnchored: async () => { throw new Error('stop after anchoring') },
      afterRetainedDirectoryHandleClosed: async root => { closedRoots.push(root) },
    })
    try {
      await expect(persistence.acquireExclusive(context)).rejects.toThrow('stop after anchoring')
      expect(closedRoots.sort()).toEqual([
        directory,
        deriveOpenCodeLaunchNamespacePaths(path, posix).trustedRoot,
      ].sort())
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test('fails closed when a live owner birth identity cannot be read', async () => {
    const directory = await workspaceTemp('owner-birth-unreadable')
    const path = join(directory, 'attempt.json')
    const controller = new AbortController()
    const context = { deadlineAtMs: Date.now() + 10_000, monotonicNow: Date.now, signal: controller.signal }
    try {
      const first = new OpenCodeLaunchFileJournalPersistence(path)
      const release = await first.acquireExclusive(context)
      const owner = JSON.parse(await readFile(join(leasePath(path), 'owner.json'), 'utf8'))
      let reads = 0
      const contender = new OpenCodeLaunchFileJournalPersistence(path, {
        processBirth: async () => {
          reads += 1
          if (reads === 1) return owner.processBirth
          throw new Error('procfs denied')
        },
      })
      const waiting = contender.acquireExclusive(context)
      while (reads < 2) await Bun.sleep(1)
      controller.abort(new Error('stop waiting'))
      await expect(waiting).rejects.toThrow('stop waiting')
      expect((await stat(leasePath(path))).isDirectory()).toBe(true)
      await release({ ...context, signal: new AbortController().signal })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test('fails closed without portable birth identity for a live non-self PID', async () => {
    const directory = await workspaceTemp('foreign-live-no-birth')
    const path = join(directory, 'attempt.json')
    const child = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(30_000)'])
    const owner = { version: 1, pid: child.pid, processBirth: '1', token: crypto.randomUUID() }
    await mkdir(leasePath(path), { mode: 0o700 })
    await writeFile(join(leasePath(path), 'owner.json'), JSON.stringify(owner), { mode: 0o600 })
    const controller = new AbortController()
    const context = { deadlineAtMs: Date.now() + 10_000, monotonicNow: Date.now, signal: controller.signal }
    try {
      const persistence = new OpenCodeLaunchFileJournalPersistence(path, {
        processBirth: async pid => {
          if (pid === process.pid) return '2'
          throw new Error('portable birth unavailable')
        },
      })
      const waiting = persistence.acquireExclusive(context)
      await Bun.sleep(20); controller.abort(new Error('stop waiting'))
      await expect(waiting).rejects.toThrow('stop waiting')
      expect(JSON.parse(await readFile(join(leasePath(path), 'owner.json'), 'utf8'))).toEqual(owner)
    } finally {
      child.kill(); await child.exited
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('reaps a live reused PID only when the platform birth identity proves mismatch', async () => {
    const directory = await workspaceTemp('pid-reuse')
    const path = join(directory, 'attempt.json')
    const owner = { version: 1, pid: process.pid, processBirth: '1', token: crypto.randomUUID() }
    await mkdir(leasePath(path), { mode: 0o700 })
    await writeFile(join(leasePath(path), 'owner.json'), JSON.stringify(owner), { mode: 0o600 })
    const context = { deadlineAtMs: Date.now() + 10_000, monotonicNow: Date.now,
      signal: new AbortController().signal }
    try {
      const persistence = new OpenCodeLaunchFileJournalPersistence(path, { processBirth: async () => '2' })
      const release = await persistence.acquireExclusive(context)
      const replacement = JSON.parse(await readFile(join(leasePath(path), 'owner.json'), 'utf8'))
      expect(replacement.token).not.toBe(owner.token)
      expect(replacement.processBirth).toBe('2')
      await release(context)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test('recovers a dead PID without requiring any foreign process birth identity', async () => {
    const directory = await workspaceTemp('dead-pid-no-birth')
    const path = join(directory, 'attempt.json')
    const owner = { version: 1, pid: 2_147_483_647, processBirth: '1', token: crypto.randomUUID() }
    await mkdir(leasePath(path), { mode: 0o700 })
    await writeFile(join(leasePath(path), 'owner.json'), JSON.stringify(owner), { mode: 0o600 })
    let foreignBirthRead = false
    const context = { deadlineAtMs: Date.now() + 10_000, monotonicNow: Date.now,
      signal: new AbortController().signal }
    try {
      const persistence = new OpenCodeLaunchFileJournalPersistence(path, {
        processBirth: async pid => {
          if (pid === process.pid) return '2'
          foreignBirthRead = true
          throw new Error('foreign birth must not be read for a dead PID')
        },
      })
      const release = await persistence.acquireExclusive(context)
      expect(foreignBirthRead).toBe(false)
      expect(JSON.parse(await readFile(join(leasePath(path), 'owner.json'), 'utf8')).token).not.toBe(owner.token)
      await release(context)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test('reaps an atomically published lease when its directory fsync fails and permits reacquisition', async () => {
    const directory = await workspaceTemp('owner-fsync')
    const path = join(directory, 'attempt.json')
    const context = { deadlineAtMs: Date.now() + 10_000, monotonicNow: Date.now,
      signal: new AbortController().signal }
    let syncs = 0
    const persistence = new OpenCodeLaunchFileJournalPersistence(path, {
      syncLeaseDirectory: async handle => {
        syncs += 1
        if (syncs === 1) throw new Error('directory fsync failed')
        await handle.sync()
      },
    })
    try {
      await expect(persistence.acquireExclusive(context)).rejects.toThrow('directory fsync failed')
      await expect(stat(`${path}.lease`)).rejects.toMatchObject({ code: 'ENOENT' })
      const release = await persistence.acquireExclusive(context)
      await release(context)
      expect(syncs).toBe(2)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test('bounds an expired release call while still reaping the physical lock operation', async () => {
    const directory = await workspaceTemp('release-deadline')
    const path = join(directory, 'attempt.json')
    const live = { deadlineAtMs: Date.now() + 10_000, monotonicNow: Date.now,
      signal: new AbortController().signal }
    try {
      const release = await new OpenCodeLaunchFileJournalPersistence(path).acquireExclusive(live)
      const expired = { deadlineAtMs: 0, monotonicNow: () => 0, signal: new AbortController().signal }
      await expect(release(expired)).rejects.toMatchObject({ code: 'fenced' })
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try { await stat(`${path}.lease`); await Bun.sleep(1) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
          throw error
        }
      }
      await expect(stat(`${path}.lease`)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  test('releases with the same absolute deadline but an independent cleanup signal', async () => {
    const persistence = new MemoryPersistence()
    const controller = new AbortController()
    let releaseContext: OpenCodeLaunchStoreContext | undefined
    persistence.acquireExclusive = async () => async context => { if (context) releaseContext = context }
    const context = { deadlineAtMs: 10_000, monotonicNow: () => 0, signal: controller.signal }
    await new OpenCodeLaunchAttemptStore(persistence).withGeneration(identity, 'begin', async () => {
      controller.abort(new Error('attempt cancelled'))
    }, context)
    expect(releaseContext?.deadlineAtMs).toBe(context.deadlineAtMs)
    expect(releaseContext?.monotonicNow).toBe(context.monotonicNow)
    expect(releaseContext?.signal).not.toBe(controller.signal)
    expect(releaseContext?.signal.aborted).toBe(false)
  })

  test('uses explicit acquisition, body, and release contexts without extending any deadline', async () => {
    const persistence = new MemoryPersistence()
    const acquiredDeadlines: number[] = []
    const bodyDeadlines: number[] = []
    const releasedDeadlines: number[] = []
    const replace = persistence.replaceAndSync.bind(persistence)
    persistence.acquireExclusive = async context => {
      acquiredDeadlines.push(context.deadlineAtMs)
      return async releaseContext => { releasedDeadlines.push(releaseContext!.deadlineAtMs) }
    }
    persistence.replaceAndSync = async (bytes, context) => {
      bodyDeadlines.push(context!.deadlineAtMs)
      await replace(bytes)
    }
    const acquisition = { deadlineAtMs: 10, monotonicNow: () => 0,
      signal: new AbortController().signal }
    const body = { ...acquisition, deadlineAtMs: 20 }
    const release = { ...acquisition, deadlineAtMs: 30 }

    await new OpenCodeLaunchAttemptStore(persistence).withGeneration(
      { ...identity, startedAtMs: 0, totalBudgetMs: 30 }, 'begin', async () => undefined,
      { acquisition, body, release },
    )

    expect(acquiredDeadlines).toEqual([10])
    expect(bodyDeadlines).toEqual([20])
    expect(releasedDeadlines).toEqual([30])
  })

  test.each([
    ['body failure', true, false, 'body failed'],
    ['release failure after body success', false, true, 'release failed'],
    ['release failure after body failure', true, true, 'release failed'],
  ] as const)('preserves %s precedence and releases exactly once', async (_name, bodyFails, releaseFails, message) => {
    const persistence = new MemoryPersistence()
    let releases = 0
    persistence.acquireExclusive = async () => async () => {
      releases += 1
      if (releaseFails) throw new Error('release failed')
    }
    const running = new OpenCodeLaunchAttemptStore(persistence).withGeneration(
      identity, 'begin', async () => {
        if (bodyFails) throw new Error('body failed')
      },
    )
    await expect(running).rejects.toThrow(message)
    expect(releases).toBe(1)
  })

  test('cancelled local-tail wait releases its queue node and late acquisition is explicitly reaped', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    let releaseFirst!: () => void
    const gate = new Promise<void>(resolve => { releaseFirst = resolve })
    const first = store.withGeneration(identity, 'begin', async () => { await gate })
    const cancelled = new AbortController(); cancelled.abort(new Error('cancelled'))
    await expect(store.inspect(identity, { deadlineAtMs: 100, monotonicNow: () => 0, signal: cancelled.signal }))
      .rejects.toThrow('cancelled')
    releaseFirst(); await first
    expect(await store.inspect(identity)).not.toBeNull()

    let resolveAcquisition!: (release: () => Promise<void>) => void
    let reaped = 0
    const acquisition = new Promise<() => Promise<void>>(resolve => { resolveAcquisition = resolve })
    const latePersistence: OpenCodeLaunchJournalPersistence = {
      read: async () => null, replaceAndSync: async () => undefined,
      readFence: async () => null,
      compareAndSwapFence: async () => undefined,
      acquireExclusive: async () => acquisition,
    }
    const started = Date.now()
    const waiting = new OpenCodeLaunchAttemptStore(latePersistence).inspect(identity, {
      deadlineAtMs: started + 20, monotonicNow: Date.now, signal: new AbortController().signal,
    })
    await expect(waiting).rejects.toMatchObject({ code: 'fenced' })
    resolveAcquisition(async () => { reaped += 1 })
    await Bun.sleep(0)
    expect(reaped).toBe(1)
  })

  test('uses a finite monotonic default context when legacy callers omit one', async () => {
    const persistence = new MemoryPersistence()
    let acquiredContext: OpenCodeLaunchStoreContext | undefined
    persistence.acquireExclusive = async context => {
      acquiredContext = context
      return async () => undefined
    }
    await new OpenCodeLaunchAttemptStore(persistence).inspect(identity)
    expect(acquiredContext).toBeDefined()
    expect(acquiredContext!.deadlineAtMs).toBeLessThan(Number.MAX_SAFE_INTEGER)
    const remaining = acquiredContext!.deadlineAtMs - acquiredContext!.monotonicNow()
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThanOrEqual(300_000)
  })

  test('bounds a never-resolving store read by the supplied absolute deadline', async () => {
    const persistence: OpenCodeLaunchJournalPersistence = {
      read: () => new Promise(() => undefined), replaceAndSync: async () => undefined,
      readFence: async () => null,
      compareAndSwapFence: async () => undefined,
      acquireExclusive: async () => async () => undefined,
    }
    const started = Date.now()
    await expect(new OpenCodeLaunchAttemptStore(persistence).inspect(identity, {
      deadlineAtMs: started + 20, monotonicNow: Date.now, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'fenced' })
    expect(Date.now() - started).toBeLessThan(500)
  })

  test.each(['fence', 'journal'] as const)(
    'bounds a non-settling %s publication and retains the poisoned exclusive lease',
    async publication => {
      const persistence = new MemoryPersistence()
      let releases = 0
      persistence.acquireExclusive = async () => async () => { releases += 1 }
      if (publication === 'fence') {
        persistence.compareAndSwapFence = () => new Promise<void>(() => undefined)
      } else {
        persistence.replaceAndSync = () => new Promise<void>(() => undefined)
      }
      const store = new OpenCodeLaunchAttemptStore(persistence)
      const started = Date.now()
      await expect(store.withGeneration({ ...identity, startedAtMs: started, totalBudgetMs: 20 },
        'begin', async () => undefined, {
          deadlineAtMs: started + 20, monotonicNow: Date.now, signal: new AbortController().signal,
        })).rejects.toMatchObject({ code: 'fenced' })
      expect(Date.now() - started).toBeLessThan(500)
      expect(releases).toBe(0)

      const retryStarted = Date.now()
      await expect(store.inspect(identity, {
        deadlineAtMs: retryStarted + 20, monotonicNow: Date.now, signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'fenced' })
      expect(releases).toBe(0)
    },
  )

  test('tightens continuation writes to the persisted absolute deadline instead of resetting it', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    const initialContext = { deadlineAtMs: 10, monotonicNow: () => 0,
      signal: new AbortController().signal }
    await store.withGeneration({ ...identity, startedAtMs: 0, totalBudgetMs: 10 }, 'begin',
      async () => undefined, initialContext)
    const continuationToken = await store.withGeneration(identity, 'replay',
      lease => lease.issueContinuation([member], initialContext), initialContext)
    await expect(store.withGeneration({ ...identity, inputDigest: 'b'.repeat(64), generation: 2,
      continuationToken }, 'continue', async () => undefined, {
      deadlineAtMs: 110, monotonicNow: () => 10, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'fenced' })
    expect(JSON.parse(persistence.text()).generation).toBe(1)
  })

  test('caps lock acquisition from immutable persisted timing before waiting and rereads under lease', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    await store.withGeneration({ ...identity, startedAtMs: 100, totalBudgetMs: 10_000 }, 'begin', async () => undefined)
    const deadlines: number[] = []
    persistence.acquireExclusive = async context => {
      deadlines.push(context.deadlineAtMs)
      return async () => undefined
    }
    await store.withGeneration(identity, 'begin', async () => undefined, {
      deadlineAtMs: 50_000, monotonicNow: () => 101, signal: new AbortController().signal,
    })
    expect(deadlines).toEqual([10_100])
  })

  test('durably distinguishes acquisition/member claims and rejects orphan duplicate or cross-epoch cleanup', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    let firstToken = ''
    await store.withGeneration(identity, 'begin', async lease => {
      firstToken = await lease.claim(member)
      await expect(lease.append({ type: 'member_unknown', memberIdentity: member } as any))
        .rejects.toMatchObject({ code: 'fenced' })
      await lease.append({ type: 'member_unknown', memberIdentity: member, claimToken: firstToken })
      await lease.append({ type: 'cleanup', memberIdentity: member, outcome: 'complete', claimToken: firstToken })
      await expect(lease.append({ type: 'cleanup', memberIdentity: member, outcome: 'complete', claimToken: firstToken }))
        .rejects.toMatchObject({ code: 'corrupt' })
      await expect(lease.append({ type: 'member_reconciled_applied', memberIdentity: member,
        linkage, claimToken: firstToken })).rejects.toMatchObject({ code: 'fenced' })
      await lease.reconcile({ type: 'member_reconciled_applied', memberIdentity: member, linkage, claimToken: firstToken })
      await expect(lease.append({ type: 'cleanup', memberIdentity: member, outcome: 'complete', claimToken: firstToken }))
        .rejects.toMatchObject({ code: 'corrupt' })
      await lease.issueContinuation([member])
    })
    const continuationToken = (await store.inspect(identity))!.continuation!.token
    await store.withGeneration({ ...identity, inputDigest: 'b'.repeat(64), generation: 2,
      continuationToken }, 'continue', async lease => {
      await expect(lease.append({ type: 'cleanup', memberIdentity: member, outcome: 'complete', claimToken: firstToken }))
        .rejects.toMatchObject({ code: 'fenced' })
      const secondToken = await lease.claim(oid('5'))
      expect(secondToken).not.toBe(firstToken)
      expect(secondToken.startsWith(`${lease.acquisitionToken}.`)).toBe(true)
    })
    const orphan = new OpenCodeLaunchAttemptStore(new MemoryPersistence())
    await orphan.withGeneration(identity, 'begin', async lease => {
      await expect(lease.append({ type: 'cleanup', memberIdentity: member, outcome: 'complete' } as any))
        .rejects.toMatchObject({ code: 'fenced' })
    })
  })

  test('rejects payload replay mismatch and rollback/cross-epoch layouts', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    await store.withGeneration({ ...identity, inputDigest: 'b'.repeat(64) }, 'begin', async lease => {
      const claimToken = await lease.claim(member)
      await lease.append({ type: 'member_unknown', memberIdentity: member, claimToken })
    })
    await expect(store.inspect({ ...identity, inputDigest: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'foreign' })
    const journal = JSON.parse(persistence.text())
    journal.generation = 2; journal.fence = 2
    journal.events.push({ type: 'member_applied', sequence: 3, generation: 2, fence: 2, memberIdentity: member, linkage })
    persistence.set(journal)
    await expect(store.inspect({ ...identity, inputDigest: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'corrupt' })
  })

  test('persists absorbing cleanup truth and promotes only through exact replay reconciliation', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    const exact = { ...identity, inputDigest: 'e'.repeat(64), immutableDigest: 'f'.repeat(64) }
    await store.withGeneration(exact, 'begin', async lease => {
      expect(lease.beganGeneration).toBe(true)
      await lease.commitTerminalResponse(finalResponse(), 'incomplete')
      await expect(lease.recordCleanupState('complete')).rejects.toMatchObject({ code: 'fenced' })
    })
    await store.withGeneration(exact, 'begin', async replay => {
      expect(replay.beganGeneration).toBe(false)
      expect(replay.journal.cleanupState).toBe('incomplete')
      await expect(replay.recordCleanupState('complete')).rejects.toMatchObject({ code: 'fenced' })
      await expect(replay.reconcileCleanupComplete()).rejects.toThrow('member cleanup obligations')
    })
    const withoutMemberCleanup = finalResponse()
    withoutMemberCleanup.members.cleanupPending = []
    const durable = JSON.parse(persistence.text())
    durable.finalResponse = withoutMemberCleanup
    persistence.set(durable)
    await store.withGeneration(exact, 'begin', async replay => {
      await replay.reconcileCleanupComplete()
    })
    expect((await store.inspect(exact))?.cleanupState).toBe('complete')
  })

  test('uses the fresh invocation deadline only for reconciliation of an exact durable final', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    const exact = { ...identity, inputDigest: 'e'.repeat(64), immutableDigest: 'f'.repeat(64),
      startedAtMs: 0, totalBudgetMs: 10_000 }
    const initialContext = { deadlineAtMs: 10_000, monotonicNow: () => 0,
      signal: new AbortController().signal }
    await store.withGeneration(exact, 'begin', async lease => {
      const response = finalResponse()
      response.members.cleanupPending = []
      await lease.commitTerminalResponse(response, 'incomplete', initialContext)
    }, initialContext)

    const replayContext = { deadlineAtMs: 20_000, monotonicNow: () => 15_000,
      signal: new AbortController().signal }
    await store.withGeneration(exact, 'begin', async lease => {
      expect(lease.beganGeneration).toBe(false)
      await lease.reconcileCleanupComplete(replayContext)
    }, replayContext)
    expect((await store.inspect(exact))?.cleanupState).toBe('complete')
  })

  test('carries incomplete cleanup truth across continuation and rejects a generation upgrade', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    const first = { ...identity, inputDigest: 'e'.repeat(64), immutableDigest: 'f'.repeat(64) }
    const token = await store.withGeneration(first, 'begin', async lease => {
      await lease.recordCleanupState('incomplete')
      return lease.issueContinuation([member])
    })
    const second = { ...first, inputDigest: 'd'.repeat(64), generation: 2, continuationToken: token }
    await store.withGeneration(second, 'continue', async lease => {
      expect(lease.beganGeneration).toBe(true)
      expect(lease.journal.cleanupState).toBe('incomplete')
      await expect(lease.recordCleanupState('complete')).rejects.toMatchObject({ code: 'fenced' })
      const attemptedFinal = finalResponse()
      attemptedFinal.launchAttempt.generation = 2
      attemptedFinal.launchAttempt.inputDigest = second.inputDigest
      attemptedFinal.proof!.generation = 2
      await expect(lease.commitTerminalResponse(attemptedFinal, 'complete'))
        .rejects.toMatchObject({ code: 'fenced' })
    })
    const durable = await store.inspect(second)
    expect(durable).toMatchObject({ generation: 2, cleanupState: 'incomplete' })
    expect(durable?.finalResponse).toBeUndefined()
  })

  test('two processes fence duplicate begin writers and preserve the winning journal', async () => {
    const directory = await workspaceTemp('race')
    const path = join(directory, 'attempt.json')
    const modulePath = join(process.cwd(), 'src/services/opencode/OpenCodeLaunchAttemptStore.ts')
    const processIdentity = { ...identity, startedAtMs: Date.now(), totalBudgetMs: 5_000 }
    const child = (marker: string) => `
      import { OpenCodeLaunchAttemptStore, OpenCodeLaunchFileJournalPersistence } from ${JSON.stringify(modulePath)};
      import { writeFile } from 'node:fs/promises';
      const store = new OpenCodeLaunchAttemptStore(new OpenCodeLaunchFileJournalPersistence(${JSON.stringify(path)}));
      const identity = ${JSON.stringify(processIdentity)};
      const context = { deadlineAtMs: Date.now()+5000, monotonicNow: Date.now, signal: new AbortController().signal };
      await store.withGeneration(identity, 'begin', async lease => {
        await writeFile(${JSON.stringify(join(directory, marker))}, 'ready');
        await Bun.sleep(30);
        await lease.append({type:'member_intent',memberIdentity:${JSON.stringify(member)}});
      }, context);
    `
    try {
      const one = Bun.spawn([process.execPath, '-e', child('one')], { stdout: 'pipe', stderr: 'pipe' })
      const two = Bun.spawn([process.execPath, '-e', child('two')], { stdout: 'pipe', stderr: 'pipe' })
      const exits = await Promise.all([one.exited, two.exited])
      expect(exits.filter(code => code === 0)).toHaveLength(1)
      const journal = await readCommittedJournal(path)
      expect(journal.events).toHaveLength(1)
      expect(journal.events[0]).toMatchObject({ type: 'member_intent', generation: 1, fence: 1 })
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 15_000)

  test('two processes preserve a newer generation against a detached stale writer', async () => {
    const directory = await workspaceTemp('stale')
    const path = join(directory, 'attempt.json')
    const ready = join(directory, 'ready')
    const rejected = join(directory, 'rejected')
    const modulePath = join(process.cwd(), 'src/services/opencode/OpenCodeLaunchAttemptStore.ts')
    const processIdentity = { ...identity, startedAtMs: Date.now(), totalBudgetMs: 5_000 }
    const common = `
      import { OpenCodeLaunchAttemptStore, OpenCodeLaunchFileJournalPersistence } from ${JSON.stringify(modulePath)};
      const store = new OpenCodeLaunchAttemptStore(new OpenCodeLaunchFileJournalPersistence(${JSON.stringify(path)}));
      const identity = ${JSON.stringify(processIdentity)};
      const context = { deadlineAtMs: Date.now()+5000, monotonicNow: Date.now, signal: new AbortController().signal };
    `
    const firstCode = `${common}
      import { writeFile } from 'node:fs/promises';
      let stale;
      await store.withGeneration(identity, 'begin', async lease => { stale=lease; await lease.append({type:'member_intent',memberIdentity:${JSON.stringify(member)}}); }, context);
      await writeFile(${JSON.stringify(ready)}, 'ready');
      await Bun.sleep(200);
      try { await stale.append({type:'member_intent',memberIdentity:${JSON.stringify(oid('9'))}}); }
      catch { await writeFile(${JSON.stringify(rejected)}, 'rejected'); }
    `
    const secondCode = `${common}
      const token = await store.withGeneration(identity, 'replay', lease => lease.issueContinuation([${JSON.stringify(member)}]), context);
      await store.withGeneration({...identity,inputDigest:${JSON.stringify('b'.repeat(64))},generation:2,continuationToken:token}, 'continue', async lease => {
        await lease.append({type:'member_intent',memberIdentity:${JSON.stringify(oid('8'))}});
      }, context);
    `
    try {
      const first = Bun.spawn([process.execPath, '-e', firstCode], { stdout: 'pipe', stderr: 'pipe' })
      while (true) { try { await readFile(ready); break } catch { await Bun.sleep(5) } }
      const second = Bun.spawn([process.execPath, '-e', secondCode], { stdout: 'pipe', stderr: 'pipe' })
      expect(await second.exited).toBe(0)
      expect(await first.exited).toBe(0)
      expect(await readFile(rejected, 'utf8')).toBe('rejected')
      const journal = await readCommittedJournal(path)
      expect(journal).toMatchObject({ generation: 2, fence: 2 })
      expect(journal.events.map((event: any) => [event.memberIdentity, event.generation])).toEqual([
        [member, 1], [oid('8'), 2],
      ])
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 15_000)
})

const temporaryRoots = new Set<string>()
afterEach(async () => {
  await Promise.all([...temporaryRoots].map(root => rm(root, { recursive: true, force: true })))
  temporaryRoots.clear()
})

async function workspaceTemp(label: string): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), `src/services/opencode/.launch-store-${label}-`))
  temporaryRoots.add(root)
  const directory = join(root, 'trusted', 'parent', 'work')
  await mkdir(directory, { recursive: true })
  return directory
}

async function readCommittedJournal(path: string): Promise<any> {
  const bytes = await new OpenCodeLaunchFileJournalPersistence(path).read()
  return JSON.parse(new TextDecoder().decode(bytes!))
}
