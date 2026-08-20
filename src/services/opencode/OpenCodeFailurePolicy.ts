import { types as nodeUtilTypes } from 'node:util'

export const OPEN_CODE_LAUNCH_RETRY_DISPOSITIONS = [
  'automatic',
  'backoff',
  'user_action',
  'external_change',
  'continuation',
  'never',
] as const

export type OpenCodeLaunchRetryDisposition =
  typeof OPEN_CODE_LAUNCH_RETRY_DISPOSITIONS[number]

export const OPEN_CODE_LAUNCH_FAILURE_KINDS = [
  'pre_side_effect_transport',
  'rate_limited',
  'quota_exhausted',
  'provider_plan_denied',
  'authentication_required',
  'external_dependency',
  'contract_violation',
  'candidate_budget_exhausted',
  'attempt_budget_exhausted',
  'deadline_before_partial',
  'deadline_after_partial',
  'unknown_transport_after_side_effect',
  'cancelled',
] as const

export type OpenCodeLaunchFailureKind = typeof OPEN_CODE_LAUNCH_FAILURE_KINDS[number]

export type OpenCodeLaunchFailurePolicy = Readonly<{
  retryDisposition: OpenCodeLaunchRetryDisposition
  retryable: boolean
  sideEffectsStarted: boolean
}>

function immutableFailurePolicy<
  Policy extends Record<OpenCodeLaunchFailureKind, OpenCodeLaunchFailurePolicy>,
>(policy: Policy): Readonly<Policy> {
  for (const value of Object.values(policy)) Object.freeze(value)
  return Object.freeze(policy)
}

/** The single exhaustive retry/side-effect policy table for launch and provider operations. */
export const OPEN_CODE_LAUNCH_FAILURE_POLICY = immutableFailurePolicy({
  pre_side_effect_transport: { retryDisposition: 'automatic', retryable: true, sideEffectsStarted: false },
  rate_limited: { retryDisposition: 'backoff', retryable: true, sideEffectsStarted: false },
  quota_exhausted: { retryDisposition: 'backoff', retryable: true, sideEffectsStarted: false },
  provider_plan_denied: { retryDisposition: 'external_change', retryable: true, sideEffectsStarted: false },
  authentication_required: { retryDisposition: 'user_action', retryable: true, sideEffectsStarted: false },
  external_dependency: { retryDisposition: 'external_change', retryable: true, sideEffectsStarted: false },
  contract_violation: { retryDisposition: 'never', retryable: false, sideEffectsStarted: false },
  candidate_budget_exhausted: { retryDisposition: 'backoff', retryable: true, sideEffectsStarted: false },
  attempt_budget_exhausted: { retryDisposition: 'never', retryable: false, sideEffectsStarted: false },
  deadline_before_partial: { retryDisposition: 'backoff', retryable: true, sideEffectsStarted: false },
  deadline_after_partial: { retryDisposition: 'continuation', retryable: true, sideEffectsStarted: true },
  unknown_transport_after_side_effect: { retryDisposition: 'never', retryable: false, sideEffectsStarted: true },
  cancelled: { retryDisposition: 'never', retryable: false, sideEffectsStarted: false },
} as const satisfies Record<OpenCodeLaunchFailureKind, OpenCodeLaunchFailurePolicy>)

export type OpenCodeLaunchFailure = {
  [Kind in OpenCodeLaunchFailureKind]: {
    kind: Kind
    retryDisposition: typeof OPEN_CODE_LAUNCH_FAILURE_POLICY[Kind]['retryDisposition']
    retryable: typeof OPEN_CODE_LAUNCH_FAILURE_POLICY[Kind]['retryable']
    sideEffectsStarted: typeof OPEN_CODE_LAUNCH_FAILURE_POLICY[Kind]['sideEffectsStarted']
  }
}[OpenCodeLaunchFailureKind]

