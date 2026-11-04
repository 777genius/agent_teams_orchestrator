import { expect, spyOn, test } from 'bun:test'
import { launchExplicitOpenCodeV2Run } from './OpenCodeV2RunOwner.js'
import { OpenCodeV2TeamBridge, type OpenCodeV2RunControlPorts } from './OpenCodeV2TeamBridge.js'
import type { RunControlRecord, RunControlResult, RunLaunchPlan, RunMemberStatus } from './OpenCodeV2RunTypes.js'

type Status = Extract<RunControlResult, { kind: 'status' }>
function fixture(now = Date.now()) {
  const binding = { teamId: 'TEST-team', runId: 'TEST-run', controllerInstanceId: 'TEST-controller', ownerId: 'TEST-owner' }
  const plan: RunLaunchPlan = {
    dataRoot: '/TEST-data', binding, deadline: now + 120_000,
    qualification: { capabilitySnapshotId: 'TEST-capability', expectedBehaviorFingerprint: 'a'.repeat(64),
      binaryPath: '/TEST-opencode', binaryFingerprint: 'b'.repeat(64), version: '2.0.32' },
    source: { entryPath: '/TEST-entry', entrySha256: 'c'.repeat(64), bunPath: '/TEST-bun',
      bunSha256: 'd'.repeat(64), files: [], env: {} },
    members: ['alice', 'bob'].map(memberId => ({
      memberId, laneId: 'primary', originalSessionId: `ses_TEST${memberId}`,
      native: { generation: 'v2', version: '2.0.32', dialect: 'v2-2.0.32', executablePath: '/TEST-opencode',
        executableSha256: 'b'.repeat(64), packageName: '@opencode/cli-darwin-arm64', runtimeMode: 'source',
        entrySha256: 'c'.repeat(64), bun: { path: '/TEST-bun', sha256: 'd'.repeat(64) }, graph: { files: [], sha256: 'e'.repeat(64) } },
      profile: { root: `/TEST-${memberId}`, epoch: `TEST-${memberId}`, directory: '/TEST-project',
        databasePath: `/TEST-${memberId}/data/opencode.db`, env: {}, envSha256: 'f'.repeat(64),
        config: { directory: `/TEST-${memberId}/config`, content: '{}', sha256: 'f'.repeat(64) },
        selection: { agent: 'build', model: { providerID: 'TEST-provider', id: 'TEST-model', variant: 'default' }, permissions: [] } },
      bootstrap: { key: 'TEST-context', value: 'TEST briefing', contextHash: 'a'.repeat(64), briefingHash: 'b'.repeat(64) },
      controllerMcpName: 'agent-teams', advertisedTools: ['message_send'],
    })),
  }
  const record: RunControlRecord = { schema: 1, protocol: 1, binding, deadline: plan.deadline,
    process: { pid: 100, startTicks: '100', bootId: 'TEST-boot', executablePath: '/TEST-bun', executableSha256: 'd'.repeat(64) },
    directory: '/TEST-control', socketPath: '/TEST-control/control.sock', socketDevice: 1, socketInode: 2,
    uid: 1000, sourceSha256: 'e'.repeat(64) }
  const members: RunMemberStatus[] = plan.members.map((member, index) => ({
    memberId: member.memberId, laneId: 'primary', originalSessionId: member.originalSessionId,
    opencodeSessionId: member.originalSessionId, runtimeSessionId: member.originalSessionId,
    selectedModel: 'TEST-provider/TEST-model', selectedVariant: 'default', pin: '2.0.32',
    profileRoot: member.profile.root, profileEpoch: member.profile.epoch, runtimePid: 101 + index, state: 'accepted',
    bootstrap: { strategy: 'instruction-entry', verified: true, missingNativeMessageID: true, key: 'TEST-context',
      contextHash: 'a'.repeat(64), briefingHash: 'b'.repeat(64) },
    controllerTools: { server: 'agent-teams', nativeNames: ['message_send'], configHash: 'd'.repeat(64),
      schemasHash: 'c'.repeat(64), tools: [{ name: 'message_send', inputSchema: { type: 'object' } }] },
  }))
  const active: Status = { kind: 'status', state: 'active', deadline: plan.deadline, qualification: plan.qualification, members }
  const starting: Status = { ...active, state: 'starting', members: members.map(member =>
    ({ ...member, state: 'unknown', runtimePid: undefined, bootstrap: null, controllerTools: undefined })) }
  const counts = { launched: 0, discovered: 0, reads: 0, sends: 0 }
  const budgets: number[] = []
  let owned: RunControlRecord | null = null
  let read: () => Promise<RunControlResult> = async () => active
  const ports: OpenCodeV2RunControlPorts = {
    discover: async () => { counts.discovered++; return owned },
    launch: async received => { expect(received).toBe(plan); counts.launched++; owned = record; return record },
    request: async (received, request, budget) => {
      expect(received).toBe(record)
      if (request.operation !== 'status') { counts.sends++; throw new Error('TEST effect forbidden') }
      counts.reads++; budgets.push(budget!); return read()
    },
  }
  return { plan, record, active, starting, counts, budgets,
    bridge: new OpenCodeV2TeamBridge(plan.dataRoot, binding, ports),
    read: (value: () => Promise<RunControlResult>) => { read = value },
  }
}

