import path from 'node:path'
import { canonicalizeOpenCodeProjectPath } from '../OpenCodeProfileManager.js'
import { readOpenCodeAuthority, isKnownSessionStore, requireOpenCodeAuthority, type SessionStoreShape } from '../OpenCodeAuthorityStoreRead.js'
import { OpenCodeVersionProbeCleanupError } from '../compatibility/OpenCodeVersionProbe.js'
import { classifyOpenCodeV2ExecutionDelivery } from '../host/OpenCodeV2ExecutionDelivery.js'
import { isExecutionPlatformAvailable } from '../host/OpenCodeV2ExecutionPlatform.js'
import { resolveOpenCodeBinaryHostIdentity } from '../OpenCodeHostIdentity.js'
import { resolveOpenCodeV2ExecutionProbe } from './OpenCodeV2ExecutionProbe.js'
import { parseOpenCodeBridgePreconditions, validateOpenCodeBridgeStateChangingPreconditions } from '../OpenCodeBridgePreconditions.js'
import type { RunQualification } from './OpenCodeV2RunTypes.js'
import { createOpenCodeV2LaunchPlan, inspectOpenCodeV2SourceAvailability } from './OpenCodeV2LaunchPlan.js'
import { createBridgeServerIdentity } from '../OpenCodeBridgeCommandHandler.js'
import { SUPPORTED_COMMANDS } from './OpenCodeBridgeProtocol.js'
import { createHash } from 'node:crypto'
import type { QueueIntent } from '../execution/OpenCodeV2AdmissionService.js'
import { assertIntentIdentity, executionAssert, executionHash } from '../execution/OpenCodeV2ExecutionContracts.js'
import { resolveClaudeMultimodelPaths } from '../OpenCodeManagedPaths.js'
import type { OpenCodeDeliveryResponseObservation } from '../OpenCodeDeliveryResponseObserver.js'
import type { OpenCodeNormalizedPermission } from '../types.js'
import { parseOpenCodeStopRequest, type OpenCodeStopData } from '../OpenCodeStopRecovery.js'
import { openCodeDeliveryJournalRecoveryData, commandStatusFromOutcomeStatus, isAcceptedOutcomeStatus, commandStatusMismatchReason, outcomeSendMessageDataToCommandData, type SendMessageOutcomeBase, type SendMessageCommandData } from './OpenCodeBridgeDeliveryJournal.js'
import { OpenCodeV2DeliveryJournal } from './OpenCodeV2DeliveryJournal.js'
import { discoverOpenCodeV2Run, requestOpenCodeV2Run, isTransientOpenCodeV2ControlRead } from './OpenCodeV2RunControl.js'
import { launchExplicitOpenCodeV2Run } from './OpenCodeV2RunOwner.js'
import type { RunBinding, RunControlRecord, RunControlRequest, RunControlResult, RunLaunchPlan } from './OpenCodeV2RunTypes.js'
import type { OpenCodeV2TurnProjection } from './OpenCodeV2TurnProjection.js'
import { normalizeV2Transcript } from './OpenCodeV2TranscriptProjection.js'
import { boundOpenCodeRead } from '../transport/OpenCodeBoundedFetch.js'
import { parseOpenCodePromptFileParts, validateEnvelope, type BridgeEnvelope } from './OpenCodeBridgeProtocol.js'
import { OPENCODE_V2_TEAM_BRIDGE_CAPABILITIES, inspectOpenCodeRuntimeAdapterSelection, selectOpenCodeRuntimeAdapter } from './OpenCodeRuntimeAdapterFactory.js'

export type OpenCodeV2RunControlPorts = Readonly<{
  discover: typeof discoverOpenCodeV2Run
  request: typeof requestOpenCodeV2Run
  launch: typeof launchExplicitOpenCodeV2Run
}>
const productionControl: OpenCodeV2RunControlPorts = {
  discover: discoverOpenCodeV2Run, request: requestOpenCodeV2Run, launch: launchExplicitOpenCodeV2Run,
}
const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null
const required = (value: unknown, name: string): string => {
  const result = text(value); executionAssert(result, `missing_${name}`); return result
}

/** A CLI holds only run control identity. Lease/client/native endpoint objects stay in their owning process. */
export class OpenCodeV2TeamBridge {
  private readonly journal: OpenCodeV2DeliveryJournal
  constructor(private readonly dataRoot: string, private readonly binding: Pick<RunBinding, 'teamId' | 'runId'>,
    private readonly ports: OpenCodeV2RunControlPorts = productionControl) {
    this.journal = new OpenCodeV2DeliveryJournal(dataRoot)
  }

