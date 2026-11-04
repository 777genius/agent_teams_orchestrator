import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { readProcessStartTimeMs } from '../../utils/processKill.js'

export type RegistryLockOperation =
  | 'upsert_host' | 'remove_host' | 'endpoint_snapshot' | 'endpoint_confirm' | 'cursor_reap'
  | 'operation_pin' | 'operation_unpin' | 'retain_lease' | 'release_lease' | 'absent_recovery'
  | 'ensure_read' | 'refresh_read' | 'dispose_read' | 'dispose_host' | 'reconcile_snapshot'
  | 'reconcile_host' | 'reconcile_artifacts' | 'release_read'
type Stage = 'acquire' | 'callback' | 'release'
type DiagnosticPorts = {
  enabled: boolean
  now: () => number
  selfBirth: () => Promise<number | null>
  lockAge: () => Promise<number | null>
  write: (line: string) => void
}
let selfBirth: Promise<number | null> | undefined

/** Debug evidence only. Neither these receipts nor the observed mtime confer lock authority. */
export async function withOpenCodeRegistryLockDiagnostics<T>(
  operation: RegistryLockOperation,
  lockPath: string,
  acquire: () => Promise<() => Promise<void>>,
  callback: () => Promise<T>,
  ports: DiagnosticPorts = {
    enabled: process.env.CLAUDE_MULTIMODEL_DEBUG_OPENCODE_COMMAND === '1',
    now: () => performance.now(),
    selfBirth: () => selfBirth ??= readProcessStartTimeMs(process.pid).catch(() => null),
    lockAge: async () => Math.max(0, Date.now() - (await stat(`${lockPath}.lock`)).mtimeMs),
    write: line => { process.stderr.write(line) },
  },
): Promise<T> {
  const birth = ports.enabled ? await Promise.resolve().then(ports.selfBirth).catch(() => null) : null
  const id = ports.enabled ? randomUUID() : ''
  const started = ports.enabled ? ports.now() : 0
  let acquired: number | undefined
  let stage: Stage = 'acquire'
  const emit = (phase: 'waiting' | 'acquired' | 'releasing' | 'released' | 'failed',
    errorCode: string | null = null, lockMtimeAgeMs: number | null = null) => {
    if (!ports.enabled) return
    try {
      const now = ports.now()
      ports.write('[opencode-registry-lock] ' + JSON.stringify({
        operation, phase, stage, lockAttemptId: id, pid: process.pid, processStartedAtMs: birth,
        atMs: Date.now(), waitMs: Math.max(0, Math.round((acquired ?? now) - started)),
        heldMs: acquired === undefined ? 0 : Math.max(0, Math.round(now - acquired)),
        errorCode, lockMtimeAgeMs: lockMtimeAgeMs === null ? null : Math.round(lockMtimeAgeMs),
      }) + '\n')
    } catch { /* Diagnostics must not change lock/callback/release outcomes. */ }
  }
  const failed = async (error: unknown) => {
    if (!ports.enabled) return
    try {
      const code = error && typeof error === 'object'
        ? Object.getOwnPropertyDescriptor(error, 'code')?.value : null
      emit('failed', code === 'ELOCKED' || code === 'ECOMPROMISED' ? code : 'OTHER',
        stage === 'acquire' ? await Promise.resolve().then(ports.lockAge).catch(() => null) : null)
    } catch { /* Never inspect foreign getters or replace the original error. */ }
  }
  let release: (() => Promise<void>) | undefined
  emit('waiting')
  try {
    release = await acquire()
    if (ports.enabled) acquired = ports.now()
    stage = 'callback'
    emit('acquired')
    return await callback()
  } catch (error) {
    await failed(error)
    throw error
  } finally {
    if (release) {
      stage = 'release'
      emit('releasing')
      try { await release(); emit('released') }
      catch (error) { await failed(error); throw error }
    }
  }
}
