import { captureOwnedV2ProbeAuthority, buildOwnedV2ProbeProof, type ProbeAuthority } from './OpenCodeV2ProbeProof.js'
import { readOwnedControllerInbox, readOwnedControllerTools, type ControllerToolProof } from './OpenCodeV2ControllerTools.js'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { resolveOpenCodeV2ExecutionDelivery } from '../host/OpenCodeV2ExecutionDelivery.js'
import { OpenCodeV2AdmissionService, type QueueIntent } from '../execution/OpenCodeV2AdmissionService.js'
import { OpenCodeV2AdmissionStore } from '../execution/OpenCodeV2AdmissionStore.js'
import { OpenCodeV2SessionService, verifyExecutionSession } from '../execution/OpenCodeV2SessionService.js'
import { canonicalExecutionJSON, executionAssert, executionHash, executionRecord, type ExecutionContext, type SessionAuthority } from '../execution/OpenCodeV2ExecutionContracts.js'
import { acquireExecutionLease, type ExecutionLease } from '../host/OpenCodeV2ExecutionHost.js'
import { isExecutionCleanupReceipt, type ExecutionCleanupReceipt } from '../host/OpenCodeV2ExecutionLifecycle.js'
import { createOpenCodeV2ExecutionClient, type ExecutionBridgeClient, type ExecutionLog, type ExecutionMessagePage } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import { boundOpenCodeRead } from '../transport/OpenCodeBoundedFetch.js'
import { projectOpenCodeV2Turn } from './OpenCodeV2TurnProjection.js'
import { verifyOpenCodeV2SilentBootstrap } from './OpenCodeV2BootstrapProjection.js'
import { OPEN_CODE_V2_RUN_INITIALIZATION_MS, discoverOpenCodeV2Run, parseRunControlRequest, reserveRunControlDirectory, runControlDirectory, serveOpenCodeV2RunControl, writeRunControlFile } from './OpenCodeV2RunControl.js'
import type { InstructionReceipt, RunControlRecord, RunControlRequest, RunControlResult, RunExecutionPorts, RunLaunchPlan, RunMemberPlan, RunMemberStatus, RunOwnerState, RunStopMember } from './OpenCodeV2RunTypes.js'

const productionPorts: RunExecutionPorts = { acquire: acquireExecutionLease, client: createOpenCodeV2ExecutionClient }
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
type Member = {
  plan: RunMemberPlan; lease: ExecutionLease; client: ExecutionBridgeClient; authority: SessionAuthority
  store: OpenCodeV2AdmissionStore; session: OpenCodeV2SessionService; state: RunMemberStatus['state']
  probeAuthority?: ProbeAuthority; bootstrap: InstructionReceipt | null; mcpConnected: boolean; controllerTools?: ControllerToolProof; intents: Map<string, QueueIntent>
}

