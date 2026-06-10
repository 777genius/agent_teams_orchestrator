import { type ChildProcess } from 'node:child_process'
import {
  cp,
  lstat,
  mkdtemp,
  readdir,
  rm,
  symlink,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

import { killProcessTree } from '../../utils/processKill.js'
import { spawnPortableCli } from '../../utils/portableCli.js'
import {
  resolveCodexCliBinary,
  type CodexForcedLoginMethod,
} from '../runtimeBackends/codexBackendResolver.js'
import {
  buildCodexAppServerApprovalResponse,
  buildCodexAppServerInitializedNotification,
  buildCodexAppServerInitializeRequest,
  buildCodexManualThreadStartParams,
  buildCodexManualTurnStartParams,
  classifyCodexAppServerApprovalFailure,
  normalizeCodexAppServerApprovalRequest,
  type CodexAppServerApprovalRequestHandler,
  type CodexAppServerRequest,
  type CodexAppServerRequestId,
} from './appServerApproval.js'
import {
  type CodexNativeBinaryIdentity,
  type CodexNativeCredentialSource,
  type CodexNativeExecObservation,
  type CodexNativeExecSummary,
} from './execRunner.js'
import type { CodexNativeNormalizedEvent } from './normalizedEvents.js'

type JsonRpcErrorPayload = {
  code: number
  message: string
  data?: unknown
}

type JsonRpcResponse<T> = {
  jsonrpc?: '2.0'
  id: CodexAppServerRequestId
  result?: T
  error?: JsonRpcErrorPayload
}

type SpawnedCodexAppServerProcess = Pick<
  ChildProcess,
  | 'stdout'
  | 'stderr'
  | 'stdin'
  | 'pid'
  | 'once'
  | 'kill'
  | 'killed'
  | 'exitCode'
  | 'signalCode'
>

export type CodexNativeAppServerRunnerOptions = {
  prompt: string
  imagePaths?: string[]
  cwd: string
  model?: string | null
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null
  ephemeral?: boolean
  apiKey?: string | null
  forcedLoginMethod?: CodexForcedLoginMethod | null
  configOverrides?: string[]
  disabledFeatures?: string[]
  abortSignal?: AbortSignal
  idleTimeoutMs?: number | null
  absoluteTimeoutMs?: number | null
  requestApproval: CodexAppServerApprovalRequestHandler
}

export type CodexNativeAppServerRunnerDeps = {
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
  ) => SpawnedCodexAppServerProcess
  resolveVersion?: (executablePath: string) => string | null
}

type PendingRequest = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeoutId: ReturnType<typeof setTimeout> | null
}

type QueuedObservation =
  | CodexNativeExecObservation
  | { type: 'runner_error'; error: Error }
  | { type: 'runner_done' }

const DEFAULT_APP_SERVER_REQUEST_TIMEOUT_MS = 120_000
const CODEX_CONFIG_FILE_NAME = 'config.toml'
const CODEX_APP_SERVER_HOME_PREFIX = 'codex-app-server-home-'
const REQUIRED_CODEX_HOME_OVERLAY_ENTRIES = new Set(['accounts', 'auth.json'])

function defaultResolveVersion(executablePath: string): string | null {
  try {
    const result = Bun.spawnSync([executablePath, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const output = new TextDecoder().decode(result.stdout).trim()
    return output || null
  } catch {
    return null
  }
}

function normalizeTimeoutMs(timeoutMs: number | null | undefined): number | null {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
    return null
  }
  const normalized = Math.max(0, Math.floor(timeoutMs))
  return normalized > 0 ? normalized : null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function buildAppServerArgs(options: CodexNativeAppServerRunnerOptions): string[] {
  const args = ['app-server', '--listen', 'stdio://']
  if (options.forcedLoginMethod) {
    args.push('-c', `forced_login_method="${options.forcedLoginMethod}"`)
  }
  for (const override of options.configOverrides ?? []) {
    args.push('-c', override)
  }
  for (const feature of options.disabledFeatures ?? []) {
    args.push('--disable', feature)
  }
  return args
}

function resolveCodexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME?.trim() || path.join(homedir(), '.codex')
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT',
  )
}

