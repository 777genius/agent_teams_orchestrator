import { createHash } from 'node:crypto'
import { types as nodeTypes } from 'node:util'

import {
  isOpenCodeCanonicalProviderId,
  isOpenCodePassiveBinaryVersion,
  type OpenCodeBinaryStatus,
  type OpenCodeCatalogStatus,
  type OpenCodeConfiguredStatus,
  type OpenCodeExecutionStatus,
  type OpenCodeLastConnectedStatus,
  type OpenCodePassiveAuthority,
  type OpenCodePassiveIssueCode,
  type OpenCodePassiveObservation,
  type OpenCodePassiveProviderStatus,
  type OpenCodePassiveStatusV1,
} from './OpenCodePassiveStatusContract.js'
import {
  decodeOpenCodeRedactedSnapshotV1,
  OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES,
  type OpenCodeRedactedSnapshotV1,
} from './OpenCodeRedactedStatusSnapshot.js'

export type OpenCodePassiveReadFailure = Readonly<{ ok: false; kind: 'timeout' | 'cancelled' | 'transient' | 'invalid' }>
export type OpenCodePassiveReadSuccess<T> = Readonly<{ ok: true; value: T; observedAt: number; validUntil: number }>
export type OpenCodePassiveReadResult<T> = OpenCodePassiveReadSuccess<T> | OpenCodePassiveReadFailure
export type OpenCodePassiveReadHandoff<T> = (result: OpenCodePassiveReadResult<T>) => void

const ownedReadResults = new WeakSet<object>()

/** Trusted adapter boundary: copies inert data and brands the immutable core-owned result. */
export function createOpenCodePassiveReadSuccess<T>(value: T, observedAt: number, validUntil: number): OpenCodePassiveReadResult<T> {
  const copied = copyInertOwned(value, 0, { nodes: 0, descriptors: 0 })
  if (!copied.ok) return createOpenCodePassiveReadFailure('invalid')
  const result = Object.freeze({ ok: true as const, value: copied.value as T, observedAt, validUntil })
  ownedReadResults.add(result)
  return result
}
export function createOpenCodePassiveReadFailure(kind: OpenCodePassiveReadFailure['kind']): OpenCodePassiveReadFailure {
  const result = Object.freeze({ ok: false as const, kind })
  ownedReadResults.add(result)
  return result
}

export interface OpenCodeBinaryMetadataReadPort {
  read(signal: AbortSignal, handoff: OpenCodePassiveReadHandoff<{ present: boolean; version: string | null }>): void
}
export interface OpenCodeRedactedConfigMetadataReadPort {
  read(providerId: string, projectScope: `sha256:${string}`, signal: AbortSignal, handoff: OpenCodePassiveReadHandoff<{ configured: boolean }>): void
}
export interface OpenCodeRedactedAuthMetadataReadPort {
  read(providerId: string, projectScope: `sha256:${string}`, signal: AbortSignal, handoff: OpenCodePassiveReadHandoff<{ lastConnectedAt: number | null }>): void
}
export interface OpenCodeRedactedCatalogMetadataReadPort {
  read(providerId: string, projectScope: `sha256:${string}`, signal: AbortSignal, handoff: OpenCodePassiveReadHandoff<{ available: boolean }>): void
}
export interface OpenCodeRedactedExecutionMetadataReadPort {
  read(providerId: string, projectScope: `sha256:${string}`, signal: AbortSignal, handoff: OpenCodePassiveReadHandoff<{ verified: boolean }>): void
}
export interface OpenCodeRedactedSnapshotReadPort {
  read(projectScope: `sha256:${string}`, signal: AbortSignal, handoff: OpenCodePassiveReadHandoff<string | null>): void
}
export interface OpenCodeCanonicalProjectScopeReadPort {
  /** The echoed identity cryptographically binds the result to the requested input. Neither string is retained. */
  canonicalize(projectPath: string, signal: AbortSignal, handoff: OpenCodePassiveReadHandoff<OpenCodeCanonicalProjectScopeResult | null>): void
}
export type OpenCodeCanonicalProjectScopeResult = {
  canonicalPath: string
  inputPathIdentity: `sha256:${string}`
}
export interface OpenCodePassiveClock {
  now(): number
  schedule(callback: () => void, delayMs: number): { cancel(): void }
}
export type OpenCodePassiveStatusReaderPorts = {
  binaryMetadata: OpenCodeBinaryMetadataReadPort
  configMetadata: OpenCodeRedactedConfigMetadataReadPort
  authMetadata: OpenCodeRedactedAuthMetadataReadPort
  catalogMetadata: OpenCodeRedactedCatalogMetadataReadPort
  executionMetadata: OpenCodeRedactedExecutionMetadataReadPort
  snapshots: OpenCodeRedactedSnapshotReadPort
  projectScope: OpenCodeCanonicalProjectScopeReadPort
  clock: OpenCodePassiveClock
}
export type OpenCodePassiveStatusReadRequest = {
  projectPath: string
  providerIds: readonly string[]
  timeoutMs: number
  signal?: AbortSignal
}