  queryOutcome(input: Parameters<OpenCodeV2DeliveryJournal['query']>[0], timeoutMs = 30_000) {
    executionAssert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000, 'invalid_operation_deadline')
    return boundOpenCodeRead(this.journal.query(input), timeoutMs)
  }

  async discover(): Promise<RunControlRecord | null> {
    return this.ports.discover(this.dataRoot, this.binding.teamId, this.binding.runId)
  }
  async launchExplicit(plan: RunLaunchPlan): Promise<RunControlRecord> {
    executionAssert(plan.dataRoot === this.dataRoot && plan.binding.teamId === this.binding.teamId &&
      plan.binding.runId === this.binding.runId, 'run_binding_conflict')
    executionAssert(await this.discover() === null, 'run_already_owned')
    return this.ports.launch(plan)
  }
  async call(request: RunControlRequest, timeoutMs: number): Promise<RunControlResult> {
    executionAssert(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000, 'invalid_operation_deadline')
    const deadline = Date.now() + timeoutMs
    const record = await this.discover()
    executionAssert(record && record.binding.teamId === this.binding.teamId &&
      record.binding.runId === this.binding.runId, 'run_owner_unknown')
    // Read only the same authenticated owner; transient transport loss never replays an operation.
    if (request.operation === 'status') {
      for (;;) {
        const remaining = deadline - Date.now(); executionAssert(remaining > 0, 'operation_timeout')
        try {
          const result = await this.ports.request(record, request, Math.min(5000, remaining))
          executionAssert(Date.now() < deadline, 'operation_timeout'); return result
        } catch (error) {
          if (!isTransientOpenCodeV2ControlRead(error) || Date.now() >= deadline) throw error
          await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
        }
      }
    }
    // A stale observation or stop never enters launchExplicit or acquires a host.
    const controlOnly = request.operation === 'stop'
    const remaining = deadline - Date.now(); executionAssert(remaining > 0, 'operation_timeout')
    return this.ports.request(record, request, controlOnly ? remaining
      : Math.min(remaining, Math.max(1, record.deadline - Date.now())))
  }
  async resolveMember(memberId: string, laneId: string | null, expectedSessionId: string | null, timeoutMs: number) {
    const status = await this.call({ operation: 'status' }, timeoutMs)
    executionAssert(status.kind === 'status' && status.qualification !== undefined && status.state === 'active' && status.deadline > Date.now(), 'run_stopped_or_unknown')
    const matches = status.members.filter(member => member.memberId === memberId && (!laneId || member.laneId === laneId))
    executionAssert(matches.length === 1, 'member_authority_ambiguous')
    const member = matches[0]
    executionAssert(member && member.state === 'accepted' && (!expectedSessionId || expectedSessionId === member.originalSessionId),
      'original_session_changed')
    executionAssert(member.opencodeSessionId === member.originalSessionId && member.runtimeSessionId === member.originalSessionId,
      'original_session_changed')
    return member
  }
  async send(request: Extract<RunControlRequest, { operation: 'send' }>,
    base: SendMessageOutcomeBase, timeoutMs: number): Promise<SendMessageCommandData> {
    request = structuredClone(request); base = structuredClone(base)
    executionAssert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000, 'invalid_operation_deadline')
    const deadline = Date.now() + timeoutMs
    const remaining = () => { const budget = deadline - Date.now(); executionAssert(budget > 0, 'operation_timeout'); return budget }
    executionAssert(request.operation === 'send', 'invalid_operation')
    const identity = request.intent.identity
    assertIntentIdentity(identity)
    executionAssert(base.teamId === this.binding.teamId && base.runId === this.binding.runId &&
      base.memberName === request.memberId && base.requestId === identity.requestId &&
      base.body.deliveryAttemptId === identity.deliveryAttemptId && base.body.messageId === identity.localMessageId,
    'delivery_identity_conflict')
    const claim = await boundOpenCodeRead(this.journal.reserve(base, request.originalSessionId, identity, executionHash(request.intent)), remaining())
    // A retained submitting/UNKNOWN owner is read-only. Carry the immutable
    // intent for conflict checking, never invoke another admission/send.
    const generation = claim.submissionOwner ? { submissionOwner: claim.submissionOwner } : {}
    const result = await this.call(claim.action === 'submit' ? { ...request, ...generation } : { operation: 'observe', memberId: request.memberId,
      originalSessionId: request.originalSessionId, nativeInputID: identity.nativeInputID, intent: request.intent, ...generation }, remaining())
    if (result.kind === 'send_refused') return boundOpenCodeRead(
      this.journal.refuse(base, request.originalSessionId, request.intent, result, claim.submissionOwner), remaining())
    executionAssert((result.kind === 'send' || result.kind === 'observe') && result.admission.authority.sessionID === request.originalSessionId &&
      result.admission.authority.teamId === base.teamId && result.admission.authority.runId === base.runId &&
      result.admission.authority.memberId === base.memberName && result.admission.authority.laneId === base.laneId &&
      executionHash(result.admission.identity) === executionHash(identity), 'original_input_conflict')
    return boundOpenCodeRead(this.journal.commit(base, request.originalSessionId, identity, result,
      projectV2DeliveryObservation(result.turn, identity.nativeInputID, identity.localMessageId)), remaining())
  }

  commitObservation(result: Extract<RunControlResult, { kind: 'send' | 'observe' }>, body: Record<string, unknown>, timeoutMs: number) {
    executionAssert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30_000, 'invalid_operation_deadline')
    executionAssert(result.admission.authority.teamId === this.binding.teamId &&
      result.admission.authority.runId === this.binding.runId, 'original_input_conflict')
    return boundOpenCodeRead(this.journal.commitObservation(result, body, projectV2DeliveryObservation(result.turn,
      result.admission.identity.nativeInputID, result.admission.identity.localMessageId)), timeoutMs)
  }
}