export function classifyOpenCodeLaunchFailure<Kind extends OpenCodeLaunchFailureKind>(
  kind: Kind,
): Extract<OpenCodeLaunchFailure, { kind: Kind }> {
  if (typeof kind !== 'string'
    || !Object.prototype.hasOwnProperty.call(OPEN_CODE_LAUNCH_FAILURE_POLICY, kind)
    || !Object.prototype.propertyIsEnumerable.call(OPEN_CODE_LAUNCH_FAILURE_POLICY, kind)
    || !(OPEN_CODE_LAUNCH_FAILURE_KINDS as readonly string[]).includes(kind)) {
    throw new TypeError('Invalid OpenCode launch failure kind')
  }
  return Object.freeze({ kind, ...OPEN_CODE_LAUNCH_FAILURE_POLICY[kind] }) as unknown as Extract<
    OpenCodeLaunchFailure,
    { kind: Kind }
  >
}

export type OpenCodeProviderOperation =
  | 'provider-catalog'
  | 'provider-connect'
  | 'execution-probe'

export type OpenCodeProviderFailureOrigin =
  | 'provider'
  | 'transport'
  | 'deadline'
  | 'cancellation'
  | 'contract'

export type OpenCodeProviderFailurePhase =
  | 'catalog-read'
  | 'provider-connect'
  | 'execution-probe'

const PHASE_BY_OPERATION: Readonly<Record<OpenCodeProviderOperation, OpenCodeProviderFailurePhase>> = {
  'provider-catalog': 'catalog-read',
  'provider-connect': 'provider-connect',
  'execution-probe': 'execution-probe',
}

export const OPEN_CODE_PROVIDER_FAILURE_MESSAGES = Object.freeze({
  pre_side_effect_transport: 'The provider could not be reached. Try again.',
  rate_limited: 'The provider is temporarily rate limited. Try again later.',
  quota_exhausted: 'The provider quota or subscription balance is exhausted.',
  provider_plan_denied: 'The selected model is not available on this provider plan.',
  authentication_required: 'Provider authentication is required.',
  external_dependency: 'A provider dependency is unavailable.',
  contract_violation: 'The provider returned an invalid response.',
  candidate_budget_exhausted: 'The provider candidate time budget was exhausted.',
  attempt_budget_exhausted: 'The provider operation time budget was exhausted.',
  deadline_before_partial: 'The provider operation timed out before producing a result.',
  deadline_after_partial: 'The provider operation timed out after partial progress.',
  unknown_transport_after_side_effect: 'The provider result is uncertain after an external action.',
  cancelled: 'The provider operation was cancelled.',
} satisfies Record<OpenCodeLaunchFailureKind, string>)

export const OPEN_CODE_MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000

declare const openCodeProviderFailureBrand: unique symbol

/** Opaque outside this module: values can only be obtained from the factories below. */
export type OpenCodeProviderFailure = Readonly<{
  readonly [openCodeProviderFailureBrand]: true
  code: OpenCodeLaunchFailureKind
  operation: OpenCodeProviderOperation
  origin: OpenCodeProviderFailureOrigin
  phase: OpenCodeProviderFailurePhase
  retryDisposition: OpenCodeLaunchRetryDisposition
  retryable: boolean
  sideEffectsStarted: boolean
  retryAfterMs: number | null
  message: string
}>

export type OpenCodeProviderFailureInput = Readonly<{
  operation: OpenCodeProviderOperation
  status?: number | null
  providerCode?: string | null
  message?: string | null
  retryAfterMs?: number | null
  networkFailure?: boolean
  durableSideEffectStarted?: boolean
  oauthOrExternalEffectStarted?: boolean
  partialResult?: boolean
  deadlineExceeded?: boolean
  cancelled?: boolean
  contractViolation?: boolean
}>

const DANGEROUS_FAILURE_INPUT_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function snapshotProviderFailureInput(value: unknown): OpenCodeProviderFailureInput | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || nodeUtilTypes.isProxy(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Reflect.ownKeys(descriptors).some(key => typeof key === 'symbol')) return null
    const snapshot = Object.create(null) as Record<string, unknown>
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (DANGEROUS_FAILURE_INPUT_KEYS.has(key) || !('value' in descriptor)) return null
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: false,
        writable: false,
      })
    }
    return Object.freeze(snapshot) as OpenCodeProviderFailureInput
  } catch {
    return null
  }
}

