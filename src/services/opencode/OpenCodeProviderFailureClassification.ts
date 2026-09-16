export type OpenCodeProviderFailureKind = 'not_authenticated' | 'unavailable' | 'unknown'

export const OPEN_CODE_CATALOG_FAILURE_MESSAGE = 'OpenCode catalog request failed.'

export function isOpenCodeUsageLimitFailureMessage(lower: string): boolean {
  return lower.includes('too many requests')
    || /\b(?:rate|usage)[\s_-]*limit(?:error)?\b/.test(lower)
    || /\bresource[\s_-]*exhausted(?:error)?\b/.test(lower)
    || /\bfree[\s_-]*usage[\s_-]*(?:limit|exceeded)(?:error)?\b/.test(lower)
    || /\bquota[\s_-]*exceeded(?:error)?\b/.test(lower)
    || /\bgrpc[\s_-]*code["']?\s*[:=]\s*["']?8\b/.test(lower)
    || /^\s*(?:error\s*[:=-]?\s*)?429\b/m.test(lower)
    || /\b(?:http(?:[\s_-]*status)?|status(?:[\s_-]*code)?|error(?:[\s_-]*code)?|code)["']?\s*(?::|=|is|of)?\s*["']?429\b/.test(lower)
    || /\b429\s+(?:too many requests|rate limit(?:ed)?|resource exhausted)\b/.test(lower)
}

export function isOpenCodeApiKeyAuthFailureMessage(lower: string): boolean {
  return /\binvalid[\s_-]+api[\s_-]*key\b/.test(lower)
    || /\bapi[\s_-]*key\s+(?:is\s+)?(?:invalid|not\s+valid|expired|revoked)\b/.test(lower)
}

function hasHttpAuthStatus(lower: string, status: '401' | '403'): boolean {
  const statusWord = status === '401' ? 'unauthorized|unauthorised' : 'forbidden'
  return new RegExp(
    String.raw`\b(?:http(?:[\s_-]*status)?|status(?:[\s_-]*code)?|error(?:[\s_-]*code)?)["']?\s*(?::|=|is|of)?\s*["']?${status}\b`,
  ).test(lower)
    || new RegExp(String.raw`\b${status}\s+(?:${statusWord})\b`).test(lower)
}

export function isOpenCodeCatalogAuthExpiryFailureMessage(lower: string): boolean {
  return lower.includes('token refresh failed')
    || lower.includes('invalid_grant')
    || lower.includes('invalid grant')
    || lower.includes('invalid or unknown refresh token')
    || lower.includes('authentication failed')
    || lower.includes('authentication required')
    || lower.includes('auth failed')
    || lower.includes('not logged in')
    || lower.includes("please run 'agent login'")
    || lower.includes('please run `kiro-cli login`')
    || lower.includes('cursor_api_key')
    || /\bunauthorized\b/.test(lower)
    || hasHttpAuthStatus(lower, '401')
}

export function isOpenCodeAuthenticationFailureMessage(lower: string): boolean {
  return isOpenCodeCatalogAuthExpiryFailureMessage(lower)
    || isOpenCodeApiKeyAuthFailureMessage(lower)
    // Execution probes keep substring matching for concatenated forms such as
    // UnauthorizedError. Catalog sanitization stays on the word-boundary helper.
    || lower.includes('unauthorized')
    || lower.includes('forbidden')
    || /\b403\b/.test(lower)
    || /\b401\b/.test(lower)
}

export function isOpenCodeModelUnavailableFailureMessage(lower: string): boolean {
  return lower.includes('model is not supported')
    || lower.includes('model not supported')
    || lower.includes('unsupported model')
    || lower.includes('model not available')
    || lower.includes('model unavailable')
    || lower.includes('model is no longer available')
    || (lower.includes('model') && lower.includes('no longer available to new users'))
    || lower.includes('model not found')
    || lower.includes('unknown model')
    || lower.includes('invalid model')
    || lower.includes('not available for your account')
}

export function classifyOpenCodeProviderFailure(message: string): OpenCodeProviderFailureKind {
  const lower = message.toLowerCase()
  // Provider quota markers are more specific than an accompanying HTTP 401/403.
  if (isOpenCodeUsageLimitFailureMessage(lower)) {
    return 'unavailable'
  }
  if (isOpenCodeAuthenticationFailureMessage(lower)) {
    return 'not_authenticated'
  }
  if (isOpenCodeModelUnavailableFailureMessage(lower)) {
    return 'unavailable'
  }
  return 'unknown'
}

export function formatOpenCodeCatalogAuthFailureMessage(input: {
  displayName: string
  rawMessage: string
}): string {
  const displayName = input.displayName.trim() || 'This provider'
  if (isOpenCodeApiKeyAuthFailureMessage(input.rawMessage.toLowerCase())) {
    return `${displayName} rejected this API key. Check the key, then refresh the OpenCode catalog.`
  }
  return `${displayName} sign-in is no longer valid. Sign in again, then refresh the OpenCode catalog.`
}

export function formatOpenCodeCatalogUnknownFailureMessage(displayName: string): string {
  const name = displayName.trim() || 'This provider'
  return `Couldn't load ${name} models from OpenCode.`
}

export function classifyOpenCodeCatalogSanitizedFailure(input: {
  displayName: string
  rawMessage: string
}): { code: 'auth-failed' | 'runtime-unhealthy'; message: string } {
  const lower = input.rawMessage.toLowerCase()
  // Catalog sanitization is narrower than probe classification: a bare 403
  // or a coincidental 401 in a timeout/byte-count is not a prompt to sign in.
  if (isOpenCodeUsageLimitFailureMessage(lower)) {
    return {
      code: 'runtime-unhealthy',
      message: formatOpenCodeCatalogUnknownFailureMessage(input.displayName),
    }
  }
  if (
    isOpenCodeApiKeyAuthFailureMessage(lower)
    || isOpenCodeCatalogAuthExpiryFailureMessage(lower)
  ) {
    return {
      code: 'auth-failed',
      message: formatOpenCodeCatalogAuthFailureMessage(input),
    }
  }
  return {
    code: 'runtime-unhealthy',
    message: formatOpenCodeCatalogUnknownFailureMessage(input.displayName),
  }
}