export function validateRunLaunchPlan(plan: RunLaunchPlan): void {
  executionAssert(Number.isSafeInteger(plan.deadline) && plan.deadline > Date.now() && plan.deadline - Date.now() <= 24 * 60 * 60 * 1000, 'run_lifetime_invalid')
  executionAssert(plan.members.length > 0 && plan.members.length <= 32 && plan.binding.ownerId.length > 0 &&
    plan.binding.teamId.length > 0 && plan.binding.runId.length > 0 && plan.binding.controllerInstanceId.length > 0, 'run_identity_invalid')
  executionAssert(new Set(plan.members.map(member => member.memberId)).size === plan.members.length &&
    new Set(plan.members.map(member => member.originalSessionId)).size === plan.members.length &&
    new Set(plan.members.map(member => member.profile.root)).size === plan.members.length, 'run_member_conflict')
  executionAssert(path.isAbsolute(plan.dataRoot) && path.isAbsolute(plan.source.entryPath) && path.isAbsolute(plan.source.bunPath), 'run_source_invalid')
  executionAssert(plan.source.files.length > 0 && plan.source.files.length <= 20_000 &&
    new Set(plan.source.files.map(file => file.path)).size === plan.source.files.length, 'run_source_invalid')
  for (const member of plan.members) {
    executionAssert(member.memberId.length > 0 && member.laneId.length > 0 && /^ses_[a-zA-Z0-9]+$/.test(member.originalSessionId), 'run_member_invalid')
    executionAssert(['source', 'packaged'].includes(member.native.runtimeMode) &&
      member.native.runtimeMode === plan.members[0]!.native.runtimeMode && member.native.generation === 'v2' &&
      ['2.0.0', '2.0.21'].includes(member.native.version), 'run_pin_unsupported')
    executionAssert(member.native.bun.path === plan.source.bunPath && member.native.bun.sha256 === plan.source.bunSha256, 'run_source_changed')
    executionAssert(/^[a-z0-9][a-z0-9._-]{0,199}$/.test(member.bootstrap.key) &&
      Buffer.byteLength(member.bootstrap.value) <= 256 * 1024 && sha(member.bootstrap.value) === member.bootstrap.contextHash &&
      /^[a-f0-9]{64}$/.test(member.bootstrap.briefingHash), 'run_bootstrap_conflict')
    executionAssert(Buffer.byteLength(canonicalExecutionJSON({ context: member.bootstrap.value, contextHash: member.bootstrap.contextHash,
      briefingHash: member.bootstrap.briefingHash, teamId: plan.binding.teamId, runId: plan.binding.runId,
      laneId: member.laneId, memberId: member.memberId, originalSessionId: member.originalSessionId })) <= 256 * 1024, 'run_bootstrap_conflict')
    executionAssert(member.controllerMcpName.length > 0 && member.advertisedTools.length <= 256, 'run_mcp_invalid')
    const mcp = executionRecord(executionRecord(JSON.parse(member.profile.config.content)).mcp)
    executionAssert(Object.hasOwn(executionRecord(mcp.servers), member.controllerMcpName), 'run_selected_mcp_missing')
  }
}

/** One bounded run, in the process that acquired every lease. No durable DTO
 * or caller-supplied ExecutionAuthority is ever converted into lease authority. */
