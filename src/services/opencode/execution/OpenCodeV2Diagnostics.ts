import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, lstat, writeFile } from 'node:fs/promises'
import { resolveClaudeMultimodelPaths } from '../OpenCodeManagedPaths.js'
import { executionAssert } from './OpenCodeV2ExecutionContracts.js'
import { readOpenCodeV2ProviderWireFailure } from '../transport/OpenCodeV2ProviderWire.js'
import { ensureWindowsPrivateDirectories } from '../profile/OpenCodePrivateDirectories.js'

const startupStages = new Set(['windows-cohort', 'windows-profile', 'windows-roots', 'windows-dll',
  'windows-process', 'windows-owned-pair', 'windows-published', 'windows-connected', 'windows-prepare', 'windows-assert', 'waiting-for-prepare', 'profile-validation', 'native-validation', 'graph-validation',
  'runtime-import', 'server-start', 'effect-import', 'selected-oauth-import', 'scope-acquisition', 'ready-identity'])
function startupDiagnostic(output: string | undefined) {
  if (!output || output.length > 16_384) return undefined
  for (const line of output.split('\n').reverse()) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>
      if (!row || Array.isArray(row) || !['elapsedMs,event,reason,stage', 'elapsedMs,event,history,reason,stage',
        'elapsedMs,event,graph,reason,stage', 'elapsedMs,event,graph,history,reason,stage'].includes(Object.keys(row).filter(key => key !== 'nativeExitCode' && key !== 'nativeStderrKind').sort().join(',')) ||
        ('nativeStderrKind' in row && (typeof row.nativeStderrKind !== 'string' || !['empty', 'entry_resolution', 'module_resolution', 'child_identity', 'child_pipe', 'access_denied', 'pipe_refused', 'pipe_missing', 'bun_error', 'unclassified', 'unavailable'].includes(row.nativeStderrKind))) ||
        ('nativeExitCode' in row && (!Number.isSafeInteger(row.nativeExitCode) || Number(row.nativeExitCode) < 0 || Number(row.nativeExitCode) > 0xffffffff)) ||
        row.event !== 'opencode-v2-startup' || typeof row.reason !== 'string' || !['timeout', 'failed'].includes(row.reason) ||
        typeof row.stage !== 'string' || !startupStages.has(row.stage) ||
        !Number.isSafeInteger(row.elapsedMs) || Number(row.elapsedMs) < 0 || Number(row.elapsedMs) > 86_400_000) continue
      const history: { stage: string; elapsedMs: number }[] = []
      if ('history' in row) {
        if (!Array.isArray(row.history) || row.history.length < 1 || row.history.length > 10) continue
        for (const entry of row.history) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
            Object.keys(entry).sort().join(',') !== 'elapsedMs,stage' ||
            typeof entry.stage !== 'string' || !startupStages.has(entry.stage) ||
            !Number.isSafeInteger(entry.elapsedMs) || entry.elapsedMs < 0 || entry.elapsedMs > Number(row.elapsedMs) ||
            entry.elapsedMs < (history.at(-1)?.elapsedMs ?? 0) || history.some(item => item.stage === entry.stage)) break
          history.push({ stage: entry.stage, elapsedMs: entry.elapsedMs })
        }
        if (history.length !== row.history.length || history.at(-1)?.stage !== row.stage) continue
      }
      let graph: { phase: 'hash' | 'closure'; completed: number; total: number } | undefined
      if ('graph' in row) {
        const value = row.graph as Record<string, unknown> | null
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.keys(value).sort().join(',') !== 'completed,phase,total' ||
          (value.phase !== 'hash' && value.phase !== 'closure') ||
          !Number.isSafeInteger(value.total) || Number(value.total) < 1 || Number(value.total) > 65_536 ||
          !Number.isSafeInteger(value.completed) || Number(value.completed) < 0 || Number(value.completed) > Number(value.total) ||
          (value.phase === 'closure' && value.completed !== value.total)) continue
        graph = { phase: value.phase, completed: Number(value.completed), total: Number(value.total) }
      }
      return { reason: row.reason, stage: row.stage, elapsedMs: row.elapsedMs,
        ...('nativeExitCode' in row ? { nativeExitCode: Number(row.nativeExitCode) } : {}),
        ...('nativeStderrKind' in row ? { nativeStderrKind: row.nativeStderrKind as string } : {}),
        ...('history' in row ? { history } : {}), ...(graph ? { graph } : {}) }
    } catch { /* Arbitrary native output is never a diagnostic payload. */ }
  }
  return undefined
}

export type ExecutionAcquisitionPhase = 'preparing' | 'delivery-resolved' | 'profile-validated' | 'native-validated' |
  'graph-validated' | 'resolution-prepared' | 'controller-prepared' | 'prepared' | 'mapping' | 'child-bound' | 'start-sent' |
  'ready' | 'catalog-ready' | 'auth-ready' | 'selection-ready'
