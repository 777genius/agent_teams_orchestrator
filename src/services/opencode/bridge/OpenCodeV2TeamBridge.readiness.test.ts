import { expect, spyOn, test } from 'bun:test'
import { OpenCodeV2TeamBridge, type OpenCodeV2RunControlPorts } from './OpenCodeV2TeamBridge.js'
import type { RunControlRecord, RunControlResult, RunLaunchPlan, RunMemberStatus } from './OpenCodeV2RunTypes.js'

type Status = Extract<RunControlResult, { kind: 'status' }>
function fixture(now = Date.now()) {
  const binding = { teamId: 'TEST-team', runId: 'TEST-run', controllerInstanceId: 'TEST-controller', ownerId: 'TEST-owner' }
  const plan: RunLaunchPlan = {
    dataRoot: '/TEST-data', binding, deadline: now + 120_000,
    qualification: { capabilitySnapshotId: 'TEST-capability', expectedBehaviorFingerprint: 'a'.repeat(64),
      binaryPath: '/TEST-opencode', binaryFingerprint: 'b'.repeat(64), version: '2.0.21' },
    source: { entryPath: '/TEST-entry', entrySha256: 'c'.repeat(64), bunPath: '/TEST-bun',
      bunSha256: 'd'.repeat(64), files: [], env: {} },
    members: ['alice', 'bob'].map(memberId => ({
      memberId, laneId: 'primary', originalSessionId: `ses_TEST${memberId}`,
      native: { generation: 'v2', version: '2.0.21', dialect: 'v2-2.0.21', executablePath: '/TEST-opencode',
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
    selectedModel: 'TEST-provider/TEST-model', selectedVariant: 'default', pin: '2.0.21',
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
