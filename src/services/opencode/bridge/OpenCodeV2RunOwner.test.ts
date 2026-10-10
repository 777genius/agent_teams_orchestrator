import { fileURLToPath } from 'node:url'
import { describe, expect, test, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OpenCodeV2RunOwner } from './OpenCodeV2RunOwner.js'
import { reserveRunControlDirectory } from './OpenCodeV2RunControl.js'
import type { RunExecutionPorts, RunLaunchPlan } from './OpenCodeV2RunTypes.js'
import type { ExecutionAuthority, SessionAuthority } from '../execution/OpenCodeV2ExecutionContracts.js'
import { OpenCodeV2AdmissionStore } from '../execution/OpenCodeV2AdmissionStore.js'
import type { ExecutionBridgeClient, ExecutionInbox, ExecutionLog, ExecutionMessage } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import { ExecutionTransportFailure, OpenCodeV2ExecutionFetch } from '../transport/OpenCodeV2ExecutionFetch.js'
import type { QueueIntent } from '../execution/OpenCodeV2AdmissionService.js'

// These tests cross the real durable session/admission boundary with fake
// native/lease ports. They neither import an official server nor mint a native
// containment qualification. Same-fields fake close results must stay unknown.
async function missingSession(sessionID: string): Promise<never> {
  const endpoint = 'http://127.0.0.1:1'
  const wire = new OpenCodeV2ExecutionFetch(endpoint, '2.0.21', '/TEST-project', 'TEST-only',
    { deadline: Date.now() + 5000 }, async () => new Response(JSON.stringify({
      _tag: 'SessionNotFoundError', sessionID, message: 'synthetic missing',
    }), { status: 404, headers: { 'content-type': 'application/json' } }))
  try { await wire.fetch(`${endpoint}/api/session/${sessionID}`); throw new Error('missing_not_classified') }
  finally { await wire.dispose() }
}
const intent: QueueIntent = { delivery: 'queue', identity: {
  requestId: 'request', deliveryAttemptId: 'attempt', localMessageId: 'local', nativeInputID: 'msg_TESTinput',
}, input: { nativeInputID: 'msg_TESTinput', text: 'hello worker', resume: true } }

