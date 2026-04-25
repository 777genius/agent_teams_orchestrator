import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  doesOpenCodeAuthStoreIncludeSource,
  mergeOpenCodeAuthStores,
  readOpenCodeAuthProviderSummaries,
  removeOpenCodeAuthCredential,
  syncOpenCodeManagedAuthStore,
  upsertOpenCodeApiAuthCredential,
} from './OpenCodeAuthStore.js'

describe('OpenCodeAuthStore', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-auth-store-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test('merges local source credentials without dropping app-managed providers', async () => {
    const sourceAuthPath = path.join(tempDir, 'source-auth.json')
    const managedAuthPath = path.join(tempDir, 'managed', 'auth.json')

    await mkdir(path.dirname(managedAuthPath), { recursive: true })
    await writeFile(
      sourceAuthPath,
      JSON.stringify({
        openai: { type: 'oauth' },
      }),
      'utf8',
    )
    await writeFile(
      managedAuthPath,
      JSON.stringify({
        openrouter: { type: 'api', key: 'sk-managed' },
      }),
      'utf8',
    )

    await syncOpenCodeManagedAuthStore({
      sourceAuthPath,
      managedAuthPath,
    })

    const merged = JSON.parse(await readFile(managedAuthPath, 'utf8')) as Record<string, unknown>
    expect(merged).toEqual({
      openrouter: { type: 'api', key: 'sk-managed' },
      openai: { type: 'oauth' },
    })
  })

  test('lets local source credentials win on provider conflicts', () => {
    expect(
      mergeOpenCodeAuthStores({
        source: { openrouter: { type: 'api', key: 'local-key' } },
        managed: { openrouter: { type: 'api', key: 'managed-key' } },
      }),
    ).toEqual({
      openrouter: { type: 'api', key: 'local-key' },
    })
  })

  test('writes and removes API-key auth without leaking the secret in provider summaries', async () => {
    const authPath = path.join(tempDir, 'data', 'opencode', 'auth.json')

    await upsertOpenCodeApiAuthCredential({
      authPath,
      providerId: 'OpenRouter',
      apiKey: 'sk-secret',
    })

    expect(await readOpenCodeAuthProviderSummaries(authPath)).toEqual([
      {
        id: 'openrouter',
        authHint: 'api',
        source: 'credentials',
      },
    ])

    await removeOpenCodeAuthCredential({
      authPath,
      providerId: 'openrouter',
    })

    expect(JSON.parse(await readFile(authPath, 'utf8'))).toEqual({})
  })

  test('reports whether managed auth includes all local source entries', () => {
    expect(
      doesOpenCodeAuthStoreIncludeSource({
        source: { openai: { type: 'oauth' } },
        managed: {
          openai: { type: 'oauth' },
          openrouter: { type: 'api', key: 'managed-key' },
        },
      }),
    ).toBe(true)

    expect(
      doesOpenCodeAuthStoreIncludeSource({
        source: { openai: { type: 'oauth' } },
        managed: { openrouter: { type: 'api', key: 'managed-key' } },
      }),
    ).toBe(false)
  })
})