test('launch remains unresolved while starting, then returns both original ready members without another launch or input', async () => {
  const f = fixture()
  let release: (value: RunControlResult) => void = () => undefined
  const gate = new Promise<RunControlResult>(resolve => { release = resolve })
  f.read(async () => f.counts.reads === 1 ? f.starting : gate)
  const record = await f.bridge.launchExplicit(f.plan)
  let settled = false
  const waiting = f.bridge.awaitLaunchReady(record, f.plan, Date.now() + 5000).then(result => { settled = true; return result })
  await Bun.sleep(150)
  expect(settled).toBe(false)
  expect(f.counts).toEqual({ launched: 1, discovered: 1, reads: 2, sends: 0 })
  release(f.active)
  expect(await waiting).toBe(f.active)
  expect(f.counts).toEqual({ launched: 1, discovered: 1, reads: 2, sends: 0 })
})

for (const state of ['stopping', 'stopped', 'cleanup_unknown'] as const) {
  test(`original owner ${state} cannot produce a ready launch response`, async () => {
    const f = fixture()
    f.read(async () => f.counts.reads === 1 ? f.starting : ({ ...f.active, state }))
    await expect(f.bridge.awaitLaunchReady(f.record, f.plan, Date.now() + 1000)).rejects.toThrow('run_readiness_unknown')
    expect(f.counts).toEqual({ launched: 0, discovered: 0, reads: 2, sends: 0 })
  })
}

for (const state of ['starting', 'active'] as const) {
  test(`${state} rejects changed original member/session/model/version/lane and qualification identities`, async () => {
    const mutations: Partial<RunMemberStatus>[] = [
      { memberId: 'other' }, { laneId: 'other' }, { originalSessionId: 'ses_other' },
      { opencodeSessionId: 'ses_other' }, { runtimeSessionId: 'ses_other' },
      { selectedModel: 'TEST-provider/other' }, { selectedVariant: 'other' }, { pin: '2.0.0' },
    ]
    for (const mutation of mutations) {
      const f = fixture(), base = state === 'active' ? f.active : f.starting
      f.read(async () => ({ ...base, members: [{ ...base.members[0]!, ...mutation }, base.members[1]!] }))
      await expect(f.bridge.awaitLaunchReady(f.record, f.plan, Date.now() + 1000)).rejects.toThrow('run_readiness_changed')
      expect(f.counts.sends + f.counts.launched).toBe(0)
    }
    for (const changed of ['qualification', 'members', 'deadline'] as const) {
      const f = fixture(), base = state === 'active' ? f.active : f.starting
      const result: Status = changed === 'qualification' ? { ...base, qualification: undefined }
        : changed === 'members' ? { ...base, members: [base.members[0]!] } : { ...base, deadline: base.deadline + 1 }
      f.read(async () => result)
      await expect(f.bridge.awaitLaunchReady(f.record, f.plan, Date.now() + 1000)).rejects.toThrow('run_readiness_changed')
      expect(f.counts.sends + f.counts.launched).toBe(0)
    }
  })
}

test('active without bootstrap, controller proof, valid PID or qualification cannot confirm a member', async () => {
  for (const mutation of [
    { bootstrap: null }, { controllerTools: undefined }, { runtimePid: undefined }, { runtimePid: 0 }, { runtimePid: 1.5 },
  ] satisfies Partial<RunMemberStatus>[]) {
    const f = fixture()
    f.read(async () => ({ ...f.active, members: [{ ...f.active.members[0]!, ...mutation }, f.active.members[1]!] }))
    await expect(f.bridge.awaitLaunchReady(f.record, f.plan, Date.now() + 1000)).rejects.toThrow('run_readiness_unknown')
    expect(f.counts.sends + f.counts.launched).toBe(0)
  }
})