type ProviderReadKind = 'configured' | 'lastConnected' | 'catalogAvailable' | 'executionVerified'
type Completion =
  | { target: 'binary'; result: OpenCodePassiveReadResult<{ present: boolean; version: string | null }> }
  | { target: 'snapshot'; expectedScope: `sha256:${string}`; result: OpenCodePassiveReadResult<OpenCodeRedactedSnapshotV1 | null> }
  | { target: 'provider'; expectedScope: `sha256:${string}`; providerId: string; kind: ProviderReadKind; result: OpenCodePassiveReadResult<unknown> }

/** Pure orchestration over explicitly read-only ports. No writer or active runtime surface is accepted. */
export class OpenCodePassiveStatusReader {
  readonly #ports: OpenCodePassiveStatusReaderPorts

  constructor(ports: OpenCodePassiveStatusReaderPorts) {
    this.#ports = ports
  }

  async read(request: OpenCodePassiveStatusReadRequest): Promise<OpenCodePassiveStatusV1> {
    // Capture structural function references once. Later mutation/replacement of a port
    // object cannot redirect an in-flight passive read.
    const ports = {
      binaryRead: this.#ports.binaryMetadata.read.bind(this.#ports.binaryMetadata),
      configRead: this.#ports.configMetadata.read.bind(this.#ports.configMetadata),
      authRead: this.#ports.authMetadata.read.bind(this.#ports.authMetadata),
      catalogRead: this.#ports.catalogMetadata.read.bind(this.#ports.catalogMetadata),
      executionRead: this.#ports.executionMetadata.read.bind(this.#ports.executionMetadata),
      snapshotRead: this.#ports.snapshots.read.bind(this.#ports.snapshots),
      canonicalize: this.#ports.projectScope.canonicalize.bind(this.#ports.projectScope),
      now: this.#ports.clock.now.bind(this.#ports.clock),
      schedule: this.#ports.clock.schedule.bind(this.#ports.clock),
    }
    // Snapshot each request field exactly once. Validation and all later work use
    // only these inert primitive copies, never the caller-owned request again.
    const timeoutMs = request.timeoutMs
    const projectPath = request.projectPath
    const requestedProviderIds = request.providerIds
    const requestSignal = request.signal
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('Passive status timeout must be a positive safe integer')
    if (typeof projectPath !== 'string' || projectPath.length === 0 || projectPath.length > 32_768 || projectPath.includes('\0')) throw new TypeError('Passive status project path must be a bounded string')
    const capturedProviderIds = captureProviderIds(requestedProviderIds)
    if (!capturedProviderIds) throw new TypeError('Passive status provider IDs must be a bounded inert array')
    const providerIds: string[] = []
    for (const providerId of capturedProviderIds) {
      if (!isOpenCodeCanonicalProviderId(providerId) || providerIds.includes(providerId)) throw new TypeError('Passive status provider IDs must be unique canonical identifiers')
      providerIds.push(providerId)
    }
    const requestedPathIdentity = opaqueInputPathIdentity(projectPath)
    const controller = new AbortController()
    let fenced = false
    let endReason: OpenCodePassiveIssueCode | null = null
    const completions: Completion[] = []
    let pending = 0
    let launching = true
    let clockInvalid = false
    let highWaterNow = 0
    const readNow = (): number | null => {
      let candidate: unknown
      try { candidate = ports.now() }
      catch { clockInvalid = true; return null }
      if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0) {
        clockInvalid = true
        return null
      }
      if (candidate < highWaterNow) {
        clockInvalid = true
        return null
      }
      highWaterNow = candidate
      return candidate
    }
    let resolveAll!: () => void
    const allDone = new Promise<void>(resolve => { resolveAll = resolve })
    let resolveEnd!: () => void
    const ended = new Promise<void>(resolve => { resolveEnd = resolve })
    const timer = ports.schedule(() => {
      if (fenced) return
      endReason = 'read_timeout'
      fenced = true
      controller.abort(endReason)
      resolveEnd()
    }, timeoutMs)
    const cancel = () => {
      if (fenced) return
      endReason = 'read_cancelled'
      fenced = true
      controller.abort(endReason)
      resolveEnd()
    }
    requestSignal?.addEventListener('abort', cancel, { once: true })
    if (requestSignal?.aborted) cancel()

