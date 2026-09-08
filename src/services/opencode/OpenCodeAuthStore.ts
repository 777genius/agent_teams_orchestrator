import { resolveBoundedAuthPath, validateOpenCodeBoundedPaths, assertBoundedAuthObjects, boundedCoordinationDatabase, type OpenCodeBoundedExecutionPaths } from './OpenCodeBoundedPaths.js'
import { readFile } from 'node:fs/promises'

import { writeJsonFileAtomic } from '../../utils/atomicWrite.js'
import { withOpenCodeAuthCoordinationLock } from './OpenCodeAuthCoordinationLock.js'
import { throwOpenCodeAbortReason } from './OpenCodeRuntimeDeadline.js'

import type { OpenCodeApiAuthInput, OpenCodeConnectedProvider } from './types.js'

export type OpenCodeAuthCredential = Record<string, unknown>
type OpenCodeAuthEntry = OpenCodeAuthCredential
export type OpenCodeAuthStore = Record<string, OpenCodeAuthEntry>

// Only leaf read/modify/replace operations enter this queue. The enclosing SQLite
// lease remains reentrant for preparation and OAuth refresh; sibling mutations
// inheriting that lease must still serialize their entire read/replace interval.
const boundedMutationTails = new Map<string, Promise<void>>()
async function serializeBoundedMutation<T>(
  c: OpenCodeBoundedExecutionPaths,
  operation: () => Promise<T>,
  abortSignal?: AbortSignal,
): Promise<T> {
  const key = boundedCoordinationDatabase(c.globalAuthPath, c)
  const previous = boundedMutationTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const tail = new Promise<void>(resolve => { release = resolve })
  boundedMutationTails.set(key, tail)
  await previous
  try {
    if (abortSignal?.aborted) throwOpenCodeAbortReason(abortSignal)
    return await operation()
  } finally {
    release()
    if (boundedMutationTails.get(key) === tail) boundedMutationTails.delete(key)
  }
}

async function withAuthStoreWriteLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  abortSignal?: AbortSignal,
  boundedPaths?: OpenCodeBoundedExecutionPaths,
): Promise<T> {
  if (boundedPaths) {
    resolveBoundedAuthPath(filePath, boundedPaths, true)
    await assertBoundedAuthDocuments(boundedPaths)
  }
  return withOpenCodeAuthCoordinationLock({
    authPath: filePath,
    boundedPaths,
    operation: boundedPaths ? () => serializeBoundedMutation(boundedPaths, async () => {
      // Recheck after waiting: an admitted sibling may have replaced a document.
      await assertBoundedAuthDocuments(boundedPaths)
      return operation()
    }, abortSignal) : operation,
    description: 'OpenCode auth store coordination lock',
    abortSignal,
  })
}

async function assertBoundedAuthDocuments(c: OpenCodeBoundedExecutionPaths): Promise<void> {
  await assertBoundedAuthObjects(c)
  await Promise.all([...c.immutableAuthPaths, ...c.authStores.map(s => s.logicalPath)]
    .map(p => readOpenCodeAuthStore(p, c)))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalizeProviderId(value: string): string | null {
  const normalized = value.trim().toLowerCase()
  return normalized && /^[a-z0-9][a-z0-9._-]*$/i.test(normalized) ? normalized : null
}

export async function withOpenCodeOAuthRefreshLock<T>(input: {
  boundedPaths?: OpenCodeBoundedExecutionPaths
  authPath: string
  providerId: string
  operation: () => Promise<T>
  abortSignal?: AbortSignal
}): Promise<T> {
  if (input.boundedPaths) input = { ...input, boundedPaths: validateOpenCodeBoundedPaths(input.boundedPaths) }
  const providerId = normalizeProviderId(input.providerId)
  if (!providerId) {
    throw new Error('OpenCode OAuth refresh provider id is invalid')
  }

  if (input.boundedPaths) await assertBoundedAuthDocuments(input.boundedPaths)
  return withOpenCodeAuthCoordinationLock({
    authPath: input.authPath,
    boundedPaths: input.boundedPaths,
    operation: input.operation,
    description: `OpenCode ${providerId} OAuth refresh coordination lock`,
    abortSignal: input.abortSignal,
  })
}

const missingAuthDocument = Symbol('missing auth document')
async function readOptionalJson(filePath: string, strict = false): Promise<unknown> {
  try {
    const raw = await readFile(filePath, 'utf8')
    if (!raw.trim()) {
      if (strict) throw new Error(`OpenCode auth store is not a JSON object: ${filePath}`)
      return {}
    }
    return JSON.parse(raw) as unknown
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return missingAuthDocument
    }
    throw error
  }
}

