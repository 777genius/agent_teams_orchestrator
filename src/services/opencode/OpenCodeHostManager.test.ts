import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'

import { describe, expect, test } from 'bun:test'

import { OpenCodeHostManager } from './OpenCodeHostManager.js'

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
    })

    const handle = await manager.ensureHost({ hostKey: 'host-key' })
    spawned.child.emit('exit', 1, null)

    expect(handle.state).toBe('degraded')
    expect(handle.diagnostics.some(message => message.includes('process exited with code 1'))).toBe(true)
    expect(manager.getHost('host-key')).toBeNull()
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
    })

    const handle = await manager.ensureHost({ hostKey: 'host-key' })
    const initialFingerprint = handle.resolvedConfigFingerprint
    phase = 'refresh'
    const refreshedFingerprint = await manager.refreshResolvedConfigFingerprint('host-key')

    expect(initialFingerprint).not.toBeNull()
    expect(refreshedFingerprint).toBe(initialFingerprint)
  })
})
