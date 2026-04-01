import { randomUUID } from 'crypto'
import type {
  CountTokensParameters,
  CountTokensResponse,
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai'
import {
  AuthType,
  CodeAssistServer,
  getOauthClient,
  setupUser,
} from '@google/gemini-cli-core'
import { LlmRole } from '@google/gemini-cli-core/dist/src/telemetry/llmRole.js'
import { getSessionId } from '../../../bootstrap/state.js'
import { saveGlobalConfig } from '../../../utils/config.js'
import { getUserAgent } from '../../../utils/http.js'
import type {
  GeminiBackend,
  GeminiBackendStatus,
  GeminiNormalizedChunk,
  GeminiNormalizedRequest,
  GeminiNormalizedResponseEnvelope,
} from '../types.js'

type MinimalCliCoreConfig = {
  getProxy(): string | undefined
  getValidationHandler(): undefined
  getBillingSettings(): { overageStrategy: 'off' }
  getCreditsNotificationShown(): boolean
  setCreditsNotificationShown(value: boolean): void
  isBrowserLaunchSuppressed(): boolean
  isInteractive(): boolean
  getAcpMode(): boolean
}

type GeminiCliCoreConfig = Parameters<typeof getOauthClient>[1]
type GeminiCliSetup = {
  authClient: Awaited<ReturnType<typeof getOauthClient>>
  userData: Awaited<ReturnType<typeof setupUser>>
}

const CODE_ASSIST_ENDPOINT_LABEL =
  'Code Assist (https://cloudcode-pa.googleapis.com/v1internal)'

let creditsNotificationShown = false

function createCliCoreConfig(): GeminiCliCoreConfig {
  const config: MinimalCliCoreConfig = {
    getProxy: () => undefined,
    getValidationHandler: () => undefined,
    getBillingSettings: () => ({ overageStrategy: 'off' }),
    getCreditsNotificationShown: () => creditsNotificationShown,
    setCreditsNotificationShown: value => {
      creditsNotificationShown = value
    },
    isBrowserLaunchSuppressed: () => true,
    isInteractive: () => false,
    getAcpMode: () => false,
  }
  return config as unknown as GeminiCliCoreConfig
}

function toCliErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.includes('Manual authorization is required')) {
      return 'Gemini CLI login was not found. Sign in with the gemini CLI first.'
    }
    return error.message
  }
  return String(error)
}

async function getCliSetup(): Promise<GeminiCliSetup> {
  const config = createCliCoreConfig()
  const authClient = await getOauthClient(AuthType.LOGIN_WITH_GOOGLE, config)
  const userData = await setupUser(authClient, config)
  saveGlobalConfig(current => ({
    ...current,
    geminiProjectId: userData.projectId ?? current.geminiProjectId,
    geminiLastAuthMethod: 'cli_oauth_personal',
  }))
  return { authClient, userData }
}

async function validateCliAuth(): Promise<GeminiBackendStatus> {
  try {
    const { userData } = await getCliSetup()
    return {
      ok: true,
      backend: 'cli',
      authMethod: 'cli_oauth_personal',
      projectId: userData.projectId,
      endpointLabel: CODE_ASSIST_ENDPOINT_LABEL,
    }
  } catch (error) {
    return {
      ok: false,
      backend: 'cli',
      authMethod: 'none',
      endpointLabel: CODE_ASSIST_ENDPOINT_LABEL,
      message: toCliErrorMessage(error),
      hint: 'Run the installed gemini CLI login flow first if you want to use the CLI backend.',
    }
  }
}

function createCodeAssistServer(
  setup: GeminiCliSetup,
): InstanceType<typeof CodeAssistServer> {
  return new CodeAssistServer(
    setup.authClient,
    setup.userData.projectId,
    {
      headers: {
        'User-Agent': getUserAgent(),
      },
    },
    getSessionId(),
    setup.userData.userTier,
    setup.userData.userTierName,
    setup.userData.paidTier,
    undefined,
  )
}

