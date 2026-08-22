import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

import { OpenCodeCatalogAuthorityClient,
  OpenCodeCatalogCommitUncertainError } from './OpenCodeCatalogAuthorityClient.js'
import type { OpenCodeCatalogAuthorityIdentity } from './OpenCodeCatalogAuthorityProtocol.js'
import { cleanupOpenCodeCatalogProfile,
  heartbeatOpenCodeCatalogProfile } from './OpenCodeCatalogProfileJanitor.js'
import { decodeOpenCodeLegacyCatalogEnvelope } from './OpenCodeCatalogLegacyCodec.js'
import { normalizeOpenCodeScopedProviderCatalogResponse } from './OpenCodeLiveProviderNormalizer.js'
import {
  createOpenCodeCatalogRecordId,
  type OpenCodeCatalogRecordIdentityPayload,
  type OpenCodeScopedProviderCatalog,
} from './OpenCodeProviderCatalogContract.js'
import { canonicalizeOpenCodeProviderId } from './OpenCodeProviderIdentity.js'
import { canonicalizeOpenCodePassiveProjectPath } from './OpenCodePassiveStatusProductionReader.js'
import {
  prepareOpenCodeProviderCatalogProductionProfile,
  type OpenCodeProviderCatalogProductionProfileManager,
} from './OpenCodeProviderCatalogProduction.js'
import {
  finalizeOpenCodeScopedProfileAuth,
  rollbackOpenCodeScopedProfileAuth,
  rollbackOpenCodeScopedProfileAuthSignal,
} from './OpenCodeScopedProfileAuthPublication.js'

import type { OpenCodeScopedPreparedProfile } from './types.js'

const DEFAULT_TTL_MS = 30_000
const DEFAULT_MAX_STALE_MS = 5 * 60_000
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 2_147_483_647
const MAX_EPOCH_MS = 8_640_000_000_000_000
const MAX_ENVELOPE_BYTES = 2 * 1024 * 1024
const FIXED_FAILURE = 'OpenCode provider catalog is temporarily unavailable.'

export type OpenCodeProviderCatalogLoadInput = Readonly<{
  providerId: string
  projectPath?: string | null
  abortSignal?: AbortSignal
}>

export type OpenCodeProviderCatalogLoadResult = Readonly<{
  catalog: OpenCodeScopedProviderCatalog
  catalogEvidence: OpenCodeCatalogPublicationEvidence
  catalogObservedAt: number
  catalogExpiresAt: number
  catalogProvenance: 'fresh-live' | 'cache-hit' | 'bounded-stale'
  profileRootPath: string
  projectPath: string
  diagnostics: readonly string[]
}>

export type OpenCodeCatalogPublicationEvidence = Readonly<{
  providerId: string
  requestGeneration: number
  startedAt: number
  attemptIdentity: `sha256:${string}`
  binaryFingerprint: `sha256:${string}`
  configFingerprint: `sha256:${string}`
  authFingerprint: `sha256:${string}`
}>

export type OpenCodeProviderCatalogPort = {
  loadCatalog(input: OpenCodeProviderCatalogLoadInput): Promise<OpenCodeProviderCatalogLoadResult>
}

type CatalogHost = Readonly<{ hostKey: string; baseUrl: string }>

type AuthorityAttempt = Pick<OpenCodeCatalogAuthorityClient,
  'beginAttempt' | 'bindAndRead' | 'finalize' | 'close' | 'kill' | 'committed'>

/**
 * The injected persistence/allocation hooks are retained only as deterministic
 * fake boundaries. Production omits them and therefore always uses one native
 * attempt authority from BEGIN_ATTEMPT through FINALIZE.
 */