export class OpenCodeV2RunOwner {
  private readonly members = new Map<string, Member>()
  private readonly active = new Set<Promise<unknown>>()
  private readonly operations = new Set<AbortController>()
  private readonly initializationAbort = new AbortController()
  private readonly acquisitions = new Set<AbortController>()
  private readonly pendingLeases = new Map<string, ExecutionLease>()
  private readonly closing = new Map<ExecutionLease, Promise<ExecutionCleanupReceipt>>()
  private cleanupGraceDeadline = 0
  private state: RunOwnerState = 'starting'
  private stopping: Promise<Extract<RunControlResult, { kind: 'stop' }>> | undefined
  private readonly initialization: Promise<void>
  private readonly timer: ReturnType<typeof setTimeout>
  private resolveStopped: (receipt: Extract<RunControlResult, { kind: 'stop' }>) => void = () => undefined
  readonly stopped = new Promise<Extract<RunControlResult, { kind: 'stop' }>>(resolve => { this.resolveStopped = resolve })
  constructor(private readonly plan: RunLaunchPlan, private readonly directory: string, private readonly ports: RunExecutionPorts = productionPorts) {
    validateRunLaunchPlan(plan)
    this.plan = structuredClone(plan)
    this.initialization = this.initialize()
    void this.initialization.catch(() => { void this.stop().catch(() => undefined) })
    this.timer = setTimeout(() => { void this.stop().catch(() => undefined) }, plan.deadline - Date.now())
  }
  private context(member: RunMemberPlan, deadline = this.plan.deadline, signal?: AbortSignal): ExecutionContext {
    return { teamId: this.plan.binding.teamId, runId: this.plan.binding.runId, laneId: member.laneId,
      memberId: member.memberId, deadline, ...(signal ? { signal } : {}) }
  }
  private statuses(): RunMemberStatus[] {
    return this.plan.members.map(plan => {
      const member = this.members.get(plan.memberId)
      return { memberId: plan.memberId, laneId: plan.laneId, originalSessionId: plan.originalSessionId,
        opencodeSessionId: plan.originalSessionId, runtimeSessionId: plan.originalSessionId,
        profileEpoch: plan.profile.epoch, profileRoot: plan.profile.root, pin: plan.native.version,
        ...(member ? { runtimePid: member.lease.authority.child.pid } : {}),
        selectedModel: `${plan.profile.selection.model.providerID}/${plan.profile.selection.model.id}`,
        ...(plan.profile.selection.model.variant === undefined ? {} : { selectedVariant: plan.profile.selection.model.variant }),
        state: member?.state ?? 'unknown', bootstrap: member?.bootstrap ?? null,
        ...(member?.controllerTools ? { controllerTools: member.controllerTools } : {}) }
    })
  }
  private async persistState(): Promise<void> {
    await writeRunControlFile(this.directory, 'state.json', { binding: this.plan.binding, state: this.state, deadline: this.plan.deadline, members: this.statuses() })
  }
  private async initialize(): Promise<void> {
    const initializationDeadline = Math.min(this.plan.deadline, Date.now() + OPEN_CODE_V2_RUN_INITIALIZATION_MS)
    for (const memberPlan of this.plan.members) {
      executionAssert(this.state === 'starting' && Date.now() < initializationDeadline, 'run_stopped')
      const acquiring = new AbortController()
      this.acquisitions.add(acquiring)
      const acquisitionTimer = setTimeout(() => acquiring.abort(new Error('run_acquisition_timeout')), initializationDeadline - Date.now())
      let lease: ExecutionLease
      try { lease = await this.ports.acquire(memberPlan.native, memberPlan.profile, this.context(memberPlan, this.plan.deadline, acquiring.signal)) }
      finally { clearTimeout(acquisitionTimer); this.acquisitions.delete(acquiring) }
      this.pendingLeases.set(memberPlan.memberId, lease)
      let member: Member | undefined
      const initializationTimer = setTimeout(() => this.initializationAbort.abort(new Error('run_initialization_timeout')), initializationDeadline - Date.now())
      try {
        executionAssert(this.state === 'starting', 'run_stopped')
        const client = await this.ports.client(lease.authority, this.context(memberPlan, initializationDeadline, this.initializationAbort.signal))
        executionAssert(client.authority === lease.authority, 'run_lease_not_owned')
        const authority: SessionAuthority = { host: lease.authority, teamId: this.plan.binding.teamId, runId: this.plan.binding.runId,
          laneId: memberPlan.laneId, memberId: memberPlan.memberId, sessionID: memberPlan.originalSessionId,
          agent: memberPlan.profile.selection.agent, model: memberPlan.profile.selection.model }
        const store = await OpenCodeV2AdmissionStore.open(this.plan.dataRoot, authority)
        const session = new OpenCodeV2SessionService(client, store, authority)
        member = { plan: memberPlan, lease, client, authority, store, session, state: 'unknown', bootstrap: null, mcpConnected: false, intents: new Map() }
        this.members.set(memberPlan.memberId, member)
        this.pendingLeases.delete(memberPlan.memberId)
        executionAssert(this.state === 'starting', 'run_stopped')
        await session.reserveSession()
        const created = await session.createSession(memberPlan.title)
        member.state = created.disposition
        await this.persistState()
        executionAssert(created.disposition === 'accepted' && created.session, 'run_original_session_unknown')
        // Actual native persistent context, never a queue/resume:false model
        // turn. There is no published messageID for an instruction entry.
        const value = { context: memberPlan.bootstrap.value, contextHash: memberPlan.bootstrap.contextHash,
          briefingHash: memberPlan.bootstrap.briefingHash, teamId: authority.teamId, runId: authority.runId,
          laneId: authority.laneId, memberId: authority.memberId, originalSessionId: authority.sessionID }
        const before = await this.cut(client, authority.sessionID)
        await client.putInstruction(authority.sessionID, memberPlan.bootstrap.key, value)
        const entries = await client.instructions(authority.sessionID)
        const after = await this.cut(client, authority.sessionID)
        verifyOpenCodeV2SilentBootstrap({ before, after, entries, key: memberPlan.bootstrap.key, value })
        member.bootstrap = { strategy: 'instruction-entry', key: memberPlan.bootstrap.key,
          contextHash: memberPlan.bootstrap.contextHash, briefingHash: memberPlan.bootstrap.briefingHash,
          verified: true, missingNativeMessageID: true }
        await client.connectMcp(memberPlan.controllerMcpName)
        const servers = await client.mcp()
        member.mcpConnected = servers.filter(server => server.name === memberPlan.controllerMcpName && server.status === 'connected').length === 1
        executionAssert(member.mcpConnected, 'run_controller_mcp_unknown')
        member.controllerTools = await readOwnedControllerTools(client, memberPlan.profile, memberPlan.controllerMcpName, initializationDeadline, this.initializationAbort.signal)
        if (this.plan.executionProbe?.memberId === memberPlan.memberId)
          member.probeAuthority = await captureOwnedV2ProbeAuthority(client, this.plan.executionProbe.prepared)
        await this.persistState()
      } catch (failure) {
        // If an object was not yet registered, no lease may escape cleanup.
        if (!member || this.state !== 'starting') {
          const closing = this.closeLease(lease)
          if (member) await boundOpenCodeRead(member.client.dispose(), 2000).catch(() => undefined)
          await closing.then(() => this.pendingLeases.delete(memberPlan.memberId)).catch(() => undefined)
        }
        throw failure
      } finally { clearTimeout(initializationTimer) }
    }
    executionAssert(this.state === 'starting', 'run_stopped')
    this.state = 'active'; await this.persistState()
  }
  async ready(): Promise<void> { await this.initialization }
  private closeLease(lease: ExecutionLease): Promise<ExecutionCleanupReceipt> {
    const existing = this.closing.get(lease)
    if (existing) return existing
    const work = Promise.resolve().then(() => lease.close()).then(receipt => {
      // A returned acknowledgement or same-fields object is not a measured
      // R247 physical retirement receipt. Check the process-owned receipt
      // before serialization and bind it to this exact lease's child birth.
      executionAssert(isExecutionCleanupReceipt(receipt) && receipt.pid === lease.authority.child.pid &&
        executionHash(receipt.birth) === executionHash(lease.authority.child.birth), 'physical_cleanup_unknown')
      return receipt
    })
    this.closing.set(lease, work); void work.catch(() => undefined)
    return work
  }
  /** The response deadline does not abandon a still-live lower cleanup handle.
   * Source retirement joins those exact promises with a fixed orphan grace.
   * Expired grace remains cleanup_unknown; it never releases native ownership. */
  async awaitCleanupTerminal(): Promise<void> {
    executionAssert(this.stopping, 'run_stop_not_requested')
    const remaining = () => Math.max(1, this.cleanupGraceDeadline - Date.now())
    try {
      await boundOpenCodeRead(this.initialization.catch(() => undefined), remaining())
      await boundOpenCodeRead(Promise.allSettled([...this.closing.values()]), remaining())
      await boundOpenCodeRead(Promise.allSettled([...this.active]), remaining())
    } catch {
      this.state = 'cleanup_unknown'
      await boundOpenCodeRead(writeRunControlFile(this.directory, 'orphan.json', { binding: this.plan.binding,
        reason: 'lower_cleanup_terminal_unknown', deadline: this.cleanupGraceDeadline }), remaining()).catch(() => undefined)
      await boundOpenCodeRead(this.persistState(), remaining()).catch(() => undefined)
    }
  }
  private member(request: { memberId: string; originalSessionId: string }): Member {
    const member = this.members.get(request.memberId)
    executionAssert(member && member.authority.sessionID === request.originalSessionId &&
      member.plan.originalSessionId === request.originalSessionId && member.lease.authority === member.client.authority &&
      !member.lease.signal.aborted, 'run_original_session_changed')
    return member
  }
  private async cut(client: ExecutionBridgeClient, id: string): Promise<{ messages: ExecutionMessagePage; log: ExecutionLog }> {
    const before = await client.log(id)
    const messages: ExecutionMessagePage = { data: [], previous: null, next: null }
    const cursors = new Set<string>(); let cursor: string | undefined, complete = false
    for (let page = 0; page < 8; page++) {
      const value = await client.messages(id, cursor)
      messages.data.push(...value.data)
      executionAssert(messages.data.length <= 1600 && new Set(messages.data.map(message => message.id)).size === messages.data.length, 'run_transcript_unknown')
      if (!value.next) { complete = true; break }
      executionAssert(!cursors.has(value.next), 'run_transcript_unknown'); cursors.add(value.next); cursor = value.next
    }
    executionAssert(complete, 'run_transcript_unknown')
    const log = await client.log(id)
    executionAssert(executionHash(before) === executionHash(log), 'run_mutable_cut')
    return { messages, log }
  }
  async execute(request: RunControlRequest, deadline: number): Promise<RunControlResult> {
    request = parseRunControlRequest(structuredClone(request))
    if (request.operation === 'stop') return this.stop()
    if (request.operation === 'status') return { kind: 'status', ...(this.plan.qualification ? { qualification: this.plan.qualification } : {}), state: this.state, deadline: this.plan.deadline, members: this.statuses() }
    executionAssert(this.state === 'active' && Date.now() < this.plan.deadline && deadline > Date.now() &&
      deadline <= this.plan.deadline && deadline - Date.now() <= 30_000, 'run_not_active')
    const member = this.member(request), abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(new Error('run_operation_timeout')), deadline - Date.now())
    this.operations.add(abort)
    const work = this.perform(member, request, deadline, abort.signal)
    this.active.add(work)
    void work.finally(() => {
      clearTimeout(timeout); this.operations.delete(abort); this.active.delete(work)
    }).catch(() => undefined)
    try { return await boundOpenCodeRead(work, deadline - Date.now(), abort.signal) }
    finally { if (Date.now() >= deadline) abort.abort(new Error('run_operation_timeout')) }
  }
  private async perform(member: Member, request: Exclude<RunControlRequest, { operation: 'stop' | 'status' }>, deadline: number, signal: AbortSignal): Promise<RunControlResult> {
    const client = await this.ports.client(member.lease.authority, this.context(member.plan, deadline, signal))
    try {
      executionAssert(client.authority === member.lease.authority && this.state === 'active', 'run_stopped')
      verifyExecutionSession(member.authority, await client.getSession(member.authority.sessionID))
      const id = member.authority.sessionID
      if (request.operation === 'probeEvidence') {
        const probe = this.plan.executionProbe
        executionAssert(probe && probe.memberId === member.plan.memberId && member.probeAuthority, 'probe_not_owned')
        const service = new OpenCodeV2AdmissionService(client, member.store, member.authority)
        const admission = await service.settleOriginalInput(probe.intent)
        const proof = await buildOwnedV2ProbeProof({ client, authority: member.authority, captured: member.probeAuthority,
          intent: probe.intent, admission, expectedText: probe.expectedText, capabilitySnapshotId: probe.capabilitySnapshotId })
        return { kind: 'probeEvidence', proof }
      }
      if (request.operation === 'transcript') return { kind: 'transcript', ...await this.cut(client, id) }
      if (request.operation === 'mcp') return { kind: 'mcp', servers: await client.mcp() }
      if (request.operation === 'permissions') return { kind: 'permissions', requests: await client.permissions(id) }
      if (request.operation === 'permissionReply') {
        const permission = await client.permission(id, request.requestId)
        executionAssert(permission.id === request.requestId && permission.sessionID === id, 'run_permission_changed')
        // Deny-only selected policy cannot be widened by a protocol reply.
        const allowed = permission.resources.length > 0 && permission.resources.every(resource => {
          const matching = member.plan.profile.selection.permissions.filter(rule =>
            (rule.action === '*' || rule.action === permission.action) && (rule.resource === '*' || rule.resource === resource))
          // Conservatively keep every selected deny. Native pattern/ordering
          // semantics have not been widened by this bridge's protocol mapping.
          return matching.length > 0 && matching.every(rule => rule.effect !== 'deny')
        })
        executionAssert(request.decision === 'deny' || allowed, 'run_permission_policy_denied')
        await client.replyPermission(id, request.requestId, request.decision === 'allow' ? 'once' : 'reject')
        // The published reply is void. It does not expose a decision/status
        // readback, so the bridge does not manufacture "granted".
        return { kind: 'permissionReply', status: 'unknown' }
      }
      const admissions = new OpenCodeV2AdmissionService(client, member.store, member.authority)
      let intent: QueueIntent
      if (request.operation === 'send') {
        executionAssert(member.bootstrap?.verified && member.mcpConnected && request.intent.input.resume === true, 'run_bootstrap_unverified')
        const old = member.intents.get(request.intent.identity.nativeInputID)
        executionAssert(!old || executionHash(old) === executionHash(request.intent), 'run_intent_conflict')
        executionAssert(old || member.intents.size < 128, 'run_intent_limit')
        intent = old ?? JSON.parse(canonicalExecutionJSON(request.intent)) as QueueIntent
        member.intents.set(intent.identity.nativeInputID, intent)
        await writeRunControlFile(this.directory, 'intents.json', {
          binding: this.plan.binding, members: [...this.members.values()].map(value => ({ memberId: value.plan.memberId,
            originalSessionId: value.authority.sessionID, intents: [...value.intents.values()] })),
        })
        const snapshot = await member.store.snapshot()
        if (snapshot.slot && snapshot.slot !== intent.identity.requestId &&
            !snapshot.admissions.some(record => record.identity.requestId === intent.identity.requestId)) {
          const previous = [...member.intents.values()].find(value => value.identity.requestId === snapshot.slot)
          executionAssert(previous, 'run_original_input_unknown')
          await admissions.settleOriginalInput(previous)
        }
        executionAssert(this.state === 'active' && !signal.aborted, 'run_stopped')
        const admission = await admissions.admitQueue(intent, true)
        return { kind: 'send', admission, turn: null }
      }
      executionAssert(request.operation === 'observe', 'run_operation_invalid')
      const original = member.intents.get(request.nativeInputID)
      executionAssert(original, 'run_original_input_unknown'); intent = original
      executionAssert(!request.intent || executionHash(request.intent) === executionHash(original), 'run_intent_conflict')
      const admission = await admissions.settleOriginalInput(intent)
      const cut = await this.cut(client, id)
      // Refresh the owned transport schema proof and native connection before publishing effects.
      member.controllerTools = await readOwnedControllerTools(client, member.plan.profile, member.plan.controllerMcpName, deadline, signal)
      const controllerBinding = { teamId: this.plan.binding.teamId, runId: this.plan.binding.runId,
        memberId: member.plan.memberId, sessionID: id }
      const controllerInbox = await readOwnedControllerInbox(member.plan.profile, member.controllerTools,
        controllerBinding, deadline, signal)
      const turn = projectOpenCodeV2Turn({ pin: client.authority.pin, sessionID: id, nativeInputID: intent.identity.nativeInputID,
        beforeCursor: admission.beforeCursor, originalText: intent.input.text, ...cut,
        inboundMessageId: intent.identity.localMessageId, advertisedTools: member.controllerTools.nativeNames,
        controllerBinding, controllerInbox })
      return { kind: 'observe', admission, turn }
    } finally { await client.dispose() }
  }
  stop(): Promise<Extract<RunControlResult, { kind: 'stop' }>> {
    if (this.stopping) return this.stopping
    this.state = 'stopping'; clearTimeout(this.timer)
    this.cleanupGraceDeadline = Date.now() + 60_000
    this.stopping = this.performStop(); return this.stopping
  }
  private async performStop(): Promise<Extract<RunControlResult, { kind: 'stop' }>> {
    const cleanupDeadline = Date.now() + 29_000
    const remaining = (maximum: number) => Math.max(1, Math.min(maximum, cleanupDeadline - Date.now()))
    let durable = true
    try {
      await boundOpenCodeRead(writeRunControlFile(this.directory, 'tombstone.json', { binding: this.plan.binding, stoppedAt: Date.now() }), remaining(2000))
      await boundOpenCodeRead(this.persistState(), remaining(2000))
    }
    catch { durable = false }
    this.initializationAbort.abort(new Error('run_stopped'))
    for (const controller of this.acquisitions) controller.abort(new Error('run_stopped'))
    for (const controller of this.operations) controller.abort(new Error('run_stopped'))
    // Join an acquisition already in flight; it must publish its lease or close
    // it before initialization settles. Do not launch a replacement owner.
    await boundOpenCodeRead(this.initialization.catch(() => undefined), remaining(2000)).catch(() => { durable = false })
    const results = await Promise.all([...this.members.values()].map(async (member): Promise<RunStopMember> => {
      const errors: string[] = [], ids: readonly string[] = await boundOpenCodeRead(member.store.fenceStop(), remaining(2000))
        .catch(() => { errors.push('tombstone_unknown'); return [] })
      let cleanupClient: ExecutionBridgeClient | undefined
      try {
        // Cleanup has its own operation context. It never extends a prompt's
        // deadline or reopens lease/session authority after the run tombstone.
        cleanupClient = await boundOpenCodeRead(this.ports.client(member.lease.authority,
          this.context(member.plan, Math.min(cleanupDeadline, Date.now() + 5000))), remaining(2000))
        const native = cleanupClient, admissions = new OpenCodeV2AdmissionService(native, member.store, member.authority)
        const candidates = ids.map(nativeInputID => ({ nativeInputID, deadline: Date.now() + remaining(2000) }))
        // Read terminal cuts before interrupt can change their native log. Classification
        // and any remaining cancellation share the original per-input deadline.
        const terminal = await Promise.all(candidates.map(async ({ nativeInputID, deadline }) => {
          const original = member.intents.get(nativeInputID)
          const proved = original ? await boundOpenCodeRead(admissions.terminalAfterStop(original), Math.max(1, deadline - Date.now()))
            .catch(() => false) : false
          return proved && Date.now() < deadline
        }))
        const cancellation = await Promise.allSettled([
          ...candidates.filter((_candidate, index) => !terminal[index]).map(async ({ nativeInputID, deadline }) => {
            const budget = deadline - Date.now()
            executionAssert(budget > 0, 'authority_or_deadline')
            await boundOpenCodeRead(native.cancelInbox(member.authority.sessionID, nativeInputID), budget)
          }),
          boundOpenCodeRead(native.interrupt(member.authority.sessionID), remaining(2000)),
        ])
        if (cancellation.some(result => result.status === 'rejected')) errors.push('cancel_or_interrupt_unknown')
      } catch { errors.push('cancel_or_interrupt_unknown') }
      try { await boundOpenCodeRead(Promise.all([member.client.dispose(), ...(cleanupClient ? [cleanupClient.dispose()] : [])]), remaining(2000)) }
      catch { errors.push('readers_unknown') }
      let cleanup: RunStopMember['cleanup'] = null
      try { cleanup = await boundOpenCodeRead(this.closeLease(member.lease), remaining(22_000)) }
      catch { errors.push('physical_cleanup_unknown') }
      if (!durable) errors.push('run_tombstone_unknown')
      return { memberId: member.plan.memberId, cleanup, errors }
    }))
    const pendingCleanup = await Promise.allSettled([...this.pendingLeases].map(async ([memberId, lease]) => {
      await boundOpenCodeRead(this.closeLease(lease), remaining(2000)); this.pendingLeases.delete(memberId)
    }))
    if (pendingCleanup.some(result => result.status === 'rejected') || this.acquisitions.size) durable = false
    await boundOpenCodeRead(Promise.allSettled([...this.active]), remaining(1000)).catch(() => { durable = false })
    this.state = durable && results.length === this.plan.members.length && results.every(result => result.cleanup !== null && result.errors.length === 0) ? 'stopped' : 'cleanup_unknown'
    const receipt: Extract<RunControlResult, { kind: 'stop' }> = { kind: 'stop', state: this.state, members: results }
    try { await boundOpenCodeRead(writeRunControlFile(this.directory, 'stop.json', { binding: this.plan.binding, receipt }), remaining(2000)) }
    catch {
      this.state = 'cleanup_unknown'
      const unknown: Extract<RunControlResult, { kind: 'stop' }> = { ...receipt, state: 'cleanup_unknown' }
      await boundOpenCodeRead(this.persistState(), remaining(2000)).catch(() => undefined)
      this.resolveStopped(unknown); return unknown
    }
    await boundOpenCodeRead(this.persistState(), remaining(2000)).catch(() => undefined)
    this.resolveStopped(receipt)
    return receipt
  }
}