function buildCliRequest(
  request: GeminiNormalizedRequest,
): GenerateContentParameters {
  return {
    model: request.model,
    contents: request.contents,
    config: {
      ...(request.systemInstruction
        ? { systemInstruction: request.systemInstruction }
        : {}),
      ...(request.tools ? { tools: request.tools } : {}),
      ...request.generationConfig,
    },
  }
}

function toEnvelope(response: GenerateContentResponse): GeminiNormalizedResponseEnvelope {
  return {
    candidates: Array.isArray(response.candidates)
      ? (response.candidates as GeminiNormalizedResponseEnvelope['candidates'])
      : [],
    usageMetadata:
      typeof response.usageMetadata === 'object' && response.usageMetadata !== null
        ? (response.usageMetadata as GeminiNormalizedResponseEnvelope['usageMetadata'])
        : undefined,
  }
}

function envelopeToChunk(
  envelope: GeminiNormalizedResponseEnvelope,
): GeminiNormalizedChunk {
  const candidate = Array.isArray(envelope.candidates)
    ? envelope.candidates[0]
    : undefined
  return {
    parts: candidate?.content?.parts ?? [],
    usage: {
      input_tokens: envelope.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: envelope.usageMetadata?.candidatesTokenCount ?? 0,
    },
    finishReason: candidate?.finishReason,
  }
}

async function* streamCliResponses(
  responses: AsyncIterable<GenerateContentResponse>,
): AsyncIterable<GeminiNormalizedChunk> {
  for await (const response of responses) {
    yield envelopeToChunk(toEnvelope(response))
  }
}

function shouldFallbackStreamToUnary(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  return (
    message.includes('status code 429') ||
    message.includes('resource_exhausted') ||
    message.includes('ratelimitexceeded') ||
    message.includes('rate_limit_exceeded')
  )
}

async function* streamCliRequest(
  server: InstanceType<typeof CodeAssistServer>,
  request: GenerateContentParameters,
): AsyncIterable<GeminiNormalizedChunk> {
  let yieldedAnyChunk = false
  try {
    const responses = await server.generateContentStream(
      request,
      randomUUID(),
      LlmRole.MAIN,
    )
    for await (const chunk of streamCliResponses(responses)) {
      yieldedAnyChunk = true
      yield chunk
    }
  } catch (error) {
    if (!yieldedAnyChunk && shouldFallbackStreamToUnary(error)) {
      const response = await server.generateContent(
        request,
        randomUUID(),
        LlmRole.MAIN,
      )
      yield envelopeToChunk(toEnvelope(response))
      return
    }
    throw error
  }
}

export const geminiCliBackend: GeminiBackend = {
  kind: 'cli',
  validate: validateCliAuth,
  async unary(
    request: GeminiNormalizedRequest,
  ): Promise<GeminiNormalizedResponseEnvelope> {
    const setup = await getCliSetup()
    const server = createCodeAssistServer(setup)
    const response = await server.generateContent(
      buildCliRequest(request),
      randomUUID(),
      LlmRole.MAIN,
    )
    return toEnvelope(response)
  },
  async stream(
    request: GeminiNormalizedRequest,
  ): Promise<AsyncIterable<GeminiNormalizedChunk>> {
    const setup = await getCliSetup()
    const server = createCodeAssistServer(setup)
    return streamCliRequest(server, buildCliRequest(request))
  },
  async countTokens(request: GeminiNormalizedRequest): Promise<number | null> {
    try {
      const setup = await getCliSetup()
      const server = createCodeAssistServer(setup)
      const countTokenRequest: CountTokensParameters = {
        model: request.model,
        contents: request.contents,
      }
      const response: CountTokensResponse = await server.countTokens(
        countTokenRequest,
      )
      return typeof response.totalTokens === 'number' ? response.totalTokens : null
    } catch {
      return null
    }
  },
}
