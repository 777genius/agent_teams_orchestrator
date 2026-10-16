import { readWindowsNativeAliasFailure } from '../host/windows/OpenCodeV2WindowsNativeBroker.js'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, lstat, writeFile } from 'node:fs/promises'
import { resolveClaudeMultimodelPaths } from '../OpenCodeManagedPaths.js'
import { executionAssert } from './OpenCodeV2ExecutionContracts.js'
import { readOpenCodeV2ProviderWireFailure } from '../transport/OpenCodeV2ProviderWire.js'
import { ensureWindowsPrivateDirectories } from '../profile/OpenCodePrivateDirectories.js'

const startupStages = new Set(['run-owner-entry', 'windows-cohort', 'windows-profile', 'windows-roots', 'windows-dll',
  'windows-process', 'windows-owned-pair', 'windows-published', 'windows-connected', 'windows-prepare', 'windows-assert', 'waiting-for-prepare', 'profile-validation', 'native-validation', 'graph-validation', 'waiting-for-activation',
  'delivery-resolution', 'runtime-import', 'server-start', 'effect-import', 'selected-oauth-import', 'scope-acquisition', 'ready-identity'])
function startupDiagnostic(output: string | undefined) {
  if (!output || output.length > 16_384) return undefined
  for (const line of output.split('\n').reverse()) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>
      const optionalFacts: Record<string, unknown> = {}
      const closedFields: Record<string, readonly string[]> = {
        errno: ['EPERM', 'EACCES', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EINVAL', 'UNKNOWN', 'EIO', 'ENOSYS'],
        operation: ['realpath', 'open', 'read', 'lstat', 'stat'], errorName: ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'AbortError'],
        cause: ['execution_contract_invalid', 'execution_identity_mismatch', 'execution_entry_changed', 'v2_compiled_runtime_unsupported', 'v2_execution_layout_unsupported', 'execution_profile_changed', 'execution_graph_changed', 'execution_graph_incomplete', 'execution_graph_dependency_missing', 'execution_containment_identity_mismatch', 'execution_timeout', 'execution_cancelled'],
        profileGuard: ['environment_hash', 'config_hash', 'home_mapping', 'path_containment', 'database_type', 'models_type', 'models_hash', 'process_cwd', 'process_pwd', 'process_environment'],
      }
      if (!row || Array.isArray(row)) continue
      if (Object.entries(closedFields).some(([key, allowed]) => key in row && !allowed.includes(row[key] as string))) continue
      for (const key of Object.keys(closedFields)) if (key in row) optionalFacts[key] = row[key]
      if ('environmentMismatchKeys' in row) {
        const allowed = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR', 'TMP', 'TEMP', 'APPDATA', 'LOCALAPPDATA', 'PATH', 'NO_COLOR', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'HOMEDRIVE', 'HOMEPATH', 'OPENCODE_CONFIG_DIR', 'AGENT_TEAMS_MCP_CLAUDE_DIR', 'OPENSSL_CONF', 'other']
        if (!Array.isArray(row.environmentMismatchKeys) || row.environmentMismatchKeys.length > allowed.length ||
            !row.environmentMismatchKeys.every(key => typeof key === 'string' && allowed.includes(key))) continue
        optionalFacts.environmentMismatchKeys = row.environmentMismatchKeys
      }
      if (!row || Array.isArray(row) || !['elapsedMs,event,reason,stage', 'elapsedMs,event,history,reason,stage',
        'elapsedMs,event,graph,reason,stage', 'elapsedMs,event,graph,history,reason,stage'].includes(Object.keys(row).filter(key => key !== 'nativeExitCode' && key !== 'nativeStderrKind' && key !== 'graphFailure' && !Object.hasOwn(closedFields, key) && key !== 'environmentMismatchKeys').sort().join(',')) ||
        ('nativeStderrKind' in row && (typeof row.nativeStderrKind !== 'string' || !['empty', 'entry_resolution', 'module_resolution', 'child_identity', 'child_pipe', 'access_denied', 'pipe_refused', 'pipe_missing', 'bun_error', 'unclassified', 'unavailable'].includes(row.nativeStderrKind))) ||
        ('nativeExitCode' in row && (!Number.isSafeInteger(row.nativeExitCode) || Number(row.nativeExitCode) < 0 || Number(row.nativeExitCode) > 0xffffffff)) ||
        row.event !== 'opencode-v2-startup' || typeof row.reason !== 'string' || !['timeout', 'failed'].includes(row.reason) ||
        typeof row.stage !== 'string' || !startupStages.has(row.stage) ||
        !Number.isSafeInteger(row.elapsedMs) || Number(row.elapsedMs) < 0 || Number(row.elapsedMs) > 86_400_000) continue
      let graphFailure: Record<string, unknown> | undefined
      if ('graphFailure' in row) {
        const value = row.graphFailure as Record<string, unknown> | null
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            !['contentSha256,index,pathSha256,readPhase,total', 'contentSha256,index,pathSha256,readPhase,realpath,total'].includes(Object.keys(value).sort().join(',')) ||
            (value.readPhase !== 'realpath' && value.readPhase !== 'hash') || !Number.isSafeInteger(value.index) || !Number.isSafeInteger(value.total) || Number(value.index) < 0 || Number(value.index) >= Number(value.total) || Number(value.total) > 65536 ||
            typeof value.pathSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.pathSha256) || typeof value.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.contentSha256)) continue
        if (value.realpath !== undefined) {
          const native = value.realpath as Record<string, unknown> | null
          if (!native || typeof native !== 'object' || Array.isArray(native) || Object.keys(native).sort().join(',') !== 'anchorCount,matchingAnchorIndex,operation,status,win32' ||
              !Object.values(native).every(Number.isSafeInteger) || Number(native.status) < 1 || Number(native.status) > 4 || Number(native.operation) < 0 || Number(native.operation) > 25 ||
              Number(native.win32) < 0 || Number(native.win32) > 0xffffffff || Number(native.anchorCount) < 0 || Number(native.anchorCount) > 4096 || Number(native.matchingAnchorIndex) < -1 || Number(native.matchingAnchorIndex) >= Number(native.anchorCount)) continue
        }
        graphFailure = value
      }
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
      return { reason: row.reason, stage: row.stage, elapsedMs: row.elapsedMs, ...optionalFacts,
        ...('nativeExitCode' in row ? { nativeExitCode: Number(row.nativeExitCode) } : {}),
        ...('nativeStderrKind' in row ? { nativeStderrKind: row.nativeStderrKind as string } : {}),
        ...('history' in row ? { history } : {}), ...(graph ? { graph } : {}), ...(graphFailure ? { graphFailure } : {}) }
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
  'process-retirement' | 'closed-ack' | 'kernel-proof' | 'kernel-binding' | 'owner-release' | 'retained-roots' | 'plan-close'