export function projectV2DeliveryObservation(turn: OpenCodeV2TurnProjection | null,
  nativeInputID: string, inboundMessageId: string): OpenCodeDeliveryResponseObservation {
  const reply = turn?.visibleReplies.find(item => item.nativeInputId === nativeInputID &&
    item.inboundMessageId === inboundMessageId && turn.assistantMessageIds.includes(item.assistantMessageId) &&
    turn.toolEffects.some(effect => effect.kind === 'visible_message' && effect.toolName === item.toolName &&
      effect.toolCallId === item.toolCallId && effect.assistantMessageId === item.assistantMessageId))
  const terminal = turn !== null && ['succeeded', 'failed', 'cancelled'].includes(turn.state)
  return {
    state: terminal && reply ? 'responded_visible_message' : turn?.state === 'failed' ? 'session_error'
      : turn?.state === 'succeeded' && turn.toolEffects.some(effect => effect.kind === 'task') ? 'responded_non_visible_tool'
      : turn?.state === 'succeeded' && turn.text ? 'responded_plain_text' : 'pending',
    deliveredUserMessageId: nativeInputID,
    assistantMessageId: terminal ? reply?.assistantMessageId ?? turn?.assistantMessageIds.at(-1) ?? null : null,
    toolCallNames: terminal ? [...new Set(turn?.toolEffects.map(effect => effect.toolName) ?? [])] : [],
    visibleMessageToolCallId: terminal ? reply?.toolCallId ?? null : null,
    visibleReplyMessageId: terminal ? reply?.visibleReplyMessageId ?? null : null,
    visibleReplyCorrelation: terminal && reply ? 'relayOfMessageId' : null,
    latestAssistantPreview: terminal ? turn?.text.slice(0, 500) || null : null,
    reason: turn?.reason ?? 'native_terminal_not_observed',
  }
}

/** Immutable per-delivery native identity; recovery never allocates a successor. */
export function createV2ProtocolQueueIntent(envelope: BridgeEnvelope): QueueIntent {
  const body = envelope.body
  executionAssert(body.noReply !== true && body.system === undefined, 'unsupported_v1_input')
  const parts = parseOpenCodePromptFileParts(body.fileParts ?? body.parts)
  const files = parts.map(part => {
    executionAssert(part.type === 'file', 'invalid_file_part')
    return { uri: part.url, name: part.filename }
  })
  const identity = {
    requestId: envelope.requestId,
    deliveryAttemptId: required(body.deliveryAttemptId, 'deliveryAttemptId'),
    localMessageId: required(body.messageId, 'messageId'),
    nativeInputID: '',
  }
  identity.nativeInputID = `msg_${createHash('sha256').update(JSON.stringify({
    teamId: body.teamId ?? body.teamName, runId: body.runId, laneId: body.laneId, memberName: body.memberName,
    requestId: identity.requestId, deliveryAttemptId: identity.deliveryAttemptId, localMessageId: identity.localMessageId,
  })).digest('hex')}`
  assertIntentIdentity(identity)
  return { identity, input: { nativeInputID: identity.nativeInputID, text: required(body.text, 'text'), resume: true,
    ...(files.length > 0 ? { files } : {}) }, delivery: 'queue' }
}

export function resolveOpenCodeV2RunBinding(body: Record<string, unknown>): { teamId: string; runId: string } | null {
  const teamId = text(body.teamId ?? body.teamName), runId = text(body.runId ?? body.expectedRunId)
  executionAssert(body.runId === undefined || body.expectedRunId === undefined || body.runId === body.expectedRunId, 'run_identity_conflict')
  return teamId && runId ? { teamId, runId } : null
}

function response(envelope: BridgeEnvelope, started: number, data: unknown, pin: string | null, qualification?: RunQualification) {
  return { ok: true, schemaVersion: 1, requestId: envelope.requestId, command: envelope.command,
    completedAt: new Date().toISOString(), durationMs: Math.max(0, Date.now() - started),
    runtime: { providerId: 'opencode', binaryPath: qualification?.binaryPath ?? null, binaryFingerprint: qualification?.binaryFingerprint ?? (pin ? `version:${pin}` : null),
      version: qualification?.version ?? pin, capabilitySnapshotId: qualification?.capabilitySnapshotId ?? null }, diagnostics: [], data }
}
function refusal(envelope: BridgeEnvelope, started: number, message: string) {
  return { ok: false, schemaVersion: 1, requestId: envelope.requestId, command: envelope.command,
    completedAt: new Date().toISOString(), durationMs: Math.max(0, Date.now() - started),
    error: { kind: 'runtime_not_ready', message, retryable: false }, diagnostics: [] }
}

/** Runtime source qualification is derived from the exact private owner and measured member evidence.
 * Exported product defaults remain false; caller booleans cannot activate these capabilities. */
export function openCodeV2SupportedSourcePredicate(status: Extract<RunControlResult, { kind: 'status' }>): boolean {
  try { classifyOpenCodeV2ExecutionDelivery(import.meta.url) } catch { return false }
  return isExecutionPlatformAvailable() && process.versions.bun === '1.3.11' &&
    status.qualification !== undefined && status.state === 'active' && status.deadline > Date.now() && status.members.length > 0 &&
    status.members.every(member => ['2.0.0', '2.0.21'].includes(member.pin) && member.state === 'accepted' &&
      member.originalSessionId === member.opencodeSessionId && member.originalSessionId === member.runtimeSessionId &&
      member.bootstrap?.verified === true && member.bootstrap.strategy === 'instruction-entry' &&
      member.bootstrap.missingNativeMessageID === true && member.controllerTools?.server === 'agent-teams' &&
      member.controllerTools.nativeNames.length > 0 && /^[a-f0-9]{64}$/.test(member.controllerTools.schemasHash))
}

