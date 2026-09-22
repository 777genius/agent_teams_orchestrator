import { createSystemMessage } from '../../utils/messages.js'
import type { Message } from '../../types/message.js'
import type {
  CodexNativeBinaryIdentity,
  CodexNativeFinalUsageAuthority,
  CodexNativeHistoryCompleteness,
} from './execRunner.js'

export type CodexNativeWarningSource = 'process' | 'history' | 'config'
export type CodexNativeThreadStatus = 'running' | 'completed' | 'system_error'

type CodexNativeSystemMessageMetadata = {
  subtype: string
  codexNativeWarningSource?: CodexNativeWarningSource
  codexNativeThreadStatus?: CodexNativeThreadStatus
  codexNativeThreadId?: string
  codexNativeCompletionPolicy?: 'ephemeral' | 'persistent'
  codexNativeHistoryCompleteness?: CodexNativeHistoryCompleteness
  codexNativeFinalUsageAuthority?: CodexNativeFinalUsageAuthority
  codexNativeExecutablePath?: string
  codexNativeExecutableSource?: CodexNativeBinaryIdentity['executableSource']
  codexNativeExecutableVersion?: string | null
}

function withCodexNativeMetadata(
  message: Message,
  metadata: CodexNativeSystemMessageMetadata,
): Message {
  return Object.assign(message, metadata)
}

export function classifyCodexNativeWarningSource(
  text: string,
): CodexNativeWarningSource {
  const lower = text.toLowerCase()
  if (
    lower.includes('thread/read') ||
    lower.includes('backfill') ||
    lower.includes('includeturns') ||
    lower.includes('hydrat')
  ) {
    return 'history'
  }
  if (
    lower.includes('codex_api_key') ||
    lower.includes('openai_api_key') ||
    lower.includes('authentication required') ||
    lower.includes('requires the codex cli') ||
    lower.includes('not found')
  ) {
    return 'config'
  }
  return 'process'
}

export function createCodexNativeWarningMessage(text: string): Message {
  return withCodexNativeMetadata(createSystemMessage(text, 'warning'), {
    subtype: 'codex_native_warning',
    codexNativeWarningSource: classifyCodexNativeWarningSource(text),
  })
}

export function createCodexNativeUnsupportedRawEventMessage(
  rawType: string,
): Message {
  return withCodexNativeMetadata(
    createSystemMessage(
      `Codex native emitted an unsupported raw event: ${rawType}`,
      'warning',
    ),
    {
      subtype: 'codex_native_warning',
      codexNativeWarningSource: 'process',
    },
  )
}

export function createCodexNativeThreadStatusMessage(params: {
  status: CodexNativeThreadStatus
  threadId?: string | null
  detail?: string | null
}): Message {
  const threadIdPart = params.threadId ? ` (${params.threadId})` : ''
  const detailPart = params.detail ? ` ${params.detail}` : ''
  const content =
    params.status === 'running'
      ? `Codex native thread started${threadIdPart}.`
      : params.status === 'completed'
        ? `Codex native thread completed${threadIdPart}.`
        : `Codex native thread failed${threadIdPart}.${detailPart}`.trim()

  return withCodexNativeMetadata(
    createSystemMessage(
      content,
      params.status === 'system_error' ? 'error' : 'info',
    ),
    {
      subtype: 'codex_native_thread_status',
      codexNativeThreadStatus: params.status,
      codexNativeThreadId: params.threadId ?? undefined,
    },
  )
}

export function createCodexNativeExecutionSummaryMessage(params: {
  identity: CodexNativeBinaryIdentity | null
  threadId: string | null
  completionPolicy: 'ephemeral' | 'persistent' | null
  finalHistoryCompleteness: CodexNativeHistoryCompleteness | null
  finalUsageAuthority: CodexNativeFinalUsageAuthority | null
}): Message | null {
  if (
    !params.identity &&
    !params.threadId &&
    !params.completionPolicy &&
    !params.finalHistoryCompleteness &&
    !params.finalUsageAuthority
  ) {
    return null
  }

  const fragments = [
    params.threadId ? `thread=${params.threadId}` : null,
    params.completionPolicy ? `completion=${params.completionPolicy}` : null,
    params.finalHistoryCompleteness
      ? `history=${params.finalHistoryCompleteness}`
      : null,
    params.finalUsageAuthority
      ? `usageAuthority=${params.finalUsageAuthority}`
      : null,
    params.identity?.version ? `binary=${params.identity.version}` : null,
  ].filter(Boolean)

  return withCodexNativeMetadata(
    createSystemMessage(
      `Codex native execution summary: ${fragments.join(', ')}`,
      'info',
    ),
    {
      subtype: 'codex_native_execution_summary',
      codexNativeThreadId: params.threadId ?? undefined,
      codexNativeCompletionPolicy: params.completionPolicy ?? undefined,
      codexNativeHistoryCompleteness:
        params.finalHistoryCompleteness ?? undefined,
      codexNativeFinalUsageAuthority:
        params.finalUsageAuthority ?? undefined,
      codexNativeExecutablePath: params.identity?.executablePath,
      codexNativeExecutableSource: params.identity?.executableSource,
      codexNativeExecutableVersion: params.identity?.version ?? null,
    },
  )
}
