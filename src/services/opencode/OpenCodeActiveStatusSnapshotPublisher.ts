import { createHash } from 'node:crypto'

import { parseOpenCodeExactProviderModelRef, tryCreateOpenCodeCanonicalProviderId } from './OpenCodeProviderIdentity.js'
import {
  canonicalizeOpenCodePassiveProjectPath,
  getOpenCodePassiveSnapshotPath,
  getOpenCodePassiveStatusRootDirectory,
  readBoundedSnapshotText,
} from './OpenCodePassiveStatusProductionReader.js'
import { OpenCodePassiveStatusSnapshotWriter } from './OpenCodePassiveStatusSnapshotWriter.js'
import {
  isOpenCodeCanonicalProviderId,
  normalizeOpenCodePassiveModelRef,
} from './OpenCodePassiveStatusContract.js'
import {
  assertOpenCodePassiveSnapshotPersistenceSupported,
  getOpenCodePassiveSnapshotPersistenceCapability,
} from './OpenCodePassiveSnapshotPersistencePolicy.js'
import {
  decodeOpenCodeRedactedSnapshotV1,
  catalogProjectionIdentity,
  type OpenCodeRedactedSnapshotProviderV1,
  type OpenCodeRedactedSnapshotMutation,
  type OpenCodeRedactedSnapshotV1,
  type OpenCodeRedactedSnapshotWriterPort,
} from './OpenCodeRedactedStatusSnapshot.js'
import type { OpenCodeInventoryCompleteness, OpenCodeInventorySnapshot } from './types.js'
import type { OpenCodeCatalogPublicationEvidence } from './OpenCodeProviderCatalogService.js'

const ACTIVE_EVIDENCE_TTL_MS = 5 * 60_000

export type OpenCodeActiveStatusPublisherPort = {
  publishInventory(snapshot: OpenCodeInventorySnapshot, signal?: AbortSignal): Promise<void>
  /** Execution/config/auth observations can never carry catalog evidence. */
  publishProviderUpdate(input: {
    projectPath: string
    providerId: string
    configured?: boolean
    connected?: boolean
  }, signal?: AbortSignal): Promise<void>
  publishExecutionUpdate(input: {
    projectPath: string
    providerId: string
    executionVerified?: boolean
  }, signal?: AbortSignal): Promise<void>
  publishCatalogResult(input: {
    projectPath: string
    evidence: OpenCodeCatalogPublicationEvidence
    catalogAvailable: boolean
    modelIds: readonly string[]
    observedAt?: number
    expiresAt?: number
    provenance?: 'fresh-live' | 'cache-hit' | 'bounded-stale'
  }, signal?: AbortSignal): Promise<void>
}

type PublisherDeps = Readonly<{
  platform?: NodeJS.Platform
  rootDirectory?: string
  writer?: OpenCodeRedactedSnapshotWriterPort
  now?: () => number
  canonicalizePath?: (projectPath: string, signal: AbortSignal) => Promise<string>
  readSnapshot?: (scope: `sha256:${string}`, signal: AbortSignal) => Promise<string | null>
  withScopeUpdate?: <T>(scope: `sha256:${string}`, signal: AbortSignal, operation: () => Promise<T>) => Promise<T>
}>

/** Mutation-only bridge from successful active observations to the passive redacted store. */
export class OpenCodeActiveStatusSnapshotPublisher implements OpenCodeActiveStatusPublisherPort {
  readonly #platform: NodeJS.Platform
  readonly #rootDirectory: string
  readonly #writer: OpenCodeRedactedSnapshotWriterPort
  readonly #now: () => number
  readonly #canonicalizePath: (projectPath: string, signal: AbortSignal) => Promise<string>
  readonly #readSnapshot: (scope: `sha256:${string}`, signal: AbortSignal) => Promise<string | null>
  readonly #withScopeUpdate: <T>(scope: `sha256:${string}`, signal: AbortSignal, operation: () => Promise<T>) => Promise<T>
  readonly #tails = new Map<string, Promise<void>>()

