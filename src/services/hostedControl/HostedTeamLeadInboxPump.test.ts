import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { OpenCodeSessionRecord } from '../opencode/types.js'
import type { TeamLifecycleLaunchPlan } from '../teamLifecycleOwner/TeamLifecycleLaunchPlan.js'
import { writeToMailboxAtCanonicalTeamRootVerified } from '../../utils/teammateMailbox.js'
import {
  HostedTeamLeadInboxPump,
  type HostedTeamLeadInboxPumpOptions,
  type InboxPumpTiming,
} from './HostedTeamLeadInboxPump.js'
import type { HostedControlAuthority } from './protocol.js'

const roots: string[] = []
const teamId = `team_${'a'.repeat(32)}`
const authority: HostedControlAuthority = {
  actorId: 'actor-a', deploymentId: 'deployment-a', bootId: 'boot-a',
  restoreGeneration: 1, workspaceId: 'workspace-a',
  mountBinding: { mountGeneration: 1, declaredRootHash: 'b'.repeat(64) }, teamId,
}
/** An operator row as message_send appends it to team-lead's inbox. */
const message = {
  messageId: `message_${'c'.repeat(32)}`, text: 'Message the lead.', createdAt: '2026-09-24T10:00:00.000Z',
}
const appendOperatorRow = (root: string, recipientName: string, row: typeof message) =>
  writeToMailboxAtCanonicalTeamRootVerified({ canonicalTeamRoot: root, recipientName,
    message: { messageId: row.messageId, from: 'user', text: row.text, timestamp: row.createdAt } })
const wakeLead = (pump: HostedTeamLeadInboxPump) => pump.wakeRecipient('team-lead', message.messageId)
/** Simulates a crash before the read commit reached the inbox. */
async function markLeadRowUnread(root: string): Promise<void> {
  const path = join(root, 'inboxes', 'team-lead.json')
  const rows = JSON.parse(await readFile(path, 'utf8')) as Array<Record<string, unknown>>
  await writeFile(path, JSON.stringify(rows.map(row => ({ ...row, read: false }))), { mode: 0o600 })
}
const sessionId = 'session-lead'
const runId = `run_${'d'.repeat(32)}`
const capabilitySnapshotId = `opencode:${'e'.repeat(32)}`
const verifiedObservation = {
  state: 'responded_plain_text', deliveredUserMessageId: 'prompt-1', assistantMessageId: 'assistant-1',
}
type TestBridge = (
  input: { command: string; memberName?: string; text?: string; requestId?: string },
  guard: () => Promise<boolean>,
  signal: AbortSignal,
  onStage?: (stage: string) => void,
) => Promise<{ ok: boolean; data?: Record<string, unknown>; notReceived?: true }>

