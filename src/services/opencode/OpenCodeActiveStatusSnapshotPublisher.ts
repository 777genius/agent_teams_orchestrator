import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { parseOpenCodeExactProviderModelRef, tryCreateOpenCodeCanonicalProviderId } from './OpenCodeProviderIdentity.js'
import {
  canonicalizeOpenCodePassiveProjectPath,
  getOpenCodePassiveSnapshotPath,
  getOpenCodePassiveStatusRootDirectory,
} from './OpenCodePassiveStatusProductionReader.js'
import { OpenCodePassiveStatusSnapshotWriter } from './OpenCodePassiveStatusSnapshotWriter.js'
import {
  decodeOpenCodeRedactedSnapshotV1,
  OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES,
  type OpenCodeRedactedSnapshotProviderV1,
  type OpenCodeRedactedSnapshotV1,
  type OpenCodeRedactedSnapshotWriterPort,
} from './OpenCodeRedactedStatusSnapshot.js'
import type { OpenCodeInventorySnapshot } from './types.js'

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
}>

/** Mutation-only bridge from successful active observations to the passive redacted store. */
export class OpenCodeActiveStatusSnapshotPublisher implements OpenCodeActiveStatusPublisherPort {
  readonly #rootDirectory: string
  readonly #writer: OpenCodeRedactedSnapshotWriterPort
  readonly #now: () => number
  readonly #canonicalizePath: (projectPath: string, signal: AbortSignal) => Promise<string>
  readonly #readSnapshot: (scope: `sha256:${string}`, signal: AbortSignal) => Promise<string | null>
  readonly #tails = new Map<string, Promise<void>>()

  constructor(deps: PublisherDeps = {}) {
    this.#rootDirectory = deps.rootDirectory ?? getOpenCodePassiveStatusRootDirectory()
    this.#writer = deps.writer ?? new OpenCodePassiveStatusSnapshotWriter({ rootDirectory: this.#rootDirectory })
    this.#now = deps.now ?? Date.now
    this.#canonicalizePath = deps.canonicalizePath ?? canonicalizeOpenCodePassiveProjectPath
    this.#readSnapshot = deps.readSnapshot ?? (async (scope, signal) => {
      if (signal.aborted) throw new Error('cancelled')
      try {
        const bytes = await readFile(getOpenCodePassiveSnapshotPath(this.#rootDirectory, scope))
        if (bytes.byteLength > OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES) return null
        return bytes.toString('utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    })
  }

  async publishInventory(inventory: OpenCodeInventorySnapshot, signal = new AbortController().signal): Promise<void> {
    if (inventory.probeError || signal.aborted) return
    const connected = new Map(inventory.connectedProviders.map(provider => [provider.id, provider]))
    const modelIds = new Map<string, string[]>()
    for (const model of inventory.models) {
      const parsed = parseOpenCodeExactProviderModelRef(model)
      if (!parsed) continue
      const values = modelIds.get(parsed.providerId) ?? []
      values.push(parsed.raw)
      modelIds.set(parsed.providerId, values)
    }
    const providerIds = new Set(
      [...inventory.availableProviders, ...connected.keys(), ...modelIds.keys()]
        .filter(providerId => tryCreateOpenCodeCanonicalProviderId(providerId) === providerId),
    )
    await this.#update(inventory.projectPath, signal, (snapshot, now) => {
      snapshot.binary = observation(
        { presence: inventory.detected ? 'present' as const : 'absent' as const, version: inventory.version },
        'binary_metadata', now,
      )
      for (const providerId of providerIds) {
        const provider = getOrCreateProvider(snapshot, providerId)
        if (connected.has(providerId)) {
          provider.configured = observation('configured', 'config_metadata', now)
          provider.lastConnected = observation({ state: 'connected', at: now }, 'auth_metadata', now)
        }
        if (inventory.detected) provider.catalogAvailable = observation(
          modelIds.has(providerId) || inventory.availableProviders.includes(providerId) ? 'available' : 'unavailable',
          'catalog_snapshot', now,
        )
        if (modelIds.has(providerId)) provider.modelIds = [...new Set(modelIds.get(providerId))]
      }
    })
  }

  async publishProviderUpdate(input: {
    projectPath: string; providerId: string; configured?: boolean; connected?: boolean
    catalogAvailable?: boolean; executionVerified?: boolean; modelIds?: readonly string[]
  }, signal = new AbortController().signal): Promise<void> {
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
      if (input.modelIds) provider.modelIds = [...new Set(input.modelIds)]
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
    const next = previous.catch(() => undefined).then(async () => {
      if (signal.aborted) return
      const now = this.#now()
      if (!Number.isSafeInteger(now) || now < 0) return
      const loaded = await this.#load(scope, signal)
      const snapshot = loaded ?? emptySnapshot(scope, now)
      snapshot.capturedAt = now
      mutate(snapshot, now)
      snapshot.providers.sort((left, right) => left.providerId.localeCompare(right.providerId))
      await this.#writer.write(snapshot, signal)
    })
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

function projectScope(canonicalPath: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update('opencode-project-scope-v1\0').update(canonicalPath).digest('hex')}`
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