export type OpenCodeProviderCatalogServiceDeps = {
  profileManager?: OpenCodeProviderCatalogProductionProfileManager
  prepareProfile?: (input: {
    purpose: 'provider-catalog'; providerId: string; runtimeInstanceId: string
    projectPath?: string | null; abortSignal?: AbortSignal
  }) => Promise<OpenCodeScopedPreparedProfile>
  finalizePreparedProfile?: (profile: OpenCodeScopedPreparedProfile) => Promise<void>
  rollbackPreparedProfile?: (profile: OpenCodeScopedPreparedProfile) => Promise<void>
  ensureHost?: (input: { preparedProfile: OpenCodeScopedPreparedProfile
    expectedHostKey: string; abortSignal?: AbortSignal }) => Promise<CatalogHost>
  releaseHost?: (hostKey: string, controls?: Readonly<{
    abortSignal: AbortSignal; deadline: number
  }>) => Promise<void>
  fetchProviderCatalog?: (input: {
    baseUrl: string; providerId: string; abortSignal: AbortSignal
  }) => Promise<unknown>
  readPersisted?: (cacheKey: string) => Promise<unknown | null>
  writePersisted?: (cacheKey: string, value: unknown) => Promise<void>
  deletePersisted?: (cacheKey: string) => Promise<void>
  now?: () => number
  timeoutMs?: number
  ttlMs?: number
  maxStaleMs?: number
  maxEntries?: number
  canonicalizeProjectPath?: (projectPath: string, signal: AbortSignal) => Promise<string>
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  beforeFinalPublication?: () => void | Promise<void>
  beforeVisibilitySync?: () => void | Promise<void>
  beforeStageDirectorySync?: () => void | Promise<void>
  afterCommitVisibility?: () => void | Promise<void>
  allocateAttempt?: (scope: string, startedAt: number) => Readonly<{
    requestGeneration: number; attemptIdentity: `sha256:${string}`
  }> | Promise<Readonly<{ requestGeneration: number; attemptIdentity: `sha256:${string}` }>>
  authorityFactory?: (input: Readonly<{ deadline: number; signal: AbortSignal }>) => AuthorityAttempt
}

type CacheIdentity = Readonly<{
  projectPath: string
  providerId: string
  binaryFingerprint: string
  managedConfigFingerprint: string
  selectedAuthBaselineFingerprint: string
}>

type Persisted = Readonly<{
  schema: 'opencode-provider-catalog-cache-v44307'
  identity: CacheIdentity
  authorityIdentity: OpenCodeCatalogAuthorityIdentity
  catalog: OpenCodeScopedProviderCatalog
  catalogEvidence: OpenCodeCatalogPublicationEvidence
  catalogObservedAt: number
  catalogExpiresAt: number
  envelopeHash: `sha256:${string}`
}>

export class OpenCodeProviderCatalogUnavailableError extends Error {
  readonly code = 'OPENCODE_PROVIDER_CATALOG_UNAVAILABLE' as const
  constructor(readonly outcome: 'superseded' | 'transient' = 'transient') {
    super(FIXED_FAILURE)
    this.name = 'OpenCodeProviderCatalogUnavailableError'
  }
}

function failure(outcome: 'superseded' | 'transient' = 'transient') {
  return new OpenCodeProviderCatalogUnavailableError(outcome)
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function fingerprint(domain: string, value: string): `sha256:${string}` {
  return `sha256:${hash(`${domain}\0${value}`)}`
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function options(deps: OpenCodeProviderCatalogServiceDeps) {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS
  const maxStaleMs = deps.maxStaleMs ?? DEFAULT_MAX_STALE_MS
  if (!integer(timeoutMs, 1) || timeoutMs > MAX_TIMEOUT_MS || !integer(ttlMs)
    || !integer(maxStaleMs) || maxStaleMs < ttlMs) throw failure()
  return { timeoutMs, ttlMs, maxStaleMs }
}

function snapshotInput(value: OpenCodeProviderCatalogLoadInput): OpenCodeProviderCatalogLoadInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.providerId !== 'string'
    || (value.projectPath !== undefined && value.projectPath !== null
      && typeof value.projectPath !== 'string')
    || (value.abortSignal !== undefined && !(value.abortSignal instanceof AbortSignal))) throw failure()
  return Object.freeze({ providerId: value.providerId, projectPath: value.projectPath,
    abortSignal: value.abortSignal })
}