async function linkCodexHomeEntry(
  entryName: string,
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  const stats = await lstat(sourcePath)
  try {
    await symlink(sourcePath, targetPath, stats.isDirectory() ? 'dir' : 'file')
    return
  } catch (symlinkError) {
    try {
      await cp(sourcePath, targetPath, {
        recursive: true,
        force: false,
        errorOnExist: true,
        verbatimSymlinks: true,
      })
    } catch {
      if (REQUIRED_CODEX_HOME_OVERLAY_ENTRIES.has(entryName)) {
        throw symlinkError
      }
    }
  }
}

async function createCodexAppServerHomeOverlay(
  env: NodeJS.ProcessEnv,
): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const sourceHome = resolveCodexHome(env)
  const overlayHome = await mkdtemp(path.join(tmpdir(), CODEX_APP_SERVER_HOME_PREFIX))

  try {
    let entries: Awaited<ReturnType<typeof readdir>>
    try {
      entries = await readdir(sourceHome, { withFileTypes: true })
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error
      }
      entries = []
    }

    for (const entry of entries) {
      if (entry.name === CODEX_CONFIG_FILE_NAME) {
        continue
      }
      await linkCodexHomeEntry(
        entry.name,
        path.join(sourceHome, entry.name),
        path.join(overlayHome, entry.name),
      )
    }
  } catch (error) {
    await rm(overlayHome, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }

  return {
    env: {
      ...env,
      CODEX_HOME: overlayHome,
    },
    cleanup: () => rm(overlayHome, { recursive: true, force: true }),
  }
}

function createObservationQueue() {
  const queue: QueuedObservation[] = []
  const waiters: Array<(value: QueuedObservation) => void> = []
  return {
    push(value: QueuedObservation) {
      const waiter = waiters.shift()
      if (waiter) {
        waiter(value)
        return
      }
      queue.push(value)
    },
    next(): Promise<QueuedObservation> {
      const value = queue.shift()
      if (value) return Promise.resolve(value)
      return new Promise(resolve => waiters.push(resolve))
    },
  }
}

function buildRequestError(method: string, error: JsonRpcErrorPayload): Error {
  const code = typeof error.code === 'number' ? ` (${error.code})` : ''
  return new Error(`Codex app-server ${method} failed${code}: ${error.message}`)
}

function isJsonRpcResponse(message: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(message, 'id') && !message.method
}

function isJsonRpcRequest(message: Record<string, unknown>): message is CodexAppServerRequest {
  return (
    Object.prototype.hasOwnProperty.call(message, 'id') &&
    typeof message.method === 'string'
  )
}

function extractThreadId(value: unknown): string | null {
  const record = asRecord(value)
  const thread = asRecord(record.thread)
  return stringValue(thread.id) ?? stringValue(record.threadId)
}

function mapTokenUsageNotification(params: Record<string, unknown>): CodexNativeNormalizedEvent | null {
  const tokenUsage = asRecord(params.tokenUsage)
  const last = asRecord(tokenUsage.last)
  const inputTokens = Number(last.inputTokens)
  const cachedInputTokens = Number(last.cachedInputTokens)
  const outputTokens = Number(last.outputTokens)
  if (
    !Number.isFinite(inputTokens) ||
    !Number.isFinite(cachedInputTokens) ||
    !Number.isFinite(outputTokens)
  ) {
    return null
  }
  return {
    type: 'usage_updated',
    inputTokens,
    cachedInputTokens,
    outputTokens,
  }
}

function mapThreadItemToToolStarted(item: Record<string, unknown>): CodexNativeNormalizedEvent | null {
  const itemType = stringValue(item.type)
  const itemId = stringValue(item.id)
  if (!itemType || !itemId) return null

  if (itemType === 'commandExecution') {
    return {
      type: 'tool_call_started',
      itemId,
      toolSource: 'native',
      toolName: 'Bash',
      arguments: {
        command: stringValue(item.command) ?? '',
        cwd: stringValue(item.cwd) ?? undefined,
        commandActions: Array.isArray(item.commandActions) ? item.commandActions : undefined,
      },
      status: stringValue(item.status) ?? 'inProgress',
      rawItemType: itemType,
    }
  }

  if (itemType === 'fileChange') {
    return {
      type: 'tool_call_started',
      itemId,
      toolSource: 'native',
      toolName: 'Edit',
      arguments: {
        changes: Array.isArray(item.changes) ? item.changes : [],
      },
      status: stringValue(item.status) ?? 'inProgress',
      rawItemType: itemType,
    }
  }

  if (itemType === 'mcpToolCall') {
    const serverName = stringValue(item.server) ?? 'mcp'
    const toolName = stringValue(item.tool) ?? 'tool'
    return {
      type: 'tool_call_started',
      itemId,
      toolSource: 'mcp',
      serverName,
      toolName,
      arguments: asRecord(item.arguments),
      status: stringValue(item.status) ?? 'inProgress',
      rawItemType: itemType,
    }
  }

  if (itemType === 'dynamicToolCall') {
    const namespace = stringValue(item.namespace)
    const toolName = stringValue(item.tool) ?? 'tool'
    return {
      type: 'tool_call_started',
      itemId,
      toolSource: 'native',
      toolName: namespace ? `${namespace}.${toolName}` : toolName,
      arguments: asRecord(item.arguments),
      status: stringValue(item.status) ?? 'inProgress',
      rawItemType: itemType,
    }
  }

  return null
}

