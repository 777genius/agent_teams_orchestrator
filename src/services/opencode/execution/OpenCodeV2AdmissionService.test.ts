import { readOriginalTerminal, readExecutionCut } from './OpenCodeV2TerminalSettlement.js'
import { describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OpenCodeV2AdmissionStore } from './OpenCodeV2AdmissionStore.js'
import { OpenCodeV2AdmissionService, type QueueIntent } from './OpenCodeV2AdmissionService.js'
import { OpenCodeV2SessionService } from './OpenCodeV2SessionService.js'
import type { ExecutionClient, ExecutionInbox, ExecutionLog, ExecutionSession } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import { assertExecutionSelectedModel, executionHash, type SessionAuthority } from './OpenCodeV2ExecutionContracts.js'
import { OpenCodeV2ExecutionFetch, rejectExecutionBeforeInvocation } from '../transport/OpenCodeV2ExecutionFetch.js'
import { executionFloorOperations } from '../transport/OpenCodeV2ExecutionFloorClient.js'
import { executionCurrentOperations } from '../transport/OpenCodeV2ExecutionCurrentClient.js'

const authority: SessionAuthority = {
  host: { generation: 'v2', pin: '2.0.21', dialect: 'v2-2.0.21', graphSha256: '1'.repeat(64),
    selectedCli: { path: '/TEST-cli', sha256: '2'.repeat(64), version: '2.0.21' },
    child: { pid: 10, birth: { format: 'linux-start-ticks', value: '11', bootId: 'TEST-boot' }, executablePath: '/TEST-bun', sha256: '3'.repeat(64) },
    hostInstanceId: 'TEST-host', profileEpoch: 'TEST-epoch', profileRoot: '/TEST-profile', directory: '/TEST-project', leaseOwnerId: 'TEST-owner' },
  teamId: 'TEST-team', runId: 'TEST-run', laneId: 'TEST-lane', memberId: 'TEST-member', sessionID: 'ses_TEST1', agent: 'TEST-agent', model: { providerID: 'TEST-provider', id: 'catalog-model' },
}
function intent(n: number, resume = true): QueueIntent {
  return { identity: { requestId: `request-${n}`, deliveryAttemptId: `attempt-${n}`, localMessageId: `local-${n}`, nativeInputID: `msg_TEST${n}` },
    input: { nativeInputID: `msg_TEST${n}`, text: `TEST input ${n}`, resume }, delivery: 'queue' }
}
function session(a = authority): ExecutionSession {
  return { id: a.sessionID, directory: a.host.directory, agent: a.agent, model: a.model, timeCreated: 1 }
}
function receipt(i: QueueIntent): ExecutionInbox {
  return { id: i.identity.nativeInputID, sessionID: authority.sessionID, type: 'user', timeCreated: 1, delivery: 'queue', payload: { text: i.input.text } }
}
function cut(i: QueueIntent): ExecutionLog {
  return { synced: true, watermark: 2, events: [
    { id: 'created', type: 'session.created', seq: 1, aggregateID: authority.sessionID, data: { sessionID: authority.sessionID } },
    { id: 'enqueued', type: 'session.inbox.enqueued', seq: 2, aggregateID: authority.sessionID,
      data: { sessionID: authority.sessionID, inboxID: i.identity.nativeInputID, item: { type: 'user', delivery: 'queue', payload: { text: i.input.text } } } },
  ] }
}
function client(overrides: Partial<ExecutionClient> = {}, a = authority): ExecutionClient {
  return { authority: a.host, createSession: async () => session(a), getSession: async () => session(a),
    promptQueue: async () => receipt(intent(1)), inbox: async () => [], messages: async () => ({ data: [], previous: null, next: null }),
    log: async () => ({ events: [], synced: true, watermark: null }), dispose: async () => {}, ...overrides }
}
// Obtain missing-session authority from the actual bounded wire decoder. A
// fabricated status/tag on a mock exception cannot authorize creation.
async function nativeSessionMissing(a = authority): Promise<never> {
  const endpoint = 'http://127.0.0.1:1'
  const wire = new OpenCodeV2ExecutionFetch(endpoint, a.host.pin, a.host.directory, 'TEST-password',
    { deadline: Date.now() + 5000 }, async () => new Response(JSON.stringify({
      _tag: 'SessionNotFoundError', sessionID: a.sessionID, message: 'TEST missing',
    }), { status: 404, headers: { 'content-type': 'application/json' } }))
  try {
    await wire.fetch(`${endpoint}/api/session/${a.sessionID}`)
    throw new Error('TEST-missing-response-accepted')
  } finally { await wire.dispose() }
}
async function setup(selectedAuthority = authority) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-r207-store-'))
  const store = await OpenCodeV2AdmissionStore.open(root, selectedAuthority)
  const reservation = await store.reserveSession()
  await store.markCreation(reservation.revision, 'accepted')
  return { root, store, close: () => rm(root, { recursive: true, force: true }) }
}

