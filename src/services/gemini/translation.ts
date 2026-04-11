import { getMainLoopModel } from '../../utils/model/model.js'
import { isGeminiModel, mapModelAliasToGemini } from '../../utils/model/gemini.js'
import {
  getAnthropicRequestedEffortLevel,
  mapEffortToGeminiThinkingConfig,
} from '../../utils/providerEffort.js'
import type {
  GeminiNormalizedChunk,
  GeminiNormalizedPart,
  GeminiNormalizedRequest,
  GeminiNormalizedResponseEnvelope,
  GeminiNormalizedTool,
} from './types.js'

type AnthropicContentBlock = {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  source?: {
    type?: string
    media_type?: string
    data?: string
  }
  [key: string]: unknown
}

type AnthropicMessage = {
  role: string
  content: string | AnthropicContentBlock[]
}

type AnthropicTool = {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

const GEMINI_SUPPORTED_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'default',
  'items',
  'minItems',
  'maxItems',
  'enum',
  'properties',
  'propertyOrdering',
  'required',
  'minProperties',
  'maxProperties',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'example',
  'anyOf',
  'additionalProperties',
  'ref',
  'defs',
])

function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

function stripAnthropicSystemHeaders(
  system:
    | string
    | Array<{ type: string; text?: string; cache_control?: unknown }>
    | undefined,
): string {
  if (!system) return ''
  const blocks =
    typeof system === 'string'
      ? system
          .split('\n')
          .map(block => block.trim())
          .filter(Boolean)
      : system
          .filter(block => block.type === 'text' && typeof block.text === 'string')
          .map(block => block.text!)

  return blocks
    .filter(block => !block.startsWith('x-anthropic-billing-header'))
    .join('\n')
    .trim()
}

function sanitizeGeminiSchema(
  value: unknown,
  isRoot: boolean = false,
): unknown {
  if (Array.isArray(value)) {
    return value
      .map(item => sanitizeGeminiSchema(item))
      .filter(item => item !== undefined)
  }

  if (typeof value !== 'object' || value === null) {
    return value
  }

  const input = value as Record<string, unknown>
  const output: Record<string, unknown> = {}

  for (const [rawKey, rawChild] of Object.entries(input)) {
    const mappedKey =
      rawKey === '$ref' ? 'ref' : rawKey === '$defs' ? 'defs' : rawKey
    if (!GEMINI_SUPPORTED_SCHEMA_KEYS.has(mappedKey)) {
      continue
    }

    const child =
      mappedKey === 'properties' && typeof rawChild === 'object' && rawChild !== null
        ? Object.fromEntries(
            Object.entries(rawChild).flatMap(([propertyName, propertySchema]) => {
              const sanitizedPropertySchema = sanitizeGeminiSchema(propertySchema)
              return sanitizedPropertySchema === undefined
                ? []
                : [[propertyName, sanitizedPropertySchema]]
            }),
          )
        : mappedKey === 'defs' && typeof rawChild === 'object' && rawChild !== null
          ? Object.fromEntries(
              Object.entries(rawChild).flatMap(([definitionName, definitionSchema]) => {
                const sanitizedDefinitionSchema = sanitizeGeminiSchema(
                  definitionSchema,
                  isRoot,
                )
                return sanitizedDefinitionSchema === undefined
                  ? []
                  : [[definitionName, sanitizedDefinitionSchema]]
              }),
            )
          : sanitizeGeminiSchema(
              rawChild,
              isRoot && mappedKey === 'defs',
            )
    if (child !== undefined) {
      output[mappedKey] = child
    }
  }

  if (
    output.type === 'object' &&
    !Array.isArray(output.propertyOrdering) &&
    output.properties &&
    typeof output.properties === 'object'
  ) {
    output.propertyOrdering = Object.keys(
      output.properties as Record<string, unknown>,
    )
  }

  if (Array.isArray(output.required)) {
    if (output.properties && typeof output.properties === 'object') {
      const propertyNames = new Set(
        Object.keys(output.properties as Record<string, unknown>),
      )
      output.required = output.required.filter(
        field => typeof field === 'string' && propertyNames.has(field),
      )
    } else {
      delete output.required
    }
  }

  if (!isRoot && 'defs' in output) {
    delete output.defs
  }

  return output
}

