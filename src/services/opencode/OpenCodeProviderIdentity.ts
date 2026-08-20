const providerIdBrand: unique symbol = Symbol('OpenCodeCanonicalProviderId')
const modelIdBrand: unique symbol = Symbol('OpenCodeCanonicalModelId')
const modelRefBrand: unique symbol = Symbol('OpenCodeExactProviderModelRef')

export type OpenCodeCanonicalProviderId = string & { readonly [providerIdBrand]: true }
export type OpenCodeCanonicalModelId = string & { readonly [modelIdBrand]: true }
export type OpenCodeExactProviderModelRef = string & { readonly [modelRefBrand]: true }

export type OpenCodeScopedProviderModelRef = Readonly<{
  providerId: OpenCodeCanonicalProviderId
  modelId: OpenCodeCanonicalModelId
  /** The exact canonical provider/model reference. It is never a bare model id. */
  raw: OpenCodeExactProviderModelRef
}>

export const OPEN_CODE_PROVIDER_ALIAS_ENTRIES = [
  ['minimax-token-plan', 'minimax-coding-plan'],
  ['minimax-token-plan-(minimax.io)', 'minimax-coding-plan'],
  ['xiaomi-token-plan-(europe)', 'xiaomi-token-plan-ams'],
  ['xiaomi-token-plan-(singapore)', 'xiaomi-token-plan-sgp'],
  ['xiaomi-token-plan-(china)', 'xiaomi-token-plan-cn'],
  ['xiaomi-mimo-token-plan---europe', 'xiaomi-token-plan-ams'],
  ['xiaomi-mimo-token-plan---singapore', 'xiaomi-token-plan-sgp'],
  ['xiaomi-mimo-token-plan---china', 'xiaomi-token-plan-cn'],
  ['z.ai-coding-plan', 'zai-coding-plan'],
  ['kimi-code-membership', 'kimi-for-coding'],
  ['amazon-q-developer-/-kiro', 'kiro'],
  ['MiniMax Token Plan (minimax.io)', 'minimax-coding-plan'],
  ['Xiaomi Token Plan (Europe)', 'xiaomi-token-plan-ams'],
  ['Xiaomi Token Plan (Singapore)', 'xiaomi-token-plan-sgp'],
  ['Xiaomi Token Plan (China)', 'xiaomi-token-plan-cn'],
  ['Xiaomi MiMo Token Plan - Europe', 'xiaomi-token-plan-ams'],
  ['Xiaomi MiMo Token Plan - Singapore', 'xiaomi-token-plan-sgp'],
  ['Xiaomi MiMo Token Plan - China', 'xiaomi-token-plan-cn'],
  ['Z.AI Coding Plan', 'zai-coding-plan'],
  ['Kimi Code Membership', 'kimi-for-coding'],
  ['Amazon Q Developer / Kiro', 'kiro'],
  ['GitHub Copilot', 'github-copilot'],
] as const

const OPEN_CODE_PROVIDER_ALIASES = new Map<string, string>(OPEN_CODE_PROVIDER_ALIAS_ENTRIES)
const PROVIDER_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/
const MODEL_ID = /^[a-zA-Z0-9](?:[a-zA-Z0-9._:+@/-]{0,254}[a-zA-Z0-9])?$/
const CONTROL_OR_WHITESPACE = /[\u0000-\u0020\u007f-\u009f]/
const SCHEME_OR_PROTOCOL_RELATIVE_AUTHORITY = /(?:^|[^a-z0-9+.-])(?:[a-z][a-z0-9+.-]*:)?\/\//i
const BRACKETED_IP_AUTHORITY = /(?:^|[^a-z0-9])\[[0-9a-f:.%]+\](?::\d+)?(?=$|[^a-z0-9])/i
const HOST_PORT_AUTHORITY = /(?:^|[^a-z0-9.-])(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.?):\d+(?=$|[\/\s,;)\]}])/i
const USERINFO_AUTHORITY_SUFFIX = /^(?:host|localhost|\[[0-9a-f:.%]+\](?::\d+)?|(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.?):\d+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.?)$/i

export class OpenCodeProviderIdentityError extends Error {
  constructor() {
    super('Invalid OpenCode provider or model identity')
    this.name = 'OpenCodeProviderIdentityError'
  }
}

function hasUnsafeSegments(value: string): boolean {
  return value.split('/').some(segment => segment === '.' || segment === '..')
}

/**
 * Pure redaction boundary shared by identity and catalog contracts. It does
 * not parse, decode, resolve, or retain the rejected authority text.
 */
export function isOpenCodeCredentialOrAuthorityLike(
  value: string,
  options: Readonly<{ allowHostPort?: boolean }> = {},
): boolean {
  if (typeof value !== 'string') return true
  if (SCHEME_OR_PROTOCOL_RELATIVE_AUTHORITY.test(value)
    || BRACKETED_IP_AUTHORITY.test(value)
    || (!options.allowHostPort && HOST_PORT_AUTHORITY.test(value))) return true

  return value.split('/').some(segment => {
    // URL userinfo is separated from its host at the final @, including when
    // the userinfo itself contains additional at-signs.
    const finalAt = segment.lastIndexOf('@')
    const userinfoColon = segment.indexOf(':')
    if (finalAt <= 0 || finalAt === segment.length - 1) return false
    // A colon at offset zero is password-only URL userinfo (`:secret@host`),
    // not safe model punctuation. Username-only userinfo is rejected only when
    // its suffix is authority-shaped so `model@revision` remains valid.
    return (userinfoColon >= 0 && userinfoColon < finalAt)
      || USERINFO_AUTHORITY_SUFFIX.test(segment.slice(finalAt + 1))
  })
}

