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
  onDisposeError?: (error: unknown) => void
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
  const onDisposeError = deps.onDisposeError ?? (() => {
    console.warn('[opencode-command] Failed to dispose unregistered owned OpenCode hosts')
  })
  let timeout: RuntimeCommandTimeout | undefined

  try {
    const outcome = await Promise.race([
      Promise.all([
        disposeUnregisteredOwnedHosts().catch(error => { onDisposeError(error) }),
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

type RuntimeOpenCodeCommandDeps = {
  readInput?: (path: string) => Promise<string>
  executeEnvelope?: typeof executeOpenCodeBridgeCommandEnvelope
  writePayload?: (opts: { output?: string }, payload: string) => Promise<void>
  drainCleanup?: () => Promise<void>
  exit?: (code: number) => void
  setTimeout?: RuntimeCommandSetTimeout
  clearTimeout?: RuntimeCommandClearTimeout
  onSignal?: (signal: 'SIGTERM' | 'SIGINT', listener: () => void) => void
  offSignal?: (signal: 'SIGTERM' | 'SIGINT', listener: () => void) => void
}

export async function runtimeOpenCodeCommand(opts: {
  input: string
  json?: boolean
  output?: string
}, deps: RuntimeOpenCodeCommandDeps = {}): Promise<void> {
  const readInput = deps.readInput ?? (path => readFile(path, 'utf8'))
  const executeEnvelope = deps.executeEnvelope ?? executeOpenCodeBridgeCommandEnvelope
  const writePayload = deps.writePayload ?? (async (commandOpts, payload) => {
    if (commandOpts.output?.trim()) {
      await writeOutputFileAtomically(commandOpts.output.trim(), payload)
    } else {
      await writeStdoutAndDrain(payload)
    }
  })
  const drainCleanup = deps.drainCleanup ?? drainRuntimeOpenCodeCommandCleanup
  const exit = deps.exit ?? (code => process.exit(code))
  const setTimeoutFn = deps.setTimeout ?? setTimeout
  const clearTimeoutFn = deps.clearTimeout ?? clearTimeout
  const onSignal = deps.onSignal ?? ((signal, listener) => process.once(signal, listener))
  const offSignal = deps.offSignal ?? ((signal, listener) => process.off(signal, listener))
  const commandController = new AbortController()
  let signalCleanupPromise: Promise<void> | null = null
  let cleanupPromise: Promise<void> | null = null
  const drainCleanupOnce = (): Promise<void> => {
    cleanupPromise ??= drainCleanup()
    return cleanupPromise
  }
  const cleanupUnregisteredHostsAndExit = (exitCode: number): void => {
    if (signalCleanupPromise) {
      return
    }
    commandController.abort(new Error(`OpenCode runtime command cancelled by signal (${exitCode})`))
    const watchdog = setTimeoutFn(() => exit(exitCode), OPENCODE_COMMAND_FORCE_EXIT_TIMEOUT_MS)
    watchdog.unref?.()
    signalCleanupPromise = drainCleanupOnce()
      .finally(() => {
        clearTimeoutFn(watchdog)
        exit(exitCode)
      })
  }
  const onSigterm = () => cleanupUnregisteredHostsAndExit(143)
  const onSigint = () => cleanupUnregisteredHostsAndExit(130)
  onSignal('SIGTERM', onSigterm)
  onSignal('SIGINT', onSigint)
  const stopKeepAlive = startRuntimeCommandKeepAlive()

  try {
    const raw = await readInput(opts.input)
    const envelope = JSON.parse(raw) as unknown
    const result = await executeEnvelope(envelope, {
      signal: commandController.signal,
    })
    if (signalCleanupPromise) {
      await signalCleanupPromise
      return
    }
    const payload = jsonStringify(result) + '\n'
    await writePayload(opts, payload)
  } finally {
    stopKeepAlive()
    offSignal('SIGTERM', onSigterm)
    offSignal('SIGINT', onSigint)
    await drainCleanupOnce()
  }
  exit(0)
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
