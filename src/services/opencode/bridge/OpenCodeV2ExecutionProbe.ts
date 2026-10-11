import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, lstat, writeFile, rename } from 'node:fs/promises'
import * as lockfile from '../../../utils/lockfile.js'
import { parseOpenCodeExecutionProof } from '../OpenCodeExecutionProof.js'
import { resolveClaudeMultimodelPaths } from '../OpenCodeManagedPaths.js'
import { collectProjectBehaviorMetadata } from '../OpenCodeProfileManager.js'
import { executionAssert, executionHash, executionRecord } from '../execution/OpenCodeV2ExecutionContracts.js'
import { buildOpenCodeV2InternalRunPlan, type inspectOpenCodeV2SourceAvailability } from './OpenCodeV2LaunchPlan.js'
import { launchExplicitOpenCodeV2Run } from './OpenCodeV2RunOwner.js'
import { OPEN_CODE_V2_RUN_INITIALIZATION_MS, discoverOpenCodeV2Run, awaitOpenCodeV2RunMemberReadiness, requestOpenCodeV2Run, parseRunControlRequest } from './OpenCodeV2RunControl.js'
import type { OpenCodeExecutionProof } from '../types.js'
import type { BridgeEnvelope } from './OpenCodeBridgeProtocol.js'
import type { RunBinding } from './OpenCodeV2RunTypes.js'
import type { QueueIntent } from '../execution/OpenCodeV2AdmissionService.js'

type Selection = Awaited<ReturnType<typeof inspectOpenCodeV2SourceAvailability>>
type ProbeRecord = { sourceKey: string; binding: RunBinding; sessionID: string; intent: QueueIntent;
  submitted: boolean; proof: OpenCodeExecutionProof | null; retired: boolean }
async function privateDirectory(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const stat = await lstat(root)
  executionAssert(await realpath(root) === root && stat.isDirectory() && !stat.isSymbolicLink() &&
    stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0, 'probe_store_foreign')
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
  return { sourceKey: row.sourceKey, binding: typedBinding, sessionID: row.sessionID,
    submitted: row.submitted, retired: row.retired, intent: request.intent, proof }
}

/** Normal readiness protocol. The cached proof is a result of this owned producer,
 * never a public caller proof DTO. UNKNOWN retains the original IDs and only observes. */
