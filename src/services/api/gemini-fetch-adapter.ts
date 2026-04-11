import { resolveGeminiBackend } from '../gemini/backendResolver.js'
import { GeminiBackendError } from '../gemini/errors.js'
import {
  translateAnthropicBody,
  translateGeminiChunksToAnthropic,
  translateGeminiEnvelopeToAnthropic,
} from '../gemini/translation.js'

function authenticationError(message: string): Response {
  return new Response(
    JSON.stringify({
      type: 'error',
      error: {
        type: 'authentication_error',
        message,
      },
    }),
    {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    },
  )
}

function apiError(message: string, status: number = 500): Response {
  return new Response(
    JSON.stringify({
      type: 'error',
      error: {
        type: 'api_error',
        message,
      },
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    },
  )
}

async function parseAnthropicBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  try {
    const requestBody =
      init?.body ?? (input instanceof Request ? input.clone().body : null)
    const bodyText =
      requestBody instanceof ReadableStream
        ? await new Response(requestBody).text()
        : typeof requestBody === 'string'
          ? requestBody
          : requestBody instanceof Uint8Array || requestBody instanceof ArrayBuffer
            ? await new Response(requestBody).text()
            : '{}'
    return JSON.parse(bodyText) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function createGeminiFetch(): (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response> {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.includes('/v1/messages')) {
      return globalThis.fetch(input, init)
    }

    const resolution = await resolveGeminiBackend()
    if (!resolution.backend) {
      return authenticationError(
        resolution.status.message ??
          'Gemini authentication is not configured correctly.',
      )
    }

    const anthropicBody = await parseAnthropicBody(input, init)
    const request = translateAnthropicBody(anthropicBody)
    const stream = Boolean(anthropicBody.stream)

    try {
      if (!stream) {
        const envelope = await resolution.backend.unary(request)
        return translateGeminiEnvelopeToAnthropic(envelope, request.model)
      }

      const chunks = await resolution.backend.stream(request)
      return translateGeminiChunksToAnthropic(chunks, request.model)
    } catch (error) {
      const status =
        error instanceof GeminiBackendError && typeof error.status === 'number'
          ? error.status
          : 500
      return apiError(
        `Gemini ${resolution.backend.kind} backend error: ${
          error instanceof Error ? error.message : String(error)
        }`,
        status,
      )
    }
  }
}
