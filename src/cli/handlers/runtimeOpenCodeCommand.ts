/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import { readFile } from 'node:fs/promises'

const STDOUT_DRAIN_FALLBACK_TIMEOUT_MS = 2_000
export const OPENCODE_COMMAND_KEEPALIVE_INTERVAL_MS = 1_000

type RuntimeCommandTimer = ReturnType<typeof setInterval>
type RuntimeCommandSetInterval = (callback: () => void, ms: number) => RuntimeCommandTimer
type RuntimeCommandClearInterval = (timer: RuntimeCommandTimer) => void

export function startRuntimeCommandKeepAlive(deps: {
  setInterval?: RuntimeCommandSetInterval
  clearInterval?: RuntimeCommandClearInterval
} = {}): () => void {
  const setIntervalFn: RuntimeCommandSetInterval = deps.setInterval ?? setInterval
  const clearIntervalFn: RuntimeCommandClearInterval = deps.clearInterval ?? (timer => {
    clearInterval(timer)
  })
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

export async function runtimeOpenCodeCommand(opts: {
  input: string
  json?: boolean
  output?: string
}): Promise<void> {
  const raw = await readFile(opts.input, 'utf8')
  const envelope = JSON.parse(raw) as unknown
  const passiveCommandStatus = isPassiveCommandStatusEnvelope(envelope)
  if (passiveCommandStatus) {
    const result = await executeRuntimeOpenCodeCommandEnvelope(envelope)
    await writeRuntimeCommandPayload(opts.output, JSON.stringify(result) + '\n')
    process.exit(0)
  }

  const [{ executeOpenCodeBridgeCommandEnvelope }, { openCodeHostManager }] = await Promise.all([
    import('../../services/opencode/OpenCodeBridgeCommandHandler.js'),
    import('../../services/opencode/OpenCodeHostManager.js'),
  ])
  let signalCleanupPromise: Promise<void> | null = null
  const cleanupUnregisteredHostsAndExit = (exitCode: number): void => {
    if (signalCleanupPromise) {
      return
    }
    const watchdog = setTimeout(() => process.exit(exitCode), 5_000)
    watchdog.unref?.()
    signalCleanupPromise = openCodeHostManager.disposeUnregisteredOwnedHosts()
      .catch(() => undefined)
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
    const result = await executeOpenCodeBridgeCommandEnvelope(envelope)
    if (signalCleanupPromise) {
      await signalCleanupPromise
      return
    }
    const { jsonStringify } = await import('../../utils/slowOperations.js')
    await writeRuntimeCommandPayload(opts.output, jsonStringify(result) + '\n')
  } finally {
    stopKeepAlive()
    process.off('SIGTERM', onSigterm)
    process.off('SIGINT', onSigint)
  }
  process.exit(0)
}

export async function executeRuntimeOpenCodeCommandEnvelope(
  envelope: unknown,
  deps: {
    executePassive?: (input: unknown) => Promise<unknown>
    executeActive?: (input: unknown) => Promise<unknown>
  } = {},
): Promise<unknown> {
  if (isPassiveCommandStatusEnvelope(envelope)) {
    const executePassive = deps.executePassive ?? (async input => {
      const { executeOpenCodePassiveCommandStatusEnvelope } = await import(
        '../../services/opencode/OpenCodePassiveCommandStatusRoute.js'
      )
      return executeOpenCodePassiveCommandStatusEnvelope(input)
    })
    return executePassive(envelope)
  }
  const executeActive = deps.executeActive ?? (async input => {
    const { executeOpenCodeBridgeCommandEnvelope } = await import(
      '../../services/opencode/OpenCodeBridgeCommandHandler.js'
    )
    return executeOpenCodeBridgeCommandEnvelope(input)
  })
  return executeActive(envelope)
}

function isPassiveCommandStatusEnvelope(input: unknown): boolean {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    && (input as { command?: unknown }).command === 'opencode.commandStatus'
}

async function writeRuntimeCommandPayload(outputPath: string | undefined, payload: string): Promise<void> {
  if (outputPath?.trim()) {
    const { writeFileAtomic } = await import('../../utils/atomicWrite.js')
    await writeFileAtomic(outputPath.trim(), payload)
    return
  }
  await writeStdoutAndDrain(payload)
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
