import { boundOpenCodeRead } from '../transport/OpenCodeBoundedFetch.js'
import { executionAssert, executionHash, executionRecord } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { ExecutionBirth } from './OpenCodeV2ExecutionBinding.js'
import { executionPlatformRetirementBudgetMs, requireExecutionPlatformRetirement } from './OpenCodeV2ExecutionPlatform.js'

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
  const failures: unknown[] = []
  try { await boundOpenCodeRead(port.disposeTransport(), 3000) } catch (error) { failures.push(error) }
  try { if (!port.exited()) port.sendClose() } catch (error) { failures.push(error) }
  try { await boundOpenCodeRead(port.waitExit, 10_000) } catch {
    try {
      const birth = await boundOpenCodeRead(port.readBirth(), 1500)
      if (!port.exited() && birth !== null && executionHash(birth) === executionHash(port.birth)) await port.kill()
    } catch (error) { failures.push(error) }
    try { await boundOpenCodeRead(port.waitExit, 2000) } catch (error) { failures.push(error) }
  }
  let retired = false
  try {
    const birth = await boundOpenCodeRead(port.readBirth(), 1500)
    retired = port.exited() && (birth === null || executionHash(birth) !== executionHash(port.birth))
  } catch (error) { failures.push(error) }
  let kernel: unknown
  try { kernel = await boundOpenCodeRead(port.retireOwnedDescendants(), executionPlatformRetirementBudgetMs()) } catch (error) { failures.push(error) }
  if (failures.length > 0) throw new Error('cleanup_unknown', { cause: failures[0] })
  executionAssert(retired && port.acknowledged(), 'cleanup_unknown')
  const evidence = requireExecutionPlatformRetirement(kernel)
  executionAssert(evidence.pid === port.pid && executionHash(evidence.birth) === executionHash(port.birth), 'cleanup_unknown')
  const receipt: ExecutionCleanupReceipt = Object.freeze({ scopeClosed: true, processRetired: true,
    descendantsRetired: true, pid: evidence.pid, birth: evidence.birth })
  cleanupReceipts.add(receipt)
  return receipt
}
