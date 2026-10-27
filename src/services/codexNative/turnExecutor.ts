import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { randomUUID } from 'crypto'
import { homedir } from 'node:os'
import path from 'node:path'

import { getSessionId, getStrictMcpConfig } from '../../bootstrap/state.js'
import type {
  SDKMessage,
  SDKPermissionDenial,
  SDKResultMessage,
  SDKStatus,
  SDKUserMessageReplay,
} from '../../entrypoints/agentSdkTypes.js'
import { getFastModeState } from '../../utils/fastMode.js'
import {
  type EffortValue,
  getEffortEnvOverride,
  resolveAppliedEffort,
} from '../../utils/effort.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  extractTextContent,
} from '../../utils/messages.js'
import type { Message } from '../../types/message.js'
import { flushSessionStorage, getTranscriptPath, isSessionStoragePersistenceEnabled, recordTranscript } from '../../utils/sessionStorage.js'
import { getAgentId, getTeamName } from '../../utils/teammate.js'
import { isHumanAuthoredTurn } from '../../utils/replayProvenance.js'
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
import {
  type CodexAppServerApprovalRequestHandler,
  type CodexManualTurnStartParams,
  buildCodexAutoExecPolicy,
  buildCodexManualAppServerThreadPolicy,
} from './appServerApproval.js'
import { runCodexNativeAppServer } from './appServerRunner.js'
import { buildCodexNativeCustomProviderConfigOverrides } from './customProviderConfigOverrides.js'
import { buildCodexNativeLaunchConfigOverrides } from './launchConfigOverrides.js'
import { buildCodexNativeStartupContextPrompt } from './nativeStartupContextPrompt.js'
import {
  buildCodexNativeUserLoopbackProviderConfigOverrides,
  resolveCodexNativeUserLoopbackLaunchConfig,
  type CodexNativeUserLoopbackLaunchConfig,
} from './userLoopbackProviderConfigOverrides.js'
import { buildCodexNativeMcpConfigOverrides } from './mcpConfigBridge.js'
import { buildCodexNativeWorkspaceTrustConfigOverrides } from './workspaceTrustConfigOverrides.js'
import {
  buildCodexNativeTurnSettledEvent,
  emitCodexNativeTurnSettledBestEffort,
  type CodexNativeTurnSettledIdentity,
  type CodexNativeTurnSettledEmitterPort,
  type CodexNativeTurnSettledOutcome,
} from './runtimeTurnSettledEmitter.js'
import {
  isWorkSyncTurnSettledOwnerGateBound,
  stageWorkSyncTurnSettledEvent,
} from '../../utils/workSyncTurnSettledOwnerGate.js'
import { readWorkSyncActiveQueryIdentity } from '../../utils/workSyncActiveQueryIdentity.js'
import {
  createCodexNativeExecutionSummaryMessage,
  createCodexNativeThreadStatusMessage,
} from './statusAuthority.js'
import { CodexNativeTranscriptProjector } from './transcriptProjector.js'
import { acquireCodexNativeConversation, type CodexNativeConversation } from './conversationBinding.js'
import type { CodexNativeConversationScope } from './conversationScope.js'
import { CodexNativeRunnerError, type CodexNativeRunnerLifecycle } from './runnerLifecycle.js'

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
  conversationScope?: CodexNativeConversationScope
  replayedUserMessages: SDKUserMessageReplay[]
  transcriptMessages: Message[]
  mutableMessages: Message[]
  totalUsage: NonNullableUsage
  permissionDenials: SDKPermissionDenial[]
  initialAppState: AppState
  startTime: number
  abortSignal?: AbortSignal
  setSDKStatus?: (status: SDKStatus) => void
  requestApproval?: CodexAppServerApprovalRequestHandler
}

type ExecuteCodexNativeTurnDeps = {
  runExec?: typeof runCodexNativeExec
  runAppServer?: typeof runCodexNativeAppServer
  recordTranscript?: typeof recordTranscript
  flushSessionStorage?: typeof flushSessionStorage
  acquireConversation?: typeof acquireCodexNativeConversation
  isPersistenceEnabled?: typeof isSessionStoragePersistenceEnabled
  runtimeTurnSettledEmitter?: CodexNativeTurnSettledEmitterPort
  buildUserLoopbackProviderConfigOverrides?: typeof buildCodexNativeUserLoopbackProviderConfigOverrides
  resolveUserLoopbackLaunchConfig?: typeof resolveCodexNativeUserLoopbackLaunchConfig
}

const EMPTY_LOOPBACK_LAUNCH_CONFIG: CodexNativeUserLoopbackLaunchConfig = {
  configOverrides: [],
  secretEnv: {},
  overlayToml: null,
}

