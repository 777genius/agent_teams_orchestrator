import { type ChildProcess } from 'node:child_process'
import { PassThrough, type Readable } from 'node:stream'
import readline from 'node:readline'

import {
  resolveCodexCliBinary,
  type CodexCliBinarySource,
  type CodexForcedLoginMethod,
} from '../runtimeBackends/codexBackendResolver.js'
import { killProcessTree } from '../../utils/processKill.js'
import { spawnPortableCli, spawnSyncPortableCli } from '../../utils/portableCli.js'
import { CodexNativeTraceWriter } from './CodexNativeTraceWriter.js'
import { mapCodexNativeExecLine } from './jsonlMapper.js'
import type { CodexNativeNormalizedEvent } from './normalizedEvents.js'

export type CodexNativeExecRunnerOptions = {
  prompt: string
  cwd: string
  model?: string | null
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access' | null
  additionalWritableDirectories?: string[]
  ephemeral?: boolean
  apiKey?: string | null
  forcedLoginMethod?: CodexForcedLoginMethod | null
  configOverrides?: string[]
  disabledFeatures?: string[]
  ignoreUserConfig?: boolean
  abortSignal?: AbortSignal
  timeoutMs?: number | null
  idleTimeoutMs?: number | null
  absoluteTimeoutMs?: number | null
}

export type CodexNativeBinaryIdentity = {
  executablePath: string
  executableSource: CodexCliBinarySource
  version: string | null
}

export type CodexNativeCredentialSource =
  | 'explicit-api-key'
  | 'ambient-process-env'
  | 'none'

export type CodexNativeHistoryCompleteness =
  | 'live-only'
  | 'explicit-hydration-required'

export type CodexNativeFinalUsageAuthority = 'live-turn-completed'

export type CodexNativeExecObservation =
  | {
      type: 'binary_identity'
      identity: CodexNativeBinaryIdentity
    }
  | {
      type: 'normalized_event'
      event: CodexNativeNormalizedEvent
    }

export type CodexNativeExecSummary = {
  identity: CodexNativeBinaryIdentity
  threadId: string | null
  credentialSource: CodexNativeCredentialSource
  completionPolicy: 'ephemeral' | 'persistent'
  finalHistoryCompleteness: CodexNativeHistoryCompleteness
  finalUsageAuthority: CodexNativeFinalUsageAuthority
}

type SpawnedCodexProcess = Pick<
  ChildProcess,
  | 'stdout'
  | 'stderr'
  | 'stdin'
  | 'pid'
  | 'once'
  | 'removeAllListeners'
  | 'kill'
  | 'killed'
>

type CodexNativeExecRunnerDeps = {
  which?: (command: string) => string | null | undefined
  spawnProcess?: (
    executablePath: string,
    args: string[],
    options: {
      cwd: string
      env: NodeJS.ProcessEnv
      signal?: AbortSignal
      detached?: boolean
      stdin: 'pipe'
      stdout: 'pipe'
      stderr: 'pipe'
    },
  ) => SpawnedCodexProcess
  resolveVersion?: (executablePath: string) => string | null
}

type QueuedLine = {
  stream: 'stdout' | 'stderr'
  line: string
}

type CodexNativeStderrFilterState = {
  suppressAnalyticsHtmlContinuation: boolean
}

type CodexNativeExecTimeoutReason =
  | { type: 'idle'; timeoutMs: number }
  | { type: 'absolute'; timeoutMs: number }

function normalizeTimeoutMs(timeoutMs: number | null | undefined): number | null {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
    return null
  }

  const normalized = Math.max(0, Math.floor(timeoutMs))
  return normalized > 0 ? normalized : null
}

export function buildCodexNativeExecArgs(
  options: CodexNativeExecRunnerOptions,
): string[] {
  const args = ['exec', '--json', '--skip-git-repo-check', '-C', options.cwd]

  if (options.ignoreUserConfig) {
    args.push('--ignore-user-config')
  }

  if (options.ephemeral !== false) {
    args.push('--ephemeral')
  }

  if (options.model) {
    args.push('-m', options.model)
  }

  if (options.reasoningEffort) {
    args.push('-c', `model_reasoning_effort="${options.reasoningEffort}"`)
  }

  if (options.forcedLoginMethod) {
    args.push('-c', `forced_login_method="${options.forcedLoginMethod}"`)
  }

  for (const override of options.configOverrides ?? []) {
    args.push('-c', override)
  }

  for (const feature of options.disabledFeatures ?? []) {
    args.push('--disable', feature)
  }

  if (options.sandboxMode) {
    args.push('--sandbox', options.sandboxMode)
  }

  for (const directory of options.additionalWritableDirectories ?? []) {
    args.push('--add-dir', directory)
  }

  args.push('-')
  return args
}

