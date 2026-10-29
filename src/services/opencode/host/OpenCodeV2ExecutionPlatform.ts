import type { EventEmitter } from 'node:events'
import { executionAssert } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { ExecutionCleanupClosedFrame, ExecutionCommandObservation } from '../execution/OpenCodeV2Diagnostics.js'
import type { ExecutionBirth } from './OpenCodeV2ExecutionBinding.js'
import { isPlainExecutionMapping, isPlainExecutionRetirement, launchPlainExecution, planPlainExecution,
  preparePlainExecutionChild, readPlainExecutionBirth, type PlainExecutionMapping, type PlainExecutionPlan } from './OpenCodeV2PlainExecution.js'

/** The host consumes only these common observations of the execution child. */
export type ExecutionPlatformMapping = PlainExecutionMapping
export type ExecutionPlatformLaunch = Readonly<{
  output?(): Readonly<{ stdout: string; stderr: string }>
  /** Diagnostic-only native command channel snapshot; grants no authority. */
  commands?(): ExecutionCommandObservation
  child: Pick<EventEmitter, 'on' | 'once'> & Readonly<{ pid?: number }>
  prepare(deadline: number, signal?: AbortSignal): Promise<ExecutionPlatformMapping>
  start(payload: Readonly<Record<string, unknown>>, deadline: number, signal?: AbortSignal): Promise<void>
  assertLive(): Promise<void>; sendClose(): void; acknowledged(): boolean
  /** Diagnostic only: how the owner reader observed the closed ACK frame. */
  closedObservation?(): ExecutionCleanupClosedFrame
  readBirth?(): Promise<ExecutionBirth | null>
  kill(deadline?: number): void | Promise<void>; retire(deadline?: number): Promise<unknown>
}>
type ExecutionPlatformPlan = Readonly<{ platform: NodeJS.Platform; concrete: PlainExecutionPlan }>

// V2 execution runs as an ordinary child process on every platform it ships for.
export function isExecutionPlatformAvailable(): boolean {
  return process.platform === 'linux' || process.platform === 'darwin' ||
    process.platform === 'win32' && (process.arch === 'x64' || process.arch === 'arm64')
}
export function assertExecutionPlatformAvailable(): void {
  executionAssert(isExecutionPlatformAvailable(), 'execution_platform_unsupported')
}
export async function planExecutionPlatform(input: Parameters<typeof planPlainExecution>[0]): Promise<ExecutionPlatformPlan> {
  assertExecutionPlatformAvailable()
  return Object.freeze({ platform: process.platform, concrete: await planPlainExecution(input) })
}
export function launchExecutionPlatform(plan: ExecutionPlatformPlan, nonce: string, leaseOwnerId: string,
  bun: Readonly<{ path: string; sha256: string }>): ExecutionPlatformLaunch {
  executionAssert(plan.platform === process.platform, 'execution_platform_unsupported')
  return launchPlainExecution(plan.concrete, nonce, leaseOwnerId, bun)
}
export function isExecutionPlatformMapping(value: unknown): value is ExecutionPlatformMapping {
  return isPlainExecutionMapping(value)
}
/** A spawn without a committed child identity may only claim that its process exited. */
export type ExecutionUnboundRetirement = Readonly<{ pid: number; scopeClosed: boolean }>
export function isExecutionUnboundRetirement(value: unknown): value is ExecutionUnboundRetirement {
  return isPlainExecutionRetirement(value)
}
export function requireExecutionPlatformRetirement(value: unknown) {
  executionAssert(isPlainExecutionRetirement(value), 'cleanup_unknown')
  executionAssert(value.scopeClosed, 'cleanup_unknown')
  return value
}
/** The child tree kill and exit wait run inside this budget. */
export function executionPlatformRetirementBudgetMs(): number {
  assertExecutionPlatformAvailable()
  return 8000
}
export async function readExecutionPlatformBirth(pid: number): Promise<ExecutionBirth | null> {
  assertExecutionPlatformAvailable()
  return readPlainExecutionBirth(pid)
}
export async function prepareExecutionPlatformChild(value: unknown) {
  assertExecutionPlatformAvailable()
  return preparePlainExecutionChild(value)
}