test('one absolute deadline shrinks across repeated starting reads rather than resetting per member or poll', async () => {
  let clock = 1000
  const now = spyOn(Date, 'now').mockImplementation(() => clock)
  try {
    const f = fixture(clock)
    f.read(async () => { clock += 100; return f.starting })
    await expect(f.bridge.awaitLaunchReady(f.record, f.plan, 1250)).rejects.toThrow('run_readiness_unknown')
    expect(f.budgets).toEqual([250, 150, 50])
    expect(f.counts).toEqual({ launched: 0, discovered: 0, reads: 3, sends: 0 })
  } finally { now.mockRestore() }
})

test('transient read uncertainty consumes the same budget and late active status cannot qualify', async () => {
  let clock = 1000
  const now = spyOn(Date, 'now').mockImplementation(() => clock)
  try {
    const f = fixture(clock)
    f.read(async () => {
      if (f.counts.reads === 1) { clock += 80; throw new Error('run_control_disconnected') }
      clock = 1250; return f.active
    })
    await expect(f.bridge.awaitLaunchReady(f.record, f.plan, 1250)).rejects.toThrow('run_readiness_unknown')
    expect(f.budgets).toEqual([250, 170])
    expect(f.counts.sends + f.counts.launched).toBe(0)
  } finally { now.mockRestore() }
})

test('foreign binding, excessive deadline and expired budget refuse before any status or effect', async () => {
  const f = fixture(), now = Date.now()
  await expect(f.bridge.awaitLaunchReady({ ...f.record, binding: { ...f.record.binding, ownerId: 'other' } }, f.plan, now + 1000))
    .rejects.toThrow('run_readiness_changed')
  await expect(f.bridge.awaitLaunchReady(f.record, f.plan, now + 130_000)).rejects.toThrow('run_readiness_changed')
  await expect(f.bridge.awaitLaunchReady(f.record, f.plan, now - 1)).rejects.toThrow('run_readiness_unknown')
  expect(f.counts).toEqual({ launched: 0, discovered: 0, reads: 0, sends: 0 })
})

// Serialize the typed fixture after Bun transpilation so its module mocks stay
// isolated from other readiness tests in this process.
async function missingReadinessFixture(urls: { target: string; factory: string; planner: string; probe: string }) {
  const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default
  const { mock } = await import('bun:test')
  const factory: typeof import('./OpenCodeRuntimeAdapterFactory.js') = await import(urls.factory)
  mock.module(urls.factory, () => ({ ...factory,
    inspectOpenCodeRuntimeAdapterSelection: async () => ({ policy: { generation: 'v2', version: '2.0.32' } }),
  }))
  let stage: 'source_availability' | 'execution_probe' = 'source_availability'
  let code = 'ENOENT', probes = 0
  const failure = () => Object.assign(new Error('TEST-private-path must never appear'), { code, path: 'C:/TEST-private-path' })
  const planner: typeof import('./OpenCodeV2LaunchPlan.js') = await import(urls.planner)
  mock.module(urls.planner, () => ({ ...planner, inspectOpenCodeV2SourceAvailability: async () => {
    if (stage === 'source_availability') throw failure()
    return { project: '/TEST-project', model: { providerID: 'openrouter', id: 'TEST-model' } }
  } }))
  const probeModule = await import(urls.probe)
  mock.module(urls.probe, () => ({ ...probeModule, resolveOpenCodeV2ExecutionProbe: async (_envelope: unknown, _selection: unknown, run: boolean) => {
    assert.equal(run, false); probes++; throw failure()
  } }))
  const { executeSelectedOpenCodeBridgeCommandEnvelope: execute, OpenCodeV2TeamBridge }:
    typeof import('./OpenCodeV2TeamBridge.js') = await import(urls.target)
  const envelope = { schemaVersion: 1, requestId: 'TEST-ready', command: 'opencode.readiness', cwd: '/TEST-project',
    startedAt: new Date().toISOString(), timeoutMs: 120000,
    body: { selectedModel: 'openrouter/TEST-model', requireExecutionProbe: false } }
  type Refusal = { ok: boolean; error: { kind: string; message: string } }
  const noV1 = async () => { throw Error('V1 forbidden') }
  for (const phase of ['source_availability', 'execution_probe'] as const) {
    stage = phase
    const response = await execute(envelope, noV1) as Refusal
    assert.equal(response.ok, false); assert.equal(response.error.kind, 'runtime_not_ready')
    assert.equal(response.error.message, 'readiness_file_missing:' + stage)
    assert.equal(JSON.stringify(response).includes('TEST-private-path'), false)
  }
  assert.equal(probes, 1)
  OpenCodeV2TeamBridge.prototype.discover = async () => { throw failure() }
  const bound = await execute({ ...envelope, body: { ...envelope.body, teamId: 'TEST-team', runId: 'TEST-run' } }, noV1) as Refusal
  assert.equal(bound.error.message, 'readiness_file_missing:owner_discovery')
  assert.equal(JSON.stringify(bound).includes('TEST-private-path'), false)
  code = 'EACCES'; stage = 'source_availability'
  const denied = await execute(envelope, noV1) as Refusal
  assert.equal(denied.error.message, 'TEST-private-path must never appear')
}

