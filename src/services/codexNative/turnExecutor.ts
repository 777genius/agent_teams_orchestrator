import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { randomUUID } from 'crypto'

import { getSessionId } from '../../bootstrap/state.js'
import type {
  SDKMessage,
  SDKPermissionDenial,
  SDKResultMessage,
  SDKStatus,
  SDKUserMessageReplay,
} from '../../entrypoints/agentSdkTypes.js'
import { getFastModeState } from '../../utils/fastMode.js'
import { type EffortValue, resolveAppliedEffort } from '../../utils/effort.js'
import {
  createAssistantAPIErrorMessage,
  extractTextContent,
} from '../../utils/messages.js'
import type { Message } from '../../types/message.js'
import { flushSessionStorage, recordTranscript } from '../../utils/sessionStorage.js'
import { normalizeMessage } from '../../utils/queryHelpers.js'
import type { AppState } from '../../state/AppState.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { getModelUsage, getTotalAPIDuration, getTotalCost } from '../../cost-tracker.js'
import type { NonNullableUsage } from '../../entrypoints/sdk/coreTypes.js'
import {
  type CodexCliBinarySource,
  getCodexForcedLoginMethod,
  getCodexNativeApiKey,
} from '../runtimeBackends/codexBackendResolver.js'
import { runCodexNativeExec } from './execRunner.js'
import { buildCodexNativeMcpConfigOverrides } from './mcpConfigBridge.js'
import {
  buildCodexNativeTurnSettledEvent,
  emitCodexNativeTurnSettledBestEffort,
  type CodexNativeTurnSettledEmitterPort,
  type CodexNativeTurnSettledOutcome,
} from './runtimeTurnSettledEmitter.js'
import {
  createCodexNativeExecutionSummaryMessage,
  createCodexNativeThreadStatusMessage,
} from './statusAuthority.js'
import { CodexNativeTranscriptProjector } from './transcriptProjector.js'

type CodexNativeExecutionSummary = {
  totalUsage: NonNullableUsage
  binaryIdentity: {
    executablePath: string
    executableSource: CodexCliBinarySource
    version: string | null
  } | null
  threadId: string | null
  credentialSource: 'explicit-api-key' | 'ambient-process-env' | 'none' | null
  completionPolicy: 'ephemeral' | 'persistent' | null
  finalHistoryCompleteness: 'live-only' | 'explicit-hydration-required' | null
  finalUsageAuthority: 'live-turn-completed' | null
}

type ExecuteCodexNativeTurnParams = {
  prompt: string | ContentBlockParam[]
  jsonSchema?: Record<string, unknown>
  cwd: string
  model: string
  effortValue: EffortValue | undefined
  permissionMode: PermissionMode
  additionalWritableDirectories: string[]
  persistSession: boolean
  replayedUserMessages: SDKUserMessageReplay[]
  transcriptMessages: Message[]
  mutableMessages: Message[]
  totalUsage: NonNullableUsage
  permissionDenials: SDKPermissionDenial[]
  initialAppState: AppState
  startTime: number
  abortSignal?: AbortSignal
  setSDKStatus?: (status: SDKStatus) => void
}

type ExecuteCodexNativeTurnDeps = {
  runExec?: typeof runCodexNativeExec
  recordTranscript?: typeof recordTranscript
  flushSessionStorage?: typeof flushSessionStorage
  runtimeTurnSettledEmitter?: CodexNativeTurnSettledEmitterPort
}

const DEFAULT_CODEX_NATIVE_MAILBOX_IDLE_TIMEOUT_MS = 300_000
const DEFAULT_CODEX_NATIVE_MAILBOX_ABSOLUTE_TIMEOUT_MS = 2_700_000
const DEFAULT_CODEX_NATIVE_DIRECT_IDLE_TIMEOUT_MS = 900_000
const DEFAULT_CODEX_NATIVE_DIRECT_ABSOLUTE_TIMEOUT_MS = 3_600_000
const CODEX_NATIVE_MAILBOX_IDLE_TIMEOUT_ENV =
  'CLAUDE_CODE_CODEX_NATIVE_MAILBOX_IDLE_TIMEOUT_MS'
const CODEX_NATIVE_MAILBOX_ABSOLUTE_TIMEOUT_ENV =
  'CLAUDE_CODE_CODEX_NATIVE_MAILBOX_ABSOLUTE_TIMEOUT_MS'
const CODEX_NATIVE_MAILBOX_TIMEOUT_ENV =
  'CLAUDE_CODE_CODEX_NATIVE_MAILBOX_TURN_TIMEOUT_MS'