function profileIdentity(profile: OpenCodeScopedPreparedProfile, providerId: string,
  projectPath: string): CacheIdentity {
  const value = profile as unknown as Record<string, unknown>
  const identity = {
    projectPath,
    providerId,
    binaryFingerprint: value.binaryFingerprint,
    managedConfigFingerprint: value.managedConfigFingerprint,
    selectedAuthBaselineFingerprint: value.selectedAuthBaselineFingerprint,
  }
  if (typeof identity.binaryFingerprint !== 'string' || !identity.binaryFingerprint
    || typeof identity.managedConfigFingerprint !== 'string' || !identity.managedConfigFingerprint
    || typeof identity.selectedAuthBaselineFingerprint !== 'string'
    || !identity.selectedAuthBaselineFingerprint) throw failure()
  return Object.freeze(identity as CacheIdentity)
}

function authorityIdentity(identity: CacheIdentity): OpenCodeCatalogAuthorityIdentity {
  return Object.freeze({
    project_path: identity.projectPath,
    provider_id: identity.providerId,
    config_fingerprint: identity.managedConfigFingerprint,
    auth_fingerprint: identity.selectedAuthBaselineFingerprint,
    binary_fingerprint: identity.binaryFingerprint,
    // Preserve the exact 44305/44306 cache-key encoding so bounded native
    // migration can identify the eligible previous catalog without guessing.
    cache_key: hash(JSON.stringify([identity.projectPath, identity.providerId,
      identity.binaryFingerprint, identity.managedConfigFingerprint,
      identity.selectedAuthBaselineFingerprint])),
  })
}

function evidence(identity: CacheIdentity, generation: number, startedAt: number,
  attemptIdentity: `sha256:${string}`): OpenCodeCatalogPublicationEvidence {
  return Object.freeze({ providerId: identity.providerId, requestGeneration: generation,
    startedAt, attemptIdentity,
    binaryFingerprint: fingerprint('opencode-catalog-binary-v1', identity.binaryFingerprint),
    configFingerprint: fingerprint('opencode-catalog-config-v1', identity.managedConfigFingerprint),
    authFingerprint: fingerprint('opencode-catalog-auth-v1', identity.selectedAuthBaselineFingerprint) })
}

function payload(catalog: OpenCodeScopedProviderCatalog): OpenCodeCatalogRecordIdentityPayload {
  return { providerId: catalog.providerId, source: catalog.source, endpoint: catalog.endpoint,
    generation: catalog.generation, freshness: catalog.freshness, connected: catalog.connected,
    models: catalog.models }
}

function refresh(catalog: OpenCodeScopedProviderCatalog, now: number, ttlMs: number,
  maxStaleMs: number): OpenCodeScopedProviderCatalog | null {
  const observed = catalog.freshness.observedAtMs
  const age = now - observed
  if (!integer(observed) || age < 0 || age > maxStaleMs) return null
  const freshness = Object.freeze({ observedAtMs: observed, ageMs: age,
    maxStaleMs, state: age <= ttlMs ? 'fresh' as const : 'bounded-stale' as const })
  const next = { ...catalog, freshness }
  return Object.freeze({ ...next, recordId: createOpenCodeCatalogRecordId(payload(next)) })
}

function persisted(identity: CacheIdentity, catalog: OpenCodeScopedProviderCatalog,
  catalogEvidence: OpenCodeCatalogPublicationEvidence, observedAt: number, expiresAt: number): Persisted {
  const material = `${JSON.stringify(identity)}\0${catalog.recordId}\0${JSON.stringify(catalogEvidence)}\0${observedAt}\0${expiresAt}`
  return Object.freeze({ schema: 'opencode-provider-catalog-cache-v44307', identity, catalog,
    authorityIdentity: authorityIdentity(identity),
    catalogEvidence, catalogObservedAt: observedAt, catalogExpiresAt: expiresAt,
    envelopeHash: `sha256:${hash(material)}` })
}

function decodePersisted(raw: unknown, identity: CacheIdentity): Persisted | null {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const value = raw as Partial<Persisted>
    if (value.schema !== 'opencode-provider-catalog-cache-v44307'
      || JSON.stringify(value.identity) !== JSON.stringify(identity)
      || JSON.stringify(value.authorityIdentity) !== JSON.stringify(authorityIdentity(identity))
      || !value.catalog || value.catalog.providerId !== identity.providerId
      || !value.catalogEvidence || value.catalogEvidence.providerId !== identity.providerId
      || !integer(value.catalogObservedAt) || !integer(value.catalogExpiresAt)
      || value.catalogExpiresAt! < value.catalogObservedAt!
      || createOpenCodeCatalogRecordId(payload(value.catalog)) !== value.catalog.recordId) return null
    const material = `${JSON.stringify(identity)}\0${value.catalog.recordId}\0${JSON.stringify(value.catalogEvidence)}\0${value.catalogObservedAt}\0${value.catalogExpiresAt}`
    if (value.envelopeHash !== `sha256:${hash(material)}`) return null
    return value as Persisted
  } catch { return null }
}