test('model-free public readiness refuses missing inputs with closed preparation phases and no path', async () => {
  const urls = { target: import.meta.resolve('./OpenCodeV2TeamBridge.ts'), factory: import.meta.resolve('./OpenCodeRuntimeAdapterFactory.ts'),
    planner: import.meta.resolve('./OpenCodeV2LaunchPlan.ts'), probe: import.meta.resolve('./OpenCodeV2ExecutionProbe.ts') }
  const child = Bun.spawn([process.execPath, '-e', `(${missingReadinessFixture.toString()})(${JSON.stringify(urls)})`],
    { cwd: import.meta.dir, stdout: 'ignore', stderr: 'pipe' })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
}, 15_000)


async function totalReadinessFixture(urls: { target: string; factory: string; planner: string; probe: string }) {
  const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default
  const { mock } = await import('bun:test')
  let clock = 1000, scenario = 'success', selections = 0, plans = 0, probes = 0, cleaned = false
  Date.now = () => clock
  const deadline = 6000
  const factory = await import(urls.factory)
  mock.module(urls.factory, () => ({ ...factory, inspectOpenCodeRuntimeAdapterSelection: async (signal?: AbortSignal, _started?: unknown, at?: number) => {
    selections++
    if (scenario === 'v1') {
      assert.equal(signal, undefined); assert.equal(at, undefined)
      return { policy: { generation: 'v1', version: '1.19.4' } }
    }
    assert.ok(signal instanceof AbortSignal); assert.equal(at, deadline)
    clock += 2000
    if (scenario === 'selection-timeout' || scenario === 'selection-cleanup') {
      clock = deadline + 1
      // Selection retains responsibility for cleanup; public routing awaits it.
      await Bun.sleep(5); cleaned = true
      throw Error(scenario === 'selection-cleanup' ? 'opencode_version_probe_cleanup_unknown' : 'selection_unavailable')
    }
    return { policy: { generation: 'v2', version: '2.0.32' } }
  } }))
  const planner = await import(urls.planner)
  mock.module(urls.planner, () => ({ ...planner, inspectOpenCodeV2SourceAvailability: async (_envelope: unknown, budget: { signal: AbortSignal; deadlineMs: number }) => {
    plans++; assert.equal(budget.deadlineMs, deadline); assert.ok(budget.signal instanceof AbortSignal)
    if (scenario === 'source-timeout') { clock = deadline + 1; throw Error('execution_timeout') }
    clock += 1000
    return { model: { providerID: 'TEST', id: 'TEST' }, native: { version: '2.0.32', executablePath: '/TEST' } }
  } }))
  const probeModule = await import(urls.probe)
  mock.module(urls.probe, () => ({ ...probeModule, resolveOpenCodeV2ExecutionProbe: async (_envelope: unknown, _selection: unknown, run: boolean,
    options: { deadline: number; signal: AbortSignal; onPhase: (phase: string) => void }) => {
    probes++; assert.equal(run, true); assert.equal(options.deadline, deadline)
    assert.ok(options.signal instanceof AbortSignal); assert.equal(clock, 4000)
    options.onPhase('model_observe'); clock = deadline + 1
    if (scenario === 'probe-cleanup') throw Error('probe_physical_cleanup_unknown')
    throw Error('execution_timeout')
  } }))
  const { OpenCodeV2TeamBridge, executeSelectedOpenCodeBridgeCommandEnvelope: execute } = await import(urls.target)
  OpenCodeV2TeamBridge.prototype.discover = async () => { if (scenario === 'discovery-timeout') clock = deadline + 1; return null }
  const input = { schemaVersion: 1, requestId: 'TEST-total', command: 'opencode.readiness', cwd: '/TEST',
    startedAt: new Date().toISOString(), timeoutMs: 30000, body: { selectedModel: 'TEST/TEST', requireExecutionProbe: true } }
  const noV1 = async () => { throw Error('TEST V1 forbidden') }
  for (const [name, expected] of [
    ['discovery-timeout', 'execution_timeout:owner_discovery'], ['selection-timeout', 'execution_timeout:runtime_selection'],
    ['selection-cleanup', 'opencode_version_probe_cleanup_unknown'], ['source-timeout', 'execution_timeout:source_availability'],
    ['probe-timeout', 'execution_timeout:model_observe'], ['probe-cleanup', 'probe_physical_cleanup_unknown'],
  ]) {
    scenario = name!; clock = 1000; selections = plans = probes = 0; cleaned = false
    const result = await execute({ ...input, body: { ...input.body, ...(name === 'discovery-timeout' ? { teamId: 'TEST', runId: 'TEST' } : {}) } }, noV1)
    assert.equal(result.ok, false); assert.equal(result.error.message, expected)
    if (name === 'discovery-timeout') assert.equal(selections + plans + probes, 0)
    if (name.startsWith('selection-')) { assert.equal(cleaned, true); assert.equal(plans + probes, 0) }
    if (name === 'source-timeout') assert.equal(probes, 0)
  }
  scenario = 'v1'; clock = 1000
  const original = { ...input, command: 'opencode.reconcileTeam' }
  const marker = { TEST: 'legacy-response' }
  assert.equal(await execute(original, async (received: unknown) => { assert.equal(received, original); return marker }), marker)
}
test('public readiness shares one deadline across discovery, selection, preparation and probe while preserving cleanup refusals', async () => {
  const urls = { target: import.meta.resolve('./OpenCodeV2TeamBridge.ts'), factory: import.meta.resolve('./OpenCodeRuntimeAdapterFactory.ts'),
    planner: import.meta.resolve('./OpenCodeV2LaunchPlan.ts'), probe: import.meta.resolve('./OpenCodeV2ExecutionProbe.ts') }
  const child = Bun.spawn([process.execPath, '-e', `(${totalReadinessFixture.toString()})(${JSON.stringify(urls)})`],
    { cwd: import.meta.dir, stdout: 'ignore', stderr: 'pipe' })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
}, 15000)