const cleanupPhases = new Set<ExecutionCleanupPhase>(['dispose-transport', 'send-close', 'force-kill', 'wait-exit', 'read-birth', 'kernel-retirement',
  'process-retirement', 'closed-ack', 'kernel-proof', 'kernel-binding', 'owner-release', 'retained-roots', 'plan-close'])
export const executionNativeRetirementPhases = ['retire_job', 'retire_wait', 'retire_io_join', 'retire_main_exit',
  'retire_owned_pair', 'retire_commands', 'retire_receipt', 'retire_grants', 'retire_grants_dll',
  'retire_grants_roots', 'retire_grants_metadata'] as const
export type ExecutionNativeRetirementPhase = typeof executionNativeRetirementPhases[number]
export type ExecutionCleanupObservation = Readonly<{ phase: ExecutionCleanupPhase; nativePhase?: ExecutionNativeRetirementPhase }>
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
  'run_acquisition_timeout', 'run_initialization_timeout', 'run_stopped', 'cancelled',
  'execution_selected_auth_required', 'execution_selected_auth_unbound', 'execution_selected_auth_changed',
  'execution_selected_auth_missing', 'execution_selected_auth_unsupported', 'execution_selected_auth_location_changed',
  'execution_selected_auth_provider_unknown', 'execution_selected_auth_existing_or_unsupported',
  'execution_selected_auth_readback_unknown', 'execution_selected_auth_profile_changed',
  'execution_selected_oauth_readback_unknown', 'execution_selected_oauth_recovery_required', 'execution_selected_oauth_windows_unqualified',
  'execution_selected_oauth_provider_unknown', 'execution_selected_oauth_integration_unknown',
  'execution_selected_oauth_connection_unknown', 'execution_selected_oauth_model_unknown',
  'execution_lease_not_owned', 'execution_host_unavailable', 'execution_containment_unqualified', 'execution_invalid_response', 'execution_identity_mismatch', 'execution_identity_unknown',
  'execution_profile_changed', 'execution_graph_changed', 'execution_graph_incomplete', 'execution_graph_dependency_missing',
  'execution_timeout', 'execution_owner_unknown', 'execution_owner_record_invalid', 'cleanup_unknown', 'selection_mismatch', 'authority_mismatch',
  'graph_mismatch', 'identity_mismatch', 'unqualified_version', 'invalid_response', 'invalid_model',
  'http_failure', 'transport_failure', 'media_type', 'deadline', 'authority_or_deadline', 'disposed', 'timeout'])
