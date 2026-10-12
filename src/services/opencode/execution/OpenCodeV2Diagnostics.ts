import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, lstat, writeFile } from 'node:fs/promises'
import { resolveClaudeMultimodelPaths } from '../OpenCodeManagedPaths.js'
import { executionAssert } from './OpenCodeV2ExecutionContracts.js'
import { readOpenCodeV2ProviderWireFailure } from '../transport/OpenCodeV2ProviderWire.js'

const startupStages = new Set(['waiting-for-prepare', 'profile-validation', 'native-validation', 'graph-validation',
  'runtime-import', 'server-start', 'effect-import', 'selected-oauth-import', 'scope-acquisition', 'ready-identity'])
function startupDiagnostic(output: string | undefined) {
  if (!output || output.length > 16_384) return undefined
  for (const line of output.split('\n').reverse()) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>
      if (!row || Array.isArray(row) || !['elapsedMs,event,reason,stage', 'elapsedMs,event,history,reason,stage',
        'elapsedMs,event,graph,reason,stage', 'elapsedMs,event,graph,history,reason,stage'].includes(Object.keys(row).sort().join(',')) ||
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
  'execution_lease_not_owned', 'execution_host_unavailable', 'execution_invalid_response', 'execution_identity_mismatch',
  'execution_profile_changed', 'execution_graph_changed', 'execution_graph_incomplete', 'execution_graph_dependency_missing',
  'execution_timeout', 'execution_owner_unknown', 'cleanup_unknown', 'selection_mismatch', 'authority_mismatch',
  'graph_mismatch', 'identity_mismatch', 'unqualified_version', 'invalid_response', 'invalid_model',
  'http_failure', 'transport_failure', 'media_type', 'deadline', 'authority_or_deadline', 'disposed'])
/** Private static phase/category only: never an arbitrary SDK message, body, credential or key. */
export async function recordOpenCodeV2ProviderFailure(phase: string, error: unknown, retainedOriginal: boolean, startupOutput?: string, acquisitionTiming?: unknown): Promise<void> {
  // Only our finite cleanup wrappers may preserve one exact known cause.
  const cause = error instanceof Error && (error.message === 'cleanup_unknown' || error.message === 'execution_owner_unknown')
    ? error.cause : undefined
  const category = cause instanceof Error && privateProviderFailureCodes.has(cause.message) ? cause.message
    : error instanceof Error && privateProviderFailureCodes.has(error.message) ? error.message : 'provider_operation_unknown'
  const operation = readOpenCodeV2ProviderWireFailure(error)
  const startup = startupDiagnostic(startupOutput)
  const acquisition = acquisitionDiagnostic(acquisitionTiming)
  const initialization = phase === 'run-owner-initialization' && error instanceof Error ? initializationFailures.get(error) : undefined
  try {
    const directory = path.join(resolveClaudeMultimodelPaths().data, 'opencode/v2/provider-diagnostics')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await lstat(directory)
    executionAssert(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0, 'provider_diagnostics_foreign')
    await writeFile(path.join(directory, randomUUID() + '.json'), JSON.stringify({ schemaVersion: 1, phase, category, retainedOriginal,
      ...(operation ? { operation } : {}), ...(startup ? { startup } : {}), ...(acquisition ? { acquisition } : {}), ...(initialization ? { initialization } : {}), recordedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
  } catch { /* Diagnostics cannot replace or retry the unresolved original operation. */ }
}
