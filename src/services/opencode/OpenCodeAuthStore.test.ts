import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  doesOpenCodeAuthStoreIncludeSource,
  mergeOpenCodeAuthStores,
  readOpenCodeAuthProviderSummaries,
  readOpenCodeAuthCredential,
  reconcileOpenCodeManagedAuthStore,
  removeOpenCodeAuthCredential,
  syncOpenCodeManagedAuthStore,
  upsertOpenCodeApiAuthCredential,
  upsertOpenCodeAuthCredential,
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

  test('serializes concurrent managed auth syncs without dropping providers', async () => {
    const firstSourceAuthPath = path.join(tempDir, 'first-source-auth.json')
    const secondSourceAuthPath = path.join(tempDir, 'second-source-auth.json')
    const managedAuthPath = path.join(tempDir, 'managed', 'auth.json')

    await mkdir(path.dirname(managedAuthPath), { recursive: true })
    await writeFile(
      firstSourceAuthPath,
      JSON.stringify({
        openai: { type: 'oauth' },
      }),
      'utf8',
    )
    await writeFile(
      secondSourceAuthPath,
      JSON.stringify({
        anthropic: { type: 'api', key: 'sk-anthropic' },
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

    await Promise.all([
      syncOpenCodeManagedAuthStore({
        sourceAuthPath: firstSourceAuthPath,
        managedAuthPath,
      }),
      syncOpenCodeManagedAuthStore({
        sourceAuthPath: secondSourceAuthPath,
        managedAuthPath,
      }),
    ])

    const merged = JSON.parse(await readFile(managedAuthPath, 'utf8')) as Record<string, unknown>
    expect(merged).toEqual({
      openrouter: { type: 'api', key: 'sk-managed' },
      openai: { type: 'oauth' },
      anthropic: { type: 'api', key: 'sk-anthropic' },
    })
  })

  test('reconciles managed auth to current sources and drops stale providers', async () => {
    const globalAuthPath = path.join(tempDir, 'global-auth.json')
    const localAuthPath = path.join(tempDir, 'local-auth.json')
    const managedAuthPath = path.join(tempDir, 'managed', 'auth.json')

    await mkdir(path.dirname(managedAuthPath), { recursive: true })
    await writeFile(
      globalAuthPath,
      JSON.stringify({
        openrouter: { type: 'api', key: 'global-key' },
      }),
      'utf8',
    )
    await writeFile(
      localAuthPath,
      JSON.stringify({
        openai: { type: 'oauth', token: 'fresh-local' },
      }),
      'utf8',
    )
    await writeFile(
      managedAuthPath,
      JSON.stringify({
        openrouter: { type: 'api', key: 'old-global-key' },
        openai: { type: 'oauth', token: 'old-local' },
        staleprovider: { type: 'api', key: 'stale' },
      }),
      'utf8',
    )

    await reconcileOpenCodeManagedAuthStore({
      sourceAuthPaths: [globalAuthPath, localAuthPath],
      managedAuthPath,
    })

    const reconciled = JSON.parse(await readFile(managedAuthPath, 'utf8')) as Record<
      string,
      unknown
    >
    expect(reconciled).toEqual({
      openrouter: { type: 'api', key: 'global-key' },
      openai: { type: 'oauth', token: 'fresh-local' },
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

  test('writes API auth metadata for prompted provider setup', async () => {
    const authPath = path.join(tempDir, 'data', 'opencode', 'auth.json')

    await upsertOpenCodeApiAuthCredential({
      authPath,
      providerId: 'cloudflare-ai-gateway',
      apiKey: 'cf-secret',
      metadata: {
        accountId: 'account-123',
        gatewayId: 'gateway-123',
      },
    })

    expect(JSON.parse(await readFile(authPath, 'utf8'))).toEqual({
      'cloudflare-ai-gateway': {
        type: 'api',
        key: 'cf-secret',
        metadata: {
          accountId: 'account-123',
          gatewayId: 'gateway-123',
        },
      },
    })
  })

  test('copies opaque OAuth credentials without changing provider-specific fields', async () => {
    const authPath = path.join(tempDir, 'data', 'opencode', 'auth.json')
    const credential = {
      type: 'oauth',
      access: 'opaque-access-token',
      refresh: 'opaque-refresh-token',
      expires: 1_900_000_000_000,
      accountId: 'subscription-account',
    }

    await upsertOpenCodeAuthCredential({
      authPath,
      providerId: 'XAI',
      credential,
    })

    expect(await readOpenCodeAuthCredential({ authPath, providerId: 'xai' })).toEqual(credential)
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
