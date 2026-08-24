/** Pure optional wire contract. Legacy executionProof is never launch authorization. */
import { types as nodeUtilTypes } from 'node:util'
import {
  OPEN_CODE_LAUNCH_FAILURE_POLICY,
  type OpenCodeLaunchFailureKind,
  type OpenCodeLaunchRetryDisposition,
} from './OpenCodeLaunchAttemptPolicy.js'
import { OPEN_CODE_MAX_RETRY_AFTER_MS } from './OpenCodeFailurePolicy.js'
import {
  parseOpenCodeExactProviderModelRef,
  tryCreateOpenCodeCanonicalProviderId,
} from './OpenCodeProviderIdentity.js'

export const OPEN_CODE_LAUNCH_ATTEMPT_CONTRACT_VERSION = 1 as const

export type OpenCodeBridgeCapabilityVersions = {
  openCodeLaunchAttemptContract: number
  purposeScopedProfiles: number
  freshRetainedHostProof: number
  idempotentContinuation: number
  typedFailureDiagnostics: number
}
export type OpenCodeBridgeDecodeError = {
  code: 'invalid_json' | 'invalid_field' | 'unsupported_version'
  field: string
}
export type OpenCodeBridgeDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: OpenCodeBridgeDecodeError }

export type OpenCodeOpaqueIdentity = `sha256:${string}`
export type OpenCodeRetainedHostIdentity = {
  /** Opaque identity of the orchestrator host key; never the key or endpoint itself. */
  hostKeyIdentity: OpenCodeOpaqueIdentity
  /** OS process identity, bound to its birth time to prevent PID reuse. */
  processId: number
  processStartedAtMs: number
  /** Opaque identity of the purpose/profile scope used to create the host. */
  profileScopeIdentity: OpenCodeOpaqueIdentity
}
export type OpenCodeLaunchParentLinkage = {
  sessionIdentity: OpenCodeOpaqueIdentity
  messageIdentity: OpenCodeOpaqueIdentity
}
export type OpenCodeLaunchAttempt = {
  /** The sole idempotency key for a launch attempt. */
  attemptId: string
  /** SHA-256 of the canonical launch payload, excluding this wire envelope. */
  payloadHash: string
  generation: number
  proofNonce: string
  parent: OpenCodeLaunchParentLinkage
  providerId: string
  modelId: string
  requiredMcpTools: string[]
  continuationToken?: string
  requireFreshRetainedHostProof: true
}
export type OpenCodeLaunchAttemptRequest = {
  launchContractVersion: 1
  launchAttempt: OpenCodeLaunchAttempt
}
export type DecodedOpenCodeLaunchAttemptRequest =
  | { kind: 'legacy' }
  | { kind: 'v2'; request: OpenCodeLaunchAttemptRequest }

export type OpenCodeLaunchAttemptOutcome =
  | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'reconciliation_required'
export type { OpenCodeLaunchFailureKind, OpenCodeLaunchRetryDisposition }
export type OpenCodeLaunchAttemptPhase =
  | 'profile_prepare' | 'retained_host_start' | 'provider_live_validate'
  | 'retained_host_mcp_proof' | 'execution_submit' | 'execution_poll'
  | 'member_materialize' | 'result_commit' | 'cleanup' | 'complete'
export type OpenCodeLaunchFailureOrigin =
  | 'profile' | 'host' | 'catalog' | 'mcp' | 'provider' | 'session' | 'store' | 'deadline'
export type OpenCodeLaunchExhaustionScope =
  | 'attempt' | 'member' | 'profile' | 'host' | 'provider' | 'global'

export type OpenCodeLaunchFailureDetails = {
  code: OpenCodeLaunchFailureKind
  origin: OpenCodeLaunchFailureOrigin
  retryDisposition: OpenCodeLaunchRetryDisposition
  retryable: boolean
  retryAfterMs?: number
  phase: OpenCodeLaunchAttemptPhase
  sideEffectsStarted: boolean
  exhaustionScope?: OpenCodeLaunchExhaustionScope
}
export type OpenCodeLaunchAttemptDetails = {
  contractVersion: 1
  /** attemptId is the idempotency key; no derived or alternative key is permitted in v2. */
  attemptId: string
  idempotencyKey: 'attemptId'
  payloadHash: string
  generation: number
  /** Orchestrator-authored digest for this exact generation/mode/token. */
  inputDigest: string
  /** Orchestrator-authored stable digest for the immutable ordered launch plan. */
  immutableDigest: string
  outcome: OpenCodeLaunchAttemptOutcome
  phase: OpenCodeLaunchAttemptPhase
  startedAt: number
  absoluteDeadlineAt: number
  workDeadlineAt: number
  cleanupReserveMs: number
  elapsedMs: number
  providerId: string
  modelId: string
  profilePurpose: string
  projectIdentity: OpenCodeOpaqueIdentity
  profileIdentity: OpenCodeOpaqueIdentity
  configIdentity: OpenCodeOpaqueIdentity
  authIdentity: OpenCodeOpaqueIdentity
  pluginPolicyIdentity: OpenCodeOpaqueIdentity
  cacheIdentity: OpenCodeOpaqueIdentity
  /** Canonical digest of the exact immutable executable bytes used by the host. */
  binaryIdentity: OpenCodeOpaqueIdentity
  retainedHostIdentity: OpenCodeRetainedHostIdentity
  processStartedAtMs?: number
}
export type OpenCodeRetainedHostProof = {
  generation: number
  attemptId: string
  parent: OpenCodeLaunchParentLinkage
  providerId: string
  modelId: string
  retainedHostIdentity: OpenCodeRetainedHostIdentity
  observedMcpTools: string[]
  nonceHash: string
  sessionIdentity: OpenCodeOpaqueIdentity
  promptMessageIdentity: OpenCodeOpaqueIdentity
  assistantMessageIdentity: OpenCodeOpaqueIdentity
  verifiedAt: number
  authorizationSource: 'fresh_live_attempt'
  cacheUsed: false
}
export type OpenCodeLaunchMemberLinkage = {
  memberIdentity: OpenCodeOpaqueIdentity
  sessionIdentity: OpenCodeOpaqueIdentity
  bootstrapMessageIdentity: OpenCodeOpaqueIdentity
  commitIdentity: OpenCodeOpaqueIdentity
}
export type OpenCodeLaunchMemberOutcomes = {
  committed: OpenCodeLaunchMemberLinkage[]
  failed: Array<{ memberIdentity: OpenCodeOpaqueIdentity; failure: OpenCodeLaunchFailureDetails }>
  pending: OpenCodeOpaqueIdentity[]
  cleanupPending: OpenCodeOpaqueIdentity[]
  continuationToken?: string
}
export type OpenCodeLaunchAttemptResponse = {
  launchAttempt: OpenCodeLaunchAttemptDetails
  proof?: OpenCodeRetainedHostProof
  members: OpenCodeLaunchMemberOutcomes
  failure?: OpenCodeLaunchFailureDetails
}
export type DecodedOpenCodeLaunchAttemptResponse =
  | { kind: 'legacy' }
  | { kind: 'v2'; response: OpenCodeLaunchAttemptResponse }

