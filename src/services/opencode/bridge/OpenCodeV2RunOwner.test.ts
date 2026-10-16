import { fileURLToPath } from 'node:url'
import { describe, expect, test, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { OpenCodeV2RunOwner, projectRunOwnerEntryFailure } from './OpenCodeV2RunOwner.js'
import { reserveRunControlDirectory, serveOpenCodeV2RunControl, requestOpenCodeV2Run } from './OpenCodeV2RunControl.js'
import type { RunControlRequest, RunExecutionPorts, RunLaunchPlan } from './OpenCodeV2RunTypes.js'
import type { ExecutionAuthority, SessionAuthority } from '../execution/OpenCodeV2ExecutionContracts.js'
import { OpenCodeV2TeamBridge } from './OpenCodeV2TeamBridge.js'
import type { SendMessageOutcomeBase } from './OpenCodeBridgeDeliveryJournal.js'
import { OpenCodeV2AdmissionStore } from '../execution/OpenCodeV2AdmissionStore.js'
import type { ExecutionBridgeClient, ExecutionInbox, ExecutionLog, ExecutionMessage } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import { ExecutionTransportFailure, OpenCodeV2ExecutionFetch } from '../transport/OpenCodeV2ExecutionFetch.js'
import type { QueueIntent } from '../execution/OpenCodeV2AdmissionService.js'
import * as runControl from './OpenCodeV2RunControl.js'
import * as atomicWrite from '../../../utils/atomicWrite.js'

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

async function fixture(options: { unknown?: boolean; foreignClient?: boolean; createUnknown?: boolean;
  probe?: boolean; promptBarrier?: Promise<void>; closeBarrier?: Promise<void>; permissionResources?: string[];
  lifetimeMs?: number; twoMembers?: boolean; memberCount?: number; preparation?: () => void; startup?: () => void;
  windowsAcquisitions?: boolean;
  acquisition?: (memberId: string, signal: AbortSignal | undefined) => Promise<void>;
  permissions?: import('../host/OpenCodeV2ExecutionBinding.js').ExecutionSelection['permissions'] } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'TEST-r249-owner-')))
  const authority: ExecutionAuthority = { generation: 'v2', pin: '2.0.21', dialect: 'v2-2.0.21',
    graphSha256: 'a'.repeat(64), selectedCli: { path: '/TEST-opencode', sha256: 'b'.repeat(64), version: '2.0.21' },
    child: { pid: 42, birth: { format: 'linux-start-ticks', value: '42', bootId: 'TEST' }, executablePath: '/TEST-bun', sha256: 'c'.repeat(64) },
    hostInstanceId: 'TEST-host', profileEpoch: 'TEST-epoch', profileRoot: options.probe ? root : '/TEST-profile', directory: options.probe ? path.join(root, 'project') : '/TEST-project', leaseOwnerId: 'TEST-owner' }
  if (options.probe) {
    await mkdir(authority.directory); await mkdir(path.join(root, 'data/opencode'), { recursive: true })
    await writeFile(path.join(root, 'data/opencode/auth.json'), '{}', { mode: 0o600 })
  }
  const value = 'silent TEST context', counters = { acquired: 0, prompted: 0, closed: 0, interrupted: 0, replied: 0,
    clients: 0, sessions: 0, sessionReads: 0, cancelled: 0, disposed: 0 }
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
  if (options.probe) {
    const member = plan.members[0]!, config = JSON.parse(member.profile.config.content)
    plan = { ...plan, members: [{ ...member, profile: { ...member.profile, root, directory: authority.directory } }], executionProbe: { memberId: member.memberId, intent, expectedText: 'done', capabilitySnapshotId: 'TEST-capability',
      prepared: { projectPath: authority.directory, canonicalProjectPath: authority.directory, workingDirectoryPath: authority.directory,
        scopeToken: null, profileRootKey: 'TEST-profile', profileRootPath: root, projectBehaviorFingerprint: 'b'.repeat(64), behaviorSources: [],
        managedConfig: config, managedConfigFingerprint: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
        homePath: root, tmpPath: root, xdgConfigHome: root, xdgDataHome: root, xdgCacheHome: root,
        managedAuthPath: path.join(root, 'data/opencode/auth.json'), sourceAuthPath: null, sourceAuthFingerprint: null,
        managedAuthFingerprint: createHash('sha256').update('{}').digest('hex'), authState: 'missing', env: {} } } }
  }
  if (options.twoMembers || options.memberCount) {
    const first = plan.members[0]!
    plan = { ...plan, members: [first, ...Array.from({ length: (options.memberCount ?? 2) - 1 }, (_, index) => ({ ...first,
      memberId: `worker-${index + 2}`, originalSessionId: index === 0 ? 'ses_TESTsecond' : `ses_TEST${index + 2}`,
      profile: { ...first.profile, root: `/TEST-profile-${index + 2}`, epoch: `TEST-epoch-${index + 2}` } }))] }
  }
  const created = new Set<string>()
  const instructions = new Map<string, Parameters<ExecutionBridgeClient['putInstruction']>[2]>()
  let drift = false, resolvePrompted: () => void = () => undefined
  const prompted = new Promise<void>(resolve => { resolvePrompted = resolve })
  let resolveClosing: () => void = () => undefined
  const closingStarted = new Promise<void>(resolve => { resolveClosing = resolve })
  const native: ExecutionBridgeClient = {
    get authority() { return options.foreignClient ? structuredClone(authority) : authority },
    getSession: async id => {
      counters.sessionReads++
      if (!created.has(id)) return missingSession(id)
      return { id: drift ? 'ses_TESTchanged' : id, directory: authority.directory, agent: 'worker',
        model: { providerID: 'TEST-provider', id: 'TEST-model' }, timeCreated: 1 }
    },
    createSession: async input => {
      counters.sessions++
      if (options.createUnknown) throw new ExecutionTransportFailure('invalid_response', 'unknown')
      created.add(input.sessionID); return { id: input.sessionID, directory: authority.directory,
        agent: input.agent, model: input.model, timeCreated: 1 }
    },
    promptQueue: async (sessionID, input): Promise<ExecutionInbox> => {
      counters.prompted++; resolvePrompted(); await options.promptBarrier
      if (options.unknown) throw new ExecutionTransportFailure('synthetic_timeout', 'unknown')
      return { id: input.nativeInputID, sessionID, type: 'user', timeCreated: 1, delivery: 'queue', payload: { text: input.text } }
    },
    config: async () => [{ type: 'document', info: JSON.parse(plan.members[0]!.profile.config.content) }],
    log: async () => ({ events: [], synced: true, watermark: null }),
    messages: async () => ({ data: [], next: null, previous: null }), inbox: async () => [],
    dispose: async () => { counters.disposed++ },
    putInstruction: async (id, _key, input) => { instructions.set(id, input) },
    instructions: async id => [{ key: 'test.context', value: instructions.get(id)! }],
    connectMcp: async () => {}, disconnectMcp: async () => {}, addMcp: async () => {},
    mcp: async () => [{ name: 'agent-teams', status: 'connected' }],
    interrupt: async () => { counters.interrupted++; return { interrupted: true } },
    cancelInbox: async () => { counters.cancelled++ },
    permissions: async () => [], permission: async (sessionID, id) => ({ id, sessionID, action: 'edit', resources: options.permissionResources ?? ['TEST-file'] }),
    replyPermission: async () => { counters.replied++ },
  }
  const ports: RunExecutionPorts = {
    acquire: async (_native, _profile, context) => {
      expect(context).toMatchObject({ teamId: binding.teamId, runId: binding.runId, laneId: 'primary' })
      expect(plan.members.some(member => member.memberId === context.memberId)).toBe(true)
      const profile = plan.members.find(member => member.memberId === context.memberId)!.profile
      const owned = context.memberId === 'worker' ? authority : { ...authority,
        profileRoot: profile.root, profileEpoch: profile.epoch }
      counters.acquired++
      options.preparation?.()
      await options.acquisition?.(context.memberId!, context.signal)
      return { authority: owned, signal: new AbortController().signal, close: async () => {
        counters.closed++
        resolveClosing(); await options.closeBarrier
        return { scopeClosed: true, processRetired: true, descendantsRetired: true, pid: authority.child.pid, birth: authority.child.birth }
      } }
    },
    client: async (owned, context) => {
      counters.clients++
      options.startup?.()
      if (Date.now() >= context.deadline) throw new Error('deadline')
      if (owned === authority) return native
      return { ...native, authority: options.foreignClient ? structuredClone(owned) : owned }
    },
  }
  const directory = await reserveRunControlDirectory(root, binding, 'f'.repeat(64))
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  let owner: OpenCodeV2RunOwner
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: options.windowsAcquisitions ? 'win32' : 'linux' })
    owner = new OpenCodeV2RunOwner(plan, directory, ports)
  } finally { Object.defineProperty(process, 'platform', platform) }
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
function publishPending(f: Awaited<ReturnType<typeof fixture>>) {
  const sessionID = f.sessionAuthority.sessionID, inboxID = intent.identity.nativeInputID
  f.native.log = async () => ({ synced: true, watermark: 1, events: [{ id: 'enqueued',
    type: 'session.inbox.enqueued', seq: 1, aggregateID: sessionID,
    data: { sessionID, inboxID, item: { type: 'user', delivery: 'queue', payload: { text: intent.input.text } } } }] })
  f.native.messages = async () => ({ data: [], previous: null, next: null })
  f.native.inbox = async () => [{ id: inboxID, sessionID, type: 'user', delivery: 'queue',
    timeCreated: 1, payload: { text: intent.input.text } }]
}

