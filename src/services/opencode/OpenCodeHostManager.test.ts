import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { describe, expect, test } from 'bun:test'

import {
  OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID,
  OpenCodeHostManager,
} from './OpenCodeHostManager.js'

import type { OpenCodePreparedProfile } from './types.js'

const baseProfile: OpenCodePreparedProfile = {
  projectPath: '/tmp/project',
  profileRootKey: 'profile-root',
  profileRootPath: '/tmp/profile-root',
  projectBehaviorFingerprint: 'behavior-v1',
  behaviorSources: ['AGENTS.md', 'opencode.json'],
  managedConfig: {
    default_agent: 'teammate',
    share: 'disabled',
    snapshot: false,
  },
  managedConfigFingerprint: 'managed-config-v1',
  homePath: '/tmp/profile-root/home',
  xdgConfigHome: '/tmp/profile-root/config',
  xdgDataHome: '/tmp/profile-root/data',
  xdgCacheHome: '/tmp/profile-root/cache',
  managedAuthPath: '/tmp/profile-root/data/opencode/auth.json',
  sourceAuthPath: '/Users/test/.local/share/opencode/auth.json',
  sourceAuthFingerprint: 'source-auth',
  managedAuthFingerprint: 'managed-auth',
  authState: 'ok',
  env: {},
}

function createMockChildProcess(pid = 4242): {
  child: ChildProcess
  killedSignals: Array<NodeJS.Signals | undefined>
} {
  const emitter = new EventEmitter() as ChildProcess
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const killedSignals: Array<NodeJS.Signals | undefined> = []

  Object.assign(emitter, {
    pid,
    stdout,
    stderr,
    kill(signal?: NodeJS.Signals) {
      killedSignals.push(signal)
      return true
    },
  })

  return {
    child: emitter,
    killedSignals,
  }
}