const CODEX_NATIVE_DIRECT_IDLE_TIMEOUT_ENV =
  'CLAUDE_CODE_CODEX_NATIVE_DIRECT_IDLE_TIMEOUT_MS'
const CODEX_NATIVE_DIRECT_ABSOLUTE_TIMEOUT_ENV =
  'CLAUDE_CODE_CODEX_NATIVE_DIRECT_ABSOLUTE_TIMEOUT_MS'
const CODEX_NATIVE_DIRECT_TIMEOUT_ENV =
  'CLAUDE_CODE_CODEX_NATIVE_DIRECT_TURN_TIMEOUT_MS'

export type CodexNativeExecTimeoutPolicy = {
  idleTimeoutMs: number | null
  absoluteTimeoutMs: number | null
}

function isOrdinaryQueuedMailboxPrompt(prompt: string): boolean {
  return (
    prompt.includes('Process this queued mailbox message now.') &&
    prompt.includes('<queued_mailbox_message>') &&
    prompt.includes('</queued_mailbox_message>')
  )
}

export function resolveCodexNativeExecTimeoutMs(
  prompt: string,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  return (
    resolveCodexNativeExecTimeoutPolicy(prompt, env)?.absoluteTimeoutMs ?? null
  )
}

function resolveTimeoutEnvValue(
  raw: string | undefined,
  fallback: number | null,
): number | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return fallback
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  const timeoutMs = Math.max(0, Math.floor(parsed))
  return timeoutMs > 0 ? timeoutMs : null
}

export function resolveCodexNativeExecTimeoutPolicy(
  prompt: string,
  env: NodeJS.ProcessEnv = process.env,
): CodexNativeExecTimeoutPolicy | null {
  if (isOrdinaryQueuedMailboxPrompt(prompt)) {
    const legacyAbsoluteTimeoutMs = resolveTimeoutEnvValue(
      env[CODEX_NATIVE_MAILBOX_TIMEOUT_ENV],
      DEFAULT_CODEX_NATIVE_MAILBOX_ABSOLUTE_TIMEOUT_MS,
    )

    return {
      idleTimeoutMs: resolveTimeoutEnvValue(
        env[CODEX_NATIVE_MAILBOX_IDLE_TIMEOUT_ENV],
        DEFAULT_CODEX_NATIVE_MAILBOX_IDLE_TIMEOUT_MS,
      ),
      absoluteTimeoutMs: resolveTimeoutEnvValue(
        env[CODEX_NATIVE_MAILBOX_ABSOLUTE_TIMEOUT_ENV],
        legacyAbsoluteTimeoutMs,
      ),
    }
  }

  const legacyAbsoluteTimeoutMs = resolveTimeoutEnvValue(
    env[CODEX_NATIVE_DIRECT_TIMEOUT_ENV],
    DEFAULT_CODEX_NATIVE_DIRECT_ABSOLUTE_TIMEOUT_MS,
  )

  return {
    idleTimeoutMs: resolveTimeoutEnvValue(
      env[CODEX_NATIVE_DIRECT_IDLE_TIMEOUT_ENV],
      DEFAULT_CODEX_NATIVE_DIRECT_IDLE_TIMEOUT_MS,
    ),
    absoluteTimeoutMs: resolveTimeoutEnvValue(
      env[CODEX_NATIVE_DIRECT_ABSOLUTE_TIMEOUT_ENV],
      legacyAbsoluteTimeoutMs,
    ),
  }
}

function toCodexNativePromptText(
  prompt: string | ContentBlockParam[],
): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof prompt === 'string') {
    return {
      ok: true,
      text: prompt,
    }
  }

  if (prompt.some(block => block.type !== 'text')) {
    return {
      ok: false,
      error:
        'Codex native phase 0 only supports text-only prompts. Images, documents, and structured input are not wired yet.',
    }
  }

  const text = extractTextContent(prompt, '\n').trim()
  if (!text) {
    return {
      ok: false,
      error: 'Codex native phase 0 requires non-empty text input.',
    }
  }

  return {
    ok: true,
    text,
  }
}

function mapPermissionModeToSandboxMode(
  permissionMode: PermissionMode,
): 'read-only' | 'workspace-write' | 'danger-full-access' {
  switch (permissionMode) {
    case 'acceptEdits':
      return 'workspace-write'
    case 'bypassPermissions':
    case 'dontAsk':
      return 'danger-full-access'
    case 'default':
    case 'plan':
    case 'auto':
    case 'bubble':
    default:
      return 'read-only'
  }
}