function acquisitionGate() {
  let release: () => void = () => undefined
  let reject: (reason: Error) => void = () => undefined
  const promise = new Promise<void>((resolve, fail) => { release = resolve; reject = fail })
  return { promise, release, reject }
}
async function waitForTestAcquisitions(observe: () => boolean) {
  const deadline = Date.now() + 1000
  while (!observe() && Date.now() < deadline) await Bun.sleep(5)
  expect(observe()).toBe(true)
}

test('Windows acquires all leases before any client or controller bootstrap, with no model input', async () => {
  const gates = [acquisitionGate(), acquisitionGate()], started: string[] = []
  const f = await fixture({ windowsAcquisitions: true, twoMembers: true, acquisition: async member => {
    const index = started.length; started.push(member); await gates[index]!.promise
  } })
  try {
    await waitForTestAcquisitions(() => started.length === 1)
    expect(f.counters.acquired).toBe(1)
    gates[0]!.release()
    await waitForTestAcquisitions(() => started.length === 2)
    expect(f.counters).toMatchObject({ clients: 0, sessions: 0, prompted: 0 })
    gates[1]!.release()
    await f.owner.ready()
    expect(started).toEqual(['worker', 'worker-2'])
    expect(f.counters).toMatchObject({ acquired: 2, clients: 2, sessions: 2, prompted: 0 })
  } finally { gates.forEach(gate => gate.release()); await f.close() }
})

test('Windows stop refuses queued acquisition and joins the late original lease', async () => {
  const gate = acquisitionGate(), started: string[] = [], signals: AbortSignal[] = []
  const f = await fixture({ windowsAcquisitions: true, memberCount: 3, acquisition: async (member, signal) => {
    started.push(member)
    if (member === 'worker-2') { signals.push(signal!); await gate.promise }
  } })
  try {
    await waitForTestAcquisitions(() => started.length === 2)
    const stopping = f.owner.stop()
    await waitForTestAcquisitions(() => signals.every(signal => signal.aborted))
    gate.release()
    await expect(f.owner.ready()).rejects.toThrow('run_stopped')
    await stopping
    expect(started).toEqual(['worker', 'worker-2'])
    expect(f.counters).toMatchObject({ acquired: 2, closed: 2, clients: 0, sessions: 0, prompted: 0 })
  } finally { gate.release(); await f.close() }
})

