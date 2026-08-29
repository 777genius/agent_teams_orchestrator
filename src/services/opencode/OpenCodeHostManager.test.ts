import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { describe, expect, test } from 'bun:test'

import {
  OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID,
  OpenCodeHostManager,
  buildOpenCodeHostProfileIdentity,
  buildOpenCodeHostSpawnOptions,
  resolveOpenCodeBinaryHostIdentity,
  shouldUnrefOpenCodeHostProcess,
} from './OpenCodeHostManager.js'
import { resolveOpenCodeProfileScope } from './OpenCodeProfileManager.js'

import type { OpenCodePreparedProfile } from './types.js'

const baseProfile: OpenCodePreparedProfile = {
  projectPath: '/tmp/project',
  canonicalProjectPath: '/tmp/project',
  workingDirectoryPath: '/tmp/project',
  scopeToken: null,
  profileRootKey: 'profile-root',
  profileRootPath: '/tmp/profile-root',
  projectBehaviorFingerprint: 'behavior-v1',
  behaviorSources: ['AGENTS.md', 'opencode.json'],
  managedConfig: {
    default_agent: 'teammate',
    share: 'disabled',
    snapshot: true,
  },
  managedConfigFingerprint: 'managed-config-v1',
  homePath: '/tmp/profile-root/home',
  tmpPath: '/tmp/profile-root/tmp',
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
  unrefCalls: string[]
} {
  const emitter = new EventEmitter() as ChildProcess
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const killedSignals: Array<NodeJS.Signals | undefined> = []
  const unrefCalls: string[] = []

  Object.assign(emitter, {
    pid,
    stdout,
    stderr,
    unref() {
      unrefCalls.push('child')
    },
    kill(signal?: NodeJS.Signals) {
      killedSignals.push(signal)
      return true
    },
  })
  Object.assign(stdout, {
    unref() {
      unrefCalls.push('stdout')
    },
  })
  Object.assign(stderr, {
    unref() {
      unrefCalls.push('stderr')
    },
  })

  return {
    child: emitter,
    killedSignals,
    unrefCalls,
  }
}