const capabilityFields = [
  'openCodeLaunchAttemptContract', 'purposeScopedProfiles', 'freshRetainedHostProof',
  'idempotentContinuation', 'typedFailureDiagnostics',
] as const satisfies readonly (keyof OpenCodeBridgeCapabilityVersions)[]
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const base64UrlPattern = /^[A-Za-z0-9_-]+$/
const base64UrlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const sha256Pattern = /^[0-9a-f]{64}$/
const opaqueIdentityPattern = /^sha256:[0-9a-f]{64}$/
const purposePattern = /^[a-z][a-z0-9_-]{0,63}$/
const toolPattern = /^[a-z][a-z0-9_.:-]{0,127}$/
const sensitiveWireTextPattern = /(?:https?:\/\/|wss?:\/\/|@|bearer|secret|credential|authorization|password|api[_-]?key|access[_-]?token|refresh[_-]?token)/i
const outcomes: readonly OpenCodeLaunchAttemptOutcome[] = [
  'succeeded', 'partial', 'failed', 'cancelled', 'reconciliation_required',
]
const phases: readonly OpenCodeLaunchAttemptPhase[] = [
  'profile_prepare', 'retained_host_start', 'provider_live_validate', 'retained_host_mcp_proof',
  'execution_submit', 'execution_poll', 'member_materialize', 'result_commit', 'cleanup', 'complete',
]
const origins: readonly OpenCodeLaunchFailureOrigin[] = [
  'profile', 'host', 'catalog', 'mcp', 'provider', 'session', 'store', 'deadline',
]
const exhaustionScopes: readonly OpenCodeLaunchExhaustionScope[] = [
  'attempt', 'member', 'profile', 'host', 'provider', 'global',
]

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || nodeUtilTypes.isProxy(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>
  if (Reflect.ownKeys(descriptors).some(key => typeof key === 'symbol')) return null
  const snapshot = Object.create(null) as Record<string, unknown>
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor' || !('value' in descriptor)) return null
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    })
  }
  return Object.freeze(snapshot)
}
function owns(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field)
}
function invalid(field: string): OpenCodeBridgeDecodeResult<never> {
  return { ok: false, error: { code: 'invalid_field', field } }
}
function unsupported(field: string): OpenCodeBridgeDecodeResult<never> {
  return { ok: false, error: { code: 'unsupported_version', field } }
}
function isDecodeFailure<T>(
  result: OpenCodeBridgeDecodeResult<T>,
): result is { ok: false; error: OpenCodeBridgeDecodeError } {
  return result.ok === false
}
function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T)
}
function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}
function opaqueToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/[\u0000-\u001f\u007f]/.test(value) && !sensitiveWireTextPattern.test(value)
}
export function isOpenCodeLaunchPayloadHash(value: unknown): value is string {
  return typeof value === 'string' && sha256Pattern.test(value)
}
export function isOpenCodeLaunchAttemptId(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value)
}
function uniqueStrings<T extends string>(
  value: unknown,
  predicate: (item: unknown) => item is T,
): value is T[] {
  return Array.isArray(value) && value.every(predicate) && new Set(value).size === value.length
}
function inertArray(value: unknown): readonly unknown[] | null {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>
  if (Reflect.ownKeys(descriptors).some(key => typeof key === 'symbol')) return null
  const lengthDescriptor = descriptors.length
  if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) return null
  const length = lengthDescriptor.value as number
  const snapshot = new Array<unknown>(length)
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === 'length') continue
    if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length || !('value' in descriptor)) return null
    snapshot[Number(key)] = descriptor.value
  }
  if (Object.keys(descriptors).length !== length + 1) return null
  return Object.freeze(snapshot)
}
function toolName(value: unknown): value is string {
  return typeof value === 'string' && toolPattern.test(value) && !sensitiveWireTextPattern.test(value)
}
function wireIdentifier(pattern: RegExp, value: unknown): value is string {
  return typeof value === 'string' && pattern.test(value) && !sensitiveWireTextPattern.test(value)
}

function canonicalWireProvider(providerId: unknown): providerId is string {
  return typeof providerId === 'string'
    && tryCreateOpenCodeCanonicalProviderId(providerId) === providerId
}

function exactWireModelRef(modelId: unknown, providerId: unknown): modelId is string {
  if (typeof modelId !== 'string' || typeof providerId !== 'string') return false
  const model = parseOpenCodeExactProviderModelRef(modelId)
  return model !== null && model.providerId === providerId
}