function translateTools(tools: AnthropicTool[]): GeminiNormalizedTool[] | undefined {
  if (tools.length === 0) return undefined
  return [
    {
      functionDeclarations: tools.map(tool => ({
        name: tool.name,
        description: tool.description ?? '',
        parameters:
          (sanitizeGeminiSchema(tool.input_schema ?? {
            type: 'object',
            properties: {},
          }, true) as Record<string, unknown>) ?? {
            type: 'object',
            properties: {},
          },
      })),
    },
  ]
}

function normalizeToolResultContent(
  content: string | AnthropicContentBlock[] | undefined,
): unknown {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  const textParts = content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
  return textParts.join('\n')
}

function translateMessageParts(
  message: AnthropicMessage,
  toolNames: Map<string, string>,
): GeminiNormalizedPart[] {
  if (typeof message.content === 'string') {
    return [{ text: message.content }]
  }

  const parts: GeminiNormalizedPart[] = []
  for (const block of message.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ text: block.text })
      continue
    }

    if (
      block.type === 'image' &&
      block.source?.type === 'base64' &&
      block.source.media_type &&
      block.source.data
    ) {
      parts.push({
        inlineData: {
          mimeType: block.source.media_type,
          data: block.source.data,
        },
      })
      continue
    }

    if (block.type === 'tool_use') {
      if (block.id && block.name) {
        toolNames.set(block.id, block.name)
      }
      parts.push({
        functionCall: {
          id: block.id,
          name: block.name ?? '',
          args:
            typeof block.input === 'object' && block.input !== null
              ? block.input
              : {},
        },
      })
      continue
    }

    if (block.type === 'tool_result') {
      parts.push({
        functionResponse: {
          name:
            (block.tool_use_id && toolNames.get(block.tool_use_id)) ??
            block.name ??
            'tool_result',
          response: {
            content: normalizeToolResultContent(block.content),
          },
        },
      })
    }
  }
  return parts
}

export function translateAnthropicBody(
  anthropicBody: Record<string, unknown>,
): GeminiNormalizedRequest {
  const anthropicMessages = (anthropicBody.messages || []) as AnthropicMessage[]
  const anthropicTools = (anthropicBody.tools || []) as AnthropicTool[]
  const requestedModel =
    typeof anthropicBody.model === 'string' ? anthropicBody.model : getMainLoopModel()
  const model = isGeminiModel(requestedModel)
    ? requestedModel
    : mapModelAliasToGemini(requestedModel)
  const toolNames = new Map<string, string>()

  const contents = anthropicMessages
    .map(message => {
      const role: 'user' | 'model' =
        message.role === 'assistant' ? 'model' : 'user'
      const parts = translateMessageParts(message, toolNames)
      return parts.length > 0 ? { role, parts } : null
    })
    .filter((value): value is NonNullable<typeof value> => value !== null)

  const generationConfig: GeminiNormalizedRequest['generationConfig'] = {
    candidateCount: 1,
  }
  if (typeof anthropicBody.max_tokens === 'number') {
    generationConfig.maxOutputTokens = anthropicBody.max_tokens
  }
  if (typeof anthropicBody.temperature === 'number') {
    generationConfig.temperature = anthropicBody.temperature
  }
  if (Array.isArray(anthropicBody.stop_sequences)) {
    generationConfig.stopSequences = anthropicBody.stop_sequences as string[]
  }
  const thinkingConfig = mapEffortToGeminiThinkingConfig(
    model,
    getAnthropicRequestedEffortLevel(anthropicBody),
  )
  if (thinkingConfig) {
    generationConfig.thinkingConfig = thinkingConfig
  }

  const systemInstruction = stripAnthropicSystemHeaders(
    anthropicBody.system as
      | string
      | Array<{ type: string; text?: string; cache_control?: unknown }>
      | undefined,
  )

  return {
    model,
    contents,
    ...(systemInstruction
      ? { systemInstruction: { parts: [{ text: systemInstruction }] } }
      : {}),
    ...(anthropicTools.length > 0 ? { tools: translateTools(anthropicTools) } : {}),
    generationConfig,
  }
}

