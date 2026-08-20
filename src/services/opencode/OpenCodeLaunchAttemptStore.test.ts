import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  OPEN_CODE_LAUNCH_JOURNAL_MAX_BYTES,
  OpenCodeLaunchAttemptStore,
  OpenCodeLaunchFileJournalPersistence,
  OpenCodeLaunchJournalError,
  type OpenCodeLaunchJournalPersistence,
  type OpenCodeLaunchJournalLease,
  type OpenCodeLaunchStoreContext,
} from './OpenCodeLaunchAttemptStore.js'
import type { OpenCodeLaunchMemberLinkage, OpenCodeOpaqueIdentity } from './OpenCodeBridgeContractV2.js'

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

class MemoryPersistence implements OpenCodeLaunchJournalPersistence {
  bytes: Uint8Array | null = null
  fence = 0
  activeWrites = 0
  maximumActiveWrites = 0
  async read() { return this.bytes?.slice() ?? null }
  async replaceAndSync(bytes: Uint8Array) {
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
    const gate = new Promise<void>(resolve => { release = resolve })
    const first = store.withGeneration(identity, 'begin', async lease => {
      order.push(`begin:${lease.generation}:${lease.fence}`)
      await gate
      await lease.append({ type: 'member_intent', memberIdentity: member })
      order.push('begin:end')
    })
    const second = store.withGeneration({ ...identity, inputDigest: 'b'.repeat(64) }, 'continue', async lease => {
      order.push(`continue:${lease.generation}:${lease.fence}`)
    })
    while (order.length === 0) await Promise.resolve()
    expect(order).toEqual(['begin:1:1'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['begin:1:1', 'begin:end', 'continue:2:2'])
    expect((await store.inspect({ ...identity, inputDigest: 'b'.repeat(64) }))?.generation).toBe(2)
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
    await expect(store.withGeneration({ ...identity, inputDigest: '3'.repeat(64), immutableDigest: '2'.repeat(64), generation: 2 },
      'continue', lease => lease.bindProfile({ ...binding, authIdentity: oid('0') })))
      .rejects.toMatchObject({ code: 'foreign' })
    expect((await store.inspect(identity))?.profileBinding).toEqual(binding)
  })