  constructor(deps: PublisherDeps = {}) {
    this.#platform = deps.platform ?? process.platform
    this.#rootDirectory = getOpenCodePassiveSnapshotPersistenceCapability(this.#platform).supported
      ? deps.rootDirectory ?? getOpenCodePassiveStatusRootDirectory()
      : ''
    this.#writer = deps.writer ?? new OpenCodePassiveStatusSnapshotWriter({
      rootDirectory: this.#rootDirectory,
      platform: this.#platform,
    })
    this.#now = deps.now ?? Date.now
    this.#canonicalizePath = deps.canonicalizePath ?? canonicalizeOpenCodePassiveProjectPath
    this.#readSnapshot = deps.readSnapshot ?? (async (scope, signal) => {
      if (signal.aborted) throw new Error('cancelled')
      return readBoundedSnapshotText(
        getOpenCodePassiveSnapshotPath(this.#rootDirectory, scope), signal,
      )
    })
    this.#withScopeUpdate = deps.withScopeUpdate ?? (async (_scope, _signal, operation) => operation())
  }

  async publishInventory(inventory: OpenCodeInventorySnapshot, signal = new AbortController().signal): Promise<void> {
    if (signal.aborted) return
    const completeness = inventory.completeness ?? legacyCompleteness(inventory)
    const connected = new Map(inventory.connectedProviders.map(provider => [provider.id, provider]))
    const usable = (state: string) => state === 'complete' || state === 'partial'
    const usableConnected = new Map([...connected].filter(([, provider]) => provider.source === 'environment'
      ? usable(completeness.environmentAuth.state)
      : usable(completeness.managedAuth.state) || usable(completeness.providerInventory.state)))
    if (inventory.probeError
      && completeness.profileConfig.state !== 'complete'
      && completeness.providerInventory.state !== 'complete'
      && completeness.modelCatalog.state !== 'complete'
      && usableConnected.size === 0) return
    const configuredProviderIds = getManagedConfiguredProviderIds(inventory)
    const providerIds = new Set(
      [...inventory.availableProviders, ...configuredProviderIds, ...connected.keys()]
        .filter(providerId => tryCreateOpenCodeCanonicalProviderId(providerId) === providerId
          && isOpenCodeCanonicalProviderId(providerId)),
    )
    await this.#update(inventory.projectPath, signal, (snapshot, now) => {
      if (!inventory.probeError) {
        const nextBinary = { presence: inventory.detected ? 'present' as const : 'absent' as const, version: inventory.version }
        const binaryChanged = JSON.stringify(snapshot.binary.value) !== JSON.stringify(nextBinary)
          && snapshot.binary.value.presence !== 'unknown'
        snapshot.binary = observation(nextBinary, 'binary_metadata', now)
        if (binaryChanged) for (const provider of snapshot.providers) invalidateCatalogEvidence(provider)
      }
      const knownProviderIds = new Set([
        ...snapshot.providers.map(provider => provider.providerId),
        ...providerIds,
      ])
      for (const providerId of knownProviderIds) {
        const providerExisted = snapshot.providers.some(provider => provider.providerId === providerId)
        const provider = getOrCreateProvider(snapshot, providerId)
        const priorConfigured = provider.configured.value
        const priorConnected = provider.lastConnected.value.state
        const priorFingerprint = provider.fingerprint
        const evidenceFingerprint = providerEvidenceFingerprint(inventory, providerId)
        const inventoryBinaryFingerprint = inventory.profile?.binaryFingerprint
          ? redactedCatalogFingerprint('binary', inventory.profile.binaryFingerprint) : null
        if (inventoryBinaryFingerprint) provider.binaryFingerprint = inventoryBinaryFingerprint
        if (completeness.profileConfig.state === 'complete' && inventory.profile) {
          provider.configured = observation(
            configuredProviderIds.has(providerId) ? 'configured' : 'not_configured',
            'config_metadata', now,
          )
        }
        if (usableConnected.has(providerId)) {
          provider.lastConnected = observation(
            { state: 'connected' as const, at: now }, 'auth_metadata', now,
          )
        } else if (completeness.providerInventory.state === 'complete') {
          provider.lastConnected = observation(
            { state: 'not_connected' as const }, 'auth_metadata', now,
          )
        }
        if (providerExisted && (provider.configured.value !== priorConfigured
          || provider.lastConnected.value.state !== priorConnected
          || evidenceFingerprint !== priorFingerprint)) {
          provider.fingerprint = evidenceFingerprint
          invalidateCatalogEvidence(provider)
        } else if (!providerExisted) {
          provider.fingerprint = evidenceFingerprint
        }
        if (inventoryBinaryFingerprint && provider.catalogBinaryFingerprint
          && inventoryBinaryFingerprint !== provider.catalogBinaryFingerprint) {
          invalidateCatalogEvidence(provider)
        }
        if (completeness.providerInventory.state === 'complete'
          && completeness.modelCatalog.state === 'complete'
          && provider.configured.value === 'not_configured'
          && provider.lastConnected.value.state === 'not_connected') {
          provider.catalogAvailable = catalogObservation(
            'unavailable', now, Math.min(Number.MAX_SAFE_INTEGER, now + ACTIVE_EVIDENCE_TTL_MS), false,
          )
          replaceModelRefs(provider, [])
        }
      }
    }, now => ({
      ...(completeness.profileConfig.state === 'complete' && inventory.profile ? {
        configured: observation('not_configured', 'config_metadata', now),
      } : {}),
      ...(completeness.providerInventory.state === 'complete' ? {
        lastConnected: observation({ state: 'not_connected' as const }, 'auth_metadata', now),
      } : {}),
      ...(completeness.modelCatalog.state === 'complete' ? {
        catalog: { available: observation('unavailable', 'catalog_snapshot', now) },
      } : {}),
    }))
  }

  async publishProviderUpdate(input: {
    projectPath: string; providerId: string; configured?: boolean; connected?: boolean
  }, signal = new AbortController().signal): Promise<void> {
    if (!isOpenCodeCanonicalProviderId(input.providerId)) return
    await this.#update(input.projectPath, signal, (snapshot, now) => {
      const provider = getOrCreateProvider(snapshot, input.providerId)
      const changed = (input.configured !== undefined
        && provider.configured.value !== (input.configured ? 'configured' : 'not_configured'))
        || (input.connected !== undefined
          && provider.lastConnected.value.state !== (input.connected ? 'connected' : 'not_connected'))
      if (input.configured !== undefined) provider.configured = observation(
        input.configured ? 'configured' : 'not_configured', 'config_metadata', now,
      )
      if (input.connected !== undefined) provider.lastConnected = observation(
        input.connected ? { state: 'connected' as const, at: now } : { state: 'not_connected' as const },
        'auth_metadata', now,
      )
      if (changed) invalidateCatalogEvidence(provider)
    })
  }

  async publishExecutionUpdate(input: {
    projectPath: string; providerId: string; executionVerified?: boolean
  }, signal = new AbortController().signal): Promise<void> {
    if (!isOpenCodeCanonicalProviderId(input.providerId)) return
    await this.#update(input.projectPath, signal, (snapshot, now) => {
      const provider = getOrCreateProvider(snapshot, input.providerId)
      if (input.executionVerified !== undefined) provider.executionVerified = observation(
        input.executionVerified ? 'verified' : 'rejected', 'execution_snapshot', now,
      )
    })
  }

  async publishCatalogResult(input: {
    projectPath: string
    evidence: OpenCodeCatalogPublicationEvidence
    catalogAvailable: boolean
    modelIds: readonly string[]
    observedAt?: number
    expiresAt?: number
    provenance?: 'fresh-live' | 'cache-hit' | 'bounded-stale'
  }, signal = new AbortController().signal): Promise<void> {
    const { evidence } = input
    if (!isOpenCodeCanonicalProviderId(evidence.providerId)) return
    await this.#update(input.projectPath, signal, (snapshot, now) => {
      const provider = getOrCreateProvider(snapshot, evidence.providerId)
      if (isSuperseded(provider, evidence)) return
      if (provider.binaryFingerprint && provider.binaryFingerprint !== evidence.binaryFingerprint) return
      const observedAt = input.observedAt ?? now
      const expiresAt = input.expiresAt ?? Math.min(Number.MAX_SAFE_INTEGER, now + ACTIVE_EVIDENCE_TTL_MS)
      if (!Number.isSafeInteger(observedAt) || !Number.isSafeInteger(expiresAt)
        || observedAt < 0 || observedAt > now || expiresAt < observedAt
        || (now > expiresAt && input.provenance !== 'bounded-stale')) return
      provider.catalogAvailable = catalogObservation(
        input.catalogAvailable ? 'available' : 'unavailable', observedAt, expiresAt,
        input.provenance === 'bounded-stale',
      )
      replaceModelRefs(provider, input.modelIds, evidence.providerId)
      provider.catalogRequestGeneration = evidence.requestGeneration
      delete provider.catalogFenceGeneration
      provider.catalogStartedAt = evidence.startedAt
      provider.catalogAttemptIdentity = evidence.attemptIdentity
      provider.catalogBinaryFingerprint = evidence.binaryFingerprint
      provider.catalogConfigFingerprint = evidence.configFingerprint
      provider.catalogAuthFingerprint = evidence.authFingerprint
      provider.catalogIdentity = catalogProjectionIdentity(snapshot.projectScope, provider)
    })
  }

  async #update(
    projectPath: string,
    signal: AbortSignal,
    mutate: (snapshot: OpenCodeRedactedSnapshotV1, now: number) => void,
    defaults?: (now: number) => OpenCodeRedactedSnapshotMutation['providerDefaults'],
  ): Promise<void> {
    // Persistence-unavailable is a typed transient result. Gate before path
    // canonicalization or compatibility reads so native Windows does zero I/O.
    assertOpenCodePassiveSnapshotPersistenceSupported(this.#platform)
    if (signal.aborted) return
    const canonical = await this.#canonicalizePath(projectPath, signal)
    const scope = projectScope(canonical)
    const previous = this.#tails.get(scope) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => this.#withScopeUpdate(scope, signal, async () => {
      if (signal.aborted) return
      const now = this.#now()
      if (!Number.isSafeInteger(now) || now < 0) return
      if (this.#writer.update) {
        await this.#writer.update(scope, now, snapshot => {
          const evidenceTime = Math.max(now, snapshot.capturedAt)
          ageExpiredObservations(snapshot, evidenceTime)
          snapshot.capturedAt = evidenceTime
          mutate(snapshot, evidenceTime)
          snapshot.providers.sort((left, right) => left.providerId.localeCompare(right.providerId))
        }, signal)
        return
      }
      if (this.#writer.mutate) {
        const delta = emptySnapshot(scope, now)
        mutate(delta, now)
        await this.#writer.mutate(toMutation(delta, defaults?.(now)), signal)
        return
      }
      const loaded = await this.#load(scope, signal)
      const snapshot = loaded ?? emptySnapshot(scope, now)
      const evidenceTime = Math.max(now, snapshot.capturedAt)
      ageExpiredObservations(snapshot, evidenceTime)
      snapshot.capturedAt = evidenceTime
      mutate(snapshot, evidenceTime)
      snapshot.providers.sort((left, right) => left.providerId.localeCompare(right.providerId))
      await this.#writer.write(snapshot, signal)
    }))
    this.#tails.set(scope, next)
    try { await next } finally { if (this.#tails.get(scope) === next) this.#tails.delete(scope) }
  }

  async #load(scope: `sha256:${string}`, signal: AbortSignal): Promise<OpenCodeRedactedSnapshotV1 | null> {
    const text = await this.#readSnapshot(scope, signal)
    if (text === null) return null
    const decoded = decodeOpenCodeRedactedSnapshotV1(text)
    return decoded.ok && decoded.value.projectScope === scope ? structuredClone(decoded.value) : null
  }
}