function mapFinishReason(reason: string | undefined, hasToolUse: boolean): string {
  if (hasToolUse) return 'tool_use'
  if (reason === 'MAX_TOKENS') return 'max_tokens'
  return 'end_turn'
}

function isBlockedFinishReason(reason: string | undefined): boolean {
  return reason === 'SAFETY' || reason === 'PROHIBITED_CONTENT'
}

function translateGeminiPartsToAnthropic(
  parts: GeminiNormalizedPart[],
): AnthropicContentBlock[] {
  const content: AnthropicContentBlock[] = []
  for (const part of parts) {
    if ('text' in part && typeof part.text === 'string' && part.text.length > 0) {
      content.push({ type: 'text', text: part.text })
    } else if ('functionCall' in part) {
      content.push({
        type: 'tool_use',
        id: part.functionCall.id ?? `toolu_${Date.now()}_${content.length}`,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      })
    }
  }
  return content
}

function getUsage(
  envelope: GeminiNormalizedResponseEnvelope,
): {
  input_tokens: number
  output_tokens: number
} {
  const usage = envelope.usageMetadata ?? {}
  return {
    input_tokens: usage.promptTokenCount ?? 0,
    output_tokens: usage.candidatesTokenCount ?? 0,
  }
}

export function translateGeminiEnvelopeToAnthropic(
  envelope: GeminiNormalizedResponseEnvelope,
  model: string,
): Response {
  const candidate = Array.isArray(envelope.candidates)
    ? envelope.candidates[0]
    : undefined
  const parts = candidate?.content?.parts ?? []
  const anthropicContent = translateGeminiPartsToAnthropic(parts)
  const hasToolUse = anthropicContent.some(block => block.type === 'tool_use')
  const finishReason = candidate?.finishReason
  if (isBlockedFinishReason(finishReason)) {
    return new Response(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'api_error',
          message: `Gemini blocked the response with finish reason ${finishReason}.`,
        },
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }
  const response = {
    id: `msg_gemini_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content: anthropicContent,
    stop_reason: mapFinishReason(finishReason, hasToolUse),
    stop_sequence: null,
    usage: getUsage(envelope),
  }
  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function translateGeminiChunksToAnthropic(
  chunks: AsyncIterable<GeminiNormalizedChunk>,
  model: string,
): Response {
  const messageId = `msg_gemini_${Date.now()}`
  const readable = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      let contentIndex = 0
      let textStarted = false
      let lastFunctionArgs = ''
      let functionBlockOpen = false
      let functionBlockName = ''
      let functionBlockId = ''
      let hadToolUse = false
      let usage = { input_tokens: 0, output_tokens: 0 }
      let finishReason: string | undefined

      const closeToolBlock = () => {
        if (!functionBlockOpen) return
        controller.enqueue(
          encoder.encode(
            formatSSE(
              'content_block_stop',
              JSON.stringify({ type: 'content_block_stop', index: contentIndex }),
            ),
          ),
        )
        contentIndex++
        functionBlockOpen = false
        functionBlockName = ''
        functionBlockId = ''
        lastFunctionArgs = ''
      }

      controller.enqueue(
        encoder.encode(
          formatSSE(
            'message_start',
            JSON.stringify({
              type: 'message_start',
              message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                content: [],
                model,
                stop_reason: null,
                stop_sequence: null,
                usage,
              },
            }),
          ),
        ),
      )
      controller.enqueue(
        encoder.encode(formatSSE('ping', JSON.stringify({ type: 'ping' }))),
      )

      const handlePart = (part: GeminiNormalizedPart) => {
        if ('text' in part && typeof part.text === 'string' && part.text.length > 0) {
          closeToolBlock()
          if (!textStarted) {
            controller.enqueue(
              encoder.encode(
                formatSSE(
                  'content_block_start',
                  JSON.stringify({
                    type: 'content_block_start',
                    index: contentIndex,
                    content_block: { type: 'text', text: '' },
                  }),
                ),
              ),
            )
            textStarted = true
          }
          controller.enqueue(
            encoder.encode(
              formatSSE(
                'content_block_delta',
                JSON.stringify({
                  type: 'content_block_delta',
                  index: contentIndex,
                  delta: { type: 'text_delta', text: part.text },
                }),
              ),
            ),
          )
          return
        }

        if ('functionCall' in part) {
          if (textStarted) {
            controller.enqueue(
              encoder.encode(
                formatSSE(
                  'content_block_stop',
                  JSON.stringify({ type: 'content_block_stop', index: contentIndex }),
                ),
              ),
            )
            contentIndex++
            textStarted = false
          }

          const nextFunctionName = part.functionCall.name
          const nextFunctionId = part.functionCall.id ?? `toolu_${Date.now()}_${contentIndex}`
          if (functionBlockOpen && functionBlockId !== nextFunctionId) {
            closeToolBlock()
          }

          const args = JSON.stringify(part.functionCall.args ?? {})
          if (!functionBlockOpen) {
            functionBlockOpen = true
            functionBlockName = nextFunctionName
            functionBlockId = nextFunctionId
            lastFunctionArgs = ''
            hadToolUse = true
            controller.enqueue(
              encoder.encode(
                formatSSE(
                  'content_block_start',
                  JSON.stringify({
                    type: 'content_block_start',
                    index: contentIndex,
                    content_block: {
                      type: 'tool_use',
                      id: functionBlockId,
                      name: functionBlockName,
                      input: {},
                    },
                  }),
                ),
              ),
            )
          }

          const delta = args.startsWith(lastFunctionArgs)
            ? args.slice(lastFunctionArgs.length)
            : args
          if (delta.length > 0) {
            controller.enqueue(
              encoder.encode(
                formatSSE(
                  'content_block_delta',
                  JSON.stringify({
                    type: 'content_block_delta',
                    index: contentIndex,
                    delta: { type: 'input_json_delta', partial_json: delta },
                  }),
                ),
              ),
            )
            lastFunctionArgs = args
          }
        }
      }

      for await (const chunk of chunks) {
        usage = chunk.usage
        finishReason = chunk.finishReason ?? finishReason
        for (const part of chunk.parts) {
          handlePart(part)
        }
      }

      if (textStarted) {
        controller.enqueue(
          encoder.encode(
            formatSSE(
              'content_block_stop',
              JSON.stringify({ type: 'content_block_stop', index: contentIndex }),
            ),
          ),
        )
        contentIndex++
      }
      closeToolBlock()

      if (isBlockedFinishReason(finishReason)) {
        controller.enqueue(
          encoder.encode(
            formatSSE(
              'content_block_start',
              JSON.stringify({
                type: 'content_block_start',
                index: contentIndex,
                content_block: { type: 'text', text: '' },
              }),
            ),
          ),
        )
        controller.enqueue(
          encoder.encode(
            formatSSE(
              'content_block_delta',
              JSON.stringify({
                type: 'content_block_delta',
                index: contentIndex,
                delta: {
                  type: 'text_delta',
                  text: `Gemini blocked the response with finish reason ${finishReason}.`,
                },
              }),
            ),
          ),
        )
        controller.enqueue(
          encoder.encode(
            formatSSE(
              'content_block_stop',
              JSON.stringify({ type: 'content_block_stop', index: contentIndex }),
            ),
          ),
        )
      }

      controller.enqueue(
        encoder.encode(
          formatSSE(
            'message_delta',
            JSON.stringify({
              type: 'message_delta',
              delta: {
                stop_reason: hadToolUse ? 'tool_use' : mapFinishReason(finishReason, false),
                stop_sequence: null,
              },
              usage: { output_tokens: usage.output_tokens },
            }),
          ),
        ),
      )
      controller.enqueue(
        encoder.encode(
          formatSSE(
            'message_stop',
            JSON.stringify({
              type: 'message_stop',
              usage,
            }),
          ),
        ),
      )
      controller.close()
    },
  })

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'x-request-id': messageId,
    },
  })
}
