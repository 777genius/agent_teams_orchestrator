import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { PassThrough, type Readable } from 'node:stream'
import readline from 'node:readline'

import type { CodexForcedLoginMethod } from '../runtimeBackends/codexBackendResolver.js'
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
  abortSignal?: AbortSignal
  timeoutMs?: number | null
}

export type CodexNativeBinaryIdentity = {
  executablePath: string
  executableSource: 'system-path'
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
      stdin: 'ignore'
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

export function buildCodexNativeExecArgs(
  options: CodexNativeExecRunnerOptions,
): string[] {
  const args = ['exec', '--json', '--skip-git-repo-check', '-C', options.cwd]

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

  if (options.sandboxMode) {
    args.push('--sandbox', options.sandboxMode)
  }

  for (const directory of options.additionalWritableDirectories ?? []) {
    args.push('--add-dir', directory)
  }

  args.push(options.prompt)
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
  const result = spawnSync(executablePath, ['--version'], {
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    return null
  }
  const version = typeof result.stdout === 'string' ? result.stdout.trim() : ''
  return version.length > 0 ? version : null
}

function createQueuedLineStream(
  process: SpawnedCodexProcess,
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

  stdoutInterface.on('line', line => onLine('stdout', line))
  stderrInterface.on('line', line => onLine('stderr', line))
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
      stdoutInterface.close()
      stderrInterface.close()
    }
  })()
}

export async function* runCodexNativeExec(
  options: CodexNativeExecRunnerOptions,
  deps: CodexNativeExecRunnerDeps = {},
): AsyncGenerator<CodexNativeExecObservation, CodexNativeExecSummary, unknown> {
  const executablePath = deps.which?.('codex') ?? Bun.which('codex')
  if (!executablePath) {
    throw new Error('Codex native runtime requires the codex CLI binary.')
  }

  const identity: CodexNativeBinaryIdentity = {
    executablePath,
    executableSource: 'system-path',
    version: (deps.resolveVersion ?? defaultResolveVersion)(executablePath),
  }

  const env: NodeJS.ProcessEnv = { ...process.env }
  const credentialSource: CodexNativeCredentialSource = options.apiKey
    ? 'explicit-api-key'
    : env.CODEX_API_KEY
      ? 'ambient-process-env'
      : 'none'
  if (options.apiKey) {
    env.CODEX_API_KEY = options.apiKey
  }

  const child =
    deps.spawnProcess?.(executablePath, buildCodexNativeExecArgs(options), {
      cwd: options.cwd,
      env,
      signal: options.abortSignal,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    }) ??
    spawn(executablePath, buildCodexNativeExecArgs(options), {
      cwd: options.cwd,
      env,
      signal: options.abortSignal,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  const stderrLines: string[] = []
  const queuedLines = createQueuedLineStream(child)
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
      ? Math.max(0, Math.floor(options.timeoutMs))
      : 0
  let timedOut = false
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  let forceKillHandle: ReturnType<typeof setTimeout> | null = null
  const clearTimeouts = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
      timeoutHandle = null
    }
    if (forceKillHandle) {
      clearTimeout(forceKillHandle)
      forceKillHandle = null
    }
  }

  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true
      try {
        if (!child.killed) {
          child.kill('SIGTERM')
        }
      } catch {
        // Best-effort timeout cleanup.
      }
      forceKillHandle = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Best-effort timeout cleanup.
        }
      }, 5_000)
      forceKillHandle.unref?.()
    }, timeoutMs)
    timeoutHandle.unref?.()
  }

  yield {
    type: 'binary_identity',
    identity,
  }

  let threadId: string | null = null
  const stderrFilterState: CodexNativeStderrFilterState = {
    suppressAnalyticsHtmlContinuation: false,
  }

  let spawnError: Error | null = null
  child.once('error', error => {
    spawnError = error instanceof Error ? error : new Error(String(error))
  })
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    resolve => {
      child.once('close', (code, signal) => {
        resolve({ code, signal })
      })
    },
  )

  try {
    for await (const entry of queuedLines) {
      if (entry.stream === 'stderr') {
        const rewrittenLine = rewriteCodexNativeStderrLine(
          entry.line,
          stderrFilterState,
        )
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

      for (const event of mapCodexNativeExecLine(entry.line)) {
        if (event.type === 'thread_started') {
          threadId = event.threadId
        }
        yield {
          type: 'normalized_event',
          event,
        }
      }
    }

    const exit = await exitPromise

    if (spawnError) {
      throw spawnError
    }

    if (timedOut) {
      throw new Error(`Codex native exec timed out after ${timeoutMs}ms.`)
    }

    if (exit.code !== 0 || exit.signal) {
      const detail = exit.signal
        ? `signal ${exit.signal}`
        : `code ${exit.code ?? 1}`
      const stderrText =
        stderrLines.length > 0 ? `: ${stderrLines.join('\n')}` : ''
      throw new Error(`Codex native exec exited with ${detail}${stderrText}`)
    }

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
    clearTimeouts()
  }
}