// Exact native producer literals only; neither an arbitrary message nor a
// syntactically plausible unknown stage is persisted as diagnostic data.
const privateNativeFailureCodes = new Set([
  'cleanup_unknown', 'execution_identity_unknown', 'execution_path_alias',
  'execution_cancelled', 'execution_containment_unqualified', 'execution_containment_dll_identity', 'execution_containment_filesystem_denied',
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
  'alias_predicate',
  'assert_mapping', 'assert_stopped', 'assert_broker',
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
  'retire_main_exit', 'retire_owned_pair', 'retire_commands', 'retire_receipt', 'retire_grants',
  'retire_grants_dll', 'retire_grants_roots', 'retire_grants_metadata'])
function nativeFailure(error: unknown): { category: string; native?: { stage: string; nativeCode: number } } | undefined {
  if (!(error instanceof Error)) return undefined
  if (privateNativeFailureCodes.has(error.message)) return { category: error.message }
  const match = /^([a-z_]{1,96}):([a-z_][a-z_0-9]{0,63}):(0|[1-9][0-9]{0,9})$/.exec(error.message)
  if (!match || !privateNativeFailureCodes.has(match[1]!)) return undefined
  const nativeCode = Number(match[3])
  if (!Number.isSafeInteger(nativeCode) || nativeCode > 0xffffffff) return undefined
  return { category: match[1]!, ...(privateNativeFailureStages.has(match[2]!)
    ? { native: { stage: match[2]!, nativeCode } } : {}) }
}
/** Private static phase/category only: never an arbitrary SDK message, body, credential or key. */
export async function recordOpenCodeV2ProviderFailure(phase: string, error: unknown, retainedOriginal: boolean, startupOutput?: string, acquisitionTiming?: unknown, cleanupTiming?: Readonly<{ elapsedMs: number; dataRoot?: string; observation?: ExecutionCleanupObservation }>): Promise<void> {
  // Only our finite cleanup wrappers may preserve one exact known cause.
  const cause = error instanceof Error && (error.message === 'cleanup_unknown' || error.message === 'execution_owner_unknown')
    ? error.cause : undefined
  const native = nativeFailure(cause) ?? nativeFailure(error)
  const category = cause instanceof Error && privateProviderFailureCodes.has(cause.message) ? cause.message
    : native?.category ?? (error instanceof Error && privateProviderFailureCodes.has(error.message) ? error.message : 'provider_operation_unknown')
  // Preserve only fixed original exception facts when a startup guard is not a
  // known category. Never persist its message, path, stack or arbitrary fields.
  const detail = (cause instanceof Error ? cause : error instanceof Error ? error : undefined) as
    { name?: unknown; code?: unknown; syscall?: unknown } | undefined
  const name = ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'AbortError'].find(value => value === detail?.name)
  const errno = ['EPERM', 'EACCES', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EINVAL', 'UNKNOWN', 'EIO', 'ENOSYS'].find(value => value === detail?.code)
  const syscall = ['realpath', 'open', 'read', 'lstat', 'stat'].find(value => value === detail?.syscall)
  const failure = phase === 'execution-host-startup' && (name || errno || syscall)
    ? { ...(name ? { name } : {}), ...(errno ? { errno } : {}), ...(syscall ? { operation: syscall } : {}) } : undefined
  const alias = readWindowsNativeAliasFailure(cause) ?? readWindowsNativeAliasFailure(error)
  const operation = readOpenCodeV2ProviderWireFailure(error)
  const startup = startupDiagnostic(startupOutput)
  const acquisition = acquisitionDiagnostic(acquisitionTiming)
  const observed = cleanupTiming?.observation
  const observedPhase = observed && cleanupPhases.has(observed.phase) ? observed.phase : undefined
  const cleanupPhase = error instanceof Error ? cleanupFailures.get(error) ?? observedPhase : observedPhase
  const nativePhase = cleanupPhase === observedPhase && (cleanupPhase === 'kernel-retirement' || cleanupPhase === 'force-kill')
    ? executionNativeRetirementPhases.find(value => value === observed?.nativePhase) : undefined
  const cleanup = phase === 'run-member-retirement' && Number.isSafeInteger(cleanupTiming?.elapsedMs) &&
    Number(cleanupTiming?.elapsedMs) >= 0 && Number(cleanupTiming?.elapsedMs) <= 86_400_000
    ? { elapsedMs: Number(cleanupTiming?.elapsedMs), ...(cleanupPhase ? { phase: cleanupPhase } : {}),
      ...(nativePhase ? { nativePhase } : {}) } : undefined
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
      ...(native?.native ? { native: native.native } : {}), ...(alias ? { alias } : {}), ...(failure ? { failure } : {}), ...(operation ? { operation } : {}), ...(startup ? { startup } : {}), ...(acquisition ? { acquisition } : {}), ...(cleanup ? { cleanup } : {}), ...(initialization ? { initialization } : {}), recordedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
  } catch { /* Diagnostics cannot replace or retry the unresolved original operation. */ }
}