function isCodexAnalyticsHtmlContinuation(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) {
    return true
  }

  return (
    trimmed.startsWith('<') ||
    trimmed.startsWith('</') ||
    trimmed.startsWith('window.') ||
    trimmed.startsWith('history.') ||
    trimmed.startsWith('document.') ||
    trimmed.includes('__cf_chl') ||
    trimmed.includes('challenge-platform')
  )
}

function rewriteCodexNativeStderrLine(
  line: string,
  state: CodexNativeStderrFilterState,
): string | null {
  if (state.suppressAnalyticsHtmlContinuation) {
    if (isCodexAnalyticsHtmlContinuation(line)) {
      return null
    }
    state.suppressAnalyticsHtmlContinuation = false
  }

  const trimmed = line.trim()
  if (trimmed.length === 0) {
    return null
  }

  if (trimmed === 'Reading additional input from stdin...') {
    return null
  }

  if (
    trimmed.includes(
      'codex_analytics::client: events failed with status 403 Forbidden: <html>',
    )
  ) {
    state.suppressAnalyticsHtmlContinuation = true
    return 'Codex analytics events were blocked with 403 Forbidden. Continuing without analytics.'
  }

  if (
    trimmed.includes(
      'codex_rmcp_client::stdio_server_launcher: Failed to terminate MCP process group',
    )
  ) {
    return null
  }

  if (
    trimmed.includes(
      'codex_core::shell_snapshot: Failed to delete shell snapshot',
    )
  ) {
    return null
  }

  return line
}

function defaultResolveVersion(executablePath: string): string | null {
  const result = spawnSyncPortableCli(executablePath, ['--version'], {
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    return null
  }
  const version = typeof result.stdout === 'string' ? result.stdout.trim() : ''
  return version.length > 0 ? version : null
}

function terminateCodexNativeProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
): boolean {
  if (!pid || !Number.isFinite(pid) || pid <= 1) {
    return false
  }

  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal)
      return true
    } catch {
      // Fall back to the direct process if the group is already gone or was not
      // spawned as a POSIX process-group leader.
    }
  }

  killProcessTree(pid, signal)
  return true
}

function createQueuedLineStream(
  process: SpawnedCodexProcess,
  onStdoutActivity?: () => void,
): AsyncGenerator<QueuedLine, void, unknown> {
  const queue: QueuedLine[] = []
  let streamClosures = 0
  let notify: (() => void) | null = null

  const wake = () => {
    const current = notify
    notify = null
    current?.()
  }

  const onLine = (stream: 'stdout' | 'stderr', line: string) => {
    if (stream === 'stdout') {
      onStdoutActivity?.()
    }
    queue.push({ stream, line })
    wake()
  }

  const onClose = () => {
    streamClosures += 1
    wake()
  }

  const stdout = (process.stdout ?? new PassThrough()) as Readable
  const stderr = (process.stderr ?? new PassThrough()) as Readable
  const stdoutInterface = readline.createInterface({
    input: stdout,
    crlfDelay: Infinity,
  })
  const stderrInterface = readline.createInterface({
    input: stderr,
    crlfDelay: Infinity,
  })
  const onStdoutData = () => onStdoutActivity?.()

  stdoutInterface.on('line', line => onLine('stdout', line))
  stderrInterface.on('line', line => onLine('stderr', line))
  stdout.on('data', onStdoutData)
  stdout.once('end', onClose)
  stderr.once('end', onClose)
  process.once('close', () => {
    streamClosures = 2
    wake()
  })

  return (async function* queuedLines() {
    try {
      while (streamClosures < 2 || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>(resolve => {
            notify = resolve
          })
        }

        while (queue.length > 0) {
          const next = queue.shift()
          if (next) {
            yield next
          }
        }
      }
    } finally {
      stdout.off('data', onStdoutData)
      stdoutInterface.close()
      stderrInterface.close()
    }
  })()
}

