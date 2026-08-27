import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterAll, describe, expect, test } from 'bun:test'

import {
  OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID,
  OpenCodeHostManager,
  buildOpenCodeScopedHostIdentity,
  bindVerifiedScopedBinaryHandle,
  deriveOpenCodeScopedHostKey,
  buildOpenCodeHostSpawnOptions,
  buildOpenCodeVerifiedScopedHostCommand,
  resolveOpenCodeBinaryHostIdentity,
  shouldUnrefOpenCodeHostProcess,
  stageScopedHostBinary,
} from './OpenCodeHostManager.js'
import {
  canonicalSerializeOpenCodePolicyIdentity,
  deriveOpenCodeScopedHostKeyFromPlanDigest,
  resolveOpenCodeOperationPolicy,
} from './OpenCodeOperationPolicy.js'
import {
  buildManagedConfigFingerprint,
  fingerprintOpenCodeScopedExecutionEnvironment,
  fingerprintOpenCodeScopedInheritedEnvironment,
} from './OpenCodeProfileManager.js'

import type { OpenCodePreparedProfile, OpenCodeScopedPreparedProfile } from './types.js'

const baseProfile: OpenCodePreparedProfile = {
  projectPath: '/tmp/project',
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

const scopedFixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'opencode-scoped-fixture-'))
const scopedFixtureProfileRoot = path.join(scopedFixtureRoot, 'profile')
const scopedFixtureBinaryPath = path.join(scopedFixtureRoot, 'opencode')
const scopedFixtureBinaryBytes = Buffer.from('#!/bin/sh\nexit 0\n')
const scopedFixtureBinaryFingerprint = createHash('sha256')
  .update(scopedFixtureBinaryBytes)
  .digest('hex')
mkdirSync(scopedFixtureProfileRoot)
writeFileSync(scopedFixtureBinaryPath, scopedFixtureBinaryBytes, { mode: 0o700 })

afterAll(async () => {
  await rm(scopedFixtureRoot, { recursive: true, force: true })
})

function scopedProfile(
  purpose: 'provider-catalog' | 'provider-connect' | 'execution-probe' | 'launch' | 'session-resume' | 'legacy-diagnostic',
  overrides: Partial<OpenCodeScopedPreparedProfile> = {},
): OpenCodeScopedPreparedProfile {
  const authFingerprint = createHash('sha256').update('{}').digest('hex')
  const providerId = purpose === 'legacy-diagnostic' ? null : 'kiro'
  const profileRootPath = overrides.profileRootPath ?? scopedFixtureProfileRoot
  const homePath = overrides.homePath ?? path.join(profileRootPath, 'home')
  const tmpPath = overrides.tmpPath ?? path.join(profileRootPath, 'tmp')
  const xdgConfigHome = overrides.xdgConfigHome ?? path.join(profileRootPath, 'config')
  const xdgDataHome = overrides.xdgDataHome ?? path.join(profileRootPath, 'data')
  const xdgCacheHome = overrides.xdgCacheHome ?? path.join(profileRootPath, 'cache')
  const managedConfig = overrides.managedConfig ?? baseProfile.managedConfig
  const binaryPath = overrides.binaryPath ?? scopedFixtureBinaryPath
  const binaryFingerprint = overrides.binaryFingerprint ?? scopedFixtureBinaryFingerprint
  const managedAuthPath = path.join(xdgDataHome, 'opencode', 'auth.json')
  mkdirSync(path.dirname(managedAuthPath), { recursive: true })
  if (!existsSync(managedAuthPath)) writeFileSync(managedAuthPath, '{}', { mode: 0o400 })
  const inheritedEnv = { PATH: process.env.PATH ?? '/bin', ...(overrides.env ?? {}) }
  const nativeCredentialBridge = overrides.nativeCredentialBridge ?? (providerId === 'kiro'
    ? {
        providerId: 'kiro' as const,
        binPath: path.join(profileRootPath, 'native-subscription-cli-bin'),
        executablePath: path.join(profileRootPath, 'native-subscription-cli-bin', process.platform === 'win32' ? 'kiro-cli.cmd' : 'kiro-cli'),
      }
    : null)
  if (nativeCredentialBridge) {
    mkdirSync(nativeCredentialBridge.binPath, { recursive: true })
    if (!existsSync(nativeCredentialBridge.executablePath)) {
      writeFileSync(nativeCredentialBridge.executablePath, '#!/bin/sh\nexit 0\n', { mode: 0o500 })
    }
  }
  const projectBehaviorSnapshotPath = path.join(profileRootPath, 'project-behavior')
  mkdirSync(projectBehaviorSnapshotPath, { recursive: true })
  chmodSync(projectBehaviorSnapshotPath, 0o500)
  const profileCore = {
    ...baseProfile,
    managedAuthFingerprint: authFingerprint,
    ...overrides,
    profileRootPath,
    homePath,
    tmpPath,
    xdgConfigHome,
    xdgDataHome,
    xdgCacheHome,
    managedConfig,
    managedAuthPath,
    binaryPath,
    binaryFingerprint,
    pluginNodeModulesPath: path.join(xdgConfigHome, 'opencode', 'node_modules'),
    profileLayoutGeneration: '1',
    nativeCredentialBridge,
    env: {
      ...inheritedEnv,
      ...(nativeCredentialBridge
        ? { PATH: `${nativeCredentialBridge.binPath}${path.delimiter}${inheritedEnv.PATH ?? ''}` }
        : {}),
      HOME: homePath,
      USERPROFILE: homePath,
      TMPDIR: tmpPath,
      TMP: tmpPath,
      TEMP: tmpPath,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: xdgDataHome,
      XDG_CACHE_HOME: xdgCacheHome,
      NPM_CONFIG_CACHE: path.join(profileRootPath, 'npm-cache'),
      CLAUDE_MULTIMODEL_DATA_HOME: path.join(profileRootPath, 'app-data'),
      CLAUDE_MULTIMODEL_CACHE_HOME: path.join(profileRootPath, 'app-cache'),
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify(managedConfig),
      OPENCODE_CONFIG_DIR: projectBehaviorSnapshotPath,
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    },
  }
  const fingerprint = (value: unknown) => createHash('sha256')
    .update(canonicalSerializeOpenCodePolicyIdentity(value))
    .digest('hex')
  const nativeCredentialBridgeInputFingerprint = fingerprint(nativeCredentialBridge
    ? { providerId: nativeCredentialBridge.providerId }
    : null)
  const nativeCredentialBridgeFingerprint = fingerprint(nativeCredentialBridge
    ? [{
        name: path.basename(nativeCredentialBridge.executablePath),
        digest: createHash('sha256').update(readFileSync(nativeCredentialBridge.executablePath)).digest('hex'),
      }]
    : null)
  const providerEnvironmentFingerprint = fingerprint({
    inherited: fingerprintOpenCodeScopedInheritedEnvironment(inheritedEnv),
    nativeBridgeInputs: nativeCredentialBridgeInputFingerprint,
    finalEnvironmentInputs: {
      npmConfigCache: profileCore.env.NPM_CONFIG_CACHE ?? null,
      multimodelDataHome: profileCore.env.CLAUDE_MULTIMODEL_DATA_HOME ?? null,
      multimodelCacheHome: profileCore.env.CLAUDE_MULTIMODEL_CACHE_HOME ?? null,
      disableAutoUpdate: profileCore.env.OPENCODE_DISABLE_AUTOUPDATE ?? null,
    },
  })
  const expectedEntryManifest = {
    projectBehaviorFingerprint: profileCore.projectBehaviorFingerprint,
    projectBehaviorSnapshotPath: 'project-behavior',
    projectBehaviorEntryManifest: [],
    userPluginDirectory: path.join(profileRootPath, 'empty-user-plugins'),
    userPluginEntries: [],
    pluginConfigs: [],
    preservedPlugins: [],
    preservedPluginsFingerprint: fingerprint([]),
    inlinePluginsFingerprint: fingerprint([]),
  }
  const scopedPlanDigest = fingerprint({
    purpose,
    providerId,
    projectPath: profileCore.projectPath,
    binaryFingerprint: profileCore.binaryFingerprint,
    environment: providerEnvironmentFingerprint,
  })
  const fingerprints = {
    project: fingerprint({
      projectPath: profileCore.projectPath,
      projectBehaviorFingerprint: profileCore.projectBehaviorFingerprint,
    }),
    model: fingerprint('kiro/model-a'),
    policy: fingerprint({ purpose, providerId }),
    plugin: 'plugin-fingerprint',
    version: 'version-fingerprint',
    config: buildManagedConfigFingerprint(profileCore.managedConfig),
    auth: authFingerprint,
    environment: providerEnvironmentFingerprint,
    binary: profileCore.binaryFingerprint,
    layout: fingerprint({ profileLayoutGeneration: '1', planDigest: scopedPlanDigest }),
  }
  const preliminaryPolicy = resolveOpenCodeOperationPolicy({
    purpose,
    providerId,
    fingerprints,
  })
  fingerprints.plugin = fingerprint({
    plugins: preliminaryPolicy.plugins,
    automaticUserPluginEntries: expectedEntryManifest.userPluginEntries,
  })
  const policy = resolveOpenCodeOperationPolicy({ purpose, providerId, fingerprints })
  const profileScopeIdentity = createHash('sha256')
    .update(JSON.stringify(policy.identity.canonicalInput))
    .digest('hex')
  const nativeTargetExecutableFingerprint = nativeCredentialBridge
    ? createHash('sha256').update('#!/bin/sh\nexit 0\n').digest('hex')
    : fingerprint(null)
  const nativeTargetExecutablePath = nativeCredentialBridge
    ? path.join(
        profileRootPath,
        'native-executables',
        nativeTargetExecutableFingerprint,
        nativeCredentialBridge.providerId === 'kiro' ? 'kiro-cli' : 'cursor-agent',
      )
    : null
  if (nativeTargetExecutablePath) {
    mkdirSync(path.dirname(nativeTargetExecutablePath), { recursive: true })
    if (!existsSync(nativeTargetExecutablePath)) {
      writeFileSync(nativeTargetExecutablePath, '#!/bin/sh\nexit 0\n', { mode: 0o500 })
    }
  }
  return {
    ...profileCore,
    managedConfigFingerprint: fingerprints.config,
    profileRootKey: profileScopeIdentity,
    preparationLockPath: path.join(
      profileRootPath,
      `prepare-${policy.identity.operationKey.split(':').at(-1)}.lock`,
    ),
    scopeSchema: 'opencode-scoped-profile-v1',
    policy,
    purpose,
    providerId,
    modelId: 'kiro/model-a',
    runtimeInstanceId: 'runtime-one',
    canonicalProjectPathFingerprint: fingerprint(profileCore.projectPath),
    executionProjectPath: path.join(profileRootPath, 'project-behavior'),
    operationKey: policy.identity.operationKey,
    profileKey: policy.identity.profileKey!,
    pluginKey: policy.identity.pluginKey!,
    cacheKey: policy.identity.cacheKey!,
    profileScopeIdentity,
    catalogAttemptPlan: null,
    scopedPlanDigest,
    plannedHostKey: deriveOpenCodeScopedHostKeyFromPlanDigest(scopedPlanDigest),
    selectedAuthBaselineFingerprint: authFingerprint,
    providerEnvironmentFingerprint,
    nativeCredentialBridgeInputFingerprint,
    nativeCredentialBridgeFingerprint,
    nativeTargetExecutableFingerprint,
    nativeTargetExecutablePath,
    nativeCredentialHostHomePath: null,
    nativeAccountEvidenceFingerprint: fingerprint(null),
    executionEnvironmentFingerprint: fingerprintOpenCodeScopedExecutionEnvironment(profileCore.env),
    expectedEntryManifest,
    expectedEntryManifestFingerprint: fingerprint(expectedEntryManifest),
    automaticUserPluginFingerprint: fingerprint(expectedEntryManifest.userPluginEntries),
  }
}

