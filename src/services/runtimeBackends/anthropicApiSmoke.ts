export type AnthropicApiSmokeVerdict =
  | 'ok'
  | 'missing_key'
  | 'routing_error'
  | 'billing_error'
  | 'auth_error'
  | 'rate_limit_error'
  | 'runtime_error'

export type AnthropicApiSmokeReport = {
  verdict: AnthropicApiSmokeVerdict
  ok: boolean
  summary: string
  authMethod: string | null
  promptText: string | null
  promptErrorText: string | null
}

type AnthropicAuthStatusJson = {
  status?: {
    authenticated?: boolean
    authMethod?: string | null
  }
}

type AnthropicPromptJson = {
  is_error?: boolean
  result?: string | null
}

type AnthropicMessagesResponse = {
  content?: Array<{
    type?: string
    text?: string
  }>
  error?: {
    type?: string
    message?: string
  }
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function getPromptErrorVerdict(text: string): AnthropicApiSmokeVerdict {
  const normalized = text.toLowerCase()
  if (
    normalized.includes('billing_error') ||
    normalized.includes('insufficient_quota') ||
    normalized.includes('credit balance is too low')
  ) {
    return 'billing_error'
  }
  if (
    normalized.includes('authentication_error') ||
    normalized.includes('invalid x-api-key') ||
    normalized.includes('invalid api key') ||
    normalized.includes('unauthorized')
  ) {
    return 'auth_error'
  }
  if (
    normalized.includes('rate_limit_error') ||
    normalized.includes('rate limit') ||
    normalized.includes('429')
  ) {
    return 'rate_limit_error'
  }
  return 'runtime_error'
}

function getSummaryForVerdict(verdict: AnthropicApiSmokeVerdict): string {
  switch (verdict) {
    case 'ok':
      return 'Anthropic API smoke succeeded.'
    case 'missing_key':
      return 'ANTHROPIC_API_KEY is not set.'
    case 'routing_error':
      return 'Anthropic did not authenticate via API key.'
    case 'billing_error':
      return 'Anthropic accepted the API path, but billing or quota blocked inference.'
    case 'auth_error':
      return 'Anthropic rejected the API key.'
    case 'rate_limit_error':
      return 'Anthropic accepted the API key, but rate limits blocked the request.'
    case 'runtime_error':
      return 'The Anthropic API smoke failed for a runtime reason that was not classified.'
  }
}

export async function runAnthropicApiKeyPromptSmoke(params: {
  apiKey: string
  model: string
  prompt: string
  timeoutMs?: number
}): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = params.timeoutMs ?? 35_000
  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': params.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: params.model,
        max_tokens: 16,
        messages: [
          {
            role: 'user',
            content: params.prompt,
          },
        ],
      }),
      signal: controller.signal,
    })

    const rawText = await response.text()
    if (!response.ok) {
      return {
        stdout: JSON.stringify({
          is_error: true,
          result: rawText,
        }),
        stderr: '',
      }
    }

    const parsed = parseJson<AnthropicMessagesResponse>(rawText)
    const promptText =
      parsed?.content?.find(block => block.type === 'text')?.text?.trim()
      ?? null

    return {
      stdout: JSON.stringify({
        is_error: false,
        result: promptText,
      }),
      stderr: '',
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : String(error)
    return {
      stdout: JSON.stringify({
        is_error: true,
        result: errorMessage,
      }),
      stderr: '',
    }
  } finally {
    clearTimeout(timeoutHandle)
  }
}

export function evaluateAnthropicApiSmoke(params: {
  hasApiKey: boolean
  authStatusStdout: string
  promptStdout: string
  promptStderr?: string
}): AnthropicApiSmokeReport {
  if (!params.hasApiKey) {
    return {
      verdict: 'missing_key',
      ok: false,
      summary: getSummaryForVerdict('missing_key'),
      authMethod: null,
      promptText: null,
      promptErrorText: null,
    }
  }

  const authStatus = parseJson<AnthropicAuthStatusJson>(params.authStatusStdout)
  const promptResult = parseJson<AnthropicPromptJson>(params.promptStdout)

  const authMethod = authStatus?.status?.authMethod ?? null
  const authenticated = authStatus?.status?.authenticated === true

  if (!authenticated || authMethod !== 'api_key') {
    return {
      verdict: 'routing_error',
      ok: false,
      summary: getSummaryForVerdict('routing_error'),
      authMethod,
      promptText: null,
      promptErrorText: null,
    }
  }

  if (!promptResult || typeof promptResult.is_error !== 'boolean') {
    const fallbackError =
      params.promptStderr?.trim() || params.promptStdout.trim() || null
    return {
      verdict: 'runtime_error',
      ok: false,
      summary: getSummaryForVerdict('runtime_error'),
      authMethod,
      promptText: null,
      promptErrorText: fallbackError,
    }
  }

  const promptPayload =
    typeof promptResult.result === 'string' ? promptResult.result.trim() : null

  if (promptResult.is_error) {
    const promptErrorText =
      promptPayload ||
      params.promptStderr?.trim() ||
      'Unknown Anthropic API error.'
    const verdict = getPromptErrorVerdict(promptErrorText)
    return {
      verdict,
      ok: false,
      summary: getSummaryForVerdict(verdict),
      authMethod,
      promptText: null,
      promptErrorText,
    }
  }

  return {
    verdict: 'ok',
    ok: true,
    summary: getSummaryForVerdict('ok'),
    authMethod,
    promptText: promptPayload,
    promptErrorText: null,
  }
}
