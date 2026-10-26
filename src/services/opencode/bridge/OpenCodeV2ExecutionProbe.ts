import { claimOpenCodeV2FreshProofRequest, hasOpenCodeV2FreshProofClaim } from './OpenCodeV2FreshProofRequest.js'
import { openCodeV2EngineVersion } from '../compatibility/OpenCodeV2Registry.js'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, lstat, writeFile, rename } from 'node:fs/promises'
import * as lockfile from '../../../utils/lockfile.js'
import { parseOpenCodeExecutionProof } from '../OpenCodeExecutionProof.js'
import { normalizeOpenCodeProjectIdentity } from '../OpenCodeProjectIdentity.js'
import { resolveClaudeMultimodelPaths } from '../OpenCodeManagedPaths.js'
import { collectProjectBehaviorMetadata } from '../OpenCodeProfileManager.js'
import { executionAssert, executionHash, executionRecord } from '../execution/OpenCodeV2ExecutionContracts.js'
import { buildOpenCodeV2InternalRunPlan, type inspectOpenCodeV2SourceAvailability } from './OpenCodeV2LaunchPlan.js'
import { launchExplicitOpenCodeV2Run } from './OpenCodeV2RunOwner.js'
import { ensureOpenCodeV2ProbeStore } from './OpenCodeV2ProbeStore.js'
import { OPEN_CODE_V2_RUN_INITIALIZATION_MS, discoverOpenCodeV2Run, awaitOpenCodeV2RunMemberReadiness, requestOpenCodeV2Run, parseRunControlRequest, isTransientOpenCodeV2ControlRead } from './OpenCodeV2RunControl.js'
import type { OpenCodeExecutionProof } from '../types.js'
import type { BridgeEnvelope } from './OpenCodeBridgeProtocol.js'
import type { RunBinding, RunProbeFailure } from './OpenCodeV2RunTypes.js'
import type { QueueIntent } from '../execution/OpenCodeV2AdmissionService.js'

type Selection = Awaited<ReturnType<typeof inspectOpenCodeV2SourceAvailability>>
export type OpenCodeV2ProbeIntent = { sourceKey: string; binding: RunBinding; sessionID: string; intentHash: string }
type ProbeRecord = { sourceKey: string; binding: RunBinding; sessionID: string; intent: QueueIntent;
  submitted: boolean; proof: OpenCodeExecutionProof | null; retired: boolean; failure: RunProbeFailure | null; freshExecutionProofRequestId?: string }
function parseProbeFailure(value: unknown): RunProbeFailure | null {
  if (value === null || value === undefined) return null // Existing records predate this field.
  executionAssert(value === 'native_execution_failed' || value === 'native_execution_cancelled', 'probe_failure_invalid')
  return value
}
const WINDOWS = process.platform === 'win32'
/** `lexicalRoot`: on Windows the configured data root may differ from its real path in letter
 * case or 8.3 names; it is canonicalized once and everything below must match exactly. */
async function privateDirectory(root: string, lexicalRoot = false) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const stat = await lstat(root)
  executionAssert((lexicalRoot && WINDOWS || await realpath(root) === root) && stat.isDirectory() && !stat.isSymbolicLink() &&
    (WINDOWS || stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0), 'probe_store_foreign')
}