    const track = <T, U>(invoke: (handoff: OpenCodePassiveReadHandoff<T>) => unknown, normalize: (result: unknown, settledAt: number) => OpenCodePassiveReadResult<U>, completion: ((result: OpenCodePassiveReadResult<U>) => Completion) | null, after?: (result: OpenCodePassiveReadResult<U>) => void) => {
      pending += 1
      let handedOff = false
      let invoking = true
      let captured: OpenCodePassiveReadResult<U> | null = null
      const commit = (result: OpenCodePassiveReadResult<U>) => {
        if (handedOff || fenced) return
        handedOff = true
        if (completion) completions.push(completion(result))
        after?.(result)
        pending -= 1
        if (!launching && pending === 0) resolveAll()
      }
      const handoff = (raw: OpenCodePassiveReadResult<T>) => {
        if (handedOff || captured || fenced) return
        // This is the settlement boundary: timestamp and normalization/copying
        // complete synchronously before producer control resumes.
        const handedOffAt = readNow()
        captured = handedOffAt === null ? createOpenCodePassiveReadFailure('invalid') : normalize(raw, handedOffAt)
        if (!invoking) commit(captured)
      }
      try {
        if (!controller.signal.aborted) {
          const returned = invoke(handoff)
          if (returned !== undefined) {
            if (returned === null || typeof returned !== 'object' || nodeTypes.isProxy(returned) || !nodeTypes.isPromise(returned)) {
              captured = createOpenCodePassiveReadFailure('invalid')
            } else {
              Promise.prototype.then.call(returned, undefined, () => {
                if (!captured && !handedOff) commit(createOpenCodePassiveReadFailure('transient'))
              })
            }
          }
          if (captured) commit(captured)
        }
        else handoff(createOpenCodePassiveReadFailure('cancelled'))
      } catch { captured = createOpenCodePassiveReadFailure('transient') }
      invoking = false
      if (captured && !handedOff) commit(captured)
    }