test('team launch invokes producer cleanup only before handoff or with a matching no-spawn receipt', async () => {
  const f = fixture()
  let cleanups = 0
  const cleanup = async () => { cleanups++ }
  await f.bridge.launchExplicit(f.plan, cleanup)
  expect(cleanups).toBe(0) // A successful launch hands ownership to its original owner.
  const unusedPlan = { ...f.plan, members: f.plan.members.map(member => ({ ...member,
    profile: { ...member.profile, root: member.profile.root + '-unused' } })) }
  await expect(f.bridge.launchExplicit(unusedPlan, cleanup)).rejects.toThrow('run_already_owned')
  expect(cleanups).toBe(1)
  const cleanupFailure = Error('TEST-profile-cleanup-failed')
  await expect(f.bridge.launchExplicit(unusedPlan, async () => { throw cleanupFailure })).rejects.toMatchObject({
    message: 'run_profile_cleanup_unknown',
    errors: [expect.objectContaining({ message: 'run_already_owned' }), cleanupFailure],
  })
  for (const branded of [false, true]) {
    cleanups = 0
    const bridge = new OpenCodeV2TeamBridge(f.plan.dataRoot, f.plan.binding, {
      discover: async () => null, request: async () => f.active,
      launch: async plan => {
        if (branded) return launchExplicitOpenCodeV2Run({ ...plan, deadline: Date.now() - 1 })
        throw Error('execution_timeout:owner_start')
      },
    })
    await expect(bridge.launchExplicit(f.plan, cleanup)).rejects.toThrow('execution_timeout:owner_start')
    expect(cleanups).toBe(branded ? 1 : 0)
  }
})