  test('rejects a detached writer after its coordinated generation lease ends', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    let stale!: OpenCodeLaunchJournalLease
    await store.withGeneration(identity, 'begin', async lease => { stale = lease })
    await store.withGeneration({ ...identity, inputDigest: 'b'.repeat(64) }, 'continue', async () => undefined)
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
    expect(persistence.fence).toBe(2)
    await expect(new OpenCodeLaunchAttemptStore(persistence).inspect(identity)).rejects.toMatchObject({ code: 'fenced' })
  })

  test('keeps the lease through a delayed physical replacement so generation 1 cannot complete after generation 2', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    await store.withGeneration(identity, 'begin', async () => undefined)
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
    const second = store.withGeneration({ ...identity, inputDigest: 'b'.repeat(64), generation: 2 }, 'continue', async () => {
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

  test('quarantines publish-then-throw even when visibility matches the candidate', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    await store.withGeneration(identity, 'begin', async () => undefined)
    const replace = persistence.replaceAndSync.bind(persistence)
    persistence.replaceAndSync = async bytes => { await replace(bytes); throw new Error('post-publish fsync ambiguity') }
    await expect(store.withGeneration(identity, 'begin', lease =>
      lease.append({ type: 'member_intent', memberIdentity: member }))).rejects.toThrow('post-publish fsync ambiguity')
    expect(persistence.fence).toBe(2)
    await expect(store.inspect(identity)).rejects.toMatchObject({ code: 'fenced' })
  })

  test('keeps a poisoned lease when an ambiguous replacement cannot advance its quarantine fence', async () => {
    const persistence = new MemoryPersistence()
    let releases = 0
    persistence.acquireExclusive = async () => async () => { releases += 1 }
    const store = new OpenCodeLaunchAttemptStore(persistence)
    await store.withGeneration(identity, 'begin', async () => undefined)
    const replace = persistence.replaceAndSync.bind(persistence)
    persistence.replaceAndSync = async bytes => { await replace(bytes); throw new Error('ambiguous replacement') }
    persistence.compareAndSwapFence = async () => { throw new Error('fence unavailable') }
    await expect(store.withGeneration(identity, 'begin', lease =>
      lease.append({ type: 'member_intent', memberIdentity: member }))).rejects.toMatchObject({ code: 'fenced' })
    expect(releases).toBe(1)
    const controller = new AbortController()
    const waiting = store.inspect(identity, { deadlineAtMs: 10, monotonicNow: () => 0, signal: controller.signal })
    controller.abort(new Error('poisoned'))
    await expect(waiting).rejects.toThrow('poisoned')
    expect(releases).toBe(1)
  })

  test('quarantines a publish-then-throw fence CAS without publishing its journal generation', async () => {
    const persistence = new MemoryPersistence()
    const store = new OpenCodeLaunchAttemptStore(persistence)
    await store.withGeneration(identity, 'begin', async () => undefined)
    const compare = persistence.compareAndSwapFence.bind(persistence)
    let ambiguous = true
    persistence.compareAndSwapFence = async (expected, next) => {
      await compare(expected, next)
      if (ambiguous) { ambiguous = false; throw new Error('fence fsync ambiguity') }
    }
    await expect(store.withGeneration({ ...identity, inputDigest: 'b'.repeat(64), generation: 2 },
      'continue', async () => undefined)).rejects.toThrow('fence fsync ambiguity')
    expect(persistence.fence).toBe(3)
    expect(JSON.parse(persistence.text())).toMatchObject({ generation: 1, fence: 1 })
    await expect(store.inspect(identity)).rejects.toMatchObject({ code: 'fenced' })
  })

  test('poisons the lease when the quarantine CAS itself publishes and throws', async () => {
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
      lease.append({ type: 'member_intent', memberIdentity: member }))).rejects.toMatchObject({ code: 'fenced' })
    expect(persistence.fence).toBe(2)
    expect(releases).toBe(1)
  })

  test('cannot release a poisoned lease when the operation swallows the append failure', async () => {
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
    })).rejects.toMatchObject({ code: 'fenced' })
    expect(releases).toBe(1)
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
    await store.withGeneration({ ...identity, inputDigest: 'b'.repeat(64), generation: 2 }, 'continue', lease =>
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

  test('rejects a pre-planted lease symlink without reading or mutating its target namespace', async () => {
    const directory = await workspaceTemp('lease-symlink')
    const target = join(directory, 'target')
    const path = join(directory, 'attempt.json')
    await mkdir(target)
    await symlink(target, `${path}.lease`)
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
      const owner = JSON.parse(await readFile(`${path}.lease/owner.json`, 'utf8'))
      expect(owner).toMatchObject({ version: 1, pid: process.pid })
      expect(owner.token).toMatch(/^[0-9a-f-]{36}$/)
      expect(owner.processBirth).toMatch(/^\d+$/)
      expect(await readdir(`${path}.lease`)).toEqual(['owner.json'])
      await release(context)
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
      const ownerPath = `${path}.lease/owner.json`
      const owner = JSON.parse(await readFile(ownerPath, 'utf8'))
      await writeFile(ownerPath, JSON.stringify({ ...owner, token: 'foreign-token' }), { mode: 0o600 })
      await expect(release(context)).rejects.toMatchObject({ code: 'fenced' })
      expect((await stat(`${path}.lease`)).isDirectory()).toBe(true)
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
      const ownerPath = `${path}.lease/owner.json`
      const owner = JSON.parse(await readFile(ownerPath, 'utf8'))
      await writeFile(ownerPath, JSON.stringify({ ...owner, processBirth: `${Number(owner.processBirth) + 1}` }))
      mutationDone()
      await expect(releasing).rejects.toMatchObject({ code: 'fenced' })
      expect(JSON.parse(await readFile(ownerPath, 'utf8')).processBirth).not.toBe(owner.processBirth)
      expect((await stat(`${path}.lease`)).isDirectory()).toBe(true)
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
      const contenderOwner = await readFile(`${path}.lease/owner.json`, 'utf8')
      finishRelease()
      await releasing

      expect(await readFile(`${path}.lease/owner.json`, 'utf8')).toBe(contenderOwner)
      await releaseContender(context)
      await expect(stat(`${path}.lease`)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      finishRelease?.()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('fails closed when a live owner birth identity cannot be read', async () => {
    const directory = await workspaceTemp('owner-birth-unreadable')
    const path = join(directory, 'attempt.json')
    const controller = new AbortController()
    const context = { deadlineAtMs: Date.now() + 10_000, monotonicNow: Date.now, signal: controller.signal }
    try {
      const first = new OpenCodeLaunchFileJournalPersistence(path)
      const release = await first.acquireExclusive(context)
      const owner = JSON.parse(await readFile(`${path}.lease/owner.json`, 'utf8'))
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
      expect((await stat(`${path}.lease`)).isDirectory()).toBe(true)
      await release({ ...context, signal: new AbortController().signal })
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
    await store.withGeneration({ ...identity, startedAtMs: 0, totalBudgetMs: 10 }, 'begin', async () => undefined)
    await expect(store.withGeneration({ ...identity, inputDigest: 'b'.repeat(64), generation: 2 }, 'continue', async () => undefined, {
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
    })
    await store.withGeneration({ ...identity, inputDigest: 'b'.repeat(64), generation: 2 }, 'continue', async lease => {
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
      const one = Bun.spawn(['/root/.bun/bin/bun', '-e', child('one')], { stdout: 'pipe', stderr: 'pipe' })
      const two = Bun.spawn(['/root/.bun/bin/bun', '-e', child('two')], { stdout: 'pipe', stderr: 'pipe' })
      const exits = await Promise.all([one.exited, two.exited])
      expect(exits.filter(code => code === 0)).toHaveLength(1)
      const journal = await readCommittedJournal(path)
      expect(journal.events).toHaveLength(1)
      expect(journal.events[0]).toMatchObject({ type: 'member_intent', generation: 1, fence: 1 })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

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
      await store.withGeneration({...identity,inputDigest:${JSON.stringify('b'.repeat(64))},generation:2}, 'continue', async lease => {
        await lease.append({type:'member_intent',memberIdentity:${JSON.stringify(oid('8'))}});
      }, context);
    `
    try {
      const first = Bun.spawn(['/root/.bun/bin/bun', '-e', firstCode], { stdout: 'pipe', stderr: 'pipe' })
      while (true) { try { await readFile(ready); break } catch { await Bun.sleep(5) } }
      const second = Bun.spawn(['/root/.bun/bin/bun', '-e', secondCode], { stdout: 'pipe', stderr: 'pipe' })
      expect(await second.exited).toBe(0)
      expect(await first.exited).toBe(0)
      expect(await readFile(rejected, 'utf8')).toBe('rejected')
      const journal = await readCommittedJournal(path)
      expect(journal).toMatchObject({ generation: 2, fence: 2 })
      expect(journal.events.map((event: any) => [event.memberIdentity, event.generation])).toEqual([
        [member, 1], [oid('8'), 2],
      ])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

async function workspaceTemp(label: string): Promise<string> {
  return mkdtemp(join(process.cwd(), `src/services/opencode/.launch-store-${label}-`))
}

async function readCommittedJournal(path: string): Promise<any> {
  const bytes = await new OpenCodeLaunchFileJournalPersistence(path).read()
  return JSON.parse(new TextDecoder().decode(bytes!))
}
