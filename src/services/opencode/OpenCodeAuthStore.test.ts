import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  doesOpenCodeAuthStoreIncludeSource,
  fanOutOpenCodeOAuthCredential,
  mergeOpenCodeAuthStores,
  mergeOpenCodeAuthStoresWithFreshestOAuth,
  mergeOpenCodeManagedAuthSources,
  materializeOpenCodeSelectedAuthCredential,
  readOpenCodeAuthProviderSummaries,
  readOpenCodeAuthCredential,
  reconcileOpenCodeManagedAuthStore,
  reconcileOpenCodeManagedAuthStores,
  removeOpenCodeAuthCredential,
  syncOpenCodeManagedAuthStore,
  upsertOpenCodeApiAuthCredential,
  upsertOpenCodeAuthCredential,
  withOpenCodeOAuthRefreshLock,
} from './OpenCodeAuthStore.js'

describe('OpenCodeAuthStore', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-auth-store-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  for (const operationName of ['upsert', 'remove', 'materialize'] as const) {
    test(`cancels a queued ${operationName} without writing after the lock is released`, async () => {
      const authPath = path.join(tempDir, 'cancelled-auth.json')
      const original = { type: 'api', key: 'original-test-key' }
      await upsertOpenCodeAuthCredential({ authPath, providerId: 'test', credential: original })
      let release!: () => void
      let acquired!: () => void
      const ready = new Promise<void>(resolve => { acquired = resolve })
      const holder = withOpenCodeOAuthRefreshLock({
        authPath,
        providerId: 'test',
        operation: () => new Promise<void>(resolve => {
          release = resolve
          acquired()
        }),
      })
      await ready
      const controller = new AbortController()
      const input = { authPath, providerId: 'test', abortSignal: controller.signal }
      const pending = operationName === 'remove'
        ? removeOpenCodeAuthCredential(input)
        : operationName === 'materialize'
          ? materializeOpenCodeSelectedAuthCredential({ ...input, credential: null })
          : upsertOpenCodeAuthCredential({ ...input, credential: { type: 'api', key: 'late-write' } })
      const outcome = pending.then(() => 'written', error => error)
      try {
        await new Promise(resolve => setTimeout(resolve, 30))
        const reason = new Error('test profile preparation cancelled')
        controller.abort(reason)
        // The waiter must settle before the holder releases its lease.
        expect(await Promise.race([
          outcome,
          new Promise(resolve => setTimeout(() => resolve('still waiting'), 250)),
        ])).toBe(reason)
      } finally {
        release()
        await holder
        await outcome
      }
      expect(await readOpenCodeAuthCredential({ authPath, providerId: 'test' })).toEqual(original)
    })
  }

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

  test('restricts rewritten credential stores to the current user', async () => {
    const authPath = path.join(tempDir, 'opencode', 'auth.json')
    await mkdir(path.dirname(authPath), { recursive: true })
    await writeFile(authPath, JSON.stringify({}), { encoding: 'utf8', mode: 0o644 })

    await upsertOpenCodeApiAuthCredential({
      authPath,
      providerId: 'google',
      apiKey: 'google-test-key',
    })

    if (process.platform !== 'win32') {
      expect((await stat(authPath)).mode & 0o777).toBe(0o600)
    }
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

  test('serializes one provider OAuth refresh across separate processes', async () => {
    const authPath = path.join(tempDir, 'opencode', 'profiles', 'project', 'data', 'opencode', 'auth.json')
    const counterPath = path.join(tempDir, 'refresh-count')
    const startPath = path.join(tempDir, 'refresh-start')
    const scriptPath = path.join(tempDir, 'refresh-auth.ts')
    const authStoreUrl = pathToFileURL(path.resolve('src/services/opencode/OpenCodeAuthStore.ts')).href
    await writeFile(
      scriptPath,
      `import { access, readFile, writeFile } from 'node:fs/promises'
import { withOpenCodeOAuthRefreshLock } from ${JSON.stringify(authStoreUrl)}
while (await access(process.argv[4]).then(() => false).catch(() => true)) {
  await new Promise(resolve => setTimeout(resolve, 5))
}
await withOpenCodeOAuthRefreshLock({
  authPath: process.argv[2],
  providerId: 'xai',
  operation: async () => {
    const current = Number(await readFile(process.argv[3], 'utf8').catch(() => '0'))
    await new Promise(resolve => setTimeout(resolve, 30))
    await writeFile(process.argv[3], String(current + 1), 'utf8')
  },
})
`,
      'utf8',
    )
    const children = Array.from({ length: 12 }, () => Bun.spawn({
      cmd: [process.execPath, scriptPath, authPath, counterPath, startPath],
      cwd: process.cwd(),
      stdout: 'ignore',
      stderr: 'pipe',
    }))
    await writeFile(startPath, 'go\n', 'utf8')

    expect(await Promise.all(children.map(child => child.exited))).toEqual(
      Array.from({ length: children.length }, () => 0),
    )
    expect(await readFile(counterPath, 'utf8')).toBe(String(children.length))
  }, 15_000)

  test('recovers an OAuth refresh lock left by a dead process', async () => {
    const authPath = path.join(tempDir, 'opencode', 'profiles', 'project', 'data', 'opencode', 'auth.json')
    const readyPath = path.join(tempDir, 'dead-owner-ready')
    const scriptPath = path.join(tempDir, 'hold-refresh-auth.ts')
    const authStoreUrl = pathToFileURL(path.resolve('src/services/opencode/OpenCodeAuthStore.ts')).href
    await writeFile(
      scriptPath,
      `import { writeFile } from 'node:fs/promises'
import { withOpenCodeOAuthRefreshLock } from ${JSON.stringify(authStoreUrl)}
await withOpenCodeOAuthRefreshLock({
  authPath: process.argv[2],
  providerId: 'xai',
  operation: async () => {
    await writeFile(process.argv[3], 'ready', 'utf8')
    await new Promise(() => {})
  },
})
`,
      'utf8',
    )
    const child = Bun.spawn({
      cmd: [process.execPath, scriptPath, authPath, readyPath],
      cwd: process.cwd(),
      stdout: 'ignore',
      stderr: 'pipe',
    })
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await access(readyPath).then(() => true).catch(() => false)) {
        break
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(await access(readyPath).then(() => true).catch(() => false)).toBe(true)
    child.kill()
    await child.exited

    await expect(withOpenCodeOAuthRefreshLock({
      authPath,
      providerId: 'xai',
      operation: async () => 'recovered',
    })).resolves.toBe('recovered')
  }, 15_000)

  test('keeps nested auth writes reentrant while an OAuth refresh owns coordination', async () => {
    const authPath = path.join(tempDir, 'opencode', 'profiles', 'project', 'data', 'opencode', 'auth.json')
    await withOpenCodeOAuthRefreshLock({
      authPath,
      providerId: 'xai',
      operation: async () => {
        await upsertOpenCodeAuthCredential({
          authPath,
          providerId: 'xai',
          credential: {
            type: 'oauth',
            access: 'rotated-access',
            refresh: 'rotated-refresh',
            expires: Date.now() + 3_600_000,
          },
        })
      },
    })

    await expect(readOpenCodeAuthCredential({ authPath, providerId: 'xai' }))
      .resolves.toMatchObject({ access: 'rotated-access' })
  })

  test('blocks cross-process profile auth writes until OAuth refresh coordination releases', async () => {
    const managedAuthPath = path.join(
      tempDir,
      'opencode',
      'profiles',
      'project',
      'data',
      'opencode',
      'auth.json',
    )
    const globalAuthPath = path.join(tempDir, 'opencode', 'auth.json')
    const startPath = path.join(tempDir, 'profile-write-start')
    const finishedPath = path.join(tempDir, 'profile-write-finished')
    const scriptPath = path.join(tempDir, 'write-during-refresh.ts')
    const authStoreUrl = pathToFileURL(path.resolve('src/services/opencode/OpenCodeAuthStore.ts')).href
    await writeFile(
      scriptPath,
      `import { access, writeFile } from 'node:fs/promises'
import { upsertOpenCodeApiAuthCredential } from ${JSON.stringify(authStoreUrl)}
while (await access(process.argv[3]).then(() => false).catch(() => true)) {
  await new Promise(resolve => setTimeout(resolve, 5))
}
await upsertOpenCodeApiAuthCredential({
  authPath: process.argv[2],
  providerId: 'openrouter',
  apiKey: 'test-key',
})
await writeFile(process.argv[4], 'finished', 'utf8')
`,
      'utf8',
    )
    const child = Bun.spawn({
      cmd: [process.execPath, scriptPath, globalAuthPath, startPath, finishedPath],
      cwd: process.cwd(),
      stdout: 'ignore',
      stderr: 'pipe',
    })

    await withOpenCodeOAuthRefreshLock({
      authPath: managedAuthPath,
      providerId: 'xai',
      operation: async () => {
        await writeFile(startPath, 'go', 'utf8')
        await new Promise(resolve => setTimeout(resolve, 100))
        expect(await access(finishedPath).then(() => true).catch(() => false)).toBe(false)
      },
    })

    expect(await child.exited).toBe(0)
    expect(await access(finishedPath).then(() => true).catch(() => false)).toBe(true)
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

  test('keeps an app-managed API key ahead of a stale local OpenCode key', async () => {
    const globalAuthPath = path.join(tempDir, 'opencode', 'auth.json')
    const localAuthPath = path.join(tempDir, 'local-opencode', 'auth.json')
    const managedAuthPath = path.join(
      tempDir,
      'opencode',
      'profiles',
      'active',
      'data',
      'opencode',
      'auth.json',
    )
    const freshCredential = { type: 'api', key: 'llmgtwy-new-valid-key' }
    const staleCredential = { type: 'api', key: 'llmgtwy-deleted-old-key' }

    await Promise.all([
      upsertOpenCodeAuthCredential({
        authPath: globalAuthPath,
        providerId: 'llmgateway',
        credential: freshCredential,
      }),
      upsertOpenCodeAuthCredential({
        authPath: localAuthPath,
        providerId: 'llmgateway',
        credential: staleCredential,
      }),
    ])

    await reconcileOpenCodeManagedAuthStores({
      sourceAuthPaths: [globalAuthPath, localAuthPath],
      globalAuthPath,
      managedAuthPath,
    })

    await expect(
      readOpenCodeAuthCredential({ authPath: managedAuthPath, providerId: 'llmgateway' }),
    ).resolves.toEqual(freshCredential)
    await expect(
      readOpenCodeAuthCredential({ authPath: localAuthPath, providerId: 'llmgateway' }),
    ).resolves.toEqual(staleCredential)

    await removeOpenCodeAuthCredential({
      authPath: globalAuthPath,
      providerId: 'llmgateway',
    })
    await reconcileOpenCodeManagedAuthStores({
      sourceAuthPaths: [globalAuthPath, localAuthPath],
      globalAuthPath,
      managedAuthPath,
    })

    await expect(
      readOpenCodeAuthCredential({ authPath: managedAuthPath, providerId: 'llmgateway' }),
    ).resolves.toEqual(staleCredential)
  })

  test('does not give app-global precedence to unknown credential types', () => {
    const globalAuthPath = path.join(tempDir, 'opencode', 'auth.json')
    const localAuthPath = path.join(tempDir, 'local-opencode', 'auth.json')

    expect(
      mergeOpenCodeManagedAuthSources({
        sourceAuthPaths: [globalAuthPath, localAuthPath],
        sourceStores: [
          { future: { type: 'future-auth', token: 'global-token' } },
          { future: { type: 'future-auth', token: 'local-token' } },
        ],
        globalAuthPath,
      }),
    ).toEqual({
      future: { type: 'future-auth', token: 'local-token' },
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

  test('does not enter OAuth refresh work after the readiness deadline aborts', async () => {
    const controller = new AbortController()
    const timeout = new Error('readiness deadline expired')
    controller.abort(timeout)
    let operationCalled = false

    await expect(withOpenCodeOAuthRefreshLock({
      authPath: path.join(tempDir, 'managed', 'auth.json'),
      providerId: 'xai',
      abortSignal: controller.signal,
      operation: async () => {
        operationCalled = true
      },
    })).rejects.toBe(timeout)
    expect(operationCalled).toBe(false)
  })

  test('does not enter a reentrant auth operation after its deadline aborts', async () => {
    const authPath = path.join(tempDir, 'opencode', 'auth.json')
    const controller = new AbortController()
    const timeout = new Error('nested readiness deadline expired')
    let nestedOperationCalled = false

    await withOpenCodeOAuthRefreshLock({
      authPath,
      providerId: 'xai',
      operation: async () => {
        controller.abort(timeout)
        await expect(withOpenCodeOAuthRefreshLock({
          authPath,
          providerId: 'xai',
          abortSignal: controller.signal,
          operation: async () => {
            nestedOperationCalled = true
          },
        })).rejects.toBe(timeout)
      },
    })

    expect(nestedOperationCalled).toBe(false)
  })

  test('cancels managed auth reconciliation while an OAuth refresh owns coordination', async () => {
    const managedAuthPath = path.join(
      tempDir,
      'opencode',
      'profiles',
      'project',
      'data',
      'opencode',
      'auth.json',
    )
    const globalAuthPath = path.join(tempDir, 'opencode', 'auth.json')
    let markRefreshStarted!: () => void
    let releaseRefresh!: () => void
    const refreshStarted = new Promise<void>(resolve => {
      markRefreshStarted = resolve
    })
    const refreshRelease = new Promise<void>(resolve => {
      releaseRefresh = resolve
    })
    const refresh = withOpenCodeOAuthRefreshLock({
      authPath: managedAuthPath,
      providerId: 'xai',
      operation: async () => {
        markRefreshStarted()
        await refreshRelease
      },
    })
    await refreshStarted

    const controller = new AbortController()
    const timeout = new Error('profile preparation deadline expired')
    const reconciliation = reconcileOpenCodeManagedAuthStores({
      sourceAuthPaths: [],
      globalAuthPath,
      managedAuthPath,
      abortSignal: controller.signal,
    })

    try {
      await new Promise(resolve => setTimeout(resolve, 30))
      controller.abort(timeout)
      await expect(reconciliation).rejects.toBe(timeout)
    } finally {
      releaseRefresh()
      await refresh
    }
  })

  test('creates only the SDK global private namespace before auth locking and preserves native refusals', async () => {
    const scriptPath = path.join(tempDir, 'private-global-auth-order.ts')
    const authStoreUrl = pathToFileURL(path.resolve('src/services/opencode/OpenCodeAuthStore.ts')).href
    const privateDirectoriesUrl = pathToFileURL(path.resolve('src/services/opencode/profile/OpenCodePrivateDirectories.ts')).href
    await writeFile(scriptPath, `
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { access, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
const data = path.join(process.argv[2], 'managed-data')
process.env.CLAUDE_MULTIMODEL_DATA_HOME = data
const globalAuth = path.join(data, 'opencode', 'auth.json')
const coordination = globalAuth + '.agent-teams-coordination.sqlite'
let calls = 0, refuse = false
const original = new Error('execution_owner_not_private:private_acl_owner:0')
mock.module(${JSON.stringify(privateDirectoriesUrl)}, () => ({
  hasWindowsPrivateProfileDirectoryDelivery: async () => true,
  ensureWindowsPrivateDirectories: async (directories: readonly string[]) => {
    assert.deepEqual(directories, [data, path.dirname(globalAuth)])
    if (refuse) throw original
    assert.equal(await access(coordination).then(() => true, () => false), false)
    assert.equal(await access(globalAuth).then(() => true, () => false), false)
    calls++
    await mkdir(path.dirname(globalAuth), { recursive: true })
  },
}))
const { upsertOpenCodeApiAuthCredential } = await import(${JSON.stringify(authStoreUrl)})
await upsertOpenCodeApiAuthCredential({ authPath: globalAuth, providerId: 'openrouter', apiKey: 'TEST-noncredential' })
assert.equal(calls, 1)
const saved = await readFile(globalAuth, 'utf8')
const arbitrary = path.join(process.argv[2], 'user-chosen-store', 'auth.json')
await upsertOpenCodeApiAuthCredential({ authPath: arbitrary, providerId: 'openrouter', apiKey: 'TEST-noncredential' })
assert.equal(calls, 1)
assert.equal(JSON.parse(await readFile(arbitrary, 'utf8')).openrouter.key, 'TEST-noncredential')
refuse = true
await assert.rejects(upsertOpenCodeApiAuthCredential({ authPath: globalAuth, providerId: 'openrouter', apiKey: 'TEST-replacement' }), error => error === original)
assert.equal(await readFile(globalAuth, 'utf8'), saved)
`, 'utf8')
    // Isolate this ordering double from every other test's native validation.
    const child = Bun.spawn([process.execPath, scriptPath, tempDir], { stdout: 'ignore', stderr: 'pipe' })
    let ended = false
    try {
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      ended = true
      expect(stderr).toBe('')
      expect(code).toBe(0)
    } finally {
      if (!ended) { child.kill(); await child.exited }
    }
  }, 15_000)

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
