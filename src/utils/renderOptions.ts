import { openSync } from 'fs'
import { Writable } from 'node:stream'
import { ReadStream } from 'tty'
import type { RenderOptions } from '../ink.js'
import { isEnvTruthy } from './envUtils.js'
import { logError } from './log.js'

// Cached stdin override - computed once per process
let cachedStdinOverride: ReadStream | undefined | null = null
let cachedHeadlessStdout: NodeJS.WriteStream | undefined
const TEAMMATE_RUNTIME_ENV = 'CLAUDE_CODE_TEAMMATE_RUNTIME'

export function shouldSkipStdinOverrideForHeadlessTeammate(
  teammateRuntimeEnv: string | undefined = process.env[TEAMMATE_RUNTIME_ENV],
): boolean {
  return teammateRuntimeEnv === 'headless'
}

/**
 * Gets a ReadStream for /dev/tty when stdin is piped.
 * This allows interactive Ink rendering even when stdin is a pipe.
 * Result is cached for the lifetime of the process.
 */
function getStdinOverride(): ReadStream | undefined {
  // Return cached result if already computed
  if (cachedStdinOverride !== null) {
    return cachedStdinOverride
  }

  // Headless process teammates have their own stdin handling and must not try
  // to recover an interactive terminal before startup readiness is emitted.
  if (shouldSkipStdinOverrideForHeadlessTeammate()) {
    cachedStdinOverride = undefined
    return undefined
  }

  // No override needed if stdin is already a TTY
  if (process.stdin.isTTY) {
    cachedStdinOverride = undefined
    return undefined
  }

  // Skip in CI environments
  if (isEnvTruthy(process.env.CI)) {
    cachedStdinOverride = undefined
    return undefined
  }

  // Skip if running MCP (input hijacking breaks MCP)
  if (process.argv.includes('mcp')) {
    cachedStdinOverride = undefined
    return undefined
  }

  // No /dev/tty on Windows
  if (process.platform === 'win32') {
    cachedStdinOverride = undefined
    return undefined
  }

  // Try to open /dev/tty as an alternative input source
  try {
    const ttyFd = openSync('/dev/tty', 'r')
    const ttyStream = new ReadStream(ttyFd)
    // Explicitly set isTTY to true since we know /dev/tty is a TTY.
    // This is needed because some runtimes (like Bun's compiled binaries)
    // may not correctly detect isTTY on ReadStream created from a file descriptor.
    ttyStream.isTTY = true
    cachedStdinOverride = ttyStream
    return cachedStdinOverride
  } catch (err) {
    logError(err as Error)
    cachedStdinOverride = undefined
    return undefined
  }
}

/**
 * Returns base render options for Ink, including stdin override when needed.
 * Use this for all render() calls to ensure piped input works correctly.
 *
 * @param exitOnCtrlC - Whether to exit on Ctrl+C (usually false for dialogs)
 */
export function getBaseRenderOptions(
  exitOnCtrlC: boolean = false,
): RenderOptions {
  const stdin = getStdinOverride()
  const options: RenderOptions = { exitOnCtrlC }
  if (stdin) {
    options.stdin = stdin
  }
  return options
}

function getHeadlessTeammateStdout(): NodeJS.WriteStream {
  if (cachedHeadlessStdout) {
    return cachedHeadlessStdout
  }

  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  }) as NodeJS.WriteStream & {
    isTTY?: boolean
    columns?: number
    rows?: number
  }
  stream.isTTY = false
  stream.columns = process.stdout.columns || 80
  stream.rows = process.stdout.rows || 24
  cachedHeadlessStdout = stream
  return cachedHeadlessStdout
}

export function getHeadlessTeammateRenderOptions(
  options: RenderOptions,
): RenderOptions {
  return {
    ...options,
    stdout: getHeadlessTeammateStdout(),
    patchConsole: false,
  }
}