function normalizeModelRefs(values: readonly string[], providerId: string): string[] {
  const retained = new Set<string>()
  for (const value of values) {
    const normalized = normalizeOpenCodePassiveModelRef(value)
    const parsed = normalized && parseOpenCodeExactProviderModelRef(normalized)
    if (parsed?.providerId === providerId) retained.add(normalized)
  }
  return [...retained]
}

function replaceModelRefs(provider: OpenCodeRedactedSnapshotProviderV1, values: readonly string[] | undefined, providerId = provider.providerId): void {
  if (values === undefined) delete provider.modelIds
  else provider.modelIds = normalizeModelRefs(values, providerId)
  delete provider.modelIdsTotal
  delete provider.modelIdsTruncated
  delete provider.modelIdsFingerprint
}

function legacyCompleteness(inventory: OpenCodeInventorySnapshot): OpenCodeInventoryCompleteness {
  const aggregate = inventory.probeError ? 'failed' as const : 'complete' as const
  return {
    profileConfig: { state: inventory.profile ? 'complete' : aggregate, provenance: 'managed_profile' },
    managedAuth: { state: aggregate, provenance: 'managed_auth_store' },
    environmentAuth: { state: aggregate, provenance: 'provider_environment' },
    providerInventory: { state: aggregate, provenance: 'provider_cli' },
    modelCatalog: { state: aggregate, provenance: 'model_cli' },
  }
}