    if (!fenced) track(handoff => ports.binaryRead(controller.signal, handoff), normalizeBinaryResult, result => ({ target: 'binary', result }))
    let capturedScope: OpenCodePassiveReadResult<OpenCodeCanonicalProjectScopeResult | null> | null = null
    let capturedScopeIdentity: `sha256:${string}` | null = null
    if (!fenced) track(
      handoff => ports.canonicalize(projectPath, controller.signal, handoff),
      normalizeScopeResult,
      null,
      scopeResult => {
        capturedScope = scopeResult
        const scopeCheckedAt = readNow()
        if (scopeCheckedAt === null || !validBoundScope(scopeResult, requestedPathIdentity, scopeCheckedAt)) return
        const scope = opaqueProjectScope(scopeResult.value.canonicalPath)
        capturedScopeIdentity = scope
        track(handoff => ports.snapshotRead(scope, controller.signal, handoff), normalizeSnapshotResult, result => ({ target: 'snapshot', expectedScope: scope, result }))
        for (const providerId of providerIds) {
          track(handoff => ports.configRead(providerId, scope, controller.signal, handoff), (result, at) => normalizeBooleanResult(result, 'configured', at), result => ({ target: 'provider', expectedScope: scope, providerId, kind: 'configured', result }))
          track(handoff => ports.authRead(providerId, scope, controller.signal, handoff), normalizeConnectedResult, result => ({ target: 'provider', expectedScope: scope, providerId, kind: 'lastConnected', result }))
          track(handoff => ports.catalogRead(providerId, scope, controller.signal, handoff), (result, at) => normalizeBooleanResult(result, 'available', at), result => ({ target: 'provider', expectedScope: scope, providerId, kind: 'catalogAvailable', result }))
          track(handoff => ports.executionRead(providerId, scope, controller.signal, handoff), (result, at) => normalizeBooleanResult(result, 'verified', at), result => ({ target: 'provider', expectedScope: scope, providerId, kind: 'executionVerified', result }))
        }
      },
    )
    launching = false
    if (pending === 0) resolveAll()

    await Promise.race([allDone, ended])
    if (!fenced) fenced = true
    timer.cancel()
    requestSignal?.removeEventListener('abort', cancel)
    controller.abort('passive_status_complete')
    const finalNow = readNow()
    const completedAt = finalNow ?? highWaterNow

    let projectScope: `sha256:${string}` | null = null
    const scopeResult = capturedScope
    if (!clockInvalid && validBoundScope(scopeResult, requestedPathIdentity, completedAt) && capturedScopeIdentity !== null) projectScope = capturedScopeIdentity

    const snapshot = projectScope === null ? null : decodeSnapshot(completions, projectScope, completedAt)
    const binaryFallbackIssue = endReason ?? 'read_failed'
    const projectFallbackIssue = projectScope === null ? 'scope_unavailable' : endReason ?? 'read_failed'
    const binaryCompletion = clockInvalid ? undefined : completions.find(item => item.target === 'binary') as Extract<Completion, { target: 'binary' }> | undefined
    const binary = resolveBinary(binaryCompletion?.result, snapshot?.binary, completedAt, binaryFallbackIssue)
    const providers = providerIds.map(providerId => {
      const history = snapshot?.providers.find(provider => provider.providerId === providerId)
      return resolveProvider(providerId, projectScope === null || clockInvalid ? [] : completions, history, completedAt, projectFallbackIssue)
    })
    return freezePassiveStatus({ contractVersion: 1, projectScope, binary, providers, authorization: 'unknown', launchReadiness: 'not_authorized', completedAt })
  }
}

function captureProviderIds(value: unknown): unknown[] | null {
  if (value === null || typeof value !== 'object' || nodeTypes.isProxy(value) || !Array.isArray(value)) return null
  try {
    if (Reflect.getPrototypeOf(value) !== Array.prototype) return null
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length')
    if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) return null
    const length = lengthDescriptor.value as number
    if (length < 0 || length > 32) return null
    const result: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !('value' in descriptor)) return null
      result.push(descriptor.value)
    }
    return result
  } catch { return null }
}

function opaqueProjectScope(canonicalPath: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update('opencode-project-scope-v1\0').update(canonicalPath).digest('hex')}`
}
export function openCodePassiveInputPathIdentity(projectPath: string): `sha256:${string}` {
  return opaqueInputPathIdentity(projectPath)
}
function opaqueInputPathIdentity(projectPath: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update('opencode-project-input-v1\0').update(projectPath).digest('hex')}`
}