/** Constructs the only identity representation accepted on the v2 wire. */
export function buildOpenCodeOpaqueIdentity(hash: string): OpenCodeOpaqueIdentity {
  if (!isOpenCodeLaunchPayloadHash(hash)) throw new TypeError('OpenCode identity hash must be canonical lowercase SHA-256')
  return `sha256:${hash}`
}
export function isOpenCodeOpaqueIdentity(value: unknown): value is OpenCodeOpaqueIdentity {
  return typeof value === 'string' && opaqueIdentityPattern.test(value)
}

/** Builds the only retained-host identity shape accepted on the v2 wire. */
export function buildOpenCodeRetainedHostIdentity(
  hostKeyIdentity: OpenCodeOpaqueIdentity,
  processId: number,
  processStartedAtMs: number,
  profileScopeIdentity: OpenCodeOpaqueIdentity,
): OpenCodeRetainedHostIdentity {
  const value = { hostKeyIdentity, processId, processStartedAtMs, profileScopeIdentity }
  if (!isOpenCodeRetainedHostIdentity(value)) {
    throw new TypeError('Invalid OpenCode retained-host identity')
  }
  return value
}
export function isOpenCodeRetainedHostIdentity(value: unknown): value is OpenCodeRetainedHostIdentity {
  const source = record(value)
  return source !== null
    && isOpenCodeOpaqueIdentity(source.hostKeyIdentity)
    && safeInteger(source.processId) && source.processId > 0
    && safeInteger(source.processStartedAtMs)
    && isOpenCodeOpaqueIdentity(source.profileScopeIdentity)
}

function decodeRetainedHostIdentity(
  value: unknown,
  field: string,
): OpenCodeBridgeDecodeResult<OpenCodeRetainedHostIdentity> {
  const source = record(value)
  if (!source
    || !isOpenCodeOpaqueIdentity(source.hostKeyIdentity)
    || !safeInteger(source.processId) || source.processId <= 0
    || !safeInteger(source.processStartedAtMs)
    || !isOpenCodeOpaqueIdentity(source.profileScopeIdentity)) return invalid(field)
  return { ok: true, value: {
    hostKeyIdentity: source.hostKeyIdentity,
    processId: source.processId,
    processStartedAtMs: source.processStartedAtMs,
    profileScopeIdentity: source.profileScopeIdentity,
  } }
}

/** Canonical, unpadded base64url carrying at least 128 bits. */
export function isOpenCodeLaunchProofNonce(value: unknown): value is string {
  if (typeof value !== 'string' || !base64UrlPattern.test(value) || value.length % 4 === 1) return false
  if (Math.floor(value.length * 6 / 8) < 16) return false
  const remainder = value.length % 4
  const lastValue = base64UrlAlphabet.indexOf(value[value.length - 1]!)
  return (remainder !== 2 || lastValue % 16 === 0) && (remainder !== 3 || lastValue % 4 === 0)
}

export function decodeOpenCodeBridgeCapabilities(
  value: unknown,
): OpenCodeBridgeDecodeResult<OpenCodeBridgeCapabilityVersions> {
  try {
    const source = record(value)
    if (!source) return invalid('$')
    const decoded = {} as OpenCodeBridgeCapabilityVersions
    for (const field of capabilityFields) {
      const candidate = source[field]
      if (!owns(source, field)) decoded[field] = 0
      else if (safeInteger(candidate)) decoded[field] = candidate
      else return invalid(field)
    }
    return { ok: true, value: decoded }
  } catch { return invalid('$') }
}

export function encodeOpenCodeBridgeCapabilities(
  value: OpenCodeBridgeCapabilityVersions,
): OpenCodeBridgeCapabilityVersions {
  const decoded = decodeOpenCodeBridgeCapabilities(value)
  if (isDecodeFailure(decoded)) throw new TypeError(`Invalid OpenCode capability: ${decoded.error.field}`)
  return decoded.value
}

function decodeParent(value: unknown, field: string): OpenCodeBridgeDecodeResult<OpenCodeLaunchParentLinkage> {
  const source = record(value)
  if (!source) return invalid(field)
  if (!isOpenCodeOpaqueIdentity(source.sessionIdentity)) return invalid(`${field}.sessionIdentity`)
  if (!isOpenCodeOpaqueIdentity(source.messageIdentity)) return invalid(`${field}.messageIdentity`)
  return { ok: true, value: {
    sessionIdentity: source.sessionIdentity,
    messageIdentity: source.messageIdentity,
  } }
}

