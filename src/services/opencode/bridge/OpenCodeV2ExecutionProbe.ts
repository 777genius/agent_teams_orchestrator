import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, lstat, writeFile, rename } from 'node:fs/promises'
import * as lockfile from '../../../utils/lockfile.js'
import { parseOpenCodeExecutionProof } from '../OpenCodeExecutionProof.js'
import { normalizeOpenCodeProjectIdentity } from '../OpenCodeProjectIdentity.js'
import { resolveClaudeMultimodelPaths } from '../OpenCodeManagedPaths.js'
import { ensureWindowsPrivateDirectories } from '../profile/OpenCodePrivateDirectories.js'
import { collectProjectBehaviorMetadata } from '../OpenCodeProfileManager.js'
import { executionAssert, executionHash, executionRecord } from '../execution/OpenCodeV2ExecutionContracts.js'
import { createWindowsNativeBroker, resolveWindowsNativeArtifact } from '../host/windows/OpenCodeV2WindowsNativeBroker.js'
import { createWindowsOwnerFilesystem, type WindowsOwnerDirectory } from '../host/windows/OpenCodeV2WindowsOwnerFilesystem.js'
import { buildOpenCodeV2InternalRunPlan, type inspectOpenCodeV2SourceAvailability } from './OpenCodeV2LaunchPlan.js'
import { launchExplicitOpenCodeV2Run } from './OpenCodeV2RunOwner.js'
import { OPEN_CODE_V2_RUN_INITIALIZATION_MS, discoverOpenCodeV2Run, awaitOpenCodeV2RunMemberReadiness, requestOpenCodeV2Run, parseRunControlRequest, isTransientOpenCodeV2ControlRead } from './OpenCodeV2RunControl.js'
import type { OpenCodeExecutionProof } from '../types.js'
import type { BridgeEnvelope } from './OpenCodeBridgeProtocol.js'
import type { RunBinding, RunProbeFailure } from './OpenCodeV2RunTypes.js'
import type { QueueIntent } from '../execution/OpenCodeV2AdmissionService.js'

type Selection = Awaited<ReturnType<typeof inspectOpenCodeV2SourceAvailability>>
type ProbeRecord = { sourceKey: string; binding: RunBinding; sessionID: string; intent: QueueIntent;
  submitted: boolean; proof: OpenCodeExecutionProof | null; retired: boolean; failure: RunProbeFailure | null }
type WindowsProbeStore = Readonly<{
  directory: string; guard: string; file: string
  assertDirectories(deadline?: number): Promise<void>; ensureGuard(deadline: number): Promise<void>
  readRecord(deadline: number): Promise<ProbeRecord | null>; save(record: ProbeRecord, deadline: number): Promise<void>
  close(): Promise<void>
}>
function parseProbeFailure(value: unknown): RunProbeFailure | null {
  if (value === null || value === undefined) return null // Existing records predate this field.
  executionAssert(value === 'native_execution_failed' || value === 'native_execution_cancelled', 'probe_failure_invalid')
  return value
}
async function privateDirectory(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const stat = await lstat(root)
  executionAssert(await realpath(root) === root && stat.isDirectory() && !stat.isSymbolicLink() &&
    stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0, 'probe_store_foreign')
}

type ProbeStoreRole = 'data_parent' | 'data_root' | 'opencode' | 'v2' | 'execution_probes' | 'source'
function probeStoreRole(candidate: string, dataRoot: string, directory: string): ProbeStoreRole {
  return candidate === path.dirname(dataRoot) ? 'data_parent' : candidate === dataRoot ? 'data_root'
    : candidate === path.join(dataRoot, 'opencode') ? 'opencode'
    : candidate === path.join(dataRoot, 'opencode/v2') ? 'v2' : candidate === directory ? 'source' : 'execution_probes'
}
/** Names which store directory has a foreign DACL owner with one closed role.
 * The error object is kept; only its exact owner-mismatch message changes. */
function labelProbeStoreOwnerFailure(error: unknown, role: ProbeStoreRole): unknown {
  const match = error instanceof Error && /^execution_owner_not_private:private_acl_owner(?:_op_prepare_directory|_op_assert_directory)?:(0|[1-9][0-9]{0,9})$/.exec(error.message)
  if (match) (error as Error).message = `execution_owner_not_private:private_acl_owner_probe_store_${role}:${match[1]}`
  return error
}

