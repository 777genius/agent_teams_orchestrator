import type { EventEmitter } from 'node:events'
import { executionAssert } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { ExecutionBirth } from './OpenCodeV2ExecutionBinding.js'
import { isKernelRetirement, isLinuxExecutionMapping, launchLinuxExecution, linuxBirth,
  planLinuxExecution, prepareLinuxExecutionChild } from './OpenCodeV2ExecutionLauncher.js'
import { darwinBirth, darwinSelfBirth, isDarwinExecutionMapping, isDarwinKernelRetirement, launchDarwinExecution,
  planDarwinExecution, prepareDarwinExecutionChild } from './darwin/OpenCodeV2DarwinExecution.js'

import { isWindowsExecutionMapping, isWindowsKernelRetirement, launchWindowsExecution,
  planWindowsExecution, windowsBirth } from './windows/OpenCodeV2WindowsExecution.js'
import { prepareWindowsExecutionChild, windowsExecutionSelfBirth } from './windows/OpenCodeV2WindowsChildControl.js'

/** The host consumes only these common observations. Their authority remains in
 * the concrete adapter's private plan, mapping and kernel-retirement sets. */
export type ExecutionPlatformMapping = Readonly<{
  bun: Readonly<{ hostPID: number; nativePID: number; birth: ExecutionBirth; executablePath: string; executableSha256: string }>
  namespace: Readonly<{ name: string }>; leaseOwnerId: string
}>
export type ExecutionPlatformLaunch = Readonly<{
  output?(): Readonly<{ stdout: string; stderr: string }>
  fetch?: (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => Promise<Response>
  child: Pick<EventEmitter, 'on' | 'once'> & Readonly<{ pid?: number }>
  prepare(deadline: number, signal?: AbortSignal): Promise<ExecutionPlatformMapping>
  start(payload: Readonly<Record<string, unknown>>, deadline: number, signal?: AbortSignal): Promise<void>
  assertLive(): Promise<void>; sendClose(): void; acknowledged(): boolean
  kill(): void | Promise<void>; retire(): Promise<unknown>
}>
type ExecutionPlatformPlan =
  | Readonly<{ platform: 'linux'; concrete: Awaited<ReturnType<typeof planLinuxExecution>> }>
  | Readonly<{ platform: 'darwin'; concrete: Awaited<ReturnType<typeof planDarwinExecution>> }>
  | Readonly<{ platform: 'win32'; concrete: Awaited<ReturnType<typeof planWindowsExecution>> }>

// Closed composition, not a caller-registerable adapter registry. Unsupported
// systems cannot cross admission before native containment and delivery exist.
export function isExecutionPlatformAvailable(): boolean {
  return process.platform === 'linux' || process.platform === 'darwin' ||
    process.platform === 'win32' && process.arch === 'x64'
}
export function assertExecutionPlatformAvailable(): void {
  executionAssert(isExecutionPlatformAvailable(), 'execution_containment_platform_pending')
}
export async function planExecutionPlatform(input: Parameters<typeof planLinuxExecution>[0] & Readonly<{ profileDirectories?: readonly string[] }>): Promise<ExecutionPlatformPlan> {
  assertExecutionPlatformAvailable()
  if (process.platform === 'win32') return Object.freeze({ platform: 'win32', concrete: await planWindowsExecution(input) })
  if (process.platform === 'darwin') return Object.freeze({ platform: 'darwin', concrete: await planDarwinExecution(input) })
  return Object.freeze({ platform: 'linux', concrete: await planLinuxExecution(input) })
}
export function launchExecutionPlatform(plan: ExecutionPlatformPlan, nonce: string, leaseOwnerId: string,
  bun: Readonly<{ path: string; sha256: string }>, deadline: number): ExecutionPlatformLaunch {
  executionAssert(plan.platform === process.platform, 'execution_containment_unqualified')
  if (plan.platform === 'win32') return launchWindowsExecution(plan.concrete, nonce, leaseOwnerId, bun, deadline)
  if (plan.platform === 'darwin') return launchDarwinExecution(plan.concrete, nonce, leaseOwnerId, bun)
  return launchLinuxExecution(plan.concrete, nonce, leaseOwnerId, bun)
}
export function isExecutionPlatformMapping(value: unknown): value is ExecutionPlatformMapping {
  return process.platform === 'linux' ? isLinuxExecutionMapping(value) :
    process.platform === 'win32' ? isWindowsExecutionMapping(value) : process.platform === 'darwin' && isDarwinExecutionMapping(value)
}
export function requireExecutionPlatformRetirement(value: unknown) {
  const owned = process.platform === 'linux' ? isKernelRetirement(value) :
    process.platform === 'win32' ? isWindowsKernelRetirement(value) : process.platform === 'darwin' && isDarwinKernelRetirement(value)
  executionAssert(owned, 'cleanup_unknown')
  const evidence = value as Readonly<{ pid: number; birth: ExecutionBirth; scopeClosed: boolean }>
  executionAssert(evidence.scopeClosed, 'cleanup_unknown')
  return evidence
}
/** Darwin allows 12 seconds for kernel reaping, then 3 for the observer exit.
 * The outer wait includes a final second for receipt publication and cleanup.
 * This is selected by composition, never supplied by a retirement caller. */
export function executionPlatformRetirementBudgetMs(): number {
  assertExecutionPlatformAvailable()
  return process.platform === 'darwin' || process.platform === 'win32' ? 16_000 : 4000
}
export async function readExecutionPlatformBirth(pid: number): Promise<ExecutionBirth | null> {
  assertExecutionPlatformAvailable()
  if (process.platform === 'win32') return pid === process.pid && process.env.OPENCODE_V2_WINDOWS_PIPE ? windowsExecutionSelfBirth() : windowsBirth(pid)
  return process.platform === 'darwin' ? (pid === process.pid ? darwinSelfBirth() : darwinBirth(pid)) : linuxBirth(pid)
}
export async function prepareExecutionPlatformChild(value: unknown) {
  assertExecutionPlatformAvailable()
  if (process.platform === 'win32') return prepareWindowsExecutionChild(value)
  return process.platform === 'darwin' ? prepareDarwinExecutionChild(value) : prepareLinuxExecutionChild(value)
}
