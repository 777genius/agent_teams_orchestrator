import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { writeJsonFileAtomic } from '../../utils/atomicWrite.js'

import type { OpenCodeApiAuthInput, OpenCodeConnectedProvider } from './types.js'

type OpenCodeAuthEntry = Record<string, unknown>
type OpenCodeAuthStore = Record<string, OpenCodeAuthEntry>

const authStoreWriteQueues = new Map<string, Promise<void>>()

async function withAuthStoreWriteLock<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockKey = path.resolve(filePath)
  const previous = authStoreWriteQueues.get(lockKey) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => {
    release = resolve
  })
  authStoreWriteQueues.set(lockKey, previous.then(() => current, () => current))

  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (authStoreWriteQueues.get(lockKey) === current) {
      authStoreWriteQueues.delete(lockKey)
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizeProviderId(value: string): string | null {
  const normalized = value.trim().toLowerCase()
  return normalized && /^[a-z0-9][a-z0-9._-]*$/i.test(normalized) ? normalized : null
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

async function writeOpenCodeAuthStore(filePath: string, authStore: OpenCodeAuthStore): Promise<void> {
  await writeJsonFileAtomic(filePath, authStore, { indent: 2 })
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
      authHint: typeof entry.type === 'string' && entry.type.trim()
        ? entry.type.trim().toLowerCase()
        : null,
      source: 'credentials' as const,
      ...(credentialScopes ? { credentialScopes } : {}),
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
}