function projectScope(canonicalPath: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update('opencode-project-scope-v1\0').update(canonicalPath).digest('hex')}`
}

function isSuperseded(
  provider: OpenCodeRedactedSnapshotProviderV1,
  evidence: OpenCodeCatalogPublicationEvidence,
): boolean {
  // Mutation fences are inclusive: the fenced ordinal may already have been
  // allocated and can finish after this publisher is restarted.
  if ((provider.catalogFenceGeneration ?? 0) >= evidence.requestGeneration) return true
  if (provider.catalogRequestGeneration === undefined) return false
  if (evidence.requestGeneration !== provider.catalogRequestGeneration) {
    return evidence.requestGeneration < provider.catalogRequestGeneration
  }
  // An invalidation fence deliberately has no producer identity. The next
  // durable attempt may claim that exact ordinal; an already-published
  // ordinal remains idempotent only for its exact producer.
  return provider.catalogAttemptIdentity !== undefined
    && evidence.attemptIdentity !== provider.catalogAttemptIdentity
}

function invalidateCatalogEvidence(provider: OpenCodeRedactedSnapshotProviderV1): void {
  // Never remove ordering authority. A request that started before the
  // config/auth/binary mutation must remain durably fenced when it finishes
  // late, including after the publisher is restarted from this snapshot.
  provider.catalogFenceGeneration = Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(provider.catalogFenceGeneration ?? 0, provider.catalogRequestGeneration ?? 0, 1),
  )
  delete provider.catalogIdentity
  delete provider.catalogAttemptIdentity
  delete provider.catalogRequestGeneration
  delete provider.catalogStartedAt
  delete provider.catalogBinaryFingerprint
  delete provider.catalogConfigFingerprint
  delete provider.catalogAuthFingerprint
}

function providerEvidenceFingerprint(
  inventory: OpenCodeInventorySnapshot,
  providerId: string,
): `sha256:${string}` {
  const profile = inventory.profile
  const connected = inventory.connectedProviders.find(provider => provider.id === providerId)
  const material = JSON.stringify({
    providerId,
    managedConfigFingerprint: profile?.managedConfigFingerprint ?? null,
    managedAuthFingerprint: profile?.managedAuthFingerprint ?? null,
    sourceAuthFingerprint: profile?.sourceAuthFingerprint ?? null,
    providerEnvironmentFingerprint: profile?.providerEnvironmentFingerprint ?? null,
    authSource: connected?.source ?? null,
    authHint: connected?.authHint ?? null,
    credentialScopes: [...(connected?.credentialScopes ?? [])].sort(),
    binaryFingerprint: profile?.binaryFingerprint ?? null,
  })
  return `sha256:${createHash('sha256').update('opencode-passive-provider-evidence-v1\0').update(material).digest('hex')}`
}

function redactedCatalogFingerprint(kind: 'binary', value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(`opencode-catalog-${kind}-v1\0${value}`).digest('hex')}`
}