describe('durable V2 admission ownership', () => {
  test('opening a store retains original authority despite caller mutation during filesystem work', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-r237-store-authority-'))
    const selected = structuredClone({ ...authority, host: { ...authority.host }, model: { ...authority.model, variant: 'high' } })
    const original = structuredClone(selected)
    try {
      const opening = OpenCodeV2AdmissionStore.open(root, selected)
      selected.sessionID = 'ses_TESTforeign'
      selected.host.hostInstanceId = 'TEST-foreign-host'
      selected.host.profileEpoch = 'TEST-foreign-epoch'
      selected.model.variant = 'low'
      const store = await opening
      const directoryID = executionHash({ pin: original.host.pin, profileEpoch: original.host.profileEpoch,
        hostInstanceId: original.host.hostInstanceId, sessionID: original.sessionID })
      expect(path.basename(path.dirname(store.filePath))).toBe(directoryID)
      expect(() => store.assertAuthority(original)).not.toThrow()
      expect(() => store.assertAuthority(selected)).toThrow('authority_conflict')
      await store.reserveSession()
      expect((await store.snapshot()).authority).toEqual(original)
      const reopened = await OpenCodeV2AdmissionStore.open(root, original)
      expect(reopened.filePath).toBe(store.filePath)
      expect((await reopened.snapshot()).authority).toEqual(original)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  test('queued journal writes retain original intent, read boundary and uncertainty patch', async () => {
    const fixture = await setup(), input = intent(1), selectedIdentity = { ...input.identity }
    const boundary = { beforeCursor: 1, beforeUserIDs: ['msg_TESTearlier'] }
    const originalBoundary = structuredClone(boundary), payloadHash = executionHash('TEST-original-payload')
    try {
      const reservation = fixture.store.reserve(selectedIdentity, payloadHash, boundary)
      selectedIdentity.requestId = 'TEST-foreign-request'
      selectedIdentity.nativeInputID = 'msg_TESTforeign'
      boundary.beforeCursor = 999
      boundary.beforeUserIDs.push('msg_TESTforeign')
      const reserved = await reservation
      expect(reserved.identity).toEqual(input.identity)
      expect(reserved.beforeCursor).toBe(originalBoundary.beforeCursor)
      expect(reserved.beforeUserIDs).toEqual(originalBoundary.beforeUserIDs)
      const sent = await fixture.store.submitting(input.identity.requestId, reserved.revision)
      const patch: Parameters<OpenCodeV2AdmissionStore['update']>[2] = { state: 'unknown', disposition: 'unknown', complete: false }
      const updating = fixture.store.update(input.identity.requestId, sent.revision, patch)
      patch.state = 'not_submitted'
      patch.disposition = 'rejected'
      patch.complete = true
      const saved = await updating
      expect(saved.state).toBe('unknown'); expect(saved.disposition).toBe('unknown'); expect(saved.complete).toBe(false)
      expect((await fixture.store.snapshot()).slot).toBe(input.identity.requestId)
      await expect(fixture.store.reserve(intent(2).identity, payloadHash)).rejects.toThrow('session_fenced')
    } finally { await fixture.close() }
  })

  test('parked series retains original identities across queued persistence', async () => {
    const fixture = await setup(), inputs = [intent(1, false), intent(2, false), intent(3, true)]
    const selected = inputs.map(input => ({ identity: { ...input.identity }, payloadHash: executionHash(input.input.text) }))
    const original = structuredClone(selected)
    try {
      const reservation = fixture.store.reserveParkedSeries(selected)
      selected[0]!.identity.nativeInputID = 'msg_TESTforeign'
      selected[0]!.payloadHash = 'f'.repeat(64)
      await reservation
      expect((await fixture.store.snapshot()).parkedSeries).toEqual(original.map(input => ({
        requestId: input.identity.requestId, intentHash: executionHash(input),
      })))
      const first = await fixture.store.reserve(original[0]!.identity, original[0]!.payloadHash)
      expect(first.identity).toEqual(inputs[0]!.identity)
    } finally { await fixture.close() }
  })
  test('structurally assignable extra fields cannot rewrite durable input identity or history', async () => {
    const fixture = await setup(), input = intent(1), payloadHash = executionHash('TEST-original-payload')
    try {
      const bytesBefore = await readFile(fixture.store.filePath, 'utf8')
      const boundary = { beforeCursor: 1, beforeUserIDs: [],
        identity: { ...input.identity, nativeInputID: 'msg_TESTforeign' }, state: 'accepted' }
      await expect(fixture.store.reserve(input.identity, payloadHash, boundary)).rejects.toThrow('store_unknown')
      expect(await readFile(fixture.store.filePath, 'utf8')).toBe(bytesBefore)
      const reserved = await fixture.store.reserve(input.identity, payloadHash)
      const sent = await fixture.store.submitting(input.identity.requestId, reserved.revision)
      const bytesSent = await readFile(fixture.store.filePath, 'utf8')
      const patch = { state: 'unknown' as const, disposition: 'unknown' as const, complete: false,
        identity: { ...input.identity, nativeInputID: 'msg_TESTforeign' }, beforeCursor: 999 }
      await expect(fixture.store.update(input.identity.requestId, sent.revision, patch)).rejects.toThrow('store_unknown')
      expect(await readFile(fixture.store.filePath, 'utf8')).toBe(bytesSent)
      expect((await fixture.store.snapshot()).admissions[0]?.identity).toEqual(input.identity)
      expect((await fixture.store.snapshot()).slot).toBe(input.identity.requestId)
    } finally { await fixture.close() }
  })
  // Red if selection construction drops variant, if create loses it, or if
  // variant-only native drift reaches prompt mutation through readback.
  for (const pin of ['2.0.0', '2.0.21'] as const) {
    // Real generated adapters must preserve variant in both wire directions;
    // a service-only fake cannot detect dialect mapping silently dropping it.
    test(`${pin} generated create/get roundtrip preserves variant on the wire`, async () => {
      const endpoint = 'http://127.0.0.1:1', model = { providerID: 'TEST-provider', id: 'catalog-model', variant: 'high' }
      const requests: { method: string; body: unknown }[] = []
      const wire = new OpenCodeV2ExecutionFetch(endpoint, pin, authority.host.directory, 'TEST-password',
        { deadline: Date.now() + 5000 }, async (input, init) => {
          const request = new Request(input, init)
          requests.push({ method: request.method, body: request.body ? await request.json() : null })
          return new Response(JSON.stringify({ data: { id: authority.sessionID, location: { directory: authority.host.directory },
            agent: authority.agent, model, time: { created: 1 } } }), { headers: { 'content-type': 'application/json' } })
        })
      const operations = (pin === '2.0.0' ? executionFloorOperations : executionCurrentOperations)(endpoint, authority.host.directory, wire, wire.fetch)
      try {
        expect(await operations.create({ sessionID: authority.sessionID, agent: authority.agent, model })).toMatchObject({ model })
        expect(await operations.get(authority.sessionID)).toMatchObject({ model })
        expect(requests).toEqual([{ method: 'POST', body: { id: 'ses_TEST1', agent: 'TEST-agent', model,
          location: { directory: '/TEST-project' } } }, { method: 'GET', body: null }])
      } finally { await wire.dispose() }
    })
    test(`${pin} preserves selected model variant through create, journal, readback and admission`, async () => {
      const selected: SessionAuthority = { ...authority,
        host: { ...authority.host, pin, dialect: `v2-${pin}`, selectedCli: { ...authority.host.selectedCli, version: pin } },
        model: { providerID: 'TEST-provider', id: 'catalog-model', variant: 'high' } }
      const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-r237-variant-'))
      const store = await OpenCodeV2AdmissionStore.open(root, selected)
      const creations: Parameters<ExecutionClient['createSession']>[0][] = []
      let prompts = 0, drift = false
      const consumer = client({ createSession: async input => { creations.push(input); return session(selected) },
        getSession: async () => creations.length === 0 ? nativeSessionMissing(selected) :
          ({ ...session(selected), model: { ...selected.model, variant: drift ? 'low' : 'high' } }),
        promptQueue: async () => { prompts++; return receipt(intent(1)) } }, selected)
      const sessions = new OpenCodeV2SessionService(consumer, store, selected)
      const admissions = new OpenCodeV2AdmissionService(consumer, store, selected)
      try {
        expect((await sessions.createSession()).disposition).toBe('accepted')
        expect(creations[0]?.model).toEqual({ providerID: 'TEST-provider', id: 'catalog-model', variant: 'high' })
        expect((await sessions.readSession()).session?.model).toEqual(selected.model)
        expect((await admissions.admitQueue(intent(1), true)).state).toBe('accepted')
        const reopened = await OpenCodeV2AdmissionStore.open(root, selected)
        expect((await reopened.snapshot()).authority.model).toEqual(selected.model)
        expect((await reopened.snapshot()).admissions[0]?.authority.model).toEqual(selected.model)
        drift = true
        await expect(admissions.admitQueue(intent(2), true)).rejects.toThrow('session_selection_changed')
        expect(prompts).toBe(1)
        expect((await reopened.snapshot()).admissions).toHaveLength(1)
      } finally { await rm(root, { recursive: true, force: true }) }
    })
  }
  // Red if optional fields broaden ModelRef, or invalid/unbounded variant enters
  // durable authority. This boundary is shared by profile selection/readback.
  test('model variant is optional, bounded and exact-key validated', () => {
    expect(() => assertExecutionSelectedModel(authority.model)).not.toThrow()
    expect(() => assertExecutionSelectedModel({ ...authority.model, variant: 'high' })).not.toThrow()
    for (const model of [
      { ...authority.model, variant: '' }, { ...authority.model, variant: undefined },
      { ...authority.model, variant: null }, { ...authority.model, variant: 7 },
      { ...authority.model, variant: 'x'.repeat(4097) }, { ...authority.model, variant: 'hi\0gh' },
      { ...authority.model, variant: 'high', temperature: 0 },
    ]) expect(() => assertExecutionSelectedModel(model as unknown as SessionAuthority['model'])).toThrow()
  })
  // Red if matching foreign native selection alone promotes RESERVED creation
  // into admission authority. The diagnostic read must preserve exact bytes.
  test('merely reserved creation cannot adopt a foreign pre-existing native session', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-r237-foreign-session-'))
    const store = await OpenCodeV2AdmissionStore.open(root, authority)
    let creates = 0, prompts = 0, readID = ''
    const consumer = client({ createSession: async () => { creates++; return session() },
      getSession: async id => { readID = id; return session() },
      promptQueue: async () => { prompts++; return receipt(intent(1)) } })
    try {
      await store.reserveSession()
      const bytes = await readFile(store.filePath, 'utf8')
      const read = await new OpenCodeV2SessionService(consumer, store, authority).readSession()
      expect(read.disposition).toBe('unknown'); expect(read.session?.id).toBe('ses_TEST1')
      expect(readID).toBe('ses_TEST1'); expect(await readFile(store.filePath, 'utf8')).toBe(bytes)
      expect((await new OpenCodeV2SessionService(consumer, store, authority).createSession()).disposition).toBe('rejected')
      await expect(new OpenCodeV2AdmissionService(consumer, store, authority).admitQueue(intent(1), true)).rejects.toThrow('session_fenced')
      expect(creates).toBe(0); expect(prompts).toBe(0)
      expect((await store.snapshot()).creation.state).toBe('reserved')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  // Red if a proved-unsubmitted creation can subsequently adopt foreign state.
  test('unsubmitted creation remains fenced after original-ID readback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-r237-unsubmitted-session-'))
    const store = await OpenCodeV2AdmissionStore.open(root, authority)
    let calls = 0
    const sessions = new OpenCodeV2SessionService(client({ createSession: async () => {
      calls++; rejectExecutionBeforeInvocation('TEST-not-invoked')
    }, getSession: async () => calls === 0 ? nativeSessionMissing() : session() }), store, authority)
    try {
      expect((await sessions.createSession()).disposition).toBe('rejected')
      const bytes = await readFile(store.filePath, 'utf8')
      expect((await sessions.readSession()).disposition).toBe('unknown')
      expect(await readFile(store.filePath, 'utf8')).toBe(bytes)
      expect((await sessions.createSession()).disposition).toBe('unknown')
      expect(calls).toBe(1)
      expect((await store.snapshot()).creation.state).toBe('not_submitted')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  // Red if a status/tag forged outside the owned wire becomes create authority,
  // or an uncertain preflight marks a submission that never happened.
  test('uncertain or unqualified missing-session reads authorize zero creation', async () => {
    for (const failure of [new Error('TEST-read-loss'),
      { _tag: 'SessionNotFoundError', sessionID: authority.sessionID, message: 'TEST-forged' }]) {
      const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-r237-preflight-'))
      const store = await OpenCodeV2AdmissionStore.open(root, authority)
      let creates = 0
      const sessions = new OpenCodeV2SessionService(client({ getSession: async () => { throw failure },
        createSession: async () => { creates++; return session() } }), store, authority)
      try {
        expect((await sessions.createSession()).disposition).toBe('unknown')
        expect(creates).toBe(0)
        const saved = await store.snapshot()
        expect(saved.creation.state).toBe('reserved'); expect(saved.authority.sessionID).toBe('ses_TEST1')
        expect(saved.admissions).toHaveLength(0)
      } finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  // Red if a matching foreign enqueue promotes a never-submitted intent, or
  // recovery inspects foreign evidence despite proved non-submission.
  test('prepared and proved-unsubmitted intents cannot adopt matching foreign native admission', async () => {
    for (const state of ['prepared', 'not_submitted'] as const) {
      const fixture = await setup(), input = intent(1)
      let foreignPresent = false, recoveryReads = 0, promptCalls = 0
      const consumer = client({
        getSession: async () => { if (foreignPresent) recoveryReads++; return session() },
        log: async () => {
          if (foreignPresent) { recoveryReads++; return cut(input) }
          return { synced: true, watermark: 1, events: cut(input).events.slice(0, 1) }
        },
        inbox: async () => { if (foreignPresent) recoveryReads++; return foreignPresent ? [receipt(input)] : [] },
        promptQueue: async () => { promptCalls++; rejectExecutionBeforeInvocation('TEST-proved-unsubmitted') },
      })
      const service = new OpenCodeV2AdmissionService(consumer, fixture.store, authority)
      try {
        const original = state === 'prepared' ? await fixture.store.reserve(input.identity,
          executionHash({ input: { text: input.input.text }, delivery: 'queue', resume: true }),
          { beforeCursor: 1, beforeUserIDs: [] }) : await service.admitQueue(input, true)
        expect(original.state).toBe(state)
        const bytes = await readFile(fixture.store.filePath, 'utf8'), callsBefore = promptCalls
        foreignPresent = true // complete matching inbox/enqueue exists outside our submission
        expect(await service.reconcileOriginalInput(input)).toEqual(original)
        expect(recoveryReads).toBe(0); expect(promptCalls).toBe(callsBefore)
        expect(await readFile(fixture.store.filePath, 'utf8')).toBe(bytes)
        const retained = (await fixture.store.snapshot()).admissions[0]
        expect(retained?.identity).toEqual(input.identity); expect(retained?.state).toBe(state)
        expect(retained?.returnedInboxID).toBeUndefined(); expect(retained?.nativePayloadHash).toBeUndefined()
      } finally { await fixture.close() }
    }
  })
  // Red if fetch precedes submitting persistence or recovery replays an ID.
  test('response loss retains one physical original mutation and read-only recovery', async () => {
    const fixture = await setup(), input = intent(1)
    let requests = 0, journalAtBoundary = '', observedID = '', attempted = false
    const server = createServer(async (req, res) => {
      requests++
      journalAtBoundary = await readFile(fixture.store.filePath, 'utf8')
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      observedID = JSON.parse(Buffer.concat(chunks).toString()).id
      req.socket.destroy() // independent HTTP peer cuts after durable admission
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('TEST-listener')
    const consumer = client({ promptQueue: async (_id, input) => {
      attempted = true
      await fetch(`http://127.0.0.1:${address.port}`, { method: 'POST', body: JSON.stringify({ id: input.nativeInputID, text: input.text }) })
      throw new Error('lost response')
    }, inbox: async () => [receipt(input)], log: async () => attempted ? cut(input) : ({ synced: true, watermark: 1, events: cut(input).events.slice(0, 1) }) })
    try {
      const service = new OpenCodeV2AdmissionService(consumer, fixture.store, authority)
      const unknown = await service.admitQueue(input, true)
      expect(unknown.state).toBe('unknown')
      expect(JSON.parse(journalAtBoundary).admissions[0].state).toBe('submitting')
      expect(observedID).toBe('msg_TEST1')
      const recovered = await service.reconcileOriginalInput(input)
      expect(recovered.disposition).toBe('pending'); expect(recovered.returnedInboxID).toBe('msg_TEST1')
      expect(recovered.projectedUserID).toBeUndefined()
      expect(recovered.complete).toBe(true); expect(recovered.cursor).toBe(2)
      await service.admitQueue(input, true)
      expect(requests).toBe(1)
      await expect(service.admitQueue(intent(2), true)).rejects.toThrow('session_fenced')
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); await fixture.close() }
  })
  // Red if a new ID/payload, run, tombstone or cross-host alias grants effects.
  test('conflicts, changed session selection and stop fence cause zero subsequent mutations', async () => {
    const f = await setup(); let requests = 0
    const service = new OpenCodeV2AdmissionService(client({ promptQueue: async () => { requests++; throw new Error('lost') } }), f.store, authority)
    try {
      await service.admitQueue(intent(1), true)
      const changed = intent(1); changed.input.text = 'changed payload'
      await expect(service.admitQueue(changed, true)).rejects.toThrow('intent_conflict')
      expect(await service.fenceStop()).toEqual(['msg_TEST1'])
      await expect(service.admitQueue(intent(2), true)).rejects.toThrow('session_fenced')
      const otherRun = { ...authority, runId: 'other-run' }
      const otherStore = await OpenCodeV2AdmissionStore.open(f.root, otherRun)
      await expect(otherStore.reserveSession()).rejects.toThrow('authority_conflict')
      const otherHost = { ...authority, host: { ...authority.host, hostInstanceId: 'other-host' } }
      expect(() => new OpenCodeV2AdmissionService(client(), f.store, otherHost)).toThrow('authority_conflict')
      const foreignStore = await OpenCodeV2AdmissionStore.open(f.root, otherHost)
      expect(() => new OpenCodeV2AdmissionService(client(), foreignStore, authority)).toThrow('authority_conflict')
      const selected = new OpenCodeV2AdmissionService(client({ getSession: async () => ({ ...session(), agent: 'foreign' }) }), f.store, authority)
      await expect(selected.admitQueue(intent(3), true)).rejects.toThrow('session_selection_changed')
      expect(requests).toBe(1)
    } finally { await f.close() }
  })
  // Red if a future schema is rewritten, or a stale slot writer crosses CAS.
  test('unknown bytes retained and competing persisted owners cannot both submit', async () => {
    const f = await setup()
    try {
      const peer = await OpenCodeV2AdmissionStore.open(f.root, authority)
      const reserved = await f.store.reserve(intent(1).identity, executionHash('TEST-payload'))
      const outcomes = await Promise.allSettled([f.store.submitting('request-1', reserved.revision), peer.submitting('request-1', reserved.revision)])
      expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1)
      const bytes = '{"schema":77,"generation":"v2","unknown":"retain exact bytes"}\n'
      await writeFile(f.store.filePath, bytes)
      await expect(peer.reserveSession()).rejects.toThrow()
      expect(await readFile(f.store.filePath, 'utf8')).toBe(bytes)
    } finally { await f.close() }
  })
  // Red if incomplete pages/reordered logs commit a highest-observed cursor.
  test('pagination exhaustion, inconsistent brackets and log gaps preserve committed evidence', async () => {
    const f = await setup(), input = intent(1)
    let mode = 'initial', reads = 0
    const service = new OpenCodeV2AdmissionService(client({ promptQueue: async () => { throw new Error('loss') },
      inbox: async () => [receipt(input)], messages: async () => ({ data: [], previous: null, next: mode === 'pages' ? 'loop' : null }),
      log: async () => { reads++; if (mode === 'initial') return { events: [], synced: true, watermark: null }; const original = cut(input); return mode === 'gap' ? { ...original, watermark: 8 } :
        mode === 'race' && reads % 2 === 0 ? { ...original, events: original.events.slice(0, 1), watermark: 1 } : original },
    }), f.store, authority)
    try {
      const original = await service.admitQueue(input, true)
      for (const value of ['pages', 'gap', 'race']) {
        mode = value; reads = 0
        const result = await service.readOriginalInput(input)
        expect(result.cursor).toBeNull(); expect(result.state).toBe('unknown'); expect(result.revision).toBe(original.revision)
      }
    } finally { await f.close() }
  })
  // Red if resume:true is implemented as a synthesized fourth/wake mutation.
  test('explicit A/B/W series binds THREE distinct intents and never synthesizes input', async () => {
    const f = await setup(), inputs = [intent(1, false), intent(2, false), intent(3, true)] as const
    const physical: { id: string; resume: boolean }[] = []
    const service = new OpenCodeV2AdmissionService(client({ promptQueue: async (_session, i) => {
      physical.push({ id: i.nativeInputID, resume: i.resume }); return receipt(inputs.find(x => x.identity.nativeInputID === i.nativeInputID)!)
    } }), f.store, authority)
    try {
      await service.reserveParkedSeries(inputs)
      for (const i of inputs) expect((await service.admitQueue(i, i.input.resume)).state).toBe('accepted')
      expect(physical).toEqual([{ id: 'msg_TEST1', resume: false }, { id: 'msg_TEST2', resume: false }, { id: 'msg_TEST3', resume: true }])
      await expect(service.admitQueue(intent(4), true)).rejects.toThrow()
    } finally { await f.close() }
  })
  // Red if normalized native file content or expanded skills are compared to
  // request JSON, rejecting valid attachments or silently changing their URI.
  test('enriched native attachments preserve request source and reject altered source', async () => {
    const f = await setup(), input = intent(1)
    input.input.files = [{ uri: 'file:///TEST-note', name: 'note' }]; input.input.skills = [{ id: 'TEST-skill' }]
    const nativePayload = { text: input.input.text, files: [{ source: { type: 'uri', uri: 'file:///TEST-note' }, data: 'TEST-file-bytes', mime: 'text/plain', name: 'note' }], skills: [{ id: 'TEST-skill', name: 'Native name', text: 'Native content' }] }
    const service = new OpenCodeV2AdmissionService(client({ promptQueue: async () => ({ ...receipt(input), payload: nativePayload }) }), f.store, authority)
    try {
      const accepted = await service.admitQueue(input, true)
      expect(accepted.state).toBe('accepted'); expect(accepted.nativePayloadHash).toBe(executionHash(nativePayload))
      const peer = await setup()
      try {
        const changed = { ...nativePayload, files: [{ ...nativePayload.files[0]!, source: { type: 'uri', uri: 'file:///foreign' } }] }
        const bad = new OpenCodeV2AdmissionService(client({ promptQueue: async () => ({ ...receipt(input), payload: changed }) }), peer.store, authority)
        expect((await bad.admitQueue(input, true)).state).toBe('unknown')
      } finally { await peer.close() }
    } finally { await f.close() }
  })
  // Red if uncertain create is retried with an original or replacement ID.
  test('uncertain session creation reconciles the reserved ID without recreate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-r207-create-'))
    const store = await OpenCodeV2AdmissionStore.open(root, authority); let calls = 0, readID = ''
    const service = new OpenCodeV2SessionService(client({ createSession: async () => { calls++; throw new Error('loss') },
      getSession: async id => { readID = id; return calls === 0 ? nativeSessionMissing() : session() } }), store, authority)
    try {
      expect((await service.createSession()).disposition).toBe('unknown')
      expect((await service.createSession()).disposition).toBe('accepted')
      expect(calls).toBe(1); expect(readID).toBe('ses_TEST1')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})


describe('qualified original terminal slot settlement', () => {
  function terminalFixture(selectedAuthority = authority) {
    const original = intent(1)
    let sent = false
    const log: ExecutionLog = { synced: true, watermark: 8, events: [...cut(original).events,
      { id: 'evt_start', type: 'session.execution.started', seq: 3, aggregateID: selectedAuthority.sessionID, data: { sessionID: selectedAuthority.sessionID } },
      { id: 'evt_delivery', type: 'session.inbox.delivered', seq: 4, aggregateID: selectedAuthority.sessionID, data: { sessionID: selectedAuthority.sessionID, inboxID: original.identity.nativeInputID } },
      { id: 'evt_step', type: 'session.step.started', seq: 5, aggregateID: selectedAuthority.sessionID, data: { sessionID: selectedAuthority.sessionID, assistantMessageID: 'msg_assistant', agent: selectedAuthority.agent, model: selectedAuthority.model } },
      { id: 'evt_text', type: 'session.text.ended', seq: 6, aggregateID: selectedAuthority.sessionID, data: { sessionID: selectedAuthority.sessionID, assistantMessageID: 'msg_assistant', text: 'done' } },
      { id: 'evt_stepend', type: 'session.step.ended', seq: 7, aggregateID: selectedAuthority.sessionID, data: { sessionID: selectedAuthority.sessionID, assistantMessageID: 'msg_assistant', finish: 'stop' } },
      { id: 'evt_terminal', type: 'session.execution.succeeded', seq: 8, aggregateID: selectedAuthority.sessionID, data: { sessionID: selectedAuthority.sessionID } },
    ] }
    const messages: import('../transport/OpenCodeV2ExecutionClientFactory.js').ExecutionMessage[] = [
      { id: original.identity.nativeInputID, timeCreated: 1, type: 'user', data: { id: original.identity.nativeInputID, timeCreated: 1, type: 'user', text: original.input.text } },
      { id: 'msg_assistant', timeCreated: 1, type: 'assistant', data: { id: 'msg_assistant', timeCreated: 1, type: 'assistant', agent: selectedAuthority.agent, model: selectedAuthority.model, time: { created: 1, completed: 2 }, finish: 'stop', content: [{ type: 'text', text: 'done' }] } },
      { id: 'msg_terminal', timeCreated: 1, type: 'idle', data: { outcome: 'succeeded' } },
    ]
    const owned = client({ promptQueue: async (_sessionID, input) => { sent = true; return receipt({ ...original, input, identity: { ...original.identity, nativeInputID: input.nativeInputID } }) },
      log: async () => sent ? log : { events: [], synced: true, watermark: null },
      messages: async (_sessionID, cursor) => sent && cursor === undefined
        ? { data: messages, previous: 'TEST-newest', next: 'TEST-oldest' } : { data: [], previous: null, next: null } }, selectedAuthority)
    return { original, owned, log, messages }
  }
  test('queue acceptance remains held until native terminal, then replay cannot release successor', async () => {
    const f = await setup(), native = terminalFixture()
    try {
      const service = new OpenCodeV2AdmissionService(native.owned, f.store, authority)
      await service.admitQueue(native.original, true)
      expect((await f.store.snapshot()).slot).toBe(native.original.identity.requestId)
      await expect(service.admitQueue(intent(2), true)).rejects.toThrow('session_fenced')
      await service.settleOriginalInput(native.original)
      expect((await f.store.snapshot()).slot).toBeNull()
      await service.admitQueue(intent(2), true)
      await service.settleOriginalInput(native.original)
      expect((await f.store.snapshot()).slot).toBe(intent(2).identity.requestId)
      expect((await f.store.snapshot()).terminalSettlements).toHaveLength(1)
      expect(await f.store.fenceStop()).toEqual([intent(2).identity.nativeInputID])
    } finally { await f.close() }
  })
  for (const pin of ['2.0.0', '2.0.21'] as const) test(`${pin} wrong assistant model cannot mint an original terminal proof`, async () => {
    const selectedAuthority: SessionAuthority = { ...authority, host: { ...authority.host, pin,
      dialect: pin === '2.0.0' ? 'v2-2.0.0' : 'v2-2.0.21', selectedCli: { ...authority.host.selectedCli, version: pin } } }
    const f = await setup(selectedAuthority), native = terminalFixture(selectedAuthority)
    try {
      const service = new OpenCodeV2AdmissionService(native.owned, f.store, selectedAuthority)
      await service.admitQueue(native.original, true)
      const observed = await service.readOriginalInput(native.original)
      const assistant = native.messages.find(row => row.type === 'assistant')
      if (!assistant) throw new Error('TEST-assistant-missing')
      const index = native.messages.indexOf(assistant)
      native.messages[index] = { ...assistant, data: { ...assistant.data, model: { ...selectedAuthority.model, variant: 'foreign' } } }
      await expect(readOriginalTerminal(native.owned, selectedAuthority, native.original, observed)).rejects.toThrow('terminal_assistant_selection_changed')
      expect((await f.store.snapshot()).slot).toBe(native.original.identity.requestId)
    } finally { await f.close() }
  })
  test('partial or missing native terminal cannot release an accepted slot', async () => {
    const f = await setup(), native = terminalFixture()
    try {
      const service = new OpenCodeV2AdmissionService(native.owned, f.store, authority)
      await service.admitQueue(native.original, true)
      native.log.events.pop(); native.log.watermark = 7
      await service.settleOriginalInput(native.original)
      expect((await f.store.snapshot()).slot).toBe(native.original.identity.requestId)
    } finally { await f.close() }
  })
  test('copied proof DTO cannot authorize settlement; concurrent stop retains tombstone', async () => {
    const f = await setup(), native = terminalFixture()
    try {
      const service = new OpenCodeV2AdmissionService(native.owned, f.store, authority)
      await service.admitQueue(native.original, true)
      const observed = await service.readOriginalInput(native.original)
      const proof = await readOriginalTerminal(native.owned, authority, native.original, observed)
      expect(proof).not.toBeNull()
      if (!proof) throw new Error('TEST-terminal-proof-missing')
      await expect(f.store.settleOriginalTerminal({ ...proof })).rejects.toThrow('terminal_proof_not_owned')
      await f.store.fenceStop()
      await expect(f.store.settleOriginalTerminal(proof)).rejects.toThrow('terminal_revision_conflict')
      expect((await f.store.snapshot()).tombstone).toBe(true)
      expect((await f.store.snapshot()).slot).toBe(native.original.identity.requestId)
    } finally { await f.close() }
  })
  test('revision drift invalidates a branded proof without freeing a successor slot', async () => {
    const f = await setup(), native = terminalFixture()
    try {
      const service = new OpenCodeV2AdmissionService(native.owned, f.store, authority)
      await service.admitQueue(native.original, true)
      const observed = await service.readOriginalInput(native.original)
      const proof = await readOriginalTerminal(native.owned, authority, native.original, observed)
      if (!proof) throw new Error('TEST-terminal-proof-missing')
      await service.readOriginalInput(native.original)
      await expect(f.store.settleOriginalTerminal(proof)).rejects.toThrow('terminal_revision_conflict')
      expect((await f.store.snapshot()).slot).toBe(native.original.identity.requestId)
    } finally { await f.close() }
  })
})


// Native handlers on both qualified pins emit edge cursors for every nonempty
// page, even two messages. Only a real empty tail completes this bracketed cut.
test('native edge cursor traversal reaches empty tail and rejects partial/mutable cuts', async () => {
  const rows = [
    { id: 'msg_user', type: 'user', timeCreated: 1, data: { id: 'msg_user', type: 'user', text: 'original' } },
    { id: 'msg_assistant', type: 'assistant', timeCreated: 2, data: { id: 'msg_assistant', type: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
  ]
  const seen: (string | undefined)[] = []
  const complete = client({ messages: async (_session, cursor) => {
    seen.push(cursor)
    return cursor === undefined ? { data: rows, previous: 'native-newer-edge', next: 'native-older-edge' }
      : { data: [], previous: null, next: null }
  } })
  expect((await readExecutionCut(complete, authority.sessionID)).messages).toEqual(rows)
  expect(seen).toEqual([undefined, 'native-older-edge'])
  for (const mode of ['duplicate', 'cursor-loop', 'page-bound', 'changed-log', 'nonempty-no-cursor'] as const) {
    let page = 0, logs = 0
    const partial = client({
      messages: async () => {
        page++
        if (mode === 'changed-log') return { data: [], previous: null, next: null }
        if (mode === 'nonempty-no-cursor') return { data: rows, previous: null, next: null }
        return { data: mode === 'duplicate' ? rows : [{ ...rows[0]!, id: `msg_${page}` }],
          previous: 'edge', next: mode === 'page-bound' ? `older_${page}` : 'same-edge' }
      },
      log: async () => {
        logs++
        return mode === 'changed-log' && logs > 1 ? cut(intent(1)) : { events: [], synced: true, watermark: null }
      },
    })
    await expect(readExecutionCut(partial, authority.sessionID)).rejects.toThrow(mode === 'changed-log' ? 'mutable_readback' : 'incomplete_transcript')
    expect(page).toBeLessThanOrEqual(8)
  }
})
