import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'

import { isSessionPersistenceDisabled } from '../../bootstrap/state.js'
import type { SDKMessage } from '../../entrypoints/agentSdkTypes.js'
import { convertSDKMessage } from '../../remote/sdkMessageAdapter.js'
import type { AppState } from '../../state/AppState.js'
import type { Message, StreamEvent } from '../../types/message.js'
import type { EffortValue } from '../../utils/effort.js'
import { isNotEmptyMessage } from '../../utils/messages.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { EMPTY_USAGE } from '../api/emptyUsage.js'
import type { CodexAppServerApprovalRequestHandler } from './appServerApproval.js'
import { executeCodexNativeTurn } from './turnExecutor.js'

type RunCodexNativeTurnInReplParams = {
  prompt: string | ContentBlockParam[]
  cwd: string
  model: string
  effortValue: EffortValue | undefined
  permissionMode: PermissionMode
  additionalWritableDirectories: string[]
  initialAppState: AppState
  transcriptMessages: Message[]
  abortSignal?: AbortSignal
  requestApproval: CodexAppServerApprovalRequestHandler
  onReplEvent: (event: Message | StreamEvent) => void
}

type RunCodexNativeTurnInReplDeps = {
  executeTurn?: typeof executeCodexNativeTurn
}

function shouldSuppressResultMessage(
  sdkMessage: SDKMessage,
  emittedAssistantError: boolean,
): boolean {
  if (sdkMessage.type !== 'result') {
    return false
  }

  if (sdkMessage.subtype === 'success') {
    return true
  }

  return emittedAssistantError
}

export async function runCodexNativeTurnInRepl(
  params: RunCodexNativeTurnInReplParams,
  deps: RunCodexNativeTurnInReplDeps = {},
): Promise<void> {
  const executeTurn = deps.executeTurn ?? executeCodexNativeTurn
  const mutableMessages = [...params.transcriptMessages]
  const persistedTranscriptMessages = [...params.transcriptMessages]
  const initialTranscriptLength = persistedTranscriptMessages.length
  let emittedAssistantError = false
  const emittedMessageUuids = new Set<string>()

  for await (const sdkMessage of executeTurn({
    prompt: params.prompt,
    cwd: params.cwd,
    model: params.model,
    effortValue: params.effortValue,
    permissionMode: params.permissionMode,
    additionalWritableDirectories: params.additionalWritableDirectories,
    persistSession: !isSessionPersistenceDisabled(),
    replayedUserMessages: [],
    transcriptMessages: persistedTranscriptMessages,
    mutableMessages,
    totalUsage: { ...EMPTY_USAGE },
    permissionDenials: [],
    initialAppState: params.initialAppState,
    startTime: Date.now(),
    abortSignal: params.abortSignal,
    requestApproval: params.requestApproval,
  })) {
    if (sdkMessage.type === 'assistant' && sdkMessage.error) {
      emittedAssistantError = true
    }

    if (shouldSuppressResultMessage(sdkMessage, emittedAssistantError)) {
      if (
        sdkMessage.type === 'result' &&
        sdkMessage.subtype === 'success' &&
        !sdkMessage.is_error &&
        !emittedAssistantError &&
        !params.abortSignal?.aborted
      ) {
        // SDK output omits empty assistants, but the live REPL mailbox needs
        // the actual successful turn receipt. Preserve its original UUID;
        // the UI still hides it through isNotEmptyMessage. Never infer one
        // from a result or forward a failed/cancelled turn as completion.
        for (const message of persistedTranscriptMessages.slice(
          initialTranscriptLength,
        )) {
          if (
            message.type === 'assistant' &&
            !isNotEmptyMessage(message) &&
            !emittedMessageUuids.has(message.uuid)
          ) {
            emittedMessageUuids.add(message.uuid)
            params.onReplEvent(message)
          }
        }
      }
      continue
    }

    const converted = convertSDKMessage(sdkMessage, {
      convertToolResults: true,
    })
    if (converted.type === 'message') {
      emittedMessageUuids.add(converted.message.uuid)
      params.onReplEvent(converted.message)
      continue
    }
    if (converted.type === 'stream_event') {
      params.onReplEvent(converted.event)
    }
  }
}
