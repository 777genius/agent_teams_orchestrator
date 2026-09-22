import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  clearOpenCodeManagedDefaultModel,
  getOpenCodeManagedPreferencesPath,
  readOpenCodeManagedRuntimePreferences,
  setOpenCodeManagedDefaultModel,
  setOpenCodeManagedModelLimits,
  writeOpenCodeManagedRuntimePreferences,
} from './OpenCodeManagedPreferences.js'

const tempDirs: string[] = []

async function makeProfile(): Promise<string> {
  const profileRootPath = await mkdtemp(path.join(os.tmpdir(), 'opencode-managed-preferences-'))
  tempDirs.push(profileRootPath)
  return profileRootPath
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(tempDir => rm(tempDir, { recursive: true, force: true })))
})

describe('OpenCodeManagedPreferences', () => {
  test('clears only the project default and preserves model limits', async () => {
    const profileRootPath = await makeProfile()
    await setOpenCodeManagedDefaultModel(profileRootPath, 'local/default-model')
    await setOpenCodeManagedModelLimits(profileRootPath, {
      modelId: 'local/model-a',
      contextTokens: 32_000,
      outputTokens: 4_000,
    })

    await clearOpenCodeManagedDefaultModel(profileRootPath)

    const preferences = await readOpenCodeManagedRuntimePreferences(profileRootPath)
    expect(preferences.defaultModelId).toBeNull()
    expect(preferences.modelLimitOverrides['local/model-a']).toMatchObject({
      contextTokens: 32_000,
      outputTokens: 4_000,
    })
  })

  test('serializes concurrent default and model-limit updates for one profile', async () => {
    const profileRootPath = await makeProfile()

    await Promise.all([
      setOpenCodeManagedDefaultModel(profileRootPath, 'local/default-model'),
      setOpenCodeManagedModelLimits(profileRootPath, {
        modelId: 'local/model-a',
        contextTokens: 32_000,
        outputTokens: 4_000,
      }),
      setOpenCodeManagedModelLimits(profileRootPath, {
        modelId: 'local/model-b',
        contextTokens: 64_000,
        outputTokens: 8_000,
      }),
    ])

    const preferences = await readOpenCodeManagedRuntimePreferences(profileRootPath)
    expect(preferences.defaultModelId).toBe('local/default-model')
    expect(preferences.modelLimitOverrides).toMatchObject({
      'local/model-a': { contextTokens: 32_000, outputTokens: 4_000 },
      'local/model-b': { contextTokens: 64_000, outputTokens: 8_000 },
    })
  })

  test('serializes model-limit updates across separate CLI processes', async () => {
    const profileRootPath = await makeProfile()
    const moduleUrl = new URL('./OpenCodeManagedPreferences.ts', import.meta.url).href
    const spawnUpdate = (modelId: string, contextTokens: number, outputTokens: number) =>
      Bun.spawn(
        [
          process.execPath,
          '-e',
          `import { setOpenCodeManagedModelLimits } from ${JSON.stringify(moduleUrl)}; await setOpenCodeManagedModelLimits(${JSON.stringify(profileRootPath)}, ${JSON.stringify({ modelId, contextTokens, outputTokens })});`,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )
    const processes = [
      spawnUpdate('local/process-a', 32_000, 4_000),
      spawnUpdate('local/process-b', 64_000, 8_000),
    ]

    const exitCodes = await Promise.all(processes.map(process => process.exited))
    const stderr = await Promise.all(
      processes.map(process => new Response(process.stderr).text()),
    )
    expect(exitCodes, stderr.join('\n')).toEqual([0, 0])

    const preferences = await readOpenCodeManagedRuntimePreferences(profileRootPath)
    expect(preferences.modelLimitOverrides).toMatchObject({
      'local/process-a': { contextTokens: 32_000, outputTokens: 4_000 },
      'local/process-b': { contextTokens: 64_000, outputTokens: 8_000 },
    })
  })

  test('preserves a schema v1 default when adding the first model limit', async () => {
    const profileRootPath = await makeProfile()
    await writeFile(
      getOpenCodeManagedPreferencesPath(profileRootPath),
      JSON.stringify({
        schemaVersion: 1,
        defaultModelId: 'local/legacy-default',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    )

    await setOpenCodeManagedModelLimits(profileRootPath, {
      modelId: 'local/new-model',
      contextTokens: 16_000,
      outputTokens: 2_000,
    })

    const preferences = await readOpenCodeManagedRuntimePreferences(profileRootPath)
    expect(preferences.schemaVersion).toBe(2)
    expect(preferences.defaultModelId).toBe('local/legacy-default')
    expect(preferences.modelLimitOverrides['local/new-model']).toMatchObject({
      contextTokens: 16_000,
      outputTokens: 2_000,
    })
  })

  test('rejects limits above the shared upper bound and filters them while reading', async () => {
    const profileRootPath = await makeProfile()
    await expect(
      setOpenCodeManagedModelLimits(profileRootPath, {
        modelId: 'local/too-large',
        contextTokens: 100_000_001,
        outputTokens: 1,
      }),
    ).rejects.toThrow('OpenCode managed model limits are invalid')

    await writeFile(
      getOpenCodeManagedPreferencesPath(profileRootPath),
      JSON.stringify({
        schemaVersion: 2,
        defaultModelId: null,
        modelLimitOverrides: {
          'local/too-large': {
            contextTokens: 100_000_001,
            outputTokens: 1,
            updatedAt: null,
          },
          'local/valid': {
            contextTokens: 100_000_000,
            outputTokens: 100_000_000,
            updatedAt: null,
          },
        },
        updatedAt: null,
      }),
    )

    const preferences = await readOpenCodeManagedRuntimePreferences(profileRootPath)
    expect(preferences.modelLimitOverrides['local/too-large']).toBeUndefined()
    expect(preferences.modelLimitOverrides['local/valid']).toMatchObject({
      contextTokens: 100_000_000,
      outputTokens: 100_000_000,
    })
  })

  test('never persists an out-of-range override through the direct writer', async () => {
    const profileRootPath = await makeProfile()
    await writeOpenCodeManagedRuntimePreferences(profileRootPath, {
      schemaVersion: 2,
      defaultModelId: null,
      modelLimitOverrides: {
        'local/too-large': {
          contextTokens: 100_000_001,
          outputTokens: 1,
          updatedAt: null,
        },
      },
      updatedAt: null,
    })

    const persisted = JSON.parse(
      await readFile(getOpenCodeManagedPreferencesPath(profileRootPath), 'utf8'),
    ) as { modelLimitOverrides?: Record<string, unknown> }
    expect(persisted.modelLimitOverrides).toEqual({})
  })
})