function mapThreadItemToToolCompleted(item: Record<string, unknown>): CodexNativeNormalizedEvent | null {
  const started = mapThreadItemToToolStarted(item)
  if (!started || started.type !== 'tool_call_started') {
    return null
  }

  const itemType = stringValue(item.type)
  let resultText: string | null = null
  let rawResult: unknown = item
  let errorMessage: string | null = null
  let isError = false

  if (itemType === 'commandExecution') {
    resultText = stringValue(item.aggregatedOutput)
    const status = stringValue(item.status)
    const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null
    isError = status === 'failed' || status === 'declined' || (exitCode !== null && exitCode !== 0)
    errorMessage = isError ? `Command ${status ?? 'failed'}` : null
  } else if (itemType === 'mcpToolCall') {
    rawResult = item.result ?? item.error ?? item
    resultText =
      typeof rawResult === 'string'
        ? rawResult
        : rawResult === null || rawResult === undefined
          ? null
          : JSON.stringify(rawResult)
    isError = Boolean(item.error)
    errorMessage = isError ? resultText : null
  } else if (itemType === 'dynamicToolCall') {
    rawResult = item.contentItems ?? item
    resultText =
      rawResult === null || rawResult === undefined
        ? null
        : JSON.stringify(rawResult)
    isError = item.success === false
    errorMessage = isError ? resultText : null
  } else if (itemType === 'fileChange') {
    rawResult = item.changes ?? item
    resultText =
      rawResult === null || rawResult === undefined
        ? null
        : JSON.stringify(rawResult)
    isError = stringValue(item.status) === 'failed'
    errorMessage = isError ? resultText : null
  }

  return {
    type: 'tool_call_completed',
    itemId: started.itemId,
    toolSource: started.toolSource,
    ...(started.serverName ? { serverName: started.serverName } : {}),
    toolName: started.toolName,
    arguments: started.arguments,
    status: stringValue(item.status) ?? 'completed',
    resultText,
    rawResult,
    errorMessage,
    isError,
    rawItemType: started.rawItemType,
  }
}

function mapNotificationToEvents(
  method: string,
  params: Record<string, unknown>,
): CodexNativeNormalizedEvent[] {
  switch (method) {
    case 'thread/started': {
      const threadId = extractThreadId(params)
      return threadId ? [{ type: 'thread_started', threadId }] : []
    }
    case 'turn/started':
      return [{ type: 'turn_started' }]
    case 'item/agentMessage/delta': {
      const itemId = stringValue(params.itemId) ?? 'agent-message'
      const text = stringValue(params.delta)
      return text ? [{ type: 'assistant_text', itemId, text }] : []
    }
    case 'thread/tokenUsage/updated': {
      const event = mapTokenUsageNotification(params)
      return event ? [event] : []
    }
    case 'item/started': {
      const event = mapThreadItemToToolStarted(asRecord(params.item))
      return event ? [event] : []
    }
    case 'item/completed': {
      const event = mapThreadItemToToolCompleted(asRecord(params.item))
      return event ? [event] : []
    }
    case 'turn/completed':
      return [{ type: 'turn_completed' }]
    case 'warning':
    case 'error': {
      const text =
        stringValue(params.message) ??
        stringValue(params.error) ??
        JSON.stringify(params)
      return [{ type: 'warning', source: 'codex', text }]
    }
    default:
      return []
  }
}

