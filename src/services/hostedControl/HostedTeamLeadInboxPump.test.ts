import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { OpenCodeSessionRecord } from '../opencode/types.js'
import type { TeamLifecycleLaunchPlan } from '../teamLifecycleOwner/TeamLifecycleLaunchPlan.js'
import { HostedTeamLeadMessageDelivery } from './HostedTeamLeadMessageDelivery.js'
import {
  HostedTeamLeadInboxPump,
  type HostedTeamLeadInboxPumpOptions,
} from './HostedTeamLeadInboxPump.js'
import { HostedTeamRecipientRoster } from './HostedTeamRecipientRoster.js'
import type { HostedControlAuthority } from './protocol.js'

const roots: string[] = []
const teamId = `team_${'a'.repeat(32)}`
const authority: HostedControlAuthority = {
  actorId: 'actor-a', deploymentId: 'deployment-a', bootId: 'boot-a',
  restoreGeneration: 1, workspaceId: 'workspace-a',
  mountBinding: { mountGeneration: 1, declaredRootHash: 'b'.repeat(64) }, teamId,
}
const message = {
  teamId, messageId: `message_${'c'.repeat(32)}`,
  clientMessageId: 'client_message_inbox-pump', text: 'Message the lead.',
  createdAt: '2026-09-24T10:00:00.000Z',
}
const sessionId = 'session-lead'
const runId = `run_${'d'.repeat(32)}`
const capabilitySnapshotId = `opencode:${'e'.repeat(32)}`
const verifiedObservation = {
  state: 'responded_plain_text', deliveredUserMessageId: 'prompt-1', assistantMessageId: 'assistant-1',
}
type TestBridge = (input: { command: string; memberName?: string; text?: string; requestId?: string }, guard: () => Promise<boolean>, signal: AbortSignal) =>
  Promise<{ ok: boolean; data?: Record<string, unknown> }>

