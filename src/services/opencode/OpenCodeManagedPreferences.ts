import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const OPEN_CODE_MANAGED_PREFERENCES_FILE = 'agent-teams-runtime-preferences.json'

export type OpenCodeManagedRuntimePreferences = {
  schemaVersion: 1
  defaultModelId: string | null
  updatedAt: string | null
}

export function getOpenCodeManagedPreferencesPath(profileRootPath: string): string {
  return path.join(profileRootPath, OPEN_CODE_MANAGED_PREFERENCES_FILE)
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

export async function writeOpenCodeManagedRuntimePreferences(
  profileRootPath: string,
  preferences: OpenCodeManagedRuntimePreferences,
): Promise<void> {
  await mkdir(profileRootPath, { recursive: true })
  const preferencesPath = getOpenCodeManagedPreferencesPath(profileRootPath)
  const tempPath = `${preferencesPath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(preferences, null, 2)}\n`, 'utf8')
  await rename(tempPath, preferencesPath)
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