export function decodeOpenCodeLaunchAttemptRequest(
  value: unknown,
): OpenCodeBridgeDecodeResult<DecodedOpenCodeLaunchAttemptRequest> {
  try {
    const source = record(value)
    if (!source) return invalid('$')
    const hasVersion = owns(source, 'launchContractVersion')
    const hasAttempt = owns(source, 'launchAttempt')
    if (!hasVersion && !hasAttempt) return { ok: true, value: { kind: 'legacy' } }
    if (source.launchContractVersion !== OPEN_CODE_LAUNCH_ATTEMPT_CONTRACT_VERSION) {
      return typeof source.launchContractVersion === 'number'
        ? unsupported('launchContractVersion') : invalid('launchContractVersion')
    }
    const attempt = record(source.launchAttempt)
    if (!attempt) return invalid('launchAttempt')
    if (!isOpenCodeLaunchAttemptId(attempt.attemptId)) {
      return invalid('launchAttempt.attemptId')
    }
    if (!isOpenCodeLaunchPayloadHash(attempt.payloadHash)) return invalid('launchAttempt.payloadHash')
    if (!positiveInteger(attempt.generation)) return invalid('launchAttempt.generation')
    if (!isOpenCodeLaunchProofNonce(attempt.proofNonce)) return invalid('launchAttempt.proofNonce')
    const parent = decodeParent(attempt.parent, 'launchAttempt.parent')
    if (isDecodeFailure(parent)) return parent
    const providerId = attempt.providerId
    const modelId = attempt.modelId
    if (!canonicalWireProvider(providerId)) {
      return invalid('launchAttempt.providerId')
    }
    if (!exactWireModelRef(modelId, providerId)) return invalid('launchAttempt.modelId')
    const requiredMcpTools = inertArray(attempt.requiredMcpTools)
    if (!requiredMcpTools || !uniqueStrings(requiredMcpTools, toolName) || requiredMcpTools.length === 0) {
      return invalid('launchAttempt.requiredMcpTools')
    }
    if (attempt.requireFreshRetainedHostProof !== true) {
      return invalid('launchAttempt.requireFreshRetainedHostProof')
    }
    const continuationToken = attempt.continuationToken
    if (continuationToken !== undefined && !opaqueToken(continuationToken)) {
      return invalid('launchAttempt.continuationToken')
    }
    const ownedContinuationToken = continuationToken as string | undefined
    return { ok: true, value: { kind: 'v2', request: {
      launchContractVersion: 1,
      launchAttempt: {
        attemptId: attempt.attemptId,
        payloadHash: attempt.payloadHash,
        generation: attempt.generation,
        proofNonce: attempt.proofNonce,
        parent: parent.value,
        providerId,
        modelId,
        requiredMcpTools: [...requiredMcpTools],
        ...(ownedContinuationToken === undefined ? {} : { continuationToken: ownedContinuationToken }),
        requireFreshRetainedHostProof: true,
      },
    } } }
  } catch { return invalid('$') }
}

/** Whitelist encoder; properties outside the v2 request contract are dropped. */
export function encodeOpenCodeLaunchAttemptRequest(
  value: OpenCodeLaunchAttemptRequest,
): OpenCodeLaunchAttemptRequest {
  const decoded = decodeOpenCodeLaunchAttemptRequest(value)
  if (isDecodeFailure(decoded)) throw new TypeError(`Invalid OpenCode launch request: ${decoded.error.field}`)
  if (decoded.value.kind !== 'v2') throw new TypeError('OpenCode launch request is missing v2 fields')
  return decoded.value.request
}

function decodeFailure(value: unknown, field: string): OpenCodeBridgeDecodeResult<OpenCodeLaunchFailureDetails> {
  const source = record(value)
  if (!source) return invalid(field)
  if (typeof source.code !== 'string' || !owns(OPEN_CODE_LAUNCH_FAILURE_POLICY, source.code)) {
    return invalid(`${field}.code`)
  }
  const code = source.code as OpenCodeLaunchFailureKind
  const canonical = OPEN_CODE_LAUNCH_FAILURE_POLICY[code]
  if (!member(origins, source.origin)) return invalid(`${field}.origin`)
  if (source.retryDisposition !== canonical.retryDisposition) return invalid(`${field}.retryDisposition`)
  if (source.retryable !== canonical.retryable) return invalid(`${field}.retryable`)
  if (source.sideEffectsStarted !== canonical.sideEffectsStarted) return invalid(`${field}.sideEffectsStarted`)
  const retryAfterMs = source.retryAfterMs
  if (retryAfterMs !== undefined && (
    !safeInteger(retryAfterMs)
    || retryAfterMs > OPEN_CODE_MAX_RETRY_AFTER_MS
    || (code !== 'rate_limited' && code !== 'quota_exhausted')
  )) return invalid(`${field}.retryAfterMs`)
  const ownedRetryAfterMs = retryAfterMs as number | undefined
  if (!member(phases, source.phase)) return invalid(`${field}.phase`)
  const exhaustionScope = source.exhaustionScope
  if (exhaustionScope !== undefined && !member(exhaustionScopes, exhaustionScope)) {
    return invalid(`${field}.exhaustionScope`)
  }
  const ownedExhaustionScope = exhaustionScope as OpenCodeLaunchFailureDetails['exhaustionScope']
  return { ok: true, value: {
    code,
    origin: source.origin,
    retryDisposition: canonical.retryDisposition,
    retryable: canonical.retryable,
    ...(ownedRetryAfterMs === undefined ? {} : { retryAfterMs: ownedRetryAfterMs }),
    phase: source.phase,
    sideEffectsStarted: canonical.sideEffectsStarted,
    ...(ownedExhaustionScope === undefined ? {} : { exhaustionScope: ownedExhaustionScope }),
  } }
}