function projectV2TeamStatus(status: Extract<RunControlResult, { kind: 'status' }>, runId: string) {
  const qualified = openCodeV2SupportedSourcePredicate(status)
  return { runId, teamLaunchState: qualified ? 'launching' : status.state === 'starting' || status.state === 'active' ? 'launching' : 'failed',
    members: Object.fromEntries(status.members.map(member => [member.memberId, {
      sessionId: member.originalSessionId, launchState: member.state === 'accepted' && member.bootstrap?.verified && member.controllerTools ? 'confirmed_alive' : member.state === 'accepted' || status.state === 'starting' && member.state === 'unknown' ? 'created' : 'failed',
      ...(member.runtimePid === undefined ? {} : { runtimePid: member.runtimePid }),
      model: member.selectedModel, bootstrap: member.bootstrap ? { ...member.bootstrap, nativeMessageID: null, sessionId: member.originalSessionId } : null,
      evidence: member.bootstrap?.verified && member.controllerTools ? [{ kind: 'member_session_recorded' },
        { kind: 'app_managed_bootstrap_context_injected', strategy: 'instruction-entry', nativeMessageID: null, contextHash: member.bootstrap.contextHash, briefingHash: member.bootstrap.briefingHash },
        { kind: 'bootstrap_confirmed', strategy: 'instruction-entry' }, { kind: 'member_ready', schemasHash: member.controllerTools.schemasHash }] : [],
      diagnostics: [],
    }])), warnings: [], diagnostics: [], manifestHighWatermark: null, runtimeStoreManifestHighWatermark: null,
    durableCheckpoints: [] }
}