function resolveLoopbackLaunchConfig(
  deps: ExecuteCodexNativeTurnDeps,
): CodexNativeUserLoopbackLaunchConfig {
  if (deps.resolveUserLoopbackLaunchConfig) {
    return deps.resolveUserLoopbackLaunchConfig()
  }
  if (deps.buildUserLoopbackProviderConfigOverrides) {
    return {
      configOverrides: deps.buildUserLoopbackProviderConfigOverrides(),
      secretEnv: {},
      overlayToml: null,
    }
  }
  return resolveCodexNativeUserLoopbackLaunchConfig()
}

const DEFAULT_CODEX_NATIVE_MAILBOX_IDLE_TIMEOUT_MS = 900_000
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
const CODEX_NATIVE_IGNORE_USER_CONFIG_ENV =
  'CLAUDE_CODE_CODEX_NATIVE_IGNORE_USER_CONFIG'

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

type CodexNativePreparedImageBlock = {
  type: 'image'
  source?: {
    type?: string
    path?: string
  }
  path?: string
}

function extractCodexNativePreparedImagePath(
  block: ContentBlockParam,
): string | null {
  const imageBlock = block as CodexNativePreparedImageBlock
  if (imageBlock.type !== 'image') {
    return null
  }
  if (
    imageBlock.source?.type === 'file' &&
    typeof imageBlock.source.path === 'string'
  ) {
    return imageBlock.source.path
  }
  if (typeof imageBlock.path === 'string') {
    return imageBlock.path
  }
  return null
}

function toCodexNativePromptText(
  prompt: string | ContentBlockParam[],
): {
  ok: true
  text: string
  imagePaths: string[]
  input?: CodexManualTurnStartParams['input']
} | { ok: false; error: string } {
  if (typeof prompt === 'string') {
    return {
      ok: true,
      text: prompt,
      imagePaths: [],
    }
  }

  const textBlocks: ContentBlockParam[] = []
  const imagePaths: string[] = []
  const input: CodexManualTurnStartParams['input'] = []
  for (const block of prompt) {
    if (block.type === 'text') {
      textBlocks.push(block)
      input.push({ type: 'text', text: block.text, text_elements: [] })
      continue
    }

    if (block.type === 'image') {
      const imagePath = extractCodexNativePreparedImagePath(block)
      if (!imagePath) {
        return {
          ok: false,
          error:
            'Codex native image attachments require prepared file paths. Base64 image blocks are not supported by this runtime path.',
        }
      }
      imagePaths.push(imagePath)
      input.push({ type: 'localImage', path: imagePath })
      continue
    }

    return {
      ok: false,
      error: `Codex native does not support ${block.type} attachments yet. Send text or images only.`,
    }
  }

  const text = extractTextContent(textBlocks, '\n').trim()
  if (!text) {
    return {
      ok: false,
      error: 'Codex native phase 0 requires non-empty text input.',
    }
  }

  return {
    ok: true,
    text,
    imagePaths,
    input,
  }
}

export type CodexNativeApprovalLaunchPolicy =
  | {
      transport: 'exec-json'
      approvalPolicy: 'never'
      sandboxMode: 'danger-full-access'
    }
  | {
      transport: 'app-server'
      approvalPolicy: 'on-request'
      approvalsReviewer: 'user'
      sandbox: 'read-only'
    }

export function resolveCodexNativeApprovalLaunchPolicy(
  permissionMode: PermissionMode,
): CodexNativeApprovalLaunchPolicy {
  switch (permissionMode) {
    case 'bypassPermissions':
    case 'dontAsk': {
      const policy = buildCodexAutoExecPolicy()
      return {
        transport: 'exec-json',
        approvalPolicy: policy.approvalPolicy,
        sandboxMode: policy.sandboxMode,
      }
    }
    case 'acceptEdits':
    case 'default':
    case 'plan':
    case 'auto':
    case 'bubble':
    default: {
      const policy = buildCodexManualAppServerThreadPolicy()
      return {
        transport: 'app-server',
        approvalPolicy: policy.approvalPolicy,
        approvalsReviewer: policy.approvalsReviewer,
        sandbox: policy.sandbox,
      }
    }
  }
}

function mapEffortToCodexNativeReasoningEffort(
  model: string,
  effortValue: EffortValue | undefined,
): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | null {
  const envOverride = getEffortEnvOverride()
  const explicitlyRequestedEffort =
    envOverride === null ? undefined : (envOverride ?? effortValue)
  const resolved = resolveAppliedEffort(model, effortValue)
  if (resolved === undefined) {
    return null
  }
  if (explicitlyRequestedEffort === 'max') {
    return 'max'
  }
  if (typeof resolved === 'number') {
    return 'high'
  }
  return resolved
}

