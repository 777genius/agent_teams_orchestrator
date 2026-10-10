import { executionAssert, executionHash } from '../execution/OpenCodeV2ExecutionContracts.js'
import { readExecutionBirth, type ExecutionBirth } from './OpenCodeV2ExecutionBinding.js'
import { isKernelRetirement, planLinuxExecution } from './OpenCodeV2ExecutionLauncher.js'

// Only plans minted by the concrete Linux launcher are callable. No callback or
// structural receipt can qualify a process group/ancestry sampler as containment.
export const requireExecutionContainmentQualification = planLinuxExecution

/** Compatibility cleanup for an older, uncontained child remains UNKNOWN. */
export async function captureExecutionGroup(pid: number, birth: ExecutionBirth) {
  executionAssert(process.platform === 'linux', 'execution_containment_platform_pending')
  executionAssert(Number.isSafeInteger(pid) && pid > 0 && birth.format === 'linux-start-ticks' &&
    birth.bootId !== null, 'execution_containment_unavailable')
  const current = await readExecutionBirth(pid)
  executionAssert(current !== null && executionHash(current) === executionHash(birth), 'execution_containment_unavailable')
  return Object.freeze({ async retire(): Promise<never> { throw new Error('cleanup_unknown') } })
}

export function requireExecutionContainmentRetirement(value?: unknown) {
  executionAssert(isKernelRetirement(value) && value.scopeClosed, 'cleanup_unknown')
  return value
}