async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'hosted-inbox-pump-')))
  roots.push(parent)
  const root = join(parent, 'legacy')
  const workspace = join(parent, 'workspace')
  await mkdir(root, { mode: 0o700 })
  await mkdir(workspace, { mode: 0o700 })
  expect((await appendOperatorRow(root, 'team-lead', message)).kind).toBe('written')
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
    readActiveRun: async () => ({ phase: active ? 'running' : 'stopping', runId }),
    getSession: async (_teamId, _laneId, memberName) => { await sessionReadHook(); return ({
      teamId: 'legacy', laneId: 'lead-lane', memberName, runId,
      opencodeSessionId: selectedSession, projectPath: workspace,
      selectedModel: 'openai/gpt-6-sol', staleReason: null,
      profileScope: { purpose: 'launch_runtime' },
    }) as OpenCodeSessionRecord },
    getCapability: async () => { await capabilityReadHook(); return capabilitySnapshotId },
    executeBridge: (input, guard, signal, onStage) => bridge(input, guard, signal, onStage),
    ...overrides,
  })
  return { root, build, calls, setBridge: (next: typeof bridge) => { bridge = next },
    stop: () => { active = false }, resume: () => { active = true },
    revoke: () => { current = false },
    replaceSession: () => { selectedSession = 'replacement' },
    replacePlan: () => { planGeneration = 'plan-generation_second' },
    onSessionRead: (hook: typeof sessionReadHook) => { sessionReadHook = hook },
    onCapabilityRead: (hook: typeof capabilityReadHook) => { capabilityReadHook = hook },
    // A native lead team (planLanes) with one OpenCode member lane, like desktop mixed_opencode_side_lanes.
    useMixedLanes: () => { plan = { ...plan, toolApprovalMode: 'auto', lanes: [
      { laneId: 'native-lane', kind: 'native', provider: 'anthropic',
        members: [{ name: 'team-lead', prompt: 'Lead.' }, { name: 'bob', prompt: 'Review.' }] },
      { laneId: 'lead-lane', kind: 'opencode', provider: 'opencode', selectedModel: 'openai/gpt-6-sol',
        members: [{ name: 'alice', prompt: 'Build.' }] },
    ] } },
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
    // The accepted row is read now: a restarted pump neither prompts nor reconciles it.
    const restarted = f.build()
    expect(await restarted.recover()).toEqual([])
    expect(await wakeLead(restarted)).toEqual({ kind: 'accepted' })
    expect(f.calls).toEqual(['send'])
    const [marker] = await readdir(join(f.root, 'hosted-team-lead-inbox-pump'))
    expect(JSON.parse(await readFile(join(f.root, 'hosted-team-lead-inbox-pump', marker!), 'utf8')))
      .toMatchObject({ status: 'accepted', inboxReadCommitted: true,
        message: { text: message.text, createdAt: message.createdAt,
          relay: { sourceMessageId: message.messageId, from: 'user', replyRecipient: 'user' } },
        selected: { sessionId, runId, laneId: 'lead-lane' } })
  })

  test('ambiguous prompt outcome is reconciled and never blindly sent again', async () => {
    const f = await fixture()
    f.setBridge(async input => {
      f.calls.push(input.command)
      if (input.command === 'send') throw new Error('response lost after POST')
      if (input.command === 'status') return { ok: true, data: { status: 'prompt_submitting', accepted: false, safeToRetry: false } }
      return { ok: false }
    })
    expect(await wakeLead(f.build())).toEqual({ kind: 'pending' })
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
    expect(await wakeLead(f.build())).toEqual({ kind: 'observed' })
    expect(await f.build().recover()).toEqual([])
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
    expect(await wakeLead(f.build())).toEqual({ kind: 'accepted' })
    const [marker] = await readdir(join(f.root, 'hosted-team-lead-inbox-pump'))
    expect(JSON.parse(await readFile(join(f.root, 'hosted-team-lead-inbox-pump', marker!), 'utf8')).status)
      .toBe('accepted')
    expect(await f.build().recover()).toEqual([])
    expect(f.calls).toEqual(['send', 'status', 'observe'])
  })

  test('crash at durable intent with unknown bridge outcome requires an operator', async () => {
    const f = await fixture()
    expect(await wakeLead(f.build())).toEqual({ kind: 'accepted' })
    const [name] = await readdir(join(f.root, 'hosted-team-lead-inbox-pump'))
    const path = join(f.root, 'hosted-team-lead-inbox-pump', name!)
    const { inboxReadCommitted: _read, ...persisted } = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, `${JSON.stringify({ ...persisted, status: 'intent',
      runtimePromptMessageId: undefined })}\n`, { mode: 0o600 })
    await markLeadRowUnread(f.root)
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

  test('an operator_required or foreign intent is never prompted again while its row stays unread', async () => {
    const f = await fixture()
    expect(await wakeLead(f.build())).toEqual({ kind: 'accepted' })
    const [name] = await readdir(join(f.root, 'hosted-team-lead-inbox-pump'))
    const path = join(f.root, 'hosted-team-lead-inbox-pump', name!)
    const accepted = JSON.parse(await readFile(path, 'utf8'))
    await markLeadRowUnread(f.root)
    f.calls.length = 0
    await writeFile(path, `${JSON.stringify({ ...accepted, status: 'operator_required' })}\n`, { mode: 0o600 })
    expect(await f.build().recover()).toEqual([{ kind: 'operator_required' }])
    // A record for another actor is not trusted and is left for an operator.
    await writeFile(path, `${JSON.stringify({ ...accepted,
      authority: { ...accepted.authority, actorId: 'actor-b' } })}\n`, { mode: 0o600 })
    expect(await f.build().recover()).toEqual([{ kind: 'operator_required' }])
    expect(f.calls).toEqual([])
    expect(JSON.parse(await readFile(path, 'utf8')).authority.actorId).toBe('actor-b')
  })

  test('recovery still commits the inbox read of an observed prompt', async () => {
    const f = await fixture()
    expect(await wakeLead(f.build())).toEqual({ kind: 'accepted' })
    const [name] = await readdir(join(f.root, 'hosted-team-lead-inbox-pump'))
    const path = join(f.root, 'hosted-team-lead-inbox-pump', name!)
    const { inboxReadCommitted: _, ...uncommitted } = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, `${JSON.stringify({ ...uncommitted, status: 'observed' })}\n`, { mode: 0o600 })
    await markLeadRowUnread(f.root)
    expect(await f.build().recover()).toEqual([{ kind: 'observed' }])
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ status: 'observed', inboxReadCommitted: true })
    const [row] = JSON.parse(await readFile(join(f.root, 'inboxes', 'team-lead.json'), 'utf8'))
    expect(row.read).toBe(true)
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
    expect(await wakeLead(f.build())).toEqual({ kind: 'unavailable' })
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
      const pending = wakeLead(pump)
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
      const pending = wakeLead(f.build())
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
      expect(await wakeLead(f.build())).toEqual({ kind: 'unavailable' })
      expect(f.calls).toEqual([])
    }
    for (const mutate of ['stop', 'replaceSession', 'replacePlan', 'revoke'] as const) {
      const f = await fixture()
      expect(await wakeLead(f.build())).toEqual({ kind: 'accepted' })
      await markLeadRowUnread(f.root)
      f[mutate]()
      // An accepted prompt is only reconciled under the fences it was sent with.
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
    const pending = wakeLead(pump)
    await entered
    let closed = false
    const closing = pump.close().then(() => { closed = true })
    expect(await wakeLead(pump)).toEqual({ kind: 'unavailable' })
    expect(closed).toBe(false)
    release()
    expect(await pending).toEqual({ kind: 'accepted' })
    await closing
    expect(closed).toBe(true)
    expect(f.calls).toEqual(['send'])
  })

  test('prompts the addressed teammate with the delivery contract and marks its inbox row read', async () => {
    const f = await fixture()
    const dm = { messageId: `message_${'f'.repeat(32)}`, text: 'Alice, check the build.',
      createdAt: '2026-09-24T10:00:30.000Z' }
    expect((await appendOperatorRow(f.root, 'alice', dm)).kind).toBe('written')
    const sent: Array<{ memberName?: string; text?: string }> = []
    f.setBridge(async input => {
      f.calls.push(input.command)
      if (input.command === 'send') sent.push({ memberName: input.memberName, text: input.text })
      return { ok: true, data: { accepted: true, sessionId, runtimePromptMessageId: 'prompt-1' } }
    })

    expect(await f.build().wakeRecipient('alice', dm.messageId)).toEqual({ kind: 'accepted' })
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
    expect(await f.build().wakeRecipient('alice', dm.messageId)).toEqual({ kind: 'accepted' })
    expect(sent).toHaveLength(1)
    const intents = await Promise.all((await readdir(join(f.root, 'hosted-team-lead-inbox-pump')))
      .map(async name => JSON.parse(await readFile(join(f.root, 'hosted-team-lead-inbox-pump', name), 'utf8'))))
    expect(intents).toEqual([expect.objectContaining({
      message: expect.objectContaining({ recipient: 'alice', relay: expect.objectContaining({ sourceMessageId: dm.messageId }) }),
      status: 'accepted', inboxReadCommitted: true,
    })])
  })

  test('treats a native lane recipient as delivered to its inbox and never polls it again', async () => {
    const f = await fixture()
    f.useNativeLane()
    const pump = f.build()
    expect(await wakeLead(pump)).toEqual({ kind: 'native_inbox' })
    // Recovery drains only OpenCode members; a native member reads its own inbox.
    expect(await pump.recover()).toEqual([])
    expect(await wakeLead(f.build())).toEqual({ kind: 'native_inbox' })
    expect(f.calls).toEqual([])
    const lead = JSON.parse(await readFile(join(f.root, 'inboxes', 'team-lead.json'), 'utf8'))
    // The native process marks its own rows read.
    expect(lead).toEqual([expect.objectContaining({ messageId: message.messageId, read: false })])
  })

  test('resends an intent whose fence failed before the bridge call and reports the reason once', async () => {
    const f = await fixture()
    const reports: unknown[] = []
    let runReads = 0
    const fenced = f.build({
      // Running when the intent is selected (two reads), stopping by its fence.
      readActiveRun: async () => ({ phase: runReads++ < 2 ? 'running' : 'stopping', runId }),
      reportDecision: report => { reports.push(report) },
    })
    expect(await wakeLead(fenced)).toEqual({ kind: 'unavailable' })
    expect(await wakeLead(fenced)).toEqual({ kind: 'unavailable' })
    // The resend reselects before its fence, so the second miss names the selection.
    expect(reports).toEqual(['fence:run_not_running:stopping', 'run_not_running:stopping'].map(reason => ({
      messageId: message.messageId, recipient: 'team-lead', decision: 'unavailable', reason })))
    expect(f.calls).toEqual([])
    // The durable intent was never sent, so it is sent now instead of being
    // reconciled into an acceptance the runtime never saw.
    expect(await wakeLead(f.build())).toEqual({ kind: 'accepted' })
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
    expect(await wakeLead(f.build())).toEqual({ kind: 'pending' })
    expect(await f.build().recover()).toEqual([{ kind: 'pending' }])
    expect(await f.build().recover()).toEqual([{ kind: 'operator_required' }])
    expect(await f.build().recover()).toEqual([{ kind: 'operator_required' }])
    expect(f.calls.filter(command => command === 'send')).toHaveLength(3)
    expect(new Set(requestIds).size).toBe(3)
  })

  test('relays a teammate row to the recipient session once, like desktop, and never back to its sender', async () => {
    const f = await fixture()
    // The agent-teams MCP writer creates inboxes under its umask: 0644 on a live host.
    const inbox = async (member: string, rows: Array<Record<string, unknown>>) => {
      const path = join(f.root, 'inboxes', `${member}.json`)
      await writeFile(path, JSON.stringify(rows))
      await chmod(path, 0o644)
    }
    const leadToAlice = { messageId: 'relay-source-1', from: 'team-lead', text: 'Alice, take task #t1.',
      timestamp: '2026-09-24T10:01:00.000Z', read: false }
    await inbox('alice', [
      leadToAlice,
      // Its own row is never relayed; an operator row takes the same path, after the teammate row.
      { messageId: 'relay-self', from: 'alice', text: 'note to self', timestamp: '2026-09-24T10:02:00.000Z', read: false },
      { messageId: 'relay-user', from: 'user', text: 'Operator note.', timestamp: '2026-09-24T10:03:00.000Z', read: false },
    ])
    const sent: Array<{ memberName?: string; text?: string }> = []
    f.setBridge(async input => {
      f.calls.push(input.command)
      if (input.command === 'send') sent.push({ memberName: input.memberName, text: input.text })
      return { ok: true, data: { accepted: true, sessionId, runtimePromptMessageId: 'prompt-1' } }
    })

    const pump = f.build()
    await pump.recover()
    const alicePrompts = sent.filter(prompt => prompt.memberName === 'alice').map(prompt => prompt.text!)
    expect(alicePrompts).toHaveLength(2)
    const prompt = alicePrompts[0]!
    expect(alicePrompts[1]).toContain('"to":"user","from":"alice","source":"runtime_delivery","relayOfMessageId":"relay-user"')
    // The recipient answers its sender through message_send, linked to the source row.
    expect(prompt).toContain(`{"teamName":"legacy","to":"team-lead","from":"alice","source":"runtime_delivery","relayOfMessageId":"relay-source-1"}`)
    expect(prompt).toEndWith(`<opencode_inbound_app_message>\n${leadToAlice.text}\n</opencode_inbound_app_message>`)
    const rows = JSON.parse(await readFile(join(f.root, 'inboxes', 'alice.json'), 'utf8'))
    expect(rows.map((row: { messageId: string; read: boolean }) => [row.messageId, row.read])).toEqual([
      ['relay-source-1', true], ['relay-self', false], ['relay-user', true],
    ])
    // The owner's read commit leaves the inbox owner-private again.
    expect((await lstat(join(f.root, 'inboxes', 'alice.json'))).mode & 0o777).toBe(0o600)
    const sends = sent.length
    await pump.recover()
    await f.build().recover()
    expect(sent).toHaveLength(sends)
  })

  test('in a native-led team relays only to OpenCode members and never touches native inboxes', async () => {
    const f = await fixture()
    f.useMixedLanes()
    const inbox = async (member: string, rows: Array<Record<string, unknown>>) => {
      const path = join(f.root, 'inboxes', `${member}.json`)
      await writeFile(path, JSON.stringify(rows))
      await chmod(path, 0o644)
      return path
    }
    await inbox('alice', [{ messageId: 'lead-to-alice', from: 'team-lead', text: 'Alice, build #t1.',
      timestamp: '2026-09-24T10:01:00.000Z', read: false }])
    const nativeInboxes = [
      await inbox('bob', [{ messageId: 'alice-to-bob', from: 'alice', text: 'Please review.',
        timestamp: '2026-09-24T10:02:00.000Z', read: false }]),
      await inbox('team-lead', [{ messageId: 'alice-to-lead', from: 'alice', text: 'Done with #t1.',
        timestamp: '2026-09-24T10:03:00.000Z', read: false }]),
    ]
    const before = await Promise.all(nativeInboxes.map(async path => [await readFile(path, 'utf8'),
      (await lstat(path)).mode & 0o777] as const))
    const sent: string[] = []
    f.setBridge(async input => {
      f.calls.push(input.command)
      if (input.command === 'send') sent.push(String(input.memberName))
      return { ok: true, data: { accepted: true, sessionId, runtimePromptMessageId: 'prompt-1' } }
    })

    await f.build().recover()
    expect(sent).toEqual(['alice'])
    const aliceRows = JSON.parse(await readFile(join(f.root, 'inboxes', 'alice.json'), 'utf8'))
    expect(aliceRows.map((row: { read: boolean }) => row.read)).toEqual([true])
    // The native lead and native teammates poll their own inboxes: bytes and mode stay as written.
    expect(await Promise.all(nativeInboxes.map(async path => [await readFile(path, 'utf8'),
      (await lstat(path)).mode & 0o777] as const))).toEqual(before)
  })

  test('a restart between the issued send and its acceptance never relays the row twice', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'inboxes', 'alice.json'), JSON.stringify([
      { messageId: 'relay-lost', from: 'team-lead', text: 'Ship it.', timestamp: '2026-09-24T10:01:00.000Z', read: false },
    ]), { mode: 0o600 })
    let sends = 0
    let runtimeReachable = false
    f.setBridge(async input => {
      f.calls.push(input.command)
      if (input.memberName !== 'alice') {
        return { ok: true, data: { accepted: true, sessionId, runtimePromptMessageId: 'prompt-1' } }
      }
      if (input.command === 'send') {
        sends++
        // The prompt reached the runtime, then the owner died before the answer.
        throw new Error('owner stopped after the POST')
      }
      if (!runtimeReachable) throw new Error('runtime unreachable while the owner restarts')
      return { ok: true, data: { status: 'prompt_accepted', accepted: true, sessionId, runtimePromptMessageId: 'prompt-1' } }
    })
    await f.build().recover()
    expect(sends).toBe(1)
    runtimeReachable = true
    const restarted = f.build()
    await restarted.recover()
    await restarted.recover()
    expect(sends).toBe(1)
    const [row] = JSON.parse(await readFile(join(f.root, 'inboxes', 'alice.json'), 'utf8'))
    expect(row.read).toBe(true)
  })

  test('holds later rows of a recipient behind one that cannot be prompted yet', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'inboxes', 'alice.json'), JSON.stringify([
      { messageId: 'relay-second', from: 'team-lead', text: 'Second.', timestamp: '2026-09-24T10:02:00.000Z', read: false },
      { messageId: 'relay-first', from: 'team-lead', text: 'First.', timestamp: '2026-09-24T10:01:00.000Z', read: false },
    ]), { mode: 0o600 })
    const texts: string[] = []
    f.setBridge(async input => {
      f.calls.push(input.command)
      if (input.memberName !== 'alice') {
        return { ok: true, data: { accepted: true, sessionId, runtimePromptMessageId: 'prompt-1' } }
      }
      if (input.command === 'send') {
        texts.push(input.text!)
        return { ok: false }
      }
      return { ok: true, data: { status: 'failed_before_accept', accepted: false, safeToRetry: true } }
    })
    await f.build().recover()
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('First.')
  })

  test('a new inbox row is prompted on its file change, well before the next poll', async () => {
    const f = await fixture()
    const sent: string[] = []
    f.setBridge(async input => {
      f.calls.push(input.command)
      if (input.command === 'send') sent.push(input.memberName ?? '')
      return { ok: true, data: { accepted: true, sessionId, runtimePromptMessageId: 'prompt-1' } }
    })
    const until = async (condition: () => boolean, ms: number) => {
      const end = Date.now() + ms
      while (!condition() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20))
    }
    const pump = f.build()
    pump.start(60_000)
    await until(() => sent.includes('team-lead'), 2_000)
    expect(sent).toEqual(['team-lead'])
    const startedAt = Date.now()
    await writeFile(join(f.root, 'inboxes', 'alice.json'), JSON.stringify([
      { messageId: 'relay-watch', from: 'team-lead', text: 'Now.', timestamp: '2026-09-24T10:05:00.000Z', read: false },
    ]), { mode: 0o600 })
    await until(() => sent.includes('alice'), 2_000)
    expect(sent).toEqual(['team-lead', 'alice'])
    expect(Date.now() - startedAt).toBeLessThan(2_000)

    await pump.close()
    await writeFile(join(f.root, 'inboxes', 'alice.json'), JSON.stringify([
      { messageId: 'relay-watch', from: 'team-lead', text: 'Now.', timestamp: '2026-09-24T10:05:00.000Z', read: true },
      { messageId: 'relay-after-close', from: 'team-lead', text: 'Late.', timestamp: '2026-09-24T10:06:00.000Z', read: false },
    ]), { mode: 0o600 })
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(sent).toEqual(['team-lead', 'alice'])
  })

  test('reports where a prompt spent its time, as stage codes without text', async () => {
    const f = await fixture()
    f.setBridge(async (input, _guard, _signal, onStage) => {
      f.calls.push(input.command)
      onStage?.('received')
      await new Promise(resolve => setTimeout(resolve, 300))
      onStage?.('prompt_accepted')
      return { ok: true, data: { accepted: true, sessionId, runtimePromptMessageId: 'prompt-1' } }
    })
    const timings: InboxPumpTiming[] = []
    expect((await wakeLead(f.build({ reportTiming: timing => { timings.push(timing) } }))).kind).toBe('accepted')
    expect(timings).toHaveLength(1)
    const [timing] = timings
    expect(timing).toMatchObject({ messageId: message.messageId, recipient: 'team-lead', decision: 'accepted' })
    expect(timing!.rowAgeMs).toBeGreaterThan(0)
    const order = ['checked', 'locked', 'selected', 'intent', 'fenced', 'issued',
      'bridge.received', 'bridge.prompt_accepted', 'bridged', 'read']
    expect(Object.keys(timing!.stages)).toEqual(order)
    const at = timing!.stages
    for (let i = 1; i < order.length; i += 1) expect(at[order[i]!]!).toBeGreaterThanOrEqual(at[order[i - 1]!]!)
    // The bridge's 300 ms lands in its own segment, not in the pump's.
    expect(at['bridge.prompt_accepted']! - at['bridge.received']!).toBeGreaterThanOrEqual(290)
    expect(JSON.stringify(timing)).not.toContain(message.text)
    // A wake that finds the row already delivered does not report a prompt.
    await markLeadRowUnread(f.root)
    await wakeLead(f.build({ reportTiming: timing => { timings.push(timing) } }))
    expect(timings).toHaveLength(1)
  })

  test('a send the bridge never recorded stays unsent and is retried under the same request id', async () => {
    const f = await fixture()
    const requests: string[] = []
    let reachable = false
    f.setBridge(async input => {
      f.calls.push(input.command)
      if (input.command !== 'send') throw new Error('a never-recorded send needs no status reconcile')
      requests.push(input.requestId!)
      return reachable
        ? { ok: true, data: { accepted: true, sessionId, runtimePromptMessageId: 'prompt-1' } }
        : { ok: false, notReceived: true }
    })
    expect((await wakeLead(f.build())).kind).toBe('unavailable')
    expect(JSON.parse(await readFile(join(f.root, 'inboxes', 'team-lead.json'), 'utf8'))[0].read).toBe(false)
    reachable = true
    expect((await wakeLead(f.build())).kind).toBe('accepted')
    expect(f.calls).toEqual(['send', 'send'])
    expect(new Set(requests).size).toBe(1)
    expect(JSON.parse(await readFile(join(f.root, 'inboxes', 'team-lead.json'), 'utf8'))[0].read).toBe(true)
  })
})