function normalizeFailure(value: unknown): OpenCodePassiveReadFailure | null {
  if (value === null || typeof value !== 'object' || !ownedReadResults.has(value)) return null
  const record = exactDataRecord(value, ['ok', 'kind'])
  if (!record || record.ok !== false || !['timeout', 'cancelled', 'transient', 'invalid'].includes(record.kind as string)) return null
  return { ok: false, kind: record.kind as OpenCodePassiveReadFailure['kind'] }
}
function normalizedSuccess<T>(value: unknown, settledAt: number, normalizeValue: (value: unknown) => T | null): OpenCodePassiveReadResult<T> {
  if (value === null || typeof value !== 'object' || !ownedReadResults.has(value)) return { ok: false, kind: 'invalid' }
  const record = exactDataRecord(value, ['ok', 'value', 'observedAt', 'validUntil'])
  if (!record || record.ok !== true) return normalizeFailure(value) ?? { ok: false, kind: 'invalid' }
  const observedAt = record.observedAt
  const validUntil = record.validUntil
  const copiedValue = normalizeValue(record.value)
  if ((copiedValue === null && record.value !== null) || !Number.isSafeInteger(observedAt) || (observedAt as number) < 0 || (observedAt as number) > settledAt || !Number.isSafeInteger(validUntil) || (validUntil as number) < (observedAt as number)) return { ok: false, kind: 'invalid' }
  return { ok: true, value: copiedValue as T, observedAt: observedAt as number, validUntil: validUntil as number }
}
function normalizeBinaryResult(value: unknown, settledAt: number): OpenCodePassiveReadResult<{ present: boolean; version: string | null }> {
  return normalizedSuccess(value, settledAt, candidate => {
    const record = exactDataRecord(candidate, ['present', 'version'])
    if (!record || typeof record.present !== 'boolean' || (record.present && record.version !== null && (typeof record.version !== 'string' || !validVersion(record.version)))) return null
    return { present: record.present, version: record.present ? record.version as string | null : null }
  })
}
function normalizeBooleanResult(value: unknown, field: string, settledAt: number): OpenCodePassiveReadResult<Record<string, boolean>> {
  return normalizedSuccess(value, settledAt, candidate => {
    const record = exactDataRecord(candidate, [field])
    return record && typeof record[field] === 'boolean' ? { [field]: record[field] as boolean } : null
  })
}
function normalizeConnectedResult(value: unknown, settledAt: number): OpenCodePassiveReadResult<{ lastConnectedAt: number | null }> {
  return normalizedSuccess(value, settledAt, candidate => {
    const record = exactDataRecord(candidate, ['lastConnectedAt'])
    const connectedAt = record?.lastConnectedAt
    return connectedAt === null || (Number.isSafeInteger(connectedAt) && (connectedAt as number) >= 0)
      ? { lastConnectedAt: connectedAt as number | null }
      : null
  })
}
function normalizeScopeResult(value: unknown, settledAt: number): OpenCodePassiveReadResult<OpenCodeCanonicalProjectScopeResult | null> {
  return normalizedSuccess(value, settledAt, candidate => {
    if (candidate === null) return null
    const record = exactDataRecord(candidate, ['canonicalPath', 'inputPathIdentity'])
    if (!record || typeof record.canonicalPath !== 'string' || typeof record.inputPathIdentity !== 'string') return null
    return { canonicalPath: record.canonicalPath, inputPathIdentity: record.inputPathIdentity as `sha256:${string}` }
  })
}
function normalizeSnapshotResult(value: unknown, settledAt: number): OpenCodePassiveReadResult<OpenCodeRedactedSnapshotV1 | null> {
  return normalizedSuccess(value, settledAt, candidate => {
    if (candidate === null) return null
    if (typeof candidate !== 'string' || candidate.length > OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES) return null
    const decoded = decodeOpenCodeRedactedSnapshotV1(candidate)
    return decoded.ok && decoded.value.capturedAt <= settledAt && snapshotTimesAreConservative(decoded.value, settledAt) ? decoded.value : null
  })
}