function decodeLaunchAttempt(value: unknown): OpenCodeBridgeDecodeResult<OpenCodeLaunchAttemptDetails> {
  const source = record(value)
  if (!source) return invalid('launchAttempt')
  if (source.contractVersion !== OPEN_CODE_LAUNCH_ATTEMPT_CONTRACT_VERSION) {
    return typeof source.contractVersion === 'number'
      ? unsupported('launchAttempt.contractVersion') : invalid('launchAttempt.contractVersion')
  }
  if (!isOpenCodeLaunchAttemptId(source.attemptId)) return invalid('launchAttempt.attemptId')
  if (source.idempotencyKey !== 'attemptId') return invalid('launchAttempt.idempotencyKey')
  if (!isOpenCodeLaunchPayloadHash(source.payloadHash)) return invalid('launchAttempt.payloadHash')
  if (!positiveInteger(source.generation)) return invalid('launchAttempt.generation')
  if (!isOpenCodeLaunchPayloadHash(source.inputDigest)) return invalid('launchAttempt.inputDigest')
  if (!isOpenCodeLaunchPayloadHash(source.immutableDigest)) return invalid('launchAttempt.immutableDigest')
  if (!member(outcomes, source.outcome)) return invalid('launchAttempt.outcome')
  if (!member(phases, source.phase)) return invalid('launchAttempt.phase')
  const startedAt = source.startedAt
  const workDeadlineAt = source.workDeadlineAt
  const absoluteDeadlineAt = source.absoluteDeadlineAt
  const cleanupReserveMs = source.cleanupReserveMs
  const elapsedMs = source.elapsedMs
  if (!safeInteger(startedAt)) return invalid('launchAttempt.startedAt')
  if (!safeInteger(workDeadlineAt)) return invalid('launchAttempt.workDeadlineAt')
  if (!safeInteger(absoluteDeadlineAt)) return invalid('launchAttempt.absoluteDeadlineAt')
  if (!safeInteger(cleanupReserveMs) || cleanupReserveMs === 0) {
    return invalid('launchAttempt.cleanupReserveMs')
  }
  if (!safeInteger(elapsedMs)) return invalid('launchAttempt.elapsedMs')
  if (startedAt > workDeadlineAt || workDeadlineAt >= absoluteDeadlineAt) {
    return invalid('launchAttempt.workDeadlineAt')
  }
  if (absoluteDeadlineAt - workDeadlineAt !== cleanupReserveMs) {
    return invalid('launchAttempt.cleanupReserveMs')
  }
  const providerId = source.providerId
  const modelId = source.modelId
  if (!canonicalWireProvider(providerId)) return invalid('launchAttempt.providerId')
  if (!exactWireModelRef(modelId, providerId)) return invalid('launchAttempt.modelId')
  if (!wireIdentifier(purposePattern, source.profilePurpose)) return invalid('launchAttempt.profilePurpose')
  const projectIdentity = source.projectIdentity
  const profileIdentity = source.profileIdentity
  const configIdentity = source.configIdentity
  const authIdentity = source.authIdentity
  const pluginPolicyIdentity = source.pluginPolicyIdentity
  const cacheIdentity = source.cacheIdentity
  const binaryIdentity = source.binaryIdentity
  if (!isOpenCodeOpaqueIdentity(projectIdentity)) return invalid('launchAttempt.projectIdentity')
  if (!isOpenCodeOpaqueIdentity(profileIdentity)) return invalid('launchAttempt.profileIdentity')
  if (!isOpenCodeOpaqueIdentity(configIdentity)) return invalid('launchAttempt.configIdentity')
  if (!isOpenCodeOpaqueIdentity(authIdentity)) return invalid('launchAttempt.authIdentity')
  if (!isOpenCodeOpaqueIdentity(pluginPolicyIdentity)) return invalid('launchAttempt.pluginPolicyIdentity')
  if (!isOpenCodeOpaqueIdentity(cacheIdentity)) return invalid('launchAttempt.cacheIdentity')
  if (!isOpenCodeOpaqueIdentity(binaryIdentity)) return invalid('launchAttempt.binaryIdentity')
  const retainedHostIdentity = decodeRetainedHostIdentity(
    source.retainedHostIdentity, 'launchAttempt.retainedHostIdentity',
  )
  if (isDecodeFailure(retainedHostIdentity)) return retainedHostIdentity
  const processStartedAtMs = source.processStartedAtMs
  if (processStartedAtMs !== undefined && !safeInteger(processStartedAtMs)) {
    return invalid('launchAttempt.processStartedAtMs')
  }
  if (processStartedAtMs !== undefined
    && processStartedAtMs !== retainedHostIdentity.value.processStartedAtMs) {
    return invalid('launchAttempt.processStartedAtMs')
  }
  const ownedProcessStartedAtMs = processStartedAtMs as number | undefined
  return { ok: true, value: {
    contractVersion: 1,
    attemptId: source.attemptId,
    idempotencyKey: 'attemptId',
    payloadHash: source.payloadHash,
    generation: source.generation,
    inputDigest: source.inputDigest,
    immutableDigest: source.immutableDigest,
    outcome: source.outcome,
    phase: source.phase,
    startedAt,
    absoluteDeadlineAt,
    workDeadlineAt,
    cleanupReserveMs,
    elapsedMs,
    providerId,
    modelId,
    profilePurpose: source.profilePurpose,
    projectIdentity,
    profileIdentity,
    configIdentity,
    authIdentity,
    pluginPolicyIdentity,
    cacheIdentity,
    binaryIdentity,
    retainedHostIdentity: retainedHostIdentity.value,
    ...(ownedProcessStartedAtMs === undefined ? {} : { processStartedAtMs: ownedProcessStartedAtMs }),
  } }
}

function decodeProof(value: unknown): OpenCodeBridgeDecodeResult<OpenCodeRetainedHostProof> {
  const source = record(value)
  if (!source) return invalid('proof')
  if (!positiveInteger(source.generation)) return invalid('proof.generation')
  if (!isOpenCodeLaunchAttemptId(source.attemptId)) return invalid('proof.attemptId')
  const parent = decodeParent(source.parent, 'proof.parent')
  if (isDecodeFailure(parent)) return parent
  const providerId = source.providerId
  const modelId = source.modelId
  if (!canonicalWireProvider(providerId)) return invalid('proof.providerId')
  if (!exactWireModelRef(modelId, providerId)) return invalid('proof.modelId')
  const retainedHostIdentity = decodeRetainedHostIdentity(source.retainedHostIdentity, 'proof.retainedHostIdentity')
  if (isDecodeFailure(retainedHostIdentity)) return retainedHostIdentity
  const observedMcpTools = inertArray(source.observedMcpTools)
  if (!observedMcpTools || !uniqueStrings(observedMcpTools, toolName)) return invalid('proof.observedMcpTools')
  if (!isOpenCodeLaunchPayloadHash(source.nonceHash)) return invalid('proof.nonceHash')
  const sessionIdentity = source.sessionIdentity
  const promptMessageIdentity = source.promptMessageIdentity
  const assistantMessageIdentity = source.assistantMessageIdentity
  if (!isOpenCodeOpaqueIdentity(sessionIdentity)) return invalid('proof.sessionIdentity')
  if (!isOpenCodeOpaqueIdentity(promptMessageIdentity)) return invalid('proof.promptMessageIdentity')
  if (!isOpenCodeOpaqueIdentity(assistantMessageIdentity)) return invalid('proof.assistantMessageIdentity')
  if (!safeInteger(source.verifiedAt)) return invalid('proof.verifiedAt')
  if (source.authorizationSource !== 'fresh_live_attempt') return invalid('proof.authorizationSource')
  if (source.cacheUsed !== false) return invalid('proof.cacheUsed')
  return { ok: true, value: {
    generation: source.generation,
    attemptId: source.attemptId,
    parent: parent.value,
    providerId,
    modelId,
    retainedHostIdentity: retainedHostIdentity.value,
    observedMcpTools: [...observedMcpTools],
    nonceHash: source.nonceHash,
    sessionIdentity,
    promptMessageIdentity,
    assistantMessageIdentity,
    verifiedAt: source.verifiedAt,
    authorizationSource: 'fresh_live_attempt',
    cacheUsed: false,
  } }
}

