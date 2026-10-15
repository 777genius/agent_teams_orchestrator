import { boundOpenCodeRead } from '../transport/OpenCodeBoundedFetch.js'
import { executionHash, executionRecord } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { ExecutionBirth } from './OpenCodeV2ExecutionBinding.js'
import { executionPlatformRetirementBudgetMs, requireExecutionPlatformRetirement } from './OpenCodeV2ExecutionPlatform.js'
import { retainOpenCodeV2CleanupPhase, type ExecutionCleanupPhase } from '../execution/OpenCodeV2Diagnostics.js'

export type ExecutionCleanupReceipt = Readonly<{ scopeClosed: true; processRetired: true; descendantsRetired: true; pid: number; birth: ExecutionBirth }>
// Receipt identity, rather than caller-controlled fields, gates durable owner
// release. Only launch-owned kernel retirement with private close ACK can mint one.
const cleanupReceipts = new WeakSet<ExecutionCleanupReceipt>()
export function isExecutionCleanupReceipt(value: unknown): value is ExecutionCleanupReceipt {
  return value !== null && typeof value === 'object' && cleanupReceipts.has(value as ExecutionCleanupReceipt)
}
export type ExecutionRetirementPort = {
  pid: number; birth: ExecutionBirth; exited(): boolean; acknowledged(): boolean
  disposeTransport(): Promise<void>; sendClose(): void; waitExit: Promise<void>
  readBirth(): Promise<ExecutionBirth | null>; kill(): void | Promise<void>; retireOwnedDescendants(): Promise<unknown>
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
export async function retireExecutionChild(port: ExecutionRetirementPort): Promise<ExecutionCleanupReceipt> {
  const fail = (phase: ExecutionCleanupPhase, cause?: unknown): never => {
    const error = new Error('cleanup_unknown', { cause })
    retainOpenCodeV2CleanupPhase(error, phase)
    throw error
  }
  const failures: { error: unknown; phase: ExecutionCleanupPhase }[] = []
  try { await boundOpenCodeRead(port.disposeTransport(), 3000) } catch (error) { failures.push({ error, phase: 'dispose-transport' }) }
  try { if (!port.exited()) port.sendClose() } catch (error) { failures.push({ error, phase: 'send-close' }) }
  try { await boundOpenCodeRead(port.waitExit, 10_000) } catch {
    try {
      const birth = await boundOpenCodeRead(port.readBirth(), 1500)
      if (!port.exited() && birth !== null && executionHash(birth) === executionHash(port.birth)) await port.kill()
    } catch (error) { failures.push({ error, phase: 'force-kill' }) }
    try { await boundOpenCodeRead(port.waitExit, 2000) } catch (error) { failures.push({ error, phase: 'wait-exit' }) }
  }
  let retired = false
  try {
    const birth = await boundOpenCodeRead(port.readBirth(), 1500)
    retired = port.exited() && (birth === null || executionHash(birth) !== executionHash(port.birth))
  } catch (error) { failures.push({ error, phase: 'read-birth' }) }
  let kernel: unknown
  try { kernel = await boundOpenCodeRead(port.retireOwnedDescendants(), executionPlatformRetirementBudgetMs()) } catch (error) { failures.push({ error, phase: 'kernel-retirement' }) }
  if (failures.length > 0) {
    fail(failures[0]!.phase, failures[0]!.error)
  }
  if (!retired) fail('process-retirement')
  if (!port.acknowledged()) fail('closed-ack')
  let evidence: ReturnType<typeof requireExecutionPlatformRetirement>
  try { evidence = requireExecutionPlatformRetirement(kernel) }
  catch (error) { fail('kernel-proof', error) }
  if (evidence.pid !== port.pid || executionHash(evidence.birth) !== executionHash(port.birth)) fail('kernel-binding')
  const receipt: ExecutionCleanupReceipt = Object.freeze({ scopeClosed: true, processRetired: true,
    descendantsRetired: true, pid: evidence.pid, birth: evidence.birth })
  cleanupReceipts.add(receipt)
  return receipt
}