function decodeLegacyPersisted(raw: unknown, identity: CacheIdentity): Persisted | null {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const value = raw as Record<string, unknown>
    const fingerprints = value.fingerprints as Record<string, unknown> | null
    const catalog = value.catalog as OpenCodeScopedProviderCatalog | null
    const priorEvidence = value.catalogEvidence as OpenCodeCatalogPublicationEvidence | null
    const observed = value.catalogObservedAt
    const expires = value.catalogExpiresAt
    const key = authorityIdentity(identity).cache_key
    if (value.schema !== 'opencode-provider-catalog-cache-v4' || value.identityHash !== `sha256:${key}`
      || !fingerprints || fingerprints.providerId !== identity.providerId
      || fingerprints.binaryFingerprint !== identity.binaryFingerprint
      || fingerprints.managedConfigFingerprint !== identity.managedConfigFingerprint
      || fingerprints.selectedAuthBaselineFingerprint !== identity.selectedAuthBaselineFingerprint
      || !catalog || catalog.providerId !== identity.providerId || !priorEvidence
      || priorEvidence.providerId !== identity.providerId
      || priorEvidence.binaryFingerprint !== fingerprint('opencode-catalog-binary-v1', identity.binaryFingerprint)
      || priorEvidence.configFingerprint !== fingerprint('opencode-catalog-config-v1', identity.managedConfigFingerprint)
      || priorEvidence.authFingerprint !== fingerprint('opencode-catalog-auth-v1', identity.selectedAuthBaselineFingerprint)
      || !integer(observed) || !integer(expires) || expires < observed
      || createOpenCodeCatalogRecordId(payload(catalog)) !== catalog.recordId) return null
    const expectedHash = `sha256:${hash(`sha256:${key}\0${catalog.recordId}\0${JSON.stringify(priorEvidence)}\0${observed}\0${expires}`)}`
    if (value.envelopeHash !== expectedHash) return null
    return persisted(identity, catalog, priorEvidence, observed, expires)
  } catch { return null }
}

function profileRoot(profile: OpenCodeScopedPreparedProfile): string {
  const value = (profile as unknown as Record<string, unknown>).profileRootPath
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw failure()
  return value
}

function scheduleProfileCleanup(profile: OpenCodeScopedPreparedProfile): void {
  // Cleanup is deliberately detached. In particular, even resolving the
  // manifest root must not be able to reinterpret an acknowledged COMMIT.
  try {
    const root = profileRoot(profile)
    void cleanupOpenCodeCatalogProfile(root).catch(() => undefined)
  } catch { /* malformed/replaced cleanup state is janitor input, not publication state */ }
}

function projectOf(profile: OpenCodeScopedPreparedProfile, expected: string): string {
  const value = (profile as unknown as Record<string, unknown>).projectPath
  if (value !== expected) throw failure()
  return expected
}

const fakeAuthorityHighWater = new WeakMap<NonNullable<OpenCodeProviderCatalogServiceDeps['allocateAttempt']>, number>()

