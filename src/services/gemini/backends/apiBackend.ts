import {
  getGeminiApiVersion,
  getGeminiBaseUrl,
  resolveGeminiAuth,
} from '../../../utils/geminiAuth.js'
import { GeminiBackendError } from '../errors.js'
import type {
  GeminiBackend,
  GeminiBackendStatus,
  GeminiNormalizedChunk,
  GeminiNormalizedRequest,
  GeminiNormalizedResponseEnvelope,
} from '../types.js'

function getApiEndpointLabel(): string {
  return `${getGeminiBaseUrl().replace(/\/$/, '')}/${getGeminiApiVersion()}`
}

async function validateApiAuth(): Promise<GeminiBackendStatus> {
  const auth = await resolveGeminiAuth()
  if (!auth) {
    return {
      ok: false,
      backend: 'api',
      authMethod: 'none',
      endpointLabel: getApiEndpointLabel(),
      message:
        'Gemini API authentication is not configured. Set GEMINI_API_KEY or valid Google ADC credentials.',
    }
  }

  const url = `${getGeminiBaseUrl().replace(/\/$/, '')}/${getGeminiApiVersion()}/models`
  const headers: Record<string, string> = {}
  if (auth.method === 'api_key') {
    headers['x-goog-api-key'] = auth.apiKey!
  } else {
    headers.Authorization = `Bearer ${auth.accessToken}`
    headers['x-goog-user-project'] = auth.projectId!
  }

  try {
    const response = await fetch(url, { headers })
    if (!response.ok) {
      const body = await response.text()
      return {
        ok: false,
        backend: 'api',
        authMethod: auth.method,
        projectId: auth.projectId,
        endpointLabel: getApiEndpointLabel(),
        message: `Gemini API auth validation failed (${response.status}): ${body}`,
      }
    }
    return {
      ok: true,
      backend: 'api',
      authMethod: auth.method,
      projectId: auth.projectId,
      endpointLabel: getApiEndpointLabel(),
    }
  } catch (error) {
    return {
      ok: false,
      backend: 'api',
      authMethod: auth.method,
      projectId: auth.projectId,
      endpointLabel: getApiEndpointLabel(),
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

async function getApiHeaders(): Promise<Record<string, string>> {
  const auth = await resolveGeminiAuth()
  if (!auth) {
    throw new Error(
      'Gemini API authentication is not configured. Set GEMINI_API_KEY or valid Google ADC credentials.',
    )
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (auth.method === 'api_key') {
    headers['x-goog-api-key'] = auth.apiKey!
  } else {
    headers.Authorization = `Bearer ${auth.accessToken}`
    headers['x-goog-user-project'] = auth.projectId!
  }
  return headers
}

async function* parseApiStream(
  response: Response,
): AsyncIterable<GeminiNormalizedChunk> {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('Gemini API stream body missing')
  }

  const decoder = new TextDecoder()
  let buffer = ''

  const processChunk = (chunk: string): GeminiNormalizedChunk | null => {
    const dataLines = chunk
      .split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => line.slice(6))
    if (dataLines.length === 0) {
      return null
    }

    const data = dataLines.join('\n')
    if (data === '[DONE]') {
      return null
    }

    let parsed: GeminiNormalizedResponseEnvelope
    try {
      parsed = JSON.parse(data) as GeminiNormalizedResponseEnvelope
    } catch {
      return null
    }

    const candidate = Array.isArray(parsed.candidates)
      ? parsed.candidates[0]
      : undefined

    return {
      parts: candidate?.content?.parts ?? [],
      usage: {
        input_tokens: parsed.usageMetadata?.promptTokenCount ?? 0,
        output_tokens: parsed.usageMetadata?.candidatesTokenCount ?? 0,
      },
      finishReason: candidate?.finishReason,
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const chunks = buffer.split('\n\n')
    buffer = chunks.pop() ?? ''
    for (const chunk of chunks) {
      const parsed = processChunk(chunk)
      if (parsed) {
        yield parsed
      }
    }
  }

  if (buffer.trim().length > 0) {
    const parsed = processChunk(buffer)
    if (parsed) {
      yield parsed
    }
  }
}

export const geminiApiBackend: GeminiBackend = {
  kind: 'api',
  validate: validateApiAuth,
  async unary(
    request: GeminiNormalizedRequest,
  ): Promise<GeminiNormalizedResponseEnvelope> {
    const headers = await getApiHeaders()
    const endpoint = `${getGeminiBaseUrl().replace(/\/$/, '')}/${getGeminiApiVersion()}/models/${request.model}:generateContent`
    const response = await globalThis.fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        contents: request.contents,
        tools: request.tools,
        systemInstruction: request.systemInstruction,
        generationConfig: request.generationConfig,
      }),
    })
    if (!response.ok) {
      throw new GeminiBackendError(
        `Gemini API error (${response.status}): ${await response.text()}`,
        response.status,
      )
    }
    return (await response.json()) as GeminiNormalizedResponseEnvelope
  },
  async stream(
    request: GeminiNormalizedRequest,
  ): Promise<AsyncIterable<GeminiNormalizedChunk>> {
    const headers = await getApiHeaders()
    const endpoint = `${getGeminiBaseUrl().replace(/\/$/, '')}/${getGeminiApiVersion()}/models/${request.model}:streamGenerateContent?alt=sse`
    const response = await globalThis.fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        contents: request.contents,
        tools: request.tools,
        systemInstruction: request.systemInstruction,
        generationConfig: request.generationConfig,
      }),
    })
    if (!response.ok) {
      throw new GeminiBackendError(
        `Gemini API error (${response.status}): ${await response.text()}`,
        response.status,
      )
    }
    return parseApiStream(response)
  },
}