export async function readOpenCodeAuthStore(filePath: string, boundedPaths?: OpenCodeBoundedExecutionPaths): Promise<OpenCodeAuthStore> {
  if (boundedPaths) boundedPaths = validateOpenCodeBoundedPaths(boundedPaths)
  const parsed = await readOptionalJson(resolveBoundedAuthPath(filePath, boundedPaths), !!boundedPaths)
  if (parsed === missingAuthDocument || (!boundedPaths && !parsed)) {
    return {}
  }

  const record = asRecord(parsed)
  if (!record) {
    throw new Error(`OpenCode auth store is not a JSON object: ${filePath}`)
  }

  const authStore: OpenCodeAuthStore = {}
  for (const [rawProviderId, rawEntry] of Object.entries(record)) {
    const providerId = normalizeProviderId(rawProviderId)
    const entry = asRecord(rawEntry)
    if (!providerId || !entry) {
      if (boundedPaths) throw new Error(`OpenCode auth store has an invalid entry: ${filePath}`)
      continue
    }
    authStore[providerId] = { ...entry }
  }
  return authStore
}

export async function readOpenCodeAuthCredential(input: {
  boundedPaths?: OpenCodeBoundedExecutionPaths
  authPath: string
  providerId: string
}): Promise<OpenCodeAuthCredential | null> {
  if (input.boundedPaths) input = { ...input, boundedPaths: validateOpenCodeBoundedPaths(input.boundedPaths) }
  const providerId = normalizeProviderId(input.providerId)
  if (!providerId) {
    throw new Error('OpenCode provider id is invalid')
  }
  const authStore = await readOpenCodeAuthStore(input.authPath, input.boundedPaths)
  const credential = authStore[providerId]
  return credential ? { ...credential } : null
}

async function writeOpenCodeAuthStore(
  filePath: string,
  authStore: OpenCodeAuthStore,
  boundedPaths?: OpenCodeBoundedExecutionPaths,
): Promise<void> {
  await writeJsonFileAtomic(resolveBoundedAuthPath(filePath, boundedPaths, true), authStore, { indent: 2, mode: 0o600 })
}

export function mergeOpenCodeAuthStores(input: {
  source: OpenCodeAuthStore
  managed: OpenCodeAuthStore
}): OpenCodeAuthStore {
  return {
    ...input.managed,
    ...input.source,
  }
}

function getOpenCodeOAuthExpires(credential: OpenCodeAuthCredential | undefined): number | null {
  if (credential?.type !== 'oauth') {
    return null
  }
  const expires = credential.expires
  return typeof expires === 'number' && Number.isFinite(expires) && expires >= 0
    ? expires
    : null
}

function pickFreshestOpenCodeOAuthCredential(
  current: OpenCodeAuthCredential,
  candidate: OpenCodeAuthCredential,
  preferCandidateOnTie: boolean,
): OpenCodeAuthCredential {
  const currentExpires = getOpenCodeOAuthExpires(current)
  const candidateExpires = getOpenCodeOAuthExpires(candidate)
  if (currentExpires === null || candidateExpires === null) {
    return preferCandidateOnTie ? candidate : current
  }
  if (candidateExpires === currentExpires) {
    return preferCandidateOnTie ? candidate : current
  }
  return candidateExpires > currentExpires ? candidate : current
}

export function mergeOpenCodeAuthStoresWithFreshestOAuth(input: {
  source: OpenCodeAuthStore
  managed: OpenCodeAuthStore
}): OpenCodeAuthStore {
  const merged = { ...input.managed }
  for (const [providerId, sourceCredential] of Object.entries(input.source)) {
    const managedCredential = merged[providerId]
    merged[providerId] = managedCredential?.type === 'oauth' && sourceCredential.type === 'oauth'
      ? pickFreshestOpenCodeOAuthCredential(managedCredential, sourceCredential, true)
      : sourceCredential
  }
  return merged
}