test('Windows queued acquisition retains the original deadline and refuses expired work', async () => {
  const gate = acquisitionGate(), started: string[] = []
  const f = await fixture({ windowsAcquisitions: true, twoMembers: true, acquisition: async member => {
    started.push(member); await gate.promise
  } })
  let clock: ReturnType<typeof spyOn> | undefined
  try {
    await waitForTestAcquisitions(() => started.length === 1)
    const expired = Date.now() + 20_000
    clock = spyOn(Date, 'now').mockReturnValue(expired)
    gate.release()
    await expect(f.owner.ready()).rejects.toThrow('run_stopped')
    expect(started).toEqual(['worker'])
    expect(f.counters).toMatchObject({ acquired: 1, clients: 0, sessions: 0, prompted: 0 })
  } finally { clock?.mockRestore(); gate.release(); await f.close() }
})

test('Windows later acquisition failure closes every already acquired original lease', async () => {
  const gate = acquisitionGate(), started: string[] = []
  const f = await fixture({ windowsAcquisitions: true, memberCount: 3, acquisition: async member => {
    started.push(member)
    if (member === 'worker-2') await gate.promise
  } })
  try {
    await waitForTestAcquisitions(() => started.length === 2)
    expect(f.counters.clients).toBe(0)
    gate.reject(new Error('TEST second Windows acquisition failure'))
    await expect(f.owner.ready()).rejects.toThrow('TEST second Windows acquisition failure')
    await f.owner.stop()
    expect(started).toEqual(['worker', 'worker-2'])
    expect(f.counters).toMatchObject({ acquired: 2, closed: 1, clients: 0, sessions: 0, prompted: 0 })
  } finally { gate.release(); await f.close() }
})

test('Windows original acquisition rejection never starts queued acquisitions', async () => {
  const gate = acquisitionGate(), started: string[] = []
  const f = await fixture({ windowsAcquisitions: true, memberCount: 3, acquisition: async member => {
    started.push(member); await gate.promise
  } })
  try {
    await waitForTestAcquisitions(() => started.length === 1)
    gate.reject(new Error('TEST original Windows acquisition failure'))
    await expect(f.owner.ready()).rejects.toThrow('TEST original Windows acquisition failure')
    expect(started).toEqual(['worker'])
    expect(f.counters).toMatchObject({ acquired: 1, closed: 0, clients: 0, sessions: 0, prompted: 0 })
  } finally { gate.release(); await f.close() }
})

test('three original acquisitions overlap, the fourth stays queued, and all six become ready without model input', async () => {
  const gate = acquisitionGate(), started: string[] = []
  let active = 0, maximum = 0
  const f = await fixture({ memberCount: 6, acquisition: async memberId => {
    started.push(memberId); active++; maximum = Math.max(maximum, active)
    try { if (started.length <= 3) await gate.promise } finally { active-- }
  } })
  try {
    await waitForTestAcquisitions(() => started.length === 3)
    expect(started).toEqual(['worker', 'worker-2', 'worker-3'])
    expect(active).toBe(3)
    expect(f.counters.clients).toBe(0)
    expect(await f.owner.execute({ operation: 'status' }, Date.now() + 1000)).toMatchObject({ state: 'starting' })
    gate.release()
    await f.owner.ready()
    const status = await f.owner.execute({ operation: 'status' }, Date.now() + 1000)
    expect(status).toMatchObject({ state: 'active' })
    if (status.kind !== 'status') throw Error('TEST status missing')
    expect(status.members).toHaveLength(6)
    expect(status.members.every(member => member.state === 'accepted' && member.bootstrap?.verified)).toBe(true)
    expect(maximum).toBe(3)
    expect(f.counters).toMatchObject({ acquired: 6, clients: 6, sessions: 6, prompted: 0 })
  } finally { gate.release(); await f.close() }
}, 15_000)

test('first acquisition failure aborts peers, closes late original leases and never starts queued members or clients', async () => {
  const gates = Array.from({ length: 3 }, acquisitionGate), started: string[] = [], signals: AbortSignal[] = []
  let settled = 0
  const f = await fixture({ memberCount: 5, acquisition: async (memberId, signal) => {
    const index = started.length; started.push(memberId)
    if (!signal) throw Error('TEST acquisition signal absent')
    signals.push(signal)
    try { await gates[index]!.promise } finally { settled++ }
  } })
  try {
    await waitForTestAcquisitions(() => started.length === 3)
    gates[0]!.reject(new Error('TEST original acquisition failure'))
    await waitForTestAcquisitions(() => signals.slice(1).every(signal => signal.aborted))
    gates[1]!.release(); gates[2]!.release() // Deliberately late success must be closed before any client/session.
    await expect(f.owner.ready()).rejects.toThrow('TEST original acquisition failure')
    await f.owner.stop()
    expect(started).toEqual(['worker', 'worker-2', 'worker-3'])
    expect(settled).toBe(3)
    expect(f.counters).toMatchObject({ acquired: 3, closed: 2, clients: 0, sessions: 0, prompted: 0 })
    expect(await f.owner.execute({ operation: 'status' }, Date.now() + 1000)).toMatchObject({ state: 'cleanup_unknown' })
  } finally { for (const gate of gates) gate.release(); await f.close() }
}, 15_000)

test('stop during three held acquisitions joins late original leases and refuses both queued starts and model input', async () => {
  const gate = acquisitionGate(), started: string[] = [], signals: AbortSignal[] = []
  let settled = 0
  const f = await fixture({ memberCount: 5, acquisition: async (memberId, signal) => {
    started.push(memberId)
    if (!signal) throw Error('TEST acquisition signal absent')
    signals.push(signal)
    try { await gate.promise } finally { settled++ }
  } })
  try {
    await waitForTestAcquisitions(() => started.length === 3)
    const stopping = f.owner.stop()
    await waitForTestAcquisitions(() => signals.every(signal => signal.aborted))
    gate.release()
    await expect(f.owner.ready()).rejects.toThrow('run_stopped')
    expect(await stopping).toMatchObject({ state: 'cleanup_unknown' }) // Fake close never proves native retirement.
    expect(started).toEqual(['worker', 'worker-2', 'worker-3'])
    expect(settled).toBe(3)
    expect(f.counters).toMatchObject({ acquired: 3, closed: 3, clients: 0, sessions: 0, prompted: 0 })
  } finally { gate.release(); await f.close() }
}, 15_000)