export async function* runCodexNativeAppServer(
  options: CodexNativeAppServerRunnerOptions,
  deps: CodexNativeAppServerRunnerDeps = {},
): AsyncGenerator<CodexNativeExecObservation, CodexNativeExecSummary, unknown> {
  const binaryResolution = resolveCodexCliBinary({ which: deps.which })
  if (!binaryResolution) {
    throw new Error('Codex app-server runtime requires the codex CLI binary.')
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

  const codexHomeOverlay = await createCodexAppServerHomeOverlay(env)
  let child: SpawnedCodexAppServerProcess
  try {
    child =
      deps.spawnProcess?.(executablePath, buildAppServerArgs(options), {
        cwd: options.cwd,
        env: codexHomeOverlay.env,
        signal: options.abortSignal,
        detached: process.platform !== 'win32',
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      }) ??
      spawnPortableCli(executablePath, buildAppServerArgs(options), {
        cwd: options.cwd,
        env: codexHomeOverlay.env,
        signal: options.abortSignal,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
  } catch (error) {
    await codexHomeOverlay.cleanup().catch(() => undefined)
    throw error
  }

  if (!child.stdin || !child.stdout) {
    await codexHomeOverlay.cleanup().catch(() => undefined)
    throw new Error('Codex app-server stdio is unavailable.')
  }

  const lineReader = readline.createInterface({ input: child.stdout })
  const stderrReader = child.stderr
    ? readline.createInterface({ input: child.stderr })
    : null
  const observations = createObservationQueue()
  const pending = new Map<CodexAppServerRequestId, PendingRequest>()
  let nextRequestId = 1
  let threadId: string | null = null
  let completed = false
  let cleanupStarted = false

  const enqueueEvent = (event: CodexNativeNormalizedEvent): void => {
    if (event.type === 'thread_started') {
      threadId = event.threadId
    }
    if (event.type === 'turn_completed') {
      completed = true
    }
    observations.push({ type: 'normalized_event', event })
  }

  const writeJson = (payload: unknown): void => {
    child.stdin!.write(`${JSON.stringify(payload)}\n`)
  }

  const rejectAll = (error: Error): void => {
    for (const [id, entry] of pending) {
      if (entry.timeoutId) clearTimeout(entry.timeoutId)
      entry.reject(error)
      pending.delete(id)
    }
  }

  const cleanup = (): void => {
    if (cleanupStarted) return
    cleanupStarted = true
    lineReader.close()
    stderrReader?.close()
    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.end()
    }
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null && !child.killed) {
        if (child.pid && process.platform !== 'win32') {
          try {
            process.kill(-child.pid, 'SIGTERM')
          } catch {
            killProcessTree(child.pid, 'SIGTERM')
          }
        } else {
          child.kill('SIGTERM')
        }
      }
    }, 250).unref()
  }

  const request = <T>(
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_APP_SERVER_REQUEST_TIMEOUT_MS,
  ): Promise<T> => {
    const id = nextRequestId++
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Codex app-server request timed out: ${method}`))
      }, timeoutMs)
      pending.set(id, {
        method,
        resolve: value => resolve(value as T),
        reject,
        timeoutId,
      })
      writeJson({ jsonrpc: '2.0', id, method, params })
    })
  }

  const handleServerRequest = async (
    requestMessage: CodexAppServerRequest,
  ): Promise<void> => {
    const approval = normalizeCodexAppServerApprovalRequest(requestMessage)
    if (!approval) {
      writeJson({
        jsonrpc: '2.0',
        id: requestMessage.id,
        error: {
          code: -32601,
          message: `Unsupported Codex app-server request: ${requestMessage.method}`,
        },
      })
      return
    }

    try {
      const decision = await options.requestApproval(approval)
      writeJson(
        buildCodexAppServerApprovalResponse(requestMessage, decision.allow),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeJson({
        jsonrpc: '2.0',
        id: requestMessage.id,
        error: {
          code: -32000,
          message,
        },
      })
    }
  }

  lineReader.on('line', line => {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      enqueueEvent({ type: 'warning', source: 'codex', text: line })
      return
    }

    if (isJsonRpcResponse(message)) {
      const response = message as JsonRpcResponse<unknown>
      const entry = pending.get(response.id)
      if (!entry) return
      if (entry.timeoutId) clearTimeout(entry.timeoutId)
      pending.delete(response.id)
      if (response.error) {
        entry.reject(buildRequestError(entry.method, response.error))
        return
      }
      entry.resolve(response.result)
      return
    }

    if (isJsonRpcRequest(message)) {
      void handleServerRequest(message)
      return
    }

    if (typeof message.method === 'string') {
      for (const event of mapNotificationToEvents(
        message.method,
        asRecord(message.params),
      )) {
        enqueueEvent(event)
      }
    }
  })

  stderrReader?.on('line', line => {
    const text = line.trim()
    if (text.length > 0) {
      enqueueEvent({ type: 'warning', source: 'stderr', text })
    }
  })

  child.once('error', error => {
    const normalized = error instanceof Error ? error : new Error(String(error))
    rejectAll(normalized)
    observations.push({ type: 'runner_error', error: normalized })
  })
  child.once('exit', (code, signal) => {
    const error =
      pending.size > 0 || !completed
        ? new Error(
            `Codex app-server exited unexpectedly (code=${code ?? 'null'} signal=${signal ?? 'null'})`,
          )
        : null
    if (error) {
      rejectAll(error)
      observations.push({ type: 'runner_error', error })
      return
    }
    observations.push({ type: 'runner_done' })
  })

  observations.push({ type: 'binary_identity', identity })

  try {
    yield { type: 'binary_identity', identity }
    await request('initialize', buildCodexAppServerInitializeRequest(1).params)
    writeJson(buildCodexAppServerInitializedNotification())
    const threadStartResult = await request<Record<string, unknown>>(
      'thread/start',
      buildCodexManualThreadStartParams({
        model: options.model,
        cwd: options.cwd,
        ephemeral: options.ephemeral,
      }),
    )
    threadId = extractThreadId(threadStartResult) ?? threadId
    if (threadId) {
      enqueueEvent({ type: 'thread_started', threadId })
    }
    if (!threadId) {
      throw new Error('Codex app-server thread/start returned no thread id.')
    }

    await request('turn/start', buildCodexManualTurnStartParams({
      threadId,
      prompt: options.prompt,
      imagePaths: options.imagePaths,
      cwd: options.cwd,
      model: options.model,
      effort: options.reasoningEffort,
    }))

    const idleTimeoutMs = normalizeTimeoutMs(options.idleTimeoutMs)
    const absoluteTimeoutMs = normalizeTimeoutMs(options.absoluteTimeoutMs)
    let idleTimeoutHandle: ReturnType<typeof setTimeout> | null = null
    let absoluteTimeoutHandle: ReturnType<typeof setTimeout> | null = null
    const resetIdleTimeout = (): void => {
      if (!idleTimeoutMs) return
      if (idleTimeoutHandle) clearTimeout(idleTimeoutHandle)
      idleTimeoutHandle = setTimeout(() => {
        observations.push({
          type: 'runner_error',
          error: new Error(
            `Codex app-server idle timeout after ${idleTimeoutMs}ms`,
          ),
        })
      }, idleTimeoutMs)
    }
    if (absoluteTimeoutMs) {
      absoluteTimeoutHandle = setTimeout(() => {
        observations.push({
          type: 'runner_error',
          error: new Error(
            `Codex app-server absolute timeout after ${absoluteTimeoutMs}ms`,
          ),
        })
      }, absoluteTimeoutMs)
    }
    resetIdleTimeout()

    try {
      while (true) {
        const observation = await observations.next()
        resetIdleTimeout()
        if (observation.type === 'runner_error') {
          throw observation.error
        }
        if (observation.type === 'runner_done') {
          break
        }
        if (observation.type === 'binary_identity') {
          continue
        }
        yield observation
        if (observation.event.type === 'turn_completed') {
          break
        }
      }
    } finally {
      if (idleTimeoutHandle) clearTimeout(idleTimeoutHandle)
      if (absoluteTimeoutHandle) clearTimeout(absoluteTimeoutHandle)
    }
  } catch (error) {
    const classified = classifyCodexAppServerApprovalFailure(error)
    if (classified.unsupported) {
      throw new Error(classified.message)
    }
    throw error
  } finally {
    cleanup()
    await codexHomeOverlay.cleanup().catch(() => undefined)
  }

  return {
    identity,
    threadId,
    credentialSource,
    completionPolicy: options.ephemeral === false ? 'persistent' : 'ephemeral',
    finalHistoryCompleteness: 'explicit-hydration-required',
    finalUsageAuthority: 'live-turn-completed',
  }
}