async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'hosted-inbox-pump-')))
  roots.push(parent)
  const root = join(parent, 'legacy')
  const workspace = join(parent, 'workspace')
  await mkdir(root, { mode: 0o700 })
  await mkdir(workspace, { mode: 0o700 })
  const delivery = new HostedTeamLeadMessageDelivery({
    canonicalTeamRoot: root, legacyKey: 'legacy', authority,
    guard: { isCurrent: async () => true },
  })
  expect(await delivery.deliver(message, authority)).toEqual({ kind: 'delivered' })
  let plan: TeamLifecycleLaunchPlan = {
    schemaVersion: 2, workspaceId: authority.workspaceId, teamId,
    workspaceRoot: workspace, toolApprovalMode: 'manual', lanes: [{
      laneId: 'lead-lane', kind: 'opencode', provider: 'opencode',
      selectedModel: 'openai/gpt-6-sol', members: [
        { name: 'team-lead', prompt: 'Lead the team.' }, { name: 'alice', prompt: 'Build it.' },
      ],
    }],
  }
  let active = true
  let current = true
  let selectedSession = sessionId
  let planGeneration = 'plan-generation_first'
  let sessionReadHook = async () => {}
  let capabilityReadHook = async () => {}
  const calls: string[] = []
  let bridge: TestBridge = async input => {
    calls.push(input.command)
    if (input.command === 'send') return { ok: true, data: { accepted: true, sessionId, runtimePromptMessageId: 'prompt-1' } }
    if (input.command === 'status') return { ok: true, data: { status: 'prompt_accepted', accepted: true,
      sessionId, runtimePromptMessageId: 'prompt-1' } }
    return { ok: true, data: { observed: true, sessionId, responseObservation: verifiedObservation } }
  }
  const build = (overrides: Partial<HostedTeamLeadInboxPumpOptions> = {}) => new HostedTeamLeadInboxPump({
    canonicalTeamRoot: root, legacyKey: 'legacy', authority,
    guard: { isCurrent: async () => current },
    planStore: { load: async () => {
      const admittedGeneration = planGeneration
      return { plan, planGeneration: admittedGeneration,
        isCurrent: async () => planGeneration === admittedGeneration }
    } },
    execution: { inspect: async () => ({ providerId: 'team-lifecycle-owner', providerGeneration: 'generation-a',
      phase: active ? 'running' : 'stopping', runId, recoverable: false }) },
    readActiveRun: async () => ({ phase: active ? 'running' : 'stopping', runId }),
    getSession: async (_teamId, _laneId, memberName) => { await sessionReadHook(); return ({
      teamId: 'legacy', laneId: 'lead-lane', memberName, runId,
      opencodeSessionId: selectedSession, projectPath: workspace,
      selectedModel: 'openai/gpt-6-sol', staleReason: null,
      profileScope: { purpose: 'launch_runtime' },
    }) as OpenCodeSessionRecord },
    getCapability: async () => { await capabilityReadHook(); return capabilitySnapshotId },
    executeBridge: (input, guard, signal) => bridge(input, guard, signal),
    ...overrides,
  })
  return { root, build, calls, setBridge: (next: typeof bridge) => { bridge = next },
    stop: () => { active = false }, resume: () => { active = true },
    revoke: () => { current = false },
    replaceSession: () => { selectedSession = 'replacement' },
    replacePlan: () => { planGeneration = 'plan-generation_second' },
    onSessionRead: (hook: typeof sessionReadHook) => { sessionReadHook = hook },
    onCapabilityRead: (hook: typeof capabilityReadHook) => { capabilityReadHook = hook },
    useNativeLane: () => { plan = { ...plan, lanes: [{ laneId: 'native-lane', kind: 'native',
      provider: 'anthropic', members: [{ name: 'team-lead', prompt: 'Lead.' }, { name: 'alice', prompt: 'Build.' }] }] } },
    removeLead: () => { plan = { ...plan, lanes: [{ ...plan.lanes[0]!,
      members: [{ name: 'worker', prompt: 'Work.' }] }] } }
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('HostedTeamLeadInboxPump', () => {
  test('addresses the host-local runtime by the legacy key under the canonical teams directory only', async () => {
    const f = await fixture()
    const parent = join(f.root, '..')
    const manifest = (teamName: string) => JSON.stringify({ schemaVersion: 1, teamName,
      activeRunId: runId, activeCapabilitySnapshotId: capabilitySnapshotId })
    await mkdir(join(f.root, '.opencode-runtime', 'lanes', 'lead-lane'), { recursive: true })
    await writeFile(join(f.root, '.opencode-runtime', 'lanes', 'lead-lane', 'manifest.json'), manifest('legacy'))
    // An ambient config root with a matching-looking manifest must be ignored.
    const ambient = join(parent, 'ambient-claude')
    await mkdir(join(ambient, 'teams', 'legacy', '.opencode-runtime', 'lanes', 'lead-lane'), { recursive: true })
    await writeFile(join(ambient, 'teams', 'legacy', '.opencode-runtime', 'lanes', 'lead-lane', 'manifest.json'),
      JSON.stringify({ schemaVersion: 1, teamName: 'legacy', activeRunId: runId,
        activeCapabilitySnapshotId: `opencode:${'9'.repeat(32)}` }))
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = ambient
    try {
      const sessionTeams: string[] = []
      const bridged: Array<{ teamId: string; capabilitySnapshotId: string }> = []
      const pump = f.build({
        getCapability: undefined,
        getSession: async (team, laneId, memberName) => {
          sessionTeams.push(team)
          return { teamId: team, laneId, memberName, runId, opencodeSessionId: sessionId,
            projectPath: join(parent, 'workspace'), selectedModel: 'openai/gpt-6-sol', staleReason: null,
            profileScope: { purpose: 'launch_runtime' } } as OpenCodeSessionRecord
        },
        executeBridge: async input => {
          bridged.push({ teamId: input.teamId, capabilitySnapshotId: input.capabilitySnapshotId })
          return { ok: true, data: { accepted: true, sessionId, runtimePromptMessageId: 'prompt-1' } }
        },
      })
      expect(await pump.recover()).toEqual([{ kind: 'accepted' }])
      expect(sessionTeams.length).toBeGreaterThan(0)
      expect(new Set(sessionTeams)).toEqual(new Set(['legacy']))
      expect(bridged).toEqual([{ teamId: 'legacy', capabilitySnapshotId }])
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previous
    }
  })

  test('recovers a missed wake from durable inbox and sends once across restart', async () => {
    const f = await fixture()
    const first = f.build()
    expect(await first.recover()).toEqual([{ kind: 'accepted' }])
    expect(f.calls).toEqual(['send'])
    const restarted = f.build()
    expect(await restarted.recover()).toEqual([{ kind: 'observed' }])
    expect(await restarted.wake(message, authority)).toEqual({ kind: 'observed' })
    expect(f.calls).toEqual(['send', 'status', 'observe'])
    const [marker] = await readdir(join(f.root, 'hosted-team-lead-inbox-pump'))
    expect(JSON.parse(await readFile(join(f.root, 'hosted-team-lead-inbox-pump', marker!), 'utf8')))
      .toMatchObject({ status: 'observed', message, selected: { sessionId, runId, laneId: 'lead-lane' } })
  })

  test('ambiguous prompt outcome is reconciled and never blindly sent again', async () => {
    const f = await fixture()
    f.setBridge(async input => {
      f.calls.push(input.command)
      if (input.command === 'send') throw new Error('response lost after POST')
      if (input.command === 'status') return { ok: true, data: { status: 'prompt_submitting', accepted: false, safeToRetry: false } }
      return { ok: false }
    })
    expect(await f.build().wake(message, authority)).toEqual({ kind: 'pending' })
    expect(await f.build().recover()).toEqual([{ kind: 'pending' }])
    expect(f.calls).toEqual(['send', 'status', 'status'])
    for (let check = 0; check < 9; check++) {
      expect(await f.build().recover()).toEqual([{ kind: 'pending' }])
    }
    expect(await f.build().recover()).toEqual([{ kind: 'operator_required' }])
    expect(f.calls.filter(command => command === 'send')).toHaveLength(1)
  })

  test('recovers accepted prompt from outcome observation after a lost response', async () => {
    const f = await fixture()
    f.setBridge(async input => {
      f.calls.push(input.command)
      if (input.command === 'send') throw new Error('accepted POST response was lost')
      if (input.command === 'status') return { ok: true, data: {
        status: 'prompt_accepted', accepted: true, sessionId, runtimePromptMessageId: 'prompt-1',
      } }
      return { ok: true, data: { observed: true, sessionId, responseObservation: verifiedObservation } }
    })
    expect(await f.build().wake(message, authority)).toEqual({ kind: 'observed' })
    expect(await f.build().recover()).toEqual([{ kind: 'observed' }])
    expect(f.calls).toEqual(['send', 'status', 'observe'])
  })

  test('does not terminalize a failed or uncorrelated observation', async () => {
    const f = await fixture()
    f.setBridge(async input => {
      f.calls.push(input.command)
      if (input.command === 'send') throw new Error('accepted POST response was lost')
      if (input.command === 'status') return { ok: true, data: {
        status: 'prompt_accepted', accepted: true, sessionId, runtimePromptMessageId: 'prompt-1',
      } }
      return { ok: true, data: { observed: true, sessionId, responseObservation: {
        state: 'reconcile_failed', deliveredUserMessageId: null, assistantMessageId: null,
      } } }
    })
    expect(await f.build().wake(message, authority)).toEqual({ kind: 'accepted' })
    const [marker] = await readdir(join(f.root, 'hosted-team-lead-inbox-pump'))
    expect(JSON.parse(await readFile(join(f.root, 'hosted-team-lead-inbox-pump', marker!), 'utf8')).status)
      .toBe('accepted')
    expect(await f.build().recover()).toEqual([{ kind: 'accepted' }])
    expect(f.calls).toEqual(['send', 'status', 'observe', 'status', 'observe'])
  })

  test('crash at durable intent with unknown bridge outcome requires an operator', async () => {
    const f = await fixture()
    expect(await f.build().wake(message, authority)).toEqual({ kind: 'accepted' })
    const [name] = await readdir(join(f.root, 'hosted-team-lead-inbox-pump'))
    const path = join(f.root, 'hosted-team-lead-inbox-pump', name!)
    const persisted = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, `${JSON.stringify({ ...persisted, status: 'intent',
      runtimePromptMessageId: undefined })}\n`, { mode: 0o600 })
    f.calls.length = 0
    f.setBridge(async input => {
      f.calls.push(input.command)
      return { ok: true, data: { status: 'unknown', accepted: false } }
    })
    expect(await f.build().recover()).toEqual([{ kind: 'operator_required' }])
    expect(await f.build().recover()).toEqual([{ kind: 'operator_required' }])
    expect(f.calls).toEqual(['status'])
    expect(JSON.parse(await readFile(path, 'utf8')).status).toBe('operator_required')
  })

  test('recovery answers a terminal intent without rereading the inbox or the bridge', async () => {
    const f = await fixture()
    expect(await f.build().wake(message, authority)).toEqual({ kind: 'accepted' })
    expect(await f.build().wake(message, authority)).toEqual({ kind: 'observed' })
    const [name] = await readdir(join(f.root, 'hosted-team-lead-inbox-pump'))
    const path = join(f.root, 'hosted-team-lead-inbox-pump', name!)
    const observed = JSON.parse(await readFile(path, 'utf8'))
    expect(observed).toMatchObject({ status: 'observed', inboxReadCommitted: true })
    // An unsafe inbox fails every path that reads it, so a skipped read is observable.
    const inbox = join(f.root, 'inboxes', 'team-lead.json')
    await chmod(inbox, 0o644)
    f.calls.length = 0
    expect(await f.build().recover()).toEqual([{ kind: 'observed' }])
    expect(await f.build().wake(message, authority)).toEqual({ kind: 'operator_required' })
    await writeFile(path, `${JSON.stringify({ ...observed, status: 'operator_required' })}\n`, { mode: 0o600 })
    expect(await f.build().recover()).toEqual([{ kind: 'operator_required' }])
    expect(f.calls).toEqual([])

    // A record for another actor is not trusted as terminal and takes the full wake path.
    await writeFile(path, `${JSON.stringify({ ...observed,
      authority: { ...observed.authority, actorId: 'actor-b' } })}\n`, { mode: 0o600 })
    expect(await f.build().recover()).toEqual([{ kind: 'operator_required' }])
    await chmod(inbox, 0o600)
    expect(await f.build().recover()).toEqual([{ kind: 'operator_required' }])
    expect(JSON.parse(await readFile(path, 'utf8')).authority.actorId).toBe('actor-b')
  })

  test('recovery still commits the inbox read of an observed prompt', async () => {
    const f = await fixture()
    expect(await f.build().wake(message, authority)).toEqual({ kind: 'accepted' })
    expect(await f.build().wake(message, authority)).toEqual({ kind: 'observed' })
    const [name] = await readdir(join(f.root, 'hosted-team-lead-inbox-pump'))
    const path = join(f.root, 'hosted-team-lead-inbox-pump', name!)
    const { inboxReadCommitted: _, ...uncommitted } = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, `${JSON.stringify(uncommitted)}\n`, { mode: 0o600 })
    expect(await f.build().recover()).toEqual([{ kind: 'observed' }])
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ status: 'observed', inboxReadCommitted: true })
  })

  test('periodic recovery submits a queued row when the selected run becomes active', async () => {
    const f = await fixture()
    f.stop()
    const pump = f.build()
    pump.start(100)
    expect(await pump.recover()).toEqual([{ kind: 'unavailable' }])
    f.resume()
    const deadline = Date.now() + 1000
    while (f.calls.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await pump.close()
    expect(f.calls).toEqual(['send'])
  })

  test('does not reroute a missing lead message to a worker session', async () => {
    const f = await fixture()
    f.removeLead()
    expect(await f.build().wake(message, authority)).toEqual({ kind: 'unavailable' })
    expect(f.calls).toEqual([])
  })

  test('revocation during async preflight prevents transport for every hosted selection fence', async () => {
    for (const change of ['stop', 'replacePlan', 'replaceSession', 'revoke', 'close'] as const) {
      const f = await fixture()
      let release!: () => void
      const preflight = new Promise<void>(resolve => { release = resolve })
      let entered!: () => void
      const started = new Promise<void>(resolve => { entered = resolve })
      let posts = 0
      f.setBridge(async (input, guard, signal) => {
        f.calls.push(input.command)
        if (input.command === 'send') {
          entered()
          await preflight
          if (!signal.aborted && await guard()) posts++
          return { ok: false }
        }
        return { ok: true, data: { status: 'unknown', accepted: false } }
      })
      const pump = f.build()
      const pending = pump.wake(message, authority)
      await started
      const closing = change === 'close' ? pump.close() : null
      if (change !== 'close') f[change]()
      release()
      await pending
      await closing
      expect(posts).toBe(0)
      expect(f.calls[0]).toBe('send')
    }
  })

  test('rechecks lease, plan and run after blocked session or capability reads at transport edge', async () => {
    const cases = [
      ['session', 'revoke'],
      ['capability', 'replacePlan'],
      ['capability', 'stop'],
    ] as const
    for (const [blockedRead, change] of cases) {
      const f = await fixture()
      let resume!: () => void
      const blocked = new Promise<void>(resolve => { resume = resolve })
      let entered!: () => void
      const started = new Promise<void>(resolve => { entered = resolve })
      let posts = 0
      f.setBridge(async (input, guard) => {
        f.calls.push(input.command)
        if (input.command === 'send') {
          const hook = async () => { entered(); await blocked }
          if (blockedRead === 'session') f.onSessionRead(hook)
          else f.onCapabilityRead(hook)
          if (await guard()) posts++
          return { ok: false }
        }
        return { ok: true, data: { status: 'unknown', accepted: false } }
      })
      const pending = f.build().wake(message, authority)
      await started
      f[change]()
      resume()
      expect(await pending).toEqual({ kind: 'unavailable' })
      expect(posts).toBe(0)
      expect(f.calls).toEqual(['send'])
    }
  })

  test('stale run, session, plan, or owner fences prompt and observation', async () => {
    for (const mutate of ['stop', 'revoke'] as const) {
      const f = await fixture()
      f[mutate]()
      expect(await f.build().wake(message, authority)).toEqual({ kind: 'unavailable' })
      expect(f.calls).toEqual([])
    }
    for (const mutate of ['stop', 'replaceSession', 'replacePlan', 'revoke'] as const) {
      const f = await fixture()
      expect(await f.build().wake(message, authority)).toEqual({ kind: 'accepted' })
      f[mutate]()
      expect(await f.build().recover()).toEqual([{ kind: 'unavailable' }])
      expect(f.calls).toEqual(['send'])
    }
  })

  test('close fences new effects and waits for admitted prompt', async () => {
    const f = await fixture()
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    f.setBridge(async input => {
      f.calls.push(input.command)
      started()
      await blocked
      return { ok: true, data: { accepted: true, sessionId, runtimePromptMessageId: 'prompt-1' } }
    })
    const pump = f.build()
    const pending = pump.wake(message, authority)
    await entered
    let closed = false
    const closing = pump.close().then(() => { closed = true })
    expect(await pump.wake(message, authority)).toEqual({ kind: 'unavailable' })
    expect(closed).toBe(false)
    release()
    expect(await pending).toEqual({ kind: 'accepted' })
    await closing
    expect(closed).toBe(true)
    expect(f.calls).toEqual(['send'])
  })

  test('prompts the addressed teammate with the delivery contract and marks its inbox row read', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'config.json'), JSON.stringify({
      members: [{ name: 'team-lead', agentType: 'team-lead' }, { name: 'alice' }],
    }), { mode: 0o600 })
    const dm = { ...message, messageId: `message_${'f'.repeat(32)}`,
      clientMessageId: 'client_message_inbox-pump-dm', text: 'Alice, check the build.', recipient: 'alice' }
    expect(await new HostedTeamLeadMessageDelivery({
      canonicalTeamRoot: f.root, legacyKey: 'legacy', authority, guard: { isCurrent: async () => true },
      recipients: new HostedTeamRecipientRoster(f.root),
    }).deliver(dm, authority)).toEqual({ kind: 'delivered' })
    const sent: Array<{ memberName?: string; text?: string }> = []
    f.setBridge(async input => {
      f.calls.push(input.command)
      if (input.command === 'send') sent.push({ memberName: input.memberName, text: input.text })
      return { ok: true, data: { accepted: true, sessionId, runtimePromptMessageId: 'prompt-1' } }
    })

    expect(await f.build().wake(dm, authority)).toEqual({ kind: 'accepted' })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.memberName).toBe('alice')
    expect(sent[0]!.text).toStartWith('<opencode_app_message_delivery>')
    // Agents know their team by the admitted directory name, not the hosted team id.
    expect(sent[0]!.text).toContain('{"teamName":"legacy","to":"user"')
    expect(sent[0]!.text).toContain(`"to":"user","from":"alice","source":"runtime_delivery","relayOfMessageId":"${dm.messageId}"`)
    expect(sent[0]!.text).toEndWith(`<opencode_inbound_app_message>\n${dm.text}\n</opencode_inbound_app_message>`)
    const rows = JSON.parse(await readFile(join(f.root, 'inboxes', 'alice.json'), 'utf8'))
    expect(rows).toEqual([expect.objectContaining({ messageId: dm.messageId, read: true })])
    const lead = JSON.parse(await readFile(join(f.root, 'inboxes', 'team-lead.json'), 'utf8'))
    expect(lead).toEqual([expect.objectContaining({ messageId: message.messageId, read: false })])

    // A replayed wake is idempotent: no second prompt, the read commit is durable.
    expect(await f.build().wake(dm, authority)).toEqual({ kind: 'accepted' })
    expect(sent).toHaveLength(1)
    const intents = await Promise.all((await readdir(join(f.root, 'hosted-team-lead-inbox-pump')))
      .map(async name => JSON.parse(await readFile(join(f.root, 'hosted-team-lead-inbox-pump', name), 'utf8'))))
    expect(intents).toEqual([expect.objectContaining({
      message: dm, status: 'accepted', inboxReadCommitted: true,
    })])
  })

  test('treats a native lane recipient as delivered to its inbox and never polls it again', async () => {
    const f = await fixture()
    f.useNativeLane()
    const pump = f.build()
    expect(await pump.wake(message, authority)).toEqual({ kind: 'native_inbox' })
    expect(await pump.recover()).toEqual([{ kind: 'native_inbox' }])
    expect(await f.build().wake(message, authority)).toEqual({ kind: 'native_inbox' })
    expect(f.calls).toEqual([])
    const lead = JSON.parse(await readFile(join(f.root, 'inboxes', 'team-lead.json'), 'utf8'))
    // The native process marks its own rows read.
    expect(lead).toEqual([expect.objectContaining({ messageId: message.messageId, read: false })])
  })

  test('resends an intent whose fence failed before the bridge call and reports the reason once', async () => {
    const f = await fixture()
    const reports: unknown[] = []
    const fenced = f.build({
      readActiveRun: async () => ({ phase: 'stopping', runId }),
      reportDecision: report => { reports.push(report) },
    })
    expect(await fenced.wake(message, authority)).toEqual({ kind: 'unavailable' })
    expect(await fenced.wake(message, authority)).toEqual({ kind: 'unavailable' })
    expect(reports).toEqual([{ messageId: message.messageId, recipient: 'team-lead',
      decision: 'unavailable', reason: 'fence:run_not_running:stopping' }])
    expect(f.calls).toEqual([])
    // The durable intent was never sent, so it is sent now instead of being
    // reconciled into an acceptance the runtime never saw.
    expect(await f.build().wake(message, authority)).toEqual({ kind: 'accepted' })
    expect(f.calls).toEqual(['send'])
  })

  test('retries a proven failed_before_accept with a fresh request a bounded number of times', async () => {
    const f = await fixture()
    const requestIds: string[] = []
    f.setBridge(async input => {
      f.calls.push(input.command)
      if (input.command === 'send') {
        requestIds.push((input as { requestId?: string }).requestId ?? '')
        return { ok: false }
      }
      return { ok: true, data: { status: 'failed_before_accept', accepted: false, safeToRetry: true } }
    })
    expect(await f.build().wake(message, authority)).toEqual({ kind: 'pending' })
    expect(await f.build().recover()).toEqual([{ kind: 'pending' }])
    expect(await f.build().recover()).toEqual([{ kind: 'operator_required' }])
    expect(await f.build().recover()).toEqual([{ kind: 'operator_required' }])
    expect(f.calls.filter(command => command === 'send')).toHaveLength(3)
    expect(new Set(requestIds).size).toBe(3)
  })
})

