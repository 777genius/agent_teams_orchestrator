import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { OpenCodeProviderManagementAdapter } from './OpenCodeProviderManagementAdapter.js'
import { OpenCodeHostManager } from '../../../../services/opencode/OpenCodeHostManager.js'
import type { OpenCodeAuthCredential } from '../../../../services/opencode/OpenCodeAuthStore.js'
import type {
  OpenCodeHostHandle,
  OpenCodeInventorySnapshot,
  OpenCodeProviderResponse,
} from '../../../../services/opencode/types.js'

// Model the server's per-instance provider snapshot, not a client-side cache:
// /config/providers and /provider initialize it; callback and PUT persist auth
// without rebuilding it. Inventory auth metadata reads the updated store.
async function fixture(input: {
  method: 'oauth' | 'api'
  providerId?: string
  admission?: 'accepted' | 'rejected' | 'unavailable'
  refresh?: 'throws' | 'timeout' | 'missing' | 'hang'
  managed?: boolean
  metadata?: boolean
  execution?: 'available' | 'not_authenticated' | 'unavailable'
  previous?: boolean
  freshModel?: boolean
  hostUnavailable?: boolean
  observerFailure?: boolean
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-connect-admission-'))
  const providerId = input.providerId ?? 'xai'
  const globalAuthPath = path.join(root, 'global/auth.json')
  const managedAuthPath = path.join(root, 'profile/data/opencode/auth.json')
  const stores = new Map<string, OpenCodeAuthCredential>()
  const previous: OpenCodeAuthCredential = { type: 'api', key: 'synthetic-previous' }
  if (input.previous) {
    stores.set(globalAuthPath, previous)
    stores.set(managedAuthPath, previous)
  }
  const credential: OpenCodeAuthCredential = input.method === 'oauth'
    ? { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', expires: 1_900_000_000_000 }
    : { type: 'api', key: 'synthetic-key' }
  let written = false
  const events: string[] = []
  const snapshots: Array<{ host: OpenCodeHostHandle; connected?: string[] }> = []
  const inventory = (): OpenCodeInventorySnapshot => ({
    detected: true, binaryPath: path.join(root, 'fake-opencode'), version: '1.18.4',
    projectPath: root,
    profile: {
      projectPath: root, canonicalProjectPath: root, workingDirectoryPath: root,
      profileRootKey: 'synthetic-profile', profileRootPath: path.join(root, 'profile'),
      scopeToken: null, projectBehaviorFingerprint: 'synthetic-behavior', behaviorSources: [],
      managedConfig: {}, managedConfigFingerprint: 'synthetic-config',
      homePath: path.join(root, 'home'), tmpPath: path.join(root, 'tmp'),
      xdgConfigHome: path.join(root, 'config'), xdgDataHome: path.join(root, 'data'),
      xdgCacheHome: path.join(root, 'cache'), globalAuthPath, managedAuthPath,
      sourceAuthPath: null, sourceAuthFingerprint: null,
      managedAuthFingerprint: written ? 'after-auth' : 'before-auth', authState: 'ok', env: {},
    },
    connectedProviders: written && input.metadata !== false ? [{ id: providerId, source: 'credentials', authHint: input.method,
      credentialScopes: input.managed === false ? ['local'] : ['managed'] }] : [],
    availableProviders: [providerId], models: input.freshModel ? [] : [`${providerId}/text-model`], agents: [],
    authStorePath: managedAuthPath, probeError: null, diagnostics: [],
  })
  // Exercise the actual host key, reuse, refcount and disposal implementation.
  // Only process/HTTP/port/profile boundaries are synthetic; nothing is spawned
  // or sent to a socket, and plugin prewarming is disabled at the test boundary.
  const livePids = new Set<number>()
  let port = 41000
  const manager = new OpenCodeHostManager({
    prepareProfile: async () => inventory().profile!,
    persistentRegistryPath: null,
    allocateLoopbackPort: async () => ++port,
    spawnHostProcess: (_profile, port) => {
      const child = new EventEmitter() as ChildProcess
      const pid = port + 10000
      livePids.add(pid)
      events.push(`spawn:${pid}`)
      return Object.assign(child, { pid, unref() {}, kill() { livePids.delete(pid); return true } })
    },
    fetchJson: async (url, init) => {
      if (url.endsWith('/global/health')) {
        return { status: 200, data: { healthy: true, version: '1.18.4' } }
      }
      expect(url.endsWith('/global/dispose')).toBe(true)
      expect(init?.method).toBe('POST')
      events.push(`dispose:${new URL(url).port}`)
      return { status: 200, data: true }
    },
    isProcessAlive: pid => livePids.has(pid),
    readProcessStartTimeMs: async () => 1000,
    killProcess: pid => { livePids.delete(pid) },
  })
  const adapter = new OpenCodeProviderManagementAdapter({
    ...(input.refresh === 'hang' ? { inventoryTimeoutMs: 10 } : {}),
    inventoryService: {
      probe: async (_projectPath, options) => {
        expect(_projectPath).toBe(root)
        expect(options?.includeAppMcp).toBe(false)
        expect(options?.profileScope).toBeUndefined()
        if (written && options?.bypassCache) {
          events.push('refresh')
          if (input.refresh === 'hang') {
            return new Promise((_resolve, reject) => {
              options.abortSignal!.addEventListener('abort', () => {
                events.push('inventory-aborted')
                reject(new Error('synthetic inventory aborted'))
              }, { once: true })
            })
          }
          if (input.refresh === 'throws') throw new Error('synthetic inventory unavailable')
          if (input.refresh === 'missing') return { ...inventory(), detected: false, profile: null }
          if (input.refresh === 'timeout') return { ...inventory(), profile: null,
            connectedProviders: [], models: [],
            probeError: 'OpenCode inventory probe timed out after 1ms',
            diagnostics: ['OpenCode inventory probe timed out after 1ms'] }
        }
        return inventory()
      },
    },
    hostManager: {
      ensureHost: async params => {
        const profile = params?.preparedProfile ?? inventory().profile!
        const id = snapshots.length
        if (written) {
          expect(params?.hostLifetime).toBe('process')
          expect(params?.prewarmManagedSubscriptionPlugins).toBe(false)
          expect(profile.projectPath).toBe(root)
          if (!input.refresh) expect(profile.managedAuthFingerprint).toBe('after-auth')
        }
        if (written && input.hostUnavailable) throw new Error('synthetic startup unavailable')
        const host = await manager.ensureHost({ ...params, prewarmManagedSubscriptionPlugins: false })
        // A second ordinary persistent ensure really does reuse the old instance.
        // A fresh admission call must escape this reuse via process lifetime.
        if (!written && input.method === 'api') {
          const reused = await manager.ensureHost({ ...params, prewarmManagedSubscriptionPlugins: false })
          expect(reused).toBe(host)
          await manager.releaseHost(reused.hostKey, { keepPersistentAlive: true })
        }
        if (written) {
          expect(host.hostKey).not.toBe(snapshots[0]!.host.hostKey)
          expect(host.baseUrl).not.toBe(snapshots[0]!.host.baseUrl)
          expect(host.pid).not.toBe(snapshots[0]!.host.pid)
          expect(manager.getHost(snapshots[0]!.host.hostKey)?.state).toBe('healthy')
        }
        events.push(`host:${id}`)
        snapshots.push({ host })
        return host
      },
      releaseHost: async (key, options) => {
        events.push(`release:${key}`)
        await manager.releaseHost(key, options)
      },
    },
    clientFactory: {
      create: baseUrl => {
        const instance = snapshots.find(item => item.host.baseUrl === baseUrl)!
        const index = snapshots.indexOf(instance)
        const providers = (): OpenCodeProviderResponse => {
          if (written && index > 0 && input.admission === 'unavailable') {
            throw new Error('synthetic provider endpoint unavailable')
          }
          instance.connected ??= written && input.admission !== 'rejected' ? [providerId] : []
          events.push(`providers:${index}:${instance.connected.join(',')}`)
          return { all: [{ id: providerId, name: providerId }], connected: instance.connected, default: {} }
        }
        return {
          getConfigProviders: async () => {
            providers()
            return { providers: input.freshModel && index > 0
              ? [{ id: providerId, name: providerId, models: { 'fresh-model': {} } }] : [], default: {} }
          },
          getProviders: async () => providers(),
          getProviderAuth: async () => ({ [providerId]: [{ type: input.method }] }),
          getServerDoc: async () => ({ paths: {
            '/auth/{providerID}': { put: {}, delete: {} },
            '/provider/{providerID}/oauth/authorize': { post: {} },
            '/provider/{providerID}/oauth/callback': { post: {} },
          } }),
          authorizeProviderOAuth: async () => {
            events.push('authorize')
            return { url: 'https://accounts.x.ai/synthetic', method: 'auto' as const, instructions: 'Synthetic only' }
          },
          completeProviderOAuth: async () => {
            events.push('callback'); written = true; stores.set(managedAuthPath, credential); return true
          },
          setProviderAuth: async () => {
            events.push('put'); written = true; stores.set(managedAuthPath, credential); return true
          },
          deleteProviderAuth: async () => {
            events.push('delete'); stores.delete(managedAuthPath); return true
          },
        }
      },
    },
    authStore: {
      readCredential: async ({ authPath }) => stores.get(authPath) ?? null,
      upsertCredential: async ({ authPath, credential }) => { events.push('mirror'); stores.set(authPath, credential) },
      upsertApiAuth: async ({ authPath, auth }) => { events.push('mirror'); stores.set(authPath, auth) },
      removeCredential: async ({ authPath }) => { stores.delete(authPath) },
    },
    profileManager: { listManagedAuthPaths: async () => [managedAuthPath] },
    executionProbe: {
      probeModel: async request => {
        events.push('execution')
        expect(request.bypassCache).toBe(true)
        expect(request.projectPath).toBe(root)
        const outcome = input.execution ?? 'available'
        return {
          providerId, modelId: request.selectedModel, outcome,
          probePrompt: 'synthetic', expectedOutput: 'PONG', durationMs: 0,
          rawStatus: null, durableState: outcome === 'available' ? 'idle' : 'error',
          latestAssistantText: outcome === 'available' ? 'PONG' : null,
          latestAssistantPreview: null, toolCallCount: 0, errorCount: outcome === 'available' ? 0 : 1,
          reason: outcome === 'available' ? null : 'synthetic execution rejected', diagnostics: [],
        }
      },
    },
  })
  try {
    const result = await adapter.connectProvider({
      runtimeId: 'opencode', providerId, projectPath: root, method: input.method,
      apiKey: 'synthetic-key', authMethodIndex: 0, oauthOperationId: 'synthetic-operation',
    }, { authorizationReady: async () => {}, authorizationCompleted: async () => {
      events.push('completed')
      if (input.observerFailure) throw new Error('synthetic progress transport closed')
    } })
    // The admission process is gone before returning (also on every rejection).
    // API's original persistent catalog retains its existing lifetime contract.
    if (snapshots[1]) {
      expect(manager.getHost(snapshots[1].host.hostKey)).toBeNull()
      expect(livePids.has(snapshots[1].host.pid)).toBe(false)
    }
    return { result, events, snapshots, stores, previous, credential, globalAuthPath, managedAuthPath }
  } finally {
    for (const { host } of snapshots) await manager.disposeHost(host.hostKey)
    expect(livePids.size).toBe(0)
    await rm(root, { recursive: true, force: true })
  }
}

describe('post-auth provider admission', () => {
  for (const previous of [false, true]) {
    test(`OAuth progress interruption rolls back mirrored auth (previous=${previous})`, async () => {
      const run = await fixture({ method: 'oauth', observerFailure: true, previous })
      expect(run.result).toMatchObject({ ok: false, error: { code: 'auth-failed' } })
      expect(run.stores.get(run.globalAuthPath)).toEqual(previous ? run.previous : undefined)
      expect(run.stores.get(run.managedAuthPath)).toEqual(previous ? run.previous : undefined)
      expect(run.events.filter(event => event === 'callback')).toHaveLength(1)
      expect(run.events.filter(event => event === 'completed')).toHaveLength(1)
      expect(run.events).not.toContain('refresh')
      expect(run.events).not.toContain('execution')
      expect(run.events.filter(event => event.startsWith('release:'))).toHaveLength(1)
    })
  }
  for (const method of ['oauth', 'api'] as const) {
    test(`${method}: actual inventory deadline aborts the probe and uses a fresh process`, async () => {
      const run = await fixture({ method, refresh: 'hang' })
      expect(run.result.ok).toBe(true)
      expect(run.events.filter(event => event === 'inventory-aborted')).toHaveLength(1)
      expect(run.snapshots).toHaveLength(2)
      expect(run.snapshots[1]!.host.profile.managedAuthFingerprint).toBe('before-auth')
      expect(run.snapshots[1]!.connected).toEqual(['xai'])
      expect(run.events.filter(event => event === 'execution')).toHaveLength(1)
      expect(run.events.filter(event => event === 'mirror')).toHaveLength(2)
      expect(run.events.filter(event => event === (method === 'oauth' ? 'callback' : 'put'))).toHaveLength(1)
    })
    test(`${method}: first login reads a fresh provider instance before execution`, async () => {
      const run = await fixture({ method })
      expect(run.snapshots[0]!.connected).toEqual([])
      expect(run.result).toMatchObject({ ok: true, value: {
        providerId: 'xai', state: 'connected', ownership: ['managed'], verifiedModelId: 'xai/text-model',
      } })
      expect(run.events.filter(event => event === (method === 'oauth' ? 'callback' : 'put'))).toHaveLength(1)
      expect(run.snapshots).toHaveLength(2)
      expect(run.snapshots[1]!.connected).toEqual(['xai'])
      expect(run.events.filter(event => event === 'execution')).toHaveLength(1)
      expect(run.events.filter(event => event === 'mirror')).toHaveLength(2)
      expect(run.events.indexOf('refresh')).toBeGreaterThan(run.events.lastIndexOf('mirror'))
      expect(run.events.indexOf('execution')).toBeGreaterThan(run.events.indexOf('providers:1:xai'))
      expect(run.stores.get(run.globalAuthPath)).toEqual(run.credential)
      expect(run.events.filter(event => event.startsWith('release:'))).toHaveLength(2)
    })

    test(`${method}: execution model selection uses the refreshed catalog`, async () => {
      const run = await fixture({ method, freshModel: true })
      expect(run.result).toMatchObject({ ok: true, value: { verifiedModelId: 'xai/fresh-model' } })
      expect(run.events.filter(event => event === 'execution')).toHaveLength(1)
    })

    test(`${method}: unavailable fresh host restores prior auth without repeating side effects`, async () => {
      const run = await fixture({ method, hostUnavailable: true, previous: true })
      expect(run.result).toMatchObject({ ok: false, error: { code: 'runtime-unhealthy' } })
      expect(run.events).not.toContain('execution')
      expect(run.stores.get(run.globalAuthPath)).toEqual(run.previous)
      expect(run.stores.get(run.managedAuthPath)).toEqual(run.previous)
      expect(run.events.filter(event => event === (method === 'oauth' ? 'callback' : 'put'))).toHaveLength(1)
    })

    for (const admission of ['rejected', 'unavailable'] as const) {
      test(`${method}: ${admission} fresh admission rolls back without execution or auth retry`, async () => {
        const run = await fixture({ method, admission })
        expect(run.result).toMatchObject({ ok: false, error: {
          code: admission === 'rejected' ? 'auth-failed' : 'runtime-unhealthy',
        } })
        expect(run.snapshots).toHaveLength(2)
        expect(run.events).not.toContain('execution')
        expect(run.stores.size).toBe(0)
        expect(run.events.filter(event => event === (method === 'oauth' ? 'callback' : 'put'))).toHaveLength(1)
        expect(run.events.filter(event => event === 'delete')).toHaveLength(1)
        expect(run.events.filter(event => event.startsWith('release:'))).toHaveLength(2)
      })
    }

    test(`${method}: live xai admission without inventory credential evidence is rejected`, async () => {
      const run = await fixture({ method, metadata: false })
      expect(run.snapshots[1]!.connected).toEqual(['xai'])
      expect(run.result).toMatchObject({ ok: false, error: { code: 'auth-failed' } })
      expect(run.events).not.toContain('execution')
      expect(run.stores.size).toBe(0)
    })

    test(`${method}: live admission without managed ownership is rejected`, async () => {
      const run = await fixture({ method, managed: false })
      expect(run.snapshots[1]!.connected).toEqual(['xai'])
      expect(run.result).toMatchObject({ ok: false, error: { code: 'auth-failed' } })
      expect(run.events).not.toContain('execution')
      expect(run.stores.size).toBe(0)
    })

    for (const execution of ['not_authenticated', 'unavailable'] as const) {
      test(`${method}: ${execution} execution restores the prior credential`, async () => {
        const run = await fixture({ method, execution, previous: true })
        expect(run.result).toMatchObject({ ok: false, error: {
          code: execution === 'not_authenticated' ? 'auth-failed' : 'model-test-failed',
        } })
        expect(run.events.filter(event => event === 'execution')).toHaveLength(1)
        expect(run.stores.get(run.globalAuthPath)).toEqual(run.previous)
        expect(run.stores.get(run.managedAuthPath)).toEqual(run.previous)
        expect(run.events.filter(event => event === (method === 'oauth' ? 'callback' : 'put'))).toHaveLength(1)
      })
    }

    for (const refresh of ['throws', 'missing'] as const) {
      test(`${method}: ${refresh} refresh is an unavailable runtime and restores prior auth`, async () => {
        const run = await fixture({ method, refresh, previous: true })
        expect(run.result).toMatchObject({ ok: false, error: { code: 'runtime-unhealthy' } })
        expect(run.events).not.toContain('execution')
        expect(run.stores.get(run.globalAuthPath)).toEqual(run.previous)
        expect(run.stores.get(run.managedAuthPath)).toEqual(run.previous)
        expect(run.events.filter(event => event === 'refresh')).toHaveLength(1)
        expect(run.events.filter(event => event === (method === 'oauth' ? 'callback' : 'put'))).toHaveLength(1)
      })
    }

    for (const admission of ['accepted', 'rejected', 'unavailable'] as const) {
      test(`${method}: timed out inventory still requires ${admission} fresh live admission`, async () => {
        const run = await fixture({ method, refresh: 'timeout', admission })
        expect(run.result.ok).toBe(admission === 'accepted')
        expect(run.events.filter(event => event === 'execution')).toHaveLength(admission === 'accepted' ? 1 : 0)
        expect(run.stores.size).toBe(admission === 'accepted' ? 2 : 0)
        expect(run.snapshots).toHaveLength(2)
        expect(run.events.filter(event => event === (method === 'oauth' ? 'callback' : 'put'))).toHaveLength(1)
      })
    }
  }
  for (const providerId of ['google', 'groq'] as const) {
    for (const execution of ['available', 'not_authenticated'] as const) {
      test(`API ${providerId}: preserves inventory admission and ${execution} execution semantics`, async () => {
        const run = await fixture({ method: 'api', providerId, admission: 'rejected', execution })
        expect(run.snapshots[1]!.connected).toEqual([])
        expect(run.result.ok).toBe(execution === 'available')
        expect(run.events.filter(event => event === 'execution')).toHaveLength(1)
        expect(run.stores.size).toBe(execution === 'available' ? 2 : 0)
      })
    }
  }
})