async function openWindowsProbeStore(dataRoot: string, sourceKey: string, deadline: number): Promise<WindowsProbeStore> {
  executionAssert(Date.now() < deadline, 'execution_timeout')
  const broker = createWindowsNativeBroker(await resolveWindowsNativeArtifact())
  broker.events.on('error', () => {})
  const filesystem = createWindowsOwnerFilesystem((request, deadline, signal) =>
    broker.request(request.op, request, deadline, signal))
  const directory = path.join(dataRoot, 'opencode/v2/execution-probes', sourceKey)
  // The managed data root can be freshly allocated below an existing
  // %LOCALAPPDATA% anchor. That ambient parent is ancestry, never a private
  // producer root. Allocate it privately only when positively absent, then let
  // native qualification of dataRoot hold and check either parent form.
  const intermediateParent = path.dirname(dataRoot)
  const chain = [...new Set([intermediateParent, dataRoot, path.join(dataRoot, 'opencode'),
    path.join(dataRoot, 'opencode/v2'), path.join(dataRoot, 'opencode/v2/execution-probes'), directory])]
  const held: WindowsOwnerDirectory[] = []
  const storeRoots: WindowsOwnerDirectory[] = []
  try {
    for (const candidate of chain) {
      const stat = await lstat(candidate).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (stat) {
        executionAssert(stat.isDirectory() && !stat.isSymbolicLink(), 'probe_store_foreign')
        if (candidate === intermediateParent) continue
      }
      // Store directories never archive. Retain the preparatory capability so
      // sibling launch-plan brokers can verify these same pinned ancestors.
      // Missing paths still create exclusively; uncertain results never adopt.
      try {
        held.push(await filesystem.prepareDirectory(candidate, !stat, deadline))
        await held.at(-1)!.assertOwned(deadline)
      } catch (error) { throw labelProbeStoreOwnerFailure(error, probeStoreRole(candidate, dataRoot, directory)) }
      if (candidate === path.dirname(directory) || candidate === directory) storeRoots.push(held.at(-1)!)
    }
    const guard = path.join(directory, 'owner.lock'), file = path.join(directory, 'probe.json')
    const assertDirectories = async (deadline?: number) => {
      // Launch adds metadata-only member grants to shared data ancestors. Their
      // initial private qualification and retained handles remain in force;
      // native held() rechecks the complete physical ancestry on each store
      // assertion. The probe root and source leaf still require private ACLs.
      for (const root of storeRoots) await root.assertOwned(deadline)
      if (deadline !== undefined) executionAssert(Date.now() < deadline, 'execution_timeout')
    }
    return Object.freeze({
      directory, guard, file,
      assertDirectories,
      async ensureGuard(deadline: number) {
        await assertDirectories(deadline)
        await held.at(-1)!.writeMetadata('ProbeGuard', null, deadline)
        const metadata = await held.at(-1)!.readMetadata('ProbeGuard', deadline)
        executionAssert(metadata.path === guard && metadata.bytes === 0 && metadata.fileIdentity !== null, 'probe_store_foreign')
        await assertDirectories(deadline)
      },
      async readRecord(deadline: number) {
        await assertDirectories(deadline)
        const metadata = await held.at(-1)!.readMetadata('ProbeRecord', deadline)
        await assertDirectories(deadline)
        if (metadata.absent === true) return null
        executionAssert(metadata.value, 'probe_store_invalid')
        return parseRecord(metadata.value)
      },
      async save(record: ProbeRecord, deadline: number) {
        await assertDirectories(deadline)
        await held.at(-1)!.writeMetadata('ProbeRecord', record, deadline)
        await assertDirectories(deadline)
        const metadata = await held.at(-1)!.readMetadata('ProbeRecord', deadline)
        executionAssert(!metadata.absent && metadata.value && executionHash(metadata.value) === executionHash(record), 'probe_store_invalid')
        await assertDirectories(deadline)
      },
      async close() {
        const closed = await Promise.allSettled(held.splice(0).map(root => root.close()))
        const errors = closed.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        try { await broker.close() } catch (error) { errors.push(error) }
        if (errors.length) throw Object.assign(new AggregateError(errors, 'cleanup_unknown', { cause: errors[0] }),
          { cleanupBoundary: 'probe_store_close', primaryFailure: false })
      },
    })
  } catch (error) {
    const closed = await Promise.allSettled(held.splice(0).map(root => root.close()))
    const errors = closed.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    try { await broker.close() } catch (failure) { errors.push(failure) }
    if (errors.length) throw Object.assign(new AggregateError([error, ...errors], 'cleanup_unknown', { cause: error }),
      { cleanupBoundary: 'probe_store_open', primaryFailure: true })
    throw error
  }
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
  const failure = parseProbeFailure(row.failure)
  executionAssert(!failure || row.submitted === true && !proof, 'probe_store_invalid')
  return { sourceKey: row.sourceKey, binding: typedBinding, sessionID: row.sessionID,
    submitted: row.submitted, retired: row.retired, intent: request.intent, proof, failure }
}