async function executeV2(envelope: BridgeEnvelope, pin: string | null, bridge: OpenCodeV2TeamBridge | null) {
  const started = Date.now()
  const body: Record<string, unknown> = { ...envelope.body, runId: envelope.body.runId ?? envelope.body.expectedRunId }
  envelope = { ...envelope, body }
  let measured: RunQualification | undefined
  let originalStatus: Extract<RunControlResult, { kind: 'status' }> | undefined
  let acceptedIdempotencyKey: string | undefined
  const respond = (env: BridgeEnvelope, at: number, data: unknown, version: string | null) => response(env, at,
    acceptedIdempotencyKey && data !== null && typeof data === 'object' && !Array.isArray(data)
      ? { ...data, idempotencyKey: acceptedIdempotencyKey } : data, version, measured)
  if (envelope.command === 'opencode.answerPermission')
    return refusal(envelope, started, 'Native permission reply has no declared decision readback; permission capability remains false.')
  try {
    if (envelope.command === 'opencode.launchTeam') {
      executionAssert(bridge, 'run_identity_missing')
      const plan = await createOpenCodeV2LaunchPlan(envelope)
      measured = plan.qualification
      acceptedIdempotencyKey = parseOpenCodeBridgePreconditions(body.preconditions)?.idempotencyKey
      await bridge.launchExplicit(plan)
      const status = await bridge.call({ operation: 'status' }, 30_000)
      executionAssert(status.kind === 'status', 'run_status_unknown')
      return respond(envelope, started, { ...projectV2TeamStatus(status, plan.binding.runId), expectedBehaviorFingerprint: measured?.expectedBehaviorFingerprint }, pin)
    }
    if (envelope.command === 'opencode.readiness' || envelope.command === 'opencode.handshake') {
      let owner: Extract<RunControlResult, { kind: 'status' }> | null = null
      if (bridge && await bridge.discover()) {
        const found = await bridge.call({ operation: 'status' }, 8000)
        executionAssert(found.kind === 'status', 'run_status_unknown'); owner = found
      }
      if (owner && envelope.command === 'opencode.handshake') {
        // Cleanup and observation remain available after current login, CLI or
        // controller selection changes. Only the authenticated original owner joins.
        executionAssert(owner.qualification && owner.members.length > 0, 'run_original_qualification_missing')
        if (body.selectedModel !== undefined) executionAssert(owner.members.every(member => member.selectedModel === body.selectedModel), 'run_selected_model_changed')
        measured = owner.qualification
        const originalIdentity = createBridgeServerIdentity(null, { runtimeStoreManifestHighWatermark: null })
        originalIdentity.runtime.capabilitySnapshotId = measured.capabilitySnapshotId
        originalIdentity.runtime.binaryPath = measured.binaryPath
        originalIdentity.runtime.binaryFingerprint = measured.binaryFingerprint
        originalIdentity.runtime.version = measured.version
        originalIdentity.featureFlags.opencodeStateChangingCommands = true
        const originalHandshake = { schemaVersion: 1, requestId: envelope.requestId, client: body.client ?? originalIdentity,
          server: originalIdentity, agreedProtocolVersion: 1,
          acceptedCommands: SUPPORTED_COMMANDS.filter(command => command !== 'opencode.stopOutcome' && command !== 'opencode.reconcileStop'),
          serverTime: new Date().toISOString(),
          sourceCapabilities: { teamLaunch: false, memberSession: openCodeV2SupportedSourcePredicate(owner), permission: false },
          expectedBehaviorFingerprint: measured.expectedBehaviorFingerprint }
        return respond(envelope, started, { ...originalHandshake, identityHash: executionHash(originalHandshake) }, measured.version)
      }
      const ownerModel = owner?.members[0]?.selectedModel
      const selection = await inspectOpenCodeV2SourceAvailability({ ...envelope,
        body: { ...body, selectedModel: body.selectedModel ?? ownerModel } })
      if (owner) executionAssert(owner.members.every(member => member.selectedModel === `${selection.model.providerID}/${selection.model.id}`), 'run_selected_model_changed')
      const qualified = owner !== null && openCodeV2SupportedSourcePredicate(owner)
      const sourceCapabilities = { teamLaunch: true, memberSession: qualified, permission: false }
      const probe = await resolveOpenCodeV2ExecutionProbe(envelope, selection, envelope.command === 'opencode.readiness' && body.requireExecutionProbe === true, { unattendedTeam: true })
      measured = owner?.qualification ?? { capabilitySnapshotId: selection.capabilitySnapshotId,
        expectedBehaviorFingerprint: probe.proof?.expectedBehaviorEvidence.expectedBehaviorFingerprint ?? '',
        binaryPath: probe.proof?.binaryPath ?? selection.native.executablePath,
        binaryFingerprint: probe.proof?.binaryFingerprint ?? await resolveOpenCodeBinaryHostIdentity(selection.native.executablePath),
        version: probe.proof?.opencodeVersion ?? selection.native.version }

      if (envelope.command === 'opencode.readiness') return respond(envelope, started, {
        state: probe.proof ? 'ready' : 'model_unavailable', launchAllowed: probe.proof !== null, modelId: `${selection.model.providerID}/${selection.model.id}`,
        availableModels: [], opencodeVersion: selection.native.version, binaryPath: selection.native.executablePath,
        hostHealthy: qualified, appMcpConnected: qualified, requiredToolsPresent: qualified, permissionBridgeReady: false,
        runtimeStoresReady: owner !== null, supportLevel: qualified ? 'source_linux' : null,
        missing: probe.proof ? [] : [probe.reason ?? 'Selected-model native execution proof is required.'],
        diagnostics: ['Source availability is verified. No execution proof is claimed until the normal owned native probe observes the original terminal and physical cleanup.'],
        executionProof: probe.proof, expectedBehaviorEvidence: probe.proof?.expectedBehaviorEvidence ?? null,
        expectedBehaviorFingerprint: probe.proof?.expectedBehaviorEvidence.expectedBehaviorFingerprint ?? null, capabilitySnapshotId: selection.capabilitySnapshotId,
        sourceAvailability: { installedGraphSHA256: selection.installedGraphSHA256, installedGraphFiles: selection.installedGraphFiles, sourceOnly: true },
        sourceCapabilities, ...(owner ? { team: projectV2TeamStatus(owner, required(body.runId, 'runId')) } : {}) }, selection.native.version)
      const identity = createBridgeServerIdentity(null, { runtimeStoreManifestHighWatermark: typeof body.expectedManifestHighWatermark === 'number' ? body.expectedManifestHighWatermark : null })
      identity.runtime.capabilitySnapshotId = measured.capabilitySnapshotId
      identity.runtime.binaryPath = measured.binaryPath
      identity.runtime.binaryFingerprint = measured.binaryFingerprint
      identity.runtime.version = measured.version
      identity.featureFlags.opencodeTeamLaunch = true; identity.featureFlags.opencodeStateChangingCommands = true
      const handshake = { schemaVersion: 1, requestId: envelope.requestId, client: body.client ?? identity, server: identity,
        agreedProtocolVersion: 1, acceptedCommands: SUPPORTED_COMMANDS.filter(command => command !== 'opencode.stopOutcome' && command !== 'opencode.reconcileStop'),
        serverTime: new Date().toISOString(), sourceCapabilities,
        expectedBehaviorFingerprint: probe.proof?.expectedBehaviorEvidence.expectedBehaviorFingerprint ?? null, identityHash: '' }
      const { identityHash: omittedIdentityHash, ...unsignedHandshake } = handshake
      void omittedIdentityHash
      handshake.identityHash = executionHash(unsignedHandshake)
      return respond(envelope, started, handshake, selection.native.version)
    }
    const timeout = Math.min(envelope.timeoutMs || 8000, 30_000)
    const operationDeadline = Date.now() + timeout
    const remaining = () => {
      const budget = operationDeadline - Date.now(); executionAssert(budget > 0, 'operation_timeout'); return budget
    }
    if (bridge && await bridge.discover()) {
      const original = await bridge.call({ operation: 'status' }, remaining())
      executionAssert(original.kind === 'status', 'run_status_unknown'); measured = original.qualification; originalStatus = original
      if (body.preconditions !== undefined) {
        executionAssert(measured, 'run_original_qualification_missing')
        const accepted = validateOpenCodeBridgeStateChangingPreconditions({ body, runtime: {
          capabilitySnapshotId: measured.capabilitySnapshotId, runtimeStoreManifestHighWatermark: null } })
        executionAssert(parseOpenCodeBridgePreconditions(body.preconditions)?.expectedBehaviorFingerprint === measured.expectedBehaviorFingerprint, 'run_original_behavior_changed')
        acceptedIdempotencyKey = accepted.idempotencyKey
      }
    }
    // App-owned read-only journal commands survive a missing/crashed owner.
    // They neither acquire a lease nor reconstruct native execution authority.
    if (envelope.command === 'opencode.recoverDeliveryJournal')
      return respond(envelope, started, openCodeDeliveryJournalRecoveryData(), pin)
    if (envelope.command === 'opencode.commandStatus') {
      const input = { requestId: text(body.originalRequestId ?? body.requestId), deliveryAttemptId: text(body.deliveryAttemptId) }
      const query = bridge ? await bridge.queryOutcome(input, remaining())
        : await boundOpenCodeRead(new OpenCodeV2DeliveryJournal(resolveClaudeMultimodelPaths().data).query(input), remaining())
      const record = query.record
      if (!record) return respond(envelope, started, { status: 'unknown', safeToRetry: false,
        accepted: false, diagnostics: query.diagnostics }, pin)
      const mismatch = commandStatusMismatchReason(record, body)
      if (mismatch) return respond(envelope, started, { status: 'precondition_mismatch', safeToRetry: false,
        accepted: false, diagnostics: [mismatch] }, pin)
      const status = commandStatusFromOutcomeStatus(record.status), accepted = isAcceptedOutcomeStatus(status)
      return respond(envelope, started, { status, accepted, safeToRetry: accepted ? false : record.safeToRetry,
        originalRequestId: record.requestId, deliveryAttemptId: record.deliveryAttemptId,
        sessionId: record.sessionId, runtimePromptMessageId: record.runtimePromptMessageId,
        sendMessageData: outcomeSendMessageDataToCommandData(record.sendMessageData), diagnostics: record.diagnostics }, pin)
    }
    if (!bridge) return refusal(envelope, started, 'Exact V2 run owner is unknown; observation/stop cannot replace it.')
    let request: RunControlRequest
    if (envelope.command === 'opencode.listRuntimePermissions' && !text(body.memberName)) {
      const status = await bridge.call({ operation: 'status' }, remaining())
      executionAssert(status.kind === 'status' && status.state === 'active', 'run_owner_unknown')
      const members = status.members.filter(member => (!text(body.laneId) || member.laneId === body.laneId) &&
        (!text(body.sessionId) || member.originalSessionId === body.sessionId))
      const permissions: OpenCodeNormalizedPermission[] = []
      for (const member of members) {
        const found = await bridge.call({ operation: 'permissions', memberId: member.memberId,
          originalSessionId: member.originalSessionId }, remaining())
        executionAssert(found.kind === 'permissions', 'permission_observation_unknown')
        for (const item of found.requests) permissions.push({ requestId: item.id, sessionId: item.sessionID,
          tool: item.source?.type === 'tool' ? item.action : null, title: item.action, kind: 'ask', raw: { ...item } })
      }
      return respond(envelope, started, { permissions }, pin)
    }
    switch (envelope.command) {
      case 'opencode.reconcileTeam': request = { operation: 'status' }; break
      case 'opencode.stopTeam': {
        if (body.stopRecovery !== undefined) {
          const recovery = parseOpenCodeStopRequest(body.stopRecovery)
          const status = await bridge.call({ operation: 'status' }, remaining())
          executionAssert(status.kind === 'status' && recovery.target.teamId === (body.teamId ?? body.teamName) &&
            recovery.target.runId === body.runId && recovery.target.laneId === body.laneId &&
            recovery.target.projectPath === (body.projectPath ?? envelope.cwd) &&
            recovery.target.members.length === status.members.length && recovery.target.members.every(original =>
              status.members.some(member => member.memberId === original.memberName && member.originalSessionId === original.sessionId &&
                member.laneId === recovery.target.laneId)), 'stop_original_target_changed')
        }
        request = { operation: 'stop' }; break
      }
      case 'opencode.sendMessage': {
        const status = await bridge.call({ operation: 'status' }, remaining())
        executionAssert(status.kind === 'status' && openCodeV2SupportedSourcePredicate(status), 'run_source_unqualified')
        const memberId = required(body.memberName, 'memberName')
        const member = await bridge.resolveMember(memberId, text(body.laneId), text(body.runtimeSessionId ?? body.sessionId), remaining())
        const originalSessionId = member.originalSessionId
        const data = await bridge.send({ operation: 'send', memberId, originalSessionId,
          intent: createV2ProtocolQueueIntent(envelope) }, {
          requestId: envelope.requestId, body, teamId: required(body.teamId ?? body.teamName, 'teamId'),
          teamName: text(body.teamName) ?? required(body.teamId, 'teamId'), laneId: required(body.laneId, 'laneId'),
          memberName: memberId, projectPath: text(body.projectPath) ?? envelope.cwd, runId: required(body.runId, 'runId'),
        }, remaining())
        return respond(envelope, started, data, pin)
      }
      case 'opencode.observeMessageDelivery': {
        const memberId = required(body.memberName, 'memberName')
        const member = await bridge.resolveMember(memberId, text(body.laneId), text(body.runtimeSessionId ?? body.sessionId), remaining())
        let nativeInputID = text(body.runtimePromptMessageId)
        if (!nativeInputID) {
          const query = await bridge.queryOutcome({ requestId: text(body.originalRequestId),
            deliveryAttemptId: text(body.deliveryAttemptId) }, remaining())
          const retained = query.record
          executionAssert(query.diagnostics.length === 0 && retained && retained.teamId === (body.teamId ?? body.teamName) &&
            retained.runId === body.runId && retained.memberName === memberId && retained.laneId === member.laneId &&
            retained.sessionId === member.originalSessionId && retained.messageId === body.messageId,
          'original_input_unknown')
          nativeInputID = retained.runtimePromptMessageId
        }
        executionAssert(nativeInputID, 'original_input_unknown')
        request = { operation: 'observe', memberId, originalSessionId: member.originalSessionId, nativeInputID }; break
      }
      case 'opencode.listRuntimePermissions': case 'opencode.getRuntimeTranscript': {
        const memberId = required(body.memberName, 'memberName')
        const member = await bridge.resolveMember(memberId, text(body.laneId), text(body.runtimeSessionId ?? body.sessionId), remaining())
        request = { operation: envelope.command === 'opencode.listRuntimePermissions' ? 'permissions' : 'transcript',
          memberId, originalSessionId: member.originalSessionId }
        break
      }
      default: return refusal(envelope, started, 'V2 bridge does not qualify this command; no V1 fallback is permitted.')
    }
    remaining() // Reused status never bypasses the caller's absolute expiry.
    const result = envelope.command === 'opencode.reconcileTeam' && originalStatus
      ? originalStatus : await bridge.call(request, remaining())
    if (result.kind === 'observe') {
      executionAssert(request.operation === 'observe' && result.admission.authority.sessionID === request.originalSessionId &&
        result.admission.authority.memberId === request.memberId && result.admission.authority.teamId === (body.teamId ?? body.teamName) &&
        result.admission.authority.runId === body.runId && result.admission.identity.nativeInputID === request.nativeInputID &&
        result.admission.identity.localMessageId === required(body.messageId, 'messageId'), 'original_input_conflict')
      const recorded = await bridge.commitObservation(result, body, remaining())
      return respond(envelope, started, {
        observed: result.turn !== null && result.turn.state !== 'unknown', sessionId: result.admission.authority.sessionID,
        memberName: result.admission.authority.memberId, runtimePromptMessageId: result.admission.identity.nativeInputID,
        responseObservation: recorded.responseObservation, diagnostics: [],
      }, pin)
    }
    if (result.kind === 'permissions') {
      const permissions: OpenCodeNormalizedPermission[] = result.requests.map(item => ({ requestId: item.id,
        sessionId: item.sessionID, tool: item.source?.type === 'tool' ? item.action : null,
        title: item.action, kind: 'ask', raw: { ...item } }))
      return respond(envelope, started, { permissions }, pin)
    }
    if (result.kind === 'permissionReply') {
      if (result.status !== 'applied') return refusal(envelope, started, 'Native permission decision is unknown; no grant was confirmed.')
      const status = await bridge.call({ operation: 'status' }, remaining())
      executionAssert(status.kind === 'status', 'run_status_unknown')
      return respond(envelope, started, projectV2TeamStatus(status, required(body.runId, 'runId')), pin)
    }
    if (result.kind === 'status') return respond(envelope, started,
      projectV2TeamStatus(result, required(body.runId, 'runId')), pin)
    if (result.kind === 'stop') {
      const data: OpenCodeStopData = { runId: required(body.runId, 'runId'), stopped: result.state === 'stopped' && result.ownerRetired === true,
        members: Object.fromEntries(result.members.map(member => {
          const originalMember = originalStatus?.members.find(value => value.memberId === member.memberId)
          executionAssert(originalMember, 'run_original_member_missing')
          return [member.memberId, { sessionId: originalMember.originalSessionId,
          stopped: member.cleanup !== null && member.errors.length === 0 && result.ownerRetired === true, diagnostics: [...member.errors],
        }] })), warnings: [], diagnostics: result.state === 'stopped' && result.ownerRetired === true ? [] : [{ code: 'opencode_v2_cleanup_unknown',
          severity: 'warning', message: 'Physical cleanup remains unverified; retained tombstones forbid send/relaunch.' }],
        manifestHighWatermark: null, runtimeStoreManifestHighWatermark: null }
      return respond(envelope, started, data, pin)
    }
    if (result.kind === 'transcript') {
      executionAssert(request.operation === 'transcript', 'transcript_authority_conflict')
      return respond(envelope, started, normalizeV2Transcript(result, request.originalSessionId), pin)
    }
    return respond(envelope, started, result, pin)
  } catch (error) { return refusal(envelope, started, error instanceof Error ? error.message : 'V2 bridge operation unknown') }
}

