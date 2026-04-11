export type CodexApiSmokeVerdict =
  | 'ok'
  | 'missing_key'
  | 'routing_error'
  | 'billing_error'
  | 'auth_error'
  | 'rate_limit_error'
  | 'runtime_error'

export type CodexApiSmokeReport = {
  verdict: CodexApiSmokeVerdict
  ok: boolean
  summary: string
  authMethod: string | null
  resolvedBackendId: string | null
  endpointLabel: string | null
  promptText: string | null
  promptErrorText: string | null
}

type CodexAuthStatusJson = {
  status?: {
    authenticated?: boolean
    authMethod?: string | null
  }
}

type CodexRuntimeStatusJson = {
  providers?: {
    codex?: {
      resolvedBackendId?: string | null
      backend?: {
        endpointLabel?: string | null
      }
    }
  }
}

type CodexPromptJson = {
  is_error?: boolean
  result?: string | null
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function getPromptErrorVerdict(text: string): CodexApiSmokeVerdict {
  const normalized = text.toLowerCase()
  if (
    normalized.includes('billing_error') ||
    normalized.includes('insufficient_quota')
  ) {
    return 'billing_error'
  }
  if (
    normalized.includes('authentication_error') ||
    normalized.includes('invalid_api_key') ||
    normalized.includes('incorrect api key')
  ) {
    return 'auth_error'
  }
  if (
    normalized.includes('rate_limit_error') ||
    normalized.includes('rate_limit_exceeded')
  ) {
    return 'rate_limit_error'
  }
  return 'runtime_error'
}

function getSummaryForVerdict(verdict: CodexApiSmokeVerdict): string {
  switch (verdict) {
    case 'ok':
      return 'Codex API smoke succeeded.'
    case 'missing_key':
      return 'OPENAI_API_KEY is not set.'
    case 'routing_error':
      return 'Codex did not resolve to the OpenAI API backend.'
    case 'billing_error':
      return 'Codex reached the OpenAI API, but billing or quota blocked inference.'
    case 'auth_error':
      return 'OpenAI rejected the Codex API key.'
    case 'rate_limit_error':
      return 'OpenAI accepted the Codex API key, but rate limits blocked the request.'
    case 'runtime_error':
      return 'The Codex API smoke failed for a runtime reason that was not classified.'
  }
}

export function evaluateCodexApiSmoke(params: {
  hasApiKey: boolean
  authStatusStdout: string
  runtimeStatusStdout: string
  promptStdout: string
  promptStderr?: string
}): CodexApiSmokeReport {
  if (!params.hasApiKey) {
    return {
      verdict: 'missing_key',
      ok: false,
      summary: getSummaryForVerdict('missing_key'),
      authMethod: null,
      resolvedBackendId: null,
      endpointLabel: null,
      promptText: null,
      promptErrorText: null,
    }
  }

  const authStatus = parseJson<CodexAuthStatusJson>(params.authStatusStdout)
  const runtimeStatus =
    parseJson<CodexRuntimeStatusJson>(params.runtimeStatusStdout)
  const promptResult = parseJson<CodexPromptJson>(params.promptStdout)

  const authMethod = authStatus?.status?.authMethod ?? null
  const authenticated = authStatus?.status?.authenticated === true
  const resolvedBackendId =
    runtimeStatus?.providers?.codex?.resolvedBackendId ?? null
  const endpointLabel =
    runtimeStatus?.providers?.codex?.backend?.endpointLabel ?? null

  if (!authenticated || authMethod !== 'api_key') {
    return {
      verdict: 'routing_error',
      ok: false,
      summary: getSummaryForVerdict('routing_error'),
      authMethod,
      resolvedBackendId,
      endpointLabel,
      promptText: null,
      promptErrorText: null,
    }
  }

  if (resolvedBackendId !== 'api') {
    return {
      verdict: 'routing_error',
      ok: false,
      summary: getSummaryForVerdict('routing_error'),
      authMethod,
      resolvedBackendId,
      endpointLabel,
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
      resolvedBackendId,
      endpointLabel,
      promptText: null,
      promptErrorText: fallbackError,
    }
  }

  const promptPayload =
    typeof promptResult.result === 'string' ? promptResult.result.trim() : null

  if (promptResult.is_error) {
    const promptErrorText =
      promptPayload || params.promptStderr?.trim() || 'Unknown Codex API error.'
    const verdict = getPromptErrorVerdict(promptErrorText)
    return {
      verdict,
      ok: false,
      summary: getSummaryForVerdict(verdict),
      authMethod,
      resolvedBackendId,
      endpointLabel,
      promptText: null,
      promptErrorText,
    }
  }

  return {
    verdict: 'ok',
    ok: true,
    summary: getSummaryForVerdict('ok'),
    authMethod,
    resolvedBackendId,
    endpointLabel,
    promptText: promptPayload,
    promptErrorText: null,
  }
}