function mapEffortToCodexNativeReasoningEffort(
  model: string,
  effortValue: EffortValue | undefined,
): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null {
  const resolved = resolveAppliedEffort(model, effortValue)
  if (resolved === undefined) {
    return null
  }
  if (typeof resolved === 'number') {
    return 'high'
  }
  if (resolved === 'max') {
    return 'xhigh'
  }
  return resolved
}

function shouldUseEphemeralCodexNativeThread(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.CLAUDE_CODE_CODEX_NATIVE_PERSIST_THREADS !== '1'
}

function resolveCodexNativeDisabledFeatures(params: {
  apiKey: string | null | undefined
  forcedLoginMethod: ReturnType<typeof getCodexForcedLoginMethod> | undefined
}): string[] {
  if (!params.apiKey || params.forcedLoginMethod === 'chatgpt') {
    return []
  }

  // Codex API-key auth cannot sync ChatGPT remote plugins. Keep user config and
  // MCP overrides intact, but disable the unsupported plugin subsystem.
  return ['plugins']
}

async function persistMessages(
  messages: Message[],
  persistSession: boolean,
  recordTranscriptImpl: typeof recordTranscript,
): Promise<void> {
  if (!persistSession) {
    return
  }
  await recordTranscriptImpl(messages)
}

async function maybeFlush(
  persistSession: boolean,
  flushSessionStorageImpl: typeof flushSessionStorage,
): Promise<void> {
  if (!persistSession) {
    return
  }
  await flushSessionStorageImpl()
}

async function appendProjectedMessage(params: {
  message: Message
  mutableMessages: Message[]
  transcriptMessages: Message[]
  persistSession: boolean
  recordTranscriptImpl: typeof recordTranscript
}): Promise<void> {
  params.mutableMessages.push(params.message)
  params.transcriptMessages.push(params.message)
  await persistMessages(
    params.transcriptMessages,
    params.persistSession,
    params.recordTranscriptImpl,
  )
}

function buildResultErrorMessage(params: {
  subtype: SDKResultMessage['subtype']
  message: string
  startTime: number
  permissionDenials: SDKPermissionDenial[]
  initialAppState: AppState
  totalUsage: NonNullableUsage
  model: string
}): SDKResultMessage {
  return {
    type: 'result',
    subtype: params.subtype,
    duration_ms: Date.now() - params.startTime,
    duration_api_ms: getTotalAPIDuration(),
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    session_id: getSessionId(),
    total_cost_usd: getTotalCost(),
    usage: params.totalUsage,
    modelUsage: getModelUsage(),
    permission_denials: params.permissionDenials,
    fast_mode_state: getFastModeState(
      params.model,
      params.initialAppState.fastMode,
    ),
    uuid: randomUUID(),
    errors: [params.message],
  }
}

function buildResultSuccessMessage(params: {
  result: string
  startTime: number
  permissionDenials: SDKPermissionDenial[]
  initialAppState: AppState
  totalUsage: NonNullableUsage
  model: string
}): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: Date.now() - params.startTime,
    duration_api_ms: getTotalAPIDuration(),
    num_turns: 1,
    result: params.result,
    stop_reason: 'end_turn',
    session_id: getSessionId(),
    total_cost_usd: getTotalCost(),
    usage: params.totalUsage,
    modelUsage: getModelUsage(),
    permission_denials: params.permissionDenials,
    fast_mode_state: getFastModeState(
      params.model,
      params.initialAppState.fastMode,
    ),
    uuid: randomUUID(),
  }
}