function getManagedConfiguredProviderIds(inventory: OpenCodeInventorySnapshot): Set<string> {
  const configured = new Set<string>()
  const value = inventory.profile?.managedConfig.provider
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return configured
  for (const providerId of Object.keys(value)) {
    if (tryCreateOpenCodeCanonicalProviderId(providerId) === providerId
      && isOpenCodeCanonicalProviderId(providerId)) configured.add(providerId)
  }
  return configured
}

function ageExpiredObservations(snapshot: OpenCodeRedactedSnapshotV1, now: number): void {
  const observations = [
    snapshot.binary,
    ...snapshot.providers.flatMap(provider => [
      provider.configured,
      provider.lastConnected,
      provider.catalogAvailable,
      provider.executionVerified,
    ]),
  ]
  for (const retained of observations) {
    if (retained.freshness !== 'fresh' || retained.validUntil === null || retained.validUntil >= now) continue
    retained.freshness = 'stale'
    retained.condition = 'degraded'
    retained.issueCode = 'expired'
  }
}

function observation<T>(value: T, authority: any, now: number): any {
  return { value, authority, freshness: 'fresh', condition: 'normal', observedAt: now,
    validUntil: Math.min(Number.MAX_SAFE_INTEGER, now + ACTIVE_EVIDENCE_TTL_MS), issueCode: 'none',
  }
}