export function mergeOpenCodeManagedAuthSources(input: {
  sourceAuthPaths: readonly string[]
  sourceStores: readonly OpenCodeAuthStore[]
  globalAuthPath: string
}): OpenCodeAuthStore {
  let expected: OpenCodeAuthStore = {}
  for (const source of input.sourceStores) {
    expected = mergeOpenCodeAuthStoresWithFreshestOAuth({ source, managed: expected })
  }

  const globalSourceIndex = input.sourceAuthPaths.indexOf(input.globalAuthPath)
  const globalSourceStore = globalSourceIndex >= 0 ? input.sourceStores[globalSourceIndex] : {}
  // API credentials explicitly saved through Agent Teams belong to the app-global
  // store and must shadow stale credentials imported from the user's OpenCode store.
  // OAuth remains freshness-based because OpenCode may refresh it outside the app.
  for (const [providerId, credential] of Object.entries(globalSourceStore)) {
    if (credential.type === 'api') {
      expected[providerId] = credential
    }
  }

  return expected
}

export function doesOpenCodeAuthStoreIncludeSource(input: {
  source: OpenCodeAuthStore
  managed: OpenCodeAuthStore
}): boolean {
  for (const [providerId, sourceEntry] of Object.entries(input.source)) {
    const managedEntry = input.managed[providerId]
    if (!managedEntry || JSON.stringify(managedEntry) !== JSON.stringify(sourceEntry)) {
      return false
    }
  }
  return true
}

export async function syncOpenCodeManagedAuthStore(input: {
  boundedPaths?: OpenCodeBoundedExecutionPaths
  sourceAuthPath: string
  managedAuthPath: string
}): Promise<void> {
  if (input.boundedPaths) input = { ...input, boundedPaths: validateOpenCodeBoundedPaths(input.boundedPaths) }
  if (input.boundedPaths) resolveBoundedAuthPath(input.sourceAuthPath, input.boundedPaths)
  await withAuthStoreWriteLock(input.managedAuthPath, async () => {
    const source = await readOpenCodeAuthStore(input.sourceAuthPath, input.boundedPaths)
    const managed = await readOpenCodeAuthStore(input.managedAuthPath, input.boundedPaths)
    const merged = mergeOpenCodeAuthStores({ source, managed })

    if (JSON.stringify(merged) !== JSON.stringify(managed)) {
      await writeOpenCodeAuthStore(input.managedAuthPath, merged, input.boundedPaths)
    }
  }, undefined, input.boundedPaths)
}

/** Global first, then immutable admission order. Only ENOENT may omit a source;
 * present invalid bytes always reject. Later imports win OAuth ties, global API
 * wins regardless of position; imported OAuth ties beat selected, then sorted peers.
 */
async function assertBoundedReconciliationSources(
  sourceAuthPaths: readonly string[], c: OpenCodeBoundedExecutionPaths,
): Promise<void> {
  const expected: string[] = []
  for (const logical of [c.globalAuthPath, ...c.immutableAuthPaths]) {
    const parsed = await readOptionalJson(resolveBoundedAuthPath(logical, c), true)
    if (parsed === missingAuthDocument) continue
    // Use the exported reader's complete shape validation before any mutation.
    await readOpenCodeAuthStore(logical, c)
    expected.push(logical)
  }
  if (JSON.stringify(sourceAuthPaths) !== JSON.stringify(expected)) {
    throw new Error('opencode_bounded_auth_sources')
  }
}