/** Normal readiness protocol. The cached proof is a result of this owned producer,
 * never a public caller proof DTO. UNKNOWN retains the original IDs and only observes. */
export async function resolveOpenCodeV2ExecutionProbe(envelope: BridgeEnvelope, selection: Selection, run: boolean,
  options: { unattendedTeam?: boolean } = {}) {
  const unattendedTeam = options.unattendedTeam === true
  const deadline = Date.now() + Math.max(1, Math.min(envelope.timeoutMs || 120_000, 300_000) - 25_000)
  const assertDeadline = () => executionAssert(Date.now() < deadline, 'execution_timeout')
  const behavior = await collectProjectBehaviorMetadata(selection.project)
  const variant = typeof envelope.body.effort === 'string' ? envelope.body.effort : 'default'
  const sourceKey = executionHash({ project: selection.project, scopeToken: selection.scope.scopeToken, selectedAuthIdentity: selection.scope.selectedAuthIdentity, source: selection.behaviorFingerprint, graph: selection.installedGraphSHA256,
    projectBehavior: behavior.projectBehaviorFingerprint, variant, ...(unattendedTeam ? { unattendedTeam: true } : {}) })
  const requestedDataRoot = path.resolve(resolveClaudeMultimodelPaths().data)
  assertDeadline()
  const windowsStore = process.platform === 'win32' ? await openWindowsProbeStore(requestedDataRoot, sourceKey, deadline) : undefined
  let dataRoot: string, directory: string, file: string, guard: string
  if (windowsStore) {
    dataRoot = requestedDataRoot; directory = windowsStore.directory; file = windowsStore.file; guard = windowsStore.guard
  } else {
    await privateDirectory(requestedDataRoot)
    dataRoot = await realpath(requestedDataRoot)
    directory = path.join(dataRoot, 'opencode/v2/execution-probes', sourceKey)
    await privateDirectory(directory)
    file = path.join(directory, 'probe.json'); guard = path.join(directory, 'owner.lock')
    await writeFile(guard, '', { flag: 'ax', mode: 0o600 }).catch((error: unknown) => {
      if (executionRecord(error).code !== 'EEXIST') throw error
    })
    const guardStat = await lstat(guard)
    executionAssert(guardStat.isFile() && !guardStat.isSymbolicLink() && guardStat.nlink === 1 &&
      guardStat.uid === process.getuid?.() && (guardStat.mode & 0o077) === 0, 'probe_store_foreign')
  }
  if (windowsStore) {
    try { await windowsStore.ensureGuard(deadline); assertDeadline() }
    catch (error) {
      try { await windowsStore.close() }
      catch (failure) { throw Object.assign(new AggregateError([error, failure], 'cleanup_unknown', { cause: error }),
        { cleanupBoundary: 'probe_guard_close', primaryFailure: true }) }
      throw error
    }
  } else assertDeadline()
  let release: (() => Promise<void>) | undefined
  const save = async (record: ProbeRecord) => {
    assertDeadline()
    const recordBytes = Buffer.from(JSON.stringify(record), 'utf8')
    executionAssert(recordBytes.length > 0 && recordBytes.length < 131072, 'probe_store_invalid')
    if (windowsStore) return windowsStore.save(record, deadline)
    const temporary = path.join(directory, `.${randomUUID()}.tmp`)
    await writeFile(temporary, recordBytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, file)
    assertDeadline()
  }
  let primary: unknown, failed = false
  try {
    release = await lockfile.lock(guard, { retries: { retries: 10, minTimeout: 20, maxTimeout: 200 } })
    assertDeadline()
    let record: ProbeRecord | null = null
    try {
      if (windowsStore) record = await windowsStore.readRecord(deadline)
      else {
        const stat = await lstat(file)
        executionAssert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid?.() &&
          (stat.mode & 0o077) === 0 && stat.size < 128 * 1024, 'probe_store_foreign')
        record = parseRecord(JSON.parse(await readFile(file, 'utf8')))
      }
      assertDeadline()
      if (record) executionAssert(record.sourceKey === sourceKey, 'probe_source_changed')
    } catch (error) { if (executionRecord(error).code !== 'ENOENT') throw error }
    if (record?.proof) executionAssert(record.proof.projectPath === normalizeOpenCodeProjectIdentity(selection.project) && record.proof.modelId === `${selection.model.providerID}/${selection.model.id}` &&
      record.proof.capabilitySnapshotId === selection.capabilitySnapshotId && record.proof.opencodeVersion === selection.native.version &&
      record.proof.binaryPath === selection.native.executablePath && record.proof.projectBehaviorFingerprint === behavior.projectBehaviorFingerprint, 'probe_cached_target_changed')
    if (record?.proof && record.retired && Date.parse(record.proof.expiresAt) > Date.now())
      return { state: 'available' as const, proof: record.proof, reason: null }
    if (record?.failure && (record.retired || !run)) return { state: 'failed' as const, proof: null,
      reason: record.retired ? record.failure : `${record.failure}; probe_physical_cleanup_unknown` }
    // A retained unresolved attempt never allocates another session or input.
    if (!run) return { state: 'pending' as const, proof: null, reason: record ? 'Original native execution proof is pending or expired.' : 'Selected-model execution proof was not requested.' }
    if (record?.retired && !record.proof) return { state: 'pending' as const, proof: null, reason: 'Original native probe was retired without qualifying terminal evidence.' }
    if (record?.proof && record.retired) record = null // Completed generations may start a fresh normal probe after TTL.
    if (!record) {
      assertDeadline()
      const nonce = randomUUID().replaceAll('-', ''), teamId = `TEST-execution-probe-${nonce}`
      const localClaude = selection.controller.type === 'local' ? selection.controller.environment?.AGENT_TEAMS_MCP_CLAUDE_DIR : undefined
      if (localClaude) {
        // Only new probe-owned exact team/task directories, never another team.
        const localClaudeStat = await lstat(localClaude)
        executionAssert(await realpath(localClaude) === localClaude && localClaudeStat.isDirectory() &&
          !localClaudeStat.isSymbolicLink() && (process.platform === 'win32' || localClaudeStat.uid === process.getuid?.()), 'probe_controller_state_foreign')
        if (process.platform === 'win32') {
          const leaves = ['teams', 'tasks'].map(kind => path.join(localClaude, kind, teamId))
          await ensureWindowsPrivateDirectories(leaves, leaves)
        }
        for (const kind of ['teams', 'tasks']) {
          const parent = path.join(localClaude, kind)
          if (process.platform !== 'win32') await mkdir(parent, { recursive: true, mode: 0o700 })
          const parentStat = await lstat(parent)
          executionAssert(await realpath(parent) === parent && parentStat.isDirectory() &&
            !parentStat.isSymbolicLink() && (process.platform === 'win32' || parentStat.uid === process.getuid?.()), 'probe_controller_state_foreign')
          if (process.platform !== 'win32') await mkdir(path.join(parent, teamId), { mode: 0o700 })
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
      record = { sourceKey, binding: plan.binding, sessionID: member.originalSessionId, intent, submitted: false, proof: null, retired: false, failure: null }
      await save(record) // Original identities precede launch and every prompt effect.
      await launchExplicitOpenCodeV2Run(plan)
    }
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
        selectedModel: `${selection.model.providerID}/${selection.model.id}`, selectedVariant: variant, pin: selection.native.version },
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
        return { state: 'available' as const, proof: record.proof, reason: null }
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(300, Math.max(1, deadline - Date.now()))))
    }
    return { state: 'pending' as const, proof: null, reason: 'Original native input has no qualifying terminal; only readback is authorized.' }
  } catch (error) { primary = error; failed = true; throw error }
  finally {
    if (windowsStore) {
      const errors: unknown[] = []
      try { await release?.() } catch (error) { errors.push(error) }
      try { await windowsStore.close() } catch (error) { errors.push(error) }
      if (errors.length) throw Object.assign(new AggregateError([...(failed ? [primary] : []), ...errors], 'cleanup_unknown',
        { cause: failed ? primary : errors[0] }), { cleanupBoundary: 'probe_release', primaryFailure: failed })
    } else await release?.()
  }
}
