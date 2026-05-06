import type {
  OpenCodeCanonicalContentBlock,
  OpenCodeCanonicalMessage,
  OpenCodeCanonicalMessageRole,
  OpenCodeCanonicalToolCall,
  OpenCodeCanonicalToolStatus,
  OpenCodeMessage,
  OpenCodeMessagePart,
  OpenCodeTranscriptProjection,
} from './types.js'
import { isOpenCodeAppManagedBootstrapMessage } from './OpenCodeAppManagedBootstrapMessage.js'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function buildPreviewText(value: string): string | null {
  const compacted = compactText(value)
  if (!compacted) {
    return null
  }
  return compacted.length <= 160 ? compacted : `${compacted.slice(0, 157)}...`
}

function toRole(value: string | null): OpenCodeCanonicalMessageRole {
  if (value === 'user' || value === 'assistant' || value === 'system') {
    return value
  }
  return 'unknown'
}

function normalizeToolStatus(value: string | null): OpenCodeCanonicalToolStatus {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'running') {
    return 'running'
  }
  if (normalized === 'completed' || normalized === 'success') {
    return 'completed'
  }
  if (
    normalized === 'error'
    || normalized === 'errored'
    || normalized === 'failed'
    || normalized === 'aborted'
    || normalized === 'denied'
  ) {
    return 'errored'
  }
  return 'unknown'
}

function extractError(info: Record<string, unknown>): {
  errorName: string | null
  errorMessage: string | null
} {
  const error = asRecord(info.error)
  if (!error) {
    return {
      errorName: null,
      errorMessage: null,
    }
  }

  const data = asRecord(error.data)
  return {
    errorName: asString(error.name),
    errorMessage:
      asString(error.message)
      ?? asString(data?.message)
      ?? asString(data?.error)
      ?? null,
  }
}

function extractMessageModel(info: Record<string, unknown>): {
  providerId: string | null
  modelId: string | null
} {
  const providerId = asString(info.providerID)
  const modelId = asString(info.modelID)
  if (providerId || modelId) {
    return { providerId, modelId }
  }

  const model = asRecord(info.model)
  return {
    providerId: asString(model?.providerID),
    modelId: asString(model?.modelID),
  }
}

function extractToolCall(part: OpenCodeMessagePart): {
  toolCall: OpenCodeCanonicalToolCall
  contentBlocks: OpenCodeCanonicalContentBlock[]
} | null {
  const partRecord = asRecord(part)
  const state = asRecord(partRecord?.state)
  if (!partRecord || !state) {
    return null
  }

  const status = normalizeToolStatus(asString(state.status))
  const time = asRecord(state.time)
  const input = asRecord(state.input)
  const metadata = asRecord(state.metadata)
  const rawOutput = state.output ?? metadata?.output ?? null
  const outputText =
    typeof rawOutput === 'string'
      ? rawOutput
      : asString(metadata?.message)
        ?? asString(metadata?.error)
        ?? null

  let isError = status === 'errored'
  if (!isError && typeof metadata?.exit === 'number' && metadata.exit !== 0) {
    isError = true
  }
  if (!isError && asString(metadata?.error)) {
    isError = true
  }

  const toolCall: OpenCodeCanonicalToolCall = {
    callId: asString(partRecord.callID),
    toolName: asString(partRecord.tool),
    title: asString(state.title),
    status,
    input,
    output: rawOutput,
    outputText,
    outputPreview: outputText ? buildPreviewText(outputText) : null,
    startedAt: asNumber(time?.start),
    completedAt: asNumber(time?.end),
    isError,
  }

  const contentBlocks: OpenCodeCanonicalContentBlock[] = [
    {
      type: 'tool_use',
      id: toolCall.callId,
      name: toolCall.toolName,
      title: toolCall.title,
      status: toolCall.status,
      input: toolCall.input,
      startedAt: toolCall.startedAt,
      completedAt: toolCall.completedAt,
    },
  ]

  if (toolCall.output !== null || toolCall.outputText || toolCall.isError) {
    contentBlocks.push({
      type: 'tool_result',
      toolUseId: toolCall.callId,
      toolName: toolCall.toolName,
      title: toolCall.title,
      status: toolCall.status,
      contentText: toolCall.outputText,
      contentPreview: toolCall.outputPreview,
      rawContent: toolCall.output,
      isError: toolCall.isError,
      startedAt: toolCall.startedAt,
      completedAt: toolCall.completedAt,
    })
  }

  return {
    toolCall,
    contentBlocks,
  }
}

