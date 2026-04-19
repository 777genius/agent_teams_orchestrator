import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

import {
  createAssistantMessage,
} from '../../utils/messages.js'
import type { Message } from '../../types/message.js'
import type { NonNullableUsage } from '../../entrypoints/sdk/coreTypes.js'
import { EMPTY_USAGE } from '../api/emptyUsage.js'
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
        const message = createAssistantMessage({ content: event.text })
        this.lastAssistantMessage = message
        return {
          appendedMessages: [message],
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
}