function decodeSnapshot(completions: Completion[], scope: `sha256:${string}`, now: number): OpenCodeRedactedSnapshotV1 | null {
  const completion = completions.find(item => item.target === 'snapshot' && item.expectedScope === scope) as Extract<Completion, { target: 'snapshot' }> | undefined
  if (!completion?.result.ok || completion.result.value === null || !validProducerTimes(completion.result, now)) return null
  const snapshot = completion.result.value
  if (snapshot.projectScope !== scope || snapshot.capturedAt > now || !snapshotTimesAreConservative(snapshot, now)) return null
  return snapshot
}

function resolveBinary(result: OpenCodePassiveReadResult<{ present: boolean; version: string | null }> | undefined, history: OpenCodePassiveObservation<OpenCodeBinaryStatus> | undefined, now: number, fallback: OpenCodePassiveIssueCode): OpenCodePassiveObservation<OpenCodeBinaryStatus> {
  const value = result?.ok ? exactDataRecord(result.value, ['present', 'version']) : null
  if (result?.ok && validProducerTimes(result, now) && value && typeof value.present === 'boolean' && (!value.present || value.version === null || (typeof value.version === 'string' && validVersion(value.version)))) {
    return authoritative({ presence: value.present ? 'present' : 'absent', version: value.present ? value.version as string | null : null }, 'binary_metadata', result, now)
  }
  return degraded(history, { presence: 'unknown', version: null }, resultIssue(result, fallback))
}

function resolveProvider(providerId: string, completions: Completion[], history: OpenCodePassiveProviderStatus | undefined, now: number, fallback: OpenCodePassiveIssueCode): OpenCodePassiveProviderStatus {
  const firstProvider = completions.find(item => item.target === 'provider' && item.providerId === providerId) as Extract<Completion, { target: 'provider' }> | undefined
  const expectedScope = firstProvider?.expectedScope
  const find = (kind: ProviderReadKind) => (completions.find(item => item.target === 'provider' && item.expectedScope === expectedScope && item.providerId === providerId && item.kind === kind) as Extract<Completion, { target: 'provider' }> | undefined)?.result
  const configured = find('configured')
  const connected = find('lastConnected')
  const catalog = find('catalogAvailable')
  const execution = find('executionVerified')
  return {
    providerId,
    configured: validBooleanResult(configured, 'configured', now)
      ? authoritative(configured.value.configured ? 'configured' : 'not_configured', 'config_metadata', configured, now)
      : degraded(history?.configured, 'unknown', resultIssue(configured, fallback)),
    lastConnected: validConnectedResult(connected, now)
      ? authoritative(connected.value.lastConnectedAt === null ? { state: 'not_connected' } : { state: 'connected', at: connected.value.lastConnectedAt }, 'auth_metadata', connected, now)
      : degraded(history?.lastConnected, { state: 'unknown' }, resultIssue(connected, fallback)),
    catalogAvailable: validBooleanResult(catalog, 'available', now)
      ? authoritative(catalog.value.available ? 'available' : 'unavailable', 'catalog_snapshot', catalog, now)
      : degraded(history?.catalogAvailable, 'unknown', resultIssue(catalog, fallback)),
    executionVerified: validBooleanResult(execution, 'verified', now)
      ? authoritative(execution.value.verified ? 'verified' : 'rejected', 'execution_snapshot', execution, now)
      : degraded(history?.executionVerified, 'unknown', resultIssue(execution, fallback)),
  }
}

