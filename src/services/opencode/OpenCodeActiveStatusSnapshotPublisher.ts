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
  decodeOpenCodeRedactedSnapshotV1,
  type OpenCodeRedactedSnapshotProviderV1,
  type OpenCodeRedactedSnapshotV1,
  type OpenCodeRedactedSnapshotWriterPort,
} from './OpenCodeRedactedStatusSnapshot.js'
import type { OpenCodeInventoryCompleteness, OpenCodeInventorySnapshot } from './types.js'

const ACTIVE_EVIDENCE_TTL_MS = 5 * 60_000

export type OpenCodeActiveStatusPublisherPort = {
  publishInventory(snapshot: OpenCodeInventorySnapshot, signal?: AbortSignal): Promise<void>
  publishProviderUpdate(input: {
    projectPath: string
    providerId: string
    configured?: boolean
    connected?: boolean
    catalogAvailable?: boolean
    executionVerified?: boolean
    modelIds?: readonly string[]
  }, signal?: AbortSignal): Promise<void>
}

type PublisherDeps = Readonly<{
  rootDirectory?: string
  writer?: OpenCodeRedactedSnapshotWriterPort
  now?: () => number
  canonicalizePath?: (projectPath: string, signal: AbortSignal) => Promise<string>
  readSnapshot?: (scope: `sha256:${string}`, signal: AbortSignal) => Promise<string | null>
  withScopeLease?: <T>(scope: `sha256:${string}`, signal: AbortSignal, operation: () => Promise<T>) => Promise<T>
}>

/** Mutation-only bridge from successful active observations to the passive redacted store. */
export class OpenCodeActiveStatusSnapshotPublisher implements OpenCodeActiveStatusPublisherPort {
  readonly #rootDirectory: string
  readonly #writer: OpenCodeRedactedSnapshotWriterPort
  readonly #now: () => number
  readonly #canonicalizePath: (projectPath: string, signal: AbortSignal) => Promise<string>
  readonly #readSnapshot: (scope: `sha256:${string}`, signal: AbortSignal) => Promise<string | null>
  readonly #withScopeLease: <T>(scope: `sha256:${string}`, signal: AbortSignal, operation: () => Promise<T>) => Promise<T>
  readonly #tails = new Map<string, Promise<void>>()

  constructor(deps: PublisherDeps = {}) {
    this.#rootDirectory = deps.rootDirectory ?? getOpenCodePassiveStatusRootDirectory()
    this.#writer = deps.writer ?? new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: this.#rootDirectory })
    this.#now = deps.now ?? Date.now
    this.#canonicalizePath = deps.canonicalizePath ?? canonicalizeOpenCodePassiveProjectPath
    this.#readSnapshot = deps.readSnapshot ?? (async (scope, signal) => {
      if (signal.aborted) throw new Error('cancelled')
      return readBoundedSnapshotText(
        getOpenCodePassiveSnapshotPath(this.#rootDirectory, scope), signal,
      )
    })
    this.#withScopeLease = deps.withScopeLease
      ?? (this.#writer.withScopeLease?.bind(this.#writer) as typeof this.#withScopeLease | undefined)
      ?? (async (_scope, _signal, operation) => operation())
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
    const modelIds = new Map<string, string[]>()
    for (const model of inventory.models) {
      const parsed = parseOpenCodeExactProviderModelRef(model)
      if (!parsed) continue
      const normalized = normalizeOpenCodePassiveModelRef(parsed.raw)
      if (!normalized) continue
      const values = modelIds.get(parsed.providerId) ?? []
      values.push(normalized)
      modelIds.set(parsed.providerId, values)
    }
    const providerIds = new Set(
      [...inventory.availableProviders, ...configuredProviderIds, ...connected.keys(), ...modelIds.keys()]
        .filter(providerId => tryCreateOpenCodeCanonicalProviderId(providerId) === providerId
          && isOpenCodeCanonicalProviderId(providerId)),
    )
    await this.#update(inventory.projectPath, signal, (snapshot, now) => {
      if (!inventory.probeError) snapshot.binary = observation(
        { presence: inventory.detected ? 'present' as const : 'absent' as const, version: inventory.version },
        'binary_metadata', now,
      )
      const knownProviderIds = new Set([
        ...snapshot.providers.map(provider => provider.providerId),
        ...providerIds,
      ])
      for (const providerId of knownProviderIds) {
        const provider = getOrCreateProvider(snapshot, providerId)
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
        if (completeness.modelCatalog.state === 'complete') {
          provider.catalogAvailable = observation(
            modelIds.has(providerId) ? 'available' : 'unavailable',
            'catalog_snapshot', now,
          )
          replaceModelRefs(provider, modelIds.has(providerId) ? modelIds.get(providerId) : undefined)
        }
      }
    })
  }

  async publishProviderUpdate(input: {
    projectPath: string; providerId: string; configured?: boolean; connected?: boolean
    catalogAvailable?: boolean; executionVerified?: boolean; modelIds?: readonly string[]
  }, signal = new AbortController().signal): Promise<void> {
    if (!isOpenCodeCanonicalProviderId(input.providerId)) return
    await this.#update(input.projectPath, signal, (snapshot, now) => {
      const provider = getOrCreateProvider(snapshot, input.providerId)
      if (input.configured !== undefined) provider.configured = observation(
        input.configured ? 'configured' : 'not_configured', 'config_metadata', now,
      )
      if (input.connected !== undefined) provider.lastConnected = observation(
        input.connected ? { state: 'connected' as const, at: now } : { state: 'not_connected' as const },
        'auth_metadata', now,
      )
      if (input.catalogAvailable !== undefined) provider.catalogAvailable = observation(
        input.catalogAvailable ? 'available' : 'unavailable', 'catalog_snapshot', now,
      )
      if (input.executionVerified !== undefined) provider.executionVerified = observation(
        input.executionVerified ? 'verified' : 'rejected', 'execution_snapshot', now,
      )
      if (input.modelIds) replaceModelRefs(provider, input.modelIds)
    })
  }

  async #update(
    projectPath: string,
    signal: AbortSignal,
    mutate: (snapshot: OpenCodeRedactedSnapshotV1, now: number) => void,
  ): Promise<void> {
    if (signal.aborted) return
    const canonical = await this.#canonicalizePath(projectPath, signal)
    const scope = projectScope(canonical)
    const previous = this.#tails.get(scope) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => this.#withScopeLease(scope, signal, async () => {
      if (signal.aborted) return
      const now = this.#now()
      if (!Number.isSafeInteger(now) || now < 0) return
      const loaded = await this.#load(scope, signal)
      const snapshot = loaded ?? emptySnapshot(scope, now)
      ageExpiredObservations(snapshot, now)
      snapshot.capturedAt = now
      mutate(snapshot, now)
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

function normalizeModelRefs(values: readonly string[]): string[] {
  const retained = new Set<string>()
  for (const value of values) {
    const normalized = normalizeOpenCodePassiveModelRef(value)
    if (normalized) retained.add(normalized)
  }
  return [...retained]
}

function replaceModelRefs(provider: OpenCodeRedactedSnapshotProviderV1, values: readonly string[] | undefined): void {
  if (values === undefined) delete provider.modelIds
  else provider.modelIds = normalizeModelRefs(values)
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
    validUntil: Math.min(Number.MAX_SAFE_INTEGER, now + ACTIVE_EVIDENCE_TTL_MS), issueCode: 'none' }
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