/** Explicit launch alone may spawn. Config/native objects travel over inherited
 * private IPC, never via protocol stdout or a durable authority descriptor. */
export async function launchExplicitOpenCodeV2Run(plan: RunLaunchPlan): Promise<RunControlRecord> {
  plan = structuredClone(plan)
  validateRunLaunchPlan(plan)
  executionAssert(process.platform === 'linux' && process.versions.bun === '1.3.11', 'run_source_linux_bun_required')
  executionAssert(await realpath(plan.source.bunPath) === plan.source.bunPath && sha(await readFile(plan.source.bunPath)) === plan.source.bunSha256, 'run_source_changed')
  const delivery = await resolveOpenCodeV2ExecutionDelivery(import.meta.url, 'run-owner')
  const entry = delivery.entryPath
  executionAssert(plan.members.every(member => member.native.runtimeMode === delivery.runtimeMode) &&
    plan.source.entryPath === entry && delivery.entrySha256 === plan.source.entrySha256, 'run_source_changed')
  for (const file of plan.source.files) executionAssert(await realpath(file.path) === file.path && sha(await readFile(file.path)) === file.sha256, 'run_source_changed')
  executionAssert(plan.source.files.some(file => file.path === entry && file.sha256 === plan.source.entrySha256), 'run_source_incomplete')
  executionAssert(!Object.keys(plan.source.env).some(key => /^(?:NODE_OPTIONS|NODE_PATH|BUN_.*|LD_.*|DYLD_.*|BASH_ENV|ENV|ZDOTDIR|SHELLOPTS)$/i.test(key)), 'run_environment_injection')
  const sourceSha256 = executionHash(plan.source.files)
  const directory = await reserveRunControlDirectory(plan.dataRoot, plan.binding, sourceSha256)
  const child = spawn(plan.source.bunPath, [entry], { detached: true, cwd: plan.dataRoot, env: { ...plan.source.env }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const ready = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new Error('run_owner_unknown')))
    child.once('close', () => reject(new Error('run_owner_unknown')))
    child.on('message', message => {
      if (message && typeof message === 'object' && 'type' in message && message.type === 'ready') resolve()
      if (message && typeof message === 'object' && 'type' in message && message.type === 'failed') reject(new Error('run_owner_unknown'))
    })
  })
  try {
    child.send({ type: 'start', plan, directory, sourceSha256 })
    await boundOpenCodeRead(ready, Math.min(30_000, plan.deadline - Date.now()))
    const record = await discoverOpenCodeV2Run(plan.dataRoot, plan.binding.teamId, plan.binding.runId)
    executionAssert(record && child.pid === record.process.pid && executionHash(record.binding) === executionHash(plan.binding) && record.sourceSha256 === sourceSha256, 'run_owner_unknown')
    child.disconnect(); child.unref(); return record
  } catch (error) {
    // Unknown startup cannot be replayed, reclaimed or PID-killed. The exact
    // launched supervisor owns its bounded deadline and cleanup.
    if (child.connected) child.disconnect(); child.unref(); throw error
  }
}

