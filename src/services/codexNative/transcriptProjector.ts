import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

import {
  createAssistantMessage,
  createUserMessage,
} from '../../utils/messages.js'
import type { Message, UserMessage } from '../../types/message.js'
import type { NonNullableUsage } from '../../entrypoints/sdk/coreTypes.js'
import { getSessionId } from '../../bootstrap/state.js'
import { getAgentId } from '../../utils/teammate.js'
import { EMPTY_USAGE } from '../api/emptyUsage.js'
import {
  annotateAmbientBoardTaskExecutionMessage,
  annotateBoardTaskToolResultMessage,
} from '../boardTaskActivity/BoardTaskTranscriptProjector.js'
import type { CodexNativeNormalizedEvent } from './normalizedEvents.js'
import {
  createCodexNativeThreadStatusMessage,
  createCodexNativeUnsupportedRawEventMessage,
  createCodexNativeWarningMessage,
} from './statusAuthority.js'

function buildAssistantUsage(event: Extract<CodexNativeNormalizedEvent, { type: 'usage_updated' }>): Usage {
  return {
    input_tokens: event.inputTokens,
    output_tokens: event.outputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: event.cachedInputTokens,
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
  }
}

function accumulateCodexNativeUsage(
  total: NonNullableUsage,
  usage: Usage,
): NonNullableUsage {
  return {
    input_tokens: total.input_tokens + usage.input_tokens,
    output_tokens: total.output_tokens + usage.output_tokens,
    cache_creation_input_tokens:
      total.cache_creation_input_tokens + (usage.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens:
      total.cache_read_input_tokens + (usage.cache_read_input_tokens ?? 0),
    cache_creation: {
      ephemeral_1h_input_tokens:
        total.cache_creation.ephemeral_1h_input_tokens +
        (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0),
      ephemeral_5m_input_tokens:
        total.cache_creation.ephemeral_5m_input_tokens +
        (usage.cache_creation?.ephemeral_5m_input_tokens ?? 0),
    },
  }
}

function buildCodexNativeMcpToolName(params: {
  serverName: string
  toolName: string
}): string {
  return `mcp__${params.serverName}__${params.toolName}`
}

function buildCodexNativeToolName(event: Extract<
  CodexNativeNormalizedEvent,
  { type: 'tool_call_started' | 'tool_call_completed' }
>): string {
  if (event.toolSource === 'mcp') {
    if (!event.serverName) {
      return event.toolName
    }
    return buildCodexNativeMcpToolName({
      serverName: event.serverName,
      toolName: event.toolName,
    })
  }
  return event.toolName
}

function buildCodexNativeToolResultContent(event: Extract<
  CodexNativeNormalizedEvent,
  { type: 'tool_call_completed' }
>): string {
  if (event.resultText && event.resultText.trim().length > 0) {
    return event.resultText
  }
  if (event.isError) {
    const detail = event.errorMessage?.trim() || 'Codex native tool call failed.'
    return `<tool_use_error>${detail}</tool_use_error>`
  }
  return 'Tool completed successfully.'
}

export class CodexNativeTranscriptProjector {
  private lastAssistantMessage: Extract<Message, { type: 'assistant' }> | null =
    null
  private totalUsage: NonNullableUsage

  constructor(initialUsage: NonNullableUsage = EMPTY_USAGE) {
    this.totalUsage = initialUsage
  }

  apply(
    event: CodexNativeNormalizedEvent,
  ): { appendedMessages: Message[]; turnCompleted: boolean } {
    switch (event.type) {
      case 'assistant_text': {
        const message = this.annotateTaskAwareMessage(
          createAssistantMessage({ content: event.text }),
        ) as Extract<Message, { type: 'assistant' }>
        this.lastAssistantMessage = message
        return {
          appendedMessages: [message],
          turnCompleted: false,
        }
      }
      case 'tool_call_started': {
        const toolUseMessage = this.annotateTaskAwareMessage(
          createAssistantMessage({
            content: [
              {
                type: 'tool_use',
                id: event.itemId,
                name: buildCodexNativeToolName(event),
                input: event.arguments,
              } as never,
            ],
          }),
        ) as Extract<Message, { type: 'assistant' }>
        if (!this.lastAssistantMessage) {
          this.lastAssistantMessage = toolUseMessage
        }
        return {
          appendedMessages: [toolUseMessage],
          turnCompleted: false,
        }
      }
      case 'tool_call_completed': {
        const toolResultMessage = this.annotateTaskAwareMessage(
          createUserMessage({
            content: [
              {
                type: 'tool_result',
                tool_use_id: event.itemId,
                content: buildCodexNativeToolResultContent(event),
                is_error: event.isError,
              } as never,
            ],
            toolUseResult: event.rawResult,
          }),
          event,
        )
        return {
          appendedMessages: [toolResultMessage],
          turnCompleted: false,
        }
      }
      case 'usage_updated': {
        if (this.lastAssistantMessage) {
          const usage = buildAssistantUsage(event)
          this.lastAssistantMessage.message.usage = usage
          this.totalUsage = accumulateCodexNativeUsage(this.totalUsage, usage)
        }
        return {
          appendedMessages: [],
          turnCompleted: false,
        }
      }
      case 'warning':
        return {
          appendedMessages: [createCodexNativeWarningMessage(event.text)],
          turnCompleted: false,
        }
      case 'unsupported_raw_event':
        return {
          appendedMessages: [
            createCodexNativeUnsupportedRawEventMessage(event.rawType),
          ],
          turnCompleted: false,
        }
      case 'turn_completed':
        return {
          appendedMessages: [],
          turnCompleted: true,
        }
      case 'thread_started':
        return {
          appendedMessages: [
            createCodexNativeThreadStatusMessage({
              status: 'running',
              threadId: event.threadId,
            }),
          ],
          turnCompleted: false,
        }
      case 'turn_started':
        return {
          appendedMessages: [],
          turnCompleted: false,
        }
    }
  }

  getTotalUsage(): NonNullableUsage {
    return this.totalUsage
  }

  getLastAssistantMessage(): Extract<Message, { type: 'assistant' }> | null {
    return this.lastAssistantMessage
  }

  private annotateTaskAwareMessage(
    message: Message,
    toolResultEvent?: Extract<CodexNativeNormalizedEvent, { type: 'tool_call_completed' }>,
  ): Message {
    const sessionId = getSessionId()
    const agentId = getAgentId()

    const explicitlyAnnotated =
      toolResultEvent && message.type === 'user' && toolResultEvent.toolSource === 'mcp'
        ? annotateBoardTaskToolResultMessage({
            message: message as UserMessage,
            toolName: buildCodexNativeToolName(toolResultEvent),
            input: toolResultEvent.arguments,
            result: toolResultEvent.rawResult,
            toolUseId: toolResultEvent.itemId,
            sessionId,
            agentId,
          })
        : message

    return annotateAmbientBoardTaskExecutionMessage({
      message: explicitlyAnnotated,
      sessionId,
      agentId,
    })
  }
}