test('reservation failure before creation stops without fencing or native session cancellation', async () => {
  const f = await fixture()
  const reserveSession = spyOn(OpenCodeV2AdmissionStore.prototype, 'reserveSession')
  const fenceStop = spyOn(OpenCodeV2AdmissionStore.prototype, 'fenceStop')
  let fenceCalls = 0
  reserveSession.mockImplementationOnce(async () => { throw new Error('TEST reserve failure') })
  fenceStop.mockImplementation(async () => { fenceCalls++; return [] })
  try {
    await expect(f.owner.ready()).rejects.toThrow('TEST reserve failure')
    const stopped = await f.owner.stop()
    expect(fenceCalls).toBe(0)
    expect(f.counters).toMatchObject({ clients: 1, sessionReads: 0, sessions: 0, interrupted: 0,
      cancelled: 0, disposed: 1, closed: 1, prompted: 0 })
    // The fake close lacks the private launch-owned receipt identity. Closing
    // the exact lease must still happen, but cannot manufacture success.
    expect(stopped.state).toBe('cleanup_unknown')
    expect(stopped.members).toEqual([{ memberId: 'worker', cleanup: null, errors: ['physical_cleanup_unknown'] }])
  } finally { await f.close(); reserveSession.mockRestore(); fenceStop.mockRestore() }
})

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
      expect(await f.owner.execute({ operation: 'send', ...f.selected, intent: successor(2) }, Date.now() + 5000))
        .toMatchObject({ kind: 'send_refused', disposition: 'not_reserved', intent: successor(2) })
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
      const admitted = results.filter(result => result.status === 'fulfilled' && result.value.kind === 'send')
      expect(admitted.length).toBeLessThanOrEqual(1)
      expect(f.counters.prompted).toBe(1 + admitted.length)
      const stored = await (await f.store()).snapshot()
      expect(stored.admissions).toHaveLength(1 + admitted.length)
      expect((stored.terminalSettlements ?? []).length).toBeLessThanOrEqual(1)
      if (admitted.length) expect(stored.slot === 'request-2' || stored.slot === 'request-3').toBe(true)
      else expect([intent.identity.requestId, null]).toContain(stored.slot)
    } finally { await f.close() }
  })

  for (const lifetimeMs of [120_000, 70_000]) test(`two member startup work retains shared initialization and original ${lifetimeMs}ms lifetime`, async () => {
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
      } else await expect(f.owner.ready()).rejects.toThrow(/deadline|run_stopped/)
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
      expect(await f.owner.execute({ operation: 'send', ...f.selected, intent }, Date.now() + 5000))
        .toMatchObject({ kind: 'send_refused', disposition: 'not_reserved' })
      expect(f.counters.prompted).toBe(0)
    } finally { await f.close() }
  })
  for (const mode of ['pending', 'projected', 'promotion-race', 'unknown-after-race', 'projected-interrupt-false'] as const) {
    test(`stop routes ${mode} original without replay or post-fence admission writes`, async () => {
      const f = await fixture()
      let cancelled = 0
      try {
        await f.owner.ready()
        await f.owner.execute({ operation: 'send', ...f.selected, intent }, Date.now() + 5000)
        if (mode === 'projected' || mode === 'projected-interrupt-false') publishTerminal(f, false); else publishPending(f)
        if (mode === 'projected-interrupt-false') f.native.interrupt = async () => {
          f.counters.interrupted++; return { interrupted: false }
        }
        f.native.cancelInbox = async (sessionID, inboxID) => {
          expect(sessionID).toBe(f.sessionAuthority.sessionID)
          expect(inboxID).toBe(intent.identity.nativeInputID)
          expect((await (await f.store()).snapshot()).tombstone).toBe(true)
          cancelled++
          if (mode === 'promotion-race') { publishTerminal(f, false); f.native.inbox = async () => [] }
          if (mode === 'unknown-after-race') f.native.log = async () => { throw new Error('TEST-unavailable') }
          if (mode !== 'pending') throw new ExecutionTransportFailure('invalid_response', 'unknown')
        }
        const before = await (await f.store()).snapshot()
        const stopped = await f.owner.stop(), after = await (await f.store()).snapshot()
        expect(cancelled).toBe(mode === 'projected' || mode === 'projected-interrupt-false' ? 0 : 1)
        expect(stopped.members[0]!.errors).toEqual(mode === 'unknown-after-race' || mode === 'projected-interrupt-false'
          ? ['cancel_or_interrupt_unknown', 'physical_cleanup_unknown'] : ['physical_cleanup_unknown'])
        expect(after.tombstone).toBe(true)
        expect(after.admissions).toEqual(before.admissions)
        expect(after.terminalSettlements).toEqual(before.terminalSettlements)
        expect(f.counters.interrupted).toBe(1)
        expect(f.counters.closed).toBe(1)
        expect(f.counters.prompted).toBe(1)
      } finally { await f.close() }
    })
  }
  test('stop proves the exact terminal original without observe, cancellation or post-fence writes', async () => {
    const f = await fixture()
    let cancelled = 0
    try {
      await f.owner.ready()
      await f.owner.execute({ operation: 'send', ...f.selected, intent }, Date.now() + 5000)
      publishTerminal(f)
      const before = await (await f.store()).snapshot()
      let resolveFirstCut: () => void = () => undefined, interrupted = false
      const firstCut = new Promise<void>(resolve => { resolveFirstCut = resolve }), readLog = f.native.log
      f.native.log = async (...args) => {
        const cut = structuredClone(await readLog(...args))
        if (interrupted) {
          cut.events.push({ id: 'stop-interrupt', type: 'session.execution.interrupted', seq: 8,
            aggregateID: f.sessionAuthority.sessionID, data: { sessionID: f.sessionAuthority.sessionID } })
          cut.watermark = 8
        }
        resolveFirstCut(); await Promise.resolve()
        return cut
      }
      f.native.interrupt = async () => { await firstCut; interrupted = true; f.counters.interrupted++; return { interrupted: true } }
      f.native.cancelInbox = async () => { cancelled++; throw new ExecutionTransportFailure('invalid_response', 'unknown') }
      const update = spyOn(OpenCodeV2AdmissionStore.prototype, 'update')
      const settle = spyOn(OpenCodeV2AdmissionStore.prototype, 'settleOriginalTerminal')
      try {
        const stopped = await f.owner.stop()
        expect(stopped.members[0]!.errors).toEqual(['physical_cleanup_unknown'])
        const after = await (await f.store()).snapshot()
        expect(after.tombstone).toBe(true)
        expect(after.admissions).toEqual(before.admissions)
        expect(after.terminalSettlements).toEqual(before.terminalSettlements)
        expect(update).not.toHaveBeenCalled()
        expect(settle).not.toHaveBeenCalled()
      } finally { update.mockRestore(); settle.mockRestore() }
      expect(cancelled).toBe(0)
      expect(f.counters.interrupted).toBe(1)
      expect(f.counters.closed).toBe(1)
      expect(f.counters.prompted).toBe(1)
    } finally { await f.close() }
  })
  for (const reason of ['unknown', 'payload', 'session', 'revision'] as const) {
    test(`stop refuses cancellation for unproved ${reason} original evidence`, async () => {
      const f = await fixture({ unknown: reason === 'unknown' })
      let cancelled = 0
      let snapshotSpy: ReturnType<typeof spyOn<OpenCodeV2AdmissionStore, 'snapshot'>> | undefined
      try {
        await f.owner.ready()
        await f.owner.execute({ operation: 'send', ...f.selected, intent }, Date.now() + 5000)
        publishTerminal(f)
        if (reason === 'payload') {
          const read = f.native.log
          f.native.log = async (...args) => {
            const cut = structuredClone(await read(...args))
            cut.events = cut.events.map(event => event.type === 'session.inbox.enqueued' ? { ...event,
              data: { ...event.data, item: { type: 'user', delivery: 'queue', payload: { text: 'foreign payload' } } } } : event)
            return cut
          }
        }
        if (reason === 'session') f.drift()
        if (reason === 'revision') {
          let sessionReads = 0
          const readSession = f.native.getSession, snapshot = OpenCodeV2AdmissionStore.prototype.snapshot
          f.native.getSession = async id => { sessionReads++; return readSession(id) }
          snapshotSpy = spyOn(OpenCodeV2AdmissionStore.prototype, 'snapshot').mockImplementation(async function (this: OpenCodeV2AdmissionStore) {
            const current = await snapshot.call(this)
            // A competing commit becomes visible after the proof's independent session read.
            return current.tombstone && sessionReads >= 2 ? { ...current,
              admissions: current.admissions.map(row => ({ ...row, revision: row.revision + 1 })) } : current
          })
        }
        f.native.cancelInbox = async (_session, nativeInputID) => {
          expect(nativeInputID).toBe(intent.identity.nativeInputID)
          expect((await (await f.store()).snapshot()).tombstone).toBe(true)
          cancelled++; throw new ExecutionTransportFailure('invalid_response', 'unknown')
        }
        const stopped = await f.owner.stop()
        expect(cancelled).toBe(0)
        expect(stopped.members[0]!.errors).toEqual(['cancel_or_interrupt_unknown', 'physical_cleanup_unknown'])
        expect(f.counters.interrupted).toBe(1)
        expect(f.counters.closed).toBe(1)
        expect(f.counters.prompted).toBe(1)
      } finally { snapshotSpy?.mockRestore(); await f.close() }
    })
  }
  test('stop never starts cancellation after terminal classification exhausts its original input budget', async () => {
    const f = await fixture()
    let cancelled = 0, clock: ReturnType<typeof spyOn<DateConstructor, 'now'>> | undefined
    try {
      await f.owner.ready()
      await f.owner.execute({ operation: 'send', ...f.selected, intent }, Date.now() + 5000)
      publishTerminal(f)
      let now = Date.now()
      clock = spyOn(Date, 'now').mockImplementation(() => now)
      const readSession = f.native.getSession
      f.native.getSession = async id => { now += 2001; return readSession(id) }
      f.native.cancelInbox = async () => { cancelled++ }
      const stopped = await f.owner.stop()
      expect(cancelled).toBe(0)
      expect(stopped.members[0]!.errors).toEqual(['cancel_or_interrupt_unknown', 'physical_cleanup_unknown'])
      expect((await (await f.store()).snapshot()).tombstone).toBe(true)
      expect(f.counters.interrupted).toBe(1)
      expect(f.counters.closed).toBe(1)
      expect(f.counters.prompted).toBe(1)
    } finally { clock?.mockRestore(); await f.close() }
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
  test('unknown creation after entry retains conservative native cancellation and cleanup', async () => {
    const f = await fixture({ createUnknown: true })
    try {
      await expect(f.owner.ready()).rejects.toThrow('run_original_session_unknown')
      const stopped = await f.owner.stop()
      expect(f.counters).toMatchObject({ clients: 2, sessionReads: 1, sessions: 1, interrupted: 1,
        cancelled: 0, disposed: 2, closed: 1, prompted: 0 })
      expect(stopped.members).toEqual([{ memberId: 'worker', cleanup: null,
        errors: ['physical_cleanup_unknown'] }])
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


describe('durable owner refusal crosses authenticated control and app journal', () => {
  // These regressions go red if pre-reservation refusal becomes UNKNOWN, if a
  // retry resends an uncertain native mutation, or if payload identity changes.
  for (const loseRefusal of [false, true]) test(`unreserved successor remains retryable across fresh bridges (lost response: ${loseRefusal})`, async () => {
    const f = await fixture()
    let control: Awaited<ReturnType<typeof serveOpenCodeV2RunControl>> | undefined
    try {
      await f.owner.ready()
      control = await serveOpenCodeV2RunControl(f.directory,
        { teamId: 'TEST-team', runId: 'TEST-run', ownerId: 'TEST-owner', controllerInstanceId: 'TEST-controller' },
        Date.now() + 10_000, 'f'.repeat(64), (request, deadline) => f.owner.execute(request, deadline))
      const record = control.record
      const base = (value: QueueIntent): SendMessageOutcomeBase => ({ requestId: value.identity.requestId,
        body: { deliveryAttemptId: value.identity.deliveryAttemptId, messageId: value.identity.localMessageId, payloadHash: 'a'.repeat(64) },
        teamId: record.binding.teamId, teamName: record.binding.teamId, runId: record.binding.runId,
        laneId: 'primary', memberName: 'worker', projectPath: '/TEST-project' })
      let lost = false
      let refusedSend: Extract<RunControlRequest, { operation: 'send' }> | undefined
      const bridge = () => new OpenCodeV2TeamBridge(f.root, record.binding, { discover: async () => record,
        launch: async () => { throw Error('TEST forbidden') }, request: async (owner, request, budget) => {
          const result = await requestOpenCodeV2Run(owner, request, budget)
          if (result.kind === 'send_refused' && request.operation === 'send' && !refusedSend) refusedSend = request
          if (loseRefusal && result.kind === 'send_refused' && !lost) { lost = true; throw Error('run_control_disconnected') }
          return result
        } })
      const send = (value: QueueIntent) => bridge().send({ operation: 'send', ...f.selected, intent: value }, base(value), 5000)
      expect((await send(intent)).accepted).toBe(true)
      publishTerminal(f, false)
      const next = successor(2)
      if (loseRefusal) {
        await expect(send(next)).rejects.toThrow('run_control_disconnected')
        expect((await bridge().queryOutcome({ requestId: next.identity.requestId })).record?.safeToRetry).toBe(false)
      }
      expect((await send(next)).accepted).toBe(false)
      expect((await bridge().queryOutcome({ requestId: next.identity.requestId })).record).toMatchObject({
        status: 'failed_before_accept', safeToRetry: true, runtimePromptMessageId: next.identity.nativeInputID })
      expect((await (await f.store()).snapshot()).admissions).toHaveLength(1)
      expect(f.counters.prompted).toBe(1)
      await expect(send({ ...next, input: { ...next.input, text: 'changed payload' } })).rejects.toThrow('delivery_identity_conflict')
      publishTerminal(f)
      expect((await send(next)).accepted).toBe(true)
      expect(f.counters.prompted).toBe(2)
      expect((await (await f.store()).snapshot()).admissions).toHaveLength(2)
      if (!refusedSend) throw Error('TEST original refused generation missing')
      // Even after a new generation was accepted, a delayed old send token is
      // still refused by the owner and cannot reach native transport.
      expect(await requestOpenCodeV2Run(record, refusedSend, 5000)).toMatchObject({ kind: 'send_refused',
        submissionOwner: refusedSend.submissionOwner, intent: next })
      expect(f.counters.prompted).toBe(2)
    } finally { await control?.close(); await f.close() }
  }, 15000)

  for (const capped of [false, true]) test(`failed complete-cut read proves no reservation; invoked transport failure stays UNKNOWN (event cap: ${capped})`, async () => {
    const f = await fixture({ unknown: true })
    try {
      await f.owner.ready()
      const log = f.native.log
      f.native.log = async () => {
        if (!capped) throw Error('TEST cut unavailable')
        return { synced: true, watermark: 2049, events: Array.from({ length: 2049 }, (_, index) => ({
          id: `TEST-${index}`, type: 'session.execution.started', seq: index + 1,
          aggregateID: f.selected.originalSessionId, data: { sessionID: f.selected.originalSessionId },
        })) }
      }
      expect(await f.owner.execute({ operation: 'send', ...f.selected, intent }, Date.now() + 5000))
        .toMatchObject({ kind: 'send_refused', disposition: 'not_reserved' })
      expect((await (await f.store()).snapshot()).admissions).toHaveLength(0)
      expect(f.counters.prompted).toBe(0)
      f.native.log = log
      expect(await f.owner.execute({ operation: 'send', ...f.selected, intent }, Date.now() + 5000))
        .toMatchObject({ kind: 'send', admission: { state: 'unknown' } })
      expect(await f.owner.execute({ operation: 'observe', ...f.selected,
        nativeInputID: intent.identity.nativeInputID, intent }, Date.now() + 5000))
        .toMatchObject({ kind: 'observe', admission: { state: 'unknown' } })
      expect(f.counters.prompted).toBe(1)
    } finally { await f.close() }
  })
})


test('lost send response after native invocation stays fenced and a fresh bridge only observes', async () => {
  const f = await fixture({ unknown: true })
  let control: Awaited<ReturnType<typeof serveOpenCodeV2RunControl>> | undefined
  try {
    await f.owner.ready()
    control = await serveOpenCodeV2RunControl(f.directory,
      { teamId: 'TEST-team', runId: 'TEST-run', ownerId: 'TEST-owner', controllerInstanceId: 'TEST-controller' },
      Date.now() + 10_000, 'f'.repeat(64), (request, deadline) => f.owner.execute(request, deadline))
    const record = control.record, operations: string[] = []
    const base: SendMessageOutcomeBase = { requestId: intent.identity.requestId,
      body: { deliveryAttemptId: intent.identity.deliveryAttemptId, messageId: intent.identity.localMessageId, payloadHash: 'a'.repeat(64) },
      teamId: record.binding.teamId, teamName: record.binding.teamId, runId: record.binding.runId,
      laneId: 'primary', memberName: 'worker', projectPath: '/TEST-project' }
    const bridge = () => new OpenCodeV2TeamBridge(f.root, record.binding, { discover: async () => record,
      launch: async () => { throw Error('TEST forbidden') }, request: async (owner, request, budget) => {
        operations.push(request.operation)
        const result = await requestOpenCodeV2Run(owner, request, budget)
        if (request.operation === 'send') throw Error('run_control_disconnected')
        return result
      } })
    const send = () => bridge().send({ operation: 'send', ...f.selected, intent }, base, 5000)
    await expect(send()).rejects.toThrow('run_control_disconnected')
    expect((await bridge().queryOutcome({ requestId: intent.identity.requestId })).record).toMatchObject({
      status: 'prompt_submitting', safeToRetry: false })
    expect((await send()).accepted).toBe(false)
    expect(operations).toEqual(['send', 'observe'])
    expect(f.counters.prompted).toBe(1)
    expect((await (await f.store()).snapshot()).admissions[0]?.state).toBe('unknown')
    expect((await bridge().queryOutcome({ requestId: intent.identity.requestId })).record?.safeToRetry).toBe(false)
  } finally { await control?.close(); await f.close() }
}, 15000)


describe('owner submission generation and prepared callback failures', () => {
  test('stop owns the prepared fence when it interrupts intent persistence', async () => {
    const f = await fixture()
    const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
    const callbackEntered = gate(), releaseCallback = gate(), stopEntered = gate(), releaseStop = gate()
    const cleanupEntered = gate(), releaseCleanup = gate()
    const originalControlWrite = runControl.writeRunControlFile, originalAtomicWrite = atomicWrite.writeJsonFileAtomic
    let controlWrite: ReturnType<typeof spyOn> | undefined, atomic: ReturnType<typeof spyOn> | undefined
    let sent: Promise<unknown> | undefined, stopped: ReturnType<typeof f.owner.stop> | undefined
    try {
      await f.owner.ready()
      const store = await f.store()
      controlWrite = spyOn(runControl, 'writeRunControlFile').mockImplementation(async (directory, name, value) => {
        if (directory === f.directory && name === 'intents.json') { callbackEntered.release(); await releaseCallback.promise }
        if (directory === f.directory && name === 'tombstone.json') { stopEntered.release(); await releaseStop.promise }
        return originalControlWrite(directory, name, value)
      })
      atomic = spyOn(atomicWrite, 'writeJsonFileAtomic').mockImplementation(async (file, value, options) => {
        const state = value as { tombstone?: boolean; admissions?: { state: string }[] }
        if (file === store.filePath && state.tombstone === false && state.admissions?.[0]?.state === 'not_submitted') {
          cleanupEntered.release(); await releaseCleanup.promise
        }
        return originalAtomicWrite(file, value, options)
      })
      sent = f.owner.execute({ operation: 'send', ...f.selected, intent }, Date.now() + 5000)
        .then(value => ({ value }), error => ({ error }))
      await callbackEntered.promise
      stopped = f.owner.stop()
      await stopEntered.promise
      releaseCallback.release()
      // Old cleanup holds the real store lock; corrected code lets send fail
      // and leaves the prepared row exclusively to the stop fence.
      await Promise.race([cleanupEntered.promise, sent])
      releaseStop.release()
      const receipt = await stopped
      expect(receipt.members[0]?.errors).not.toContain('tombstone_unknown')
      expect(await store.snapshot()).toMatchObject({ tombstone: true, slot: null,
        admissions: [{ state: 'not_submitted' }] })
      expect(f.counters.prompted).toBe(0)
    } finally {
      releaseCallback.release(); releaseStop.release(); releaseCleanup.release()
      await sent; await stopped
      controlWrite?.mockRestore(); atomic?.mockRestore()
      await f.close()
    }
  }, 15000)

  test('active-owner callback deadline still releases the never-invoked prepared slot', async () => {
    const f = await fixture()
    let clock: ReturnType<typeof spyOn> | undefined, controlWrite: ReturnType<typeof spyOn> | undefined
    const originalControlWrite = runControl.writeRunControlFile
    try {
      await f.owner.ready()
      const deadline = Date.now() + 5000
      controlWrite = spyOn(runControl, 'writeRunControlFile').mockImplementation(async (directory, name, value) => {
        await originalControlWrite(directory, name, value)
        if (directory === f.directory && name === 'intents.json') clock = spyOn(Date, 'now').mockReturnValue(deadline + 1)
      })
      expect(await f.owner.execute({ operation: 'send', ...f.selected, intent }, deadline))
        .toMatchObject({ kind: 'send', admission: { state: 'not_submitted', disposition: 'rejected' } })
      clock?.mockRestore(); controlWrite.mockRestore()
      expect((await (await f.store()).snapshot()).slot).toBeNull()
      expect(f.counters.prompted).toBe(0)
      expect(await f.owner.execute({ operation: 'send', ...f.selected, intent: successor(2) }, Date.now() + 5000))
        .toMatchObject({ kind: 'send', admission: { state: 'accepted' } })
      expect(f.counters.prompted).toBe(1)
    } finally { clock?.mockRestore(); controlWrite?.mockRestore(); await f.close() }
  })

  test('failed intent persistence releases only the never-invoked prepared slot for the next input', async () => {
    const f = await fixture()
    try {
      await f.owner.ready()
      const blocked = path.join(f.directory, 'intents.json')
      await mkdir(blocked)
      const result = await f.owner.execute({ operation: 'send', ...f.selected, intent }, Date.now() + 5000)
      expect(result).toMatchObject({ kind: 'send', admission: { state: 'not_submitted', disposition: 'rejected' } })
      const after = await (await f.store()).snapshot()
      expect(after.slot).toBeNull()
      expect(after.admissions[0]?.state).toBe('not_submitted')
      expect(f.counters.prompted).toBe(0)
      await rm(blocked, { recursive: true })
      expect(await f.owner.execute({ operation: 'send', ...f.selected, intent: successor(2) }, Date.now() + 5000))
        .toMatchObject({ kind: 'send', admission: { state: 'accepted' } })
      expect(f.counters.prompted).toBe(1)
    } finally { await f.close() }
  })

  test('observe reaching the owner before the original send cannot invent a retryable refusal', async () => {
    const f = await fixture()
    let control: Awaited<ReturnType<typeof serveOpenCodeV2RunControl>> | undefined
    let release: () => void = () => undefined
    const barrier = new Promise<void>(resolve => { release = resolve })
    let reached: () => void = () => undefined
    const firstSendReached = new Promise<void>(resolve => { reached = resolve })
    let pending: Promise<unknown> | undefined
    try {
      await f.owner.ready()
      control = await serveOpenCodeV2RunControl(f.directory,
        { teamId: 'TEST-team', runId: 'TEST-run', ownerId: 'TEST-owner', controllerInstanceId: 'TEST-controller' },
        Date.now() + 10_000, 'f'.repeat(64), (request, deadline) => f.owner.execute(request, deadline))
      const record = control.record, operations: string[] = []
      const base: SendMessageOutcomeBase = { requestId: intent.identity.requestId,
        body: { deliveryAttemptId: intent.identity.deliveryAttemptId, messageId: intent.identity.localMessageId, payloadHash: 'a'.repeat(64) },
        teamId: record.binding.teamId, teamName: record.binding.teamId, runId: record.binding.runId,
        laneId: 'primary', memberName: 'worker', projectPath: '/TEST-project' }
      const bridge = () => new OpenCodeV2TeamBridge(f.root, record.binding, { discover: async () => record,
        launch: async () => { throw Error('TEST forbidden') }, request: async (owner, request, budget) => {
          operations.push(request.operation)
          if (request.operation === 'send') { reached(); await barrier }
          return requestOpenCodeV2Run(owner, request, budget)
        } })
      const send = () => bridge().send({ operation: 'send', ...f.selected, intent }, base, 5000)
      pending = send().then(value => ({ value }), error => ({ error }))
      await firstSendReached
      await expect(send()).rejects.toThrow('run_operation_unknown')
      expect((await bridge().queryOutcome({ requestId: intent.identity.requestId })).record).toMatchObject({
        status: 'prompt_submitting', safeToRetry: false })
      expect(f.counters.prompted).toBe(0)
      release()
      expect(await pending).toMatchObject({ value: { accepted: true } })
      expect(operations).toEqual(['send', 'observe'])
      expect(f.counters.prompted).toBe(1)
      expect((await bridge().queryOutcome({ requestId: intent.identity.requestId })).record).toMatchObject({
        status: 'prompt_accepted', safeToRetry: false })
    } finally { release(); await pending; await control?.close(); await f.close() }
  }, 15000)
})


test('probe readiness retains one original across a mutable cut and rejects unbranded faults', async () => {
  if (process.env.TEST_MUTABLE_READBACK_CHILD !== '1') {
    const root = await mkdtemp(path.join(os.tmpdir(), 'TEST-probe-cut-preload-'))
    try {
      const preload = path.join(root, 'endpoint.ts')
      const endpoint = await realpath(fileURLToPath(import.meta.resolve('../host/OpenCodeV2ExecutionHost.ts')))
      await writeFile(preload, `import { mock } from 'bun:test'
import * as endpoints from ${JSON.stringify(endpoint)}
mock.module(${JSON.stringify(endpoint)}, () => ({ ...endpoints,
requireExecutionEndpoint: authority => {
 if (authority.hostInstanceId !== 'TEST-host' || !authority.profileRoot.includes('/TEST-r249-owner-')) throw Error('TEST foreign endpoint')
 return { baseUrl: 'http://127.0.0.1:1', nativePID: 42 }
} }))`)
      const child = Bun.spawn([process.execPath, 'test', '--preload', preload, import.meta.path, '-t', 'probe readiness retains one original'], {
        cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', TEST_MUTABLE_READBACK_CHILD: '1' } })
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect({ exit, stderr: exit === 0 ? '' : stderr }).toEqual({ exit: 0, stderr: '' })
      expect(stdout).not.toContain('TEST_RAW_')
    } finally { await rm(root, { recursive: true, force: true }) }
    return
  }
  const f = await fixture({ probe: true })
  try {
    await f.owner.ready()
    await f.owner.execute({ operation: 'send', ...f.selected, intent }, Date.now() + 2000)
    publishTerminal(f)
    const stable = f.native.log
    let reads = 0
    f.native.log = async id => {
      const cut = structuredClone(await stable(id))
      // First reconciliation is stable and may update the same original record.
      // The next terminal read advances while its transcript is being collected.
      if (++reads === 4) cut.events = cut.events.map((event, index) => index === cut.events.length - 1
        ? { ...event, data: { ...event.data, TEST_streaming: true } } : event)
      return cut
    }
    const before = await (await f.store()).snapshot()
    const pending = await f.owner.execute({ operation: 'probeEvidence', ...f.selected }, Date.now() + 2000)
    expect(pending).toEqual({ kind: 'probeEvidence', proof: null, failure: null })
    const retained = await (await f.store()).snapshot()
    expect(retained.slot).toBe(intent.identity.requestId)
    expect(retained.admissions).toHaveLength(1)
    expect(retained.admissions[0]!.identity).toEqual(before.admissions[0]!.identity)
    expect(retained.admissions[0]!.authority).toEqual(before.admissions[0]!.authority)
    expect(f.counters).toMatchObject({ prompted: 1, acquired: 1, sessions: 1 })
    f.native.log = stable
    const settled = await f.owner.execute({ operation: 'probeEvidence', ...f.selected }, Date.now() + 2000)
    expect(settled.kind).toBe('probeEvidence')
    if (settled.kind !== 'probeEvidence') throw Error('TEST probe missing')
    expect(settled.failure).toBeNull()
    expect(settled.proof).toMatchObject({ modelId: 'TEST-provider/TEST-model', opencodeVersion: '2.0.21', capabilitySnapshotId: 'TEST-capability' })
    expect((await (await f.store()).snapshot()).slot).toBeNull()
    expect(f.counters).toMatchObject({ prompted: 1, acquired: 1, sessions: 1 })
    for (const fault of [new Error('mutable_readback'), new ExecutionTransportFailure('invalid_response', 'not_submitted')]) {
      f.native.log = async () => { throw fault }
      await expect(f.owner.execute({ operation: 'probeEvidence', ...f.selected }, Date.now() + 2000)).rejects.toBe(fault)
    }
    f.native.log = async id => {
      const cut = structuredClone(await stable(id)); cut.events.at(-1)!.aggregateID = 'ses_TESTforeign'; return cut
    }
    await expect(f.owner.execute({ operation: 'probeEvidence', ...f.selected }, Date.now() + 2000)).rejects.toThrow('incomplete_log')
    expect(f.counters.prompted).toBe(1)
  } finally { f.native.log = async () => ({ events: [], synced: true, watermark: null }); await f.close() }
}, 15_000)


test('owner entry diagnostics preserve exit without changing ignored stderr ownership', () => {
  expect(JSON.parse(projectRunOwnerEntryFailure(123, 17))).toEqual({
    event: 'opencode-v2-startup', reason: 'failed', stage: 'run-owner-entry', elapsedMs: 123,
    nativeStderrKind: 'unavailable', nativeExitCode: 17,
  })
  expect(JSON.parse(projectRunOwnerEntryFailure(5, null))).not.toHaveProperty('nativeExitCode')
  expect(JSON.parse(projectRunOwnerEntryFailure(5, -1))).not.toHaveProperty('nativeExitCode')
  expect(JSON.parse(projectRunOwnerEntryFailure(5, 0)).nativeExitCode).toBe(0)
})