function parseRecord(value: unknown): ProbeRecord {
  const row = executionRecord(value), binding = executionRecord(row.binding)
  executionAssert(typeof row.sourceKey === 'string' && typeof row.sessionID === 'string' &&
    typeof row.submitted === 'boolean' && typeof row.retired === 'boolean' &&
    ['teamId', 'runId', 'controllerInstanceId', 'ownerId'].every(key => typeof binding[key] === 'string'), 'probe_store_invalid')
  const typedBinding = { teamId: String(binding.teamId), runId: String(binding.runId),
    controllerInstanceId: String(binding.controllerInstanceId), ownerId: String(binding.ownerId) }
  const request = parseRunControlRequest({ operation: 'send', memberId: 'probe', originalSessionId: row.sessionID, intent: row.intent })
  executionAssert(request.operation === 'send', 'probe_store_invalid')
  const proof = row.proof === null ? null : parseOpenCodeExecutionProof(row.proof)
  executionAssert(row.proof === null || proof, 'probe_store_invalid')
  executionAssert(row.freshExecutionProofRequestId === undefined || typeof row.freshExecutionProofRequestId === 'string' &&
    /^[a-zA-Z0-9._:-]{1,200}$/.test(row.freshExecutionProofRequestId), 'probe_store_invalid')
  const failure = parseProbeFailure(row.failure)
  executionAssert(!failure || row.submitted === true && !proof, 'probe_store_invalid')
  return { sourceKey: row.sourceKey, binding: typedBinding, sessionID: row.sessionID,
    submitted: row.submitted, retired: row.retired, intent: request.intent, proof, failure,
    ...(row.freshExecutionProofRequestId === undefined ? {} : { freshExecutionProofRequestId: row.freshExecutionProofRequestId as string }) }
}

/** Normal readiness protocol. The cached proof is a result of this owned producer,
 * never a public caller proof DTO. UNKNOWN retains the original IDs and only observes. */