const acquisitionPhases = new Set<ExecutionAcquisitionPhase>(['preparing', 'delivery-resolved', 'profile-validated', 'native-validated',
  'graph-validated', 'resolution-prepared', 'controller-prepared', 'prepared', 'mapping', 'child-bound',
  'start-sent', 'ready', 'catalog-ready', 'auth-ready', 'selection-ready'])
function acquisitionDiagnostic(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(',') !== 'elapsedMs,history' || !Number.isSafeInteger(row.elapsedMs) ||
    Number(row.elapsedMs) < 0 || Number(row.elapsedMs) > 86_400_000 ||
    !Array.isArray(row.history) || row.history.length < 1 || row.history.length > 15) return undefined
  const history: { phase: ExecutionAcquisitionPhase; elapsedMs: number }[] = []
  for (const entry of row.history) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      Object.keys(entry).sort().join(',') !== 'elapsedMs,phase' || !acquisitionPhases.has(entry.phase) ||
      !Number.isSafeInteger(entry.elapsedMs) || entry.elapsedMs < (history.at(-1)?.elapsedMs ?? 0) ||
      entry.elapsedMs > Number(row.elapsedMs) || history.some(item => item.phase === entry.phase)) return undefined
    history.push({ phase: entry.phase, elapsedMs: entry.elapsedMs })
  }
  if (history[0]?.phase !== 'preparing' || history[0].elapsedMs !== 0) return undefined
  return { elapsedMs: Number(row.elapsedMs), history }
}

export type RunInitializationPhase = 'MCP-connect' | 'MCP-readback' | 'controller-tools' | 'probe-authority'
const initializationPhases = new Set<RunInitializationPhase>(['MCP-connect', 'MCP-readback', 'controller-tools', 'probe-authority'])
const initializationFailures = new WeakMap<Error, Readonly<{ phase: RunInitializationPhase; elapsedMs: number }>>()
export type ExecutionCleanupPhase = 'dispose-transport' | 'send-close' | 'force-kill' | 'wait-exit' | 'read-birth' | 'kernel-retirement' |
  'process-retirement' | 'closed-ack' | 'kernel-proof' | 'kernel-binding'
const cleanupPhases = new Set<ExecutionCleanupPhase>(['dispose-transport', 'send-close', 'force-kill', 'wait-exit', 'read-birth', 'kernel-retirement',
  'process-retirement', 'closed-ack', 'kernel-proof', 'kernel-binding'])
const cleanupFailures = new WeakMap<Error, ExecutionCleanupPhase>()
export function retainOpenCodeV2CleanupPhase(error: Error, phase: ExecutionCleanupPhase): void {
  if (cleanupPhases.has(phase) && !cleanupFailures.has(error)) cleanupFailures.set(error, phase)
}
/** Preserve the original rejection object; private finite context is never error payload. */
export function retainOpenCodeV2InitializationPhase(error: unknown, phase: RunInitializationPhase, elapsedMs: number): void {
  if (error instanceof Error && initializationPhases.has(phase) && Number.isSafeInteger(elapsedMs) &&
    elapsedMs >= 0 && elapsedMs <= 86_400_000 && !initializationFailures.has(error))
    initializationFailures.set(error, Object.freeze({ phase, elapsedMs }))
}