function toMutation(
  snapshot: OpenCodeRedactedSnapshotV1,
  providerDefaults: OpenCodeRedactedSnapshotMutation['providerDefaults'],
): OpenCodeRedactedSnapshotMutation {
  return {
    projectScope: snapshot.projectScope,
    capturedAt: snapshot.capturedAt,
    ...(snapshot.binary.authority === 'none' ? {} : { binary: snapshot.binary }),
    ...(providerDefaults ? { providerDefaults } : {}),
    providers: snapshot.providers.map(provider => ({
      providerId: provider.providerId,
      ...(provider.configured.authority === 'none' ? {} : { configured: provider.configured }),
      ...(provider.lastConnected.authority === 'none' ? {} : { lastConnected: provider.lastConnected }),
      ...(provider.catalogAvailable.authority === 'none' ? {} : { catalog: {
        available: provider.catalogAvailable,
        ...(provider.modelIds ? { modelIds: provider.modelIds } : {}),
      } }),
      ...(provider.executionVerified.authority === 'none' ? {} : { executionVerified: provider.executionVerified }),
    })),
  }
}

function catalogObservation<T>(value: T, observedAt: number, validUntil: number, stale: boolean): any {
  return { value, authority: 'catalog_snapshot', freshness: stale ? 'stale' : 'fresh',
    condition: stale ? 'degraded' : 'normal', observedAt, validUntil,
    issueCode: stale ? 'expired' : 'none' }
}

function emptySnapshot(scope: `sha256:${string}`, now: number): OpenCodeRedactedSnapshotV1 {
  return { schemaVersion: 1, projectScope: scope, capturedAt: now,
    binary: unknownObservation({ presence: 'unknown', version: null }), providers: [] }
}

function getOrCreateProvider(snapshot: OpenCodeRedactedSnapshotV1, providerId: string): OpenCodeRedactedSnapshotProviderV1 {
  let provider = snapshot.providers.find(item => item.providerId === providerId)
  if (provider) return provider
  const now = snapshot.capturedAt
  provider = { providerId,
    configured: unknownObservation('unknown'),
    lastConnected: unknownObservation({ state: 'unknown' }),
    catalogAvailable: unknownObservation('unknown'),
    executionVerified: unknownObservation('unknown') }
  snapshot.providers.push(provider)
  return provider
}

function unknownObservation<T>(value: T): any {
  return { value, authority: 'none', freshness: 'unknown', condition: 'degraded',
    observedAt: null, validUntil: null, issueCode: 'unknown' }
}

export const openCodeActiveStatusSnapshotPublisher = new OpenCodeActiveStatusSnapshotPublisher()