export async function resolveOpenCodeV2ExecutionProbe(envelope: BridgeEnvelope, selection: Selection, run: boolean,
  options: { unattendedTeam?: boolean; onPrepared?: (sourceKey: string) => Promise<void>;
    onIntentPersisted?: (value: OpenCodeV2ProbeIntent) => Promise<void>; requireExisting?: OpenCodeV2ProbeIntent;
    freshExecutionProofRequestId?: string } = {}) {
  const freshRequestId = options.freshExecutionProofRequestId
  executionAssert(freshRequestId === undefined || run && !options.requireExisting && typeof freshRequestId === 'string' &&
    /^[a-zA-Z0-9._:-]{1,200}$/.test(freshRequestId), 'probe_fresh_request_invalid')
  const available = (record: ProbeRecord) => freshRequestId !== undefined && record.freshExecutionProofRequestId !== freshRequestId
    ? { state: 'pending' as const, proof: null, reason: 'The original probe settled; the requested fresh proof still requires its own retired-generation admission.' }
    : { state: 'available' as const, proof: record.proof, reason: null }
  const unattendedTeam = options.unattendedTeam === true
  const deadline = Date.now() + Math.max(1, Math.min(envelope.timeoutMs || 120_000, 300_000) - 25_000)
  const assertDeadline = () => executionAssert(Date.now() < deadline, 'execution_timeout')
  const behavior = await collectProjectBehaviorMetadata(selection.project)
  const variant = typeof envelope.body.effort === 'string' ? envelope.body.effort : 'default'
  const sourceKey = executionHash({ project: selection.project, scopeToken: selection.scope.scopeToken, selectedAuthIdentity: selection.scope.selectedAuthIdentity, source: selection.behaviorFingerprint, graph: selection.installedGraphSHA256,
    projectBehavior: behavior.projectBehaviorFingerprint, variant, ...(unattendedTeam ? { unattendedTeam: true } : {}) })
  const requestedDataRoot = path.resolve(resolveClaudeMultimodelPaths().data)
  await options.onPrepared?.(sourceKey)
  assertDeadline()
  let dataRoot: string, directory: string, file: string, guard: string
  {
    const store = await ensureOpenCodeV2ProbeStore(requestedDataRoot)
    dataRoot = store.dataRoot
    directory = path.join(store.probeRoot, sourceKey)
    await privateDirectory(directory)
    file = path.join(directory, 'probe.json'); guard = path.join(directory, 'owner.lock')
    await writeFile(guard, '', { flag: 'ax', mode: 0o600 }).catch((error: unknown) => {
      if (executionRecord(error).code !== 'EEXIST') throw error
    })
    const guardStat = await lstat(guard)
    executionAssert(guardStat.isFile() && !guardStat.isSymbolicLink() && guardStat.nlink === 1 &&
      (WINDOWS || guardStat.uid === process.getuid?.() && (guardStat.mode & 0o077) === 0), 'probe_store_foreign')
  }
  assertDeadline()
  let release: (() => Promise<void>) | undefined
  const save = async (record: ProbeRecord) => {
    assertDeadline()
    const recordBytes = Buffer.from(JSON.stringify(record), 'utf8')
    executionAssert(recordBytes.length > 0 && recordBytes.length < 131072, 'probe_store_invalid')
    const temporary = path.join(directory, `.${randomUUID()}.tmp`)
    await writeFile(temporary, recordBytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, file)
    assertDeadline()
  }
  try {
    release = await lockfile.lock(guard, { retries: { retries: 10, minTimeout: 20, maxTimeout: 200 } })
    assertDeadline()
    let record: ProbeRecord | null = null
    try {
      const stat = await lstat(file)
      executionAssert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
        (WINDOWS || stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0) && stat.size < 128 * 1024, 'probe_store_foreign')
      record = parseRecord(JSON.parse(await readFile(file, 'utf8')))
      assertDeadline()
      if (record) executionAssert(record.sourceKey === sourceKey, 'probe_source_changed')
    } catch (error) { if (executionRecord(error).code !== 'ENOENT') throw error }
    if (options.requireExisting) {
      executionAssert(record && executionHash({ sourceKey, binding: record.binding, sessionID: record.sessionID,
        intentHash: executionHash(record.intent) }) === executionHash(options.requireExisting), 'probe_original_intent_changed')
      if (record.proof && record.retired && Date.parse(record.proof.expiresAt) <= Date.now())
        return { state: 'pending' as const, proof: null, reason: 'The original qualified proof expired; no replacement input was submitted.' }
    }
    if (record?.proof) executionAssert(record.proof.projectPath === normalizeOpenCodeProjectIdentity(selection.project) && record.proof.modelId === `${selection.model.providerID}/${selection.model.id}` &&
      record.proof.capabilitySnapshotId === selection.capabilitySnapshotId && record.proof.opencodeVersion === selection.native.version &&
      record.proof.binaryPath === selection.native.executablePath && record.proof.projectBehaviorFingerprint === behavior.projectBehaviorFingerprint, 'probe_cached_target_changed')
    const freshClaimed = freshRequestId === undefined ? false : await hasOpenCodeV2FreshProofClaim(directory, sourceKey, freshRequestId)
    if (freshClaimed && record?.freshExecutionProofRequestId !== freshRequestId)
      return { state: 'pending' as const, proof: null, reason: 'This fresh request already owns a retained claim; no replacement input was submitted.' }
    if (freshRequestId !== undefined && record?.freshExecutionProofRequestId === freshRequestId && !freshClaimed)
      return { state: 'pending' as const, proof: null, reason: 'The original fresh request claim is unavailable; no replacement input was submitted.' }
    if (freshRequestId !== undefined && record?.proof && record.retired) {
      if (record.freshExecutionProofRequestId !== freshRequestId) record = null
      else if (Date.parse(record.proof.expiresAt) <= Date.now())
        return { state: 'pending' as const, proof: null, reason: 'This fresh request already completed and expired; no replacement input was submitted.' }
    }
    if (record?.proof && record.retired && Date.parse(record.proof.expiresAt) > Date.now()) {
      await options.onIntentPersisted?.({ sourceKey, binding: record.binding, sessionID: record.sessionID, intentHash: executionHash(record.intent) })
      return available(record)
    }
    if (record?.failure && (record.retired || !run)) return { state: 'failed' as const, proof: null,
      reason: record.retired ? record.failure : `${record.failure}; probe_physical_cleanup_unknown` }
    // A retained unresolved attempt never allocates another session or input.
    if (!run) return { state: 'pending' as const, proof: null, reason: record ? 'Original native execution proof is pending or expired.' : 'Selected-model execution proof was not requested.' }
    if (record?.retired && !record.proof) return { state: 'pending' as const, proof: null, reason: 'Original native probe was retired without qualifying terminal evidence.' }
    if (record?.proof && record.retired) record = null // Completed generations may start a fresh normal probe after TTL.
    if (!record) {
      assertDeadline()
      if (freshRequestId !== undefined) {
        executionAssert(!freshClaimed, 'probe_fresh_claim_conflict')
        await claimOpenCodeV2FreshProofRequest(directory, sourceKey, freshRequestId)
        assertDeadline()
      }
      const nonce = randomUUID().replaceAll('-', ''), teamId = `TEST-execution-probe-${nonce}`
      const localClaude = selection.controller.type === 'local' ? selection.controller.environment?.AGENT_TEAMS_MCP_CLAUDE_DIR : undefined
      if (localClaude) {
        // Only new probe-owned exact team/task directories, never another team.
        const localClaudeStat = await lstat(localClaude)
        executionAssert(await realpath(localClaude) === localClaude && localClaudeStat.isDirectory() &&
          !localClaudeStat.isSymbolicLink() && (WINDOWS || localClaudeStat.uid === process.getuid?.()), 'probe_controller_state_foreign')
        for (const kind of ['teams', 'tasks']) {
          const parent = path.join(localClaude, kind)
          await mkdir(parent, { recursive: true, mode: 0o700 })
          const parentStat = await lstat(parent)
          executionAssert(await realpath(parent) === parent && parentStat.isDirectory() &&
            !parentStat.isSymbolicLink() && (WINDOWS || parentStat.uid === process.getuid?.()), 'probe_controller_state_foreign')
          await mkdir(path.join(parent, teamId), { mode: 0o700 })
        }
      }
      const expectedText = `STRICT_LAUNCH_${randomUUID()}`
      const intent: QueueIntent = { identity: { requestId: `probe-${nonce}`, deliveryAttemptId: `probe-${nonce}`,
        localMessageId: `probe-${nonce}`, nativeInputID: `msg_${nonce}` }, delivery: 'queue',
        input: { nativeInputID: `msg_${nonce}`, resume: true, text: `Output only this exact token: ${expectedText}` } }
      const plan = { ...await buildOpenCodeV2InternalRunPlan(selection, { teamId, teamName: teamId, runId: nonce, laneId: 'execution-probe',
        selectedModel: `${selection.model.providerID}/${selection.model.id}`, effort: variant,
        members: [{ name: 'probe', prompt: 'Execute the single selected-model readiness prompt. Do not call controller tools.' }] },
        randomUUID(), { intent, expectedText, unattendedTeam }), deadline }
      assertDeadline()
      const member = plan.members[0]; executionAssert(member, 'probe_plan_invalid')
      record = { sourceKey, binding: plan.binding, sessionID: member.originalSessionId, intent, submitted: false, proof: null, retired: false, failure: null,
        ...(freshRequestId === undefined ? {} : { freshExecutionProofRequestId: freshRequestId }) }
      await save(record) // Original identities precede launch and every prompt effect.
      await options.onIntentPersisted?.({ sourceKey, binding: record.binding, sessionID: record.sessionID, intentHash: executionHash(record.intent) })
      assertDeadline()
      await launchExplicitOpenCodeV2Run(plan)
    } else await options.onIntentPersisted?.({ sourceKey, binding: record.binding, sessionID: record.sessionID, intentHash: executionHash(record.intent) })
    const owner = await discoverOpenCodeV2Run(dataRoot, record.binding.teamId, record.binding.runId)
    assertDeadline()
    if (!owner) return { state: record.failure ? 'failed' as const : 'pending' as const, proof: null,
      reason: record.failure ? `${record.failure}; probe_physical_cleanup_unknown` : 'Original native owner is unavailable; no replay is authorized.' }
    executionAssert(executionHash(owner.binding) === executionHash(record.binding), 'probe_original_owner_changed')
    const retire = async () => {
      const stopped = await requestOpenCodeV2Run(owner, { operation: 'stop' }, Math.max(1, Math.min(30_000, deadline - Date.now())))
      assertDeadline()
      executionAssert(stopped.kind === 'stop' && stopped.state === 'stopped' && stopped.ownerRetired === true &&
        stopped.members.length === 1 && stopped.members[0]?.memberId === 'probe' &&
        stopped.members[0].cleanup !== null && stopped.members[0].errors.length === 0, 'probe_physical_cleanup_unknown')
    }
    const finishFailure = async (original: ProbeRecord) => {
      executionAssert(original.failure && original.submitted && !original.proof, 'probe_store_invalid')
      try { await retire() }
      catch (error) {
        // Only known bounded stop uncertainty is reported as cleanup unknown.
        // Foreign/framing/identity faults and unexpected errors still propagate.
        if (!isTransientOpenCodeV2ControlRead(error) && !(error instanceof Error &&
          ['probe_physical_cleanup_unknown', 'run_control_client_budget_exhausted',
            'run_control_connect_busy_timeout_expired', 'run_control_connect_idle_expired',
            'run_control_connect_no_listener_expired', 'run_deadline_expired',
            'run_operation_unknown', 'run_state_wall_deadline_expired'].includes(error.message))) throw error
        return { state: 'failed' as const, proof: null, reason: `${original.failure}; probe_physical_cleanup_unknown` }
      }
      original.retired = true; await save(original)
      return { state: 'failed' as const, proof: null, reason: original.failure }
    }
    // Retry only the original stop/readback after a persisted failure, never send.
    if (record.failure) return await finishFailure(record)
    if (!record.submitted) {
      const ready = await awaitOpenCodeV2RunMemberReadiness(owner, { memberId: 'probe', originalSessionId: record.sessionID,
        selectedModel: `${selection.model.providerID}/${selection.model.id}`, selectedVariant: variant, pin: openCodeV2EngineVersion(selection.native) },
        Math.max(1, Math.min(OPEN_CODE_V2_RUN_INITIALIZATION_MS, deadline - Date.now())))
      if (!ready) return { state: 'pending' as const, proof: null, reason: 'Original native member is not ready; no input was submitted.' }
      assertDeadline()
      record.submitted = true; await save(record)
      await requestOpenCodeV2Run(owner, { operation: 'send', memberId: 'probe', originalSessionId: record.sessionID, intent: record.intent },
        Math.max(1, Math.min(30_000, deadline - Date.now())))
      assertDeadline()
    }
    while (Date.now() < deadline) {
      const observed = await requestOpenCodeV2Run(owner, { operation: 'probeEvidence', memberId: 'probe', originalSessionId: record.sessionID }, Math.min(10_000, deadline - Date.now()))
      assertDeadline()
      executionAssert(observed.kind === 'probeEvidence', 'probe_observation_unknown')
      const failure = parseProbeFailure(observed.failure)
      executionAssert(!failure || !observed.proof, 'probe_observation_unknown')
      if (failure) {
        executionAssert(record.proof === null, 'probe_observation_unknown')
        record.failure = failure; await save(record) // Failure precedes every stop effect.
        return await finishFailure(record)
      }
      if (observed.proof) {
        await retire()
        record.proof = observed.proof; record.retired = true; await save(record)
        return available(record)
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(300, Math.max(1, deadline - Date.now()))))
    }
    return { state: 'pending' as const, proof: null, reason: 'Original native input has no qualifying terminal; only readback is authorized.' }
  } finally { await release?.() }
}