function authoritative<T>(value: T, authority: OpenCodePassiveAuthority, result: OpenCodePassiveReadSuccess<unknown>, now: number): OpenCodePassiveObservation<T> {
  const expired = result.validUntil < now
  return { value, authority, freshness: expired ? 'stale' : 'fresh', condition: expired ? 'degraded' : 'normal', observedAt: result.observedAt, validUntil: result.validUntil, issueCode: expired ? 'expired' : 'none' }
}
function degraded<T>(history: OpenCodePassiveObservation<T> | undefined, unknownValue: T, issueCode: OpenCodePassiveIssueCode): OpenCodePassiveObservation<T> {
  const mayUseHistory = issueCode === 'read_timeout' || issueCode === 'read_failed' || issueCode === 'read_cancelled'
  return history && mayUseHistory
    ? {
        ...history,
        freshness: 'stale',
        condition: 'degraded',
        issueCode: history.freshness === 'stale' && history.condition === 'degraded' && history.issueCode !== 'none'
          ? history.issueCode
          : issueCode,
      }
    : { value: unknownValue, authority: 'none', freshness: 'unknown', condition: 'degraded', observedAt: null, validUntil: null, issueCode }
}
function resultIssue(result: OpenCodePassiveReadResult<unknown> | undefined, fallback: OpenCodePassiveIssueCode): OpenCodePassiveIssueCode {
  if (!result) return fallback
  if (result.ok === true) return 'invalid_payload'
  const failure = result as OpenCodePassiveReadFailure
  return failure.kind === 'timeout' ? 'read_timeout' : failure.kind === 'cancelled' ? 'read_cancelled' : failure.kind === 'invalid' ? 'invalid_payload' : 'read_failed'
}
function validProducerTimes(result: OpenCodePassiveReadSuccess<unknown>, now: number): boolean {
  return Number.isSafeInteger(result.observedAt) && result.observedAt >= 0 && result.observedAt <= now && Number.isSafeInteger(result.validUntil) && result.validUntil >= result.observedAt
}
function validFreshScope(result: OpenCodePassiveReadSuccess<unknown>, now: number): boolean {
  return validProducerTimes(result, now) && result.validUntil >= now
}
function validBoundScope(
  result: OpenCodePassiveReadResult<OpenCodeCanonicalProjectScopeResult | null> | null,
  requestedPathIdentity: `sha256:${string}`,
  now: number,
): result is OpenCodePassiveReadSuccess<OpenCodeCanonicalProjectScopeResult> {
  return !!result?.ok && result.value !== null && validFreshScope(result, now)
    && exactDataRecord(result.value, ['canonicalPath', 'inputPathIdentity']) !== null
    && result.value.inputPathIdentity === requestedPathIdentity
    && typeof result.value.canonicalPath === 'string' && result.value.canonicalPath.length > 0 && result.value.canonicalPath.length <= 32_768
    && !/[\u0000-\u001f\u007f]/.test(result.value.canonicalPath)
}
function validBooleanResult(result: OpenCodePassiveReadResult<unknown> | undefined, field: string, now: number): result is OpenCodePassiveReadSuccess<Record<string, boolean>> {
  if (!result?.ok || !validProducerTimes(result, now)) return false
  const value = exactDataRecord(result.value, [field])
  return value !== null && typeof value[field] === 'boolean'
}
function validConnectedResult(result: OpenCodePassiveReadResult<unknown> | undefined, now: number): result is OpenCodePassiveReadSuccess<{ lastConnectedAt: number | null }> {
  if (!result?.ok || !validProducerTimes(result, now)) return false
  const record = exactDataRecord(result.value, ['lastConnectedAt'])
  if (!record) return false
  const value = record.lastConnectedAt
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= result.observedAt)
}
function exactDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const owned: Record<string, unknown> = Object.create(null)
    for (const reserved of INERT_RESERVED_FIELDS) {
      if (Object.getOwnPropertyDescriptor(value, reserved)) return null
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) return null
      owned[key] = descriptor.value
    }
    return owned
  } catch { return null }
}
function validVersion(value: string): boolean { return isOpenCodePassiveBinaryVersion(value) }
function snapshotTimesAreConservative(snapshot: OpenCodeRedactedSnapshotV1, now: number): boolean {
  const observations: OpenCodePassiveObservation<unknown>[] = [snapshot.binary]
  for (const provider of snapshot.providers) observations.push(provider.configured, provider.lastConnected, provider.catalogAvailable, provider.executionVerified)
  return observations.every(observation => observation.observedAt === null || observation.observedAt <= now)
    && snapshot.providers.every(provider => provider.lastConnected.value.state !== 'connected'
      || provider.lastConnected.observedAt === null
      || provider.lastConnected.value.at <= provider.lastConnected.observedAt)
}