class FakeAuthority implements AuthorityAttempt {
  #allocation: { requestGeneration: number; attemptIdentity: `sha256:${string}` } | null = null
  #identity: OpenCodeCatalogAuthorityIdentity | null = null
  #committed = false
  constructor(private readonly deps: OpenCodeProviderCatalogServiceDeps) {}
  get committed() { return this.#committed }
  async beginAttempt(startedAt: number, scopeHash: string) {
    if (!this.deps.allocateAttempt) throw failure()
    this.#allocation = await this.deps.allocateAttempt(scopeHash, startedAt)
    const current = fakeAuthorityHighWater.get(this.deps.allocateAttempt) ?? 0
    if (this.#allocation.requestGeneration > current) {
      fakeAuthorityHighWater.set(this.deps.allocateAttempt, this.#allocation.requestGeneration)
    }
    return { generation: this.#allocation.requestGeneration,
      attemptIdentity: this.#allocation.attemptIdentity }
  }
  async bindAndRead(generation: number, attemptIdentity: `sha256:${string}`,
    identity: OpenCodeCatalogAuthorityIdentity) {
    if (!this.#allocation || generation !== this.#allocation.requestGeneration
      || attemptIdentity !== this.#allocation.attemptIdentity) throw failure('superseded')
    this.#identity = identity
    if (!this.deps.readPersisted) return { previousEnvelope: null }
    const raw = await this.deps.readPersisted(`${identity.cache_key}.authority-v44307`)
    return { previousEnvelope: raw === null ? null : JSON.stringify(raw) }
  }
  async finalize(generation: number, attemptIdentity: `sha256:${string}`,
    identity: OpenCodeCatalogAuthorityIdentity, envelopeJson: string) {
    if (!this.#allocation || !this.#identity || generation !== this.#allocation.requestGeneration
      || attemptIdentity !== this.#allocation.attemptIdentity
      || JSON.stringify(identity) !== JSON.stringify(this.#identity) || !this.deps.writePersisted) {
      throw failure('superseded')
    }
    if (this.deps.allocateAttempt
      && fakeAuthorityHighWater.get(this.deps.allocateAttempt) !== generation) throw failure('superseded')
    await this.deps.beforeFinalPublication?.()
    await this.deps.beforeVisibilitySync?.()
    await this.deps.writePersisted(`${identity.cache_key}.authority-v44307`, JSON.parse(envelopeJson))
    this.#committed = true
    void Promise.resolve().then(() => this.deps.afterCommitVisibility?.()).catch(() => undefined)
    return { committed: true as const, generation }
  }
  async close() {}
  kill() {}
}

/** Compatibility helper: allocates and immediately abandons one generation. */
export async function allocateOpenCodeProviderCatalogAttempt(scope: string, startedAt: number,
  controls: Readonly<{ deadline?: number; abortSignal?: AbortSignal; cacheHome?: string }> = {}) {
  const controller = new AbortController()
  const signal = controls.abortSignal ?? controller.signal
  const client = new OpenCodeCatalogAuthorityClient({ deadline: controls.deadline
    ?? performance.now() + DEFAULT_TIMEOUT_MS, signal, cacheHome: controls.cacheHome })
  try {
    const begun = await client.beginAttempt(startedAt, hash(scope))
    return { requestGeneration: begun.generation, attemptIdentity: begun.attemptIdentity }
  } finally { await client.close() }
}

export class OpenCodeProviderCatalogService implements OpenCodeProviderCatalogPort {
  private lastClock: number | null = null
  constructor(private readonly deps: OpenCodeProviderCatalogServiceDeps = {}) {}

  private now(previous?: number): number {
    let value: unknown
    try { value = this.deps.now?.() ?? Date.now() } catch { throw failure() }
    if (!integer(value) || value > MAX_EPOCH_MS || (previous !== undefined && value < previous)
      || (this.lastClock !== null && value < this.lastClock)) throw failure()
    this.lastClock = value
    return value
  }

  private async release(key: string, signal: AbortSignal, deadline: number): Promise<boolean> {
    const release = this.deps.releaseHost ?? (async (hostKey: string) => {
      const { openCodeHostManager } = await import('./OpenCodeHostManager.js')
      await openCodeHostManager.releaseHost(hostKey)
    })
    if (signal.aborted || performance.now() >= deadline) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), Math.max(0, deadline - performance.now()))
      timer.unref?.()
    })
    try {
      return await Promise.race([
        release(key, { abortSignal: signal, deadline }).then(() => true, () => false),
        timeout,
      ])
    } finally { if (timer) clearTimeout(timer) }
  }

  async loadCatalog(unsafeInput: OpenCodeProviderCatalogLoadInput): Promise<OpenCodeProviderCatalogLoadResult> {
    const selected = options(this.deps)
    // The absolute monotonic deadline is armed before even the input snapshot
    // and project/provider canonicalization.
    const controller = new AbortController()
    const deadline = performance.now() + selected.timeoutMs
    const cleanupReserveMs = Math.max(1, Math.min(1_000, Math.floor(selected.timeoutMs / 4)))
    const workDeadline = deadline - cleanupReserveMs
    let authority: AuthorityAttempt | null = null
    let profile: OpenCodeScopedPreparedProfile | null = null
    let profileSettled = false
    let hostKey: string | null = null
    let acknowledgedPrior: Persisted | null = null
    let resultAfterCommit: OpenCodeProviderCatalogLoadResult | null = null
    let leaseTimer: ReturnType<typeof setInterval> | null = null
    let inputSignal: AbortSignal | undefined
    let rejectDeadline: ((error: Error) => void) | null = null
    let finalizeInFlight = false
    let preparation: Promise<OpenCodeScopedPreparedProfile> | null = null
    const deadlineFailure = new Promise<never>((_resolve, reject) => { rejectDeadline = reject })
    const expire = () => {
      if (authority?.committed) return
      controller.abort(failure())
      // Auth publication is the last preparation phase, but a manager may do
      // additional work before resolving its profile.  Settle the transaction
      // by signal even when the caller-facing deadline wins that final gap.
      void rollbackOpenCodeScopedProfileAuthSignal(controller.signal).catch(() => undefined)
      authority?.kill()
      if (finalizeInFlight) return
      rejectDeadline?.(failure())
    }
    let timer = (this.deps.setTimer ?? setTimeout)(expire,
      Math.max(1, selected.timeoutMs - cleanupReserveMs))
    timer.unref?.()
    let externalAbort: (() => void) | null = null
    const within = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, deadlineFailure])
    try {
      const input = snapshotInput(unsafeInput)
      inputSignal = input.abortSignal
      if (input.abortSignal?.aborted) throw failure()
      externalAbort = expire
      input.abortSignal?.addEventListener('abort', externalAbort, { once: true })
      const providerId = canonicalizeOpenCodeProviderId(input.providerId)
      if (!providerId) throw failure()
      const requested = path.resolve(input.projectPath ?? process.cwd())
      const canonicalize = this.deps.canonicalizeProjectPath ?? canonicalizeOpenCodePassiveProjectPath
      const canonicalProjectPath = await within(canonicalize(requested, controller.signal))
      if (controller.signal.aborted || performance.now() >= workDeadline) throw failure()
      const startedAt = this.now()
      const scopeHash = hash(`${canonicalProjectPath}\0${providerId}`)
      authority = this.deps.authorityFactory?.({ deadline, signal: controller.signal })
        ?? (this.deps.allocateAttempt ? new FakeAuthority(this.deps)
          : new OpenCodeCatalogAuthorityClient({ deadline, signal: controller.signal }))
      // Durable global fencing precedes all profile/auth preparation.
      const begun = await within(authority.beginAttempt(startedAt, scopeHash))
      if (!integer(begun.generation, 1)
        || !/^sha256:[0-9a-f]{64}$/.test(begun.attemptIdentity)) throw failure()

      const prepare = this.deps.prepareProfile ?? (async plan => {
        const manager = this.deps.profileManager ?? (await import('./OpenCodeProfileManager.js'))
          .openCodeProfileManager as unknown as OpenCodeProviderCatalogProductionProfileManager
        return prepareOpenCodeProviderCatalogProductionProfile(manager, plan)
      })
      preparation = prepare({ purpose: 'provider-catalog', providerId,
        runtimeInstanceId: `catalog-g${begun.generation}-${randomUUID()}`, projectPath: canonicalProjectPath,
        abortSignal: controller.signal })
      // Preserve the losing promise. A late successful preparation owns real
      // auth/root authority and must be settled rather than becoming an
      // unobserved retained lease after this request has returned.
      void preparation.then(async lateProfile => {
        if (!controller.signal.aborted || profile === lateProfile) return
        const rollbackPrepared = this.deps.rollbackPreparedProfile
          ?? (this.deps.prepareProfile ? async () => {} : rollbackOpenCodeScopedProfileAuth)
        try { await rollbackPrepared(lateProfile) } catch {
          try { await rollbackOpenCodeScopedProfileAuthSignal(controller.signal) } catch {}
          return
        }
        scheduleProfileCleanup(lateProfile)
      }, () => undefined)
      profile = await within(preparation)
      const leaseProfile = profile as unknown as Record<string, unknown>
      if (typeof leaseProfile.profileRootPath === 'string'
        && typeof leaseProfile.runtimeInstanceId === 'string'
        && typeof leaseProfile.profileRootKey === 'string') {
        leaseTimer = setInterval(() => {
          void heartbeatOpenCodeCatalogProfile({
            profileRootPath: leaseProfile.profileRootPath as string,
            runtimeInstanceId: leaseProfile.runtimeInstanceId as string,
            profileRootKey: leaseProfile.profileRootKey as string,
          }).catch(() => undefined)
        }, 30_000)
        leaseTimer.unref?.()
      }
      if (controller.signal.aborted || performance.now() >= workDeadline) throw failure()
      const identity = profileIdentity(profile, providerId, projectOf(profile, canonicalProjectPath))
      const finalizePrepared = this.deps.finalizePreparedProfile
        ?? (this.deps.prepareProfile ? async () => {} : finalizeOpenCodeScopedProfileAuth)
      await within(finalizePrepared(profile))
      profileSettled = true
      const boundIdentity = authorityIdentity(identity)
      const bound = await within(authority.bindAndRead(begun.generation, begun.attemptIdentity, boundIdentity))
      if (bound.previousEnvelope !== null) {
        const decodedBytes = decodeOpenCodeLegacyCatalogEnvelope(bound.previousEnvelope)
        acknowledgedPrior = decodePersisted(decodedBytes, identity)
          ?? decodeLegacyPersisted(decodedBytes, identity)
      }
      let clock = this.now(startedAt)
      if (acknowledgedPrior) {
        const cached = refresh(acknowledgedPrior.catalog, clock, selected.ttlMs, selected.maxStaleMs)
        if (cached?.freshness.state === 'fresh') {
          const result = Object.freeze({ catalog: cached,
            catalogEvidence: acknowledgedPrior.catalogEvidence,
            catalogObservedAt: acknowledgedPrior.catalogObservedAt,
            catalogExpiresAt: acknowledgedPrior.catalogExpiresAt,
            catalogProvenance: 'cache-hit' as const, profileRootPath: profileRoot(profile),
            projectPath: canonicalProjectPath, diagnostics: Object.freeze([]) })
          scheduleProfileCleanup(profile)
          return result
        }
      }

      const ensureHost = this.deps.ensureHost ?? (async request => {
        const { openCodeHostManager } = await import('./OpenCodeHostManager.js')
        return openCodeHostManager.ensureScopedHost(request)
      })
      if (typeof profile.plannedHostKey !== 'string' || !profile.plannedHostKey.trim()) throw failure()
      const host = await within(ensureHost({ preparedProfile: profile,
        expectedHostKey: profile.plannedHostKey, abortSignal: controller.signal }))
      if (!host || typeof host.hostKey !== 'string' || typeof host.baseUrl !== 'string') throw failure()
      hostKey = host.hostKey
      const fetchCatalog = this.deps.fetchProviderCatalog ?? (async request => {
        const { openCodeClientFactory } = await import('./OpenCodeClientFactory.js')
        return openCodeClientFactory.create(request.baseUrl, { signal: request.abortSignal })
          .getProviderCatalog(request.providerId)
      })
      const response = await within(fetchCatalog({ baseUrl: host.baseUrl, providerId,
        abortSignal: controller.signal }))
      clock = this.now(clock)
      // Authority generation is also the catalog candidate generation. No
      // per-key counter or sqlite_sequence can manufacture it.
      const catalog = normalizeOpenCodeScopedProviderCatalogResponse({ requestedProviderId: providerId,
        response, generation: begun.generation, observedAtMs: clock, nowMs: clock,
        freshForMs: selected.ttlMs, maxStaleMs: selected.maxStaleMs, source: 'live' })
      const publicationEvidence = evidence(identity, begun.generation, startedAt, begun.attemptIdentity)
      const expiresAt = Math.min(MAX_EPOCH_MS, clock + selected.ttlMs)
      const envelope = persisted(identity, catalog, publicationEvidence, clock, expiresAt)
      const envelopeJson = JSON.stringify(envelope)
      if (new TextEncoder().encode(envelopeJson).byteLength > MAX_ENVELOPE_BYTES) throw failure()
      resultAfterCommit = Object.freeze({ catalog, catalogEvidence: publicationEvidence,
        catalogObservedAt: clock, catalogExpiresAt: expiresAt,
        catalogProvenance: 'fresh-live' as const, profileRootPath: profileRoot(profile),
        projectPath: canonicalProjectPath, diagnostics: Object.freeze([]) })

      // Host release and every fallible TS validation precede FINALIZE.
      const releaseKey = hostKey
      if (!await this.release(releaseKey, controller.signal, workDeadline)) throw failure()
      hostKey = null
      if (controller.signal.aborted || performance.now() >= deadline) throw failure()
      finalizeInFlight = true
      try { (this.deps.clearTimer ?? clearTimeout)(timer) } catch {}
      timer = (this.deps.setTimer ?? setTimeout)(expire,
        Math.max(1, deadline - performance.now()))
      timer.unref?.()
      // The native client owns the reserved, exact-key recovery budget from
      // this point. Racing it with the caller/deadline promise could return
      // bounded stale while RESOLVE was proving a post-COMMIT result.
      await authority.finalize(begun.generation, begun.attemptIdentity, boundIdentity,
        envelopeJson, clock, expiresAt)
      // A valid native reply follows durable COMMIT. Nothing below is allowed
      // to reject or reinterpret that publication.
      scheduleProfileCleanup(profile)
      return resultAfterCommit
    } catch (error) {
      if (authority?.committed && resultAfterCommit) return resultAfterCommit
      // A timed-out/crashed FINALIZE is never permission to launch using stale
      // proof.  Only the native attempt-key resolve protocol can authorize the
      // committed envelope.
      if (error instanceof OpenCodeCatalogCommitUncertainError) throw failure()
      if (acknowledgedPrior && profile) {
        const now = (() => { try { return this.now() } catch { return acknowledgedPrior!.catalogObservedAt } })()
        const stale = refresh(acknowledgedPrior.catalog, now, selected.ttlMs, selected.maxStaleMs)
        if (stale) {
          return Object.freeze({ catalog: stale, catalogEvidence: acknowledgedPrior.catalogEvidence,
            catalogObservedAt: acknowledgedPrior.catalogObservedAt,
            catalogExpiresAt: acknowledgedPrior.catalogExpiresAt,
            catalogProvenance: 'bounded-stale' as const, profileRootPath: profileRoot(profile),
            projectPath: acknowledgedPrior.identity.projectPath,
            diagnostics: Object.freeze(['OpenCode provider catalog refresh failed; using bounded stale data.']) })
        }
      }
      if (error instanceof OpenCodeProviderCatalogUnavailableError) throw error
      throw failure()
    } finally {
      // Once FINALIZE has replied, every action here is best-effort and
      // non-blocking so mutable caller input, injected finalizers, or cleanup
      // faults cannot revoke or delay the durable result.
      if (externalAbort) {
        try { inputSignal?.removeEventListener('abort', externalAbort) } catch {}
      }
      if (leaseTimer) { try { clearInterval(leaseTimer) } catch {} }
      if (hostKey && await this.release(hostKey, new AbortController().signal, deadline)) {
        hostKey = null
      }
      // An uncertain host release keeps both the HostManager ownership and the
      // attempt profile intact for bounded janitor/reconciliation. Deleting
      // its live filesystem would falsely claim cleanup and strand the host.
      if (profile && !profileSettled) {
        const rollbackPrepared = this.deps.rollbackPreparedProfile
          ?? (this.deps.prepareProfile ? async () => {} : rollbackOpenCodeScopedProfileAuth)
        try { await rollbackPrepared(profile); profileSettled = true } catch {}
      }
      if (profile && profileSettled && !authority?.committed && !hostKey) scheduleProfileCleanup(profile)
      if (authority?.committed) {
        void Promise.resolve().then(() => authority?.close()).catch(() => undefined)
      } else {
        try { await authority?.close() } catch {}
      }
      try { (this.deps.clearTimer ?? clearTimeout)(timer) } catch {}
    }
  }
}

export const openCodeProviderCatalogService = new OpenCodeProviderCatalogService()
