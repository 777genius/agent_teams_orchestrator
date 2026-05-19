/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import { readFile, writeFile } from 'node:fs/promises'

import { executeOpenCodeBridgeCommandEnvelope } from '../../services/opencode/OpenCodeBridgeCommandHandler.js'
import { openCodeHostManager } from '../../services/opencode/OpenCodeHostManager.js'
import { jsonStringify } from '../../utils/slowOperations.js'

const STDOUT_DRAIN_FALLBACK_TIMEOUT_MS = 2_000

export async function runtimeOpenCodeCommand(opts: {
  input: string
  json?: boolean
  output?: string
}): Promise<void> {
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

  try {
    const raw = await readFile(opts.input, 'utf8')
    const envelope = JSON.parse(raw) as unknown
    const result = await executeOpenCodeBridgeCommandEnvelope(envelope)
    if (signalCleanupPromise) {
      await signalCleanupPromise
      return
    }
    const payload = jsonStringify(result) + '\n'
    if (opts.output?.trim()) {
      await writeFile(opts.output.trim(), payload, 'utf8')
    } else {
      await writeStdoutAndDrain(payload)
    }
  } finally {
    process.off('SIGTERM', onSigterm)
    process.off('SIGINT', onSigint)
  }
  process.exit(0)
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