/** Canonicalization boundary. Callers should retain the branded result. */
export function createOpenCodeCanonicalProviderId(value: string): OpenCodeCanonicalProviderId {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new OpenCodeProviderIdentityError()
  }
  const alias = OPEN_CODE_PROVIDER_ALIASES.get(value)
  // Human-readable aliases are exact table entries. Everything else must
  // already be canonical ASCII; whitespace/case/confusable folding is unsafe.
  if (!alias && (CONTROL_OR_WHITESPACE.test(value) || /[^\x21-\x7e]/.test(value))) {
    throw new OpenCodeProviderIdentityError()
  }
  const canonical = alias ?? value
  if (!PROVIDER_ID.test(canonical) || hasUnsafeSegments(canonical)) {
    throw new OpenCodeProviderIdentityError()
  }
  return canonical as OpenCodeCanonicalProviderId
}

/**
 * Non-throwing normalization for provider ids received at user/config/runtime
 * boundaries. Internal code that requires an invariant must use
 * createOpenCodeCanonicalProviderId instead.
 */
export function canonicalizeOpenCodeProviderId(
  value: unknown,
): OpenCodeCanonicalProviderId | null {
  return tryCreateOpenCodeCanonicalProviderId(value)
}

export function tryCreateOpenCodeCanonicalProviderId(
  value: unknown,
): OpenCodeCanonicalProviderId | null {
  if (typeof value !== 'string') return null
  try {
    return createOpenCodeCanonicalProviderId(value)
  } catch {
    return null
  }
}

export function createOpenCodeCanonicalModelId(value: string): OpenCodeCanonicalModelId {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || CONTROL_OR_WHITESPACE.test(value)
    || !MODEL_ID.test(value)
    || value.startsWith('/')
    || value.endsWith('/')
    || value.includes('//')
    || hasUnsafeSegments(value)
    || isOpenCodeCredentialOrAuthorityLike(value)
  ) {
    throw new OpenCodeProviderIdentityError()
  }
  return value as OpenCodeCanonicalModelId
}

export function createOpenCodeExactProviderModelRef(
  providerId: string | OpenCodeCanonicalProviderId,
  modelId: string | OpenCodeCanonicalModelId,
): OpenCodeScopedProviderModelRef {
  const canonicalProviderId = createOpenCodeCanonicalProviderId(providerId)
  const canonicalModelId = canonicalProviderId === 'amazon-bedrock'
    ? createOpenCodeCanonicalModelIdForProvider(modelId)
    : createOpenCodeCanonicalModelId(modelId)
  return Object.freeze({
    providerId: canonicalProviderId,
    modelId: canonicalModelId,
    raw: `${canonicalProviderId}/${canonicalModelId}` as OpenCodeExactProviderModelRef,
  })
}

/** Positive grammar for the Bedrock families present in this repository. */
export function isOpenCodeBedrockModelId(value: unknown): value is string {
  if (typeof value !== 'string' || value.includes('/')) return false
  return /^(?:(?:us|eu|apac)\.)?anthropic\.claude(?:-[A-Za-z0-9]+)*-v\d+:\d+$/.test(value)
}

function createOpenCodeCanonicalModelIdForProvider(
  value: string | OpenCodeCanonicalModelId,
): OpenCodeCanonicalModelId {
  const segments = typeof value === 'string' ? value.split('/') : []
  const finalSegment = segments.at(-1) ?? ''
  const safeBedrockSuffix = isOpenCodeBedrockModelId(finalSegment)
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()
    || CONTROL_OR_WHITESPACE.test(value) || !MODEL_ID.test(value)
    || value.startsWith('/') || value.endsWith('/') || value.includes('//')
    || hasUnsafeSegments(value)
    // Bedrock's version marker is model punctuation, never an authority
    // exception for the rest of the path. Every earlier segment is checked
    // with the normal host/port rejection rules.
    || segments.slice(0, -1).some(segment => isOpenCodeCredentialOrAuthorityLike(segment))
    || isOpenCodeCredentialOrAuthorityLike(finalSegment, { allowHostPort: safeBedrockSuffix })) {
    throw new OpenCodeProviderIdentityError()
  }
  return value as OpenCodeCanonicalModelId
}

/** Parses exactly one scoped reference. There is deliberately no default or bare-id fallback. */
export function parseOpenCodeExactProviderModelRef(
  value: string | null | undefined,
): OpenCodeScopedProviderModelRef | null {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return null
  const separator = value.indexOf('/')
  if (separator <= 0 || separator === value.length - 1) return null
  try {
    const ref = createOpenCodeExactProviderModelRef(
      value.slice(0, separator),
      value.slice(separator + 1),
    )
    return ref.raw === value ? ref : null
  } catch {
    return null
  }
}