function decodeMembers(value: unknown): OpenCodeBridgeDecodeResult<OpenCodeLaunchMemberOutcomes> {
  const source = record(value)
  if (!source) return invalid('members')
  const committedSource = inertArray(source.committed)
  const failedSource = inertArray(source.failed)
  const pendingSource = inertArray(source.pending)
  const cleanupPendingSource = inertArray(source.cleanupPending)
  if (!committedSource) return invalid('members.committed')
  if (!failedSource) return invalid('members.failed')
  if (!pendingSource) return invalid('members.pending')
  if (!cleanupPendingSource) return invalid('members.cleanupPending')
  const continuationToken = source.continuationToken
  if (continuationToken !== undefined && !opaqueToken(continuationToken)) return invalid('members.continuationToken')
  const ownedContinuationToken = continuationToken as string | undefined
  const committed: OpenCodeLaunchMemberLinkage[] = []
  const correlatedIdentities = new Set<OpenCodeOpaqueIdentity>()
  for (let i = 0; i < committedSource.length; i += 1) {
    const item = record(committedSource[i])
    if (!item) return invalid(`members.committed.${i}`)
    const memberIdentity = item.memberIdentity
    const sessionIdentity = item.sessionIdentity
    const bootstrapMessageIdentity = item.bootstrapMessageIdentity
    const commitIdentity = item.commitIdentity
    if (!isOpenCodeOpaqueIdentity(memberIdentity)) return invalid(`members.committed.${i}.memberIdentity`)
    if (!isOpenCodeOpaqueIdentity(sessionIdentity)) return invalid(`members.committed.${i}.sessionIdentity`)
    if (!isOpenCodeOpaqueIdentity(bootstrapMessageIdentity)) return invalid(`members.committed.${i}.bootstrapMessageIdentity`)
    if (!isOpenCodeOpaqueIdentity(commitIdentity)) return invalid(`members.committed.${i}.commitIdentity`)
    for (const [field, identity] of [
      ['memberIdentity', memberIdentity],
      ['sessionIdentity', sessionIdentity],
      ['bootstrapMessageIdentity', bootstrapMessageIdentity],
      ['commitIdentity', commitIdentity],
    ] as const) {
      if (correlatedIdentities.has(identity)) return invalid(`members.committed.${i}.${field}`)
      correlatedIdentities.add(identity)
    }
    committed.push({
      memberIdentity,
      sessionIdentity,
      bootstrapMessageIdentity,
      commitIdentity,
    })
  }
  const failed: OpenCodeLaunchMemberOutcomes['failed'] = []
  for (let i = 0; i < failedSource.length; i += 1) {
    const item = record(failedSource[i])
    if (!item || !isOpenCodeOpaqueIdentity(item.memberIdentity)) return invalid(`members.failed.${i}.memberIdentity`)
    if (correlatedIdentities.has(item.memberIdentity)) return invalid(`members.failed.${i}.memberIdentity`)
    const failure = decodeFailure(item.failure, `members.failed.${i}.failure`)
    if (isDecodeFailure(failure)) return failure
    correlatedIdentities.add(item.memberIdentity)
    failed.push({ memberIdentity: item.memberIdentity, failure: failure.value })
  }
  if (!uniqueStrings(pendingSource, isOpenCodeOpaqueIdentity)) return invalid('members.pending')
  if (!uniqueStrings(cleanupPendingSource, isOpenCodeOpaqueIdentity)) return invalid('members.cleanupPending')
  if (pendingSource.some(identity => correlatedIdentities.has(identity))) return invalid('members.pending')
  const resultIds = [...committed.map(item => item.memberIdentity), ...failed.map(item => item.memberIdentity), ...pendingSource]
  if (new Set(resultIds).size !== resultIds.length) return invalid('members')
  const resultMemberIdentities = new Set(resultIds)
  if (cleanupPendingSource.some(identity => correlatedIdentities.has(identity) && !resultMemberIdentities.has(identity))) {
    return invalid('members.cleanupPending')
  }
  return { ok: true, value: {
    committed,
    failed,
    pending: [...pendingSource],
    cleanupPending: [...cleanupPendingSource],
    ...(ownedContinuationToken === undefined ? {} : { continuationToken: ownedContinuationToken }),
  } }
}

function hasContinuationFailure(
  failure: OpenCodeLaunchFailureDetails | undefined,
  members: OpenCodeLaunchMemberOutcomes,
): boolean {
  return failure?.retryDisposition === 'continuation'
    || members.failed.some(item => item.failure.retryDisposition === 'continuation')
}