async function fixture(options: { unknown?: boolean; foreignClient?: boolean;
  promptBarrier?: Promise<void>; closeBarrier?: Promise<void>; permissionResources?: string[];
  lifetimeMs?: number; twoMembers?: boolean; preparation?: () => void; startup?: () => void;
  permissions?: import('../host/OpenCodeV2ExecutionBinding.js').ExecutionSelection['permissions'] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-r249-owner-'))
  const authority: ExecutionAuthority = { generation: 'v2', pin: '2.0.21', dialect: 'v2-2.0.21',
    graphSha256: 'a'.repeat(64), selectedCli: { path: '/TEST-opencode', sha256: 'b'.repeat(64), version: '2.0.21' },
    child: { pid: 42, birth: { format: 'linux-start-ticks', value: '42', bootId: 'TEST' }, executablePath: '/TEST-bun', sha256: 'c'.repeat(64) },
    hostInstanceId: 'TEST-host', profileEpoch: 'TEST-epoch', profileRoot: '/TEST-profile', directory: '/TEST-project', leaseOwnerId: 'TEST-owner' }
  const value = 'silent TEST context', counters = { acquired: 0, prompted: 0, closed: 0, interrupted: 0, replied: 0 }
  const binding = { teamId: 'TEST-team', runId: 'TEST-run', ownerId: 'TEST-owner', controllerInstanceId: 'TEST-controller' }
  let plan: RunLaunchPlan = { dataRoot: root, binding, deadline: Date.now() + (options.lifetimeMs ?? 15_000),
    source: { entryPath: '/TEST-entry.ts', entrySha256: 'd'.repeat(64), bunPath: '/TEST-bun', bunSha256: 'c'.repeat(64),
      files: [{ path: '/TEST-entry.ts', sha256: 'd'.repeat(64) }], env: {} },
    members: [{ memberId: 'worker', laneId: 'primary', originalSessionId: 'ses_TESToriginal',
      native: { generation: 'v2', version: '2.0.21', dialect: 'v2-2.0.21', executablePath: '/TEST-opencode',
        executableSha256: 'b'.repeat(64), packageName: '@opencode/cli-linux-x64', runtimeMode: 'source', entrySha256: 'e'.repeat(64),
        bun: { path: '/TEST-bun', sha256: 'c'.repeat(64) }, graph: { sha256: 'a'.repeat(64), files: [] } },
      profile: { epoch: 'TEST-epoch', root: '/TEST-profile', directory: '/TEST-project', databasePath: '/TEST-profile/data/db',
        env: {}, envSha256: 'f'.repeat(64), config: { directory: '/TEST-profile/config', content: JSON.stringify({ mcp: { servers: { 'agent-teams': { type: 'local', command: [process.execPath, fileURLToPath(new URL('./fixtures/OpenCodeV2ControllerToolsPeer.ts', import.meta.url))] } } } }), sha256: 'f'.repeat(64) },
        selection: { agent: 'worker', model: { providerID: 'TEST-provider', id: 'TEST-model' }, permissions: options.permissions ?? [{ action: '*', resource: '*', effect: 'ask' }] } },
      bootstrap: { key: 'test.context', value, contextHash: createHash('sha256').update(value).digest('hex'), briefingHash: 'f'.repeat(64) },
      controllerMcpName: 'agent-teams', advertisedTools: ['message_send'] }],
  }
  if (options.twoMembers) {
    const first = plan.members[0]!
    plan = { ...plan, members: [...plan.members, { ...first,
      memberId: 'worker-2', originalSessionId: 'ses_TESTsecond',
      profile: { ...first.profile, root: '/TEST-profile-2', epoch: 'TEST-epoch-2' } }] }
  }
  const created = new Set<string>()
  let instruction: Parameters<ExecutionBridgeClient['putInstruction']>[2] = null
  let drift = false, resolvePrompted: () => void = () => undefined
  const prompted = new Promise<void>(resolve => { resolvePrompted = resolve })
  let resolveClosing: () => void = () => undefined
  const closingStarted = new Promise<void>(resolve => { resolveClosing = resolve })
  let selectedAuthority = authority
  const native: ExecutionBridgeClient = {
    get authority() { return options.foreignClient ? structuredClone(selectedAuthority) : selectedAuthority },
    getSession: async id => {
      if (!created.has(id)) return missingSession(id)
      return { id: drift ? 'ses_TESTchanged' : id, directory: '/TEST-project', agent: 'worker',
        model: { providerID: 'TEST-provider', id: 'TEST-model' }, timeCreated: 1 }
    },
    createSession: async input => { created.add(input.sessionID); return { id: input.sessionID, directory: '/TEST-project',
      agent: input.agent, model: input.model, timeCreated: 1 } },
    promptQueue: async (sessionID, input): Promise<ExecutionInbox> => {
      counters.prompted++; resolvePrompted(); await options.promptBarrier
      if (options.unknown) throw new ExecutionTransportFailure('synthetic_timeout', 'unknown')
      return { id: input.nativeInputID, sessionID, type: 'user', timeCreated: 1, delivery: 'queue', payload: { text: input.text } }
    },
    log: async () => ({ events: [], synced: true, watermark: null }),
    messages: async () => ({ data: [], next: null, previous: null }), inbox: async () => [], dispose: async () => {},
    putInstruction: async (_id, _key, input) => { instruction = input }, instructions: async () => [{ key: 'test.context', value: instruction }],
    connectMcp: async () => {}, disconnectMcp: async () => {}, addMcp: async () => {},
    mcp: async () => [{ name: 'agent-teams', status: 'connected' }],
    interrupt: async () => { counters.interrupted++; return { interrupted: true } }, cancelInbox: async () => {},
    permissions: async () => [], permission: async (sessionID, id) => ({ id, sessionID, action: 'edit', resources: options.permissionResources ?? ['TEST-file'] }),
    replyPermission: async () => { counters.replied++ },
  }
  const ports: RunExecutionPorts = {
    acquire: async (_native, _profile, context) => {
      expect(context).toMatchObject({ teamId: binding.teamId, runId: binding.runId, laneId: 'primary' })
      expect(plan.members.some(member => member.memberId === context.memberId)).toBe(true)
      const owned = context.memberId === 'worker' ? authority : { ...authority,
        profileRoot: '/TEST-profile-2', profileEpoch: 'TEST-epoch-2' }
      selectedAuthority = owned
      counters.acquired++
      options.preparation?.()
      return { authority: owned, signal: new AbortController().signal, close: async () => {
        counters.closed++
        resolveClosing(); await options.closeBarrier
        return { scopeClosed: true, processRetired: true, descendantsRetired: true, pid: authority.child.pid, birth: authority.child.birth }
      } }
    },
    client: async (owned, context) => {
      expect(owned.profileRoot).toBe(native.authority.profileRoot)
      options.startup?.()
      if (Date.now() >= context.deadline) throw new Error('deadline')
      return native
    },
  }
  const directory = await reserveRunControlDirectory(root, binding, 'f'.repeat(64))
  const owner = new OpenCodeV2RunOwner(plan, directory, ports)
  const selected = { memberId: 'worker', originalSessionId: 'ses_TESToriginal' }
  const sessionAuthority: SessionAuthority = { host: authority, teamId: binding.teamId, runId: binding.runId, laneId: 'primary', memberId: 'worker',
    sessionID: 'ses_TESToriginal', agent: 'worker', model: { providerID: 'TEST-provider', id: 'TEST-model' } }
  return { owner, counters, prompted, closingStarted, selected, directory, root, native, sessionAuthority,
    drift: () => { drift = true }, store: () => OpenCodeV2AdmissionStore.open(root, sessionAuthority),
    close: async () => { await owner.stop(); await owner.awaitCleanupTerminal(); await rm(root, { recursive: true, force: true }) } }
}

// Native terminal evidence can exist without a delivery-observe RPC. The owner
// must reconcile that exact original before reserving a subsequent queue input.
function publishTerminal(f: Awaited<ReturnType<typeof fixture>>, terminal = true) {
  const a = f.sessionAuthority, sessionID = a.sessionID, nativeInputID = intent.identity.nativeInputID
  const events: ExecutionLog['events'] = [
    { id: 'enqueued', type: 'session.inbox.enqueued', seq: 1, aggregateID: sessionID,
      data: { sessionID, inboxID: nativeInputID, item: { type: 'user', delivery: 'queue', payload: { text: intent.input.text } } } },
    { id: 'started', type: 'session.execution.started', seq: 2, aggregateID: sessionID, data: { sessionID } },
    { id: 'delivered', type: 'session.inbox.delivered', seq: 3, aggregateID: sessionID, data: { sessionID, inboxID: nativeInputID } },
    { id: 'step', type: 'session.step.started', seq: 4, aggregateID: sessionID,
      data: { sessionID, assistantMessageID: 'msg_assistant', agent: a.agent, model: a.model } },
    { id: 'text', type: 'session.text.ended', seq: 5, aggregateID: sessionID,
      data: { sessionID, assistantMessageID: 'msg_assistant', text: 'done' } },
    { id: 'stepend', type: 'session.step.ended', seq: 6, aggregateID: sessionID,
      data: { sessionID, assistantMessageID: 'msg_assistant', finish: 'stop' } },
  ]
  if (terminal) events.push({ id: 'evt_terminal', type: 'session.execution.succeeded', seq: 7, aggregateID: sessionID, data: { sessionID } })
  const messages: ExecutionMessage[] = [
    { id: nativeInputID, timeCreated: 1, type: 'user', data: { id: nativeInputID, type: 'user', text: intent.input.text } },
    { id: 'msg_assistant', timeCreated: 1, type: 'assistant', data: { id: 'msg_assistant', type: 'assistant',
      agent: a.agent, model: a.model, time: { created: 1, completed: 2 }, finish: 'stop', content: [{ type: 'text', text: 'done' }] } },
    ...(terminal ? [{ id: 'msg_terminal', timeCreated: 1, type: 'idle', data: { outcome: 'succeeded' } }] : []),
  ]
  f.native.log = async () => ({ events, synced: true, watermark: events.at(-1)!.seq })
  f.native.messages = async (_id, cursor) => cursor === undefined
    ? { data: messages, previous: 'TEST-newest', next: 'TEST-oldest' } : { data: [], previous: null, next: null }
}
function successor(n: number): QueueIntent {
  return { delivery: 'queue', identity: { requestId: `request-${n}`, deliveryAttemptId: `attempt-${n}`,
    localMessageId: `local-${n}`, nativeInputID: `msg_TEST${n}` }, input: { nativeInputID: `msg_TEST${n}`, text: `next ${n}`, resume: true } }
}

describe('run-owned V2 lease/session/admission composition', () => {
  test('next send settles the exact native-completed original without an observe RPC or replay', async () => {
    const f = await fixture()
    try {
      await f.owner.ready()
      await f.owner.execute({ operation: 'send', ...f.selected, intent }, Date.now() + 5000)
      publishTerminal(f)
      const before = await (await f.store()).snapshot()
      expect(before.slot).toBe(intent.identity.requestId)
      expect(before.admissions[0]).toMatchObject({ complete: false, cursor: null })
      const next = successor(2)
      const result = await f.owner.execute({ operation: 'send', ...f.selected, intent: next }, Date.now() + 5000)
      expect(result).toMatchObject({ kind: 'send', admission: { identity: next.identity, state: 'accepted' } })
      const after = await (await f.store()).snapshot()
      expect(after.slot).toBe(next.identity.requestId)
      expect(after.terminalSettlements).toHaveLength(1)
      expect(f.counters.prompted).toBe(2)
      await f.owner.execute({ operation: 'send', ...f.selected, intent }, Date.now() + 5000)
      expect((await (await f.store()).snapshot()).slot).toBe(next.identity.requestId)
      expect(f.counters.prompted).toBe(2)
    } finally { await f.close() }
  })
  for (const unknown of [false, true]) test(`${unknown ? 'unknown' : 'nonterminal'} original still fences successors without replay`, async () => {
    const f = await fixture({ unknown })
    try {
      await f.owner.ready()
      await f.owner.execute({ operation: 'send', ...f.selected, intent }, Date.now() + 5000)
      if (!unknown) publishTerminal(f, false)
      await expect(f.owner.execute({ operation: 'send', ...f.selected, intent: successor(2) }, Date.now() + 5000)).rejects.toThrow('session_fenced')
      expect((await (await f.store()).snapshot()).slot).toBe(intent.identity.requestId)
      expect(f.counters.prompted).toBe(1)
    } finally { await f.close() }
  })
  test('concurrent successors cannot both reserve the completed original slot', async () => {
    const f = await fixture()
    try {
      await f.owner.ready()
      await f.owner.execute({ operation: 'send', ...f.selected, intent }, Date.now() + 5000)
      publishTerminal(f)
      const results = await Promise.allSettled([2, 3].map(n => f.owner.execute({ operation: 'send', ...f.selected, intent: successor(n) }, Date.now() + 5000)))
      // Competing strict readbacks may both lose a revision race. They may
      // refuse conservatively, but cannot reserve/enqueue two successors.
      const admitted = results.filter(result => result.status === 'fulfilled')
      expect(admitted.length).toBeLessThanOrEqual(1)
      expect(f.counters.prompted).toBe(1 + admitted.length)
      const stored = await (await f.store()).snapshot()
      expect(stored.admissions).toHaveLength(1 + admitted.length)
      expect((stored.terminalSettlements ?? []).length).toBeLessThanOrEqual(1)
      if (admitted.length) expect(['request-2', 'request-3']).toContain(stored.slot)
      else expect([intent.identity.requestId, null]).toContain(stored.slot)
    } finally { await f.close() }
  })

  for (const lifetimeMs of [120_000, 70_000]) test(`two serial 36s member startups respect shared initialization and original ${lifetimeMs}ms lifetime`, async () => {
    const origin = Date.now()
    let elapsed = 0
    const clock = spyOn(Date, 'now').mockImplementation(() => origin + elapsed)
    const f = await fixture({ lifetimeMs, twoMembers: true,
      preparation: () => { elapsed += 18_000 }, startup: () => { elapsed += 18_000 } })
    try {
      if (lifetimeMs === 120_000) {
        await f.owner.ready()
        expect(await f.owner.execute({ operation: 'status' }, Date.now() + 5000)).toMatchObject({ state: 'active',
          members: [{ state: 'accepted', bootstrap: { verified: true } }, { state: 'accepted', bootstrap: { verified: true } }] })
      } else await expect(f.owner.ready()).rejects.toThrow('deadline')
      expect(elapsed).toBe(72_000)
      expect(f.counters.acquired).toBe(2)
      expect(f.counters.prompted).toBe(0)
    } finally { clock.mockRestore(); await f.close() }
  })
  test('graph preparation and native startup share a bounded initialization budget', async () => {
    const origin = Date.now()
    let elapsed = 0
    const clock = spyOn(Date, 'now').mockImplementation(() => origin + elapsed)
    const f = await fixture({ lifetimeMs: 120_000,
      preparation: () => { elapsed += 18_000 }, startup: () => { elapsed += 16_000 } })
    try {
      await f.owner.ready()
      expect(elapsed).toBe(34_000)
      expect(await f.owner.execute({ operation: 'status' }, Date.now() + 5000)).toMatchObject({ state: 'active' })
      expect(f.counters.acquired).toBe(1)
      expect(f.counters.prompted).toBe(0)
    } finally { clock.mockRestore(); await f.close() }
  })
  test('initialization still expires at the original shorter run deadline', async () => {
    const origin = Date.now()
    let elapsed = 0
    const clock = spyOn(Date, 'now').mockImplementation(() => origin + elapsed)
    const f = await fixture({ lifetimeMs: 33_000,
      preparation: () => { elapsed += 18_000 }, startup: () => { elapsed += 16_000 } })
    try {
      await expect(f.owner.ready()).rejects.toThrow()
      expect(f.counters.acquired).toBe(1)
      expect(f.counters.prompted).toBe(0)
    } finally { clock.mockRestore(); await f.close() }
  })
  for (const unknown of [false, true]) test(`${unknown ? 'unknown' : 'accepted'} input cannot resend or change payload`, async () => {
    const f = await fixture({ unknown })
    try {
      await f.owner.ready()
      const request = { operation: 'send' as const, ...f.selected, intent }
      const first = await f.owner.execute(request, Date.now() + 5000)
      const again = await f.owner.execute(request, Date.now() + 5000)
      expect(first.kind).toBe('send'); expect(again.kind).toBe('send'); expect(f.counters.prompted).toBe(1)
      await expect(f.owner.execute({ ...request, intent: { ...intent, input: { ...intent.input, text: 'changed' } } }, Date.now() + 5000))
        .rejects.toThrow('run_intent_conflict')
      expect(f.counters.prompted).toBe(1)
      await expect(f.owner.execute({ operation: 'observe', ...f.selected, nativeInputID: intent.identity.nativeInputID,
        intent: { ...intent, input: { ...intent.input, text: 'changed during read-only replay' } } }, Date.now() + 5000))
        .rejects.toThrow('run_intent_conflict')
      expect(f.counters.prompted).toBe(1)
      const stored = JSON.parse(await readFile(path.join(f.directory, 'intents.json'), 'utf8'))
      expect(stored.members[0].intents[0].identity.nativeInputID).toBe('msg_TESTinput')
    } finally { await f.close() }
  })
  test('same-fields deserialized authority cannot replace owning lease object', async () => {
    const f = await fixture({ foreignClient: true })
    try { await expect(f.owner.ready()).rejects.toThrow('run_lease_not_owned'); await f.owner.stop(); expect(f.counters.closed).toBe(1); expect(f.counters.prompted).toBe(0) }
    finally { await f.close() }
  })
  test('changed native original session selection is refused before transport', async () => {
    const f = await fixture()
    try {
      await f.owner.ready(); f.drift()
      await expect(f.owner.execute({ operation: 'send', ...f.selected, intent }, Date.now() + 5000)).rejects.toThrow('session_selection_changed')
      expect(f.counters.prompted).toBe(0)
    } finally { await f.close() }
  })
  test('stop tombstones concurrent admission, refuses later sends, and closes owned lease once', async () => {
    let release: () => void = () => undefined
    const barrier = new Promise<void>(resolve => { release = resolve })
    const f = await fixture({ promptBarrier: barrier })
    try {
      await f.owner.ready()
      const sending = f.owner.execute({ operation: 'send', ...f.selected, intent }, Date.now() + 5000)
      void sending.catch(() => undefined)
      await f.prompted
      const stopping = f.owner.stop()
      await expect(f.owner.execute({ operation: 'send', ...f.selected, intent }, Date.now() + 5000)).rejects.toThrow('run_not_active')
      release(); await sending.catch(() => undefined); await stopping
      expect((await (await f.store()).snapshot()).tombstone).toBe(true)
      expect(JSON.parse(await readFile(path.join(f.directory, 'tombstone.json'), 'utf8')).binding.runId).toBe('TEST-run')
      expect(f.counters.prompted).toBe(1); expect(f.counters.closed).toBe(1)
    } finally { release(); await f.close() }
  })
  test('one allowed resource cannot widen a multi-resource native permission', async () => {
    const f = await fixture({ permissions: [{ action: 'edit', resource: 'TEST-file', effect: 'ask' }],
      permissionResources: ['TEST-file', 'foreign-file'] })
    try {
      await f.owner.ready()
      const request = { operation: 'permissionReply' as const, ...f.selected, requestId: 'perm_TEST', decision: 'allow' as const }
      await expect(f.owner.execute(request, Date.now() + 5000)).rejects.toThrow('run_permission_policy_denied')
      expect(f.counters.replied).toBe(0)
      const denied = await f.owner.execute({ ...request, decision: 'deny' }, Date.now() + 5000)
      expect(denied).toEqual({ kind: 'permissionReply', status: 'unknown' })
      expect(f.counters.replied).toBe(1)
    } finally { await f.close() }
  })
  test('same-fields fake lease close cannot publish physical cleanup success', async () => {
    const f = await fixture()
    try {
      await f.owner.ready()
      const stopped = await f.owner.stop()
      expect(stopped.state).toBe('cleanup_unknown')
      expect(stopped.members).toEqual([{ memberId: 'worker', cleanup: null, errors: ['physical_cleanup_unknown'] }])
      const archived = JSON.parse(await readFile(path.join(f.directory, 'stop.json'), 'utf8'))
      expect(archived.receipt.state).toBe('cleanup_unknown')
      expect(archived.receipt.members[0].cleanup).toBeNull()
      expect(f.counters.closed).toBe(1)
    } finally { await f.close() }
  })
  test('supervisor retirement joins the original close handle before releasing run files', async () => {
    let release: () => void = () => undefined
    const f = await fixture({ closeBarrier: new Promise<void>(resolve => { release = resolve }) })
    try {
      await f.owner.ready()
      const stopping = f.owner.stop()
      await f.closingStarted
      let retired = false
      const retiring = f.owner.awaitCleanupTerminal().then(() => { retired = true })
      await Promise.resolve(); await Promise.resolve()
      expect(retired).toBe(false)
      expect(f.counters.closed).toBe(1)
      release(); await stopping; await retiring
      expect(retired).toBe(true)
      expect(f.counters.closed).toBe(1)
    } finally { release(); await f.close() }
  })
})
