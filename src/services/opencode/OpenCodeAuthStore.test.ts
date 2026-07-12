import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  doesOpenCodeAuthStoreIncludeSource,
  fanOutOpenCodeOAuthCredential,
  mergeOpenCodeAuthStores,
  mergeOpenCodeAuthStoresWithFreshestOAuth,
  readOpenCodeAuthProviderSummaries,
  readOpenCodeAuthCredential,
  reconcileOpenCodeManagedAuthStore,
  reconcileOpenCodeManagedAuthStores,
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

  test('serializes auth writes across separate processes without dropping providers', async () => {
    const authPath = path.join(tempDir, 'opencode', 'auth.json')
    const startPath = path.join(tempDir, 'start')
    const scriptPath = path.join(tempDir, 'write-auth.ts')
    const authStoreUrl = pathToFileURL(path.resolve('src/services/opencode/OpenCodeAuthStore.ts')).href
    await writeFile(
      scriptPath,
      `import { access } from 'node:fs/promises'
import { upsertOpenCodeApiAuthCredential } from ${JSON.stringify(authStoreUrl)}
while (await access(process.argv[4]).then(() => false).catch(() => true)) {
  await new Promise(resolve => setTimeout(resolve, 5))
}
await upsertOpenCodeApiAuthCredential({
  authPath: process.argv[3],
  providerId: process.argv[2],
  apiKey: 'key-' + process.argv[2],
})
`,
      'utf8',
    )
    const providerIds = Array.from({ length: 8 }, (_, index) => `provider-${index}`)
    const children = providerIds.map(providerId => Bun.spawn({
      cmd: [process.execPath, scriptPath, providerId, authPath, startPath],
      cwd: process.cwd(),
      stdout: 'ignore',
      stderr: 'pipe',
    }))
    await writeFile(startPath, 'go\n', 'utf8')
    const exitCodes = await Promise.all(children.map(child => child.exited))

    expect(exitCodes).toEqual(providerIds.map(() => 0))
    expect(Object.keys(JSON.parse(await readFile(authPath, 'utf8'))).sort()).toEqual(providerIds)
  }, 15_000)

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

  test('keeps the OAuth credential with the newer expiry across source precedence', () => {
    expect(
      mergeOpenCodeAuthStoresWithFreshestOAuth({
        source: {
          xai: {
            type: 'oauth',
            access: 'stale-source-access',
            refresh: 'stale-source-refresh',
            expires: 1_000,
          },
          openrouter: { type: 'api', key: 'new-source-key' },
        },
        managed: {
          xai: {
            type: 'oauth',
            access: 'fresh-managed-access',
            refresh: 'fresh-managed-refresh',
            expires: 2_000,
          },
          openrouter: { type: 'api', key: 'old-managed-key' },
        },
      }),
    ).toEqual({
      xai: {
        type: 'oauth',
        access: 'fresh-managed-access',
        refresh: 'fresh-managed-refresh',
        expires: 2_000,
      },
      openrouter: { type: 'api', key: 'new-source-key' },
    })
  })

  test('fans a rotated OAuth credential out to global and managed profile stores', async () => {
    const globalAuthPath = path.join(tempDir, 'opencode', 'auth.json')
    const activeAuthPath = path.join(
      tempDir,
      'opencode',
      'profiles',
      'active',
      'data',
      'opencode',
      'auth.json',
    )
    const peerAuthPath = path.join(
      tempDir,
      'opencode',
      'profiles',
      'peer',
      'data',
      'opencode',
      'auth.json',
    )
    const stale = {
      type: 'oauth',
      access: 'stale-access',
      refresh: 'stale-refresh',
      expires: 1_000,
    }
    const rotated = {
      type: 'oauth',
      access: 'rotated-access',
      refresh: 'rotated-refresh',
      expires: 2_000,
    }
    await Promise.all([
      upsertOpenCodeAuthCredential({ authPath: globalAuthPath, providerId: 'xai', credential: stale }),
      upsertOpenCodeAuthCredential({ authPath: activeAuthPath, providerId: 'xai', credential: rotated }),
      upsertOpenCodeAuthCredential({ authPath: peerAuthPath, providerId: 'xai', credential: stale }),
    ])

    await fanOutOpenCodeOAuthCredential({
      providerId: 'xai',
      sourceAuthPath: activeAuthPath,
      targetAuthPaths: [globalAuthPath, activeAuthPath, peerAuthPath],
    })

    await expect(Promise.all(
      [globalAuthPath, activeAuthPath, peerAuthPath].map(authPath =>
        readOpenCodeAuthCredential({ authPath, providerId: 'xai' }),
      ),
    )).resolves.toEqual([rotated, rotated, rotated])
  })

  test('recovers a rotated managed OAuth credential and prevents stale restart overwrite', async () => {
    const globalAuthPath = path.join(tempDir, 'opencode', 'auth.json')
    const localAuthPath = path.join(tempDir, 'local-opencode', 'auth.json')
    const activeAuthPath = path.join(
      tempDir,
      'opencode',
      'profiles',
      'active',
      'data',
      'opencode',
      'auth.json',
    )
    const restartedAuthPath = path.join(
      tempDir,
      'opencode',
      'profiles',
      'restarted',
      'data',
      'opencode',
      'auth.json',
    )
    const stale = {
      type: 'oauth',
      access: 'stale-access',
      refresh: 'stale-refresh',
      expires: 1_000,
    }
    const rotated = {
      type: 'oauth',
      access: 'rotated-access',
      refresh: 'rotated-refresh',
      expires: 2_000,
    }
    await Promise.all([
      upsertOpenCodeAuthCredential({ authPath: globalAuthPath, providerId: 'xai', credential: stale }),
      upsertOpenCodeAuthCredential({ authPath: localAuthPath, providerId: 'xai', credential: stale }),
      upsertOpenCodeAuthCredential({ authPath: activeAuthPath, providerId: 'xai', credential: rotated }),
    ])

    await reconcileOpenCodeManagedAuthStores({
      sourceAuthPaths: [globalAuthPath, localAuthPath],
      globalAuthPath,
      managedAuthPath: restartedAuthPath,
      peerManagedAuthPaths: [activeAuthPath, restartedAuthPath],
    })

    await expect(Promise.all(
      [globalAuthPath, activeAuthPath, restartedAuthPath].map(authPath =>
        readOpenCodeAuthCredential({ authPath, providerId: 'xai' }),
      ),
    )).resolves.toEqual([rotated, rotated, rotated])

    await reconcileOpenCodeManagedAuthStores({
      sourceAuthPaths: [globalAuthPath, localAuthPath],
      globalAuthPath,
      managedAuthPath: restartedAuthPath,
      peerManagedAuthPaths: [activeAuthPath, restartedAuthPath],
    })
    await expect(
      readOpenCodeAuthCredential({ authPath: restartedAuthPath, providerId: 'xai' }),
    ).resolves.toEqual(rotated)
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