const privateProviderFailureCodes = new Set(['provider_missing', 'provider_key_method_unsupported', 'provider_existing_credentials_unsupported',
  'provider_catalog_scope_changed', 'provider_catalog_location_changed', 'provider_integration_changed', 'provider_credential_identity_changed',
  'provider_owned_connection_unknown', 'provider_active_connection_changed', 'provider_auth_publication_changed', 'provider_auth_publication_unknown',
  'provider_selected_model_missing', 'provider_original_connect_unknown', 'provider_original_execution_pending', 'provider_execution_target_changed',
  'provider_saved_proof_changed', 'provider_saved_proof_unqualified', 'provider_physical_cleanup_unknown', 'provider_mutation_unknown',
  'provider_response_invalid', 'provider_authority_changed', 'provider_directory_changed', 'provider_rollback_peer_changed',
  'provider_rollback_publication_changed', 'provider_rollback_unknown', 'provider_rollback_publication_unknown',
  'run_control_timeout', 'run_control_disconnected', 'run_control_changed', 'run_control_foreign', 'run_control_invalid',
  'run_control_frame_too_large', 'run_owner_stale', 'run_process_unknown', 'run_process_changed',
  'run_deadline_expired', 'run_readiness_changed', 'run_readiness_unknown', 'run_operation_unknown',
  'execution_selected_auth_required', 'execution_selected_auth_unbound', 'execution_selected_auth_changed',
  'execution_selected_auth_missing', 'execution_selected_auth_unsupported', 'execution_selected_auth_location_changed',
  'execution_selected_auth_provider_unknown', 'execution_selected_auth_existing_or_unsupported',
  'execution_selected_auth_readback_unknown', 'execution_selected_auth_profile_changed',
  'execution_selected_oauth_readback_unknown', 'execution_selected_oauth_recovery_required', 'execution_selected_oauth_windows_unqualified',
  'execution_selected_oauth_provider_unknown', 'execution_selected_oauth_integration_unknown',
  'execution_selected_oauth_connection_unknown', 'execution_selected_oauth_model_unknown',
  'execution_lease_not_owned', 'execution_host_unavailable', 'execution_invalid_response', 'execution_identity_mismatch', 'execution_identity_unknown',
  'execution_profile_changed', 'execution_graph_changed', 'execution_graph_incomplete', 'execution_graph_dependency_missing',
  'execution_timeout', 'execution_owner_unknown', 'cleanup_unknown', 'selection_mismatch', 'authority_mismatch',
  'graph_mismatch', 'identity_mismatch', 'unqualified_version', 'invalid_response', 'invalid_model',
  'http_failure', 'transport_failure', 'media_type', 'deadline', 'authority_or_deadline', 'disposed', 'timeout'])
// Exact native producer literals only; neither an arbitrary message nor a
// syntactically plausible unknown stage is persisted as diagnostic data.
const privateNativeFailureCodes = new Set([
  'cleanup_unknown', 'execution_identity_unknown', 'execution_path_alias',
  'execution_cancelled', 'execution_containment_dll_identity', 'execution_containment_filesystem_denied',
  'execution_containment_helper_closed', 'execution_containment_helper_failed', 'execution_containment_helper_identity',
  'execution_containment_launcher_denied', 'execution_containment_pipe_denied', 'execution_containment_profile_denied',
  'execution_containment_unavailable', 'execution_native_command_unknown', 'execution_native_stdio_owner_unknown',
  'execution_native_timeout', 'execution_native_unknown', 'execution_owner_alias', 'run_control_process_identity',
  'execution_owner_archive_identity_mismatch', 'execution_owner_archive_path_mismatch', 'execution_owner_archive_reopen_identity_mismatch',
  'execution_owner_archive_unknown', 'execution_owner_local_volume_required', 'execution_owner_metadata_budget',
  'execution_owner_metadata_changed', 'execution_owner_metadata_invalid', 'execution_owner_metadata_missing',
  'execution_owner_metadata_purpose_invalid', 'execution_owner_not_private', 'execution_owner_ntfs_required',
  'execution_owner_path_invalid', 'execution_owner_prepared_invalid', 'execution_owner_prepared_purpose_invalid',
  'execution_owner_read_only', 'execution_owner_unknown', 'execution_owner_write_through_pending'])
const privateNativeFailureStages = new Set([
  'process_birth', 'process_image_path', 'process_image_open', 'process_birth_changed',
  'shared_acl_mutex_descriptor', 'shared_acl_mutex_create', 'shared_acl_mutex_security',
  'shared_acl_mutex_encoding', 'shared_acl_mutex_authority', 'shared_acl_mutex_wait', 'shared_acl_mutex',
  'owner_archive_nt_rename', 'owner_canonical_open', 'owner_directory_create',
  'owner_directory_open', 'owner_identity_links', 'owner_identity_reparse',
  'owner_identity_type', 'owner_metadata_cleanup', 'owner_metadata_open',
  'owner_metadata_publish', 'owner_parent_duplicate', 'owner_prepared_create',
  'owner_verification_open', 'private_acl_foreign_allow', 'private_acl_owner',
  'private_acl_owner_run_data_root', 'private_acl_owner_run_leaf', 'private_acl_owner_run_opencode',
  'private_acl_owner_run_runs', 'private_acl_owner_run_v2', 'private_image_open',
  'private_image_protected_dacl', 'private_dll_owner', 'private_owner_acquire', 'private_owner_cohort',
  'private_owner_controller_tasks', 'private_owner_controller_teams', 'private_owner_discover_selection',
  'private_owner_reserve_selection', 'private_owner_selected_selection',
  'private_readonly_root', 'private_writable_root', 'private_protected_root',
  'ancestor_metadata_control', 'ancestor_metadata_foreign', 'ancestor_metadata_group', 'ancestor_metadata_member', 'ancestor_metadata_open', 'ancestor_metadata_owner', 'ancestor_metadata_ace', 'ancestor_metadata_descriptor', 'ancestor_metadata_security', 'ancestor_metadata_package', 'ancestor_metadata_read', 'ancestor_metadata_changed', 'ancestor_metadata_cleanup_unproven', 'ancestor_metadata_intent', 'ancestor_metadata_acl_size', 'ancestor_metadata_acl', 'ancestor_metadata_write', 'ancestor_metadata_identity', 'ancestor_metadata_pin',
  'shared_readonly_security', 'shared_readonly_acl', 'shared_readonly_owner', 'shared_readonly_file',
  'shared_readonly_control', 'shared_readonly_ace', 'shared_readonly_package', 'shared_readonly_foreign_write',
  'shared_readonly_grant_open', 'shared_readonly_grant_read', 'shared_readonly_grant_merge', 'shared_readonly_grant_write',
  'shared_readonly_owner_changed', 'shared_readonly_control_changed', 'shared_readonly_foreign_changed', 'shared_readonly_member_missing',
  'retire_broker_state', 'retire_broker_write', 'retire_job', 'retire_wait', 'retire_io_join',
  'retire_main_exit', 'retire_owned_pair', 'retire_commands', 'retire_receipt', 'retire_grants'])