// Recovery follows persisted original ownership even if the installed CLI changes.
// A missing or unreadable V2 launch fence is never converted into legacy authority.
async function ownsLegacyRecovery(envelope: BridgeEnvelope, binding: { teamId: string; runId?: string }): Promise<boolean> {
  const read = await readOpenCodeAuthority<SessionStoreShape>(path.join(resolveClaudeMultimodelPaths().data, 'opencode/session-store.json'), isKnownSessionStore)
  const store = requireOpenCodeAuthority<SessionStoreShape>(read, 'session', () => ({ schemaVersion: 1 as const, records: {} }))
  const recovery = envelope.body.stopRecovery === undefined ? null : parseOpenCodeStopRequest(envelope.body.stopRecovery).target
  const laneId = text(envelope.body.laneId) ?? recovery?.laneId ?? 'primary'
  const projectPath = await canonicalizeOpenCodeProjectPath(envelope.cwd)
  const matches = async (target: { teamId: string; runId?: string; projectPath: string; laneId?: string }) =>
    target.teamId === binding.teamId && Boolean(text(target.runId)) &&
    (binding.runId === undefined || target.runId === binding.runId) && (target.laneId ?? 'primary') === laneId &&
    await canonicalizeOpenCodeProjectPath(target.projectPath) === projectPath
  for (const [key, record] of Object.entries(store.records)) {
    if (key === `${record.teamId}::${record.laneId ?? 'primary'}::${record.memberName}` && await matches(record)) return true
  }
  for (const receipt of Object.values(store.stopReceipts ?? {})) if (await matches(receipt.request.target)) return true
  return false
}
const legacyRecoveryCommands = new Set([
  'opencode.stopTeam', 'opencode.stopOutcome', 'opencode.reconcileStop',
  'opencode.commandStatus',
])

