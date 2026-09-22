import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'

import { isSessionPersistenceDisabled } from '../../bootstrap/state.js'
import type { SDKMessage } from '../../entrypoints/agentSdkTypes.js'
import { convertSDKMessage } from '../../remote/sdkMessageAdapter.js'
import type { AppState } from '../../state/AppState.js'
import type { Message, StreamEvent } from '../../types/message.js'
import type { EffortValue } from '../../utils/effort.js'
import type { PermissionMode } from '../../utils/permissions/PermissionMode.js'
import { EMPTY_USAGE } from '../api/emptyUsage.js'
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
  let emittedAssistantError = false

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
  })) {
    if (sdkMessage.type === 'assistant' && sdkMessage.error) {
      emittedAssistantError = true
    }

    if (shouldSuppressResultMessage(sdkMessage, emittedAssistantError)) {
      continue
    }

    const converted = convertSDKMessage(sdkMessage, {
      convertToolResults: true,
    })
    if (converted.type === 'message') {
      params.onReplEvent(converted.message)
      continue
    }
    if (converted.type === 'stream_event') {
      params.onReplEvent(converted.event)
    }
  }
}
