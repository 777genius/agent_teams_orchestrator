export type GeminiBackendKind = 'api' | 'cli'

export type GeminiAuthMethod =
  | 'api_key'
  | 'adc_authorized_user'
  | 'adc_service_account'
  | 'cli_oauth_personal'
  | 'none'

export type GeminiBackendStatus = {
  ok: boolean
  backend: GeminiBackendKind
  authMethod: GeminiAuthMethod
  projectId?: string
  endpointLabel: string
  message?: string
  hint?: string
}

export type GeminiNormalizedPart =
  | { text: string }
  | { functionCall: { id?: string; name: string; args?: Record<string, unknown> } }
  | {
      functionResponse: {
        name: string
        response: { content: unknown }
      }
    }
  | {
      inlineData: {
        mimeType: string
        data: string
      }
    }

export type GeminiNormalizedTool = {
  functionDeclarations: Array<Record<string, unknown>>
}

export type GeminiNormalizedRequest = {
  model: string
  contents: Array<{
    role: 'user' | 'model'
    parts: GeminiNormalizedPart[]
  }>
  tools?: GeminiNormalizedTool[]
  systemInstruction?: { parts: Array<{ text: string }> }
  generationConfig: {
    candidateCount: 1
    maxOutputTokens?: number
    temperature?: number
    stopSequences?: string[]
  }
}

export type GeminiNormalizedResponseEnvelope = {
  candidates?: Array<{
    content?: {
      parts?: GeminiNormalizedPart[]
    }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
  }
}

export type GeminiNormalizedChunk = {
  parts: GeminiNormalizedPart[]
  usage: {
    input_tokens: number
    output_tokens: number
  }
  finishReason?: string
}

export interface GeminiBackend {
  kind: GeminiBackendKind
  validate(): Promise<GeminiBackendStatus>
  unary(
    request: GeminiNormalizedRequest,
  ): Promise<GeminiNormalizedResponseEnvelope>
  stream(
    request: GeminiNormalizedRequest,
  ): Promise<AsyncIterable<GeminiNormalizedChunk>>
  countTokens?(request: GeminiNormalizedRequest): Promise<number | null>
}