export async function resolveOpenCodeV2ExecutionProbe(envelope: BridgeEnvelope, selection: Selection, run: boolean,
  options: { unattendedTeam?: boolean } = {}) {
  const unattendedTeam = options.unattendedTeam === true
  const behavior = await collectProjectBehaviorMetadata(selection.project)
  const variant = typeof envelope.body.effort === 'string' ? envelope.body.effort : 'default'
  const sourceKey = executionHash({ project: selection.project, scopeToken: selection.scope.scopeToken, selectedAuthIdentity: selection.scope.selectedAuthIdentity, source: selection.behaviorFingerprint, graph: selection.installedGraphSHA256,
    projectBehavior: behavior.projectBehaviorFingerprint, variant, ...(unattendedTeam ? { unattendedTeam: true } : {}) })
  const requestedDataRoot = path.resolve(resolveClaudeMultimodelPaths().data)
  await privateDirectory(requestedDataRoot)
  const dataRoot = await realpath(requestedDataRoot)
  const directory = path.join(dataRoot, 'opencode/v2/execution-probes', sourceKey)
  await privateDirectory(directory)
  const file = path.join(directory, 'probe.json'), guard = path.join(directory, 'owner.lock')
  await writeFile(guard, '', { flag: 'ax', mode: 0o600 }).catch((error: unknown) => {
    if (executionRecord(error).code !== 'EEXIST') throw error
  })
  const guardStat = await lstat(guard)
  executionAssert(guardStat.isFile() && !guardStat.isSymbolicLink() && guardStat.nlink === 1 &&
    guardStat.uid === process.getuid?.() && (guardStat.mode & 0o077) === 0, 'probe_store_foreign')
  const release = await lockfile.lock(guard, { retries: { retries: 10, minTimeout: 20, maxTimeout: 200 } })
  const save = async (record: ProbeRecord) => {
    const temporary = path.join(directory, `.${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); await rename(temporary, file)
  }
  try {
    let record: ProbeRecord | null = null
    try {
      const stat = await lstat(file)
      executionAssert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid?.() &&
        (stat.mode & 0o077) === 0 && stat.size < 128 * 1024, 'probe_store_foreign')
      record = parseRecord(JSON.parse(await readFile(file, 'utf8')))
      executionAssert(record.sourceKey === sourceKey, 'probe_source_changed')
    } catch (error) { if (executionRecord(error).code !== 'ENOENT') throw error }
    if (record?.proof) executionAssert(record.proof.projectPath === selection.project && record.proof.modelId === `${selection.model.providerID}/${selection.model.id}` &&
      record.proof.capabilitySnapshotId === selection.capabilitySnapshotId && record.proof.opencodeVersion === selection.native.version &&
      record.proof.binaryPath === selection.native.executablePath && record.proof.projectBehaviorFingerprint === behavior.projectBehaviorFingerprint, 'probe_cached_target_changed')
    if (record?.proof && record.retired && Date.parse(record.proof.expiresAt) > Date.now())
      return { state: 'available' as const, proof: record.proof, reason: null }
    // A retained unresolved attempt never allocates another session or input.
    if (!run) return { state: 'pending' as const, proof: null, reason: record ? 'Original native execution proof is pending or expired.' : 'Selected-model execution proof was not requested.' }
    if (record?.retired && !record.proof) return { state: 'pending' as const, proof: null, reason: 'Original native probe was retired without qualifying terminal evidence.' }
    if (record?.proof && record.retired) record = null // Completed generations may start a fresh normal probe after TTL.
    if (!record) {
      const nonce = randomUUID().replaceAll('-', ''), teamId = `TEST-execution-probe-${nonce}`
      const localClaude = selection.controller.type === 'local' ? selection.controller.environment?.AGENT_TEAMS_MCP_CLAUDE_DIR : undefined
      if (localClaude) {
        // Only new probe-owned exact team/task directories, never another team.
        executionAssert(await realpath(localClaude) === localClaude && (await lstat(localClaude)).uid === process.getuid?.(), 'probe_controller_state_foreign')
        for (const kind of ['teams', 'tasks']) {
          const parent = path.join(localClaude, kind)
          await mkdir(parent, { recursive: true, mode: 0o700 })
          executionAssert(await realpath(parent) === parent && (await lstat(parent)).uid === process.getuid?.(), 'probe_controller_state_foreign')
          await mkdir(path.join(parent, teamId), { mode: 0o700 })
        }
      }
      const expectedText = `STRICT_LAUNCH_${randomUUID()}`
      const intent: QueueIntent = { identity: { requestId: `probe-${nonce}`, deliveryAttemptId: `probe-${nonce}`,
        localMessageId: `probe-${nonce}`, nativeInputID: `msg_${nonce}` }, delivery: 'queue',
        input: { nativeInputID: `msg_${nonce}`, resume: true, text: `Output only this exact token: ${expectedText}` } }
      const plan = await buildOpenCodeV2InternalRunPlan(selection, { teamId, teamName: teamId, runId: nonce, laneId: 'execution-probe',
        selectedModel: `${selection.model.providerID}/${selection.model.id}`, effort: variant,
        members: [{ name: 'probe', prompt: 'Execute the single selected-model readiness prompt. Do not call controller tools.' }] },
        randomUUID(), { intent, expectedText, unattendedTeam })
      const member = plan.members[0]; executionAssert(member, 'probe_plan_invalid')
      record = { sourceKey, binding: plan.binding, sessionID: member.originalSessionId, intent, submitted: false, proof: null, retired: false }
      await save(record) // Original identities precede launch and every prompt effect.
      await launchExplicitOpenCodeV2Run(plan)
    }
    const owner = await discoverOpenCodeV2Run(dataRoot, record.binding.teamId, record.binding.runId)
    if (!owner) return { state: 'pending' as const, proof: null, reason: 'Original native owner is unavailable; no replay is authorized.' }
    executionAssert(executionHash(owner.binding) === executionHash(record.binding), 'probe_original_owner_changed')
    const deadline = Date.now() + Math.max(1, Math.min(envelope.timeoutMs || 120_000, 300_000) - 25_000)
    if (!record.submitted) {
      const ready = await awaitOpenCodeV2RunMemberReadiness(owner, { memberId: 'probe', originalSessionId: record.sessionID,
        selectedModel: `${selection.model.providerID}/${selection.model.id}`, selectedVariant: variant, pin: selection.native.version },
        Math.max(1, Math.min(OPEN_CODE_V2_RUN_INITIALIZATION_MS, deadline - Date.now())))
      if (!ready) return { state: 'pending' as const, proof: null, reason: 'Original native member is not ready; no input was submitted.' }
      record.submitted = true; await save(record)
      await requestOpenCodeV2Run(owner, { operation: 'send', memberId: 'probe', originalSessionId: record.sessionID, intent: record.intent }, 30_000)
    }
    while (Date.now() < deadline) {
      const observed = await requestOpenCodeV2Run(owner, { operation: 'probeEvidence', memberId: 'probe', originalSessionId: record.sessionID }, Math.min(10_000, deadline - Date.now()))
      executionAssert(observed.kind === 'probeEvidence', 'probe_observation_unknown')
      if (observed.proof) {
        const stopped = await requestOpenCodeV2Run(owner, { operation: 'stop' }, 30_000)
        executionAssert(stopped.kind === 'stop' && stopped.state === 'stopped' && stopped.ownerRetired === true &&
          stopped.members.length === 1 && stopped.members[0]?.memberId === 'probe' &&
          stopped.members[0].cleanup !== null && stopped.members[0].errors.length === 0, 'probe_physical_cleanup_unknown')
        record.proof = observed.proof; record.retired = true; await save(record)
        return { state: 'available' as const, proof: record.proof, reason: null }
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(300, Math.max(1, deadline - Date.now()))))
    }
    return { state: 'pending' as const, proof: null, reason: 'Original native input has no qualifying terminal; only readback is authorized.' }
  } finally { await release() }
}