export async function reconcileOpenCodeManagedAuthStore(input: {
  boundedPaths?: OpenCodeBoundedExecutionPaths
  sourceAuthPaths: readonly string[]
  managedAuthPath: string
}): Promise<void> {
  if (input.boundedPaths) input = { ...input, boundedPaths: validateOpenCodeBoundedPaths(input.boundedPaths), sourceAuthPaths: input.sourceAuthPaths ? [...input.sourceAuthPaths] : [] }
  if (input.boundedPaths) {
    return reconcileOpenCodeManagedAuthStores({ ...input,
      globalAuthPath: input.boundedPaths.globalAuthPath,
      peerManagedAuthPaths: input.boundedPaths.authStores.filter(s => s.logicalPath !== input.boundedPaths!.globalAuthPath).map(s => s.logicalPath),
    })
  }
  await withAuthStoreWriteLock(input.managedAuthPath, async () => {
    let expected: OpenCodeAuthStore = {}
    for (const sourceAuthPath of input.sourceAuthPaths) {
      expected = mergeOpenCodeAuthStores({
        source: await readOpenCodeAuthStore(sourceAuthPath, input.boundedPaths),
        managed: expected,
      })
    }

    const managed = await readOpenCodeAuthStore(input.managedAuthPath, input.boundedPaths)
    if (JSON.stringify(expected) !== JSON.stringify(managed)) {
      await writeOpenCodeAuthStore(input.managedAuthPath, expected, input.boundedPaths)
    }
  }, undefined, input.boundedPaths)
}

export async function reconcileOpenCodeManagedAuthStores(input: {
  boundedPaths?: OpenCodeBoundedExecutionPaths
  sourceAuthPaths: readonly string[]
  globalAuthPath: string
  managedAuthPath: string
  peerManagedAuthPaths?: readonly string[]
  abortSignal?: AbortSignal
}): Promise<void> {
  if (input.boundedPaths) input = { ...input, boundedPaths: validateOpenCodeBoundedPaths(input.boundedPaths), sourceAuthPaths: input.sourceAuthPaths ? [...input.sourceAuthPaths] : [], peerManagedAuthPaths: input.peerManagedAuthPaths ? [...input.peerManagedAuthPaths] : undefined }
  if (input.boundedPaths) {
    const c = validateOpenCodeBoundedPaths(input.boundedPaths)
    const peers = c.authStores.filter(s => s.logicalPath !== c.globalAuthPath).map(s => s.logicalPath).sort()
    if (input.globalAuthPath !== c.globalAuthPath || input.managedAuthPath !== c.selectedAuthPath
      || JSON.stringify([...new Set([input.managedAuthPath, ...(input.peerManagedAuthPaths ?? [])])].sort()) !== JSON.stringify(peers)) {
      throw new Error('opencode_bounded_auth_membership')
    }
    await assertBoundedAuthObjects(c)
    await assertBoundedReconciliationSources(input.sourceAuthPaths, c)
  }
  await withAuthStoreWriteLock(input.globalAuthPath, async () => {
    if (input.boundedPaths) await assertBoundedReconciliationSources(input.sourceAuthPaths, input.boundedPaths)
    // Selected wins equal-expiry peer ties; other peers use code-unit path order.
    const otherPeers = (input.peerManagedAuthPaths ?? []).filter(p => p !== input.managedAuthPath)
    const peerManagedAuthPaths = Array.from(new Set([
      input.managedAuthPath,
      ...(input.boundedPaths ? [...otherPeers].sort() : otherPeers),
    ]))
    const [sourceStores, peerStores] = await Promise.all([
      Promise.all(input.sourceAuthPaths.map(p => readOpenCodeAuthStore(p, input.boundedPaths))),
      Promise.all(peerManagedAuthPaths.map(p => readOpenCodeAuthStore(p, input.boundedPaths))),
    ])
    if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)

    const expected = mergeOpenCodeManagedAuthSources({
      sourceAuthPaths: input.sourceAuthPaths,
      sourceStores,
      globalAuthPath: input.globalAuthPath,
    })

    const oauthProviderIds = Object.entries(expected)
      .filter(([, credential]) => credential.type === 'oauth')
      .map(([providerId]) => providerId)
    const recoveredProviderIds = new Set<string>()
    for (const providerId of oauthProviderIds) {
      let freshest = expected[providerId]
      for (const peerStore of peerStores) {
        const candidate = peerStore[providerId]
        if (candidate?.type === 'oauth') {
          freshest = pickFreshestOpenCodeOAuthCredential(freshest, candidate, false)
        }
      }
      if (JSON.stringify(freshest) !== JSON.stringify(expected[providerId])) {
        recoveredProviderIds.add(providerId)
      }
      expected[providerId] = freshest
    }

    const globalStore = await readOpenCodeAuthStore(input.globalAuthPath, input.boundedPaths)
    const nextGlobalStore = { ...globalStore }
    for (const providerId of oauthProviderIds) {
      nextGlobalStore[providerId] = expected[providerId]
    }
    if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
    if (JSON.stringify(nextGlobalStore) !== JSON.stringify(globalStore)) {
      await writeOpenCodeAuthStore(input.globalAuthPath, nextGlobalStore, input.boundedPaths)
    }

    for (let index = 0; index < peerManagedAuthPaths.length; index += 1) {
      if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
      const authPath = peerManagedAuthPaths[index]
      const peerStore = peerStores[index]
      const nextPeerStore = authPath === input.managedAuthPath
        ? { ...expected }
        : { ...peerStore }
      const providerIdsToFanOut = authPath === input.managedAuthPath
        ? oauthProviderIds
        : Array.from(recoveredProviderIds)
      for (const providerId of providerIdsToFanOut) {
        nextPeerStore[providerId] = expected[providerId]
      }
      if (JSON.stringify(nextPeerStore) !== JSON.stringify(peerStore)) {
        await writeOpenCodeAuthStore(authPath, nextPeerStore, input.boundedPaths)
      }
    }
  }, input.abortSignal, input.boundedPaths)
}