describe('OpenCodeHostManager', () => {
  test('reuses the same host promise for concurrent ensureHost calls', async () => {
    const spawned = createMockChildProcess()
    let spawnCount = 0

    const manager = new OpenCodeHostManager({
      prepareProfile: async () => baseProfile,
      allocateLoopbackPort: async () => 43111,
      spawnHostProcess: () => {
        spawnCount += 1
        return spawned.child
      },
      fetchJson: async (url, init) => {
        if (url.endsWith('/global/health')) {
          return {
            status: 200,
            data: { healthy: true, version: '1.4.0' },
          }
        }
        if (url.endsWith('/config')) {
          return {
            status: 200,
            data: { server: { port: 43111 }, default_agent: 'teammate' },
          }
        }
        if (url.endsWith('/config/providers')) {
          return {
            status: 200,
            data: { providers: [], default: {} },
          }
        }
        if (url.endsWith('/agent')) {
          return {
            status: 200,
            data: [{ name: 'teammate', mode: 'primary' }],
          }
        }
        if (url.endsWith('/mcp')) {
          return {
            status: 200,
            data: {},
          }
        }
        if (url.endsWith('/global/dispose') && init?.method === 'POST') {
          return {
            status: 200,
            data: { ok: true },
          }
        }
        throw new Error(`Unexpected URL ${url}`)
      },
      sleepMs: async () => {},
      persistentRegistryPath: null,
    })

    const [first, second] = await Promise.all([
      manager.ensureHost({ hostKey: 'host-key' }),
      manager.ensureHost({ hostKey: 'host-key' }),
    ])

    expect(spawnCount).toBe(1)
    expect(first).toBe(second)
    expect(first.state).toBe('healthy')
    expect(first.projectBehaviorFingerprint).toBe('behavior-v1')

    await manager.releaseHost('host-key')
    expect(manager.getHost('host-key')?.state).toBe('healthy')

    await manager.releaseHost('host-key')
    expect(manager.getHost('host-key')).toBeNull()
    expect(spawned.killedSignals).toEqual(['SIGTERM'])
  })

  test('drops a host from the registry when the child exits unexpectedly', async () => {
    const spawned = createMockChildProcess()

    const manager = new OpenCodeHostManager({
      prepareProfile: async () => baseProfile,
      allocateLoopbackPort: async () => 43112,
      spawnHostProcess: () => spawned.child,
      fetchJson: async (url) => {
        if (url.endsWith('/global/health')) {
          return {
            status: 200,
            data: { healthy: true, version: '1.4.0' },
          }
        }
        if (url.endsWith('/config')) {
          return {
            status: 200,
            data: { server: { port: 43112 }, default_agent: 'teammate' },
          }
        }
        if (url.endsWith('/config/providers')) {
          return {
            status: 200,
            data: { providers: [], default: {} },
          }
        }
        if (url.endsWith('/agent')) {
          return {
            status: 200,
            data: [{ name: 'teammate', mode: 'primary' }],
          }
        }
        if (url.endsWith('/mcp')) {
          return {
            status: 200,
            data: {},
          }
        }
        return {
          status: 200,
          data: { ok: true },
        }
      },
      sleepMs: async () => {},
      persistentRegistryPath: null,
    })

    const handle = await manager.ensureHost({ hostKey: 'host-key' })
    spawned.child.emit('exit', 1, null)

    expect(handle.state).toBe('degraded')
    expect(handle.diagnostics.some(message => message.includes('process exited with code 1'))).toBe(true)
    expect(manager.getHost('host-key')).toBeNull()
  })

  test('adopts a healthy host from the persistent registry instead of spawning another serve process', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-registry-'))
    const registryPath = path.join(tempDir, 'host-registry.json')
    const spawned = createMockChildProcess()
    let spawnCount = 0
    const fetchJson = async (url: string) => {
      if (url.endsWith('/global/health')) {
        return {
          status: 200,
          data: { healthy: true, version: '1.4.0' },
        }
      }
      if (url.endsWith('/config')) {
        return {
          status: 200,
          data: { server: { port: 43114 }, default_agent: 'teammate' },
        }
      }
      if (url.endsWith('/config/providers')) {
        return {
          status: 200,
          data: { providers: [], default: {} },
        }
      }
      if (url.endsWith('/agent')) {
        return {
          status: 200,
          data: [{ name: 'teammate', mode: 'primary' }],
        }
      }
      if (url.endsWith('/mcp')) {
        return {
          status: 200,
          data: {},
        }
      }
      return {
        status: 200,
        data: { ok: true },
      }
    }

    try {
      const firstManager = new OpenCodeHostManager({
        prepareProfile: async () => baseProfile,
        allocateLoopbackPort: async () => 43114,
        spawnHostProcess: () => {
          spawnCount += 1
          return spawned.child
        },
        fetchJson,
        sleepMs: async () => {},
        persistentRegistryPath: registryPath,
      })
      const created = await firstManager.ensureHost({ hostKey: 'host-key' })

      const secondManager = new OpenCodeHostManager({
        prepareProfile: async () => baseProfile,
        allocateLoopbackPort: async () => 49999,
        spawnHostProcess: () => {
          throw new Error('should adopt existing host')
        },
        fetchJson,
        sleepMs: async () => {},
        isProcessAlive: pid => pid === created.pid,
        persistentRegistryPath: registryPath,
      })
      const adopted = await secondManager.ensureHost({ hostKey: 'host-key' })

      expect(spawnCount).toBe(1)
      expect(adopted.pid).toBe(created.pid)
      expect(adopted.baseUrl).toBe(created.baseUrl)
      expect(adopted.diagnostics.some(message => message.includes('adopted persistent OpenCode host'))).toBe(true)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('persists and releases team leases for a managed host', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-registry-'))
    const registryPath = path.join(tempDir, 'host-registry.json')
    const spawned = createMockChildProcess()
    let now = new Date('2026-04-24T10:00:00.000Z')

    try {
      const manager = new OpenCodeHostManager({
        prepareProfile: async () => baseProfile,
        allocateLoopbackPort: async () => 43115,
        spawnHostProcess: () => spawned.child,
        fetchJson: async (url) => {
          if (url.endsWith('/global/health')) {
            return { status: 200, data: { healthy: true, version: '1.4.0' } }
          }
          if (url.endsWith('/config')) {
            return { status: 200, data: { server: { port: 43115 } } }
          }
          if (url.endsWith('/config/providers')) {
            return { status: 200, data: { providers: [] } }
          }
          if (url.endsWith('/agent')) {
            return { status: 200, data: [] }
          }
          if (url.endsWith('/mcp')) {
            return { status: 200, data: {} }
          }
          return { status: 200, data: { ok: true } }
        },
        now: () => now,
        sleepMs: async () => {},
        persistentRegistryPath: registryPath,
      })

      const handle = await manager.ensureHost({ hostKey: 'host-key' })
      await manager.retainHostLease(handle.hostKey, {
        teamId: 'team-a',
        laneId: 'primary',
        memberName: 'alice',
        runId: 'run-1',
        sessionId: 'session-1',
      })

      let registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
        hosts: Record<string, { leases?: Record<string, unknown> }>
      }
      expect(Object.keys(registry.hosts['host-key']?.leases ?? {})).toEqual([
        'team-a::primary::alice',
      ])
      expect(registry.hosts['host-key']?.leases?.['team-a::primary::alice']).toMatchObject({
        updatedAt: '2026-04-24T10:00:00.000Z',
      })

      now = new Date('2026-04-24T10:00:30.000Z')
      await manager.retainHostLease(handle.hostKey, {
        teamId: 'team-a',
        laneId: 'primary',
        memberName: 'alice',
        runId: 'run-1',
        sessionId: 'session-1',
      })
      registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
        hosts: Record<string, { leases?: Record<string, Record<string, unknown>> }>
      }
      expect(registry.hosts['host-key']?.leases?.['team-a::primary::alice']).toMatchObject({
        updatedAt: '2026-04-24T10:00:00.000Z',
      })

      await manager.releaseHostLease(handle.hostKey, {
        teamId: 'team-a',
        laneId: 'primary',
        memberName: 'alice',
      })
      registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
        hosts: Record<string, { leases?: Record<string, unknown> }>
      }
      expect(registry.hosts['host-key']?.leases).toEqual({})
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('preserves concurrent lease updates across short-lived CLI processes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-registry-'))
    const registryPath = path.join(tempDir, 'host-registry.json')

    try {
      await writeFile(
        registryPath,
        JSON.stringify({
          schemaVersion: 1,
          hosts: {
            'host-key': {
              hostKey: 'host-key',
              profileRootKey: 'profile-root',
              projectPath: '/tmp/project',
              projectBehaviorFingerprint: 'behavior-v1',
              baseUrl: 'http://127.0.0.1:43115',
              port: 43115,
              pid: 43115,
              version: '1.4.0',
              resolvedConfigFingerprint: null,
              updatedAt: '2026-04-24T10:00:00.000Z',
              leases: {},
            },
          },
        }),
        'utf8',
      )
      const createManager = () => new OpenCodeHostManager({
        now: () => new Date('2026-04-24T10:01:00.000Z'),
        persistentRegistryPath: registryPath,
      })

      await Promise.all([
        createManager().retainHostLease('host-key', {
          teamId: 'team-a',
          laneId: 'primary',
          memberName: 'alice',
          runId: 'run-1',
          sessionId: 'session-alice',
        }),
        createManager().retainHostLease('host-key', {
          teamId: 'team-a',
          laneId: 'primary',
          memberName: 'bob',
          runId: 'run-1',
          sessionId: 'session-bob',
        }),
      ])

      const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
        hosts: Record<string, { leases?: Record<string, unknown> }>
      }
      expect(Object.keys(registry.hosts['host-key']?.leases ?? {}).sort()).toEqual([
        'team-a::primary::alice',
        'team-a::primary::bob',
      ])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('startup cleanup disposes stale registry hosts without active leases', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-registry-'))
    const registryPath = path.join(tempDir, 'host-registry.json')
    const killedSignals: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const disposeUrls: string[] = []

    try {
      await writeFile(
        registryPath,
        JSON.stringify({
          schemaVersion: 1,
          hosts: {
            'host-key': {
              hostKey: 'host-key',
              profileRootKey: 'profile-root',
              projectPath: '/tmp/project',
              projectBehaviorFingerprint: 'behavior-v1',
              baseUrl: 'http://127.0.0.1:43116',
              port: 43116,
              pid: 43116,
              version: '1.4.0',
              resolvedConfigFingerprint: null,
              updatedAt: '2026-04-24T09:00:00.000Z',
              leases: {},
            },
          },
        }),
        'utf8',
      )
      const manager = new OpenCodeHostManager({
        fetchJson: async (url) => {
          disposeUrls.push(url)
          return { status: 200, data: { ok: true } }
        },
        isProcessAlive: pid => pid === 43116,
        killProcess: (pid, signal) => {
          killedSignals.push({ pid, signal })
        },
        now: () => new Date('2026-04-24T10:00:00.000Z'),
        sleepMs: async () => {},
        persistentRegistryPath: registryPath,
      })

      const result = await manager.reconcilePersistentHosts({
        reason: 'startup',
        mode: 'stale',
        staleAgeMs: 1_000,
      })

      expect(result.cleaned).toBe(1)
      expect(result.hosts[0]?.action).toBe('disposed')
      expect(disposeUrls).toEqual(['http://127.0.0.1:43116/global/dispose'])
      expect(killedSignals).toEqual([{ pid: 43116, signal: 'SIGTERM' }])
      await expect(readFile(registryPath, 'utf8')).rejects.toThrow()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('startup cleanup keeps leased registry hosts', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-registry-'))
    const registryPath = path.join(tempDir, 'host-registry.json')
    const killedSignals: Array<NodeJS.Signals> = []

    try {
      await writeFile(
        registryPath,
        JSON.stringify({
          schemaVersion: 1,
          hosts: {
            'host-key': {
              hostKey: 'host-key',
              profileRootKey: 'profile-root',
              projectPath: '/tmp/project',
              projectBehaviorFingerprint: 'behavior-v1',
              baseUrl: 'http://127.0.0.1:43117',
              port: 43117,
              pid: 43117,
              version: '1.4.0',
              resolvedConfigFingerprint: null,
              updatedAt: '2026-04-24T09:00:00.000Z',
              leases: {
                'team-a::primary::alice': {
                  leaseKey: 'team-a::primary::alice',
                  teamId: 'team-a',
                  laneId: 'primary',
                  memberName: 'alice',
                  runId: 'run-1',
                  sessionId: 'session-1',
                  createdAt: '2026-04-24T09:00:00.000Z',
                  updatedAt: '2026-04-24T09:00:00.000Z',
                },
              },
            },
          },
        }),
        'utf8',
      )
      const manager = new OpenCodeHostManager({
        fetchJson: async () => {
          throw new Error('leased host should not be disposed')
        },
        isProcessAlive: pid => pid === 43117,
        killProcess: (_pid, signal) => {
          killedSignals.push(signal)
        },
        now: () => new Date('2026-04-24T10:00:00.000Z'),
        sleepMs: async () => {},
        persistentRegistryPath: registryPath,
      })

      const result = await manager.reconcilePersistentHosts({
        reason: 'startup',
        mode: 'stale',
        staleAgeMs: 1_000,
      })

      expect(result.cleaned).toBe(0)
      expect(result.hosts[0]?.action).toBe('kept_leased')
      expect(killedSignals).toEqual([])
      const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
        hosts: Record<string, unknown>
      }
      expect(Object.keys(registry.hosts)).toEqual(['host-key'])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('startup cleanup drops stale preflight leases without touching team leases', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-registry-'))
    const registryPath = path.join(tempDir, 'host-registry.json')
    const disposedUrls: string[] = []
    const killedSignals: Array<{ pid: number; signal: NodeJS.Signals }> = []

    try {
      await writeFile(
        registryPath,
        JSON.stringify({
          schemaVersion: 1,
          hosts: {
            'host-preflight': {
              hostKey: 'host-preflight',
              profileRootKey: 'profile-root',
              projectPath: '/tmp/project',
              projectBehaviorFingerprint: 'behavior-v1',
              baseUrl: 'http://127.0.0.1:43120',
              port: 43120,
              pid: 43120,
              version: '1.4.0',
              resolvedConfigFingerprint: null,
              updatedAt: '2026-04-24T09:59:30.000Z',
              leases: {
                [`${OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID}::preflight::readiness`]: {
                  leaseKey: `${OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID}::preflight::readiness`,
                  teamId: OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID,
                  laneId: 'preflight',
                  memberName: 'readiness',
                  runId: null,
                  sessionId: null,
                  createdAt: '2026-04-24T09:50:00.000Z',
                  updatedAt: '2026-04-24T09:55:00.000Z',
                },
              },
            },
            'host-team': {
              hostKey: 'host-team',
              profileRootKey: 'profile-root',
              projectPath: '/tmp/project',
              projectBehaviorFingerprint: 'behavior-v1',
              baseUrl: 'http://127.0.0.1:43121',
              port: 43121,
              pid: 43121,
              version: '1.4.0',
              resolvedConfigFingerprint: null,
              updatedAt: '2026-04-24T09:59:30.000Z',
              leases: {
                'team-a::primary::alice': {
                  leaseKey: 'team-a::primary::alice',
                  teamId: 'team-a',
                  laneId: 'primary',
                  memberName: 'alice',
                  runId: 'run-1',
                  sessionId: 'session-1',
                  createdAt: '2026-04-24T09:50:00.000Z',
                  updatedAt: '2026-04-24T09:50:00.000Z',
                },
              },
            },
          },
        }),
        'utf8',
      )
      const manager = new OpenCodeHostManager({
        fetchJson: async (url) => {
          disposedUrls.push(url)
          return { status: 200, data: { ok: true } }
        },
        isProcessAlive: pid => pid === 43120 || pid === 43121,
        killProcess: (pid, signal) => {
          killedSignals.push({ pid, signal })
        },
        now: () => new Date('2026-04-24T10:00:00.000Z'),
        sleepMs: async () => {},
        persistentRegistryPath: registryPath,
      })

      const result = await manager.reconcilePersistentHosts({
        reason: 'startup',
        mode: 'stale',
        staleAgeMs: 5 * 60_000,
        leaseStaleAgeMs: null,
        preflightLeaseStaleAgeMs: 2 * 60_000,
      })

      const byHost = new Map(result.hosts.map(host => [host.hostKey, host]))
      expect(result.cleaned).toBe(1)
      expect(byHost.get('host-preflight')?.action).toBe('disposed')
      expect(byHost.get('host-preflight')?.leaseCount).toBe(0)
      expect(byHost.get('host-team')?.action).toBe('kept_leased')
      expect(disposedUrls).toEqual(['http://127.0.0.1:43120/global/dispose'])
      expect(killedSignals).toEqual([{ pid: 43120, signal: 'SIGTERM' }])
      const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
        hosts: Record<string, unknown>
      }
      expect(Object.keys(registry.hosts)).toEqual(['host-team'])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('shutdown cleanup force-disposes leased registry hosts', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-registry-'))
    const registryPath = path.join(tempDir, 'host-registry.json')
    const killedSignals: Array<{ pid: number; signal: NodeJS.Signals }> = []

    try {
      await writeFile(
        registryPath,
        JSON.stringify({
          schemaVersion: 1,
          hosts: {
            'host-key': {
              hostKey: 'host-key',
              profileRootKey: 'profile-root',
              projectPath: '/tmp/project',
              projectBehaviorFingerprint: 'behavior-v1',
              baseUrl: 'http://127.0.0.1:43118',
              port: 43118,
              pid: 43118,
              version: '1.4.0',
              resolvedConfigFingerprint: null,
              updatedAt: '2026-04-24T09:00:00.000Z',
              leases: {
                'team-a::primary::alice': {
                  leaseKey: 'team-a::primary::alice',
                  teamId: 'team-a',
                  laneId: 'primary',
                  memberName: 'alice',
                  runId: 'run-1',
                  sessionId: 'session-1',
                  createdAt: '2026-04-24T09:00:00.000Z',
                  updatedAt: '2026-04-24T09:00:00.000Z',
                },
              },
            },
          },
        }),
        'utf8',
      )
      const manager = new OpenCodeHostManager({
        fetchJson: async () => ({ status: 200, data: { ok: true } }),
        isProcessAlive: pid => pid === 43118,
        killProcess: (pid, signal) => {
          killedSignals.push({ pid, signal })
        },
        now: () => new Date('2026-04-24T10:00:00.000Z'),
        sleepMs: async () => {},
        persistentRegistryPath: registryPath,
      })

      const result = await manager.reconcilePersistentHosts({
        reason: 'shutdown',
        mode: 'force',
      })

      expect(result.cleaned).toBe(1)
      expect(result.hosts[0]?.action).toBe('disposed')
      expect(killedSignals).toEqual([
        { pid: 43118, signal: 'SIGTERM' },
        { pid: 43118, signal: 'SIGKILL' },
      ])
      await expect(readFile(registryPath, 'utf8')).rejects.toThrow()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('keeps the resolved fingerprint stable across host transport drift', async () => {
    const spawned = createMockChildProcess()
    let phase: 'initial' | 'refresh' = 'initial'

    const manager = new OpenCodeHostManager({
      prepareProfile: async () => baseProfile,
      allocateLoopbackPort: async () => 43113,
      spawnHostProcess: () => spawned.child,
      fetchJson: async (url) => {
        if (url.endsWith('/global/health')) {
          return {
            status: 200,
            data: { healthy: true, version: '1.4.0' },
          }
        }
        if (url.endsWith('/config')) {
          return {
            status: 200,
            data: phase === 'initial'
              ? {
                  server: { port: 43113 },
                  default_agent: 'teammate',
                  mcp: {
                    'agent-teams': {
                      command: ['node', 'cli.js'],
                      environment: { PATH: '/usr/bin', TMPDIR: '/tmp/a' },
                    },
                  },
                }
              : {
                  server: { port: 45888 },
                  default_agent: 'teammate',
                  mcp: {
                    'agent-teams': {
                      command: ['node', 'cli.js'],
                      environment: { PATH: '/opt/homebrew/bin', TMPDIR: '/tmp/b' },
                    },
                  },
                },
          }
        }
        if (url.endsWith('/config/providers')) {
          return {
            status: 200,
            data: phase === 'initial'
              ? {
                  providers: [
                    { id: 'openai', models: { 'gpt-5.4-mini': {} } },
                    { id: 'moonshot', models: { 'kimi-k2': {} } },
                  ],
                }
              : {
                  providers: [
                    { id: 'moonshot', models: { 'kimi-k2': {} } },
                    { id: 'openai', models: { 'gpt-5.4-mini': {} } },
                  ],
                },
          }
        }
        if (url.endsWith('/agent')) {
          return {
            status: 200,
            data: phase === 'initial'
              ? [
                  { name: 'teammate', mode: 'primary' },
                  { name: 'reviewer', mode: 'subagent' },
                ]
              : [
                  { name: 'reviewer', mode: 'subagent' },
                  { name: 'teammate', mode: 'primary' },
                ],
          }
        }
        if (url.endsWith('/mcp')) {
          return {
            status: 200,
            data: phase === 'initial'
              ? {
                  'agent-teams': {
                    connected: true,
                    transport: { pid: 999, port: 1234 },
                  },
                }
              : {
                  'agent-teams': {
                    connected: false,
                    transport: { pid: 1001, port: 5678 },
                  },
                },
          }
        }
        return {
          status: 200,
          data: { ok: true },
        }
      },
      sleepMs: async () => {},
      persistentRegistryPath: null,
    })

    const handle = await manager.ensureHost({ hostKey: 'host-key' })
    const initialFingerprint = handle.resolvedConfigFingerprint
    phase = 'refresh'
    const refreshedFingerprint = await manager.refreshResolvedConfigFingerprint('host-key')

    expect(initialFingerprint).not.toBeNull()
    expect(refreshedFingerprint).toBe(initialFingerprint)
  })
})