export async function startOpenCodeV2RunSupervisor(plan: RunLaunchPlan, directory: string, sourceSha256: string): Promise<{ record: RunControlRecord; owner: OpenCodeV2RunOwner; retire(): Promise<void> }> {
  plan = structuredClone(plan)
  validateRunLaunchPlan(plan)
  executionAssert(directory === runControlDirectory(plan.dataRoot, plan.binding.teamId, plan.binding.runId) &&
    executionHash(plan.source.files) === sourceSha256 && process.versions.bun === '1.3.11' &&
    await realpath(process.execPath) === plan.source.bunPath && sha(await readFile(process.execPath)) === plan.source.bunSha256, 'run_source_changed')
  const delivery = await resolveOpenCodeV2ExecutionDelivery(import.meta.url, 'run-owner')
  executionAssert(plan.members.every(member => member.native.runtimeMode === delivery.runtimeMode) &&
    plan.source.entryPath === delivery.entryPath && plan.source.entrySha256 === delivery.entrySha256 &&
    await realpath(process.argv[1]!) === delivery.entryPath, 'run_source_changed')
  for (const file of plan.source.files) executionAssert(await realpath(file.path) === file.path && sha(await readFile(file.path)) === file.sha256, 'run_source_changed')
  let owner: OpenCodeV2RunOwner | undefined
  const control = await serveOpenCodeV2RunControl(directory, plan.binding, plan.deadline, sourceSha256, (request, deadline) => {
    executionAssert(owner, 'run_owner_starting'); return owner.execute(request, deadline)
  })
  try { owner = new OpenCodeV2RunOwner(plan, directory) }
  catch (error) { await control.close(); throw error }
  const owned = owner
  return { record: control.record, owner: owned, retire: async () => { await owned.stop(); await owned.awaitCleanupTerminal(); await control.close() } }
}