/** Public protocol1 routing. The existing V1 executor is passed unchanged. */
export async function executeSelectedOpenCodeBridgeCommandEnvelope(input: unknown,
  executeV1: (input: unknown) => Promise<unknown>): Promise<unknown> {
  let envelope: BridgeEnvelope
  try { envelope = validateEnvelope(input) } catch { return executeV1(input) }
  let binding: ReturnType<typeof resolveOpenCodeV2RunBinding>
  try {
    const recovery = envelope.body.stopRecovery === undefined ? null : parseOpenCodeStopRequest(envelope.body.stopRecovery).target
    binding = resolveOpenCodeV2RunBinding(envelope.body)
    if (recovery) {
      executionAssert(!binding || (binding.teamId === recovery.teamId && binding.runId === recovery.runId), 'run_identity_conflict')
      binding ??= { teamId: recovery.teamId, runId: recovery.runId }
    }
  }
  catch (error) { return refusal(envelope, Date.now(), error instanceof Error ? error.message : 'run_identity_conflict') }
  // Startup maintenance owns only the persisted legacy host registry, not a selected native runtime.
  if (envelope.command === 'opencode.cleanupStartupHosts') {
    if (envelope.body.runId !== undefined || envelope.body.expectedRunId !== undefined)
      return refusal(envelope, Date.now(), 'Startup host registry cleanup cannot target a V2 run owner.')
    return executeV1(input)
  }
  const bridge = binding ? new OpenCodeV2TeamBridge(resolveClaudeMultimodelPaths().data, binding) : null
  if (bridge && isExecutionPlatformAvailable() && process.getuid) {
    try { if (await bridge.discover()) return executeV2(envelope, null, bridge) }
    catch (error) {
      if (envelope.command === 'opencode.commandStatus' || envelope.command === 'opencode.recoverDeliveryJournal')
        return executeV2(envelope, null, bridge)
      return refusal(envelope, Date.now(), error instanceof Error ? error.message : 'run_owner_unknown')
    }
  }
  // This command touches only the legacy registry and never creates a host.
  if (envelope.command === 'opencode.cleanupHosts') return executeV1(input)
  const recoveryHandshake = envelope.command === 'opencode.handshake' &&
    ['opencode.stopOutcome', 'opencode.reconcileStop'].includes(text(envelope.body.requiredCommand) ?? '')
  // Recovery negotiation identifies a legacy lane, but grants no run or launch authority.
  const legacyBinding = binding ?? (recoveryHandshake && text(envelope.body.teamId ?? envelope.body.teamName) && text(envelope.body.laneId)
    ? { teamId: required(envelope.body.teamId ?? envelope.body.teamName, 'teamId') } : null)
  if (legacyBinding && (legacyRecoveryCommands.has(envelope.command) || recoveryHandshake)) {
    try { if (await ownsLegacyRecovery(envelope, legacyBinding)) return executeV1(input) }
    catch (error) { return refusal(envelope, Date.now(), error instanceof Error ? error.message : 'legacy_owner_unknown') }
  }
  let selection: Awaited<ReturnType<typeof inspectOpenCodeRuntimeAdapterSelection>>
  try { selection = await inspectOpenCodeRuntimeAdapterSelection() }
  catch (error) {
    const result = refusal(envelope, Date.now(), error instanceof Error ? error.message : 'selection_unavailable')
    return error instanceof OpenCodeVersionProbeCleanupError && error.helperFailure
      ? { ...result, diagnostics: [{ code: 'opencode_version_probe_helper_failed', ...error.helperFailure }] } : result
  }
  const selected = selectOpenCodeRuntimeAdapter(selection.policy, {
    v1: () => () => executeV1(input),
    v2: pin => () => executeV2(envelope, pin, bridge),
  })
  if (selected.generation === 'unsupported')
    return refusal(envelope, Date.now(), 'Selected OpenCode generation is unsupported; capabilities remain false.')
  return selected.adapter()
}

export { OPENCODE_V2_TEAM_BRIDGE_CAPABILITIES }
