import { readFile } from 'node:fs/promises'

import { writeJsonFileAtomic } from '../../utils/atomicWrite.js'
import { withOpenCodeAuthCoordinationLock } from './OpenCodeAuthCoordinationLock.js'
import { throwOpenCodeAbortReason } from './OpenCodeRuntimeDeadline.js'

import type { OpenCodeApiAuthInput, OpenCodeConnectedProvider } from './types.js'

export type OpenCodeAuthCredential = Record<string, unknown>
type OpenCodeAuthEntry = OpenCodeAuthCredential
export type OpenCodeAuthStore = Record<string, OpenCodeAuthEntry>

async function withAuthStoreWriteLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  abortSignal?: AbortSignal,
): Promise<T> {
  return withOpenCodeAuthCoordinationLock({
    authPath: filePath,
    operation,
    description: 'OpenCode auth store coordination lock',
    abortSignal,
  })
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
  authPath: string
  providerId: string
  operation: () => Promise<T>
  abortSignal?: AbortSignal
}): Promise<T> {
  const providerId = normalizeProviderId(input.providerId)
  if (!providerId) {
    throw new Error('OpenCode OAuth refresh provider id is invalid')
  }

  return withOpenCodeAuthCoordinationLock({
    authPath: input.authPath,
    operation: input.operation,
    description: `OpenCode ${providerId} OAuth refresh coordination lock`,
    abortSignal: input.abortSignal,
  })
}

async function readOptionalJson(filePath: string): Promise<unknown | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    if (!raw.trim()) {
      return {}
    }
    return JSON.parse(raw) as unknown
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export async function readOpenCodeAuthStore(filePath: string): Promise<OpenCodeAuthStore> {
  const parsed = await readOptionalJson(filePath)
  if (!parsed) {
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
      continue
    }
    authStore[providerId] = { ...entry }
  }
  return authStore
}

export async function readOpenCodeAuthCredential(input: {
  authPath: string
  providerId: string
}): Promise<OpenCodeAuthCredential | null> {
  const providerId = normalizeProviderId(input.providerId)
  if (!providerId) {
    throw new Error('OpenCode provider id is invalid')
  }
  const authStore = await readOpenCodeAuthStore(input.authPath)
  const credential = authStore[providerId]
  return credential ? { ...credential } : null
}

async function writeOpenCodeAuthStore(
  filePath: string,
  authStore: OpenCodeAuthStore,
): Promise<void> {
  await writeJsonFileAtomic(filePath, authStore, { indent: 2, mode: 0o600 })
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
  sourceAuthPath: string
  managedAuthPath: string
}): Promise<void> {
  await withAuthStoreWriteLock(input.managedAuthPath, async () => {
    const source = await readOpenCodeAuthStore(input.sourceAuthPath)
    const managed = await readOpenCodeAuthStore(input.managedAuthPath)
    const merged = mergeOpenCodeAuthStores({ source, managed })

    if (JSON.stringify(merged) !== JSON.stringify(managed)) {
      await writeOpenCodeAuthStore(input.managedAuthPath, merged)
    }
  })
}

export async function reconcileOpenCodeManagedAuthStore(input: {
  sourceAuthPaths: readonly string[]
  managedAuthPath: string
}): Promise<void> {
  await withAuthStoreWriteLock(input.managedAuthPath, async () => {
    let expected: OpenCodeAuthStore = {}
    for (const sourceAuthPath of input.sourceAuthPaths) {
      expected = mergeOpenCodeAuthStores({
        source: await readOpenCodeAuthStore(sourceAuthPath),
        managed: expected,
      })
    }

    const managed = await readOpenCodeAuthStore(input.managedAuthPath)
    if (JSON.stringify(expected) !== JSON.stringify(managed)) {
      await writeOpenCodeAuthStore(input.managedAuthPath, expected)
    }
  })
}