function freezePassiveStatus(status: OpenCodePassiveStatusV1): OpenCodePassiveStatusV1 {
  const freezeObservation = (observation: OpenCodePassiveObservation<unknown>) => {
    if (observation.value !== null && typeof observation.value === 'object') Object.freeze(observation.value)
    Object.freeze(observation)
  }
  freezeObservation(status.binary)
  for (const provider of status.providers) {
    freezeObservation(provider.configured)
    freezeObservation(provider.lastConnected)
    freezeObservation(provider.catalogAvailable)
    freezeObservation(provider.executionVerified)
    Object.freeze(provider)
  }
  Object.freeze(status.providers)
  return Object.freeze(status)
}

type OwnedCopy = { ok: true; value: unknown } | { ok: false }
type OwnedCopyBudget = { nodes: number; descriptors: number }
const INERT_MAX_DEPTH = 8
const INERT_MAX_NODES = 1_024
const INERT_MAX_DESCRIPTORS = 1_024
const INERT_RESERVED_FIELDS = ['__proto__', 'prototype', 'constructor', 'toJSON'] as const
const INERT_RECORD_SCHEMAS = [
  ['present', 'version'],
  ['configured'],
  ['lastConnectedAt'],
  ['available'],
  ['verified'],
  ['canonicalPath', 'inputPathIdentity'],
] as const

function copyInertOwned(value: unknown, depth: number, budget: OwnedCopyBudget): OwnedCopy {
  budget.nodes += 1
  if (budget.nodes > INERT_MAX_NODES) return { ok: false }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return { ok: true, value }
  if (typeof value === 'number') return Number.isFinite(value) ? { ok: true, value } : { ok: false }
  if (typeof value !== 'object' || depth > INERT_MAX_DEPTH || nodeTypes.isProxy(value)) return { ok: false }
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return { ok: false }
      budget.descriptors += 1
      if (budget.descriptors > INERT_MAX_DESCRIPTORS) return { ok: false }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
      if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) return { ok: false }
      const length = lengthDescriptor.value as number
      // The size check deliberately precedes every index descriptor lookup.
      if (length < 0 || length > 512 || budget.nodes + length > INERT_MAX_NODES || budget.descriptors + length > INERT_MAX_DESCRIPTORS) return { ok: false }
      const result: unknown[] = []
      for (let index = 0; index < length; index += 1) {
        budget.descriptors += 1
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !('value' in descriptor)) return { ok: false }
        const copied = copyInertOwned(descriptor.value, depth + 1, budget)
        if (!copied.ok) return copied
        result.push(copied.value)
      }
      return { ok: true, value: Object.freeze(result) }
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return { ok: false }
    for (const reserved of INERT_RESERVED_FIELDS) {
      budget.descriptors += 1
      if (budget.descriptors > INERT_MAX_DESCRIPTORS || Object.getOwnPropertyDescriptor(value, reserved)) return { ok: false }
    }
    let fields: readonly string[] | null = null
    for (const schema of INERT_RECORD_SCHEMAS) {
      budget.descriptors += 1
      if (budget.descriptors > INERT_MAX_DESCRIPTORS) return { ok: false }
      if (Object.getOwnPropertyDescriptor(value, schema[0])) {
        fields = schema
        break
      }
    }
    if (!fields) return { ok: false }
    const result: Record<string, unknown> = Object.create(null)
    for (const key of fields) {
      budget.descriptors += 1
      if (budget.descriptors > INERT_MAX_DESCRIPTORS) return { ok: false }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) return { ok: false }
      const copied = copyInertOwned(descriptor.value, depth + 1, budget)
      if (!copied.ok) return copied
      Object.defineProperty(result, key, { value: copied.value, enumerable: true, configurable: false, writable: false })
    }
    return { ok: true, value: Object.freeze(result) }
  } catch { return { ok: false } }
}