function nativeFailure(error: unknown): { category: string; native?: { stage: string; nativeCode: number } } | undefined {
  if (!(error instanceof Error)) return undefined
  if (privateNativeFailureCodes.has(error.message)) return { category: error.message }
  const match = /^([a-z_]{1,96}):([a-z_]{1,64}):(0|[1-9][0-9]{0,9})$/.exec(error.message)
  if (!match || !privateNativeFailureCodes.has(match[1]!)) return undefined
  const nativeCode = Number(match[3])
  if (!Number.isSafeInteger(nativeCode) || nativeCode > 0xffffffff) return undefined
  return { category: match[1]!, ...(privateNativeFailureStages.has(match[2]!)
    ? { native: { stage: match[2]!, nativeCode } } : {}) }
}
/** Private static phase/category only: never an arbitrary SDK message, body, credential or key. */
export async function recordOpenCodeV2ProviderFailure(phase: string, error: unknown, retainedOriginal: boolean, startupOutput?: string, acquisitionTiming?: unknown, cleanupTiming?: Readonly<{ elapsedMs: number; dataRoot?: string }>): Promise<void> {
  // Only our finite cleanup wrappers may preserve one exact known cause.
  const cause = error instanceof Error && (error.message === 'cleanup_unknown' || error.message === 'execution_owner_unknown')
    ? error.cause : undefined
  const native = nativeFailure(cause) ?? nativeFailure(error)
  const category = cause instanceof Error && privateProviderFailureCodes.has(cause.message) ? cause.message
    : native?.category ?? (error instanceof Error && privateProviderFailureCodes.has(error.message) ? error.message : 'provider_operation_unknown')
  const operation = readOpenCodeV2ProviderWireFailure(error)
  const startup = startupDiagnostic(startupOutput)
  const acquisition = acquisitionDiagnostic(acquisitionTiming)
  const cleanup = phase === 'run-member-retirement' && Number.isSafeInteger(cleanupTiming?.elapsedMs) &&
    Number(cleanupTiming?.elapsedMs) >= 0 && Number(cleanupTiming?.elapsedMs) <= 86_400_000
    ? { elapsedMs: Number(cleanupTiming?.elapsedMs), ...(error instanceof Error && cleanupFailures.has(error)
      ? { phase: cleanupFailures.get(error)! } : {}) } : undefined
  const initialization = phase === 'run-owner-initialization' && error instanceof Error ? initializationFailures.get(error) : undefined
  if (cleanupTiming?.dataRoot !== undefined && (!cleanup || typeof cleanupTiming.dataRoot !== 'string' || !path.isAbsolute(cleanupTiming.dataRoot))) return
  try {
    const directory = path.join(cleanupTiming?.dataRoot ?? resolveClaudeMultimodelPaths().data, 'opencode/v2/provider-diagnostics')
    if (process.platform === 'win32') {
      await ensureWindowsPrivateDirectories([directory])
    } else {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const info = await lstat(directory)
      executionAssert(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0, 'provider_diagnostics_foreign')
    }
    // Nonsecret observational data only: this file is not native ownership or
    // cleanup authority, even when an elevated Windows writer owns the file.
    await writeFile(path.join(directory, randomUUID() + '.json'), JSON.stringify({ schemaVersion: 1, phase, category, retainedOriginal,
      ...(native?.native ? { native: native.native } : {}), ...(operation ? { operation } : {}), ...(startup ? { startup } : {}), ...(acquisition ? { acquisition } : {}), ...(cleanup ? { cleanup } : {}), ...(initialization ? { initialization } : {}), recordedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
  } catch { /* Diagnostics cannot replace or retry the unresolved original operation. */ }
}