function projectMessage(message: OpenCodeMessage): OpenCodeCanonicalMessage {
  const info = asRecord(message.info) ?? {}
  const time = asRecord(info.time)
  const role = toRole(asString(info.role))
  const {
    providerId,
    modelId,
  } = extractMessageModel(info)
  const {
    errorName,
    errorMessage,
  } = extractError(info)

  const contentBlocks: OpenCodeCanonicalContentBlock[] = []
  const textSegments: string[] = []
  const reasoningSegments: string[] = []
  const toolCalls: OpenCodeCanonicalToolCall[] = []

  for (const part of message.parts) {
    switch (part.type) {
      case 'text': {
        const text = asString(part.text)
        if (!text) {
          break
        }
        contentBlocks.push({
          type: 'text',
          text,
        })
        textSegments.push(text)
        break
      }
      case 'reasoning': {
        const text = asString(part.text)
        if (!text) {
          break
        }
        contentBlocks.push({
          type: 'reasoning',
          text,
        })
        reasoningSegments.push(text)
        break
      }
      case 'tool': {
        const projected = extractToolCall(part)
        if (!projected) {
          break
        }
        toolCalls.push(projected.toolCall)
        contentBlocks.push(...projected.contentBlocks)
        break
      }
      case 'step-start':
        contentBlocks.push({ type: 'step_start' })
        break
      case 'step-finish': {
        const partRecord = asRecord(part)
        contentBlocks.push({
          type: 'step_finish',
          reason: asString(partRecord?.reason),
        })
        break
      }
      default:
        break
    }
  }

  if (errorName || errorMessage) {
    contentBlocks.push({
      type: 'error',
      name: errorName ?? 'OpenCodeError',
      message: errorMessage ?? 'Unknown OpenCode runtime error',
    })
  }

  const text = textSegments.join('\n\n').trim()
  const reasoningText = reasoningSegments.join('\n\n').trim()
  const finishReason =
    asString(info.finish)
    ?? (() => {
      for (let index = message.parts.length - 1; index >= 0; index -= 1) {
        const reason = asString(asRecord(message.parts[index])?.reason)
        if (reason) {
          return reason
        }
      }
      return null
    })()

  return {
    id: asString(info.id),
    parentId: asString(info.parentID),
    role,
    agent: asString(info.agent),
    providerId,
    modelId,
    createdAt: asNumber(time?.created),
    completedAt: asNumber(time?.completed),
    text,
    reasoningText,
    previewText: buildPreviewText(text),
    partTypes: message.parts.map(part => part.type ?? 'unknown'),
    reasoningPartCount: reasoningSegments.length,
    toolCalls,
    contentBlocks,
    finishReason,
    errorName,
    errorMessage,
    hasError: Boolean(errorName || errorMessage),
  }
}

export class OpenCodeTranscriptProjector {
  projectSessionMessages(params: {
    sessionId: string
    messages: OpenCodeMessage[]
  }): OpenCodeTranscriptProjection {
    const messages = params.messages
      .filter(message => !isOpenCodeAppManagedBootstrapMessage(message))
      .map(projectMessage)
    return {
      sessionId: params.sessionId,
      messageCount: messages.length,
      toolCallCount: messages.reduce((count, message) => count + message.toolCalls.length, 0),
      errorCount: messages.reduce(
        (count, message) => count + (message.hasError ? 1 : 0),
        0,
      ),
      messages,
    }
  }
}

export const openCodeTranscriptProjector = new OpenCodeTranscriptProjector()
