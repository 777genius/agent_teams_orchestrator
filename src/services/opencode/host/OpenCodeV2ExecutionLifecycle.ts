import { boundOpenCodeRead } from '../transport/OpenCodeBoundedFetch.js'
import { executionHash, executionRecord, OPEN_CODE_V2_WINDOWS_CLOSE_MS } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { ExecutionBirth } from './OpenCodeV2ExecutionBinding.js'
import { executionPlatformRetirementBudgetMs, requireExecutionPlatformRetirement } from './OpenCodeV2ExecutionPlatform.js'
import { retainOpenCodeV2CleanupPhase, type ExecutionCleanupPhase } from '../execution/OpenCodeV2Diagnostics.js'

/** `descendantsRetired` is true only when the child's whole process group was checked empty
 * (POSIX). Windows retires descendants best-effort with a tree kill and reports false. */
export type ExecutionCleanupReceipt = Readonly<{ scopeClosed: true; processRetired: true; descendantsRetired: boolean; pid: number; birth: ExecutionBirth }>
// Receipt identity, rather than caller-controlled fields, gates durable owner
// release. Only launch-owned kernel retirement with private close ACK can mint one.
const cleanupReceipts = new WeakSet<ExecutionCleanupReceipt>()
export function isExecutionCleanupReceipt(value: unknown): value is ExecutionCleanupReceipt {
  return value !== null && typeof value === 'object' && cleanupReceipts.has(value as ExecutionCleanupReceipt)
}
export type ExecutionRetirementPort = {
  pid: number; birth: ExecutionBirth; exited(): boolean; acknowledged(): boolean
  disposeTransport(): Promise<void>; sendClose(): void; waitExit: Promise<void>
  readBirth(): Promise<ExecutionBirth | null>; kill(deadline?: number): void | Promise<void>; retireOwnedDescendants(deadline?: number): Promise<unknown>
}
export function executionClosedAck(value: unknown, nonce: string, pid: number, birth: ExecutionBirth): boolean {
  try {
    const row = executionRecord(value)
    return row.type === 'closed' && row.nonce === nonce && row.pid === pid && row.scopeClosed === true &&
      executionHash(row.birth) === executionHash(birth)
  } catch { return false }
}
/**
 * All close attempts remain independent. A forced leader exit does not establish
 * Scope cleanup. Positive receipts additionally require a concrete launch-owned
 * kernel receipt that carries the privately verified close acknowledgment.
 */
export async function retireExecutionChild(port: ExecutionRetirementPort, deadline?: number,
  observe?: (phase: ExecutionCleanupPhase) => void): Promise<ExecutionCleanupReceipt> {
  const mark = (phase: ExecutionCleanupPhase) => { try { observe?.(phase) } catch { /* Observation cannot alter cleanup. */ } }
  // Windows Stop supplies a physical-close slice of its original 40s envelope. Pass that SAME
  // absolute deadline through every wait and the native RPC; never restart it.
  // Standalone and POSIX retirement retain their original adapter budgets.
  const closeDeadline = process.platform === 'win32' && Number.isSafeInteger(deadline)
    ? Math.min(deadline!, Date.now() + OPEN_CODE_V2_WINDOWS_CLOSE_MS) : undefined
  const remaining = (maximum: number) => closeDeadline === undefined ? maximum
    : Math.max(1, Math.min(maximum, closeDeadline - Date.now()))
  // Expiry cannot skip the owned job-stop attempt. Its existing private default
  // may finish in the background, but expired public evidence stays UNKNOWN.
  const nativeDeadline = () => closeDeadline !== undefined && Date.now() < closeDeadline ? closeDeadline : undefined
  const fail = (phase: ExecutionCleanupPhase, cause?: unknown): never => {
    const error = new Error('cleanup_unknown', { cause })
    retainOpenCodeV2CleanupPhase(error, phase)
    throw error
  }
  const failures: { error: unknown; phase: ExecutionCleanupPhase }[] = []
  mark('dispose-transport')
  try { await boundOpenCodeRead(port.disposeTransport(), remaining(3000)) } catch (error) { failures.push({ error, phase: 'dispose-transport' }) }
  mark('send-close')
  try { if (!port.exited()) port.sendClose() } catch (error) { failures.push({ error, phase: 'send-close' }) }
  mark('wait-exit')
  try { await boundOpenCodeRead(port.waitExit, remaining(10_000)) } catch {
    try {
      mark('read-birth')
      const birth = await boundOpenCodeRead(port.readBirth(), remaining(1500))
      if (!port.exited() && birth !== null && executionHash(birth) === executionHash(port.birth)) {
        mark('force-kill')
        const work = port.kill(nativeDeadline())
        if (closeDeadline === undefined) await work
        else await boundOpenCodeRead(Promise.resolve(work), remaining(Infinity))
      }
    } catch (error) { failures.push({ error, phase: 'force-kill' }) }
    mark('wait-exit')
    try { await boundOpenCodeRead(port.waitExit, remaining(2000)) } catch (error) { failures.push({ error, phase: 'wait-exit' }) }
  }
  let retired = false
  mark('read-birth')
  try {
    const birth = await boundOpenCodeRead(port.readBirth(), remaining(1500))
    retired = port.exited() && (birth === null || executionHash(birth) !== executionHash(port.birth))
  } catch (error) { failures.push({ error, phase: 'read-birth' }) }
  let kernel: unknown
  mark('kernel-retirement')
  try {
    kernel = await boundOpenCodeRead(port.retireOwnedDescendants(nativeDeadline()),
      closeDeadline === undefined ? executionPlatformRetirementBudgetMs() : remaining(Infinity))
    if (closeDeadline !== undefined && Date.now() >= closeDeadline) throw new Error('execution_timeout')
  } catch (error) { failures.push({ error, phase: 'kernel-retirement' }) }
  if (failures.length > 0) {
    fail(failures[0]!.phase, failures[0]!.error)
  }
  if (!retired) fail('process-retirement')
  if (!port.acknowledged()) fail('closed-ack')
  let evidence: ReturnType<typeof requireExecutionPlatformRetirement>
  try { evidence = requireExecutionPlatformRetirement(kernel) }
  catch (error) { fail('kernel-proof', error) }
  if (evidence.pid !== port.pid || executionHash(evidence.birth) !== executionHash(port.birth)) fail('kernel-binding')
  if (closeDeadline !== undefined && Date.now() >= closeDeadline) fail('kernel-retirement', new Error('execution_timeout'))
  const receipt: ExecutionCleanupReceipt = Object.freeze({ scopeClosed: true, processRetired: true,
    descendantsRetired: evidence.descendants === 'process-group', pid: evidence.pid, birth: evidence.birth })
  cleanupReceipts.add(receipt)
  return receipt
}