export async function fanOutOpenCodeOAuthCredential(input: {
  boundedPaths?: OpenCodeBoundedExecutionPaths
  providerId: string
  sourceAuthPath: string
  targetAuthPaths: readonly string[]
}): Promise<void> {
  if (input.boundedPaths) input = { ...input, boundedPaths: validateOpenCodeBoundedPaths(input.boundedPaths), targetAuthPaths: input.targetAuthPaths ? [...input.targetAuthPaths] : [] }
  const providerId = normalizeProviderId(input.providerId)
  if (!providerId) {
    throw new Error('OpenCode provider id is invalid')
  }
  if (input.boundedPaths) {
    const c = validateOpenCodeBoundedPaths(input.boundedPaths)
    const members = [...new Set([input.sourceAuthPath, ...input.targetAuthPaths])].sort()
    if (JSON.stringify(members) !== JSON.stringify(c.authStores.map(s => s.logicalPath).sort())) throw new Error('opencode_bounded_auth_membership')
  }
  // Source wins ties, then global, then selected, then canonical other peers.
  const targetAuthPaths = Array.from(new Set(input.boundedPaths
    ? [input.boundedPaths.globalAuthPath, input.boundedPaths.selectedAuthPath,
      ...input.targetAuthPaths.slice().sort()].filter(p => p !== input.sourceAuthPath)
    : input.targetAuthPaths))
  const coordinationPath = targetAuthPaths[0] ?? input.sourceAuthPath
  await withAuthStoreWriteLock(coordinationPath, async () => {
    const authPaths = Array.from(new Set([input.sourceAuthPath, ...targetAuthPaths]))
    const stores = await Promise.all(authPaths.map(p => readOpenCodeAuthStore(p, input.boundedPaths)))
    let freshest: OpenCodeAuthCredential | null = null
    for (const store of stores) {
      const candidate = store[providerId]
      if (candidate?.type !== 'oauth') {
        continue
      }
      freshest = freshest
        ? pickFreshestOpenCodeOAuthCredential(freshest, candidate, false)
        : candidate
    }
    if (!freshest) {
      return
    }

    for (let index = 0; index < authPaths.length; index += 1) {
      const authStore = stores[index]
      if (JSON.stringify(authStore[providerId]) === JSON.stringify(freshest)) {
        continue
      }
      await writeOpenCodeAuthStore(authPaths[index], {
        ...authStore,
        [providerId]: freshest,
      }, input.boundedPaths)
    }
  }, undefined, input.boundedPaths)
}

export async function upsertOpenCodeApiAuthCredential(input: {
  boundedPaths?: OpenCodeBoundedExecutionPaths
  authPath: string
  providerId: string
  apiKey: string
  metadata?: Record<string, string> | null
}): Promise<void> {
  if (input.boundedPaths) input = { ...input, boundedPaths: validateOpenCodeBoundedPaths(input.boundedPaths) }
  await upsertOpenCodeApiAuth(input.authPath, input.providerId, {
    type: 'api',
    key: input.apiKey,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  }, input.boundedPaths)
}

