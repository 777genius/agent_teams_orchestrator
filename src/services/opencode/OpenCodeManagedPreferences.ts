import { readOpenCodeAuthorityFile } from './OpenCodeAuthorityFile.js'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

import { writeFileAtomic, writeJsonFileAtomic } from '../../utils/atomicWrite.js'
import { lock } from '../../utils/lockfile.js'

const OPEN_CODE_MANAGED_PREFERENCES_FILE = 'agent-teams-runtime-preferences.json'
const OPEN_CODE_GLOBAL_MANAGED_PREFERENCES_FILE = 'global-runtime-preferences.json'
export const OPEN_CODE_MANAGED_MODEL_LIMIT_MAX_TOKENS = 100_000_000

const preferenceWriteQueues = new Map<string, Promise<unknown>>()
const PREFERENCE_LOCK_STALE_MS = 30_000

export type OpenCodeManagedModelLimitOverride = {
  contextTokens: number
  outputTokens: number
  updatedAt: string | null
}

export type OpenCodeManagedRuntimePreferences = {
  schemaVersion: 2
  defaultModelId: string | null
  modelLimitOverrides: Record<string, OpenCodeManagedModelLimitOverride>
  updatedAt: string | null
}

export function getOpenCodeManagedPreferencesPath(profileRootPath: string): string {
  return path.join(profileRootPath, OPEN_CODE_MANAGED_PREFERENCES_FILE)
}

export function getOpenCodeGlobalManagedPreferencesPath(dataRootPath: string): string {
  return path.join(dataRootPath, 'opencode', OPEN_CODE_GLOBAL_MANAGED_PREFERENCES_FILE)
}

function emptyPreferences(): OpenCodeManagedRuntimePreferences {
  return {
    schemaVersion: 2,
    defaultModelId: null,
    modelLimitOverrides: {},
    updatedAt: null,
  }
}

function normalizeModelId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim()
  return normalized.includes('/') ? normalized : null
}

function normalizeTokenLimit(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= OPEN_CODE_MANAGED_MODEL_LIMIT_MAX_TOKENS
    ? value
    : null
}

function normalizeModelLimitOverrides(
  value: unknown,
): Record<string, OpenCodeManagedModelLimitOverride> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const normalized: Record<string, OpenCodeManagedModelLimitOverride> = {}
  for (const [modelId, rawOverride] of Object.entries(value)) {
    const normalizedModelId = normalizeModelId(modelId)
    if (!normalizedModelId || !rawOverride || typeof rawOverride !== 'object' || Array.isArray(rawOverride)) {
      continue
    }
    const override = rawOverride as Record<string, unknown>
    const contextTokens = normalizeTokenLimit(override.contextTokens)
    const outputTokens = normalizeTokenLimit(override.outputTokens)
    if (!contextTokens || !outputTokens || outputTokens > contextTokens) {
      continue
    }
    normalized[normalizedModelId] = {
      contextTokens,
      outputTokens,
      updatedAt: typeof override.updatedAt === 'string' ? override.updatedAt : null,
    }
  }
  return normalized
}

function normalizePreferences(value: unknown): OpenCodeManagedRuntimePreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return emptyPreferences()
  }
  const parsed = value as Partial<OpenCodeManagedRuntimePreferences>
  return {
    schemaVersion: 2,
    defaultModelId: normalizeModelId(parsed.defaultModelId),
    modelLimitOverrides: normalizeModelLimitOverrides(parsed.modelLimitOverrides),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
  }
}

async function withPreferenceWriteQueue<T>(
  preferencesPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = preferenceWriteQueues.get(preferencesPath) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(async () => {
    await mkdir(path.dirname(preferencesPath), { recursive: true })
    const release = await lock(preferencesPath, {
      realpath: false,
      stale: PREFERENCE_LOCK_STALE_MS,
      update: PREFERENCE_LOCK_STALE_MS / 3,
      retries: {
        retries: 100,
        factor: 1.2,
        minTimeout: 10,
        maxTimeout: 250,
        randomize: true,
      },
    })
    try {
      return await operation()
    } finally {
      await release()
    }
  })
  const tail = current.then(
    () => undefined,
    () => undefined,
  )
  preferenceWriteQueues.set(preferencesPath, tail)
  try {
    return await current
  } finally {
    if (preferenceWriteQueues.get(preferencesPath) === tail) {
      preferenceWriteQueues.delete(preferencesPath)
    }
  }
}

async function writePreferencesFile(
  preferencesPath: string,
  preferences: OpenCodeManagedRuntimePreferences,
): Promise<void> {
  await writeJsonFileAtomic(preferencesPath, normalizePreferences(preferences), { indent: 2 })
}

export async function readOpenCodeManagedRuntimePreferences(
  profileRootPath: string,
): Promise<OpenCodeManagedRuntimePreferences> {
  try {
    const raw = await readOpenCodeAuthorityFile(getOpenCodeManagedPreferencesPath(profileRootPath))
    return normalizePreferences(JSON.parse(raw))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyPreferences()
    throw new Error('OpenCode runtime preferences are unavailable')
  }
}

export async function readOpenCodeGlobalManagedRuntimePreferences(
  dataRootPath: string,
): Promise<OpenCodeManagedRuntimePreferences> {
  try {
    const raw = await readOpenCodeAuthorityFile(getOpenCodeGlobalManagedPreferencesPath(dataRootPath))
    return normalizePreferences(JSON.parse(raw))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyPreferences()
    throw new Error('OpenCode runtime preferences are unavailable')
  }
}

