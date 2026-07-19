import type { ChildProcess } from 'node:child_process'

import { spawnPortableCli } from '../../utils/portableCli.js'
import { killProcessTree } from '../../utils/processKill.js'
import { waitForOpenCodeAbortableDelay } from './OpenCodeRuntimeDeadline.js'

const DEFAULT_CURSOR_NATIVE_FAILURE_PROBE_DELAY_MS = 2_000
const DEFAULT_CURSOR_NATIVE_FAILURE_PROBE_TIMEOUT_MS = 65_000
const DEFAULT_CURSOR_NATIVE_FAILURE_PROBE_FORCE_KILL_DELAY_MS = 2_000
const CURSOR_NATIVE_FAILURE_PROBE_TIMEOUT_ENV =
  'AGENT_TEAMS_OPENCODE_CURSOR_NATIVE_FAILURE_PROBE_TIMEOUT_MS'
const CURSOR_NATIVE_FAILURE_PROBE_MAX_OUTPUT_CHARS = 64 * 1024
const CURSOR_NATIVE_FAILURE_PROBE_MAX_MESSAGE_CHARS = 2 * 1024
const CURSOR_NATIVE_FAILURE_PROBE_PROMPT = 'Output only the single word PONG.'
const CURSOR_TERMINAL_FAILURE_PATTERN =
  /\bresource[\s_-]*exhausted(?:error)?\b|\b(?:rate|usage)[\s_-]*limit(?:error)?\b|\bfree[\s_-]*usage[\s_-]*(?:limit|exceeded)(?:error)?\b|\bquota[\s_-]*exceeded(?:error)?\b|\bgrpc[\s_-]*code["']?\s*[:=]\s*["']?8\b|too many requests|^\s*(?:error\s*[:=-]?\s*)?429\b|\b(?:http(?:[\s_-]*status)?|status(?:[\s_-]*code)?|error(?:[\s_-]*code)?|code)["']?\s*(?::|=|is|of)?\s*["']?429\b|\b429\s+(?:too many requests|rate limit(?:ed)?|resource exhausted)\b|authentication (?:failed|required)|not logged in|unauthorized|forbidden|model (?:is )?(?:not supported|not available|unavailable|not found)/im
const CURSOR_RETRYABLE_FAILURE_PATTERN =
  /\bconnection reset by (?:server|peer)\b|\bcannot connect to (?:the )?api\b|\bunable to connect to (?:the )?api\b/im
const CURSOR_QUOTED_SECRET_ASSIGNMENT_PATTERN =
  /(\b(?:[A-Z0-9_]*(?:API[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|SECRET|PASSWORD)[A-Z0-9_]*|authorization)\b["']?\s*[:=]\s*)(["'])[^"']*\2/gi
const CURSOR_SECRET_ASSIGNMENT_PATTERN =
  /(\b(?:[A-Z0-9_]*(?:API[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|SECRET|PASSWORD)[A-Z0-9_]*|authorization)\b["']?\s*[:=]\s*)(?!["'])[^"',}\s]+/gi
const CURSOR_SECRET_FLAG_PATTERN =
  /(^|\s)((?:--)?(?:api-key|token|password|secret|authorization|auth-token)(?:=|\s+))(?!["'])[^"'\s]+/gi
const CURSOR_BEARER_TOKEN_PATTERN = /\bBearer\s+[^"'\s,}]+/gi
const CURSOR_SECRET_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{12,}\b/g

export type OpenCodeCursorNativeProbeResult = {
  outcome: 'available' | 'failure' | 'retryable' | 'timeout'
  message: string | null
  durationMs: number
  exitCode: number | null
}

type OpenCodeCursorNativeFailureProbeDeps = {
  spawnProcess?: typeof spawnPortableCli
  killProcess?: typeof killProcessTree
  delayMs?: number
  timeoutMs?: number
  forceKillDelayMs?: number
  now?: () => number
}

function normalizePositiveMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback
}

function appendOutputTail(current: string, chunk: unknown): string {
  return `${current}${String(chunk)}`.slice(-CURSOR_NATIVE_FAILURE_PROBE_MAX_OUTPUT_CHARS)
}

function combinedCursorOutput(stderr: string, stdout: string): string {
  return [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
}

function redactCursorFailureMessage(value: string): string {
  return value
    .replace(CURSOR_QUOTED_SECRET_ASSIGNMENT_PATTERN, '$1$2[redacted]$2')
    .replace(CURSOR_SECRET_ASSIGNMENT_PATTERN, '$1[redacted]')
    .replace(CURSOR_SECRET_FLAG_PATTERN, '$1$2[redacted]')
    .replace(CURSOR_BEARER_TOKEN_PATTERN, 'Bearer [redacted]')
    .replace(CURSOR_SECRET_KEY_PATTERN, '[redacted-api-key]')
}

function extractCursorFailureMessage(
  stderr: string,
  stdout: string,
  pattern: RegExp,
): string | null {
  const combined = combinedCursorOutput(stderr, stdout)
  if (!combined) return null
  const match = pattern.exec(combined)
  if (match?.index === undefined) return null
  const lineStart = combined.lastIndexOf('\n', Math.max(0, match.index - 1)) + 1
  const nextLineBreak = combined.indexOf('\n', match.index)
  const lineEnd = nextLineBreak === -1 ? combined.length : nextLineBreak
  const line = combined.slice(lineStart, lineEnd)
  const matchOffset = Math.max(0, match.index - lineStart)
  const excerptStart = Math.max(0, matchOffset - 256)
  return redactCursorFailureMessage(
    line.slice(
      excerptStart,
      excerptStart + CURSOR_NATIVE_FAILURE_PROBE_MAX_MESSAGE_CHARS,
    ).trim(),
  )
}

function extractCursorTerminalFailureMessage(
  stderr: string,
  stdout: string,
): string | null {
  return extractCursorFailureMessage(stderr, stdout, CURSOR_TERMINAL_FAILURE_PATTERN)
}

function extractCursorRetryableFailureMessage(
  stderr: string,
  stdout: string,
): string | null {
  return extractCursorFailureMessage(stderr, stdout, CURSOR_RETRYABLE_FAILURE_PATTERN)
}

function buildCursorFailureMessage(
  stderr: string,
  stdout: string,
  exitCode: number | null,
): string | null {
  const terminalFailure = extractCursorTerminalFailureMessage(stderr, stdout)
  if (terminalFailure) return terminalFailure
  const combined = combinedCursorOutput(stderr, stdout)
  if (!combined) return null
  return exitCode === 0
    ? null
    : redactCursorFailureMessage(
        combined.slice(-CURSOR_NATIVE_FAILURE_PROBE_MAX_MESSAGE_CHARS).trim(),
      )
}

function hasCursorSuccessfulTerminalResult(stdout: string): boolean {
  const lines = stdout.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim()
    if (!line) continue
    try {
      const event = JSON.parse(line) as Record<string, unknown>
      if (event.type !== 'result') continue
      return (
        (event.subtype === undefined || event.subtype === 'success')
        && event.is_error !== true
        && typeof event.result === 'string'
        && event.result.trim().length > 0
      )
    } catch {
      // Ignore non-NDJSON CLI noise. Success still requires a terminal result event.
    }
  }
  return false
}

function releaseChildHandles(child: ChildProcess): void {
  child.stdin?.destroy()
  child.stdout?.destroy()
  child.stderr?.destroy()
  child.unref?.()
}

function cursorModelId(selectedModel: string): string | null {
  const prefix = 'cursor-acp/'
  if (!selectedModel.startsWith(prefix)) return null
  return selectedModel.slice(prefix.length).trim() || 'auto'
}

export class OpenCodeCursorNativeFailureProbe {
  constructor(private readonly deps: OpenCodeCursorNativeFailureProbeDeps = {}) {}

  async probe(input: {
    selectedModel: string
    projectPath: string
    env?: NodeJS.ProcessEnv
    signal?: AbortSignal
    delayMs?: number
  }): Promise<OpenCodeCursorNativeProbeResult | null> {
    const modelId = cursorModelId(input.selectedModel)
    if (!modelId || input.signal?.aborted) return null

    const startedAtMs = (this.deps.now ?? Date.now)()
    const delayMs = Math.max(
      0,
      input.delayMs
        ?? this.deps.delayMs
        ?? DEFAULT_CURSOR_NATIVE_FAILURE_PROBE_DELAY_MS,
    )
    if (delayMs > 0) {
      await waitForOpenCodeAbortableDelay(delayMs, input.signal).catch(() => undefined)
      if (input.signal?.aborted) return null
    }

    const env = input.env ?? process.env
    const executable = env.CURSOR_AGENT_EXECUTABLE?.trim() || 'cursor-agent'
    const timeoutMs = Math.max(
      1,
      this.deps.timeoutMs
        ?? normalizePositiveMs(
          env[CURSOR_NATIVE_FAILURE_PROBE_TIMEOUT_ENV],
          DEFAULT_CURSOR_NATIVE_FAILURE_PROBE_TIMEOUT_MS,
        ),
    )
    let child: ChildProcess
    try {
      child = (this.deps.spawnProcess ?? spawnPortableCli)(
        executable,
        [
          '--print',
          '--output-format',
          'stream-json',
          '--stream-partial-output',
          '--trust',
          '--mode',
          'ask',
          '--workspace',
          input.projectPath,
          '--model',
          modelId,
        ],
        {
          cwd: input.projectPath,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      )
    } catch {
      return null
    }

    return await new Promise<OpenCodeCursorNativeProbeResult | null>(resolve => {
      let stdout = ''
      let stderr = ''
      let settled = false
      let childExited = false
      let timer: ReturnType<typeof setTimeout> | null = null
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null
      let terminationRequested = false
      const clearForceKillTimer = () => {
        if (!forceKillTimer) return
        clearTimeout(forceKillTimer)
        forceKillTimer = null
      }
      const signalChild = (signal: NodeJS.Signals) => {
        if (child.pid) {
          const killProcess = this.deps.killProcess ?? killProcessTree
          killProcess(child.pid, signal)
          return
        }
        try {
          child.kill(signal)
        } catch {
          // Best-effort cleanup for a child that failed before receiving a PID.
        }
      }
      const requestTermination = () => {
        if (terminationRequested || childExited) return
        terminationRequested = true
        signalChild('SIGTERM')
        const forceKillDelayMs = Math.max(
          0,
          this.deps.forceKillDelayMs
            ?? DEFAULT_CURSOR_NATIVE_FAILURE_PROBE_FORCE_KILL_DELAY_MS,
        )
        forceKillTimer = setTimeout(() => {
          forceKillTimer = null
          if (
            childExited
            || child.exitCode != null
            || child.signalCode != null
          ) {
            return
          }
          signalChild('SIGKILL')
        }, forceKillDelayMs)
        // Keep a short-lived CLI process alive until the child exits or receives
        // SIGKILL. Unref here could let readiness return while Cursor survives.
      }
      const finish = (result: OpenCodeCursorNativeProbeResult | null) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        input.signal?.removeEventListener('abort', abort)
        resolve(result)
      }
      const abort = () => {
        requestTermination()
        releaseChildHandles(child)
        finish(null)
      }
      const timeout = () => {
        requestTermination()
        releaseChildHandles(child)
        finish({
          outcome: 'timeout',
          message: `Cursor native execution preflight timed out after ${timeoutMs}ms`,
          durationMs: Math.max(0, (this.deps.now ?? Date.now)() - startedAtMs),
          exitCode: child.exitCode,
        })
      }
      const finishTerminalFailure = () => {
        const message = extractCursorTerminalFailureMessage(stderr, stdout)
        if (!message) return
        requestTermination()
        releaseChildHandles(child)
        finish({
          outcome: 'failure',
          message,
          durationMs: Math.max(0, (this.deps.now ?? Date.now)() - startedAtMs),
          exitCode: child.exitCode,
        })
      }
      const finishRetryableFailure = () => {
        const message = extractCursorRetryableFailureMessage(stderr, stdout)
        if (!message) return
        requestTermination()
        releaseChildHandles(child)
        finish({
          outcome: 'retryable',
          message,
          durationMs: Math.max(0, (this.deps.now ?? Date.now)() - startedAtMs),
          exitCode: child.exitCode,
        })
      }
      const finishKnownFailure = () => {
        finishTerminalFailure()
        if (!settled) finishRetryableFailure()
      }
      timer = setTimeout(timeout, timeoutMs)
      timer.unref?.()

      child.stdout?.on('data', chunk => {
        stdout = appendOutputTail(stdout, chunk)
        finishKnownFailure()
      })
      child.stderr?.on('data', chunk => {
        stderr = appendOutputTail(stderr, chunk)
        finishKnownFailure()
      })
      // cursor-agent can exit before stdin is flushed. EPIPE belongs to the
      // child lifecycle and must not become an unhandled process-level error.
      child.stdin?.on('error', () => undefined)
      child.once('error', () => {
        if (child.pid && !childExited) {
          requestTermination()
        } else {
          clearForceKillTimer()
        }
        releaseChildHandles(child)
        finish(null)
      })
      child.once('exit', () => {
        childExited = true
        clearForceKillTimer()
      })
      child.once('close', code => {
        childExited = true
        clearForceKillTimer()
        const retryableMessage = extractCursorRetryableFailureMessage(stderr, stdout)
        if (retryableMessage) {
          finish({
            outcome: 'retryable',
            message: retryableMessage,
            durationMs: Math.max(0, (this.deps.now ?? Date.now)() - startedAtMs),
            exitCode: code,
          })
          return
        }
        const message = buildCursorFailureMessage(stderr, stdout, code)
        if (!message) {
          finish(code === 0 && hasCursorSuccessfulTerminalResult(stdout)
            ? {
                outcome: 'available',
                message: null,
                durationMs: Math.max(0, (this.deps.now ?? Date.now)() - startedAtMs),
                exitCode: code,
              }
            : null)
          return
        }
        finish({
          outcome: 'failure',
          message,
          durationMs: Math.max(0, (this.deps.now ?? Date.now)() - startedAtMs),
          exitCode: code,
        })
      })
      input.signal?.addEventListener('abort', abort, { once: true })
      if (input.signal?.aborted) {
        abort()
        return
      }
      try {
        child.stdin?.end(CURSOR_NATIVE_FAILURE_PROBE_PROMPT)
      } catch {
        abort()
      }
    })
  }
}

export const openCodeCursorNativeFailureProbe = new OpenCodeCursorNativeFailureProbe()