function decodeResponse(value: unknown): OpenCodeBridgeDecodeResult<OpenCodeLaunchAttemptResponse> {
  const source = record(value)
  if (!source) return invalid('$')
  const launchAttempt = decodeLaunchAttempt(source.launchAttempt)
  if (isDecodeFailure(launchAttempt)) return launchAttempt
  let proof: OpenCodeRetainedHostProof | undefined
  if (source.proof !== undefined) {
    const decodedProof = decodeProof(source.proof)
    if (isDecodeFailure(decodedProof)) return decodedProof
    proof = decodedProof.value
  }
  const members = decodeMembers(source.members)
  if (isDecodeFailure(members)) return members
  let failure: OpenCodeLaunchFailureDetails | undefined
  if (source.failure !== undefined) {
    const decodedFailure = decodeFailure(source.failure, 'failure')
    if (isDecodeFailure(decodedFailure)) return decodedFailure
    failure = decodedFailure.value
  }
  const { outcome } = launchAttempt.value
  if ((outcome === 'succeeded' || outcome === 'partial') && proof === undefined) return invalid('proof')
  if (outcome === 'succeeded'
    && (members.value.failed.length > 0 || members.value.pending.length > 0
      || members.value.continuationToken !== undefined || failure !== undefined)) return invalid('members')
  if (outcome === 'partial'
    && members.value.committed.length === 0) return invalid('members')
  if (outcome === 'failed' && (failure === undefined || members.value.committed.length > 0)) return invalid('failure')
  if (outcome === 'reconciliation_required'
    && (failure === undefined || failure.code !== 'unknown_transport_after_side_effect'
      || members.value.continuationToken !== undefined)) return invalid('members.continuationToken')
  if (members.value.continuationToken !== undefined
    && outcome !== 'partial') return invalid('members.continuationToken')
  return { ok: true, value: {
    launchAttempt: launchAttempt.value,
    ...(proof === undefined ? {} : { proof }),
    members: members.value,
    ...(failure === undefined ? {} : { failure }),
  } }
}

export function decodeOpenCodeLaunchAttemptResponse(
  value: unknown,
): OpenCodeBridgeDecodeResult<DecodedOpenCodeLaunchAttemptResponse> {
  try {
    const source = record(value)
    if (!source) return invalid('$')
    const memberSet = record(source.members)
    const hasV2MemberField = memberSet !== null
      && ['committed', 'failed', 'pending', 'cleanupPending', 'continuationToken'].some(field => owns(memberSet, field))
    if (!hasV2MemberField && !['launchAttempt', 'proof', 'failure'].some(field => owns(source, field))) {
      return { ok: true, value: { kind: 'legacy' } }
    }
    const decoded = decodeResponse(source)
    return isDecodeFailure(decoded)
      ? decoded
      : { ok: true, value: { kind: 'v2', response: decoded.value } }
  } catch { return invalid('$') }
}

export type OpenCodeLaunchCorrelationFailure = OpenCodeLaunchFailureDetails & {
  code: 'contract_violation'
  origin: 'session'
  retryDisposition: 'never'
  retryable: false
  sideEffectsStarted: false
  field: string
}
export type OpenCodeLaunchCorrelationResult =
  | { ok: true; request: OpenCodeLaunchAttemptRequest; response: OpenCodeLaunchAttemptResponse }
  | { ok: false; failure: OpenCodeLaunchCorrelationFailure }
export type OpenCodeLaunchCorrelationContext = {
  currentGeneration: number
  expectedNonceHash: string
  expectedProfilePurpose: string
  expectedProviderId: string
  expectedProjectIdentity: OpenCodeOpaqueIdentity
  expectedConfigIdentity: OpenCodeOpaqueIdentity
  expectedAuthIdentity: OpenCodeOpaqueIdentity
  expectedPluginPolicyIdentity: OpenCodeOpaqueIdentity
  expectedCacheIdentity: OpenCodeOpaqueIdentity
  expectedBinaryIdentity: OpenCodeOpaqueIdentity
  /** Server-side identity learned after the orchestrator creates the retained host. */
  expectedRetainedHostIdentity: OpenCodeRetainedHostIdentity
  requiredMcpTools?: readonly string[]
}

function correlationViolation(field: string): OpenCodeLaunchCorrelationResult {
  const policy = OPEN_CODE_LAUNCH_FAILURE_POLICY.contract_violation
  return Object.freeze({ ok: false, failure: Object.freeze({
    code: 'contract_violation',
    origin: 'session',
    retryDisposition: policy.retryDisposition,
    retryable: policy.retryable,
    phase: 'retained_host_mcp_proof',
    sideEffectsStarted: policy.sideEffectsStarted,
    field,
  }) })
}

function deepFreezeOwned<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreezeOwned(child)
    Object.freeze(value)
  }
  return value
}