export async function upsertOpenCodeAuthCredential(input: {
  boundedPaths?: OpenCodeBoundedExecutionPaths
  authPath: string
  providerId: string
  credential: OpenCodeAuthCredential
}): Promise<void> {
  if (input.boundedPaths) input = { ...input, boundedPaths: validateOpenCodeBoundedPaths(input.boundedPaths) }
  const providerId = normalizeProviderId(input.providerId)
  if (!providerId) {
    throw new Error('OpenCode provider id is invalid')
  }
  const credentialType =
    typeof input.credential.type === 'string' ? input.credential.type.trim().toLowerCase() : ''
  if (!credentialType) {
    throw new Error('OpenCode auth credential type is required')
  }

  await withAuthStoreWriteLock(input.authPath, async () => {
    const authStore = await readOpenCodeAuthStore(input.authPath, input.boundedPaths)
    authStore[providerId] = { ...input.credential, type: credentialType }
    await writeOpenCodeAuthStore(input.authPath, authStore, input.boundedPaths)
  }, undefined, input.boundedPaths)
}

export async function upsertOpenCodeApiAuth(
  authPath: string,
  rawProviderId: string,
  auth: OpenCodeApiAuthInput,
  boundedPaths?: OpenCodeBoundedExecutionPaths,
): Promise<void> {
  if (boundedPaths) boundedPaths = validateOpenCodeBoundedPaths(boundedPaths)
  const providerId = normalizeProviderId(rawProviderId)
  if (!providerId) {
    throw new Error('OpenCode provider id is invalid')
  }

  const apiKey = auth.key.trim()
  if (!apiKey) {
    throw new Error('OpenCode API key is required')
  }

  const metadata: Record<string, string> = {}
  for (const [key, value] of Object.entries(auth.metadata ?? {})) {
    const normalizedKey = key.trim()
    const normalizedValue = value.trim()
    if (normalizedKey && normalizedValue) {
      metadata[normalizedKey] = normalizedValue
    }
  }

  await withAuthStoreWriteLock(authPath, async () => {
    const authStore = await readOpenCodeAuthStore(authPath, boundedPaths)
    authStore[providerId] = {
      type: 'api',
      key: apiKey,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    }
    await writeOpenCodeAuthStore(authPath, authStore, boundedPaths)
  }, undefined, boundedPaths)
}

export async function removeOpenCodeAuthCredential(input: {
  boundedPaths?: OpenCodeBoundedExecutionPaths
  authPath: string
  providerId: string
}): Promise<void> {
  if (input.boundedPaths) input = { ...input, boundedPaths: validateOpenCodeBoundedPaths(input.boundedPaths) }
  const providerId = normalizeProviderId(input.providerId)
  if (!providerId) {
    throw new Error('OpenCode provider id is invalid')
  }

  await withAuthStoreWriteLock(input.authPath, async () => {
    const authStore = await readOpenCodeAuthStore(input.authPath, input.boundedPaths)
    if (!(providerId in authStore)) {
      return
    }
    delete authStore[providerId]
    await writeOpenCodeAuthStore(input.authPath, authStore, input.boundedPaths)
  }, undefined, input.boundedPaths)
}

export async function readOpenCodeAuthProviderSummaries(
  authPath: string | null | undefined,
  credentialScopes?: Array<'managed' | 'local'>,
  boundedPaths?: OpenCodeBoundedExecutionPaths,
): Promise<OpenCodeConnectedProvider[]> {
  if (!authPath) {
    return []
  }

  const authStore = await readOpenCodeAuthStore(authPath, boundedPaths)
  return Object.entries(authStore)
    .map(([providerId, entry]) => ({
      id: providerId,
      authHint:
        typeof entry.type === 'string' && entry.type.trim()
          ? entry.type.trim().toLowerCase()
          : null,
      source: 'credentials' as const,
      ...(credentialScopes ? { credentialScopes } : {}),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
}