export async function* executeCodexNativeTurn(
  params: ExecuteCodexNativeTurnParams,
  deps: ExecuteCodexNativeTurnDeps = {},
): AsyncGenerator<SDKMessage, CodexNativeExecutionSummary, unknown> {
  const runExec = deps.runExec ?? runCodexNativeExec
  const recordTranscriptImpl = deps.recordTranscript ?? recordTranscript
  const flushSessionStorageImpl =
    deps.flushSessionStorage ?? flushSessionStorage
  const emitRuntimeTurnSettled = async (input: {
    outcome: CodexNativeTurnSettledOutcome
    threadId?: string | null
    detail?: string
  }): Promise<void> => {
    const event = buildCodexNativeTurnSettledEvent({
      cwd: params.cwd,
      outcome: input.outcome,
      threadId: input.threadId,
      detail: input.detail,
    })
    if (!event) {
      return
    }
    await emitCodexNativeTurnSettledBestEffort(
      event,
      deps.runtimeTurnSettledEmitter,
    )
  }

  params.setSDKStatus?.('running')

  for (const replayMessage of params.replayedUserMessages) {
    yield replayMessage
  }

  const resolvedPrompt = toCodexNativePromptText(params.prompt)
  const unsupportedReason =
    params.jsonSchema !== undefined
      ? 'Codex native phase 0 does not support structured-output enforcement yet.'
      : !resolvedPrompt.ok
        ? resolvedPrompt.error
        : null
  if (unsupportedReason) {
    const assistantMessage = createAssistantAPIErrorMessage({
      content: unsupportedReason,
    })
    params.mutableMessages.push(assistantMessage)
    params.transcriptMessages.push(assistantMessage)
    await persistMessages(
      params.transcriptMessages,
      params.persistSession,
      recordTranscriptImpl,
    )
    yield* normalizeMessage(assistantMessage)
    await maybeFlush(params.persistSession, flushSessionStorageImpl)
    params.setSDKStatus?.('idle')
    await emitRuntimeTurnSettled({
      outcome: 'unsupported',
      detail: unsupportedReason,
    })
    yield buildResultErrorMessage({
      subtype: 'error_during_execution',
      message: unsupportedReason,
      startTime: params.startTime,
      permissionDenials: params.permissionDenials,
      initialAppState: params.initialAppState,
      totalUsage: params.totalUsage,
      model: params.model,
    })
    return {
      totalUsage: params.totalUsage,
      binaryIdentity: null,
      threadId: null,
      credentialSource: null,
      completionPolicy: null,
      finalHistoryCompleteness: null,
      finalUsageAuthority: null,
    }
  }

  const projector = new CodexNativeTranscriptProjector(params.totalUsage)
  let binaryIdentity: CodexNativeExecutionSummary['binaryIdentity'] = null
  let threadId: CodexNativeExecutionSummary['threadId'] = null
  let credentialSource: CodexNativeExecutionSummary['credentialSource'] = null
  let completionPolicy: CodexNativeExecutionSummary['completionPolicy'] = null
  let finalHistoryCompleteness: CodexNativeExecutionSummary['finalHistoryCompleteness'] =
    null
  let finalUsageAuthority: CodexNativeExecutionSummary['finalUsageAuthority'] =
    null

  try {
    const timeoutPolicy = resolveCodexNativeExecTimeoutPolicy(
      resolvedPrompt.text,
    )
    const apiKey = getCodexNativeApiKey() ?? undefined
    const forcedLoginMethod = getCodexForcedLoginMethod() ?? undefined
    const iterator = runExec({
      prompt: resolvedPrompt.text,
      cwd: params.cwd,
      model: params.model,
      reasoningEffort: mapEffortToCodexNativeReasoningEffort(
        params.model,
        params.effortValue,
      ),
      sandboxMode: mapPermissionModeToSandboxMode(params.permissionMode),
      additionalWritableDirectories: params.additionalWritableDirectories,
      ephemeral: shouldUseEphemeralCodexNativeThread(),
      apiKey,
      forcedLoginMethod,
      configOverrides: buildCodexNativeMcpConfigOverrides(),
      disabledFeatures: resolveCodexNativeDisabledFeatures({
        apiKey,
        forcedLoginMethod,
      }),
      abortSignal: params.abortSignal,
      idleTimeoutMs: timeoutPolicy?.idleTimeoutMs ?? null,
      absoluteTimeoutMs: timeoutPolicy?.absoluteTimeoutMs ?? null,
    })

    while (true) {
      const next = await iterator.next()
      if (next.done) {
        binaryIdentity = next.value.identity
        threadId = next.value.threadId
        credentialSource = next.value.credentialSource
        completionPolicy = next.value.completionPolicy
        finalHistoryCompleteness = next.value.finalHistoryCompleteness
        finalUsageAuthority = next.value.finalUsageAuthority
        break
      }

      if (next.value.type === 'binary_identity') {
        binaryIdentity = next.value.identity
        continue
      }

      const projection = projector.apply(next.value.event)

      for (const message of projection.appendedMessages) {
        await appendProjectedMessage({
          message,
          mutableMessages: params.mutableMessages,
          transcriptMessages: params.transcriptMessages,
          persistSession: params.persistSession,
          recordTranscriptImpl,
        })

        if (message.type === 'assistant' || message.type === 'user') {
          yield* normalizeMessage(message)
        }
      }

      if (projection.turnCompleted) {
        await persistMessages(
          params.transcriptMessages,
          params.persistSession,
          recordTranscriptImpl,
        )
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (threadId) {
      await appendProjectedMessage({
        message: createCodexNativeThreadStatusMessage({
          status: 'system_error',
          threadId,
          detail: message,
        }),
        mutableMessages: params.mutableMessages,
        transcriptMessages: params.transcriptMessages,
        persistSession: params.persistSession,
        recordTranscriptImpl,
      })
    }
    const assistantMessage = createAssistantAPIErrorMessage({
      content: message,
      errorDetails: message,
    })
    params.mutableMessages.push(assistantMessage)
    params.transcriptMessages.push(assistantMessage)
    await persistMessages(
      params.transcriptMessages,
      params.persistSession,
      recordTranscriptImpl,
    )
    yield* normalizeMessage(assistantMessage)
    await maybeFlush(params.persistSession, flushSessionStorageImpl)
    params.setSDKStatus?.('idle')
    await emitRuntimeTurnSettled({
      outcome: 'error',
      threadId,
      detail: message,
    })
    yield buildResultErrorMessage({
      subtype: 'error_during_execution',
      message,
      startTime: params.startTime,
      permissionDenials: params.permissionDenials,
      initialAppState: params.initialAppState,
      totalUsage: projector.getTotalUsage(),
      model: params.model,
    })
    return {
      totalUsage: projector.getTotalUsage(),
      binaryIdentity,
      threadId,
      credentialSource,
      completionPolicy,
      finalHistoryCompleteness,
      finalUsageAuthority,
    }
  }

  await maybeFlush(params.persistSession, flushSessionStorageImpl)

  const finalAssistant = projector.getLastAssistantMessage()
  if (!finalAssistant) {
    const message =
      'Codex native completed without an assistant message. The phase-0 lane keeps this as an execution error.'
    if (threadId) {
      await appendProjectedMessage({
        message: createCodexNativeThreadStatusMessage({
          status: 'system_error',
          threadId,
          detail: message,
        }),
        mutableMessages: params.mutableMessages,
        transcriptMessages: params.transcriptMessages,
        persistSession: params.persistSession,
        recordTranscriptImpl,
      })
    }
    const assistantMessage = createAssistantAPIErrorMessage({
      content: message,
      errorDetails: message,
    })
    params.mutableMessages.push(assistantMessage)
    params.transcriptMessages.push(assistantMessage)
    await persistMessages(
      params.transcriptMessages,
      params.persistSession,
      recordTranscriptImpl,
    )
    yield* normalizeMessage(assistantMessage)
    await maybeFlush(params.persistSession, flushSessionStorageImpl)
    params.setSDKStatus?.('idle')
    await emitRuntimeTurnSettled({
      outcome: 'no_assistant',
      threadId,
      detail: message,
    })
    yield buildResultErrorMessage({
      subtype: 'error_during_execution',
      message,
      startTime: params.startTime,
      permissionDenials: params.permissionDenials,
      initialAppState: params.initialAppState,
      totalUsage: projector.getTotalUsage(),
      model: params.model,
    })
    return {
      totalUsage: projector.getTotalUsage(),
      binaryIdentity,
      threadId,
      credentialSource,
      completionPolicy,
      finalHistoryCompleteness,
      finalUsageAuthority,
    }
  }

  const executionSummaryMessage = createCodexNativeExecutionSummaryMessage({
    identity: binaryIdentity,
    threadId,
    completionPolicy,
    finalHistoryCompleteness,
    finalUsageAuthority,
  })
  if (executionSummaryMessage) {
    await appendProjectedMessage({
      message: executionSummaryMessage,
      mutableMessages: params.mutableMessages,
      transcriptMessages: params.transcriptMessages,
      persistSession: params.persistSession,
      recordTranscriptImpl,
    })
  }

  if (threadId) {
    await appendProjectedMessage({
      message: createCodexNativeThreadStatusMessage({
        status: 'completed',
        threadId,
      }),
      mutableMessages: params.mutableMessages,
      transcriptMessages: params.transcriptMessages,
      persistSession: params.persistSession,
      recordTranscriptImpl,
    })
  }

  const finalText =
    finalAssistant.message.content.find(block => block.type === 'text')?.text ??
    ''

  params.setSDKStatus?.('idle')
  await emitRuntimeTurnSettled({
    outcome: 'success',
    threadId,
  })
  yield buildResultSuccessMessage({
    result: finalText,
    startTime: params.startTime,
    permissionDenials: params.permissionDenials,
    initialAppState: params.initialAppState,
    totalUsage: projector.getTotalUsage(),
    model: params.model,
  })

  return {
    totalUsage: projector.getTotalUsage(),
    binaryIdentity,
    threadId,
    credentialSource,
    completionPolicy,
    finalHistoryCompleteness,
    finalUsageAuthority,
  }
}