/** Decodes, snapshots, and correlates request/proof without performing side effects. */
export function validateOpenCodeLaunchAttemptCorrelation(
  requestValue: unknown,
  responseValue: unknown,
  contextValue: unknown,
): OpenCodeLaunchCorrelationResult {
  try {
    const decodedRequest = decodeOpenCodeLaunchAttemptRequest(requestValue)
    if (isDecodeFailure(decodedRequest)) {
      return correlationViolation(decodedRequest.error.field === '$' ? 'request' : decodedRequest.error.field)
    }
    if (decodedRequest.value.kind !== 'v2') return correlationViolation('request')
    const decodedResponse = decodeOpenCodeLaunchAttemptResponse(responseValue)
    if (isDecodeFailure(decodedResponse)) {
      return correlationViolation(decodedResponse.error.field === '$' ? 'response' : decodedResponse.error.field)
    }
    if (decodedResponse.value.kind !== 'v2') return correlationViolation('response')
    const context = record(contextValue)
    if (!context) return correlationViolation('context')
    if (!safeInteger(context.currentGeneration)) return correlationViolation('currentGeneration')
    if (!isOpenCodeLaunchPayloadHash(context.expectedNonceHash)) return correlationViolation('expectedNonceHash')
    if (!wireIdentifier(purposePattern, context.expectedProfilePurpose)) return correlationViolation('expectedProfilePurpose')
    if (!canonicalWireProvider(context.expectedProviderId)) return correlationViolation('expectedProviderId')
    for (const [field, identity] of [
      ['expectedProjectIdentity', context.expectedProjectIdentity],
      ['expectedConfigIdentity', context.expectedConfigIdentity],
      ['expectedAuthIdentity', context.expectedAuthIdentity],
      ['expectedPluginPolicyIdentity', context.expectedPluginPolicyIdentity],
      ['expectedCacheIdentity', context.expectedCacheIdentity],
      ['expectedBinaryIdentity', context.expectedBinaryIdentity],
    ] as const) if (!isOpenCodeOpaqueIdentity(identity)) return correlationViolation(field)
    const expectedIdentity = decodeRetainedHostIdentity(
      context.expectedRetainedHostIdentity, 'expectedRetainedHostIdentity',
    )
    if (isDecodeFailure(expectedIdentity)) return correlationViolation('expectedRetainedHostIdentity')
    const contextTools = context.requiredMcpTools === undefined
      ? Object.freeze([]) : inertArray(context.requiredMcpTools)
    if (!contextTools || !uniqueStrings(contextTools, toolName)) {
      return correlationViolation('requiredMcpTools')
    }

    const request = deepFreezeOwned(decodedRequest.value.request)
    const response = deepFreezeOwned(decodedResponse.value.response)
    const attempt = request.launchAttempt
    const result = response.launchAttempt
    const proof = response.proof
    if (!proof) return correlationViolation('proof')
    const exact: Array<[string, unknown, unknown]> = [
      ['launchAttempt.attemptId', result.attemptId, attempt.attemptId],
      ['launchAttempt.payloadHash', result.payloadHash, attempt.payloadHash],
      ['launchAttempt.generation', result.generation, attempt.generation],
      ['launchAttempt.providerId', result.providerId, attempt.providerId],
      ['launchAttempt.expectedProviderId', result.providerId, context.expectedProviderId],
      ['launchAttempt.modelId', result.modelId, attempt.modelId],
      ['launchAttempt.profilePurpose', result.profilePurpose, context.expectedProfilePurpose],
      ['launchAttempt.profileIdentity', result.profileIdentity, result.retainedHostIdentity.profileScopeIdentity],
      ['launchAttempt.projectIdentity', result.projectIdentity, context.expectedProjectIdentity],
      ['launchAttempt.configIdentity', result.configIdentity, context.expectedConfigIdentity],
      ['launchAttempt.authIdentity', result.authIdentity, context.expectedAuthIdentity],
      ['launchAttempt.pluginPolicyIdentity', result.pluginPolicyIdentity, context.expectedPluginPolicyIdentity],
      ['launchAttempt.cacheIdentity', result.cacheIdentity, context.expectedCacheIdentity],
      ['launchAttempt.binaryIdentity', result.binaryIdentity, context.expectedBinaryIdentity],
      ['proof.attemptId', proof.attemptId, attempt.attemptId],
      ['proof.generation', proof.generation, attempt.generation],
      ['proof.currentGeneration', proof.generation, context.currentGeneration],
      ['proof.parent.sessionIdentity', proof.parent.sessionIdentity, attempt.parent.sessionIdentity],
      ['proof.parent.messageIdentity', proof.parent.messageIdentity, attempt.parent.messageIdentity],
      ['proof.providerId', proof.providerId, attempt.providerId],
      ['proof.modelId', proof.modelId, attempt.modelId],
      ['proof.nonceHash', proof.nonceHash, context.expectedNonceHash],
      ['proof.cacheUsed', proof.cacheUsed, false],
    ]
    for (const [field, actual, expected] of exact) if (actual !== expected) return correlationViolation(field)
    for (const [field, actual] of [
      ['launchAttempt.retainedHostIdentity', result.retainedHostIdentity],
      ['proof.retainedHostIdentity', proof.retainedHostIdentity],
    ] as const) {
      const expected = expectedIdentity.value
      if (actual.hostKeyIdentity !== expected.hostKeyIdentity
        || actual.processId !== expected.processId
        || actual.processStartedAtMs !== expected.processStartedAtMs
        || actual.profileScopeIdentity !== expected.profileScopeIdentity) return correlationViolation(field)
    }
    const required = new Set([...contextTools, ...attempt.requiredMcpTools])
    for (const tool of required) if (!proof.observedMcpTools.includes(tool)) return correlationViolation('proof.observedMcpTools')
    return Object.freeze({ ok: true, request, response })
  } catch {
    return correlationViolation('$')
  }
}

/** Whitelist encoder: unknown credentials, endpoints, raw nonces and diagnostics are not copied. */
export function encodeOpenCodeLaunchAttemptResponse(
  value: OpenCodeLaunchAttemptResponse,
): OpenCodeLaunchAttemptResponse {
  const decoded = decodeResponse(value)
  if (isDecodeFailure(decoded)) throw new TypeError(`Invalid OpenCode launch response: ${decoded.error.field}`)
  return decoded.value
}
export function serializeOpenCodeLaunchAttemptResponse(value: OpenCodeLaunchAttemptResponse): string {
  return JSON.stringify(encodeOpenCodeLaunchAttemptResponse(value))
}
export function decodeOpenCodeLaunchAttemptRequestJson(
  value: string,
): OpenCodeBridgeDecodeResult<DecodedOpenCodeLaunchAttemptRequest> {
  try { return decodeOpenCodeLaunchAttemptRequest(JSON.parse(value)) }
  catch { return { ok: false, error: { code: 'invalid_json', field: '$' } } }
}
export function decodeOpenCodeLaunchAttemptResponseJson(
  value: string,
): OpenCodeBridgeDecodeResult<DecodedOpenCodeLaunchAttemptResponse> {
  try { return decodeOpenCodeLaunchAttemptResponse(JSON.parse(value)) }
  catch { return { ok: false, error: { code: 'invalid_json', field: '$' } } }
}
