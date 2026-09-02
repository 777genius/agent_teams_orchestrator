/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import { readFile } from 'node:fs/promises'

import { executeOpenCodeBridgeCommandEnvelope } from '../../services/opencode/OpenCodeBridgeCommandHandler.js'
import { openCodeHostManager } from '../../services/opencode/OpenCodeHostManager.js'
import { openCodeSessionStore } from '../../services/opencode/OpenCodeSessionStore.js'
import { writeFileAtomic } from '../../utils/atomicWrite.js'
import { jsonStringify } from '../../utils/slowOperations.js'

const STDOUT_DRAIN_FALLBACK_TIMEOUT_MS = 2_000
export const OPENCODE_COMMAND_KEEPALIVE_INTERVAL_MS = 1_000
export const OPENCODE_COMMAND_FORCE_EXIT_TIMEOUT_MS = 5_000
export const OPENCODE_COMMAND_FORCE_EXIT_RESERVE_MS = 500
export const OPENCODE_COMMAND_CLEANUP_TIMEOUT_MS = OPENCODE_COMMAND_FORCE_EXIT_TIMEOUT_MS
  - OPENCODE_COMMAND_FORCE_EXIT_RESERVE_MS

type RuntimeCommandTimer = ReturnType<typeof setInterval>
type RuntimeCommandSetInterval = (callback: () => void, ms: number) => RuntimeCommandTimer
type RuntimeCommandClearInterval = (timer: RuntimeCommandTimer) => void
type RuntimeCommandTimeout = ReturnType<typeof setTimeout>
type RuntimeCommandSetTimeout = (callback: () => void, ms: number) => RuntimeCommandTimeout
type RuntimeCommandClearTimeout = (timer: RuntimeCommandTimeout) => void

export function startRuntimeCommandKeepAlive(deps: {
  setInterval?: RuntimeCommandSetInterval
  clearInterval?: RuntimeCommandClearInterval
} = {}): () => void {
  const setIntervalFn = deps.setInterval ?? setInterval
  const clearIntervalFn = deps.clearInterval ?? clearInterval
  const timer = setIntervalFn(() => undefined, OPENCODE_COMMAND_KEEPALIVE_INTERVAL_MS)
  let cleared = false
  return () => {
    if (cleared) {
      return
    }
    cleared = true
    clearIntervalFn(timer)
  }
}

export async function drainRuntimeOpenCodeCommandCleanup(deps: {
  disposeUnregisteredOwnedHosts?: () => Promise<void>
  drainPendingLateLockReleases?: () => Promise<void>
  setTimeout?: RuntimeCommandSetTimeout
  clearTimeout?: RuntimeCommandClearTimeout
  timeoutMs?: number
  onTimeout?: (timeoutMs: number) => void
} = {}): Promise<void> {
  const disposeUnregisteredOwnedHosts = deps.disposeUnregisteredOwnedHosts
    ?? (() => openCodeHostManager.disposeUnregisteredOwnedHosts())
  const drainPendingLateLockReleases = deps.drainPendingLateLockReleases
    ?? (() => openCodeSessionStore.drainPendingLateLockReleases())
  const setTimeoutFn = deps.setTimeout ?? setTimeout
  const clearTimeoutFn = deps.clearTimeout ?? clearTimeout
  const timeoutMs = deps.timeoutMs ?? OPENCODE_COMMAND_CLEANUP_TIMEOUT_MS
  const onTimeout = deps.onTimeout ?? (elapsedMs => {
    console.warn('[opencode-command] Cancellation cleanup timed out after ' + elapsedMs + 'ms')
  })
  let timeout: RuntimeCommandTimeout | undefined

  try {
    const outcome = await Promise.race([
      Promise.all([
        disposeUnregisteredOwnedHosts().catch(() => undefined),
        drainPendingLateLockReleases(),
      ]).then(() => 'completed' as const),
      new Promise<'timed_out'>(resolve => {
        timeout = setTimeoutFn(() => resolve('timed_out'), timeoutMs)
        timeout.unref?.()
      }),
    ])
    if (outcome === 'timed_out') onTimeout(timeoutMs)
  } finally {
    if (timeout) clearTimeoutFn(timeout)
  }
}

export async function runtimeOpenCodeCommand(opts: {
  input: string
  json?: boolean
  output?: string
}): Promise<void> {
  const commandController = new AbortController()
  let signalCleanupPromise: Promise<void> | null = null
  const cleanupUnregisteredHostsAndExit = (exitCode: number): void => {
    if (signalCleanupPromise) {
      return
    }
    commandController.abort(new Error(`OpenCode runtime command cancelled by signal (${exitCode})`))
    const watchdog = setTimeout(() => process.exit(exitCode), OPENCODE_COMMAND_FORCE_EXIT_TIMEOUT_MS)
    watchdog.unref?.()
    signalCleanupPromise = drainRuntimeOpenCodeCommandCleanup()
      .finally(() => {
        clearTimeout(watchdog)
        process.exit(exitCode)
      })
  }
  const onSigterm = () => cleanupUnregisteredHostsAndExit(143)
  const onSigint = () => cleanupUnregisteredHostsAndExit(130)
  process.once('SIGTERM', onSigterm)
  process.once('SIGINT', onSigint)
  const stopKeepAlive = startRuntimeCommandKeepAlive()

  try {
    const raw = await readFile(opts.input, 'utf8')
    const envelope = JSON.parse(raw) as unknown
    const result = await executeOpenCodeBridgeCommandEnvelope(envelope, {
      signal: commandController.signal,
    })
    if (signalCleanupPromise) {
      await signalCleanupPromise
      return
    }
    const payload = jsonStringify(result) + '\n'
    if (opts.output?.trim()) {
      await writeOutputFileAtomically(opts.output.trim(), payload)
    } else {
      await writeStdoutAndDrain(payload)
    }
  } finally {
    stopKeepAlive()
    process.off('SIGTERM', onSigterm)
    process.off('SIGINT', onSigint)
  }
  process.exit(0)
}

async function writeOutputFileAtomically(outputPath: string, payload: string): Promise<void> {
  await writeFileAtomic(outputPath, payload)
}

function writeStdoutAndDrain(payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      process.stdout.off('drain', onDrain)
    }
    const finish = (error?: Error | null) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve()
    }
    const onDrain = () => finish()
    timer = setTimeout(() => finish(), STDOUT_DRAIN_FALLBACK_TIMEOUT_MS)
    timer.unref?.()
    process.stdout.write(payload, error => {
      finish(error)
    })
    process.stdout.once('drain', onDrain)
  })
}