export async function writeOpenCodeManagedRuntimePreferences(
  profileRootPath: string,
  preferences: OpenCodeManagedRuntimePreferences,
): Promise<void> {
  const preferencesPath = getOpenCodeManagedPreferencesPath(profileRootPath)
  await withPreferenceWriteQueue(preferencesPath, () =>
    writePreferencesFile(preferencesPath, preferences),
  )
}

export type OpenCodeDefaultModelWriteGuard = {
  validate: () => Promise<void>
  ownRollback: (rollback: () => Promise<void>) => void
}

/** Called under the preference lock. Restore only this write's exact bytes;
 * a newer writer owns its own state and must never be overwritten by rollback. */
async function writeGuardedDefault(
  preferencesPath: string,
  preferences: OpenCodeManagedRuntimePreferences,
  guard?: OpenCodeDefaultModelWriteGuard,
): Promise<void> {
  if (!guard) return writePreferencesFile(preferencesPath, preferences)
  let previous: string | null = null
  try { previous = await readOpenCodeAuthorityFile(preferencesPath) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const written = JSON.stringify(normalizePreferences(preferences), null, 2)
  const restore = async () => {
    let current: string
    try { current = await readOpenCodeAuthorityFile(preferencesPath) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (current !== written) return
    if (previous === null) await rm(preferencesPath, { force: true })
    else await writeFileAtomic(preferencesPath, previous)
  }
  await guard.validate()
  guard.ownRollback(() => withPreferenceWriteQueue(preferencesPath, restore))
  try {
    await writeFileAtomic(preferencesPath, written)
    await guard.validate()
  } catch (error) {
    await restore()
    throw error
  }
}

export async function setOpenCodeManagedDefaultModel(
  profileRootPath: string,
  defaultModelId: string,
  guard?: OpenCodeDefaultModelWriteGuard,
): Promise<OpenCodeManagedRuntimePreferences> {
  const preferencesPath = getOpenCodeManagedPreferencesPath(profileRootPath)
  return withPreferenceWriteQueue(preferencesPath, async () => {
    const current = await readOpenCodeManagedRuntimePreferences(profileRootPath)
    const preferences: OpenCodeManagedRuntimePreferences = {
      ...current,
      schemaVersion: 2,
      defaultModelId: normalizeModelId(defaultModelId),
      updatedAt: new Date().toISOString(),
    }
    await writeGuardedDefault(preferencesPath, preferences, guard)
    return preferences
  })
}

export async function clearOpenCodeManagedDefaultModel(
  profileRootPath: string,
): Promise<OpenCodeManagedRuntimePreferences> {
  const preferencesPath = getOpenCodeManagedPreferencesPath(profileRootPath)
  return withPreferenceWriteQueue(preferencesPath, async () => {
    const current = await readOpenCodeManagedRuntimePreferences(profileRootPath)
    const preferences: OpenCodeManagedRuntimePreferences = {
      ...current,
      schemaVersion: 2,
      defaultModelId: null,
      updatedAt: new Date().toISOString(),
    }
    await writePreferencesFile(preferencesPath, preferences)
    return preferences
  })
}

export async function setOpenCodeManagedGlobalDefaultModel(
  dataRootPath: string,
  defaultModelId: string,
  guard?: OpenCodeDefaultModelWriteGuard,
): Promise<OpenCodeManagedRuntimePreferences> {
  const preferencesPath = getOpenCodeGlobalManagedPreferencesPath(dataRootPath)
  return withPreferenceWriteQueue(preferencesPath, async () => {
    const current = await readOpenCodeGlobalManagedRuntimePreferences(dataRootPath)
    const preferences: OpenCodeManagedRuntimePreferences = {
      ...current,
      schemaVersion: 2,
      defaultModelId: normalizeModelId(defaultModelId),
      updatedAt: new Date().toISOString(),
    }
    await writeGuardedDefault(preferencesPath, preferences, guard)
    return preferences
  })
}

export async function setOpenCodeManagedModelLimits(
  profileRootPath: string,
  input: {
    modelId: string
    contextTokens: number
    outputTokens: number
  },
): Promise<OpenCodeManagedRuntimePreferences> {
  const modelId = normalizeModelId(input.modelId)
  const contextTokens = normalizeTokenLimit(input.contextTokens)
  const outputTokens = normalizeTokenLimit(input.outputTokens)
  if (!modelId || !contextTokens || !outputTokens || outputTokens > contextTokens) {
    throw new Error('OpenCode managed model limits are invalid')
  }

  const preferencesPath = getOpenCodeManagedPreferencesPath(profileRootPath)
  return withPreferenceWriteQueue(preferencesPath, async () => {
    const current = await readOpenCodeManagedRuntimePreferences(profileRootPath)
    const updatedAt = new Date().toISOString()
    const preferences: OpenCodeManagedRuntimePreferences = {
      ...current,
      schemaVersion: 2,
      modelLimitOverrides: {
        ...current.modelLimitOverrides,
        [modelId]: { contextTokens, outputTokens, updatedAt },
      },
      updatedAt,
    }
    await writePreferencesFile(preferencesPath, preferences)
    return preferences
  })
}