describe('OpenCodeHostManager scoped S1 contract', () => {
  test('rejects expectedHostKey mismatch before registry lookup or spawn', async () => {
    let touched = 0
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => { touched += 1; return 44100 },
      spawnHostProcess: () => { touched += 1; return createMockChildProcess().child },
      fetchJson: async () => { touched += 1; return { status: 500, data: null } },
      persistentRegistryPath: '/path/that/must/not/be/read.json',
    })
    await expect(manager.ensureScopedHost({
      preparedProfile: scopedProfile('launch'),
      expectedHostKey: 'caller-override',
    })).rejects.toThrow('expectedHostKey mismatch')
    expect(touched).toBe(0)
  })

  test('rejects a missing or blank expectedHostKey with zero side effects', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-scoped-key-'))
    const registryPath = path.join(tempDir, 'registry.json')
    let touched = 0
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => { touched += 1; return 44109 },
      spawnHostProcess: () => { touched += 1; return createMockChildProcess().child },
      fetchJson: async () => { touched += 1; return { status: 500, data: null } },
      persistentRegistryPath: registryPath,
    })
    try {
      await expect(manager.ensureScopedHost({
        preparedProfile: scopedProfile('launch'),
      } as never)).rejects.toThrow('nonblank expectedHostKey')
      await expect(manager.ensureScopedHost({
        preparedProfile: scopedProfile('launch'), expectedHostKey: '   ',
      })).rejects.toThrow('nonblank expectedHostKey')
      expect(touched).toBe(0)
      expect(await pathExists(registryPath)).toBe(false)
      expect(await pathExists(path.join(tempDir, 'profiles'))).toBe(false)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('requires exact expectedHostKey equality without whitespace normalization', async () => {
    let touched = 0
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => { touched += 1; return 44110 },
      spawnHostProcess: () => { touched += 1; return createMockChildProcess().child },
      fetchJson: async () => { touched += 1; return { status: 500, data: null } },
      persistentRegistryPath: '/path/that/must/not/be-read.json',
    })
    const profile = scopedProfile('launch')
    const exact = deriveOpenCodeScopedHostKey(profile)
    for (const expectedHostKey of [` ${exact}`, `${exact} `]) {
      await expect(manager.ensureScopedHost({ preparedProfile: profile, expectedHostKey }))
        .rejects.toThrow('expectedHostKey mismatch')
    }
    expect(touched).toBe(0)
  })

  test('rejects forged, providerless, and internally inconsistent scoped profiles before side effects', async () => {
    let touched = 0
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => { touched += 1; return 44109 },
      spawnHostProcess: () => { touched += 1; return createMockChildProcess().child },
      fetchJson: async () => { touched += 1; return { status: 500, data: null } },
      persistentRegistryPath: '/path/that/must/not/be/read.json',
    })
    const valid = scopedProfile('launch')
    const invalid = [
      { ...valid, providerId: null },
      { ...valid, purpose: 'provider-connect' as const },
      { ...valid, profileKey: `${valid.profileKey}-forged` },
      { ...valid, profileScopeIdentity: '0'.repeat(64), profileRootKey: '0'.repeat(64) },
      {
        ...valid,
        policy: {
          ...valid.policy,
          profile: { ...valid.policy.profile, hostLifetime: 'temporary' as const },
        },
      },
    ]
    for (const preparedProfile of invalid) {
      await expect(manager.ensureScopedHost({
        preparedProfile: preparedProfile as OpenCodeScopedPreparedProfile,
        expectedHostKey: deriveOpenCodeScopedHostKey(preparedProfile as OpenCodeScopedPreparedProfile),
      })).rejects.toThrow('valid policy-bearing')
    }
    expect(touched).toBe(0)
  })

  test('compatibility ensureHost rejects scoped profiles at type and runtime boundaries', async () => {
    const profile = scopedProfile('launch')
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => { throw new Error('must not allocate') },
      spawnHostProcess: () => { throw new Error('must not spawn') },
      persistentRegistryPath: null,
    })
    if (false) {
      // @ts-expect-error Scoped profiles may only enter through ensureScopedHost.
      await manager.ensureHost({ preparedProfile: profile })
    }
    const runtimeEnsureHost = (manager as unknown as {
      ensureHost: (input: unknown) => Promise<unknown>
    }).ensureHost.bind(manager)
    await expect(runtimeEnsureHost({ preparedProfile: profile }))
      .rejects.toThrow('require ensureScopedHost')
  })

  test('uses policy lifetime, never prewarms, and does not persist temporary hosts', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-scoped-host-temp-'))
    const registryPath = path.join(tempDir, 'registry.json')
    let spawnCount = 0
    let processAlive = true
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => 44101,
      spawnHostProcess: profile => {
        spawnCount += 1
        expect(profile.managedConfig.plugin).toEqual(baseProfile.managedConfig.plugin)
        return createMockChildProcess(44101).child
      },
      fetchJson: async url => {
        expect(url).not.toContain('/models')
        expect(url).not.toContain('/agent')
        if (url.endsWith('/global/health')) return { status: 200, data: { healthy: true } }
        if (url.endsWith('/global/dispose')) return { status: 200, data: {} }
        throw new Error(`unexpected scoped host request ${url}`)
      },
      isProcessAlive: () => processAlive,
      isProcessGroupAlive: () => processAlive,
      killProcess: () => { processAlive = false },
      sleepMs: async () => {},
      persistentRegistryPath: registryPath,
    })
    try {
      const profile = scopedProfile('execution-probe')
      const reference = await manager.ensureScopedHostReference({
        preparedProfile: profile,
        expectedHostKey: deriveOpenCodeScopedHostKey(profile),
      })
      const handle = reference.handle
      const sharedReference = await manager.ensureScopedHostReference({
        preparedProfile: profile,
        expectedHostKey: deriveOpenCodeScopedHostKey(profile),
      })
      expect(spawnCount).toBe(1)
      expect(await pathExists(registryPath)).toBe(false)
      const duplicate = await Promise.allSettled([
        manager.releaseHostReference(reference), manager.releaseHostReference(reference),
      ])
      expect(duplicate.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
      expect(manager.getHost(handle.hostKey)).not.toBeNull()
      await expect(manager.releaseHostReference({ handle } as never)).rejects.toThrow('invalid')
      await expect(manager.releaseHostReference(reference)).rejects.toThrow('already consumed')
      await expect(new OpenCodeHostManager({ persistentRegistryPath: null })
        .releaseHostReference(reference)).rejects.toThrow('invalid')
      await manager.releaseHostReference(sharedReference)
      expect(manager.getHost(handle.hostKey)).toBeNull()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('fails closed when TERM exits the exact leader but descendant 507 survives force cleanup', async () => {
    const profile = scopedProfile('execution-probe')
    const child = createMockChildProcess(443)
    let leaderAlive = true
    let descendant507Alive = true
    const signals: NodeJS.Signals[] = []
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => 44111,
      spawnHostProcess: () => child.child,
      fetchJson: async url => {
        if (url.endsWith('/global/health')) return { status: 200, data: { healthy: true } }
        if (url.endsWith('/global/dispose')) return { status: 200, data: {} }
        throw new Error(`unexpected scoped host request ${url}`)
      },
      isProcessAlive: pid => pid === 443 && leaderAlive,
      isProcessGroupAlive: pid => pid === 443 && (leaderAlive || descendant507Alive),
      killProcess: (_pid, signal) => {
        signals.push(signal)
        leaderAlive = false
      },
      sleepMs: async () => {},
      persistentRegistryPath: null,
    })
    const reference = await manager.ensureScopedHostReference({
      preparedProfile: profile, expectedHostKey: deriveOpenCodeScopedHostKey(profile),
    })
    await expect(manager.releaseHostReference(reference)).rejects.toThrow('did not exit')
    expect(signals).toEqual(['SIGTERM'])
    expect(descendant507Alive).toBe(true)
    await expect(manager.releaseHostReference(reference)).rejects.toThrow()
    expect(signals).toEqual(['SIGTERM'])
    expect(manager.getHost(reference.handle.hostKey)).not.toBeNull()
    expect(descendant507Alive).toBe(true)
  })

  test('never sends a post-TERM SIGKILL after the attempt aborts during observation', async () => {
    const profile = scopedProfile('execution-probe')
    const child = createMockChildProcess(444)
    const controller = new AbortController()
    let leaderAlive = true
    const signals: NodeJS.Signals[] = []
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => 44112,
      spawnHostProcess: () => child.child,
      fetchJson: async url => {
        if (url.endsWith('/global/health')) return { status: 200, data: { healthy: true } }
        if (url.endsWith('/global/dispose')) return { status: 200, data: {} }
        throw new Error(`unexpected scoped host request ${url}`)
      },
      isProcessAlive: pid => pid === 444 && leaderAlive,
      isProcessGroupAlive: pid => pid === 444,
      killProcess: (_pid, signal) => {
        signals.push(signal)
        leaderAlive = false
        if (signal === 'SIGTERM') controller.abort(new Error('hostile cancellation'))
      },
      sleepMs: async () => {},
      persistentRegistryPath: null,
    })
    const reference = await manager.ensureScopedHostReference({
      preparedProfile: profile, expectedHostKey: deriveOpenCodeScopedHostKey(profile),
    })
    await expect(manager.releaseHostReference(reference, {
      signal: controller.signal, remainingMs: () => 1_000,
    })).rejects.toThrow('hostile cancellation')
    expect(signals).toEqual(['SIGTERM'])
  })

  test('keeps a process host strongly tracked and administratively reapable after caller release timeout', async () => {
    const profile = scopedProfile('execution-probe')
    const child = createMockChildProcess(447)
    let leaderAlive = true
    const signals: NodeJS.Signals[] = []
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => 44115,
      spawnHostProcess: () => child.child,
      fetchJson: async url => url.endsWith('/global/health')
        ? { status: 200, data: { healthy: true } }
        : { status: 200, data: {} },
      isProcessAlive: pid => pid === 447 && leaderAlive,
      isProcessGroupAlive: () => false,
      readProcessStartTimeMs: async pid => pid === 447 ? 12_345 : null,
      readProcessBirthToken: pid => pid === 447
        ? 'linux:11111111-2222-3333-4444-555555555555:447' : null,
      killProcess: (_pid, signal) => { signals.push(signal); leaderAlive = false },
      sleepMs: async () => {},
      persistentRegistryPath: null,
    })
    const reference = await manager.ensureScopedHostReference({
      preparedProfile: profile, expectedHostKey: deriveOpenCodeScopedHostKey(profile),
    })
    const receipt = manager.hostReleaseReceipt(reference)

    await expect(manager.releaseHostReference(reference, { remainingMs: () => 0 }))
      .rejects.toThrow('deadline expired')
    expect(manager.getHost(reference.handle.hostKey)).not.toBeNull()
    expect(signals).toEqual([])

    await manager.reconcileHostReleaseReceipt(receipt)
    expect(signals).toEqual(['SIGTERM'])
    await expect(manager.reconcileHostReleaseReceipt(receipt)).resolves.toBeUndefined()
    expect(signals).toEqual(['SIGTERM'])
    expect(manager.getHost(reference.handle.hostKey)).toBeNull()
  })

  test.each([
    ['live descendant', true, false],
    ['unknown containment', null, false],
    ['proven empty containment', false, true],
  ] as const)('leader-gone durable receipt with %s clears only after proof', async (
    _case, groupAlive, shouldComplete,
  ) => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const manager = new OpenCodeHostManager({
      isProcessAlive: () => false,
      isProcessGroupAlive: () => groupAlive,
      killProcess: (pid, signal) => { signals.push({ pid, signal }) },
      persistentRegistryPath: null,
    })
    const receipt = {
      schemaVersion: 2 as const,
      receiptId: '11111111-1111-4111-8111-111111111111',
      hostKeyDigest: 'a'.repeat(64),
      pid: 50_701,
      processStartedAtMs: 12_345,
      processBirthToken: 'linux:11111111-2222-3333-4444-555555555555:100',
      lifetime: 'persistent' as const,
    }

    const reconciliation = manager.reconcileHostReleaseReceipt(receipt)
    if (shouldComplete) await expect(reconciliation).resolves.toBeUndefined()
    else await expect(reconciliation).rejects.toThrow('cleanup remains incomplete')
    expect(signals).toEqual([])
  })

  test('persistent cleanup retains its receipt when leader exits but descendant 507 survives', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-persistent-descendant-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const profile = scopedProfile('launch', { projectPath: tempDir })
    const child = createMockChildProcess(446)
    let leaderAlive = true
    let descendant507Alive = true
    const signals: NodeJS.Signals[] = []
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => 44114,
      spawnHostProcess: () => child.child,
      fetchJson: async url => url.endsWith('/global/health')
        ? { status: 200, data: { healthy: true } }
        : { status: 200, data: {} },
      isProcessAlive: pid => pid === 446 && leaderAlive,
      isProcessGroupAlive: pid => pid === 446 && (leaderAlive || descendant507Alive),
      killProcess: (_pid, signal) => {
        signals.push(signal)
        leaderAlive = false
      },
      sleepMs: async () => {},
      persistentRegistryPath: registryPath,
    })
    try {
      const reference = await manager.ensureScopedHostReference({
        preparedProfile: profile, expectedHostKey: deriveOpenCodeScopedHostKey(profile),
      })
      await expect(manager.releaseHostReference(reference)).rejects.toThrow('containment')
      expect(await pathExists(registryPath)).toBe(true)
      expect(signals).toEqual(['SIGTERM'])
      await expect(manager.releaseHostReference(reference)).rejects.toThrow()
      expect(signals).toEqual(['SIGTERM'])
      expect(await pathExists(registryPath)).toBe(true)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('restart receipt reconciliation preserves a persistent host with durable member leases', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-leased-receipt-restart-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const profile = scopedProfile('launch', { projectPath: tempDir })
    const child = createMockChildProcess(45_443)
    const ownerKey = Buffer.alloc(32, 7)
    const signals: NodeJS.Signals[] = []
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => 44_443,
      spawnHostProcess: () => child.child,
      fetchJson: async url => url.endsWith('/global/health')
        ? { status: 200, data: { healthy: true } }
        : { status: 200, data: {} },
      isProcessAlive: pid => pid === 45_443,
      readProcessStartTimeMs: async pid => pid === 45_443 ? 12_345 : null,
      readProcessBirthToken: pid => pid === 45_443
        ? 'linux:11111111-2222-3333-4444-555555555555:123' : null,
      persistentRegistryPath: registryPath, scopedTransportOwnerKey: ownerKey,
    })
    try {
      const reference = await manager.ensureScopedHostReference({
        preparedProfile: profile, expectedHostKey: deriveOpenCodeScopedHostKey(profile),
      })
      await manager.retainHostLease(reference.handle.hostKey, {
        teamId: 'team', laneId: 'lane', memberName: 'member', runId: 'run', sessionId: 'session',
      })
      const registry = JSON.parse(await readFile(registryPath, 'utf8'))
      const [hostKey, record] = Object.entries(registry.hosts)[0] as [string, any]
      const restarted = new OpenCodeHostManager({
        persistentRegistryPath: registryPath, scopedTransportOwnerKey: ownerKey,
        isProcessAlive: pid => pid === record.pid,
        readProcessStartTimeMs: async pid => pid === record.pid ? record.processStartedAtMs : null,
        readProcessBirthToken: pid => pid === record.pid ? record.processBirthToken : null,
        isProcessGroupAlive: () => true,
        killProcess: (_pid, signal) => { signals.push(signal) },
      })
      await restarted.reconcileHostReleaseReceipt({
        schemaVersion: 2, receiptId: '44444444-4444-4444-8444-444444444444',
        hostKeyDigest: createHash('sha256').update(hostKey).digest('hex'),
        pid: record.pid, processStartedAtMs: record.processStartedAtMs,
        processBirthToken: record.processBirthToken, lifetime: 'persistent',
      })
      expect(signals).toEqual([])
      expect(JSON.parse(await readFile(registryPath, 'utf8')).hosts[hostKey]).toBeDefined()
      await manager.releaseHostLease(reference.handle.hostKey, {
        teamId: 'team', laneId: 'lane', memberName: 'member', runId: 'run', sessionId: 'session',
      })
      let remoteEffects = 0
      const windowsRestart = new OpenCodeHostManager({
        platform: 'win32', persistentRegistryPath: registryPath, scopedTransportOwnerKey: ownerKey,
        isProcessAlive: pid => pid === record.pid,
        readProcessStartTimeMs: async pid => pid === record.pid ? record.processStartedAtMs : null,
        fetchJson: async () => { remoteEffects += 1; return { status: 200, data: {} } },
        killProcess: () => { remoteEffects += 1 },
      })
      await expect(windowsRestart.reconcileHostReleaseReceipt({
        schemaVersion: 1, receiptId: '55555555-5555-4555-8555-555555555555',
        hostKeyDigest: createHash('sha256').update(hostKey).digest('hex'),
        pid: record.pid, processStartedAtMs: record.processStartedAtMs, lifetime: 'persistent',
      })).rejects.toThrow('lacks exact native generation authority')
      expect(remoteEffects).toBe(0)
      expect(JSON.parse(await readFile(registryPath, 'utf8')).hosts[hostKey]).toBeDefined()
    } finally { await rm(tempDir, { recursive: true, force: true }) }
  })

  test('every final persistent reference release consumes only the operation reference when a durable member lease exists', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-leased-live-release-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const profile = scopedProfile('launch', { projectPath: tempDir })
    const child = createMockChildProcess(45_444)
    const signals: NodeJS.Signals[] = []
    let alive = true
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => 44_444,
      spawnHostProcess: () => child.child,
      fetchJson: async url => url.endsWith('/global/health')
        ? { status: 200, data: { healthy: true } }
        : { status: 200, data: {} },
      isProcessAlive: pid => pid === 45_444 && alive,
      isProcessGroupAlive: () => false,
      readProcessStartTimeMs: async pid => pid === 45_444 ? 12_345 : null,
      killProcess: (_pid, signal) => { signals.push(signal); alive = false },
      sleepMs: async () => {}, persistentRegistryPath: registryPath,
    })
    try {
      const first = await manager.ensureScopedHostReference({
        preparedProfile: profile, expectedHostKey: deriveOpenCodeScopedHostKey(profile),
      })
      await manager.retainHostLease(first.handle.hostKey, {
        teamId: 'committed-team', laneId: 'lane', memberName: 'durable-member',
        runId: 'committed-run', sessionId: 'committed-session',
      })
      // Simulate a later launch attempt acquiring the same persistent host
      // without reconstructing that unrelated member into its run-local set.
      const laterAttempt = await manager.ensureScopedHostReference({
        preparedProfile: profile, expectedHostKey: deriveOpenCodeScopedHostKey(profile),
      })
      await manager.releaseHostReference(first)
      // Retained receipt reconciliation is used after publication/restart;
      // the in-memory retained-capability branch must make the same locked
      // durable-lease decision as a direct publication-fallback release.
      await manager.reconcileHostReleaseReceipt(manager.hostReleaseReceipt(laterAttempt))
      const publicationFallback = await manager.ensureScopedHostReference({
        preparedProfile: profile, expectedHostKey: deriveOpenCodeScopedHostKey(profile),
      })
      await manager.releaseHostReference(publicationFallback)
      expect(signals).toEqual([])
      expect(manager.getHost(first.handle.hostKey)).not.toBeNull()
      const registry = JSON.parse(await readFile(registryPath, 'utf8'))
      expect(Object.keys(registry.hosts[first.handle.hostKey].leases)).toHaveLength(1)
    } finally { await rm(tempDir, { recursive: true, force: true }) }
  })

  test('Darwin strict persistent release fails closed without a negative group signal or probe', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-darwin-fail-closed-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const profile = scopedProfile('launch', { projectPath: tempDir })
    const child = createMockChildProcess(45_445)
    let signals = 0
    let groupProbes = 0
    const manager = new OpenCodeHostManager({ platform: 'darwin',
      allocateLoopbackPort: async () => 44_445, spawnHostProcess: () => child.child,
      fetchJson: async url => url.endsWith('/global/health')
        ? { status: 200, data: { healthy: true } } : { status: 200, data: {} },
      isProcessAlive: pid => pid === 45_445,
      readProcessStartTimeMs: async pid => pid === 45_445 ? 1_000 : null,
      killProcess: () => { signals += 1 },
      isProcessGroupAlive: () => { groupProbes += 1; return true },
      persistentRegistryPath: registryPath,
    })
    try {
      const reference = await manager.ensureScopedHostReference({
        preparedProfile: profile, expectedHostKey: deriveOpenCodeScopedHostKey(profile),
      })
      await expect(manager.releaseHostReference(reference)).rejects.toThrow('containment')
      expect(signals).toBe(0)
      expect(groupProbes).toBe(0)
      expect(await pathExists(registryPath)).toBe(true)
    } finally { await rm(tempDir, { recursive: true, force: true }) }
  })

  test.skipIf(process.platform !== 'linux')('restart receipt refuses same-second recycled Linux generation', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-native-birth-reuse-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const hostKey = 'native-birth-host'
    const oldToken = 'linux:11111111-2222-3333-4444-555555555555:100'
    const newToken = 'linux:11111111-2222-3333-4444-555555555555:101'
    let signals = 0
    try {
      await writeFile(registryPath, JSON.stringify({ schemaVersion: 2, hosts: { [hostKey]: {
        hostKey, profileRootKey: 'profile', projectPath: '/static/project',
        projectBehaviorFingerprint: 'behavior', baseUrl: 'http://127.0.0.1:44443',
        port: 44443, pid: 44443, processStartedAtMs: 1_000, processBirthToken: oldToken,
        version: null, resolvedConfigFingerprint: null,
        updatedAt: '2026-08-27T00:00:00.000Z', leases: {},
      } } }))
      const manager = new OpenCodeHostManager({ persistentRegistryPath: registryPath,
        platform: 'linux', isProcessAlive: () => true,
        readProcessStartTimeMs: async () => 1_000,
        readProcessBirthToken: () => newToken,
        killProcess: () => { signals += 1 }, isProcessGroupAlive: () => true,
        fetchJson: async () => ({ status: 200, data: {} }), sleepMs: async () => {} })
      await expect(manager.reconcileHostReleaseReceipt({ schemaVersion: 2,
        receiptId: '66666666-6666-4666-8666-666666666666',
        hostKeyDigest: createHash('sha256').update(hostKey).digest('hex'),
        pid: 44443, processStartedAtMs: 1_000, processBirthToken: oldToken,
        lifetime: 'persistent' })).rejects.toThrow('containment remained alive or unproven')
      expect(signals).toBe(0)
      expect(JSON.parse(await readFile(registryPath, 'utf8')).hosts[hostKey]).toBeDefined()
    } finally { await rm(tempDir, { recursive: true, force: true }) }
  })

  test.each(['linux', 'darwin', 'win32', 'unknown'] as const)(
    'legacy restart receipt on %s performs no process, containment, remote, registry, signal, or mutation effect',
    async platform => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-legacy-birth-reuse-'))
      const registryPath = path.join(tempDir, 'registry.json')
      const hostKey = 'legacy-native-birth-host'
      const currentToken = 'linux:11111111-2222-3333-4444-555555555555:101'
      let livenessChecks = 0
      let startTimeChecks = 0
      let birthChecks = 0
      let containmentProbes = 0
      let remoteRequests = 0
      let signals = 0
      try {
        await writeFile(registryPath, JSON.stringify({ schemaVersion: 2, hosts: { [hostKey]: {
          hostKey, profileRootKey: 'profile', projectPath: '/static/project',
          projectBehaviorFingerprint: 'behavior', baseUrl: 'http://127.0.0.1:44444',
          port: 44444, pid: 44444, processStartedAtMs: 1_000, processBirthToken: currentToken,
          version: null, resolvedConfigFingerprint: null,
          updatedAt: '2026-08-27T00:00:00.000Z', leases: {},
        } } }))
        const original = await readFile(registryPath, 'utf8')
        const manager = new OpenCodeHostManager({ persistentRegistryPath: registryPath,
          platform: platform as NodeJS.Platform,
          isProcessAlive: () => { livenessChecks += 1; return true },
          readProcessStartTimeMs: async () => { startTimeChecks += 1; return 1_000 },
          readProcessBirthToken: () => { birthChecks += 1; return currentToken },
          isProcessGroupAlive: () => { containmentProbes += 1; return true },
          killProcess: () => { signals += 1 },
          fetchJson: async () => { remoteRequests += 1; return { status: 200, data: {} } },
          sleepMs: async () => {} })

        await expect(manager.reconcileHostReleaseReceipt({ schemaVersion: 1,
          receiptId: '77777777-7777-4777-8777-777777777777',
          hostKeyDigest: createHash('sha256').update(hostKey).digest('hex'),
          pid: 44444, processStartedAtMs: 1_000,
          lifetime: 'persistent' })).rejects.toThrow('lacks exact native generation authority')
        expect({ livenessChecks, startTimeChecks, birthChecks, containmentProbes, remoteRequests, signals })
          .toEqual({ livenessChecks: 0, startTimeChecks: 0, birthChecks: 0,
            containmentProbes: 0, remoteRequests: 0, signals: 0 })
        expect(await readFile(registryPath, 'utf8')).toBe(original)
      } finally { await rm(tempDir, { recursive: true, force: true }) }
    })

  test('legacy receipt still reconciles through its exact retained live capability', async () => {
    const profile = scopedProfile('session-resume')
    const child = createMockChildProcess(44_446)
    let alive = true
    const signals: NodeJS.Signals[] = []
    const manager = new OpenCodeHostManager({ platform: 'darwin',
      allocateLoopbackPort: async () => 44_446,
      spawnHostProcess: () => child.child,
      fetchJson: async url => url.endsWith('/global/health')
        ? { status: 200, data: { healthy: true } } : { status: 200, data: {} },
      isProcessAlive: pid => pid === 44_446 && alive,
      isProcessGroupAlive: () => false,
      readProcessStartTimeMs: async pid => pid === 44_446 ? 1_000 : null,
      killProcess: (_pid, signal) => { signals.push(signal); alive = false },
      sleepMs: async () => {}, persistentRegistryPath: null })
    const reference = await manager.ensureScopedHostReference({
      preparedProfile: profile, expectedHostKey: deriveOpenCodeScopedHostKey(profile),
    })
    const receipt = manager.hostReleaseReceipt(reference)
    expect(receipt.schemaVersion).toBe(1)

    expect(manager.hasExactRetainedHostReleaseCapability({ ...receipt, pid: receipt.pid + 1 }))
      .toBe(false)
    expect(manager.hasExactRetainedHostReleaseCapability(receipt)).toBe(true)
    await manager.reconcileHostReleaseReceipt(receipt, { keepPersistentAlive: true })
    expect(signals).toEqual([])
    expect(manager.getHost(reference.handle.hostKey)).not.toBeNull()
    expect(manager.hasExactRetainedHostReleaseCapability(receipt)).toBe(false)
  })

  test('force cleanup retains registry when the leader vanishes at the force identity read', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-force-identity-race-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const profile = scopedProfile('launch', { projectPath: tempDir })
    const child = createMockChildProcess(448)
    const signals: NodeJS.Signals[] = []
    let afterTerm = false
    let afterTermLivenessReads = 0
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => 44116,
      spawnHostProcess: () => child.child,
      fetchJson: async url => url.endsWith('/global/health')
        ? { status: 200, data: { healthy: true } }
        : { status: 200, data: {} },
      isProcessAlive: pid => {
        if (pid !== 448) return false
        if (!afterTerm) return true
        afterTermLivenessReads += 1
        // TERM observation and the outer force guard still see the leader;
        // the exact identity read immediately inside the force branch does not.
        return afterTermLivenessReads <= 2
      },
      isProcessGroupAlive: pid => pid === 448,
      readProcessStartTimeMs: async pid => pid === 448 ? 12_345 : null,
      killProcess: (_pid, signal) => {
        signals.push(signal)
        if (signal === 'SIGTERM') afterTerm = true
      },
      sleepMs: async () => {},
      persistentRegistryPath: registryPath,
    })
    try {
      await manager.ensureScopedHost({
        preparedProfile: profile, expectedHostKey: deriveOpenCodeScopedHostKey(profile),
      })
      const result = await manager.reconcilePersistentHosts({ reason: 'shutdown', mode: 'force' })
      expect(result.cleaned).toBe(0)
      expect(result.remaining).toBe(1)
      expect(signals).toEqual(['SIGTERM'])
      expect(await pathExists(registryPath)).toBe(true)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('treats a TERM observer crossing the absolute deadline as incomplete and never force mutates', async () => {
    const profile = scopedProfile('execution-probe')
    const child = createMockChildProcess(445)
    let leaderAlive = true
    let remainingReads = 0
    const signals: NodeJS.Signals[] = []
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => 44113,
      spawnHostProcess: () => child.child,
      fetchJson: async url => url.endsWith('/global/health')
        ? { status: 200, data: { healthy: true } }
        : { status: 200, data: {} },
      isProcessAlive: pid => pid === 445 && leaderAlive,
      isProcessGroupAlive: pid => pid === 445,
      killProcess: (_pid, signal) => { signals.push(signal); leaderAlive = false },
      sleepMs: async () => {},
      persistentRegistryPath: null,
    })
    const reference = await manager.ensureScopedHostReference({
      preparedProfile: profile, expectedHostKey: deriveOpenCodeScopedHostKey(profile),
    })
    await expect(manager.releaseHostReference(reference, {
      remainingMs: () => ++remainingReads < 5 ? 1 : 0,
    })).rejects.toThrow('deadline expired')
    expect(signals).toEqual(['SIGTERM'])
  })

  test('writes registry v2, structurally adopts it, and preserves v1 records without adoption', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-scoped-host-v2-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const profile = scopedProfile('launch', { projectPath: tempDir })
    const hostKey = deriveOpenCodeScopedHostKey(profile)
    let spawnCount = 0
    let processAlive = true
    const dependencies = () => ({
      allocateLoopbackPort: async () => 44102,
      spawnHostProcess: () => {
        spawnCount += 1
        return createMockChildProcess(44102).child
      },
      fetchJson: async (url: string) => {
        if (url.endsWith('/global/health')) return { status: 200, data: { healthy: true, version: 'test' } }
        if (url.endsWith('/global/dispose')) return { status: 200, data: {} }
        throw new Error(`unexpected scoped host request ${url}`)
      },
      isProcessAlive: () => processAlive,
      isProcessGroupAlive: () => processAlive,
      killProcess: () => { processAlive = false },
      readProcessStartTimeMs: async () => 1_000,
      readProcessCommandLine: async () => `opencode serve --hostname 127.0.0.1 --port 44102`,
      sleepMs: async () => {},
      persistentRegistryPath: registryPath,
    })
    try {
      const first = new OpenCodeHostManager(dependencies())
      await first.ensureScopedHost({ preparedProfile: profile, expectedHostKey: hostKey })
      const v2 = JSON.parse(await readFile(registryPath, 'utf8'))
      expect(v2.schemaVersion).toBe(2)
      expect(v2.hosts[hostKey].scopedIdentity).toMatchObject({
        binaryFingerprint: scopedFixtureBinaryFingerprint,
        profileLayoutFingerprint: profile.profileScopeIdentity,
      })
      expect(v2.hosts[hostKey]).not.toHaveProperty('projectPath')
      expect(v2.hosts[hostKey]).not.toHaveProperty('baseUrl')

      const adopter = new OpenCodeHostManager(dependencies())
      const adopted = await adopter.ensureScopedHost({
        preparedProfile: profile,
        expectedHostKey: hostKey,
      })
      expect(adopted.diagnostics.join(' ')).toContain('adopted persistent')
      expect(spawnCount).toBe(1)
      await expect(adopter.disposeHost(hostKey)).resolves.toBe(true)
      expect(await pathExists(registryPath)).toBe(false)
      processAlive = true

      const rawV1 = JSON.stringify({
        schemaVersion: 1,
        hosts: {
          [hostKey]: {
            hostKey,
            profileRootKey: profile.profileRootKey,
            projectPath: profile.projectPath,
            projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
            managedConfigFingerprint: profile.managedConfigFingerprint,
            baseUrl: 'http://127.0.0.1:49999', port: 49999, pid: 49999,
            version: null, resolvedConfigFingerprint: null,
            updatedAt: new Date(0).toISOString(),
          },
        },
      })
      await writeFile(registryPath, rawV1, { mode: 0o600 })
      const v1Preserver = new OpenCodeHostManager(dependencies())
      await v1Preserver.ensureScopedHost({ preparedProfile: profile, expectedHostKey: hostKey })
      expect(await readFile(registryPath, 'utf8')).toBe(rawV1)
      expect(spawnCount).toBe(2)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('win32 production-style scoped host persists protected owner identity and adopts after restart', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-win-owner-key-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const profile = scopedProfile('launch', { projectPath: tempDir })
    const hostKey = deriveOpenCodeScopedHostKey(profile)
    const protectedSecrets = new Map<string, string>()
    const protection = {
      get: async ({ service, name }: { service: string; name: string }) =>
        protectedSecrets.get(`${service}:${name}`) ?? null,
      set: async ({ service, name, value }: { service: string; name: string; value: string }) => {
        protectedSecrets.set(`${service}:${name}`, value)
      },
    }
    let spawns = 0
    const dependencies = () => ({
      platform: 'win32' as const,
      windowsOwnerKeyProtection: protection,
      persistentRegistryPath: registryPath,
      allocateLoopbackPort: async () => 44142,
      spawnHostProcess: () => { spawns += 1; return createMockChildProcess(54142).child },
      fetchJson: async (url: string) => url.endsWith('/global/health')
        ? { status: 200, data: { healthy: true } }
        : { status: 200, data: {} },
      isProcessAlive: () => true,
      readProcessStartTimeMs: async () => 4_242,
      readProcessCommandLine: async () =>
        'opencode serve --hostname 127.0.0.1 --port 44142',
      sleepMs: async () => {},
    })
    try {
      await new OpenCodeHostManager(dependencies()).ensureScopedHost({
        preparedProfile: profile, expectedHostKey: hostKey,
      })
      const records = await readdir(path.join(tempDir, 'host-capabilities'))
      expect(records).toHaveLength(1)
      const ownerRecord = await readFile(
        path.join(tempDir, 'host-capabilities', records[0]!), 'utf8',
      )
      expect(ownerRecord).toContain('opencode-windows-owner-key-v1')
      expect([...protectedSecrets.values()].every(secret => !ownerRecord.includes(secret))).toBe(true)

      const restarted = new OpenCodeHostManager(dependencies())
      const adopted = await restarted.ensureScopedHost({
        preparedProfile: profile, expectedHostKey: hostKey,
      })
      expect(adopted.diagnostics.join(' ')).toContain('adopted persistent')
      expect(spawns).toBe(1)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('win32 owner-key backend rejects foreign rotation and corrupt root record', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-win-owner-reject-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const profile = scopedProfile('launch', { projectPath: tempDir })
    const hostKey = deriveOpenCodeScopedHostKey(profile)
    const protectedSecrets = new Map<string, string>()
    const protection = {
      get: async ({ service, name }: { service: string; name: string }) =>
        protectedSecrets.get(`${service}:${name}`) ?? null,
      set: async ({ service, name, value }: { service: string; name: string; value: string }) => {
        protectedSecrets.set(`${service}:${name}`, value)
      },
    }
    let spawns = 0
    const dependencies = () => ({
      platform: 'win32' as const, windowsOwnerKeyProtection: protection,
      persistentRegistryPath: registryPath,
      allocateLoopbackPort: async () => 44143,
      spawnHostProcess: () => { spawns += 1; return createMockChildProcess(54143).child },
      fetchJson: async () => ({ status: 200, data: { healthy: true } }),
      isProcessAlive: () => true, readProcessStartTimeMs: async () => 4_243,
      readProcessCommandLine: async () => 'opencode serve --hostname 127.0.0.1 --port 44143',
      sleepMs: async () => {},
    })
    try {
      await new OpenCodeHostManager(dependencies()).ensureScopedHost({
        preparedProfile: profile, expectedHostKey: hostKey,
      })
      const [credential] = [...protectedSecrets.keys()]
      protectedSecrets.set(credential!, Buffer.alloc(32, 9).toString('base64'))
      await expect(new OpenCodeHostManager(dependencies()).ensureScopedHost({
        preparedProfile: profile, expectedHostKey: hostKey,
      })).rejects.toThrow('scoped host startup failed')
      expect(spawns).toBe(1)

      const [record] = await readdir(path.join(tempDir, 'host-capabilities'))
      await writeFile(path.join(tempDir, 'host-capabilities', record!), '{"schema":"foreign"}')
      await expect(new OpenCodeHostManager(dependencies()).ensureScopedHost({
        preparedProfile: profile, expectedHostKey: hostKey,
      })).rejects.toThrow('scoped host startup failed')
      expect(spawns).toBe(1)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('adopted disposal aborts before termination when any canonical registry field changes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-adopted-dispose-cas-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const profile = scopedProfile('launch', { projectPath: tempDir })
    const hostKey = deriveOpenCodeScopedHostKey(profile)
    let processAlive = true
    let disposeRequests = 0
    let killRequests = 0
    const dependencies = () => ({
      allocateLoopbackPort: async () => 44128,
      spawnHostProcess: () => createMockChildProcess(44128).child,
      fetchJson: async (url: string) => {
        if (url.endsWith('/global/health')) {
          return { status: 200, data: { healthy: true, version: '1.2.3' } }
        }
        if (url.endsWith('/global/dispose')) {
          disposeRequests += 1
          return { status: 200, data: {} }
        }
        throw new Error(`unexpected adopted CAS request ${url}`)
      },
      isProcessAlive: () => processAlive,
      killProcess: () => {
        killRequests += 1
        processAlive = false
      },
      readProcessStartTimeMs: async () => 10_000,
      readProcessCommandLine: async () =>
        'opencode serve --hostname 127.0.0.1 --port 44128',
      sleepMs: async () => {},
      persistentRegistryPath: registryPath,
    })
    try {
      const creator = new OpenCodeHostManager(dependencies())
      await creator.ensureScopedHost({ preparedProfile: profile, expectedHostKey: hostKey })
      const adopter = new OpenCodeHostManager(dependencies())
      await adopter.ensureScopedHost({ preparedProfile: profile, expectedHostKey: hostKey })

      const changed = JSON.parse(await readFile(registryPath, 'utf8')) as {
        hosts: Record<string, Record<string, unknown>>
      }
      const externalDigest = `sha256:${'a'.repeat(64)}`
      changed.hosts[hostKey] = {
        ...changed.hosts[hostKey],
        leases: {
          [externalDigest]: {
            leaseKey: externalDigest,
            teamId: externalDigest,
            laneId: externalDigest,
            memberName: externalDigest,
            runId: null,
            sessionId: null,
            createdAt: '2026-08-19T00:00:00.000Z',
            updatedAt: '2026-08-19T00:00:00.000Z',
          },
        },
        updatedAt: '2026-08-19T00:00:00.000Z',
      }
      await writeFile(registryPath, `${JSON.stringify(changed, null, 2)}\n`, { mode: 0o600 })

      await expect(adopter.disposeHost(hostKey))
        .rejects.toThrow('registry compare-and-swap failed')
      expect(processAlive).toBe(true)
      expect(disposeRequests).toBe(0)
      expect(killRequests).toBe(0)
      expect(adopter.getHost(hostKey)?.state).toBe('healthy')
      expect(JSON.parse(await readFile(registryPath, 'utf8')).hosts[hostKey].leases)
        .toHaveProperty(externalDigest)
    } finally {
      processAlive = false
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('freezes created public handles and rejects mutable-handle redirection before disposal side effects', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-created-handle-receipt-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const profile = scopedProfile('launch', { projectPath: tempDir })
    const hostKey = deriveOpenCodeScopedHostKey(profile)
    let processAlive = true
    const lifecycleRequests: string[] = []
    let killRequests = 0
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => 44130,
      spawnHostProcess: () => createMockChildProcess(44130).child,
      fetchJson: async (url: string) => {
        if (url.endsWith('/global/health')) {
          return { status: 200, data: { healthy: true, version: '1.2.3' } }
        }
        lifecycleRequests.push(url)
        return { status: 200, data: {} }
      },
      isProcessAlive: () => processAlive,
      killProcess: () => {
        killRequests += 1
        processAlive = false
      },
      readProcessStartTimeMs: async () => 10_000,
      readProcessCommandLine: async () =>
        'opencode serve --hostname 127.0.0.1 --port 44130',
      sleepMs: async () => {},
      persistentRegistryPath: registryPath,
    })
    try {
      const publicHandle = await manager.ensureScopedHost({
        preparedProfile: profile, expectedHostKey: hostKey,
      })
      expect(Object.isFrozen(publicHandle)).toBe(true)
      expect(Object.isFrozen(publicHandle.profile)).toBe(true)
      expect(Object.isFrozen(publicHandle.profile.env)).toBe(true)
      expect(publicHandle.profile).not.toBe(profile)
      expect(() => { publicHandle.baseUrl = 'http://127.0.0.1:65534' }).toThrow()

      const internal = manager as unknown as {
        hosts: Map<string, { handle: typeof publicHandle }>
      }
      const tracked = internal.hosts.get(hostKey)!
      tracked.handle = {
        ...publicHandle,
        baseUrl: 'http://127.0.0.1:65534',
        pid: publicHandle.pid + 1,
      }
      await expect(manager.disposeHost(hostKey)).rejects.toThrow('handle/receipt mismatch')
      expect(lifecycleRequests).toEqual([])
      expect(killRequests).toBe(0)
      expect(processAlive).toBe(true)
      expect(JSON.parse(await readFile(registryPath, 'utf8')).hosts).toHaveProperty(hostKey)
    } finally {
      processAlive = false
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('freezes adopted public handles and rejects mutable-handle redirection before disposal side effects', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-adopted-handle-receipt-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const profile = scopedProfile('launch', { projectPath: tempDir })
    const hostKey = deriveOpenCodeScopedHostKey(profile)
    let processAlive = true
    const lifecycleRequests: string[] = []
    let killRequests = 0
    const dependencies = () => ({
      allocateLoopbackPort: async () => 44129,
      spawnHostProcess: () => createMockChildProcess(44129).child,
      fetchJson: async (url: string) => {
        if (url.endsWith('/global/health')) {
          return { status: 200, data: { healthy: true, version: '1.2.3' } }
        }
        lifecycleRequests.push(url)
        return { status: 200, data: {} }
      },
      isProcessAlive: () => processAlive,
      killProcess: () => {
        killRequests += 1
        processAlive = false
      },
      readProcessStartTimeMs: async () => 10_000,
      readProcessCommandLine: async () =>
        'opencode serve --hostname 127.0.0.1 --port 44129',
      sleepMs: async () => {},
      persistentRegistryPath: registryPath,
    })
    try {
      await new OpenCodeHostManager(dependencies()).ensureScopedHost({
        preparedProfile: profile, expectedHostKey: hostKey,
      })
      const adopter = new OpenCodeHostManager(dependencies())
      const publicHandle = await adopter.ensureScopedHost({
        preparedProfile: profile, expectedHostKey: hostKey,
      })
      expect(Object.isFrozen(publicHandle)).toBe(true)
      expect(() => { publicHandle.baseUrl = 'http://127.0.0.1:65534' }).toThrow()

      const internal = adopter as unknown as {
        hosts: Map<string, { handle: typeof publicHandle }>
      }
      const tracked = internal.hosts.get(hostKey)!
      tracked.handle = {
        ...publicHandle,
        baseUrl: 'http://127.0.0.1:65534',
        pid: publicHandle.pid + 1,
      }
      await expect(adopter.disposeHost(hostKey)).rejects.toThrow('handle/receipt mismatch')
      expect(lifecycleRequests).toEqual([])
      expect(killRequests).toBe(0)
      expect(processAlive).toBe(true)
      expect(JSON.parse(await readFile(registryPath, 'utf8')).hosts).toHaveProperty(hostKey)
    } finally {
      processAlive = false
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('executes an app-owned verified binary even when the source path is replaced before spawn', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-scoped-binary-'))
    const sourcePath = path.join(tempDir, 'source-opencode')
    const profileRootPath = path.join(tempDir, 'profile')
    const expectedBytes = Buffer.from('#!/bin/sh\necho verified\n')
    const replacementBytes = Buffer.from('#!/bin/sh\necho replaced\n')
    await writeFile(sourcePath, expectedBytes, { mode: 0o700 })
    await mkdir(profileRootPath, { recursive: true })
    const profile = scopedProfile('execution-probe', {
      projectPath: tempDir,
      profileRootPath,
      tmpPath: path.join(profileRootPath, 'tmp'),
      binaryPath: sourcePath,
      binaryFingerprint: createHash('sha256').update(expectedBytes).digest('hex'),
    })
    const executedBytes: Buffer[] = []
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => {
        await writeFile(sourcePath, replacementBytes, { mode: 0o700 })
        return 44110
      },
      spawnHostProcess: staged => {
        if (!('binaryPath' in staged) || typeof staged.binaryPath !== 'string') {
          throw new Error('expected a staged scoped profile')
        }
        executedBytes.push(readFileSync(staged.binaryPath))
        return createMockChildProcess(44110).child
      },
      fetchJson: async url => url.endsWith('/global/health')
        ? { status: 200, data: { healthy: true } }
        : { status: 200, data: {} },
      isProcessAlive: () => false,
      sleepMs: async () => {},
      persistentRegistryPath: path.join(tempDir, 'registry.json'),
    })
    try {
      const handle = await manager.ensureScopedHost({
        preparedProfile: profile,
        expectedHostKey: deriveOpenCodeScopedHostKey(profile),
      })
      expect(executedBytes).toEqual([expectedBytes])
      expect('binaryPath' in handle.profile).toBe(true)
      if (!('binaryPath' in handle.profile) || typeof handle.profile.binaryPath !== 'string') {
        throw new Error('expected a staged scoped profile')
      }
      expect(handle.profile.binaryPath).not.toBe(sourcePath)
      expect((await statMode(handle.profile.binaryPath)) & 0o100).not.toBe(0)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('fails closed when source bytes no longer match the prepared binary fingerprint', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-scoped-binary-fail-'))
    const sourcePath = path.join(tempDir, 'source-opencode')
    const preparedBytes = Buffer.from('prepared')
    await writeFile(sourcePath, 'replacement', { mode: 0o700 })
    const profile = scopedProfile('execution-probe', {
      projectPath: tempDir,
      profileRootPath: path.join(tempDir, 'profile'),
      binaryPath: sourcePath,
      binaryFingerprint: createHash('sha256').update(preparedBytes).digest('hex'),
    })
    let spawned = false
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => { throw new Error('must not allocate') },
      spawnHostProcess: () => { spawned = true; return createMockChildProcess().child },
      persistentRegistryPath: path.join(tempDir, 'registry.json'),
    })
    try {
      await expect(manager.ensureScopedHost({
        preparedProfile: profile,
        expectedHostKey: deriveOpenCodeScopedHostKey(profile),
      })).rejects.toThrow('fingerprint verification failed')
      expect(spawned).toBe(false)
      expect(await pathExists(path.join(tempDir, 'registry.json'))).toBe(false)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('rejects a symlinked scoped binary before allocation or spawn', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-scoped-binary-link-'))
    const targetPath = path.join(tempDir, 'target-opencode')
    const sourcePath = path.join(tempDir, 'source-opencode')
    const profileRootPath = path.join(tempDir, 'profile')
    const bytes = Buffer.from('verified target')
    await writeFile(targetPath, bytes, { mode: 0o700 })
    await symlink(targetPath, sourcePath)
    await mkdir(profileRootPath)
    const profile = scopedProfile('execution-probe', {
      projectPath: tempDir,
      profileRootPath,
      binaryPath: sourcePath,
      binaryFingerprint: createHash('sha256').update(bytes).digest('hex'),
    })
    let touched = false
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => { touched = true; return 44117 },
      spawnHostProcess: () => { touched = true; return createMockChildProcess().child },
      persistentRegistryPath: path.join(tempDir, 'registry.json'),
    })
    try {
      await expect(manager.ensureScopedHost({
        preparedProfile: profile,
        expectedHostKey: deriveOpenCodeScopedHostKey(profile),
      })).rejects.toThrow()
      expect(touched).toBe(false)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('rejects a symlinked staged-binary parent with zero writes outside the profile', async () => {
    if (process.platform === 'win32') return
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-scoped-stage-parent-'))
    const profileRootPath = path.join(tempDir, 'profile')
    const outsidePath = path.join(tempDir, 'outside')
    await mkdir(profileRootPath)
    await mkdir(outsidePath)
    await symlink(outsidePath, path.join(profileRootPath, 'host-binaries'))
    const profile = scopedProfile('execution-probe', { profileRootPath })
    try {
      await expect(stageScopedHostBinary(profile)).rejects.toThrow(
        'managed path ancestry is not canonical',
      )
      expect(await readdir(outsidePath)).toEqual([])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('uses opaque registry identity, redacts child output, and never probes inventory surfaces', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-scoped-redaction-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const child = createMockChildProcess(54111)
    const rawSecret = 'raw-secret-plugin-and-credential'
    const profile = scopedProfile('launch', {
      projectPath: path.join(tempDir, 'raw-project'),
      managedConfig: { plugin: [`npm:${rawSecret}`], credential: rawSecret },
      env: { OPENAI_API_KEY: rawSecret },
    })
    const urls: string[] = []
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => 44111,
      spawnHostProcess: () => {
        queueMicrotask(() => {
          if (child.child.stderr instanceof PassThrough) child.child.stderr.write(`${rawSecret}\n`)
        })
        return child.child
      },
      fetchJson: async url => {
        urls.push(url)
        if (url.endsWith('/global/health')) {
          return { status: 200, data: { healthy: true, version: `1.2.3-${rawSecret}` } }
        }
        throw new Error(`forbidden ${rawSecret}`)
      },
      isProcessAlive: () => true,
      sleepMs: async () => {},
      persistentRegistryPath: registryPath,
    })
    try {
      const handle = await manager.ensureScopedHost({
        preparedProfile: profile,
        expectedHostKey: deriveOpenCodeScopedHostKey(profile),
      })
      await Promise.resolve()
      await manager.retainHostLease(handle.hostKey, {
        teamId: `${rawSecret}-team`, memberName: `${rawSecret}-member`,
        runId: `${rawSecret}-run`, sessionId: `${rawSecret}-session`,
      })
      const persisted = await readFile(registryPath, 'utf8')
      const persistedRegistry = JSON.parse(persisted) as {
        hosts: Record<string, { port: number }>
      }
      expect(persisted).not.toContain(profile.projectPath)
      expect(persisted).not.toContain(profile.binaryPath)
      expect(persisted).not.toContain(rawSecret)
      expect(persisted).not.toContain('http://127.0.0.1:44111')
      expect(persistedRegistry.hosts[handle.hostKey]?.port).toBe(0)
      expect(JSON.parse(persisted).hosts[handle.hostKey].port).toBe(0)
      expect(persisted).not.toContain(profile.policy.identity.canonicalInput)
      const capabilityFiles = await readdir(path.join(tempDir, 'host-capabilities'))
      expect(capabilityFiles).toHaveLength(1)
      const ownerKeyPath = path.join(tempDir, 'host-capabilities', capabilityFiles[0]!)
      const ownerKey = await readFile(ownerKeyPath)
      expect(ownerKey).toHaveLength(32)
      expect((await statMode(ownerKeyPath)) & 0o077).toBe(0)
      expect(persisted).not.toContain(ownerKey.toString('hex'))
      expect(handle.diagnostics.join(' ')).not.toContain(rawSecret)
      expect(handle.version).toBeNull()
      expect(urls).toEqual(['http://127.0.0.1:44111/global/health'])
      await manager.refreshResolvedConfigFingerprint(handle.hostKey)
      expect(urls).toEqual(['http://127.0.0.1:44111/global/health'])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('includes profile layout generation in scoped key and adoption identity', () => {
    const base = scopedProfile('launch')
    const first = { ...base, profileScopeIdentity: 'layout-generation-a' }
    const secondPlanDigest = createHash('sha256').update('layout-generation-b').digest('hex')
    const second = {
      ...base,
      profileScopeIdentity: 'layout-generation-b',
      scopedPlanDigest: secondPlanDigest,
      plannedHostKey: deriveOpenCodeScopedHostKeyFromPlanDigest(secondPlanDigest),
    }
    expect(deriveOpenCodeScopedHostKey(first)).not.toBe(deriveOpenCodeScopedHostKey(second))
  })

  test('binds the automatic user-plugin digest into exact scoped host identity', () => {
    const profile = scopedProfile('launch')
    const changed = {
      ...profile,
      automaticUserPluginFingerprint: createHash('sha256').update('changed-plugin').digest('hex'),
    }
    expect(buildOpenCodeScopedHostIdentity(changed))
      .not.toEqual(buildOpenCodeScopedHostIdentity(profile))
  })

  test('preserves the complete v1 namespace through v2 lifecycle and reconciliation', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-v1-preservation-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const legacyRecord = {
      hostKey: 'legacy-colliding-key', profileRootKey: 'legacy-profile-root',
      projectPath: '/raw/legacy/project', projectBehaviorFingerprint: 'legacy-behavior',
      baseUrl: 'http://127.0.0.1:49991', port: 49991, pid: 49991,
      version: 'legacy', resolvedConfigFingerprint: 'legacy-config',
      updatedAt: '2026-08-01T00:00:00.000Z',
      leases: { raw: { leaseKey: 'raw', teamId: 'legacy-team', laneId: 'legacy-lane', memberName: 'legacy-member', runId: null, sessionId: null, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' } },
    }
    const rawV1 = JSON.stringify({
      schemaVersion: 1, hosts: { [legacyRecord.hostKey]: legacyRecord },
    })
    await writeFile(registryPath, rawV1, { mode: 0o600 })
    const profile = scopedProfile('launch', { projectPath: tempDir })
    const hostKey = deriveOpenCodeScopedHostKey(profile)
    const alive = new Set([44112])
    const probedPids: number[] = []
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => 44112,
      spawnHostProcess: () => createMockChildProcess(44112).child,
      fetchJson: async url => url.endsWith('/global/health')
        ? { status: 200, data: { healthy: true } }
        : { status: 200, data: {} },
      isProcessAlive: pid => { probedPids.push(pid); return alive.has(pid) },
      killProcess: pid => { alive.delete(pid) },
      sleepMs: async () => {},
      persistentRegistryPath: registryPath,
    })
    try {
      await manager.ensureScopedHost({ preparedProfile: profile, expectedHostKey: hostKey })
      await manager.retainHostLease(hostKey, { teamId: 'team', memberName: 'member' })
      await manager.releaseHostLease(hostKey, { teamId: 'team', memberName: 'member' })
      await manager.disposeHost(hostKey)
      await manager.reconcilePersistentHosts({ mode: 'force', reason: 'manual' })
      expect(await readFile(registryPath, 'utf8')).toBe(rawV1)
      expect(probedPids).not.toContain(legacyRecord.pid)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('fails closed on malformed v2 records before process inspection, health, or signalling', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-v2-malformed-'))
    const registryPath = path.join(tempDir, 'registry.json')
    let touched = 0
    await writeFile(registryPath, JSON.stringify({
      schemaVersion: 2,
      hosts: {
        'registry-key': {
          hostKey: 'different-key',
          profileRootKey: 'profile',
          projectPath: '/opaque/project',
          projectBehaviorFingerprint: 'behavior',
          baseUrl: 'http://127.0.0.1:44123',
          port: 44123,
          pid: 44123,
          processStartedAtMs: 1000,
          version: null,
          resolvedConfigFingerprint: null,
          updatedAt: '2026-08-18T00:00:00.000Z',
        },
      },
    }), { mode: 0o600 })
    const original = await readFile(registryPath, 'utf8')
    const manager = new OpenCodeHostManager({
      persistentRegistryPath: registryPath,
      isProcessAlive: () => { touched += 1; return true },
      readProcessCommandLine: async () => { touched += 1; return 'opencode serve --port 44123' },
      readProcessStartTimeMs: async () => { touched += 1; return 1000 },
      fetchJson: async () => { touched += 1; return { status: 200, data: {} } },
      killProcess: () => { touched += 1 },
    })
    try {
      await expect(manager.reconcilePersistentHosts({ mode: 'force' }))
        .rejects.toThrow('corrupt or unreadable')
      expect(touched).toBe(0)
      expect(await readFile(registryPath, 'utf8')).toBe(original)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('fails closed on a deep scoped-record mismatch without adoption or registry mutation', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-v2-inconsistent-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const profile = scopedProfile('launch', { projectPath: tempDir })
    const hostKey = deriveOpenCodeScopedHostKey(profile)
    const record = {
      hostKey,
      profileRootKey: 'forged-profile-root',
      projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
      managedConfigFingerprint: profile.managedConfigFingerprint,
      port: 0,
      pid: 44001,
      processStartedAtMs: 1000,
      version: null,
      resolvedConfigFingerprint: profile.managedConfigFingerprint,
      updatedAt: '2026-08-18T00:00:00.000Z',
      coordinationProtectedUntil: '2026-08-18T00:00:30.000Z',
      leases: {},
      scopedIdentity: buildOpenCodeScopedHostIdentity(profile),
      scopedTransportToken: 'loopback:00000000',
    }
    const original = JSON.stringify({ schemaVersion: 2, hosts: { [hostKey]: record } })
    await writeFile(registryPath, original, { mode: 0o600 })
    let touched = 0
    const manager = new OpenCodeHostManager({
      persistentRegistryPath: registryPath,
      isProcessAlive: () => { touched += 1; return true },
      spawnHostProcess: () => { touched += 1; return createMockChildProcess().child },
      fetchJson: async () => { touched += 1; return { status: 200, data: { healthy: true } } },
    })
    try {
      await expect(manager.ensureScopedHost({ preparedProfile: profile, expectedHostKey: hostKey }))
        .rejects.toThrow('startup failed [redacted]')
      expect(touched).toBe(0)
      expect(await readFile(registryPath, 'utf8')).toBe(original)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('retains a scoped tombstone with an invalid owner lifecycle binding without trusting its pid', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-v2-foreign-tombstone-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const profile = scopedProfile('launch', { projectPath: tempDir })
    const hostKey = deriveOpenCodeScopedHostKey(profile)
    const ownerKey = Buffer.alloc(32, 7)
    try {
      const creator = new OpenCodeHostManager({
        allocateLoopbackPort: async () => 44501,
        spawnHostProcess: () => createMockChildProcess(44501).child,
        fetchJson: async () => ({ status: 200, data: { healthy: true, version: 'static' } }),
        isProcessAlive: () => true,
        readProcessStartTimeMs: async () => 1_000,
        persistentRegistryPath: registryPath,
        scopedTransportOwnerKey: ownerKey,
      })
      await creator.ensureScopedHost({ preparedProfile: profile, expectedHostKey: hostKey })
      const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
        hosts: Record<string, { scopedIdentity: { providerFingerprint: string } }>
      }
      registry.hosts[hostKey]!.scopedIdentity.providerFingerprint = 'f'.repeat(64)
      Object.assign(registry.hosts[hostKey]!, {
        pid: 99_999,
        processStartedAtMs: 9_999,
        processBirthToken: 'linux:forged-boot:9999',
      })
      await writeFile(registryPath, `${JSON.stringify(registry)}\n`, { mode: 0o600 })
      const foreignBytes = await readFile(registryPath, 'utf8')

      let spawnCount = 0
      const blocked = new OpenCodeHostManager({
        platform: 'linux', persistentRegistryPath: registryPath, scopedTransportOwnerKey: ownerKey,
        isProcessAlive: () => true, isProcessGroupAlive: () => true,
        spawnHostProcess: () => { spawnCount += 1; return createMockChildProcess(44502).child },
      })
      await expect(blocked.ensureScopedHost({ preparedProfile: profile, expectedHostKey: hostKey }))
        .rejects.toThrow('startup failed [redacted]')
      expect(spawnCount).toBe(0)
      expect(await readFile(registryPath, 'utf8')).toBe(foreignBytes)

      let containmentProbes = 0
      const stillBlocked = new OpenCodeHostManager({
        platform: 'linux', persistentRegistryPath: registryPath, scopedTransportOwnerKey: ownerKey,
        isProcessAlive: () => { containmentProbes += 1; return false },
        isProcessGroupAlive: () => { containmentProbes += 1; return false },
        allocateLoopbackPort: async () => 44502,
        spawnHostProcess: () => { spawnCount += 1; return createMockChildProcess(44502).child },
        fetchJson: async () => ({ status: 200, data: { healthy: true, version: 'static' } }),
        readProcessStartTimeMs: async () => 2_000,
      })
      await expect(stillBlocked.ensureScopedHost({ preparedProfile: profile, expectedHostKey: hostKey }))
        .rejects.toThrow('startup failed [redacted]')
      expect(containmentProbes).toBe(0)
      expect(spawnCount).toBe(0)
      expect(await readFile(registryPath, 'utf8')).toBe(foreignBytes)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('preserves null and primitive legacy records opaquely through v2 mutation', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-v2-null-legacy-'))
    const registryPath = path.join(tempDir, 'registry.json')
    await writeFile(registryPath, JSON.stringify({
      schemaVersion: 2,
      hosts: {},
      legacyHosts: { nullRecord: null, numericRecord: 7, stringRecord: 'opaque' },
    }), { mode: 0o600 })
    const manager = new OpenCodeHostManager({ persistentRegistryPath: registryPath })
    try {
      await manager.reconcilePersistentHosts({ mode: 'stale', reason: 'startup' })
      expect(JSON.parse(await readFile(registryPath, 'utf8')).legacyHosts).toEqual({
        nullRecord: null,
        numericRecord: 7,
        stringRecord: 'opaque',
      })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('rejects every present non-object legacyHosts shape before mutation', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-invalid-legacy-hosts-'))
    try {
      for (const schemaVersion of [1, 2]) {
        for (const invalidLegacyHosts of [null, [], 'opaque', 7, true]) {
          const registryPath = path.join(
            tempDir,
            `registry-${schemaVersion}-${typeof invalidLegacyHosts}-${String(invalidLegacyHosts)}.json`,
          )
          const original = JSON.stringify({ schemaVersion, hosts: {}, legacyHosts: invalidLegacyHosts })
          await writeFile(registryPath, original, { mode: 0o600 })
          const manager = new OpenCodeHostManager({ persistentRegistryPath: registryPath })
          const readRegistry = (manager as unknown as {
            readPersistentRegistryUnlocked: () => Promise<unknown>
          }).readPersistentRegistryUnlocked.bind(manager)
          await expect(readRegistry())
            .rejects.toThrow('corrupt or unreadable')
          expect(await readFile(registryPath, 'utf8')).toBe(original)
        }
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('fails closed on a corrupt registry and never overwrites its raw bytes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-corrupt-registry-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const corruptBytes = '{"schemaVersion":1,"hosts":'
    await writeFile(registryPath, corruptBytes, { mode: 0o600 })
    const profile = scopedProfile('launch', { projectPath: tempDir })
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => 44118,
      spawnHostProcess: () => createMockChildProcess(44118).child,
      persistentRegistryPath: registryPath,
    })
    try {
      await expect(manager.ensureScopedHost({
        preparedProfile: profile,
        expectedHostKey: deriveOpenCodeScopedHostKey(profile),
      })).rejects.toThrow('startup failed [redacted]')
      expect(await readFile(registryPath, 'utf8')).toBe(corruptBytes)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('rejects a symlinked registry instead of following it through the coordination root', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-registry-link-'))
    const outsidePath = path.join(tempDir, 'outside.json')
    const registryPath = path.join(tempDir, 'registry.json')
    const outsideBytes = JSON.stringify({ schemaVersion: 2, hosts: {} })
    await writeFile(outsidePath, outsideBytes, { mode: 0o600 })
    await symlink(outsidePath, registryPath)
    try {
      await expect(new OpenCodeHostManager({ persistentRegistryPath: registryPath })
        .reconcilePersistentHosts({ mode: 'stale' })).rejects.toThrow('corrupt or unreadable')
      expect(await readFile(outsidePath, 'utf8')).toBe(outsideBytes)
    } finally { await rm(tempDir, { recursive: true, force: true }) }
  })

  test('dispose wins while scoped health is delayed and late health cannot publish a handle', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-scoped-dispose-race-'))
    const healthStarted = createDeferred<void>()
    const releaseHealth = createDeferred<void>()
    const profile = scopedProfile('execution-probe', { projectPath: tempDir })
    const hostKey = deriveOpenCodeScopedHostKey(profile)
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => 44119,
      spawnHostProcess: () => createMockChildProcess(44119).child,
      fetchJson: async url => {
        if (url.endsWith('/global/health')) {
          healthStarted.resolve()
          await releaseHealth.promise
          return { status: 200, data: { healthy: true, version: '1.2.3' } }
        }
        return { status: 200, data: {} }
      },
      isProcessAlive: () => false,
      persistentRegistryPath: path.join(tempDir, 'registry.json'),
    })
    try {
      const startup = manager.ensureScopedHost({ preparedProfile: profile, expectedHostKey: hostKey })
      await healthStarted.promise
      expect(await manager.disposeHost(hostKey)).toBe(true)
      releaseHealth.resolve()
      await expect(startup).rejects.toThrow('startup failed [redacted]')
      expect(manager.getHost(hostKey)).toBeNull()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('installs a tombstone before delayed binary staging so dispose wins without spawning', async () => {
    const stagingStarted = createDeferred<void>()
    const releaseStaging = createDeferred<void>()
    const profile = scopedProfile('execution-probe')
    const hostKey = deriveOpenCodeScopedHostKey(profile)
    let spawned = 0
    let stagedCloseCount = 0
    const stagedHandles: Array<Awaited<ReturnType<typeof open>>> = []
    const manager = new OpenCodeHostManager({
      stageScopedHostBinary: async preparedProfile => {
        stagingStarted.resolve()
        await releaseStaging.promise
        const stagedHandle = await open(preparedProfile.binaryPath)
        const originalClose = stagedHandle.close.bind(stagedHandle)
        stagedHandle.close = async () => {
          stagedCloseCount += 1
          return originalClose()
        }
        stagedHandles.push(stagedHandle)
        return bindVerifiedScopedBinaryHandle(preparedProfile, stagedHandle)
      },
      spawnHostProcess: () => { spawned += 1; return createMockChildProcess().child },
      persistentRegistryPath: null,
    })
    const startup = manager.ensureScopedHost({ preparedProfile: profile, expectedHostKey: hostKey })
    await stagingStarted.promise
    expect(await manager.disposeHost(hostKey)).toBe(true)
    releaseStaging.resolve()
    await expect(startup).rejects.toThrow('cancelled')
    expect(spawned).toBe(0)
    expect(manager.getHost(hostKey)).toBeNull()
    expect(stagedHandles).toHaveLength(1)
    expect(stagedHandles[0]!.fd).toBe(-1)
    expect(stagedCloseCount).toBe(1)
  })

  test('closes an abandoned late staged handle exactly once when abort wins', async () => {
    const stagingStarted = createDeferred<void>()
    const releaseStaging = createDeferred<void>()
    const profile = scopedProfile('execution-probe')
    const hostKey = deriveOpenCodeScopedHostKey(profile)
    const controller = new AbortController()
    let closeCount = 0
    const manager = new OpenCodeHostManager({
      stageScopedHostBinary: async preparedProfile => {
        stagingStarted.resolve()
        await releaseStaging.promise
        const fakeHandle = {
          fd: 102,
          close: async () => { closeCount += 1 },
        } as unknown as Awaited<ReturnType<typeof open>>
        return bindVerifiedScopedBinaryHandle(preparedProfile, fakeHandle)
      },
      spawnHostProcess: () => { throw new Error('must not spawn') },
      persistentRegistryPath: null,
    })
    const startup = manager.ensureScopedHost({
      preparedProfile: profile,
      expectedHostKey: hostKey,
      abortSignal: controller.signal,
    })
    await stagingStarted.promise
    controller.abort(new Error('cancelled while staging'))
    await expect(startup).rejects.toThrow('cancelled while staging')
    releaseStaging.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(closeCount).toBe(1)
    expect(manager.getHost(hostKey)).toBeNull()
  })

  test('closes the staged executable descriptor on every late assertion failure', async () => {
    if (process.platform !== 'linux') return
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-staged-fd-late-failure-'))
    try {
      for (const failAt of [9, 10, 11]) {
        const profileRootPath = path.join(tempDir, `profile-${failAt}`)
        const profile = scopedProfile('execution-probe', { profileRootPath })
        const before = (await readdir('/proc/self/fd')).length
        let assertions = 0
        await expect(stageScopedHostBinary(profile, () => {
          assertions += 1
          if (assertions === failAt) throw new Error(`cancel-${failAt}`)
        })).rejects.toThrow(`cancel-${failAt}`)
        expect(assertions).toBe(failAt)
        expect((await readdir('/proc/self/fd')).length).toBe(before)
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('closes the staged executable handle exactly once on read, chmod, and generation failures', async () => {
    if (process.platform === 'win32') return
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-staged-exact-close-'))
    try {
      for (const failure of ['read', 'chmod', 'generation'] as const) {
        const profile = scopedProfile('execution-probe', {
          profileRootPath: path.join(tempDir, failure),
        })
        let closeCount = 0
        let stagedHandleOpened = false
        await expect(stageScopedHostBinary(
          profile,
          () => {
            if (failure === 'generation' && stagedHandleOpened) {
              throw new Error('generation failed')
            }
          },
          {
            afterStagedHandleOpened: handle => {
              stagedHandleOpened = true
              const originalClose = handle.close.bind(handle)
              handle.close = async () => {
                closeCount += 1
                return originalClose()
              }
              if (failure === 'read') {
                handle.readFile = async () => { throw new Error('read failed') }
              }
              if (failure === 'chmod') {
                handle.chmod = async () => { throw new Error('chmod failed') }
              }
            },
          },
        )).rejects.toThrow(`${failure} failed`)
        expect(closeCount).toBe(1)
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('retains local executable ownership until publication-directory close succeeds', async () => {
    if (process.platform === 'win32') return
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-staged-directory-close-'))
    try {
      const profile = scopedProfile('execution-probe', { profileRootPath: tempDir })
      let executableCloseCount = 0
      await expect(stageScopedHostBinary(profile, () => undefined, {
        afterStagedHandleOpened: handle => {
          const originalClose = handle.close.bind(handle)
          handle.close = async () => {
            executableCloseCount += 1
            return originalClose()
          }
        },
        closePublicationDirectory: async directory => {
          await directory.close()
          throw new Error('publication directory close rejected')
        },
      })).rejects.toThrow('publication directory close rejected')
      expect(executableCloseCount).toBe(1)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('transfers staged handle ownership explicitly and closes it exactly once', async () => {
    const profile = scopedProfile('execution-probe')
    let closeCount = 0
    const fakeHandle = {
      fd: 101,
      close: async () => { closeCount += 1 },
    } as unknown as Awaited<ReturnType<typeof open>>
    const verified = bindVerifiedScopedBinaryHandle(profile, fakeHandle)
    expect(verified.fileHandle).toBe(fakeHandle)
    await verified.close()
    await verified.close()
    expect(closeCount).toBe(1)
  })

  test('abort during a blocked registry upsert removes late publication and returns no handle', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-scoped-upsert-abort-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const upsertStarted = createDeferred<void>()
    const releaseUpsert = createDeferred<void>()
    const controller = new AbortController()
    const profile = scopedProfile('launch', { projectPath: tempDir })
    const hostKey = deriveOpenCodeScopedHostKey(profile)
    let writes = 0
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => 44129,
      spawnHostProcess: () => createMockChildProcess(44129).child,
      fetchJson: async url => url.endsWith('/global/health')
        ? { status: 200, data: { healthy: true } }
        : { status: 200, data: {} },
      isProcessAlive: () => false,
      beforePersistentRegistryWrite: async () => {
        writes += 1
        if (writes === 1) {
          upsertStarted.resolve()
          await releaseUpsert.promise
        }
      },
      persistentRegistryPath: registryPath,
    })
    try {
      const startup = manager.ensureScopedHost({
        preparedProfile: profile,
        expectedHostKey: hostKey,
        abortSignal: controller.signal,
      })
      await upsertStarted.promise
      controller.abort(new Error('cancelled during upsert'))
      releaseUpsert.resolve()
      await expect(startup).rejects.toThrow('cancelled during upsert')
      expect(manager.getHost(hostKey)).toBeNull()
      const registry = await readFile(registryPath, 'utf8').catch(() => '')
      expect(registry).not.toContain(hostKey)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('abort after the final new-host upsert still removes publication and returns no handle', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-scoped-post-upsert-abort-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const upsertPublished = createDeferred<void>()
    const releasePublication = createDeferred<void>()
    const controller = new AbortController()
    const profile = scopedProfile('launch', { projectPath: tempDir })
    const hostKey = deriveOpenCodeScopedHostKey(profile)
    let writes = 0
    const manager = new OpenCodeHostManager({
      allocateLoopbackPort: async () => 44130,
      spawnHostProcess: () => createMockChildProcess(44130).child,
      fetchJson: async () => ({ status: 200, data: { healthy: true } }),
      isProcessAlive: () => false,
      isProcessGroupAlive: () => false,
      killProcess: () => {},
      afterPersistentRegistryWrite: async () => {
        writes += 1
        if (writes === 2) {
          upsertPublished.resolve()
          await releasePublication.promise
        }
      },
      persistentRegistryPath: registryPath,
    })
    try {
      const startup = manager.ensureScopedHost({
        preparedProfile: profile, expectedHostKey: hostKey, abortSignal: controller.signal,
      })
      await upsertPublished.promise
      controller.abort(new Error('cancelled after final upsert'))
      releasePublication.resolve()
      await expect(startup).rejects.toThrow('cancelled after final upsert')
      expect(manager.getHost(hostKey)).toBeNull()
      expect(await readFile(registryPath, 'utf8').catch(() => '')).not.toContain(hostKey)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('abort after adopted-host publication removes its handle and restores the pre-existing record', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-scoped-adopt-publish-abort-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const profile = scopedProfile('launch', { projectPath: tempDir })
    const hostKey = deriveOpenCodeScopedHostKey(profile)
    const alive = new Set([44131])
    const common = {
      allocateLoopbackPort: async () => 44131,
      spawnHostProcess: () => createMockChildProcess(44131).child,
      fetchJson: async () => ({ status: 200, data: { healthy: true } }),
      isProcessAlive: (pid: number) => alive.has(pid),
      killProcess: (pid: number) => { alive.delete(pid) },
      persistentRegistryPath: registryPath,
    }
    try {
      await new OpenCodeHostManager(common).ensureScopedHost({
        preparedProfile: profile, expectedHostKey: hostKey,
      })
      alive.add(44131)
      const published = createDeferred<void>()
      const release = createDeferred<void>()
      const controller = new AbortController()
      let writes = 0
      const adopter = new OpenCodeHostManager({
        ...common,
        afterPersistentRegistryWrite: async () => {
          writes += 1
          if (writes === 1) {
            published.resolve()
            await release.promise
          }
        },
      })
      const startup = adopter.ensureScopedHost({
        preparedProfile: profile, expectedHostKey: hostKey, abortSignal: controller.signal,
      })
      await published.promise
      controller.abort(new Error('cancelled adopted publication'))
      release.resolve()
      await expect(startup).rejects.toThrow('cancelled adopted publication')
      expect(adopter.getHost(hostKey)).toBeNull()
      expect(await readFile(registryPath, 'utf8').catch(() => '')).toContain(hostKey)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('adopter cancellation during delayed health preserves the pre-existing record byte-for-byte', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-scoped-adopt-health-abort-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const profile = scopedProfile('launch', { projectPath: tempDir })
    const hostKey = deriveOpenCodeScopedHostKey(profile)
    const healthStarted = createDeferred<void>()
    const releaseHealth = createDeferred<void>()
    try {
      const common = {
        allocateLoopbackPort: async () => 44137,
        spawnHostProcess: () => createMockChildProcess(44137).child,
        isProcessAlive: (pid: number) => pid === 44137,
        persistentRegistryPath: registryPath,
      }
      await new OpenCodeHostManager({
        ...common,
        fetchJson: async () => ({ status: 200, data: { healthy: true } }),
      }).ensureScopedHost({ preparedProfile: profile, expectedHostKey: hostKey })
      const originalRegistry = await readFile(registryPath, 'utf8')
      const controller = new AbortController()
      const adopter = new OpenCodeHostManager({
        ...common,
        fetchJson: async () => {
          healthStarted.resolve()
          await releaseHealth.promise
          return { status: 200, data: { healthy: true } }
        },
      })
      const startup = adopter.ensureScopedHost({
        preparedProfile: profile,
        expectedHostKey: hostKey,
        abortSignal: controller.signal,
      })
      await healthStarted.promise
      controller.abort(new Error('cancelled adopter health'))
      await expect(startup).rejects.toThrow('cancelled adopter health')
      releaseHealth.resolve()
      expect(adopter.getHost(hostKey)).toBeNull()
      expect(await readFile(registryPath, 'utf8')).toBe(originalRegistry)
    } finally {
      releaseHealth.resolve()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('rejects a scoped V2 record whose redundant resolved fingerprint disagrees with identity', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-scoped-v2-config-mismatch-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const profile = scopedProfile('launch', { projectPath: tempDir })
    const hostKey = deriveOpenCodeScopedHostKey(profile)
    const deps = {
      allocateLoopbackPort: async () => 44132,
      spawnHostProcess: () => createMockChildProcess(44132).child,
      fetchJson: async () => ({ status: 200, data: { healthy: true } }),
      isProcessAlive: () => true,
      persistentRegistryPath: registryPath,
    }
    try {
      await new OpenCodeHostManager(deps).ensureScopedHost({
        preparedProfile: profile, expectedHostKey: hostKey,
      })
      const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
        hosts: Record<string, { resolvedConfigFingerprint: string | null }>
      }
      registry.hosts[hostKey]!.resolvedConfigFingerprint = '0'.repeat(64)
      await writeFile(registryPath, JSON.stringify(registry), { mode: 0o600 })
      let lifecycleTouches = 0
      const adopter = new OpenCodeHostManager({
        ...deps,
        isProcessAlive: () => { lifecycleTouches += 1; return true },
      })
      await expect(adopter.ensureScopedHost({ preparedProfile: profile, expectedHostKey: hostKey }))
        .rejects.toThrow('startup failed [redacted]')
      expect(lifecycleTouches).toBe(0)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('serializes adoption publication with reconciliation and returns a live handle', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-adopt-reconcile-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const profile = scopedProfile('launch', { projectPath: tempDir })
    const hostKey = deriveOpenCodeScopedHostKey(profile)
    let healthCalls = 0
    const adoptionHealthStarted = createDeferred<void>()
    const releaseAdoptionHealth = createDeferred<void>()
    const killed: number[] = []
    const deps = () => ({
      allocateLoopbackPort: async () => 44113,
      spawnHostProcess: () => createMockChildProcess(44113).child,
      fetchJson: async (url: string) => {
        if (url.endsWith('/global/health')) {
          healthCalls += 1
          if (healthCalls === 2) {
            adoptionHealthStarted.resolve()
            await releaseAdoptionHealth.promise
          }
          return { status: 200, data: { healthy: true } }
        }
        return { status: 200, data: {} }
      },
      isProcessAlive: (pid: number) => pid === 44113 && !killed.includes(pid),
      killProcess: (pid: number) => { killed.push(pid) },
      sleepMs: async () => {},
      now: () => new Date('2026-08-17T12:00:00.000Z'),
      persistentRegistryPath: registryPath,
    })
    try {
      const creator = new OpenCodeHostManager(deps())
      await creator.ensureScopedHost({ preparedProfile: profile, expectedHostKey: hostKey })
      const adopter = new OpenCodeHostManager(deps())
      const reconciler = new OpenCodeHostManager(deps())
      const adoption = adopter.ensureScopedHost({ preparedProfile: profile, expectedHostKey: hostKey })
      await adoptionHealthStarted.promise
      const reconciliation = reconciler.reconcilePersistentHosts({
        mode: 'stale', reason: 'manual',
      })
      releaseAdoptionHealth.resolve()
      const [handle, result] = await Promise.all([adoption, reconciliation])
      expect(handle.state).toBe('healthy')
      expect(adopter.getHost(hostKey)).toBe(handle)
      expect(result.hosts[0]?.action).toBe('kept_active')
      expect(killed).toEqual([])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('does not resurrect a stale record when PID birth changes during adoption/reconciliation', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-adopt-stale-'))
    const registryPath = path.join(tempDir, 'registry.json')
    const profile = scopedProfile('launch', { projectPath: tempDir })
    const hostKey = deriveOpenCodeScopedHostKey(profile)
    const creator = new OpenCodeHostManager({
      allocateLoopbackPort: async () => 44114,
      spawnHostProcess: () => createMockChildProcess(44114).child,
      fetchJson: async () => ({ status: 200, data: { healthy: true } }),
      isProcessAlive: () => true,
      readProcessStartTimeMs: async () => 100,
      sleepMs: async () => {},
      persistentRegistryPath: registryPath,
    })
    const adoptionProbeStarted = createDeferred<void>()
    const releaseAdoptionProbe = createDeferred<void>()
    let oldPidReads = 0
    let healthCalls = 0
    const adopter = new OpenCodeHostManager({
      allocateLoopbackPort: async () => 44115,
      spawnHostProcess: () => createMockChildProcess(44115).child,
      fetchJson: async () => {
        healthCalls += 1
        if (healthCalls === 1) {
          adoptionProbeStarted.resolve()
          await releaseAdoptionProbe.promise
        }
        return { status: 200, data: { healthy: true } }
      },
      isProcessAlive: () => true,
      readProcessStartTimeMs: async pid => {
        if (pid === 44115) return 300
        oldPidReads += 1
        return oldPidReads === 1 ? 100 : 200
      },
      sleepMs: async () => {},
      persistentRegistryPath: registryPath,
    })
    const reconciler = new OpenCodeHostManager({
      isProcessAlive: () => true,
      readProcessStartTimeMs: async pid => pid === 44115 ? 300 : 200,
      sleepMs: async () => {},
      persistentRegistryPath: registryPath,
    })
    try {
      await creator.ensureScopedHost({ preparedProfile: profile, expectedHostKey: hostKey })
      const adoption = adopter.ensureScopedHost({ preparedProfile: profile, expectedHostKey: hostKey })
      await adoptionProbeStarted.promise
      const reconciliation = reconciler.reconcilePersistentHosts({ mode: 'stale' })
      releaseAdoptionProbe.resolve()
      const [handle] = await Promise.all([adoption, reconciliation])
      const registry = JSON.parse(await readFile(registryPath, 'utf8'))
      expect(handle.pid).toBe(44115)
      expect(handle.state).toBe('healthy')
      expect(registry.hosts[hostKey].pid).toBe(44115)
      expect(registry.hosts[hostKey].processStartedAtMs).toBe(300)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

function createMockChildProcess(
  pid = 4242,
  exitOnSignal: NodeJS.Signals | null = 'SIGTERM',
): {
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
    exitCode: null,
    stdout,
    stderr,
    unref() {
      unrefCalls.push('child')
    },
    kill(signal?: NodeJS.Signals) {
      killedSignals.push(signal)
      if (signal === exitOnSignal) {
        Object.assign(emitter, { exitCode: 0 })
        emitter.emit('exit', 0, signal ?? null)
      }
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

async function statMode(filePath: string): Promise<number> {
  return (await stat(filePath)).mode
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
  test('every compatibility startup policy starts serve with zero catalog prewarm', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-startup-policy-'))
    const binaryPath = path.join(tempDir, 'opencode')
    const commandLogPath = path.join(tempDir, 'commands.log')
    const originalBinaryPath = process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH
    await writeFile(binaryPath, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$OPENCODE_TEST_COMMAND_LOG"\n')
    await chmod(binaryPath, 0o755)
    process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = binaryPath

    const profile: OpenCodePreparedProfile = {
      ...baseProfile,
      projectPath: tempDir,
      profileRootPath: path.join(tempDir, 'profile'),
      xdgCacheHome: path.join(tempDir, 'cache'),
      managedConfig: {
        ...baseProfile.managedConfig,
        plugin: ['opencode-kiro@0.4.0'],
      },
      env: { OPENCODE_TEST_COMMAND_LOG: commandLogPath },
    }
    const launchedPluginConfigs: unknown[] = []
    const createManager = () => new OpenCodeHostManager({
      prepareProfile: async () => profile,
      allocateLoopbackPort: async () => 43191,
      spawnHostProcess: launchedProfile => {
        launchedPluginConfigs.push(launchedProfile.managedConfig.plugin)
        return createMockChildProcess(43191).child
      },
      fetchJson: async url => {
        if (url.endsWith('/global/health')) {
          return { status: 200, data: { healthy: true, version: '1.4.0' } }
        }
        if (url.endsWith('/global/dispose')) {
          return { status: 200, data: { ok: true } }
        }
        throw new Error(`Unexpected URL ${url}`)
      },
      sleepMs: async () => {},
      persistentRegistryPath: null,
    })

    try {
      const liveManager = createManager()
      const liveHost = await liveManager.ensureHost({
        hostLifetime: 'process',
        resolveConfigFingerprint: false,
        managedPluginStartupPolicy: 'serve-startup',
      })
      expect(liveHost.state).toBe('healthy')
      expect(await readFile(commandLogPath, 'utf8').catch(() => '')).toBe('')
      expect(launchedPluginConfigs[0]).toEqual(['opencode-kiro@0.4.0'])
      await liveManager.releaseHost(liveHost.hostKey)

      const fullManager = createManager()
      const fullHost = await fullManager.ensureHost({
        hostLifetime: 'process',
        // Deprecated compatibility requests cannot turn startup into an
        // inventory/diagnostic probe.
        resolveConfigFingerprint: true,
        managedPluginStartupPolicy: 'catalog-prewarm',
      })
      expect(await readFile(commandLogPath, 'utf8').catch(() => '')).toBe('')
      await fullManager.releaseHost(fullHost.hostKey)
    } finally {
      if (originalBinaryPath === undefined) delete process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH
      else process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = originalBinaryPath
      await rm(tempDir, { recursive: true, force: true })
    }
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

  test('runs scoped hosts only from the immutable behavior mirror', () => {
    const profile = scopedProfile('launch')
    expect(buildOpenCodeHostSpawnOptions(profile, 'linux').cwd)
      .toBe(profile.executionProjectPath)
    expect(profile.executionProjectPath).not.toBe(profile.projectPath)
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

  test('builds a same-object native launcher command for both supported Windows architectures', async () => {
    const profile = scopedProfile('execution-probe')
    const verified = {
      profile,
      fileHandle: { fd: 17 },
      objectIdentity: { dev: '7', ino: '11', size: '13' },
      close: async () => {},
    } as never
    for (const architecture of ['x64', 'arm64']) {
      expect(buildOpenCodeVerifiedScopedHostCommand(
        profile, verified, 'win32', architecture, 'C:\\runtime\\opencode-catalog-launcher.exe',
      )).toEqual({
        binaryPath: 'C:\\runtime\\opencode-catalog-launcher.exe',
        args: [profile.binaryPath, '--verified-opencode-host-v1', '7', '11', '13',
          'serve', '--hostname', '127.0.0.1', '--port'],
        inheritedVerifiedFd: false,
      })
    }
    expect(() => buildOpenCodeVerifiedScopedHostCommand(
      profile, verified, 'win32', 'ia32', 'C:\\runtime\\opencode-catalog-launcher.exe',
    )).toThrow('unsupported')
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

  test('uses the owned child handle when process-scoped identity is unavailable', async () => {
    const spawned = createMockChildProcess(43141)
    const pidKillSignals: NodeJS.Signals[] = []
    let processAlive = true

    Object.assign(spawned.child, {
      kill(signal?: NodeJS.Signals) {
        spawned.killedSignals.push(signal)
        processAlive = false
        spawned.child.emit('exit', null, signal ?? null)
        return true
      },
    })

    const manager = new OpenCodeHostManager({
      prepareProfile: async () => baseProfile,
      allocateLoopbackPort: async () => 43141,
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
      readProcessStartTimeMs: async () => null,
      killProcess: (_pid, signal) => {
        pidKillSignals.push(signal)
      },
      sleepMs: async () => {},
      persistentRegistryPath: null,
    })

    const handle = await manager.ensureHost({ hostLifetime: 'process' })

    expect(handle.state).toBe('healthy')
    expect(handle.processStartedAtMs).toBeNull()
    expect(
      handle.diagnostics.some(message => message.includes('owned child process handle')),
    ).toBe(true)

    await manager.releaseHost(handle.hostKey)

    expect(spawned.killedSignals).toEqual(['SIGTERM'])
    expect(pidKillSignals).toEqual([])
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

  test('does not commit a pending waiter reference when abort wins pending resolution', async () => {
    const spawned = createMockChildProcess(43138)
    const controller = new AbortController()
    const manager = new OpenCodeHostManager({
      prepareProfile: async () => baseProfile,
      allocateLoopbackPort: async () => 43138,
      spawnHostProcess: () => spawned.child,
      fetchJson: async url => url.endsWith('/global/health')
        ? { status: 200, data: { healthy: true, version: '1.4.0' } }
        : { status: 200, data: {} },
      isProcessAlive: pid => pid === spawned.child.pid,
      persistentRegistryPath: null,
    })
    const first = manager.ensureHost({ hostKey: 'pending-abort-race', hostLifetime: 'process' })
    void first.then(() => controller.abort(new Error('controlled pending abort')))
    const waiter = manager.ensureHost({
      hostKey: 'pending-abort-race', hostLifetime: 'process', abortSignal: controller.signal,
    })
    const handle = await first
    await expect(waiter).rejects.toThrow('controlled pending abort')
    const tracked = (manager as unknown as { hosts: Map<string, { refCount: number }> }).hosts
    expect(tracked.get(handle.hostKey)?.refCount).toBe(1)
  })

  test('scopes disposal single-flight to the exact host generation', async () => {
    const children = [
      createMockChildProcess(43131),
      createMockChildProcess(43132),
      createMockChildProcess(43133),
    ]
    let nextPort = 43130
    let spawnCount = 0
    let disposeCount = 0
    const disposalUrls: string[] = []
    let firstDisposalEntered!: () => void
    const firstEntered = new Promise<void>(resolve => { firstDisposalEntered = resolve })
    let secondDisposalEntered!: () => void
    const secondEntered = new Promise<void>(resolve => { secondDisposalEntered = resolve })
    let allowFirstDisposal!: () => void
    const firstDisposalGate = new Promise<void>(resolve => { allowFirstDisposal = resolve })
    let allowSecondDisposal!: () => void
    const secondDisposalGate = new Promise<void>(resolve => { allowSecondDisposal = resolve })
    const manager = new OpenCodeHostManager({
      prepareProfile: async () => baseProfile,
      allocateLoopbackPort: async () => ++nextPort,
      spawnHostProcess: () => children[spawnCount++]!.child,
      fetchJson: async url => {
        if (url.endsWith('/global/health')) {
          return { status: 200, data: { healthy: true, version: '1.4.0' } }
        }
        if (url.endsWith('/global/dispose')) {
          disposeCount += 1
          disposalUrls.push(url)
          if (disposeCount === 1) {
            firstDisposalEntered()
            await firstDisposalGate
          } else if (disposeCount === 2) {
            secondDisposalEntered()
            await secondDisposalGate
          }
          return { status: 200, data: { ok: true } }
        }
        throw new Error(`Unexpected URL ${url}`)
      },
      isProcessAlive: () => false,
      sleepMs: async () => {},
      persistentRegistryPath: null,
    })

    const old = await manager.ensureHost({ hostKey: 'raced-host', hostLifetime: 'process' })
    const releasingOld = manager.releaseHost(old.hostKey)
    await firstEntered
    expect(manager.getHost(old.hostKey)?.state).toBe('disposed')

    let replacementSettled = false
    const replacementPromise = manager.ensureHost({
      hostKey: old.hostKey,
      hostLifetime: 'process',
    }).finally(() => { replacementSettled = true })
    await Bun.sleep(0)
    expect(replacementSettled).toBe(false)
    allowFirstDisposal()
    await releasingOld
    const replacement = await replacementPromise
    expect(replacement.pid).not.toBe(old.pid)
    expect(replacement.state).toBe('healthy')

    // A later generation is likewise retained until its own disposal settles.
    const releasingReplacement = manager.releaseHost(replacement.hostKey)
    await secondEntered
    expect(manager.getHost(replacement.hostKey)?.pid).toBe(replacement.pid)
    allowSecondDisposal()
    await releasingReplacement
    expect(disposeCount).toBe(2)
    expect(disposalUrls).toEqual([
      'http://127.0.0.1:43131/global/dispose',
      'http://127.0.0.1:43132/global/dispose',
    ])

    expect(spawnCount).toBe(2)
    expect(manager.getHost(old.hostKey)).toBeNull()
  })

  test('legacy catalog-style release retains the exact generation after rejection and retries', async () => {
    const stuck = createMockChildProcess(43134, null)
    const children = [stuck]
    let spawnCount = 0
    let firstDisposalEntered!: () => void
    const firstEntered = new Promise<void>(resolve => { firstDisposalEntered = resolve })
    const disposeUrls: string[] = []
    const manager = new OpenCodeHostManager({
      prepareProfile: async () => baseProfile,
      allocateLoopbackPort: async () => 43134 + spawnCount,
      spawnHostProcess: () => children[spawnCount++]!.child,
      fetchJson: async url => {
        if (url.endsWith('/global/health')) {
          return { status: 200, data: { healthy: true, version: '1.4.0' } }
        }
        if (url.endsWith('/global/dispose')) {
          disposeUrls.push(url)
          if (disposeUrls.length === 1) firstDisposalEntered()
          return { status: 200, data: { ok: true } }
        }
        throw new Error(`Unexpected URL ${url}`)
      },
      isProcessAlive: pid => children.some(({ child }) =>
        child.pid === pid && child.exitCode === null),
      sleepMs: async () => {},
      persistentRegistryPath: null,
    })

    const old = await manager.ensureHost({ hostKey: 'failed-disposal', hostLifetime: 'process' })
    const releasingOld = manager.releaseHost(old.hostKey)
    await firstEntered
    await expect(releasingOld).rejects.toThrow('did not exit through its owned child handle')
    expect(manager.getHost(old.hostKey)?.pid).toBe(old.pid)
    expect(disposeUrls).toEqual(['http://127.0.0.1:43134/global/dispose'])
    expect(stuck.killedSignals).toEqual(['SIGTERM', 'SIGKILL'])
    // A concurrent ensure after the rejected disposal must retain the original
    // catalog/probe entry. It may add a reference, but it cannot manufacture a
    // replacement generation and strand the original release authority.
    const concurrent = await manager.ensureHost({ hostKey: old.hostKey, hostLifetime: 'process' })
    expect(concurrent.pid).toBe(old.pid)
    expect(spawnCount).toBe(1)
    Object.assign(stuck.child, { exitCode: 0 })
    // Retry the original release, then release the concurrent reference. The
    // physical retry must still target the exact original endpoint.
    await manager.releaseHost(old.hostKey)
    await manager.releaseHost(old.hostKey)
    expect(disposeUrls).toEqual([
      'http://127.0.0.1:43134/global/dispose',
      'http://127.0.0.1:43134/global/dispose',
    ])
    expect(spawnCount).toBe(1)
    expect(manager.getHost(old.hostKey)).toBeNull()
  })

  test('force-kills an owned host that survives release SIGTERM', async () => {
    const spawned = createMockChildProcess(4242, 'SIGKILL')
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

  test('keeps compatibility startup health-only unless diagnostics explicitly request probing', async () => {
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
    expect(handle.resolvedConfigFingerprint).toBe(baseProfile.managedConfigFingerprint)
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

    expect(Object.isFrozen(handle)).toBe(true)
    expect(handle.state).toBe('healthy')
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
      const created = await firstManager.ensureHost({
        hostKey: 'host-key', resolveConfigFingerprint: true,
      })

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
      const adopted = await secondManager.ensureHost({
        hostKey: 'host-key', resolveConfigFingerprint: true,
      })

      expect(spawnCount).toBe(1)
      expect(reconciliation.hosts[0]).toMatchObject({ action: 'kept_active' })
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

  test('retains a reused registry pid tombstone while original containment remains live', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-host-registry-'))
    const registryPath = path.join(tempDir, 'host-registry.json')
    const fetchUrls: string[] = []
    const killedSignals: NodeJS.Signals[] = []

    try {
      await writeFile(
        registryPath,
        JSON.stringify({
          schemaVersion: 2,
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
        isProcessGroupAlive: pid => pid === 43114,
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

      expect(result.cleaned).toBe(0)
      expect(result.hosts[0]).toMatchObject({
        action: 'failed',
        reason: 'leader exited during identity verification but containment remains unproven',
      })
      expect(fetchUrls).toEqual([])
      expect(killedSignals).toEqual([])
      await expect(readFile(registryPath, 'utf8')).resolves.toContain('host-key')
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
            schemaVersion: 2,
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
          isProcessGroupAlive: pid => pid === 43141 && processAlive,
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
          schemaVersion: 2,
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
        isProcessGroupAlive: pid => pid === 43114,
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
        'containment cleanup is incomplete',
      )
      expect(fetchUrls).toEqual(['http://127.0.0.1:43114/global/health'])
      await expect(readFile(registryPath, 'utf8')).resolves.toContain('host-key')
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
          schemaVersion: 2,
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
          schemaVersion: 2,
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
        isProcessGroupAlive: pid => pid === 43115,
        readProcessStartTimeMs: async () => 1_000,
        killProcess: (_pid, signal) => {
          killedSignals.push(signal)
        },
        sleepMs: async () => {},
        persistentRegistryPath: registryPath,
      })

      await expect(manager.ensureHost({ hostKey: 'host-key' })).rejects.toThrow(
        'pid 43115 containment remained alive or unproven after cleanup',
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
      expect(host.pid).toBe(43133)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('force-kills a spawned host when startup verification fails', async () => {
    const spawned = createMockChildProcess(43134)
    const killedSignals: Array<{ pid: number; signal: NodeJS.Signals }> = []
    let nowMs = 0
    let healthCalls = 0
    let processAlive = true

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
      isProcessAlive: pid => pid === spawned.child.pid && processAlive,
      isProcessGroupAlive: pid => pid === spawned.child.pid && processAlive,
      killProcess: (pid, signal) => {
        killedSignals.push({ pid, signal })
        if (signal === 'SIGKILL') processAlive = false
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
    expect(thrown).toMatchObject({ cleanupDisposition: 'complete', cleanupIncomplete: false })
    expect(message).toContain('OpenCode host did not become healthy')
    expect(message).toContain('stdout: server booting')
    expect(message).toContain('stderr: waiting for config')

    expect(manager.getHost('host-key')).toBeNull()
    expect(killedSignals).toEqual([
      { pid: 43134, signal: 'SIGTERM' },
      { pid: 43134, signal: 'SIGKILL' },
    ])
  })

  test('failed startup reports incomplete cleanup when TERM exits leader but descendant survives', async () => {
    const spawned = createMockChildProcess(43_135)
    let leaderAlive = true
    let descendantAlive = true
    const signals: NodeJS.Signals[] = []
    const manager = new OpenCodeHostManager({
      prepareProfile: async () => baseProfile,
      allocateLoopbackPort: async () => 43_135,
      spawnHostProcess: () => spawned.child,
      fetchJson: async url => url.endsWith('/global/health')
        ? { status: 503, data: { healthy: false } }
        : { status: 200, data: {} },
      isProcessAlive: pid => pid === 43_135 && leaderAlive,
      isProcessGroupAlive: pid => pid === 43_135 && (leaderAlive || descendantAlive),
      killProcess: (_pid, signal) => { signals.push(signal); leaderAlive = false },
      sleepMs: async () => {},
      persistentRegistryPath: null,
    })

    const failure = manager.ensureHost({ hostKey: 'failed-startup', healthTimeoutMs: 1 })
    await expect(failure).rejects.toMatchObject({ cleanupIncomplete: true })
    expect(signals).toEqual(['SIGTERM'])
    expect(descendantAlive).toBe(true)
    descendantAlive = false
  })

  test('uses a caller-provided host health timeout during startup verification', async () => {
    const spawned = createMockChildProcess(43136)
    const killedSignals: Array<{ pid: number; signal: NodeJS.Signals }> = []
    let nowMs = 0
    let processAlive = true

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
      isProcessAlive: pid => pid === spawned.child.pid && processAlive,
      isProcessGroupAlive: pid => pid === spawned.child.pid && processAlive,
      killProcess: (pid, signal) => {
        killedSignals.push({ pid, signal })
        if (signal === 'SIGKILL') processAlive = false
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

  test('fails closed before spawn when the persistent registry is unreadable', async () => {
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
      expect(killedSignals).toEqual([])
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
    expect(spawned.killedSignals).toEqual(['SIGTERM'])
    expect(killedSignals).toEqual([])
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
          schemaVersion: 2,
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
          schemaVersion: 2,
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
        isProcessGroupAlive: () => false,
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
      await writeFile(registryPath, JSON.stringify({ schemaVersion: 2, hosts: {} }), { mode: 0o600 })
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
          schemaVersion: 2,
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
        isProcessGroupAlive: pid => pid === 43116 && processAlive,
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
          schemaVersion: 2,
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
          schemaVersion: 2,
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
        isProcessGroupAlive: pid => alivePids.has(pid),
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
          schemaVersion: 2,
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
        isProcessGroupAlive: pid => pid === 43118 && processAlive,
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
          schemaVersion: 2,
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
        isProcessGroupAlive: pid => pid === 43118,
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
      expect(result.hosts[0]?.reason).toContain('pid 43118 containment remained alive')
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

    const handle = await manager.ensureHost({
      hostKey: 'host-key', resolveConfigFingerprint: true,
    })
    expect(handle.resolvedConfigFingerprint).toBe(baseProfile.managedConfigFingerprint)
    const initialFingerprint = await manager.refreshResolvedConfigFingerprint('host-key')
    phase = 'refresh'
    const refreshedFingerprint = await manager.refreshResolvedConfigFingerprint('host-key')

    expect(initialFingerprint).not.toBeNull()
    expect(refreshedFingerprint).toBe(initialFingerprint)
  })

  test('preserves the previous resolved fingerprint when refresh probing fails', async () => {
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
          throw new Error('fingerprint refresh unavailable')
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
    expect(refreshedFingerprint).toBe(initialFingerprint)
    expect(manager.getHost('host-key')?.resolvedConfigFingerprint).toBe(initialFingerprint)
  })
})