export async function reconcileOpenCodeManagedAuthStores(input: {
  sourceAuthPaths: readonly string[]
  globalAuthPath: string
  managedAuthPath: string
  peerManagedAuthPaths?: readonly string[]
  abortSignal?: AbortSignal
}): Promise<void> {
  await withAuthStoreWriteLock(input.globalAuthPath, async () => {
    const peerManagedAuthPaths = Array.from(new Set([
      input.managedAuthPath,
      ...(input.peerManagedAuthPaths ?? []),
    ]))
    const [sourceStores, peerStores] = await Promise.all([
      Promise.all(input.sourceAuthPaths.map(readOpenCodeAuthStore)),
      Promise.all(peerManagedAuthPaths.map(readOpenCodeAuthStore)),
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

    const globalStore = await readOpenCodeAuthStore(input.globalAuthPath)
    const nextGlobalStore = { ...globalStore }
    for (const providerId of oauthProviderIds) {
      nextGlobalStore[providerId] = expected[providerId]
    }
    if (input.abortSignal?.aborted) throwOpenCodeAbortReason(input.abortSignal)
    if (JSON.stringify(nextGlobalStore) !== JSON.stringify(globalStore)) {
      await writeOpenCodeAuthStore(input.globalAuthPath, nextGlobalStore)
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
        await writeOpenCodeAuthStore(authPath, nextPeerStore)
      }
    }
  }, input.abortSignal)
}

export async function fanOutOpenCodeOAuthCredential(input: {
  providerId: string
  sourceAuthPath: string
  targetAuthPaths: readonly string[]
}): Promise<void> {
  const providerId = normalizeProviderId(input.providerId)
  if (!providerId) {
    throw new Error('OpenCode provider id is invalid')
  }
  const targetAuthPaths = Array.from(new Set(input.targetAuthPaths))
  const coordinationPath = targetAuthPaths[0] ?? input.sourceAuthPath
  await withAuthStoreWriteLock(coordinationPath, async () => {
    const authPaths = Array.from(new Set([input.sourceAuthPath, ...targetAuthPaths]))
    const stores = await Promise.all(authPaths.map(readOpenCodeAuthStore))
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
      })
    }
  })
}

export async function upsertOpenCodeApiAuthCredential(input: {
  authPath: string
  providerId: string
  apiKey: string
  metadata?: Record<string, string> | null
}): Promise<void> {
  await upsertOpenCodeApiAuth(input.authPath, input.providerId, {
    type: 'api',
    key: input.apiKey,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  })
}

export async function upsertOpenCodeAuthCredential(input: {
  authPath: string
  providerId: string
  credential: OpenCodeAuthCredential
}): Promise<void> {
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
    const authStore = await readOpenCodeAuthStore(input.authPath)
    authStore[providerId] = { ...input.credential, type: credentialType }
    await writeOpenCodeAuthStore(input.authPath, authStore)
  })
}

export async function upsertOpenCodeApiAuth(
  authPath: string,
  rawProviderId: string,
  auth: OpenCodeApiAuthInput,
): Promise<void> {
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
    const authStore = await readOpenCodeAuthStore(authPath)
    authStore[providerId] = {
      type: 'api',
      key: apiKey,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    }
    await writeOpenCodeAuthStore(authPath, authStore)
  })
}

export async function removeOpenCodeAuthCredential(input: {
  authPath: string
  providerId: string
}): Promise<void> {
  const providerId = normalizeProviderId(input.providerId)
  if (!providerId) {
    throw new Error('OpenCode provider id is invalid')
  }

  await withAuthStoreWriteLock(input.authPath, async () => {
    const authStore = await readOpenCodeAuthStore(input.authPath)
    if (!(providerId in authStore)) {
      return
    }
    delete authStore[providerId]
    await writeOpenCodeAuthStore(input.authPath, authStore)
  })
}

export async function readOpenCodeAuthProviderSummaries(
  authPath: string | null | undefined,
  credentialScopes?: Array<'managed' | 'local'>,
): Promise<OpenCodeConnectedProvider[]> {
  if (!authPath) {
    return []
  }

  const authStore = await readOpenCodeAuthStore(authPath)
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