function boundedRetryAfterMs(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.min(OPEN_CODE_MAX_RETRY_AFTER_MS, Math.floor(value))
}

function safeMarkerText(input: OpenCodeProviderFailureInput): string {
  const providerCode = typeof input.providerCode === 'string' ? input.providerCode : ''
  const message = typeof input.message === 'string' ? input.message : ''
  return `${providerCode} ${message}`.toLowerCase()
}

function classifyProviderFailureCode(input: OpenCodeProviderFailureInput): OpenCodeLaunchFailureKind {
  if (input.contractViolation) return 'contract_violation'
  if (input.cancelled) return 'cancelled'
  if (input.deadlineExceeded) {
    return input.partialResult || input.durableSideEffectStarted
      ? 'deadline_after_partial'
      : 'deadline_before_partial'
  }

  const marker = safeMarkerText(input)
  const quota = /(?:quota|balance|subscription)(?:[\s_-]*(?:exhausted|exceeded|depleted|required|limit|reached))|insufficient[\s_-]*(?:quota|balance)|resource[_\s-]*exhausted(?=[\s\S]*(?:quota|balance|subscription))/.test(marker)
  if (quota) return 'quota_exhausted'
  if (
    input.status === 429
    || input.retryAfterMs != null
    || /rate[\s_-]*limit|too many requests|retry[\s_-]*after/.test(marker)
  ) return 'rate_limited'
  if (
    input.status === 401
    || /invalid[\s_-]*(?:token|credential|api[\s_-]*key)|revoked|unauthenticated|authentication required|log[\s_-]*in|login/.test(marker)
  ) return 'authentication_required'
  if (
    /entitlement|account[\s_-]*tier|org(?:anization)?[\s_-]*policy|model[\s_-]*plan|plan[\s_-]*(?:denied|required|restriction)|not available on (?:your|this) plan/.test(marker)
  ) return 'provider_plan_denied'
  if (input.networkFailure) {
    return input.oauthOrExternalEffectStarted || input.durableSideEffectStarted
      ? 'unknown_transport_after_side_effect'
      : 'pre_side_effect_transport'
  }
  return 'external_dependency'
}

function originFor(code: OpenCodeLaunchFailureKind): OpenCodeProviderFailureOrigin {
  if (code === 'contract_violation') return 'contract'
  if (code === 'cancelled') return 'cancellation'
  if (code.startsWith('deadline_') || code.includes('budget_exhausted')) return 'deadline'
  if (code.includes('transport')) return 'transport'
  return 'provider'
}

/** Classifies potentially unsafe provider input into a closed, serialization-safe value. */
export function classifyOpenCodeProviderFailure(
  input: OpenCodeProviderFailureInput,
): OpenCodeProviderFailure {
  const snapshot = snapshotProviderFailureInput(input)
  if (!snapshot || typeof snapshot.operation !== 'string'
    || !Object.prototype.hasOwnProperty.call(PHASE_BY_OPERATION, snapshot.operation)) {
    throw new TypeError('Invalid OpenCode provider operation')
  }
  const operation = snapshot.operation
  const code = classifyProviderFailureCode(snapshot)
  const policy = OPEN_CODE_LAUNCH_FAILURE_POLICY[code]
  const sideEffectsStarted = code === 'unknown_transport_after_side_effect'
    || code === 'deadline_after_partial'
      ? true
      : policy.sideEffectsStarted
  const failure = {
    code,
    operation,
    origin: originFor(code),
    phase: PHASE_BY_OPERATION[operation],
    retryDisposition: policy.retryDisposition,
    retryable: policy.retryable,
    sideEffectsStarted,
    retryAfterMs: code === 'rate_limited' || code === 'quota_exhausted'
      ? boundedRetryAfterMs(snapshot.retryAfterMs)
      : null,
    message: OPEN_CODE_PROVIDER_FAILURE_MESSAGES[code],
  }
  return Object.freeze(failure) as OpenCodeProviderFailure
}

export function createOpenCodeContractViolationFailure(
  operation: OpenCodeProviderOperation,
): OpenCodeProviderFailure {
  return classifyOpenCodeProviderFailure({ operation, contractViolation: true })
}