function shouldIgnoreCodexNativeUserConfig(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (getStrictMcpConfig()) {
    return true
  }
  const value = env[CODEX_NATIVE_IGNORE_USER_CONFIG_ENV]?.trim().toLowerCase()
  if (!value) {
    return true
  }
  return !(value === '0' || value === 'false' || value === 'no' || value === 'off')
}

function resolveCodexNativeDisabledFeatures(params: {
  apiKey: string | null | undefined
  forcedLoginMethod: ReturnType<typeof getCodexForcedLoginMethod> | undefined
}): string[] {
  if (!params.apiKey || params.forcedLoginMethod === 'chatgpt') {
    return []
  }

  // Codex API-key auth cannot sync ChatGPT remote plugins. Keep app-owned MCP
  // overrides intact, but disable the unsupported plugin subsystem.
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

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function resolveTurnSettledIdentityFromAppState(
  appState: AppState,
): CodexNativeTurnSettledIdentity | undefined {
  const teamContext = appState.teamContext
  if (!teamContext) {
    return undefined
  }

  const teamName = trimOptional(teamContext.teamName)
  const leadAgentId = trimOptional(teamContext.leadAgentId)
  const agentId = trimOptional(teamContext.selfAgentId) ?? leadAgentId
  const agentName =
    trimOptional(teamContext.selfAgentName) ??
    (leadAgentId
      ? trimOptional(teamContext.teammates?.[leadAgentId]?.name)
      : undefined) ??
    'team-lead'

  if (!teamName || !agentId || !agentName) {
    return undefined
  }

  return { agentId, agentName, teamName }
}

export async function* executeCodexNativeTurn(
  params: ExecuteCodexNativeTurnParams,
  deps: ExecuteCodexNativeTurnDeps = {},
): AsyncGenerator<SDKMessage, CodexNativeExecutionSummary, unknown> {
  const capturedSessionId = getSessionId()
  const capturedTranscriptPath = getTranscriptPath()
  const capturedSourceProfile = path.resolve(process.env.CODEX_HOME?.trim() || path.join(homedir(), '.codex'))
  const capturedAgentId = getAgentId() ?? resolveTurnSettledIdentityFromAppState(params.initialAppState)?.agentId ?? null
  const capturedTeamName = getTeamName(params.initialAppState.teamContext) ?? null
  const currentHostTurnId = params.transcriptMessages.findLast(message => message.type === 'user')?.uuid ?? null
  const assertSessionUnchanged = (): void => {
    if (getSessionId() !== capturedSessionId) {
      throw new Error('Codex turn stopped because the host conversation changed.')
    }
  }
  function* normalizeTurnMessage(message: Message): Generator<SDKMessage> {
    for (const normalized of normalizeMessage(message)) {
      assertSessionUnchanged()
      yield normalized
    }
  }
  const runExec = deps.runExec ?? runCodexNativeExec
  const runAppServer = deps.runAppServer ?? runCodexNativeAppServer
  const recordTranscriptImpl: typeof recordTranscript = async (...args) => {
    assertSessionUnchanged()
    return (deps.recordTranscript ?? recordTranscript)(...args)
  }
  const flushSessionStorageImpl =
    deps.flushSessionStorage ?? flushSessionStorage
  const capturedQueryIdentity = readWorkSyncActiveQueryIdentity()
  let capturedTurnId: string | null = null
  const emitRuntimeTurnSettled = async (input: {
    outcome: CodexNativeTurnSettledOutcome
    threadId?: string | null
    detail?: string
  }): Promise<void> => {
    const event = buildCodexNativeTurnSettledEvent({
      cwd: params.cwd,
      outcome: input.outcome,
      threadId: input.threadId,
      turnId: capturedTurnId,
      runtimeInstanceId: capturedQueryIdentity?.runtimeInstanceId,
      completedGeneration: capturedQueryIdentity?.completedGeneration,
      detail: input.detail,
      identity: resolveTurnSettledIdentityFromAppState(params.initialAppState),
    })
    if (!event) {
      return
    }
    if (isWorkSyncTurnSettledOwnerGateBound()) {
      stageWorkSyncTurnSettledEvent(event)
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
      : resolvedPrompt.ok === false
        ? resolvedPrompt.error
        : null
  if (resolvedPrompt.ok === false || unsupportedReason) {
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
    yield* normalizeTurnMessage(assistantMessage)
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
  let conversation: CodexNativeConversation | undefined
  let nativeIterator: ReturnType<typeof runCodexNativeExec> | undefined
  let runnerTransport: 'exec' | 'app-server' | undefined
  let runnerFinished = false
  let contextAdmitted = false
  let turnTerminal = false
  let startupContextHash: string | null = null
  let lifecycle: CodexNativeRunnerLifecycle = {
    submissionMayHaveStarted: false, turnTerminal: false, childStopped: true,
  }

  try {
    try {
      if (params.persistSession &&
          (deps.isPersistenceEnabled ?? isSessionStoragePersistenceEnabled)() &&
          (params.conversationScope ?? 'direct') === 'direct') {
        // The host reference and current user row must be durable before Codex
        // can admit a prompt. Capture their path/identity before any async work.
        assertSessionUnchanged()
        await persistMessages(params.transcriptMessages, true, recordTranscriptImpl)
        await flushSessionStorageImpl()
        assertSessionUnchanged()
        conversation = await (deps.acquireConversation ?? acquireCodexNativeConversation)({
          owner: {
            sessionId: capturedSessionId,
            transcriptPath: capturedTranscriptPath,
            cwd: params.cwd,
            agentId: capturedAgentId,
            teamName: capturedTeamName,
            sourceProfile: capturedSourceProfile,
          },
          flush: flushSessionStorageImpl,
        })
        if (conversation.isNew && params.transcriptMessages.some(message =>
          message.type === 'user' && message.uuid !== currentHostTurnId && isHumanAuthoredTurn(message),
        )) {
          const notice = createAssistantMessage({
            content: '[Codex session notice] Earlier messages remain in the transcript. Native conversation continuity starts with this message; the previous ephemeral Codex history cannot be restored.',
          })
          await appendProjectedMessage({
            message: notice, mutableMessages: params.mutableMessages,
            transcriptMessages: params.transcriptMessages, persistSession: true,
            recordTranscriptImpl,
          })
          yield* normalizeTurnMessage(notice)
        }
      }
      const contextualPrompt = await buildCodexNativeStartupContextPrompt(
        resolvedPrompt.text,
        resolvedPrompt.input,
        process.env,
        conversation?.startupContextHash,
      )
      startupContextHash = contextualPrompt.contextHash
      const timeoutPolicy = resolveCodexNativeExecTimeoutPolicy(
        resolvedPrompt.text,
      )
      const forcedLoginMethod = getCodexForcedLoginMethod() ?? undefined
      const apiKey =
        forcedLoginMethod === 'chatgpt' ? undefined : (getCodexNativeApiKey() ?? undefined)
      const launchPolicy = resolveCodexNativeApprovalLaunchPolicy(
        params.permissionMode,
      )
      runnerTransport = launchPolicy.transport
      const customProviderConfigOverrides = buildCodexNativeCustomProviderConfigOverrides()
      const loopbackLaunch =
        customProviderConfigOverrides.length === 0
          ? resolveLoopbackLaunchConfig(deps)
          : EMPTY_LOOPBACK_LAUNCH_CONFIG
      const commonOptions = {
        prompt: contextualPrompt.prompt,
        imagePaths: resolvedPrompt.imagePaths,
        cwd: params.cwd,
        model: params.model,
        reasoningEffort: mapEffortToCodexNativeReasoningEffort(
          params.model,
          params.effortValue,
        ),
        // Only an owned direct conversation is persistent. Group/bootstrap and
        // explicit no-persistence callers must never import its native history.
        ephemeral: !conversation,
        resumeThreadId: conversation?.resumeThreadId,
        sessionsDirectory: conversation?.sessionsDirectory,
        apiKey,
        forcedLoginMethod,
        extraEnv: conversation
          ? { ...loopbackLaunch.secretEnv, CODEX_HOME: capturedSourceProfile }
          : loopbackLaunch.secretEnv,
        loopbackOverlayToml: loopbackLaunch.overlayToml,
        configOverrides: [
          ...customProviderConfigOverrides,
          ...loopbackLaunch.configOverrides,
          ...buildCodexNativeMcpConfigOverrides({
            strictMcpConfig: getStrictMcpConfig(),
          }),
          ...buildCodexNativeWorkspaceTrustConfigOverrides(),
          ...buildCodexNativeLaunchConfigOverrides(),
        ],
        disabledFeatures: resolveCodexNativeDisabledFeatures({
          apiKey,
          forcedLoginMethod,
        }),
        abortSignal: conversation
          ? AbortSignal.any([conversation.signal, ...(params.abortSignal ? [params.abortSignal] : [])])
          : params.abortSignal,
        idleTimeoutMs: timeoutPolicy?.idleTimeoutMs ?? null,
        absoluteTimeoutMs: timeoutPolicy?.absoluteTimeoutMs ?? null,
      }
      nativeIterator =
        launchPolicy.transport === 'app-server'
          ? runAppServer({
              ...commonOptions,
              input: contextualPrompt.input,
              loopbackOverlayToml: loopbackLaunch.overlayToml,
              requestApproval:
                params.requestApproval ??
                (async () => {
                  throw new Error('update Codex CLI or enable auto-approve')
                }),
            })
          : runExec({
              ...commonOptions,
              approvalPolicy: launchPolicy.approvalPolicy,
              sandboxMode: launchPolicy.sandboxMode,
              additionalWritableDirectories: params.additionalWritableDirectories,
              ignoreUserConfig: shouldIgnoreCodexNativeUserConfig(),
            })

      while (true) {
        assertSessionUnchanged()
        conversation?.assertOwned()
        lifecycle = { submissionMayHaveStarted: true, turnTerminal, childStopped: false }
        let next: Awaited<ReturnType<typeof nativeIterator.next>>
        try {
          next = await nativeIterator.next()
        } catch (error) {
          // A throwing generator has already finalized. Calling return() on it
          // would be a no-op, not evidence that an unconfirmed child has stopped.
          runnerFinished = true
          throw error
        }
        assertSessionUnchanged()
        if (next.done) {
          runnerFinished = true
          lifecycle.childStopped = true
          binaryIdentity = next.value.identity
          if (conversation && (!threadId || next.value.threadId !== threadId || !turnTerminal)) {
            throw new Error('Codex native ended without confirming the owned thread and a terminal turn.')
          }
          threadId = next.value.threadId
          credentialSource = next.value.credentialSource
          completionPolicy = next.value.completionPolicy
          finalHistoryCompleteness = next.value.finalHistoryCompleteness
          finalUsageAuthority = next.value.finalUsageAuthority
          lifecycle = { submissionMayHaveStarted: true, turnTerminal, childStopped: true }
          break
        }

        if (next.value.type === 'binary_identity') {
          if (runnerTransport === 'app-server') lifecycle.submissionMayHaveStarted = false
          binaryIdentity = next.value.identity
          continue
        }

        if (next.value.event.type === 'thread_started') {
          if (runnerTransport === 'app-server') lifecycle.submissionMayHaveStarted = false
          threadId = next.value.event.threadId
          // App-server yields this identity before turn/start; do not advance
          // the iterator until the exact UUID has been committed.
          await conversation?.recordThread(threadId)
        }
        if (['turn_started', 'assistant_text', 'tool_call_started', 'tool_call_completed'].includes(next.value.event.type)) {
          contextAdmitted = true
        }
        if (next.value.event.type === 'turn_completed') turnTerminal = true

        const projection = projector.apply(next.value.event)
        if (
          (next.value.event.type === 'turn_started' ||
            next.value.event.type === 'turn_completed') &&
          next.value.event.turnId &&
          !capturedTurnId
        ) {
          capturedTurnId = next.value.event.turnId
        }

        for (const message of projection.appendedMessages) {
          await appendProjectedMessage({
            message,
            mutableMessages: params.mutableMessages,
            transcriptMessages: params.transcriptMessages,
            persistSession: params.persistSession,
            recordTranscriptImpl,
          })

          if (message.type === 'assistant' || message.type === 'user') {
            yield* normalizeTurnMessage(message)
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
      if (error instanceof CodexNativeRunnerError) lifecycle = { ...error.lifecycle }
      throw error
    } finally {
      try {
        if (nativeIterator && !runnerFinished) {
          try {
            await nativeIterator.return(undefined as never)
            // Both runners await owned-child shutdown in their finalizers.
            lifecycle.childStopped = true
            lifecycle.turnTerminal ||= turnTerminal
          } catch (error) {
            if (error instanceof CodexNativeRunnerError) lifecycle = { ...error.lifecycle }
            throw error
          }
        }
      } finally {
        if (conversation) {
          try {
            await conversation.settle({
              ...lifecycle, contextAdmitted, startupContextHash,
              hostTurnId: currentHostTurnId,
            })
          } finally {
            await conversation.release()
          }
        }
      }
    }
  } catch (error) {
    // /clear or a session switch must not append the old turn to its successor.
    if (getSessionId() !== capturedSessionId) throw error
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
    yield* normalizeTurnMessage(assistantMessage)
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
  assertSessionUnchanged()

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
    yield* normalizeTurnMessage(assistantMessage)
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
  assertSessionUnchanged()
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