export async function* runCodexNativeExec(
  options: CodexNativeExecRunnerOptions,
  deps: CodexNativeExecRunnerDeps = {},
): AsyncGenerator<CodexNativeExecObservation, CodexNativeExecSummary, unknown> {
  const binaryResolution = resolveCodexCliBinary({ which: deps.which })
  if (!binaryResolution) {
    throw new Error('Codex native runtime requires the codex CLI binary.')
  }
  const executablePath = binaryResolution.executablePath

  const identity: CodexNativeBinaryIdentity = {
    executablePath,
    executableSource: binaryResolution.executableSource,
    version: (deps.resolveVersion ?? defaultResolveVersion)(executablePath),
  }

  const env: NodeJS.ProcessEnv = { ...process.env }
  if (options.forcedLoginMethod === 'chatgpt') {
    delete env.OPENAI_API_KEY
    delete env.CODEX_API_KEY
  }

  const credentialSource: CodexNativeCredentialSource =
    options.apiKey && options.forcedLoginMethod !== 'chatgpt'
      ? 'explicit-api-key'
      : env.CODEX_API_KEY || env.OPENAI_API_KEY
        ? 'ambient-process-env'
        : 'none'
  if (options.apiKey && options.forcedLoginMethod !== 'chatgpt') {
    env.CODEX_API_KEY = options.apiKey
  }

  const child =
    deps.spawnProcess?.(executablePath, buildCodexNativeExecArgs(options), {
      cwd: options.cwd,
      env,
      signal: options.abortSignal,
      detached: process.platform !== 'win32',
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }) ??
    spawnPortableCli(executablePath, buildCodexNativeExecArgs(options), {
      cwd: options.cwd,
      env,
      signal: options.abortSignal,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })

  let recordProcessActivity: (() => void) | null = null
  let stdinError: Error | null = null
  if (child.stdin) {
    child.stdin.once('error', error => {
      stdinError = error instanceof Error ? error : new Error(String(error))
    })
    child.stdin.end(options.prompt)
  } else {
    stdinError = new Error('Codex native exec stdin is unavailable.')
  }
  const stderrLines: string[] = []
  const queuedLines = createQueuedLineStream(child, () => {
    recordProcessActivity?.()
  })
  const idleTimeoutMs = normalizeTimeoutMs(options.idleTimeoutMs)
  const absoluteTimeoutMs =
    options.absoluteTimeoutMs === undefined
      ? normalizeTimeoutMs(options.timeoutMs)
      : normalizeTimeoutMs(options.absoluteTimeoutMs)
  let timeoutReason: CodexNativeExecTimeoutReason | null = null
  let childClosed = false
  let idleTimeoutHandle: ReturnType<typeof setTimeout> | null = null
  let absoluteTimeoutHandle: ReturnType<typeof setTimeout> | null = null
  let forceKillHandle: ReturnType<typeof setTimeout> | null = null
  const clearTimeouts = () => {
    if (idleTimeoutHandle) {
      clearTimeout(idleTimeoutHandle)
      idleTimeoutHandle = null
    }
    if (absoluteTimeoutHandle) {
      clearTimeout(absoluteTimeoutHandle)
      absoluteTimeoutHandle = null
    }
    if (forceKillHandle) {
      clearTimeout(forceKillHandle)
      forceKillHandle = null
    }
  }

  const terminateChildProcessGroup = (signal: NodeJS.Signals): void => {
    if (childClosed) {
      return
    }
    try {
      if (
        !child.killed &&
        !terminateCodexNativeProcessGroup(child.pid, signal)
      ) {
        child.kill(signal)
      }
    } catch {
      // Best-effort process cleanup.
    }
  }

  const scheduleForceKill = (): void => {
    if (forceKillHandle || childClosed) {
      return
    }
    forceKillHandle = setTimeout(() => {
      terminateChildProcessGroup('SIGKILL')
    }, 5_000)
    forceKillHandle.unref?.()
  }

  const terminateForTimeout = (
    reason: CodexNativeExecTimeoutReason,
  ): void => {
    if (timeoutReason) {
      return
    }
    timeoutReason = reason
    terminateChildProcessGroup('SIGTERM')
    scheduleForceKill()
  }

  const resetIdleTimeout = (): void => {
    if (idleTimeoutHandle) {
      clearTimeout(idleTimeoutHandle)
      idleTimeoutHandle = null
    }
    if (!idleTimeoutMs || timeoutReason) {
      return
    }
    idleTimeoutHandle = setTimeout(() => {
      terminateForTimeout({ type: 'idle', timeoutMs: idleTimeoutMs })
    }, idleTimeoutMs)
    idleTimeoutHandle.unref?.()
  }

  recordProcessActivity = resetIdleTimeout
  resetIdleTimeout()

  const onAbort = () => {
    terminateChildProcessGroup('SIGTERM')
    scheduleForceKill()
  }
  if (options.abortSignal?.aborted) {
    onAbort()
  } else {
    options.abortSignal?.addEventListener('abort', onAbort, { once: true })
  }

  if (absoluteTimeoutMs) {
    absoluteTimeoutHandle = setTimeout(() => {
      terminateForTimeout({
        type: 'absolute',
        timeoutMs: absoluteTimeoutMs,
      })
    }, absoluteTimeoutMs)
    absoluteTimeoutHandle.unref?.()
  }

  let threadId: string | null = null
  const codexDiagnosticLines: string[] = []
  const stderrFilterState: CodexNativeStderrFilterState = {
    suppressAnalyticsHtmlContinuation: false,
  }
  const traceWriter = new CodexNativeTraceWriter({
    cwd: options.cwd,
    codexVersion: identity.version,
  })
  let traceOutcome: 'success' | 'error' | 'timeout' | 'aborted' | 'interrupted' =
    'interrupted'
  let traceExitCode: number | null | undefined
  let traceSignal: NodeJS.Signals | null | undefined

  let spawnError: Error | null = null
  child.once('error', error => {
    spawnError = error instanceof Error ? error : new Error(String(error))
  })
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    resolve => {
      child.once('close', (code, signal) => {
        childClosed = true
        resolve({ code, signal })
      })
    },
  )

  try {
    yield {
      type: 'binary_identity',
      identity,
    }

    for await (const entry of queuedLines) {
      if (entry.stream === 'stderr') {
        const rewrittenLine = rewriteCodexNativeStderrLine(
          entry.line,
          stderrFilterState,
        )
        await traceWriter.recordStderrLine(entry.line, rewrittenLine).catch(() => undefined)
        if (!rewrittenLine) {
          continue
        }
        stderrLines.push(rewrittenLine)
        yield {
          type: 'normalized_event',
          event: {
            type: 'warning',
            source: 'stderr',
            text: rewrittenLine,
          },
        }
        continue
      }

      await traceWriter.recordStdoutLine(entry.line).catch(() => undefined)
      for (const event of mapCodexNativeExecLine(entry.line)) {
        if (event.type === 'thread_started') {
          threadId = event.threadId
        }
        if (event.type === 'warning' && event.source === 'codex') {
          codexDiagnosticLines.push(event.text)
        }
        yield {
          type: 'normalized_event',
          event,
        }
      }
    }

    const exit = await exitPromise
    traceExitCode = exit.code
    traceSignal = exit.signal

    if (spawnError) {
      traceOutcome = 'error'
      throw spawnError
    }
    if (stdinError) {
      traceOutcome = 'error'
      throw stdinError
    }

    if (timeoutReason) {
      traceOutcome = 'timeout'
      if (timeoutReason.type === 'idle') {
        throw new Error(
          `Codex native exec timed out after ${timeoutReason.timeoutMs}ms of inactivity.`,
        )
      }
      throw new Error(
        `Codex native exec timed out after ${timeoutReason.timeoutMs}ms.`,
      )
    }

    if (exit.code !== 0 || exit.signal) {
      traceOutcome = options.abortSignal?.aborted ? 'aborted' : 'error'
      const detail = exit.signal
        ? `signal ${exit.signal}`
        : `code ${exit.code ?? 1}`
      const diagnosticLines =
        stderrLines.length > 0 ? stderrLines : codexDiagnosticLines
      const stderrText =
        diagnosticLines.length > 0 ? `: ${diagnosticLines.join('\n')}` : ''
      throw new Error(`Codex native exec exited with ${detail}${stderrText}`)
    }

    traceOutcome = 'success'
    return {
      identity,
      threadId,
      credentialSource,
      completionPolicy: options.ephemeral === false ? 'persistent' : 'ephemeral',
      finalHistoryCompleteness:
        options.ephemeral === false
          ? 'explicit-hydration-required'
          : 'live-only',
      finalUsageAuthority: 'live-turn-completed',
    }
  } finally {
    await traceWriter
      .finish({
        outcome: options.abortSignal?.aborted ? 'aborted' : traceOutcome,
        exitCode: traceExitCode,
        signal: traceSignal ?? null,
      })
      .catch(() => undefined)
    clearTimeouts()
    options.abortSignal?.removeEventListener('abort', onAbort)
    if (!childClosed) {
      terminateChildProcessGroup('SIGTERM')
      scheduleForceKill()
    }
  }
}