test('changes the persistent host identity when the OpenCode binary changes', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-binary-identity-'))
  const binaryPath = path.join(tempDir, 'opencode')
  try {
    await writeFile(binaryPath, 'version-one')
    const first = await resolveOpenCodeBinaryHostIdentity(binaryPath)
    expect(await resolveOpenCodeBinaryHostIdentity(binaryPath)).toBe(first)

    await writeFile(binaryPath, 'version-two-with-a-different-size')
    expect(await resolveOpenCodeBinaryHostIdentity(binaryPath)).not.toBe(first)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

function createDeferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

describe('OpenCodeHostManager', () => {
  test('isolates scoped hosts by the bound resolver scope token', () => {
    const scoped = {
      ...baseProfile,
      scopeToken: 'current-token',
      profileScope: {
        purpose: 'catalog' as const,
        providerId: 'custom',
        configFingerprint: 'config-a',
        selectedAuthIdentity: 'known:auth-a' as const,
        scopeToken: 'current-token',
      },
    }
    const changed = {
      ...scoped,
      profileScope: { ...scoped.profileScope, selectedAuthIdentity: 'known:auth-b' as const },
    }
    expect(buildOpenCodeHostProfileIdentity(scoped, 'binary-a'))
      .not.toBe(buildOpenCodeHostProfileIdentity(changed, 'binary-a'))
    expect(buildOpenCodeHostProfileIdentity(scoped, 'binary-a')).toContain('auth:known:auth-a')
  })

  test('starts a fresh persistent host when managed OpenCode auth changes', async () => {
    let profile = baseProfile
    let port = 43150
    let spawnCount = 0
    const manager = new OpenCodeHostManager({
      prepareProfile: async () => profile,
      allocateLoopbackPort: async () => {
        port += 1
        return port
      },
      spawnHostProcess: () => {
        spawnCount += 1
        const spawned = createMockChildProcess(50_000 + spawnCount)
        return spawned.child
      },
      fetchJson: async url => {
        if (url.endsWith('/global/health')) {
          return { status: 200, data: { healthy: true, version: '1.17.18' } }
        }
        if (url.endsWith('/config')) {
          return { status: 200, data: { default_agent: 'teammate' } }
        }
        if (url.endsWith('/config/providers')) {
          return { status: 200, data: { providers: [], default: {} } }
        }
        if (url.endsWith('/agent')) {
          return { status: 200, data: [] }
        }
        if (url.endsWith('/mcp')) {
          return { status: 200, data: {} }
        }
        throw new Error(`Unexpected URL ${url}`)
      },
      sleepMs: async () => {},
      persistentRegistryPath: null,
    })

    const beforeAuthRefresh = await manager.ensureHost({ hostLifetime: 'persistent' })
    profile = {
      ...baseProfile,
      managedAuthFingerprint: 'managed-auth-refreshed',
    }
    const afterAuthRefresh = await manager.ensureHost({ hostLifetime: 'persistent' })

    expect(afterAuthRefresh.hostKey).not.toBe(beforeAuthRefresh.hostKey)
    expect(afterAuthRefresh.pid).not.toBe(beforeAuthRefresh.pid)
    expect(spawnCount).toBe(2)

    await manager.disposeHost(beforeAuthRefresh.hostKey)
    await manager.disposeHost(afterAuthRefresh.hostKey)
  })

  test('keeps persistent OpenCode hosts detached on Windows so launch hosts survive bridge exit', () => {
    const profile = {
      ...baseProfile,
      env: {
        OPENCODE_SERVER_PASSWORD: 'secret',
      },
    }

    expect(buildOpenCodeHostSpawnOptions(profile, 'win32')).toEqual({
      cwd: profile.projectPath,
      env: profile.env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
  })

  test('starts catalog hosts from the isolated profile-owned working directory', () => {
    const profile = {
      ...baseProfile,
      workingDirectoryPath: '/managed/catalog-workspace',
    }
    expect(buildOpenCodeHostSpawnOptions(profile, 'linux').cwd)
      .toBe('/managed/catalog-workspace')
  })

  test('rejects prepared host reuse when the resolver scope token differs', async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-scope-'))
    try {
      const profileScope = await resolveOpenCodeProfileScope({
        projectPath,
        purpose: 'catalog',
        selectedModel: 'custom/catalog',
      })
      await expect(new OpenCodeHostManager().ensureHost({
        projectPath,
        preparedProfile: {
          ...baseProfile,
          projectPath,
          canonicalProjectPath: projectPath,
          workingDirectoryPath: path.join(projectPath, 'catalog'),
          profileScope,
          scopeToken: 'different-token',
        },
      })).rejects.toThrow('scope token is invalid or expired')
    } finally {
      await rm(projectPath, { recursive: true, force: true })
    }
  })

  test('keeps process-scoped OpenCode hosts attached on Windows to avoid console popup detachment', () => {
    expect(
      buildOpenCodeHostSpawnOptions(baseProfile, 'win32', {
        lifetime: 'process',
      }),
    ).toMatchObject({
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
    })
  })

  test('keeps OpenCode host detached on POSIX platforms', () => {
    expect(buildOpenCodeHostSpawnOptions(baseProfile, 'darwin')).toMatchObject({
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
  })

  test('keeps Windows process-scoped hosts referenced until explicit release', () => {
    expect(shouldUnrefOpenCodeHostProcess('process', 'win32')).toBe(false)
    expect(shouldUnrefOpenCodeHostProcess('persistent', 'win32')).toBe(true)
    expect(shouldUnrefOpenCodeHostProcess('process', 'darwin')).toBe(true)
  })

  test('does not persist process-scoped hosts into the cross-process registry', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-registry-'))
    const registryPath = path.join(tempDir, 'host-registry.json')
    const spawned = createMockChildProcess(43138)

    const manager = new OpenCodeHostManager({
      prepareProfile: async () => baseProfile,
      allocateLoopbackPort: async () => 43138,
      spawnHostProcess: () => spawned.child,
      fetchJson: async url => {
        if (url.endsWith('/global/health')) {
          return {
            status: 200,
            data: { healthy: true, version: '1.4.0' },
          }
        }
        if (url.endsWith('/config')) {
          return {
            status: 200,
            data: { server: { port: 43138 }, default_agent: 'teammate' },
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
      persistentRegistryPath: registryPath,
    })

    let hostKey: string | null = null

    try {
      const handle = await manager.ensureHost({ hostLifetime: 'process' })
      hostKey = handle.hostKey
      expect(handle.hostKey).toContain('::process:')
      await manager.retainHostLease(handle.hostKey, {
        teamId: 'team-1',
        memberName: 'alice',
      })
      await expect(readFile(registryPath, 'utf8')).rejects.toThrow()
    } finally {
      if (hostKey) {
        await manager.releaseHost(hostKey).catch(() => undefined)
      }
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('captures process identity before releasing a process-scoped host', async () => {
    const spawned = createMockChildProcess(43140)
    const killedSignals: NodeJS.Signals[] = []
    let processAlive = true
    let identityReadCalls = 0

    const manager = new OpenCodeHostManager({
      prepareProfile: async () => baseProfile,
      allocateLoopbackPort: async () => 43140,
      spawnHostProcess: () => spawned.child,
      fetchJson: async url => {
        if (url.endsWith('/global/health')) {
          return { status: 200, data: { healthy: true, version: '1.4.0' } }
        }
        if (url.endsWith('/config')) {
          return { status: 200, data: { default_agent: 'teammate' } }
        }
        if (url.endsWith('/global/dispose')) {
          return { status: 200, data: { ok: true } }
        }
        throw new Error(`Unexpected URL ${url}`)
      },
      isProcessAlive: pid => pid === spawned.child.pid && processAlive,
      readProcessStartTimeMs: async pid => {
        identityReadCalls += 1
        return pid === spawned.child.pid && identityReadCalls >= 3 ? 1_000 : null
      },
      killProcess: (_pid, signal) => {
        killedSignals.push(signal)
        processAlive = false
      },
      sleepMs: async () => {},
      persistentRegistryPath: null,
    })

    const handle = await manager.ensureHost({ hostLifetime: 'process' })
    expect(handle.processStartedAtMs).toBe(1_000)
    expect(identityReadCalls).toBe(3)

    await manager.releaseHost(handle.hostKey)

    expect(killedSignals).toEqual(['SIGTERM'])
    expect(manager.getHost(handle.hostKey)).toBeNull()
  })

  test('cleans OpenTUI temp dylibs after disposing an owned host', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-temp-'))
    const tmpPath = path.join(tempDir, 'tmp')
    await mkdir(tmpPath, { recursive: true })
    const profile: OpenCodePreparedProfile = {
      ...baseProfile,
      profileRootPath: tempDir,
      tmpPath,
    }
    const dylibPaths = [
      path.join(tmpPath, '.bbb6fbfdecfffefd-00000000.dylib'),
      path.join(tmpPath, '.bbc7fffde8b6fead-00000000.dylib'),
      path.join(tmpPath, '.b9dd7ef5eafe1fea-00000000.dylib'),
    ]
    const keepPath = path.join(tmpPath, 'keep.txt')
    const keepDylibPath = path.join(tmpPath, '.plugin-cache.dylib')
    const spawned = createMockChildProcess(43139)
    let processAlive = true

    const manager = new OpenCodeHostManager({
      prepareProfile: async () => profile,
      allocateLoopbackPort: async () => 43139,
      spawnHostProcess: () => spawned.child,
      fetchJson: async url => {
        if (url.endsWith('/global/health')) {
          return { status: 200, data: { healthy: true, version: '1.4.0' } }
        }
        if (url.endsWith('/config')) {
          return {
            status: 200,
            data: { server: { port: 43139 }, default_agent: 'teammate' },
          }
        }
        if (url.endsWith('/config/providers')) {
          return { status: 200, data: { providers: [], default: {} } }
        }
        if (url.endsWith('/agent')) {
          return { status: 200, data: [{ name: 'teammate', mode: 'primary' }] }
        }
        if (url.endsWith('/mcp')) {
          return { status: 200, data: {} }
        }
        return { status: 200, data: { ok: true } }
      },
      isProcessAlive: pid => pid === spawned.child.pid && processAlive,
      sleepMs: async () => {},
      killProcess: (_pid, signal) => {
        spawned.killedSignals.push(signal)
        processAlive = false
      },
      persistentRegistryPath: null,
    })

    try {
      await manager.ensureHost({ hostKey: 'host-key' })
      await Promise.all(dylibPaths.map(dylibPath => writeFile(dylibPath, 'temp dylib', 'utf8')))
      await writeFile(keepPath, 'keep', 'utf8')
      await writeFile(keepDylibPath, 'keep dylib', 'utf8')

      await manager.disposeHost('host-key')

      expect(await Promise.all(dylibPaths.map(pathExists))).toEqual([false, false, false])
      expect(await pathExists(keepPath)).toBe(true)
      expect(await pathExists(keepDylibPath)).toBe(true)
      expect(spawned.killedSignals).toEqual(['SIGTERM'])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('keeps OpenTUI temp dylibs while another host sharing the profile is alive', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-shared-temp-'))
    const tmpPath = path.join(tempDir, 'tmp')
    await mkdir(tmpPath, { recursive: true })
    const profile: OpenCodePreparedProfile = {
      ...baseProfile,
      profileRootPath: tempDir,
      tmpPath,
    }
    const dylibPath = path.join(tmpPath, '.bbb6fbfdecfffefd-00000000.dylib')
    const spawnedHosts = [createMockChildProcess(43139), createMockChildProcess(43140)]
    const alivePids = new Set<number>([43139, 43140])
    let spawnIndex = 0
    let nextPort = 43139

    const manager = new OpenCodeHostManager({
      prepareProfile: async () => profile,
      allocateLoopbackPort: async () => nextPort++,
      spawnHostProcess: () => spawnedHosts[spawnIndex++].child,
      fetchJson: async url => {
        if (url.endsWith('/global/health')) {
          return { status: 200, data: { healthy: true, version: '1.4.0' } }
        }
        if (url.endsWith('/config')) {
          return { status: 200, data: { default_agent: 'teammate' } }
        }
        if (url.endsWith('/config/providers')) {
          return { status: 200, data: { providers: [], default: {} } }
        }
        if (url.endsWith('/agent')) {
          return { status: 200, data: [{ name: 'teammate', mode: 'primary' }] }
        }
        if (url.endsWith('/mcp')) {
          return { status: 200, data: {} }
        }
        return { status: 200, data: { ok: true } }
      },
      isProcessAlive: pid => alivePids.has(pid),
      sleepMs: async () => {},
      killProcess: (pid, signal) => {
        spawnedHosts.find(spawned => spawned.child.pid === pid)?.killedSignals.push(signal)
        alivePids.delete(pid)
      },
      persistentRegistryPath: null,
    })

    try {
      await manager.ensureHost({ hostKey: 'host-a' })
      await writeFile(dylibPath, 'temp dylib', 'utf8')

      await manager.ensureHost({ hostKey: 'host-b' })
      expect(await pathExists(dylibPath)).toBe(true)

      await manager.disposeHost('host-a')
      expect(await pathExists(dylibPath)).toBe(true)

      await manager.disposeHost('host-b')
      expect(await pathExists(dylibPath)).toBe(false)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('reuses the same host promise for concurrent ensureHost calls', async () => {
    const spawned = createMockChildProcess()
    let spawnCount = 0
    let processAlive = true

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
      isProcessAlive: pid => pid === spawned.child.pid && processAlive,
      killProcess: (_pid, signal) => {
        spawned.killedSignals.push(signal)
        processAlive = false
      },
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
    expect(spawned.unrefCalls).toEqual(['child', 'stdout', 'stderr'])

    await manager.releaseHost('host-key')
    expect(manager.getHost('host-key')?.state).toBe('healthy')

    await manager.releaseHost('host-key')
    expect(manager.getHost('host-key')).toBeNull()
    expect(spawned.killedSignals).toEqual(['SIGTERM'])
  })

  test('force-kills an owned host that survives release SIGTERM', async () => {
    const spawned = createMockChildProcess()
    let spawnCount = 0
    let processAlive = true

    const manager = new OpenCodeHostManager({
      prepareProfile: async () => baseProfile,
      allocateLoopbackPort: async () => 43119,
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
            data: { server: { port: 43119 }, default_agent: 'teammate' },
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
      isProcessAlive: pid => pid === spawned.child.pid && processAlive,
      sleepMs: async () => {},
      killProcess: (_pid, signal) => {
        spawned.killedSignals.push(signal)
        if (signal === 'SIGKILL') processAlive = false
      },
      persistentRegistryPath: null,
    })

    await manager.ensureHost({ hostKey: 'host-key' })
    expect(spawnCount).toBe(1)

    await manager.releaseHost('host-key')

    expect(manager.getHost('host-key')).toBeNull()
    expect(spawned.killedSignals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  test('keeps an explicitly persistent host alive for adoption by the next CLI process', async () => {
    const spawned = createMockChildProcess(43118)
    const manager = new OpenCodeHostManager({
      prepareProfile: async () => baseProfile,
      allocateLoopbackPort: async () => 43118,
      spawnHostProcess: () => spawned.child,
      fetchJson: async url => {
        if (url.endsWith('/global/health')) {
          return { status: 200, data: { healthy: true, version: '1.15.7' } }
        }
        if (url.endsWith('/config')) {
          return { status: 200, data: { default_agent: 'teammate' } }
        }
        if (url.endsWith('/config/providers')) {
          return { status: 200, data: { providers: [], default: {} } }
        }
        if (url.endsWith('/agent')) {
          return { status: 200, data: [] }
        }
        if (url.endsWith('/mcp')) {
          return { status: 200, data: {} }
        }
        throw new Error(`Unexpected URL ${url}`)
      },
      sleepMs: async () => {},
      persistentRegistryPath: null,
    })

    await manager.ensureHost({
      hostKey: 'provider-management-host',
      hostLifetime: 'persistent',
    })
    await manager.releaseHost('provider-management-host', {
      keepPersistentAlive: true,
    })

    expect(manager.getHost('provider-management-host')?.state).toBe('healthy')
    expect(spawned.killedSignals).toEqual([])

    await manager.disposeHost('provider-management-host')
  })

  test('keeps a healthy host usable when resolved fingerprint probing fails', async () => {
    const spawned = createMockChildProcess()

    const manager = new OpenCodeHostManager({
      prepareProfile: async () => baseProfile,
      allocateLoopbackPort: async () => 43120,
      spawnHostProcess: () => spawned.child,
      fetchJson: async url => {
        if (url.endsWith('/global/health')) {
          return {
            status: 200,
            data: { healthy: true, version: '1.4.0' },
          }
        }
        if (url.endsWith('/config')) {
          throw new Error('fingerprint probe unavailable')
        }
        throw new Error(`Unexpected URL ${url}`)
      },
      sleepMs: async () => {},
      persistentRegistryPath: null,
    })

    const handle = await manager.ensureHost({ hostKey: 'host-key' })

    expect(handle.state).toBe('healthy')
    expect(handle.resolvedConfigFingerprint).toBeNull()
  })

  test('drops a host from the registry when the child exits unexpectedly', async () => {
    const spawned = createMockChildProcess()

    const manager = new OpenCodeHostManager({
      prepareProfile: async () => baseProfile,
      allocateLoopbackPort: async () => 43112,
      spawnHostProcess: () => spawned.child,
      fetchJson: async url => {
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
    expect(handle.diagnostics.some(message => message.includes('process exited with code 1'))).toBe(
      true,
    )
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
        readProcessStartTimeMs: async () => null,
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
        readProcessStartTimeMs: async () => 1_000,
        readProcessCommandLine: async () =>
          `"C:\\managed\\opencode.exe" serve --hostname 127.0.0.1 --port ${created.port}`,
        persistentRegistryPath: registryPath,
      })
      const reconciliation = await secondManager.reconcilePersistentHosts({
        reason: 'startup',
        staleAgeMs: 5 * 60_000,
      })
      const adopted = await secondManager.ensureHost({ hostKey: 'host-key' })

      expect(spawnCount).toBe(1)
      expect(reconciliation.hosts[0]).toMatchObject({ action: 'kept_recent' })
      expect(
        reconciliation.diagnostics.some(message =>
          message.includes('Upgraded legacy OpenCode host process identity'),
        ),
      ).toBe(true)
      expect(adopted.pid).toBe(created.pid)
      expect(adopted.baseUrl).toBe(created.baseUrl)
      expect(
        adopted.diagnostics.some(message => message.includes('adopted persistent OpenCode host')),
      ).toBe(true)
      const migratedRegistry = JSON.parse(await readFile(registryPath, 'utf8')) as {
        hosts: Record<string, { processStartedAtMs?: number }>
      }
      expect(migratedRegistry.hosts['host-key']?.processStartedAtMs).toBe(1_000)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('removes a reused registry pid without disposing or signaling the unrelated process', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-registry-'))
    const registryPath = path.join(tempDir, 'host-registry.json')
    const fetchUrls: string[] = []
    const killedSignals: NodeJS.Signals[] = []

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
              managedConfigFingerprint: 'managed-config-v1',
              baseUrl: 'http://127.0.0.1:43114',
              port: 43114,
              pid: 43114,
              processStartedAtMs: 1_000,
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
        fetchJson: async url => {
          fetchUrls.push(url)
          return { status: 200, data: { ok: true } }
        },
        isProcessAlive: pid => pid === 43114,
        readProcessStartTimeMs: async () => 2_000,
        killProcess: (_pid, signal) => {
          killedSignals.push(signal)
        },
        persistentRegistryPath: registryPath,
      })

      const result = await manager.reconcilePersistentHosts({
        reason: 'shutdown',
        mode: 'force',
      })

      expect(result.cleaned).toBe(1)
      expect(result.hosts[0]).toMatchObject({
        action: 'removed_dead',
        reason: 'registered pid was reused by a different process',
      })
      expect(fetchUrls).toEqual([])
      expect(killedSignals).toEqual([])
      await expect(readFile(registryPath, 'utf8')).rejects.toThrow()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  const symlinkProjectFilterTest = process.platform === 'win32' ? test.skip : test
  symlinkProjectFilterTest(
    'matches cleanup project filters through filesystem path aliases',
    async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-project-alias-'))
      const projectPath = path.join(tempDir, 'project')
      const projectAlias = path.join(tempDir, 'project-alias')
      const registryPath = path.join(tempDir, 'host-registry.json')
      let processAlive = true

      try {
        await mkdir(projectPath)
        await symlink(projectPath, projectAlias, 'dir')
        await writeFile(
          registryPath,
          JSON.stringify({
            schemaVersion: 1,
            hosts: {
              'host-key': {
                hostKey: 'host-key',
                profileRootKey: 'profile-root',
                projectPath,
                projectBehaviorFingerprint: 'behavior-v1',
                managedConfigFingerprint: 'managed-config-v1',
                baseUrl: 'http://127.0.0.1:43141',
                port: 43141,
                pid: 43141,
                processStartedAtMs: 1_000,
                version: '1.4.0',
                resolvedConfigFingerprint: 'resolved-v1',
                updatedAt: '2026-04-24T09:00:00.000Z',
                leases: {},
              },
            },
          }),
          'utf8',
        )

        const manager = new OpenCodeHostManager({
          fetchJson: async () => ({ status: 200, data: { ok: true } }),
          isProcessAlive: pid => pid === 43141 && processAlive,
          readProcessStartTimeMs: async () => 1_000,
          killProcess: () => {
            processAlive = false
          },
          sleepMs: async () => {},
          persistentRegistryPath: registryPath,
        })

        const result = await manager.reconcilePersistentHosts({
          mode: 'force',
          projectPath: projectAlias,
        })

        expect(result.cleaned).toBe(1)
        expect(result.hosts[0]?.action).toBe('disposed')
        await expect(readFile(registryPath, 'utf8')).rejects.toThrow()
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    },
  )

  test('refuses adoption when a registered pid is reused during the health probe', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-registry-'))
    const registryPath = path.join(tempDir, 'host-registry.json')
    const fetchUrls: string[] = []
    let startTimeReadCount = 0

    try {
      await writeFile(
        registryPath,
        JSON.stringify({
          schemaVersion: 1,
          hosts: {
            'host-key': {
              hostKey: 'host-key',
              profileRootKey: baseProfile.profileRootKey,
              projectPath: baseProfile.projectPath,
              projectBehaviorFingerprint: baseProfile.projectBehaviorFingerprint,
              managedConfigFingerprint: baseProfile.managedConfigFingerprint,
              baseUrl: 'http://127.0.0.1:43114',
              port: 43114,
              pid: 43114,
              processStartedAtMs: 1_000,
              version: '1.4.0',
              resolvedConfigFingerprint: 'resolved-v1',
              updatedAt: '2026-04-24T09:00:00.000Z',
              leases: {},
            },
          },
        }),
        'utf8',
      )
      const manager = new OpenCodeHostManager({
        prepareProfile: async () => baseProfile,
        fetchJson: async url => {
          fetchUrls.push(url)
          return { status: 200, data: { healthy: true, version: '1.4.0' } }
        },
        isProcessAlive: pid => pid === 43114,
        readProcessStartTimeMs: async () => {
          startTimeReadCount += 1
          return startTimeReadCount === 1 ? 1_000 : 2_000
        },
        spawnHostProcess: () => {
          throw new Error('fresh host requested after pid reuse')
        },
        persistentRegistryPath: registryPath,
      })

      await expect(manager.ensureHost({ hostKey: 'host-key' })).rejects.toThrow(
        'fresh host requested after pid reuse',
      )
      expect(fetchUrls).toEqual(['http://127.0.0.1:43114/global/health'])
      await expect(readFile(registryPath, 'utf8')).rejects.toThrow()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('keeps a legacy pid-only record when process identity cannot be proven', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-registry-'))
    const registryPath = path.join(tempDir, 'host-registry.json')
    const killedSignals: NodeJS.Signals[] = []
    const fetchUrls: string[] = []

    try {
      await writeFile(
        registryPath,
        JSON.stringify({
          schemaVersion: 1,
          hosts: {
            'legacy-host': {
              hostKey: 'legacy-host',
              profileRootKey: 'profile-root',
              projectPath: '/tmp/project',
              projectBehaviorFingerprint: 'behavior-v1',
              baseUrl: 'http://127.0.0.1:43119',
              port: 43119,
              pid: 43119,
              version: '1.3.0',
              resolvedConfigFingerprint: null,
              updatedAt: '2026-04-24T12:00:00.000Z',
              leases: {},
            },
          },
        }),
        'utf8',
      )
      const manager = new OpenCodeHostManager({
        fetchJson: async url => {
          fetchUrls.push(url)
          return { status: 200, data: { ok: true } }
        },
        isProcessAlive: pid => pid === 43119,
        readProcessStartTimeMs: async () => Date.parse('2026-04-24T11:00:00.000Z'),
        killProcess: (_pid, signal) => {
          killedSignals.push(signal)
        },
        persistentRegistryPath: registryPath,
      })

      const result = await manager.reconcilePersistentHosts({
        reason: 'shutdown',
        mode: 'force',
      })

      expect(result.cleaned).toBe(0)
      expect(result.remaining).toBe(1)
      expect(result.hosts[0]).toMatchObject({
        action: 'failed',
        reason: expect.stringContaining('identity could not be verified'),
      })
      expect(fetchUrls).toEqual(['http://127.0.0.1:43119/global/health'])
      expect(killedSignals).toEqual([])
      const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
        hosts: Record<string, unknown>
      }
      expect(Object.keys(registry.hosts)).toEqual(['legacy-host'])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('keeps an unhealthy adopted host registered when forced termination fails', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-registry-'))
    const registryPath = path.join(tempDir, 'host-registry.json')
    const killedSignals: NodeJS.Signals[] = []

    try {
      await writeFile(
        registryPath,
        JSON.stringify({
          schemaVersion: 1,
          hosts: {
            'host-key': {
              hostKey: 'host-key',
              profileRootKey: baseProfile.profileRootKey,
              projectPath: baseProfile.projectPath,
              projectBehaviorFingerprint: baseProfile.projectBehaviorFingerprint,
              managedConfigFingerprint: baseProfile.managedConfigFingerprint,
              baseUrl: 'http://127.0.0.1:43115',
              port: 43115,
              pid: 43115,
              processStartedAtMs: 1_000,
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
        prepareProfile: async () => baseProfile,
        fetchJson: async url => ({
          status: url.endsWith('/global/health') ? 503 : 200,
          data: url.endsWith('/global/health') ? { healthy: false } : { ok: true },
        }),
        spawnHostProcess: () => {
          throw new Error('must not start a replacement while the registered host is alive')
        },
        isProcessAlive: pid => pid === 43115,
        readProcessStartTimeMs: async () => 1_000,
        killProcess: (_pid, signal) => {
          killedSignals.push(signal)
        },
        sleepMs: async () => {},
        persistentRegistryPath: registryPath,
      })

      await expect(manager.ensureHost({ hostKey: 'host-key' })).rejects.toThrow(
        'pid 43115 remained alive after forced cleanup',
      )
      expect(killedSignals).toEqual(['SIGTERM', 'SIGKILL'])
      const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
        hosts: Record<string, unknown>
      }
      expect(Object.keys(registry.hosts)).toEqual(['host-key'])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('serializes persistent host startup across managers so late callers adopt the first host', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-registry-'))
    const registryPath = path.join(tempDir, 'host-registry.json')
    const spawned = createMockChildProcess(43131)
    const healthProbeStarted = createDeferred()
    const allowHealthProbe = createDeferred()
    let spawnCount = 0

    const fetchJson = (waitForHealth: boolean) => async (url: string) => {
      if (url.endsWith('/global/health')) {
        if (waitForHealth) {
          healthProbeStarted.resolve()
          await allowHealthProbe.promise
        }
        return {
          status: 200,
          data: { healthy: true, version: '1.4.0' },
        }
      }
      if (url.endsWith('/config')) {
        return {
          status: 200,
          data: { server: { port: 43131 }, default_agent: 'teammate' },
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
        allocateLoopbackPort: async () => 43131,
        spawnHostProcess: () => {
          spawnCount += 1
          return spawned.child
        },
        fetchJson: fetchJson(true),
        isProcessAlive: pid => pid === spawned.child.pid,
        sleepMs: async () => {},
        persistentRegistryPath: registryPath,
      })
      const secondManager = new OpenCodeHostManager({
        prepareProfile: async () => baseProfile,
        allocateLoopbackPort: async () => 43132,
        spawnHostProcess: () => {
          throw new Error('second manager should adopt the first persistent host')
        },
        fetchJson: fetchJson(false),
        isProcessAlive: pid => pid === spawned.child.pid,
        sleepMs: async () => {},
        persistentRegistryPath: registryPath,
      })

      const firstPromise = firstManager.ensureHost({ hostKey: 'host-key' })
      await healthProbeStarted.promise
      const secondPromise = secondManager.ensureHost({ hostKey: 'host-key' })
      await new Promise(resolve => setTimeout(resolve, 10))
      allowHealthProbe.resolve()

      const [first, second] = await Promise.all([firstPromise, secondPromise])

      expect(spawnCount).toBe(1)
      expect(second.pid).toBe(first.pid)
      expect(second.baseUrl).toBe(first.baseUrl)
      expect(
        second.diagnostics.some(message => message.includes('adopted persistent OpenCode host')),
      ).toBe(true)
    } finally {
      allowHealthProbe.resolve()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('cancels a persistent host startup lock wait without leaving background retries', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-registry-'))
    const registryPath = path.join(tempDir, 'host-registry.json')
    const spawned = createMockChildProcess(43134)
    const healthProbeStarted = createDeferred()
    const allowHealthProbe = createDeferred()

    const fetchJson = (waitForHealth: boolean) => async (url: string) => {
      if (url.endsWith('/global/health')) {
        if (waitForHealth) {
          healthProbeStarted.resolve()
          await allowHealthProbe.promise
        }
        return { status: 200, data: { healthy: true, version: '1.4.0' } }
      }
      if (url.endsWith('/config')) {
        return { status: 200, data: { server: { port: 43134 }, default_agent: 'teammate' } }
      }
      if (url.endsWith('/config/providers')) {
        return { status: 200, data: { providers: [], default: {} } }
      }
      if (url.endsWith('/agent')) {
        return { status: 200, data: [{ name: 'teammate', mode: 'primary' }] }
      }
      if (url.endsWith('/mcp')) {
        return { status: 200, data: {} }
      }
      return { status: 200, data: { ok: true } }
    }

    const firstManager = new OpenCodeHostManager({
      prepareProfile: async () => baseProfile,
      allocateLoopbackPort: async () => 43134,
      spawnHostProcess: () => spawned.child,
      fetchJson: fetchJson(true),
      isProcessAlive: pid => pid === spawned.child.pid,
      sleepMs: async () => {},
      persistentRegistryPath: registryPath,
    })
    const waitingManager = new OpenCodeHostManager({
      prepareProfile: async () => baseProfile,
      allocateLoopbackPort: async () => 43135,
      spawnHostProcess: () => {
        throw new Error('aborted manager must not spawn a host')
      },
      fetchJson: fetchJson(false),
      isProcessAlive: pid => pid === spawned.child.pid,
      sleepMs: async () => {},
      persistentRegistryPath: registryPath,
    })

    try {
      const firstPromise = firstManager.ensureHost({ hostKey: 'host-key' })
      await healthProbeStarted.promise
      const controller = new AbortController()
      const waitingPromise = waitingManager.ensureHost({
        hostKey: 'host-key',
        abortSignal: controller.signal,
      })
      await new Promise(resolve => setTimeout(resolve, 10))
      controller.abort(new Error('host startup deadline expired'))

      await expect(Promise.race([
        waitingPromise,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('startup lock wait did not cancel')), 500)
        }),
      ])).rejects.toThrow('host startup deadline expired')

      allowHealthProbe.resolve()
      const first = await firstPromise
      await new Promise(resolve => setTimeout(resolve, 250))

      const adoptingManager = new OpenCodeHostManager({
        prepareProfile: async () => baseProfile,
        allocateLoopbackPort: async () => 43136,
        spawnHostProcess: () => {
          throw new Error('late lock acquisition was not released')
        },
        fetchJson: fetchJson(false),
        isProcessAlive: pid => pid === spawned.child.pid,
        sleepMs: async () => {},
        persistentRegistryPath: registryPath,
      })
      const adopted = await adoptingManager.ensureHost({ hostKey: 'host-key' })
      expect(adopted.pid).toBe(first.pid)
    } finally {
      allowHealthProbe.resolve()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('releases persistent host startup lock when host creation fails', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-registry-'))
    const registryPath = path.join(tempDir, 'host-registry.json')
    const spawned = createMockChildProcess(43133)
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
          data: { server: { port: 43133 }, default_agent: 'teammate' },
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
      const failingManager = new OpenCodeHostManager({
        prepareProfile: async () => baseProfile,
        allocateLoopbackPort: async () => 43133,
        spawnHostProcess: () => {
          throw new Error('spawn failed')
        },
        fetchJson,
        sleepMs: async () => {},
        persistentRegistryPath: registryPath,
      })
      await expect(failingManager.ensureHost({ hostKey: 'host-key' })).rejects.toThrow(
        'spawn failed',
      )

      const succeedingManager = new OpenCodeHostManager({
        prepareProfile: async () => baseProfile,
        allocateLoopbackPort: async () => 43133,
        spawnHostProcess: () => {
          spawnCount += 1
          return spawned.child
        },
        fetchJson,
        sleepMs: async () => {},
        persistentRegistryPath: registryPath,
      })
      const host = await succeedingManager.ensureHost({ hostKey: 'host-key' })

      expect(spawnCount).toBe(1)
      expect(host.pid).toBe(spawned.child.pid)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('force-kills a spawned host when startup verification fails', async () => {
    const spawned = createMockChildProcess(43134)
    const killedSignals: Array<{ pid: number; signal: NodeJS.Signals }> = []
    let nowMs = 0
    let healthCalls = 0

    const manager = new OpenCodeHostManager({
      prepareProfile: async () => baseProfile,
      allocateLoopbackPort: async () => 43134,
      spawnHostProcess: () => spawned.child,
      fetchJson: async url => {
        if (url.endsWith('/global/health')) {
          if (healthCalls === 0) {
            ;(spawned.child.stdout as PassThrough).write('server booting\n')
            ;(spawned.child.stderr as PassThrough).write('waiting for config\n')
          }
          healthCalls += 1
          return {
            status: 503,
            data: { healthy: false },
          }
        }
        return {
          status: 200,
          data: {},
        }
      },
      isProcessAlive: pid => pid === spawned.child.pid,
      killProcess: (pid, signal) => {
        killedSignals.push({ pid, signal })
      },
      now: () => new Date(Date.parse('2026-04-24T10:00:00.000Z') + nowMs),
      sleepMs: async () => {
        nowMs += 16_000
      },
      persistentRegistryPath: null,
    })

    let thrown: unknown = null
    await manager.ensureHost({ hostKey: 'host-key' }).catch(error => {
      thrown = error
    })

    const message = thrown instanceof Error ? thrown.message : String(thrown)
    expect(message).toContain('OpenCode host did not become healthy')
    expect(message).toContain('stdout: server booting')
    expect(message).toContain('stderr: waiting for config')

    expect(manager.getHost('host-key')).toBeNull()
    expect(killedSignals).toEqual([
      { pid: 43134, signal: 'SIGTERM' },
      { pid: 43134, signal: 'SIGKILL' },
    ])
  })

  test('uses a caller-provided host health timeout during startup verification', async () => {
    const spawned = createMockChildProcess(43136)
    const killedSignals: Array<{ pid: number; signal: NodeJS.Signals }> = []
    let nowMs = 0

    const manager = new OpenCodeHostManager({
      prepareProfile: async () => baseProfile,
      allocateLoopbackPort: async () => 43136,
      spawnHostProcess: () => spawned.child,
      fetchJson: async url => {
        if (url.endsWith('/global/health')) {
          return {
            status: 503,
            data: { healthy: false },
          }
        }
        return {
          status: 200,
          data: {},
        }
      },
      isProcessAlive: pid => pid === spawned.child.pid,
      killProcess: (pid, signal) => {
        killedSignals.push({ pid, signal })
      },
      now: () => new Date(Date.parse('2026-04-24T10:00:00.000Z') + nowMs),
      sleepMs: async ms => {
        nowMs += ms
      },
      persistentRegistryPath: null,
    })

    await expect(
      manager.ensureHost({ hostKey: 'host-key', healthTimeoutMs: 5_000 }),
    ).rejects.toThrow('OpenCode host did not become healthy within 5000ms')

    expect(manager.getHost('host-key')).toBeNull()
    expect(killedSignals).toEqual([
      { pid: 43136, signal: 'SIGTERM' },
      { pid: 43136, signal: 'SIGKILL' },
    ])
  })

  test('lets a later pending caller extend a short host health timeout', async () => {
    const spawned = createMockChildProcess(43137)
    const firstSleepStarted = createDeferred()
    const allowSleep = createDeferred()
    let nowMs = 0
    let sleepCalls = 0

    const manager = new OpenCodeHostManager({
      prepareProfile: async () => baseProfile,
      allocateLoopbackPort: async () => 43137,
      spawnHostProcess: () => spawned.child,
      fetchJson: async url => {
        if (url.endsWith('/global/health')) {
          return {
            status: nowMs >= 5_250 ? 200 : 503,
            data: nowMs >= 5_250 ? { healthy: true, version: '1.4.0' } : { healthy: false },
          }
        }
        if (url.endsWith('/config')) {
          return {
            status: 200,
            data: { server: { port: 43137 }, default_agent: 'teammate' },
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
        throw new Error(`Unexpected URL ${url}`)
      },
      now: () => new Date(Date.parse('2026-04-24T10:00:00.000Z') + nowMs),
      sleepMs: async ms => {
        sleepCalls += 1
        if (sleepCalls === 1) {
          firstSleepStarted.resolve()
          await allowSleep.promise
        }
        nowMs += ms
      },
      persistentRegistryPath: null,
    })

    const first = manager.ensureHost({
      hostKey: 'host-key',
      healthTimeoutMs: 5_000,
    })
    await firstSleepStarted.promise
    const second = manager.ensureHost({ hostKey: 'host-key' })
    allowSleep.resolve()

    const [firstHandle, secondHandle] = await Promise.all([first, second])

    expect(firstHandle).toBe(secondHandle)
    expect(firstHandle.state).toBe('healthy')
    expect(nowMs).toBeGreaterThan(5_000)
  })

  test('force-kills a healthy spawned host when persistent registry write fails', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-registry-'))
    const registryPath = path.join(tempDir, 'host-registry.json')
    await mkdir(registryPath)
    const spawned = createMockChildProcess(43135)
    const killedSignals: Array<{ pid: number; signal: NodeJS.Signals }> = []

    const manager = new OpenCodeHostManager({
      prepareProfile: async () => baseProfile,
      allocateLoopbackPort: async () => 43135,
      spawnHostProcess: () => spawned.child,
      fetchJson: async url => {
        if (url.endsWith('/global/health')) {
          return {
            status: 200,
            data: { healthy: true, version: '1.4.0' },
          }
        }
        if (url.endsWith('/config')) {
          return {
            status: 200,
            data: { server: { port: 43135 }, default_agent: 'teammate' },
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
      isProcessAlive: pid => pid === spawned.child.pid,
      killProcess: (pid, signal) => {
        killedSignals.push({ pid, signal })
      },
      sleepMs: async () => {},
      persistentRegistryPath: registryPath,
    })

    try {
      await expect(manager.ensureHost({ hostKey: 'host-key' })).rejects.toThrow()

      expect(manager.getHost('host-key')).toBeNull()
      expect(killedSignals).toEqual([
        { pid: 43135, signal: 'SIGTERM' },
        { pid: 43135, signal: 'SIGKILL' },
      ])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('disposes owned hosts that have not reached the persistent registry', async () => {
    const spawned = createMockChildProcess(43136)
    const killedSignals: Array<{ pid: number; signal: NodeJS.Signals }> = []
    let processAlive = true

    const manager = new OpenCodeHostManager({
      prepareProfile: async () => baseProfile,
      allocateLoopbackPort: async () => 43136,
      spawnHostProcess: () => spawned.child,
      fetchJson: async url => {
        if (url.endsWith('/global/health')) {
          return {
            status: 200,
            data: { healthy: true, version: '1.4.0' },
          }
        }
        if (url.endsWith('/config')) {
          return {
            status: 200,
            data: { server: { port: 43136 }, default_agent: 'teammate' },
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
        if (url.endsWith('/global/dispose')) {
          return {
            status: 200,
            data: { ok: true },
          }
        }
        return {
          status: 200,
          data: { ok: true },
        }
      },
      isProcessAlive: pid => pid === spawned.child.pid && processAlive,
      killProcess: (pid, signal) => {
        killedSignals.push({ pid, signal })
        if (signal === 'SIGKILL') processAlive = false
      },
      sleepMs: async () => {},
      persistentRegistryPath: null,
    })

    await manager.ensureHost({ hostKey: 'host-key' })
    const result = await manager.disposeUnregisteredOwnedHosts()

    expect(result).toEqual({ disposed: 1, kept: 0, diagnostics: [] })
    expect(manager.getHost('host-key')).toBeNull()
    expect(killedSignals).toEqual([
      { pid: 43136, signal: 'SIGTERM' },
      { pid: 43136, signal: 'SIGKILL' },
    ])
  })

  test('keeps owned hosts that are already registered persistently during signal cleanup', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-registry-'))
    const registryPath = path.join(tempDir, 'host-registry.json')
    const spawned = createMockChildProcess(43137)
    const killedSignals: Array<{ pid: number; signal: NodeJS.Signals }> = []

    const manager = new OpenCodeHostManager({
      prepareProfile: async () => baseProfile,
      allocateLoopbackPort: async () => 43137,
      spawnHostProcess: () => spawned.child,
      fetchJson: async url => {
        if (url.endsWith('/global/health')) {
          return {
            status: 200,
            data: { healthy: true, version: '1.4.0' },
          }
        }
        if (url.endsWith('/config')) {
          return {
            status: 200,
            data: { server: { port: 43137 }, default_agent: 'teammate' },
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
      isProcessAlive: pid => pid === spawned.child.pid,
      killProcess: (pid, signal) => {
        killedSignals.push({ pid, signal })
      },
      sleepMs: async () => {},
      persistentRegistryPath: registryPath,
    })

    try {
      await manager.ensureHost({ hostKey: 'host-key' })
      const result = await manager.disposeUnregisteredOwnedHosts()

      expect(result).toEqual({ disposed: 0, kept: 1, diagnostics: [] })
      expect(manager.getHost('host-key')?.pid).toBe(43137)
      expect(killedSignals).toEqual([])
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
        fetchJson: async url => {
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
      const createManager = () =>
        new OpenCodeHostManager({
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

  test('startup cleanup removes temp dylibs left by a dead registered host', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-registry-'))
    const registryPath = path.join(tempDir, 'host-registry.json')
    const profileTmpPath = path.join(tempDir, 'profiles', 'profile-root', 'tmp')
    const dylibPath = path.join(profileTmpPath, '.b9dd7ef5eafe1fea-00000000.dylib')
    const keepPath = path.join(profileTmpPath, 'keep.txt')

    try {
      await mkdir(profileTmpPath, { recursive: true })
      await writeFile(dylibPath, 'temp dylib', 'utf8')
      await writeFile(keepPath, 'keep', 'utf8')
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
              updatedAt: '2026-04-24T09:00:00.000Z',
              leases: {},
            },
          },
        }),
        'utf8',
      )
      const manager = new OpenCodeHostManager({
        isProcessAlive: () => false,
        persistentRegistryPath: registryPath,
      })

      const result = await manager.reconcilePersistentHosts({ reason: 'startup' })

      expect(result.hosts[0]?.action).toBe('removed_dead')
      expect(await pathExists(dylibPath)).toBe(false)
      expect(await pathExists(keepPath)).toBe(true)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('startup cleanup removes old temp dylibs from unregistered managed profiles', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-registry-'))
    const registryPath = path.join(tempDir, 'host-registry.json')
    const tmpPath = path.join(tempDir, 'profiles', 'orphaned-profile', 'tmp')
    const staleDylibPath = path.join(tmpPath, '.bbc7fffde8b6fead-00000000.dylib')
    const recentDylibPath = path.join(tmpPath, '.b9dd7ef5eafe1fea-00000000.dylib')
    const keepPath = path.join(tmpPath, 'keep.txt')

    try {
      await mkdir(tmpPath, { recursive: true })
      await writeFile(staleDylibPath, 'old temp dylib', 'utf8')
      await writeFile(recentDylibPath, 'recent temp dylib', 'utf8')
      await writeFile(keepPath, 'keep', 'utf8')
      await utimes(
        staleDylibPath,
        new Date('2026-04-20T10:00:00.000Z'),
        new Date('2026-04-20T10:00:00.000Z'),
      )
      const manager = new OpenCodeHostManager({
        now: () => new Date('2026-04-24T10:00:00.000Z'),
        persistentRegistryPath: registryPath,
      })

      const result = await manager.reconcilePersistentHosts({ reason: 'startup' })

      expect(await pathExists(staleDylibPath)).toBe(false)
      expect(await pathExists(recentDylibPath)).toBe(true)
      expect(await pathExists(keepPath)).toBe(true)
      expect(result.diagnostics).toContain(
        'Removed 1 stale OpenCode profile temp dylib(s) (14 bytes)',
      )
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('startup cleanup disposes stale registry hosts without active leases', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-registry-'))
    const registryPath = path.join(tempDir, 'host-registry.json')
    const killedSignals: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const disposeUrls: string[] = []
    let processAlive = true

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
        fetchJson: async url => {
          disposeUrls.push(url)
          return { status: 200, data: { ok: true } }
        },
        isProcessAlive: pid => pid === 43116 && processAlive,
        killProcess: (pid, signal) => {
          killedSignals.push({ pid, signal })
          processAlive = false
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
      const alivePids = new Set([43120, 43121])
      const manager = new OpenCodeHostManager({
        fetchJson: async url => {
          disposedUrls.push(url)
          return { status: 200, data: { ok: true } }
        },
        isProcessAlive: pid => alivePids.has(pid),
        killProcess: (pid, signal) => {
          killedSignals.push({ pid, signal })
          alivePids.delete(pid)
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
    let processAlive = true

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
        isProcessAlive: pid => pid === 43118 && processAlive,
        killProcess: (pid, signal) => {
          killedSignals.push({ pid, signal })
          if (signal === 'SIGKILL') processAlive = false
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

  test('keeps a persistent host registered when forced termination fails', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-registry-'))
    const registryPath = path.join(tempDir, 'host-registry.json')
    const killedSignals: NodeJS.Signals[] = []

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
              leases: {},
            },
          },
        }),
        'utf8',
      )
      const manager = new OpenCodeHostManager({
        fetchJson: async () => ({ status: 200, data: { ok: true } }),
        isProcessAlive: pid => pid === 43118,
        killProcess: (_pid, signal) => {
          killedSignals.push(signal)
        },
        now: () => new Date('2026-04-24T10:00:00.000Z'),
        sleepMs: async () => {},
        persistentRegistryPath: registryPath,
      })

      const result = await manager.reconcilePersistentHosts({
        reason: 'shutdown',
        mode: 'force',
      })

      expect(result.cleaned).toBe(0)
      expect(result.remaining).toBe(1)
      expect(result.hosts[0]?.action).toBe('failed')
      expect(result.hosts[0]?.reason).toContain('pid 43118 remained alive')
      expect(result.diagnostics[0]).toContain('Failed to dispose OpenCode host host-key')
      expect(killedSignals).toEqual(['SIGTERM', 'SIGKILL'])
      const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
        hosts: Record<string, unknown>
      }
      expect(Object.keys(registry.hosts)).toEqual(['host-key'])
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
      fetchJson: async url => {
        if (url.endsWith('/global/health')) {
          return {
            status: 200,
            data: { healthy: true, version: '1.4.0' },
          }
        }
        if (url.endsWith('/config')) {
          return {
            status: 200,
            data:
              phase === 'initial'
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
                        environment: {
                          PATH: '/opt/homebrew/bin',
                          TMPDIR: '/tmp/b',
                        },
                      },
                    },
                  },
          }
        }
        if (url.endsWith('/config/providers')) {
          return {
            status: 200,
            data:
              phase === 'initial'
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
            data:
              phase === 'initial'
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
            data:
              phase === 'initial'
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

  test('makes live config unavailable when any refresh component fails', async () => {
    const spawned = createMockChildProcess()
    let phase: 'initial' | 'refresh' = 'initial'

    const manager = new OpenCodeHostManager({
      prepareProfile: async () => baseProfile,
      allocateLoopbackPort: async () => 43127,
      spawnHostProcess: () => spawned.child,
      fetchJson: async url => {
        if (url.endsWith('/global/health')) {
          return {
            status: 200,
            data: { healthy: true, version: '1.4.0' },
          }
        }
        if (phase === 'refresh' && url.endsWith('/config')) {
          return { status: 503, data: { error: 'unavailable' } }
        }
        if (url.endsWith('/config')) {
          return {
            status: 200,
            data: { default_agent: 'teammate' },
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
            data: {
              'agent-teams': {
                connected: true,
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
    expect(refreshedFingerprint).toBeNull()
    expect(manager.getHost('host-key')?.resolvedConfigFingerprint).toBeNull()
  })
})
