import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { writeJsonFileAtomic } from '../../utils/atomicWrite.js'

const OPEN_CODE_MANAGED_PREFERENCES_FILE = 'agent-teams-runtime-preferences.json'
const OPEN_CODE_GLOBAL_MANAGED_PREFERENCES_FILE = 'global-runtime-preferences.json'

export type OpenCodeManagedRuntimePreferences = {
  schemaVersion: 1
  defaultModelId: string | null
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
    schemaVersion: 1,
    defaultModelId: null,
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

export async function readOpenCodeManagedRuntimePreferences(
  profileRootPath: string,
): Promise<OpenCodeManagedRuntimePreferences> {
  try {
    const raw = await readFile(getOpenCodeManagedPreferencesPath(profileRootPath), 'utf8')
    const parsed = JSON.parse(raw) as Partial<OpenCodeManagedRuntimePreferences>
    return {
      schemaVersion: 1,
      defaultModelId: normalizeModelId(parsed.defaultModelId),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    }
  } catch {
    return emptyPreferences()
  }
}

export async function readOpenCodeGlobalManagedRuntimePreferences(
  dataRootPath: string,
): Promise<OpenCodeManagedRuntimePreferences> {
  try {
    const raw = await readFile(getOpenCodeGlobalManagedPreferencesPath(dataRootPath), 'utf8')
    const parsed = JSON.parse(raw) as Partial<OpenCodeManagedRuntimePreferences>
    return {
      schemaVersion: 1,
      defaultModelId: normalizeModelId(parsed.defaultModelId),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    }
  } catch {
    return emptyPreferences()
  }
}

export async function writeOpenCodeManagedRuntimePreferences(
  profileRootPath: string,
  preferences: OpenCodeManagedRuntimePreferences,
): Promise<void> {
  const preferencesPath = getOpenCodeManagedPreferencesPath(profileRootPath)
  await writeJsonFileAtomic(preferencesPath, preferences, { indent: 2 })
}

export async function setOpenCodeManagedDefaultModel(
  profileRootPath: string,
  defaultModelId: string,
): Promise<OpenCodeManagedRuntimePreferences> {
  const preferences: OpenCodeManagedRuntimePreferences = {
    schemaVersion: 1,
    defaultModelId,
    updatedAt: new Date().toISOString(),
  }
  await writeOpenCodeManagedRuntimePreferences(profileRootPath, preferences)
  return preferences
}

export async function setOpenCodeManagedGlobalDefaultModel(
  dataRootPath: string,
  defaultModelId: string,
): Promise<OpenCodeManagedRuntimePreferences> {
  const preferences: OpenCodeManagedRuntimePreferences = {
    schemaVersion: 1,
    defaultModelId,
    updatedAt: new Date().toISOString(),
  }
  const preferencesPath = getOpenCodeGlobalManagedPreferencesPath(dataRootPath)
  await writeJsonFileAtomic(preferencesPath, preferences, { indent: 2 })
  return preferences
}
