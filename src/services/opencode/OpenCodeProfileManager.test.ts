import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, mock, setDefaultTimeout, test } from 'bun:test'

import {
  buildManagedConfig,
  buildManagedConfigFingerprint,
  collectProjectBehaviorMetadata,
  ensureOpenCodeCursorPluginAuthCredential,
  ensureOpenCodeKiroPluginAuthCredential,
  ensureOpenCodeNativeCliCredentialBridge,
  fingerprintOpenCodeScopedInheritedEnvironment,
  ensureOpenCodeManagedDirectoryPath,
  isOpenCodeManagedPathComponentOwnershipValid,
  isKiroCliWhoamiAuthenticated,
  resolveOpenCodeNativeAccountIdentity,
  OpenCodeProfileManager,
  planScopedProfile,
  probeNativeCredentialIdentity,
  orderOpenCodeAuthSyncSources,
  publishOpenCodeProjectBehaviorSnapshotForTest,
  revalidateOpenCodeScopedPreparedProfileInputs,
} from './OpenCodeProfileManager.js'
import { resolveOpenCodeAppMcpLaunchConfig } from './OpenCodeMcpManager.js'
import { applyOpenCodeAutoUpdatePolicy } from './OpenCodeAutoUpdatePolicy.js'
import {
  readOpenCodeAuthCredential,
  upsertOpenCodeAuthCredential,
} from './OpenCodeAuthStore.js'
import {
  setOpenCodeManagedDefaultModel,
  setOpenCodeManagedGlobalDefaultModel,
  setOpenCodeManagedModelLimits,
} from './OpenCodeManagedPreferences.js'
import {
  CLAUDE_MULTIMODEL_CACHE_HOME_ENV,
  CLAUDE_MULTIMODEL_DATA_HOME_ENV,
} from './OpenCodeManagedPaths.js'
import { canonicalSerializeOpenCodePolicyIdentity } from './OpenCodeOperationPolicy.js'
import { OpenCodeHostManager } from './OpenCodeHostManager.js'
import { prepareOpenCodeProviderCatalogProductionProfile } from './OpenCodeProviderCatalogProduction.js'
import {
  authorizeOpenCodeLaunchScopedProfile,
  prepareAuthorizedOpenCodeLaunchScopedProfile,
} from './OpenCodePlanScopedProfile.js'

const pureDigest = (value: string): string => createHash('sha256').update(value).digest('hex')
const fakePluginTree = [{
  path: 'opencode-kiro/package.json',
  bytesBase64: Buffer.from('{"name":"opencode-kiro","version":"0.4.0"}').toString('base64'),
  mode: 0o400 as const,
}]
const fakePluginTreeFingerprint = pureDigest(canonicalSerializeOpenCodePolicyIdentity(fakePluginTree.map(entry => ({
  path: entry.path,
  mode: entry.mode,
  fingerprint: pureDigest(Buffer.from(entry.bytesBase64, 'base64').toString()),
}))))
const fakeResolvedIdentity = (
  version: string,
  treeFingerprint: string,
  manifestBytes: string,
  packageName = 'opencode-kiro',
): string => {
  const packageIntegrity = `sha512-${createHash('sha512')
    .update(treeFingerprint)
    .digest('base64')}`
  return `sha256:${pureDigest(canonicalSerializeOpenCodePolicyIdentity({
    packageName,
    version,
    packageIntegrity,
    manifestFingerprint: pureDigest(manifestBytes),
    dependencyTreeFingerprint: treeFingerprint,
  }))}`
}

describe('pure planScopedProfile contract', () => {
  const evidence = () => ({
    canonicalProjectPathFingerprint: pureDigest('project-path'),
    projectBehaviorFingerprint: pureDigest('project-behavior'),
    providerEnvironmentFingerprint: pureDigest('provider-environment'),
    selectedAuthFingerprint: pureDigest('selected-auth'),
    binaryFingerprint: pureDigest('binary'),
    configFingerprint: pureDigest('config'),
    nativeAccountIdentityFingerprint: pureDigest('official-account-id'),
    nativeAccountIdentitySource: 'official-provider-cli' as const,
    nativeTargetExecutableFingerprint: pureDigest('native-binary'),
    profileLayoutFingerprint: pureDigest('layout'),
    plugins: [{
      spec: 'opencode-kiro@0.4.0',
      provenance: 'app-managed' as const,
      dependencyTreeFingerprint: fakePluginTreeFingerprint,
      resolvedIdentity: fakeResolvedIdentity(
        '0.4.0', fakePluginTreeFingerprint, '{"name":"opencode-kiro","version":"0.4.0"}',
      ),
      immutableTreeEntries: fakePluginTree,
    }],
  })
  const input = () => ({
    purpose: 'provider-catalog' as const,
    providerId: 'kiro',
    runtimeInstanceId: 'runtime-a',
    projectPath: '/never-read-by-pure-planner',
    evidence: evidence(),
  })

  test('is deterministic, runtime-instance independent, redacted, and side-effect free', () => {
    const before = { ...process.env }
    const first = planScopedProfile(input())
    const second = planScopedProfile({ ...input(), runtimeInstanceId: 'runtime-b' })
    expect(second).toEqual(first)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.plugins)).toBe(true)
    expect(first.expectedHostKey).toMatch(/^opencode-host-v2:[a-f0-9]{64}$/)
    expect(process.env).toEqual(before)
    const serialized = JSON.stringify(first)
    expect(serialized).not.toContain('/never-read-by-pure-planner')
    expect(serialized).not.toContain('runtime-a')
  })

  test('every planning identity mutation changes the digest', () => {
    const baseline = planScopedProfile(input()).digest
    const mutations = [
      { canonicalProjectPathFingerprint: pureDigest('other-project') },
      { projectBehaviorFingerprint: pureDigest('other-behavior') },
      { providerEnvironmentFingerprint: pureDigest('rotated-env') },
      { selectedAuthFingerprint: pureDigest('rotated-auth') },
      { binaryFingerprint: pureDigest('other-binary') },
      { configFingerprint: pureDigest('other-config') },
      { nativeAccountIdentityFingerprint: pureDigest('other-account') },
      { nativeTargetExecutableFingerprint: pureDigest('other-native-binary') },
      { profileLayoutFingerprint: pureDigest('other-layout') },
    ]
    for (const mutation of mutations) {
      expect(planScopedProfile({
        ...input(), evidence: { ...evidence(), ...mutation },
      }).digest).not.toBe(baseline)
    }
    const changedManifest = '{"name":"opencode-kiro","version":"0.4.0","fixture":true}'
    const changedTreeFingerprint = pureDigest(canonicalSerializeOpenCodePolicyIdentity([{
      path: fakePluginTree[0].path,
      mode: fakePluginTree[0].mode,
      fingerprint: pureDigest(changedManifest),
    }]))
    expect(planScopedProfile({
      ...input(), evidence: {
        ...evidence(),
        plugins: [{
          ...evidence().plugins[0]!,
          spec: 'opencode-kiro@0.4.0',
          immutableTreeEntries: [{
            ...fakePluginTree[0],
            bytesBase64: Buffer.from(changedManifest).toString('base64'),
          }],
          dependencyTreeFingerprint: changedTreeFingerprint,
          resolvedIdentity: fakeResolvedIdentity('0.4.0', changedTreeFingerprint, changedManifest),
        }],
      },
    }).digest).not.toBe(baseline)
  })

  test('rejects mutable specifiers and fails closed for unavailable package/account evidence', () => {
    expect(() => planScopedProfile({
      ...input(), evidence: {
        ...evidence(), plugins: [{ ...evidence().plugins[0]!, spec: 'opencode-kiro@latest' }],
      },
    })).toThrow('exact registry package version')
    expect(() => planScopedProfile({
      ...input(), evidence: { ...evidence(), plugins: [] },
    })).toThrow('immutable evidence is unavailable')
    expect(() => planScopedProfile({
      ...input(), evidence: {
        ...evidence(), nativeAccountIdentityFingerprint: 'not-definitive',
      },
    })).toThrow('canonical native account identity evidence')
    expect(() => planScopedProfile({
      ...input(), evidence: {
        ...evidence(), nativeAccountIdentitySource: 'managed-auth',
      },
    })).toThrow('official stable account identity')
  })

  test('prepare rejects expected-plan drift before any async preparation', async () => {
    const manager = new OpenCodeProfileManager()
    const plannedInput = input()
    const expected = planScopedProfile(plannedInput)
    await expect(manager.prepareScopedProfile(
      { ...plannedInput, evidence: { ...plannedInput.evidence, binaryFingerprint: pureDigest('drift') } },
      expected,
    )).rejects.toThrow('expected plan mismatch')
  })
})

async function createScopedTestManager(tempDir: string): Promise<{
  manager: OpenCodeProfileManager
  binaryPath: string
  restore: () => void
}> {
  const previous = { ...process.env }
  const binaryPath = path.join(tempDir, 'opencode-test-bin')
  await writeFile(binaryPath, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  process.env.CLAUDE_MULTIMODEL_DATA_HOME = path.join(tempDir, 'app-data')
  process.env.CLAUDE_MULTIMODEL_CACHE_HOME = path.join(tempDir, 'app-cache')
  process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = binaryPath
  process.env.HOME = path.join(tempDir, 'home')
  process.env.USERPROFILE = process.env.HOME
  process.env.XDG_CONFIG_HOME = path.join(tempDir, 'user-config')
  process.env.XDG_DATA_HOME = path.join(tempDir, 'user-data')
  const nativeBinPath = path.join(tempDir, 'fake-native-bin')
  await mkdir(nativeBinPath, { recursive: true })
  await writeFile(
    path.join(nativeBinPath, 'kiro-cli'),
    '#!/bin/sh\necho kiro >> "$FAKE_NATIVE_PROBE_LOG"\nprintf \'{"accountType":"Builder ID","userId":"fake-kiro-account"}\\n\'\n',
    { mode: 0o700 },
  )
  await writeFile(
    path.join(nativeBinPath, 'cursor-agent'),
    '#!/bin/sh\necho cursor >> "$FAKE_NATIVE_PROBE_LOG"\nprintf \'Logged in\\n{"userId":"fake-cursor-account"}\\n\'\n',
    { mode: 0o700 },
  )
  process.env.FAKE_NATIVE_PROBE_LOG = path.join(tempDir, 'native-probes.log')
  process.env.PATH = `${nativeBinPath}${path.delimiter}${previous.PATH ?? ''}`
  delete process.env.OPENCODE_CONFIG
  delete process.env.OPENCODE_CONFIG_CONTENT
  return {
    manager: new OpenCodeProfileManager(),
    binaryPath,
    restore: () => {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) delete process.env[key]
      }
      Object.assign(process.env, previous)
    },
  }
}

async function buildDeepinfraPlannedInput(
  fixture: { binaryPath: string },
  projectPath: string,
  plugins: Array<{
    spec: string
    provenance: 'user' | 'project' | 'environment' | 'app-managed'
    dependencyTreeFingerprint: string
    resolvedIdentity: string
    immutableTreeEntries: Array<{ path: string, bytesBase64: string, mode: 0o400 | 0o500 }>
  }> = [],
  options: {
    purpose?: 'provider-catalog' | 'launch' | 'session-resume'
    modelId?: string | null
  } = {},
) {
  const canonicalFingerprint = (value: unknown): string => pureDigest(
    canonicalSerializeOpenCodePolicyIdentity(value),
  )
  const behavior = await collectProjectBehaviorMetadata(projectPath)
  const purpose = options.purpose ?? 'provider-catalog'
  const modelId = options.modelId ?? (purpose === 'provider-catalog' ? null : 'deepinfra/model')
  const appMcpConfig = purpose === 'provider-catalog'
    ? null
    : await resolveOpenCodeAppMcpLaunchConfig().then(result => result.config).catch(() => null)
  const managedConfig = buildManagedConfig(appMcpConfig, {
    allowAutoUpdate: false,
    defaultModelId: modelId,
    toolApprovalMode: purpose === 'provider-catalog' ? undefined : 'auto',
  })
  managedConfig.provider = {}
  managedConfig.plugin = plugins.map(plugin => {
    const packageName = plugin.spec.startsWith('@')
      ? plugin.spec.slice(0, plugin.spec.indexOf('@', 1))
      : plugin.spec.split('@')[0]!
    return `file:./node_modules/${packageName}`
  })
  if (purpose === 'provider-catalog') {
    managedConfig.agent = Object.fromEntries(
      Object.entries(managedConfig.agent as Record<string, unknown>).map(([name, value]) => [
        name,
        {
          ...(value as Record<string, unknown>),
          tools: { '*': false },
          permission: { '*': 'deny' },
        },
      ]),
    )
  }
  return {
    purpose,
    providerId: 'deepinfra',
    modelId,
    runtimeInstanceId: purpose === 'provider-catalog' ? 'catalog-g1-planned' : 'planned',
    projectPath,
    evidence: {
      canonicalProjectPathFingerprint: canonicalFingerprint(await realpath(projectPath)),
      projectBehaviorFingerprint: behavior.projectBehaviorFingerprint,
      providerEnvironmentFingerprint: canonicalFingerprint({
        inherited: fingerprintOpenCodeScopedInheritedEnvironment(process.env),
        nativeBridgeInputs: canonicalFingerprint(null),
        finalEnvironmentInputs: {
          npmConfigCache: path.join(process.env.CLAUDE_MULTIMODEL_CACHE_HOME!, 'opencode', 'package-downloads'),
          multimodelDataHome: process.env.CLAUDE_MULTIMODEL_DATA_HOME,
          multimodelCacheHome: process.env.CLAUDE_MULTIMODEL_CACHE_HOME,
          disableAutoUpdate: applyOpenCodeAutoUpdatePolicy({ ...process.env })
            .OPENCODE_DISABLE_AUTOUPDATE ?? null,
        },
      }),
      selectedAuthFingerprint: canonicalFingerprint({}),
      binaryFingerprint: pureDigest((await readFile(fixture.binaryPath)).toString()),
      configFingerprint: buildManagedConfigFingerprint(managedConfig),
      nativeAccountIdentityFingerprint: canonicalFingerprint(null),
      nativeAccountIdentitySource: 'managed-auth' as const,
      nativeTargetExecutableFingerprint: canonicalFingerprint(null),
      profileLayoutFingerprint: canonicalFingerprint('1'),
      plugins,
    },
  }
}

describe('OpenCodeProfileManager immutable planned preparation', () => {
  test('Windows read-only capture composes through production catalog and launch planning without effects', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-windows-current-plan-'))
    const fixture = await createScopedTestManager(tempDir)
    const manager = new OpenCodeProfileManager('win32')
    try {
      await writeFile(path.join(tempDir, 'AGENTS.md'), 'windows scoped behavior\n')
      const catalogInput = {
        purpose: 'provider-catalog' as const,
        providerId: 'deepinfra',
        runtimeInstanceId: 'catalog-g1-windows-attempt',
        projectPath: tempDir,
      }
      let catalogPrepared = false
      await prepareOpenCodeProviderCatalogProductionProfile({
        captureCurrentScopedProfilePlan: input => manager.captureCurrentScopedProfilePlan(input),
        planScopedProfile: input => manager.planScopedProfile(input),
        prepareScopedProfile: async current => {
          catalogPrepared = true
          expect(current.evidence.projectBehaviorFingerprint).toMatch(/^[a-f0-9]{64}$/)
          return current as never
        },
      }, catalogInput)
      expect(catalogPrepared).toBe(true)

      const launch = await authorizeOpenCodeLaunchScopedProfile(manager, {
        purpose: 'launch',
        providerId: 'deepinfra',
        modelId: 'deepinfra/model',
        runtimeInstanceId: 'windows-launch-attempt',
        projectPath: tempDir,
      })
      expect(launch.expected.projectBehaviorFingerprint).toMatch(/^[a-f0-9]{64}$/)
      expect(launch.expected.purpose).toBe('launch')
      expect(await lstat(process.env.CLAUDE_MULTIMODEL_DATA_HOME!).catch(() => null)).toBeNull()
      expect(await lstat(process.env.FAKE_NATIVE_PROBE_LOG!).catch(() => null)).toBeNull()

      const firstUseCatalog = await prepareOpenCodeProviderCatalogProductionProfile(manager, {
        ...catalogInput,
        runtimeInstanceId: 'catalog-g1-windows-first-use',
      })
      expect(firstUseCatalog.scopeSchema).toBe('opencode-scoped-profile-v1')
      expect((await lstat(firstUseCatalog.profileRootPath)).isDirectory()).toBe(true)
      const firstUseLaunchAuthorization = await authorizeOpenCodeLaunchScopedProfile(manager, {
        purpose: 'launch', providerId: 'deepinfra', modelId: 'deepinfra/model',
        runtimeInstanceId: 'windows-first-use-launch', projectPath: tempDir,
      })
      const firstUseLaunch = await prepareAuthorizedOpenCodeLaunchScopedProfile(
        manager, firstUseLaunchAuthorization,
      )
      expect(firstUseLaunch.purpose).toBe('launch')
      expect((await lstat(firstUseLaunch.xdgCacheHome)).isDirectory()).toBe(true)

      const localAppData = path.join(tempDir, 'LocalAppData')
      await mkdir(localAppData)
      delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      process.env.LOCALAPPDATA = localAppData
      const nestedFirstUseManager = new OpenCodeProfileManager('win32')
      const nestedCatalog = await prepareOpenCodeProviderCatalogProductionProfile(
        nestedFirstUseManager,
        { ...catalogInput, runtimeInstanceId: 'catalog-g1-windows-nested-env-paths' },
      )
      expect(nestedCatalog.profileRootPath).toStartWith(path.join(
        localAppData, 'claude-multimodel-nodejs', 'Data',
      ))
      const nestedLaunchAuthorization = await authorizeOpenCodeLaunchScopedProfile(
        nestedFirstUseManager,
        { purpose: 'launch', providerId: 'deepinfra', modelId: 'deepinfra/model',
          runtimeInstanceId: 'windows-nested-env-paths-launch', projectPath: tempDir },
      )
      const nestedLaunch = await prepareAuthorizedOpenCodeLaunchScopedProfile(
        nestedFirstUseManager, nestedLaunchAuthorization,
      )
      expect(nestedLaunch.xdgCacheHome).toStartWith(path.join(
        localAppData, 'claude-multimodel-nodejs', 'Cache',
      ))
    } finally {
      fixture.restore()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('Windows read-only behavior capture rejects a reparse-aware ambiguous path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-windows-reparse-'))
    const project = path.join(root, 'project')
    const outside = path.join(root, 'outside')
    try {
      await Promise.all([mkdir(project), mkdir(outside)])
      await writeFile(path.join(outside, 'AGENTS.md'), 'must not be captured\n')
      await symlink(outside, path.join(project, '.opencode'))
      await expect(collectProjectBehaviorMetadata(project, 'win32'))
        .rejects.toThrow(/reparse point|canonical/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('production catalog composition captures current evidence through the actual manager and policy', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-current-catalog-plan-'))
    const fixture = await createScopedTestManager(tempDir)
    try {
      const prepared = await prepareOpenCodeProviderCatalogProductionProfile(fixture.manager, {
        purpose: 'provider-catalog', providerId: 'deepinfra', runtimeInstanceId: 'catalog-g1-attempt-a',
        projectPath: tempDir,
      })
      expect(prepared.providerId).toBe('deepinfra')
      expect(prepared.purpose).toBe('provider-catalog')
      expect(prepared.scopedPlanDigest).toMatch(/^[a-f0-9]{64}$/)

      const launchAuthorization = await authorizeOpenCodeLaunchScopedProfile(fixture.manager, {
        purpose: 'launch', providerId: 'deepinfra', modelId: 'deepinfra/model',
        runtimeInstanceId: 'launch-attempt-a', projectPath: tempDir,
      })
      expect(launchAuthorization.expected.purpose).toBe('launch')
      expect(launchAuthorization.input.runtimeInstanceId).toBe('launch-attempt-a')
      expect(launchAuthorization.effectivePlanDigest).toMatch(/^[a-f0-9]{64}$/)

      const first = await fixture.manager.captureCurrentScopedProfilePlan({
        purpose: 'provider-catalog', providerId: 'deepinfra', runtimeInstanceId: 'catalog-g2-attempt-b',
        projectPath: tempDir,
      })
      await writeFile(path.join(tempDir, 'AGENTS.md'), 'fresh attempt evidence\n')
      const second = await fixture.manager.captureCurrentScopedProfilePlan({
        purpose: 'provider-catalog', providerId: 'deepinfra', runtimeInstanceId: 'catalog-g3-attempt-c',
        projectPath: tempDir,
      })
      expect(fixture.manager.planScopedProfile(second).digest)
        .not.toBe(fixture.manager.planScopedProfile(first).digest)
      await expect(fixture.manager.prepareScopedProfile(first, fixture.manager.planScopedProfile(first)))
        .rejects.toThrow('evidence drifted')
    } finally {
      fixture.restore()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('actual production manager preserves and prepares a DeepInfra user plugin', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-current-deepinfra-plugin-'))
    const fixture = await createScopedTestManager(tempDir)
    try {
      await writeFile(path.join(tempDir, 'opencode.json'), JSON.stringify({
        plugin: ['ordinary-user-choice@1.2.3'],
      }))
      const packageRoot = path.join(
        process.env.CLAUDE_MULTIMODEL_CACHE_HOME!,
        'opencode', 'shared-cache', 'opencode', 'packages', 'ordinary-user-choice@1.2.3',
      )
      await mkdir(packageRoot, { recursive: true })
      await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
        name: 'ordinary-user-choice', version: '1.2.3',
      }))
      await writeFile(path.join(packageRoot, 'index.js'), 'export default {}\n')

      const current = await fixture.manager.captureCurrentScopedProfilePlan({
        purpose: 'provider-catalog', providerId: 'deepinfra',
        runtimeInstanceId: 'catalog-g1-deepinfra-user-plugin-attempt', projectPath: tempDir,
      })
      expect(current.evidence.plugins.map(plugin => [plugin.spec, plugin.provenance])).toEqual([
        ['ordinary-user-choice@1.2.3', 'project'],
      ])
      const expected = fixture.manager.planScopedProfile(current)
      const prepared = await fixture.manager.prepareScopedProfile(current, expected)
      expect(prepared.policy.plugins).toEqual([{
        spec: 'ordinary-user-choice@1.2.3',
        packageName: 'ordinary-user-choice',
        provenance: 'project',
      }])
      expect(prepared.managedConfig.plugin).toEqual([
        'file:./node_modules/ordinary-user-choice',
      ])
    } finally {
      fixture.restore()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('production planning resolves ordinary mutable specs only from verified local trees', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-current-mutable-plugins-'))
    const fixture = await createScopedTestManager(tempDir)
    const packagesRoot = path.join(
      process.env.CLAUDE_MULTIMODEL_CACHE_HOME!,
      'opencode', 'shared-cache', 'opencode', 'packages',
    )
    const urlSpec = 'https://plugins.example.invalid/releases/url-plugin.tgz'
    const writeResolved = async (
      directory: string, name: string, version: string, source?: string,
    ): Promise<void> => {
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, 'package.json'), JSON.stringify({
        name, version, ...(source ? { opencodeSpec: source } : {}),
      }))
      await writeFile(path.join(directory, 'index.js'), `export default ${JSON.stringify(name)}\n`)
    }
    try {
      await mkdir(path.join(process.env.XDG_CONFIG_HOME!, 'opencode'), { recursive: true })
      await writeFile(
        path.join(process.env.XDG_CONFIG_HOME!, 'opencode', 'opencode.json'),
        JSON.stringify({ plugin: ['user-plugin'] }),
      )
      await writeFile(path.join(tempDir, 'opencode.json'), JSON.stringify({
        plugin: ['tag-plugin@latest', 'file:./resolved/file-plugin', urlSpec],
      }))
      process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ plugin: ['environment-plugin@next'] })
      await writeResolved(path.join(packagesRoot, 'installed-user'), 'user-plugin', '1.0.0')
      await writeResolved(path.join(packagesRoot, 'installed-tag'), 'tag-plugin', '2.0.0')
      await writeResolved(path.join(packagesRoot, 'installed-env'), 'environment-plugin', '3.0.0')
      await writeResolved(path.join(packagesRoot, 'installed-url'), 'url-plugin', '4.0.0', urlSpec)
      await writeResolved(path.join(tempDir, 'resolved', 'file-plugin'), 'file-plugin', '5.0.0')

      const current = await fixture.manager.captureCurrentScopedProfilePlan({
        purpose: 'provider-catalog', providerId: 'deepinfra',
        runtimeInstanceId: 'mutable-plugin-attempt', projectPath: tempDir,
      })
      expect(current.evidence.plugins.map(plugin =>
        [plugin.spec, plugin.packageName, plugin.provenance])).toEqual([
        ['user-plugin', 'user-plugin', 'user'],
        ['tag-plugin@latest', 'tag-plugin', 'project'],
        ['file:./resolved/file-plugin', 'file-plugin', 'project'],
        [urlSpec, 'url-plugin', 'project'],
        ['environment-plugin@next', 'environment-plugin', 'environment'],
      ])
      const firstExpected = fixture.manager.planScopedProfile(current)
      await writeFile(path.join(packagesRoot, 'installed-tag', 'index.js'), 'export default "changed"\n')
      const changedCurrent = await fixture.manager.captureCurrentScopedProfilePlan({
        purpose: 'provider-catalog', providerId: 'deepinfra',
        runtimeInstanceId: 'catalog-g2-mutable-plugin-changed-attempt', projectPath: tempDir,
      })
      const expected = fixture.manager.planScopedProfile(changedCurrent)
      expect(expected.digest).not.toBe(firstExpected.digest)
      const prepared = await fixture.manager.prepareScopedProfile(changedCurrent, expected)
      expect(prepared.managedConfig.plugin).toEqual([
        'file:./node_modules/user-plugin',
        'file:./node_modules/tag-plugin',
        'file:./node_modules/file-plugin',
        'file:./node_modules/url-plugin',
        'file:./node_modules/environment-plugin',
      ])
      for (const plugin of expected.plugins) {
        expect(await readFile(
          path.join(prepared.pluginNodeModulesPath, plugin.packageName, 'package.json'), 'utf8',
        )).toContain(`"name":"${plugin.packageName}"`)
      }
    } finally {
      fixture.restore()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('production mutable plugin capture rejects unresolved content and symlink escapes', async () => {
    if (process.platform === 'win32') return
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-current-plugin-reject-'))
    const fixture = await createScopedTestManager(tempDir)
    const packagesRoot = path.join(
      process.env.CLAUDE_MULTIMODEL_CACHE_HOME!,
      'opencode', 'shared-cache', 'opencode', 'packages',
    )
    try {
      await writeFile(path.join(tempDir, 'opencode.json'), JSON.stringify({ plugin: ['missing-plugin'] }))
      await expect(fixture.manager.captureCurrentScopedProfilePlan({
        purpose: 'provider-catalog', providerId: 'deepinfra',
        runtimeInstanceId: 'missing-plugin-attempt', projectPath: tempDir,
      })).rejects.toThrow('immutable planning evidence is unavailable')

      await writeFile(path.join(tempDir, 'opencode.json'), JSON.stringify({ plugin: ['linked-plugin'] }))
      const linkedRoot = path.join(packagesRoot, 'installed-linked')
      const outside = path.join(tempDir, 'outside.js')
      await mkdir(linkedRoot, { recursive: true })
      await writeFile(path.join(linkedRoot, 'package.json'), JSON.stringify({
        name: 'linked-plugin', version: '1.0.0',
      }))
      await writeFile(outside, 'external bytes\n')
      await symlink(outside, path.join(linkedRoot, 'index.js'))
      await expect(fixture.manager.captureCurrentScopedProfilePlan({
        purpose: 'provider-catalog', providerId: 'deepinfra',
        runtimeInstanceId: 'linked-plugin-attempt', projectPath: tempDir,
      })).rejects.toThrow('immutable planning evidence is unavailable')
    } finally {
      fixture.restore()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('actual production planning preserves ordinary plugins and materializes only the selected Kiro app plugin', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-current-kiro-plan-'))
    const fixture = await createScopedTestManager(tempDir)
    const packageCacheRoot = path.join(
      process.env.CLAUDE_MULTIMODEL_CACHE_HOME!,
      'opencode', 'shared-cache', 'opencode', 'packages',
    )
    const writeCachedPackage = async (spec: string, name: string, version: string): Promise<void> => {
      const root = path.join(packageCacheRoot, spec)
      await mkdir(root, { recursive: true })
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ name, version }))
      await writeFile(path.join(root, 'index.js'), 'export default {}\n')
    }
    try {
      await writeFile(path.join(tempDir, 'opencode.json'), JSON.stringify({
        plugin: ['ordinary-user-choice@1.2.3'],
      }))
      await writeCachedPackage('ordinary-user-choice@1.2.3', 'ordinary-user-choice', '1.2.3')
      await writeCachedPackage('opencode-kiro@0.4.0', 'opencode-kiro', '0.4.0')
      // This unrelated app-managed package is present in the shared cache but
      // is not selected and must never be injected into the Kiro plan.
      await writeCachedPackage('@rama_nigg/open-cursor@2.5.2', '@rama_nigg/open-cursor', '2.5.2')

      const current = await fixture.manager.captureCurrentScopedProfilePlan({
        purpose: 'provider-catalog', providerId: 'kiro', runtimeInstanceId: 'catalog-g1-kiro-attempt',
        projectPath: tempDir,
      })
      expect(current.evidence.plugins.map(plugin => [plugin.spec, plugin.provenance])).toEqual([
        ['ordinary-user-choice@1.2.3', 'project'],
        ['opencode-kiro@0.4.0', 'app-managed'],
      ])
      expect(current.evidence.nativeAccountIdentitySource).toBe('official-provider-cli')
      const expected = fixture.manager.planScopedProfile(current)
      expect(expected.plugins.map(plugin => plugin.spec)).toEqual([
        'ordinary-user-choice@1.2.3', 'opencode-kiro@0.4.0',
      ])
      expect(JSON.stringify(expected)).not.toContain('@rama_nigg/open-cursor')
      const prepared = await fixture.manager.prepareScopedProfile(current, expected)
      expect(prepared.managedConfig.plugin).toEqual([
        'file:./node_modules/ordinary-user-choice',
        'file:./node_modules/opencode-kiro',
      ])
    } finally {
      fixture.restore()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('actual production manager rejects unrelated app-managed plugin evidence', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-current-unrelated-managed-'))
    const fixture = await createScopedTestManager(tempDir)
    const packageCacheRoot = path.join(
      process.env.CLAUDE_MULTIMODEL_CACHE_HOME!,
      'opencode', 'shared-cache', 'opencode', 'packages',
    )
    const writeCachedPackage = async (spec: string, name: string, version: string): Promise<void> => {
      const root = path.join(packageCacheRoot, spec)
      await mkdir(root, { recursive: true })
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ name, version }))
    }
    try {
      await writeCachedPackage('opencode-kiro@0.4.0', 'opencode-kiro', '0.4.0')
      await writeCachedPackage('@rama_nigg/open-cursor@2.5.2', '@rama_nigg/open-cursor', '2.5.2')
      const kiro = await fixture.manager.captureCurrentScopedProfilePlan({
        purpose: 'provider-catalog', providerId: 'kiro', runtimeInstanceId: 'kiro-attempt',
        projectPath: tempDir,
      })
      const cursor = await fixture.manager.captureCurrentScopedProfilePlan({
        purpose: 'provider-catalog', providerId: 'cursor-acp', runtimeInstanceId: 'cursor-attempt',
        projectPath: tempDir,
      })
      const unrelated = cursor.evidence.plugins.find(plugin => plugin.provenance === 'app-managed')!
      const injected = {
        ...kiro,
        evidence: { ...kiro.evidence, plugins: [...kiro.evidence.plugins, unrelated] },
      }
      expect(() => fixture.manager.planScopedProfile(injected))
        .toThrow('app-managed plugin pin is invalid')
    } finally {
      fixture.restore()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test.each(['root', 'nested'] as const)(
    'rejects a replaced %s project parent after capture and before descriptor-relative copy',
    async replacement => {
      if (process.platform !== 'linux' && process.platform !== 'darwin') return
      const root = await mkdtemp(path.join(os.tmpdir(), `opencode-project-retained-${replacement}-`))
      const project = path.join(root, 'project')
      const displaced = path.join(root, `displaced-${replacement}`)
      const outside = path.join(root, 'outside')
      const snapshots = path.join(root, 'snapshots')
      const target = path.join(snapshots, 'project-behavior')
      try {
        await Promise.all([
          mkdir(path.join(project, '.opencode', 'plugins'), { recursive: true }),
          mkdir(path.join(outside, 'plugins'), { recursive: true }),
          mkdir(snapshots),
        ])
        await Promise.all([
          writeFile(path.join(project, '.opencode', 'plugins', 'fixture.js'), 'same bytes\n'),
          writeFile(path.join(outside, 'plugins', 'fixture.js'), 'same bytes\n'),
        ])
        await expect(publishOpenCodeProjectBehaviorSnapshotForTest(project, target, {
          afterCaptureBeforeCopy: async () => {
            if (replacement === 'root') {
              await rename(project, displaced)
              await symlink(path.join(root, 'outside-project'), project, 'dir')
              await mkdir(path.join(root, 'outside-project'), { recursive: true })
              await symlink(outside, path.join(root, 'outside-project', '.opencode'), 'dir')
            } else {
              await rename(path.join(project, '.opencode'), displaced)
              await symlink(outside, path.join(project, '.opencode'), 'dir')
            }
          },
        })).rejects.toThrow('ancestry changed before materialization')
        expect(await lstat(target).catch(() => null)).toBeNull()
        expect((await readdir(snapshots)).filter(name => name.includes('.snapshot-'))).toEqual([])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  test.each(['add', 'remove', 'type'] as const)(
    'rejects project behavior directory %s drift from the descriptor-relative name/type manifest',
    async mutation => {
      if (process.platform !== 'linux' && process.platform !== 'darwin') return
      const root = await mkdtemp(path.join(os.tmpdir(), `opencode-project-entry-${mutation}-`))
      const project = path.join(root, 'project')
      const behaviorDirectory = path.join(project, '.opencode', 'tools')
      const target = path.join(root, 'snapshots', 'project-behavior')
      try {
        await mkdir(path.join(behaviorDirectory, 'empty'), { recursive: true })
        await mkdir(path.dirname(target), { recursive: true })
        await expect(publishOpenCodeProjectBehaviorSnapshotForTest(project, target, {
          afterCaptureBeforeCopy: async () => {
            const entry = path.join(behaviorDirectory, mutation === 'add' ? 'added' : 'empty')
            if (mutation === 'add') await mkdir(entry)
            if (mutation === 'remove') await rm(entry, { recursive: true })
            if (mutation === 'type') {
              await rm(entry, { recursive: true })
              await writeFile(entry, 'changed type\n')
            }
          },
        })).rejects.toThrow('directory entry set changed before materialization')
        expect(await lstat(target).catch(() => null)).toBeNull()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  test('attempt abort at the verified project-tree barrier prevents the final profile rename', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-project-abort-before-publish-'))
    const project = path.join(root, 'project')
    const target = path.join(root, 'snapshots', 'project-behavior')
    const controller = new AbortController()
    const reason = new Error('catalog profile deadline')
    try {
      await mkdir(path.join(project, '.opencode'), { recursive: true })
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(path.join(project, '.opencode', 'fixture.ts'), 'export default true\n')
      await expect(publishOpenCodeProjectBehaviorSnapshotForTest(project, target, {
        abortSignal: controller.signal,
        afterTemporaryTreeVerified: () => controller.abort(reason),
      })).rejects.toBe(reason)
      expect(await lstat(target).catch(() => null)).toBeNull()
      expect((await readdir(path.dirname(target))).filter(name => name.includes('.snapshot-'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('freezes and verifies the complete temporary project tree before rename and remains retryable', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-project-freeze-before-publish-'))
    const project = path.join(root, 'project')
    const snapshots = path.join(root, 'snapshots')
    const target = path.join(snapshots, 'project-behavior')
    try {
      await mkdir(path.join(project, '.opencode', 'plugins'), { recursive: true })
      await mkdir(snapshots)
      await writeFile(path.join(project, '.opencode', 'plugins', 'fixture.js'), 'fixture\n')
      await expect(publishOpenCodeProjectBehaviorSnapshotForTest(project, target, {
        afterTemporaryTreeVerified: async temporaryPath => {
          expect((await lstat(temporaryPath)).mode & 0o777).toBe(0o500)
          expect((await lstat(path.join(temporaryPath, 'plugins'))).mode & 0o777).toBe(0o500)
          expect((await lstat(path.join(temporaryPath, 'plugins', 'fixture.js'))).mode & 0o777)
            .toBe(0o400)
          throw new Error('deterministic publication interruption')
        },
      })).rejects.toThrow('deterministic publication interruption')
      expect(await lstat(target).catch(() => null)).toBeNull()
      expect((await readdir(snapshots)).filter(name =>
        name.includes('.snapshot-') || name.includes('.incomplete-'))).toEqual([])

      const displacedTemporary = path.join(snapshots, 'verified-temporary-original')
      await expect(publishOpenCodeProjectBehaviorSnapshotForTest(project, target, {
        afterTemporaryTreeVerified: async temporaryPath => {
          await rename(temporaryPath, displacedTemporary)
          await mkdir(path.join(temporaryPath, 'plugins'), { recursive: true, mode: 0o700 })
          await writeFile(path.join(temporaryPath, 'plugins', 'fixture.js'), 'fixture\n', {
            mode: 0o400,
          })
          await chmod(path.join(temporaryPath, 'plugins'), 0o500)
          await chmod(temporaryPath, 0o500)
        },
      })).rejects.toThrow('pathname changed before publication')
      expect(await lstat(target).catch(() => null)).toBeNull()
      await rm(displacedTemporary, { recursive: true, force: true })

      const displacedPublished = path.join(snapshots, 'published-original')
      await expect(publishOpenCodeProjectBehaviorSnapshotForTest(project, target, {
        afterRenameBeforeFinalVerify: async publishedTarget => {
          await rename(publishedTarget, displacedPublished)
          await mkdir(publishedTarget, { mode: 0o700 })
        },
      })).rejects.toThrow('directory ownership or mode mismatch')
      expect(await lstat(target).catch(() => null)).toBeNull()
      expect((await lstat(displacedPublished)).isDirectory()).toBe(true)
      expect((await readdir(snapshots)).filter(name =>
        name.includes('.snapshot-') || name.includes('.incomplete-'))).toEqual([])

      await publishOpenCodeProjectBehaviorSnapshotForTest(project, target)
      expect((await lstat(target)).mode & 0o777).toBe(0o500)
      expect((await lstat(path.join(target, 'plugins'))).mode & 0o777).toBe(0o500)
      expect((await lstat(path.join(target, 'plugins', 'fixture.js'))).mode & 0o777).toBe(0o400)

      await chmod(path.join(target, 'plugins'), 0o700)
      await expect(publishOpenCodeProjectBehaviorSnapshotForTest(project, target))
        .rejects.toThrow('directory ownership or mode mismatch')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('failed publication cleanup preserves a later valid replacement inode', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-project-valid-replacement-'))
    const project = path.join(root, 'project')
    const snapshots = path.join(root, 'snapshots')
    const target = path.join(snapshots, 'project-behavior')
    const replacement = path.join(snapshots, 'valid-replacement')
    const displaced = path.join(snapshots, 'published-original')
    try {
      await mkdir(path.join(project, '.opencode', 'plugins'), { recursive: true })
      await mkdir(snapshots)
      await writeFile(path.join(project, '.opencode', 'plugins', 'fixture.js'), 'fixture\n')
      await publishOpenCodeProjectBehaviorSnapshotForTest(project, replacement)
      const replacementIdentity = await lstat(replacement)

      await expect(publishOpenCodeProjectBehaviorSnapshotForTest(project, target, {
        afterRenameBeforeFinalVerify: async publishedTarget => {
          await rename(publishedTarget, displaced)
          await rename(replacement, publishedTarget)
        },
      })).rejects.toThrow('inode changed after publication')

      const finalIdentity = await lstat(target)
      expect([finalIdentity.dev, finalIdentity.ino]).toEqual([
        replacementIdentity.dev, replacementIdentity.ino,
      ])
      expect(await readFile(path.join(target, 'plugins', 'fixture.js'), 'utf8')).toBe('fixture\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('failed publication cleanup quarantines a symlink replacement without touching its target', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-project-symlink-replacement-'))
    const project = path.join(root, 'project')
    const snapshots = path.join(root, 'snapshots')
    const target = path.join(snapshots, 'project-behavior')
    const displaced = path.join(snapshots, 'published-original')
    const outside = path.join(root, 'outside')
    try {
      await mkdir(path.join(project, '.opencode', 'plugins'), { recursive: true })
      await mkdir(snapshots)
      await mkdir(outside)
      await writeFile(path.join(project, '.opencode', 'plugins', 'fixture.js'), 'fixture\n')
      await writeFile(path.join(outside, 'sentinel'), 'preserved\n')

      await expect(publishOpenCodeProjectBehaviorSnapshotForTest(project, target, {
        afterRenameBeforeFinalVerify: async publishedTarget => {
          await rename(publishedTarget, displaced)
          await symlink(outside, publishedTarget, 'dir')
        },
      })).rejects.toThrow()

      expect(await lstat(target).catch(() => null)).toBeNull()
      expect(await readFile(path.join(outside, 'sentinel'), 'utf8')).toBe('preserved\n')
      await publishOpenCodeProjectBehaviorSnapshotForTest(project, target)
      expect(await readFile(path.join(target, 'plugins', 'fixture.js'), 'utf8')).toBe('fixture\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects a symlink at an intermediate project behavior component', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-project-descriptor-link-'))
    try {
      const project = path.join(root, 'project')
      const outside = path.join(root, 'outside')
      await Promise.all([mkdir(project), mkdir(outside)])
      await writeFile(path.join(outside, 'opencode.json'), '{"provider":{}}')
      await symlink(outside, path.join(project, '.opencode'), 'dir')
      await expect(collectProjectBehaviorMetadata(project)).rejects.toThrow(
        'link or unsupported component',
      )
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  test('requires the exact pure plan and materializes its canonical host key', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-scoped-planned-v2-'))
    const fixture = await createScopedTestManager(tempDir)
    try {
      const input = await buildDeepinfraPlannedInput(fixture, tempDir)
      const expectedPlan = fixture.manager.planScopedProfile(input)
      const prepared = await fixture.manager.prepareScopedProfile(input, expectedPlan)
      expect(prepared.scopedPlanDigest).toBe(expectedPlan.digest)
      expect(prepared.plannedHostKey).toBe(expectedPlan.expectedHostKey)
      expect(prepared.policy.plugins).toEqual([])
      expect((await lstat(prepared.managedAuthPath)).mode & 0o777).toBe(0o600)
    } finally {
      fixture.restore()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('rejects the removed one-argument bypass before managed filesystem effects', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-scoped-no-bypass-'))
    const fixture = await createScopedTestManager(tempDir)
    try {
      const input = await buildDeepinfraPlannedInput(fixture, tempDir)
      await expect((fixture.manager.prepareScopedProfile as unknown as (
        plannedInput: typeof input,
      ) => Promise<never>)(input)).rejects.toThrow('requires expectedPlan')
      expect(await lstat(path.join(tempDir, 'app-data')).catch(() => null)).toBeNull()
    } finally {
      fixture.restore()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('materializes and revalidates a complete immutable dependency snapshot', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-scoped-package-v2-'))
    const fixture = await createScopedTestManager(tempDir)
    try {
      await writeFile(path.join(tempDir, 'opencode.json'), JSON.stringify({
        plugin: ['custom-package@7.2.1'],
      }))
      const manifest = '{"name":"custom-package","version":"7.2.1","dependencies":{"dependency":"1.0.0"}}'
      const dependencyManifest = '{"name":"dependency","version":"1.0.0"}'
      const immutableTreeEntries = [
        { path: 'custom-package/package.json', bytesBase64: Buffer.from(manifest).toString('base64'), mode: 0o400 as const },
        { path: 'custom-package/node_modules/dependency/package.json', bytesBase64: Buffer.from(dependencyManifest).toString('base64'), mode: 0o400 as const },
        { path: 'custom-package/node_modules/dependency/index.js', bytesBase64: Buffer.from('module.exports = 42\n').toString('base64'), mode: 0o400 as const },
      ]
      const treeFingerprint = pureDigest(canonicalSerializeOpenCodePolicyIdentity(
        immutableTreeEntries.map(entry => ({
          path: entry.path,
          mode: entry.mode,
          fingerprint: pureDigest(Buffer.from(entry.bytesBase64, 'base64').toString()),
        })).sort((left, right) => left.path.localeCompare(right.path)),
      ))
      const plugin = {
        spec: 'custom-package@7.2.1',
        provenance: 'project' as const,
        dependencyTreeFingerprint: treeFingerprint,
        resolvedIdentity: fakeResolvedIdentity('7.2.1', treeFingerprint, manifest, 'custom-package'),
        immutableTreeEntries,
      }
      const input = await buildDeepinfraPlannedInput(fixture, tempDir, [plugin])
      const expectedPlan = fixture.manager.planScopedProfile(input)
      const prepared = await fixture.manager.prepareScopedProfile(input, expectedPlan)
      const dependencyPath = path.join(
        prepared.pluginNodeModulesPath,
        'custom-package', 'node_modules', 'dependency', 'index.js',
      )
      expect(await readFile(dependencyPath, 'utf8')).toBe('module.exports = 42\n')
      await expect(revalidateOpenCodeScopedPreparedProfileInputs(prepared)).resolves.toBeUndefined()
      await writeFile(dependencyPath, 'module.exports = 99\n')
      await expect(revalidateOpenCodeScopedPreparedProfileInputs(prepared))
        .rejects.toThrow('entry inputs changed')
    } finally {
      fixture.restore()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('snapshots caller plans before yielding so async byte mutation cannot publish B with A identity', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-scoped-plan-mutation-race-'))
    const fixture = await createScopedTestManager(tempDir)
    try {
      await writeFile(path.join(tempDir, 'opencode.json'), JSON.stringify({
        plugin: ['custom-package@7.2.1'],
      }))
      const manifest = '{"name":"custom-package","version":"7.2.1"}'
      const makePlugin = (implementation: string) => {
        const immutableTreeEntries = [
          { path: 'custom-package/package.json', bytesBase64: Buffer.from(manifest).toString('base64'), mode: 0o400 as const },
          { path: 'custom-package/index.js', bytesBase64: Buffer.from(implementation).toString('base64'), mode: 0o500 as const },
        ]
        const treeFingerprint = pureDigest(canonicalSerializeOpenCodePolicyIdentity(
          immutableTreeEntries.map(entry => ({
            path: entry.path,
            mode: entry.mode,
            fingerprint: pureDigest(Buffer.from(entry.bytesBase64, 'base64').toString()),
          })).sort((left, right) => left.path.localeCompare(right.path)),
        ))
        return {
          spec: 'custom-package@7.2.1',
          provenance: 'project' as const,
          dependencyTreeFingerprint: treeFingerprint,
          resolvedIdentity: fakeResolvedIdentity('7.2.1', treeFingerprint, manifest, 'custom-package'),
          immutableTreeEntries,
        }
      }
      const pluginA = makePlugin('module.exports = "A"\n')
      const pluginB = makePlugin('module.exports = "B"\n')
      const input = await buildDeepinfraPlannedInput(fixture, tempDir, [pluginA])
      const expectedA = fixture.manager.planScopedProfile(input)
      const mutableExpected = structuredClone(expectedA)
      const inputB = await buildDeepinfraPlannedInput(fixture, tempDir, [pluginB])
      const expectedB = fixture.manager.planScopedProfile(inputB)

      const preparation = fixture.manager.prepareScopedProfile(input, mutableExpected)
      // prepareScopedProfile has reached its first await. Both caller-owned
      // objects are now changed coherently to authorized-looking B evidence.
      input.evidence.plugins[0] = pluginB
      Object.assign(mutableExpected, structuredClone(expectedB))

      const prepared = await preparation
      expect(prepared.scopedPlanDigest).toBe(expectedA.digest)
      expect(prepared.plannedHostKey).toBe(expectedA.expectedHostKey)
      expect(prepared.scopedPlanDigest).not.toBe(expectedB.digest)
      expect(await readFile(
        path.join(prepared.pluginNodeModulesPath, 'custom-package', 'index.js'),
        'utf8',
      )).toBe('module.exports = "A"\n')
      const hostManager = new OpenCodeHostManager({ persistentRegistryPath: null })
      await expect(hostManager.ensureScopedHost({
        preparedProfile: prepared,
        expectedHostKey: expectedB.expectedHostKey,
      })).rejects.toThrow('expectedHostKey mismatch')
    } finally {
      fixture.restore()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('binds provider environment rotation without retaining raw values', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-scoped-env-v2-'))
    const fixture = await createScopedTestManager(tempDir)
    try {
      process.env.OPENAI_API_KEY = 'rotation-secret-one'
      const firstInput = await buildDeepinfraPlannedInput(fixture, tempDir)
      const first = fixture.manager.planScopedProfile(firstInput)
      process.env.OPENAI_API_KEY = 'rotation-secret-two'
      const secondInput = await buildDeepinfraPlannedInput(fixture, tempDir)
      const second = fixture.manager.planScopedProfile(secondInput)
      expect(second.expectedHostKey).not.toBe(first.expectedHostKey)
      expect(JSON.stringify([first, second])).not.toContain('rotation-secret')
    } finally {
      fixture.restore()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('rejects a symlinked app-owned boundary with zero writes through it', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-scoped-boundary-v2-'))
    const fixture = await createScopedTestManager(tempDir)
    const outside = path.join(tempDir, 'outside-data')
    try {
      const input = await buildDeepinfraPlannedInput(fixture, tempDir)
      const expectedPlan = fixture.manager.planScopedProfile(input)
      await mkdir(outside)
      await symlink(outside, path.join(tempDir, 'app-data'), 'dir')
      await expect(fixture.manager.prepareScopedProfile(input, expectedPlan))
        .rejects.toThrow('ancestry is not canonical')
      expect(await readdir(outside)).toEqual([])
    } finally {
      fixture.restore()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('anchors missing managed components to held descriptors during an adversarial swap', async () => {
    if (process.platform !== 'linux') return
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-managed-mkdirat-v2-'))
    const boundary = path.join(tempDir, 'managed')
    const displacedBoundary = path.join(tempDir, 'managed-original')
    const outside = path.join(tempDir, 'outside')
    const target = path.join(boundary, 'one', 'two')
    await mkdir(boundary)
    await mkdir(outside)
    let swapped = false
    try {
      await expect(ensureOpenCodeManagedDirectoryPath(target, boundary, async componentPath => {
        if (componentPath !== boundary || swapped) return
        swapped = true
        await rename(boundary, displacedBoundary)
        await symlink(outside, boundary, 'dir')
      })).rejects.toThrow('ancestry is not canonical')
      expect(swapped).toBe(true)
      expect(await readdir(outside)).toEqual([])
      expect(await stat(path.join(displacedBoundary, 'one', 'two')).then(value => value.isDirectory()))
        .toBe(true)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('creates a trusted Windows tree on first use and rejects a swap at the mkdir boundary', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-managed-windows-v2-'))
    const boundary = path.join(tempDir, 'managed')
    const target = path.join(boundary, 'one', 'two')
    const outside = path.join(tempDir, 'outside')
    const displacedBoundary = path.join(tempDir, 'managed-original')
    try {
      await ensureOpenCodeManagedDirectoryPath(target, boundary, undefined, 'win32')
      await mkdir(outside)
      expect((await stat(target)).isDirectory()).toBe(true)

      let swapped = false
      await expect(ensureOpenCodeManagedDirectoryPath(target, boundary, async componentPath => {
        if (componentPath !== boundary || swapped) return
        swapped = true
        await rename(boundary, displacedBoundary)
        await symlink(outside, boundary, 'dir')
      }, 'win32')).rejects.toThrow('ancestry is not canonical')
      expect(swapped).toBe(true)
      expect(await readdir(outside)).toEqual([])
      await rm(boundary)
      await rename(displacedBoundary, boundary)

      await symlink(outside, path.join(boundary, 'linked'), 'dir')
      await expect(ensureOpenCodeManagedDirectoryPath(
        path.join(boundary, 'linked', 'child'),
        boundary,
        undefined,
        'win32',
      )).rejects.toThrow('ancestry is not canonical')
      expect(await readdir(outside)).toEqual([])

      await expect(ensureOpenCodeManagedDirectoryPath(
        path.join(boundary, '..', 'outside', 'child'),
        boundary,
        undefined,
        'win32',
      )).rejects.toThrow('ownership boundary is invalid')
      expect(await readdir(outside)).toEqual([])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('accepts root-owned platform ancestors above a non-root app-owned boundary', () => {
    const currentUid = 12_345
    expect(isOpenCodeManagedPathComponentOwnershipValid(
      '/tmp', '/tmp/app-data', { uid: 0, mode: 0o41777 }, currentUid,
    )).toBe(true)
    expect(isOpenCodeManagedPathComponentOwnershipValid(
      '/tmp/app-data', '/tmp/app-data', { uid: currentUid, mode: 0o40755 }, currentUid,
    )).toBe(true)
    expect(isOpenCodeManagedPathComponentOwnershipValid(
      '/tmp/app-data/opencode', '/tmp/app-data', { uid: 0, mode: 0o40755 }, currentUid,
    )).toBe(false)
  })

  test('links plan, preparation, retained host adoption, and late-exit cleanup', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-scoped-integrated-v2-'))
    const fixture = await createScopedTestManager(tempDir)
    const registryPath = path.join(tempDir, 'host-registry.json')
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, {
      pid: 52221,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      unref() {},
      kill() { return true },
    })
    let spawnCount = 0
    const ownerKey = Buffer.alloc(32, 7)
    const dependencies = () => ({
      allocateLoopbackPort: async () => 44221,
      spawnHostProcess: () => {
        spawnCount += 1
        return child
      },
      fetchJson: async (url: string) => {
        if (url.endsWith('/global/health')) {
          return { status: 200, data: { healthy: true, version: '1.2.3' } }
        }
        if (url.endsWith('/global/dispose')) return { status: 200, data: {} }
        throw new Error(`unexpected integrated scoped request ${url}`)
      },
      isProcessAlive: (pid: number) => pid === 52221,
      readProcessStartTimeMs: async () => 1_000,
      readProcessCommandLine: async () => 'opencode serve --hostname 127.0.0.1 --port 44221',
      sleepMs: async () => {},
      persistentRegistryPath: registryPath,
      scopedTransportOwnerKey: ownerKey,
    })
    try {
      const input = await buildDeepinfraPlannedInput(fixture, tempDir, [], {
        purpose: 'launch',
        modelId: 'deepinfra/model',
      })
      const plan = fixture.manager.planScopedProfile(input)
      const prepared = await fixture.manager.prepareScopedProfile(input, plan)
      expect(prepared.plannedHostKey).toBe(plan.expectedHostKey)

      const owner = new OpenCodeHostManager(dependencies())
      const created = await owner.ensureScopedHost({
        preparedProfile: prepared,
        expectedHostKey: plan.expectedHostKey,
      })
      const adopter = new OpenCodeHostManager(dependencies())
      const adopted = await adopter.ensureScopedHost({
        preparedProfile: prepared,
        expectedHostKey: plan.expectedHostKey,
      })
      expect(adopted.hostKey).toBe(plan.expectedHostKey)
      expect(adopted.pid).toBe(created.pid)
      expect(adopted.diagnostics.join(' ')).toContain('adopted persistent')
      expect(spawnCount).toBe(1)

      child.emit('exit', 1, null)
      await new Promise(resolve => setTimeout(resolve, 20))
      const registryBytes = await readFile(registryPath, 'utf8').catch(() => null)
      if (registryBytes !== null) {
        const registry = JSON.parse(registryBytes) as { hosts: Record<string, unknown> }
        expect(registry.hosts[plan.expectedHostKey]).toBeUndefined()
      }
    } finally {
      fixture.restore()
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

setDefaultTimeout(30_000)

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/')
}

async function runBunScript(
  scriptPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`script exited with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })
  })
}

async function runCommandCapture(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(new Error(`command exited with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })
  })
}

describe('OpenCodeProfileManager project behavior contract', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-profile-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test('parses the first balanced Kiro whoami JSON object before its Profile trailer', () => {
    expect(isKiroCliWhoamiAuthenticated({
      stdout: '{"accountType":"IamIdentityCenter","email":"user@example.com"}\n\nProfile:\nKiroProfile',
    })).toBe(true)
  })

  test('treats logged-out and malformed Kiro whoami payloads as unauthenticated', () => {
    expect(isKiroCliWhoamiAuthenticated({ stdout: '{"account":null}' })).toBe(false)
    expect(isKiroCliWhoamiAuthenticated({ stdout: '{not valid json' })).toBe(false)
    expect(isKiroCliWhoamiAuthenticated({ stdout: '{"accountType":"   "}' })).toBe(false)
  })

  test('accepts authenticated Kiro whoami JSON from stderr despite a non-zero exit', () => {
    expect(isKiroCliWhoamiAuthenticated({
      error: Object.assign(new Error('exit 1'), { code: 1 }),
      stdout: '',
      stderr: '{"accountType":"BuilderId"}',
    })).toBe(true)
  })

  test('requires a definitive native account id and hashes stable ids distinctly', () => {
    expect(resolveOpenCodeNativeAccountIdentity(
      'kiro', '{"accountType":"BuilderId"}', '',
    )).toBeNull()
    expect(resolveOpenCodeNativeAccountIdentity(
      'cursor-acp', 'Logged in', '',
    )).toBeNull()
    const first = resolveOpenCodeNativeAccountIdentity(
      'kiro', '{"accountType":"BuilderId","userId":"account-a"}', '',
    )
    const second = resolveOpenCodeNativeAccountIdentity(
      'kiro', '{"accountType":"BuilderId","userId":"account-b"}', '',
    )
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(second).toMatch(/^[a-f0-9]{64}$/)
    expect(first).not.toBe(second)
    expect(`${first}${second}`).not.toContain('account-')
  })

  test('native account proof executes the resolved bytes with the captured environment', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-native-proof-target-'))
    try {
      const resolved = path.join(root, 'resolved-kiro')
      const decoyDir = path.join(root, 'decoy')
      await mkdir(decoyDir)
      await writeFile(resolved,
        '#!/bin/sh\nprintf \'{"accountType":"Builder ID","userId":"%s"}\\n\' "$PROOF_ACCOUNT"\n',
        { mode: 0o700 })
      await writeFile(path.join(decoyDir, 'kiro-cli'),
        '#!/bin/sh\nprintf \'{"accountType":"Builder ID","userId":"decoy"}\\n\'\n',
        { mode: 0o700 })
      const result = await probeNativeCredentialIdentity('kiro', resolved, process.platform, {
        PATH: decoyDir,
        PROOF_ACCOUNT: 'captured-account',
      })
      expect(result.reportsAuthenticated).toBe(true)
      expect(result.accountIdentity).toBe(resolveOpenCodeNativeAccountIdentity(
        'kiro', '{"accountType":"Builder ID","userId":"captured-account"}', '',
      ))
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('tracks project plugin sources without shadowing plugin config in managed overrides', async () => {
    await mkdir(path.join(tempDir, '.opencode', 'plugins'), { recursive: true })
    await writeFile(
      path.join(tempDir, 'opencode.json'),
      JSON.stringify({ plugin: ['opencode-helicone-session'] }),
      'utf8',
    )
    await writeFile(
      path.join(tempDir, '.opencode', 'package.json'),
      JSON.stringify({ dependencies: { shescape: '^2.1.0' } }),
      'utf8',
    )
    await writeFile(
      path.join(tempDir, '.opencode', 'plugins', 'team-hooks.ts'),
      'export const TeamHooks = async () => ({})\n',
      'utf8',
    )

    const first = await collectProjectBehaviorMetadata(tempDir)
    await writeFile(
      path.join(tempDir, '.opencode', 'plugins', 'team-hooks.ts'),
      'export const TeamHooks = async () => ({ "session.updated": async () => {} })\n',
      'utf8',
    )
    const second = await collectProjectBehaviorMetadata(tempDir)
    const managedConfig = buildManagedConfig()

    expect(first.behaviorSources.map(normalizePath)).toEqual([
      '.opencode/package.json',
      '.opencode/plugins/team-hooks.ts',
      'opencode.json',
    ])
    expect(second.projectBehaviorFingerprint).not.toBe(first.projectBehaviorFingerprint)
    expect('plugin' in managedConfig).toBe(false)
    expect(managedConfig).toMatchObject({
      default_agent: 'teammate',
      share: 'disabled',
      autoupdate: false,
      snapshot: true,
      agent: {
        teammate: {
          permission: {
            '*': 'deny',
            read: 'allow',
            glob: 'allow',
            grep: 'allow',
            list: 'allow',
            lsp: 'allow',
            todoread: 'allow',
            todowrite: 'allow',
            edit: 'allow',
            bash: 'allow',
            'agent-teams_*': 'allow',
            'agent_teams_*': 'allow',
            'mcp__agent-teams__*': 'allow',
            'mcp__agent_teams__*': 'allow',
          },
        },
        'teammate-bootstrap': {
          tools: {
            '*': false,
            'agent-teams_*': true,
            'agent_teams_*': true,
            'mcp__agent-teams__*': true,
            'mcp__agent_teams__*': true,
          },
          permission: {
            '*': 'deny',
            'agent-teams_*': 'allow',
            'agent_teams_*': 'allow',
            'mcp__agent-teams__*': 'allow',
            'mcp__agent_teams__*': 'allow',
          },
        },
        'teammate-model-probe': {
          tools: {
            '*': false,
          },
          permission: {
            '*': 'deny',
          },
        },
      },
    })
  })

  test('can build a manual approval teammate profile while keeping app MCP allowed', () => {
    const managedConfig = buildManagedConfig(null, { toolApprovalMode: 'manual' })

    expect(managedConfig).toMatchObject({
      agent: {
        teammate: {
          permission: {
            '*': 'ask',
            task: {
              '*': 'deny',
            },
            external_directory: 'deny',
            doom_loop: 'deny',
            'agent-teams_*': 'allow',
            'agent_teams_*': 'allow',
            'mcp__agent-teams__*': 'allow',
            'mcp__agent_teams__*': 'allow',
          },
        },
      },
    })
  })

  test('can embed the app-owned MCP server without shadowing plugins', () => {
    const managedConfig = buildManagedConfig({
      type: 'local',
      command: ['node', '/tmp/agent-teams-mcp.js'],
      environment: {
        HOME: '/tmp/profile-home',
      },
      enabled: true,
      timeout: 8000,
    })

    expect('plugin' in managedConfig).toBe(false)
    expect(managedConfig.mcp).toEqual({
      'agent-teams': {
        type: 'local',
        command: ['node', '/tmp/agent-teams-mcp.js'],
        environment: {
          HOME: '/tmp/profile-home',
        },
        enabled: true,
        timeout: 8000,
      },
    })
  })

  test('seeds Z.AI Coding Plan independently of remote catalog hydration', () => {
    const managedConfig = buildManagedConfig()

    expect(managedConfig.provider).toMatchObject({
      'zai-coding-plan': {
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: 'https://api.z.ai/api/coding/paas/v4',
        },
        models: {
          'glm-5.2': {
            reasoning: true,
            tool_call: true,
            interleaved: { field: 'reasoning_content' },
          },
          'glm-5.1': {
            reasoning: true,
            tool_call: true,
            interleaved: { field: 'reasoning_content' },
          },
          'glm-5': {
            reasoning: true,
            tool_call: true,
          },
          'glm-5-turbo': {
            reasoning: true,
            tool_call: true,
          },
        },
      },
    })
  })

  test('keeps Copilot discoverable for explicit-model capability diagnostics', () => {
    const managedConfig = buildManagedConfig()

    expect(managedConfig.provider).toMatchObject({
      'github-copilot': {
        name: 'GitHub Copilot',
        npm: '@ai-sdk/github-copilot',
        api: 'https://api.githubcopilot.com',
        models: {
          'gpt-5-mini': {
            name: 'GPT-5 Mini',
            family: 'gpt-mini',
            reasoning: true,
            tool_call: true,
            structured_output: true,
            limit: {
              context: 264_000,
              input: 128_000,
              output: 64_000,
            },
          },
        },
      },
    })
  })

  test('seeds Xiaomi MiMo Token Plan OpenCode providers for regional Token Plan endpoints', () => {
    const managedConfig = buildManagedConfig()

    expect(managedConfig.provider).toMatchObject({
      'xiaomi-token-plan-ams': {
        npm: '@ai-sdk/openai-compatible',
        name: 'Xiaomi MiMo Token Plan - Europe',
        options: {
          baseURL: 'https://token-plan-ams.xiaomimimo.com/v1',
        },
        models: {
          'mimo-v2.5-pro': {
            name: 'mimo-v2.5-pro',
            limit: {
              context: 1_048_576,
              output: 131_072,
            },
            modalities: {
              input: ['text'],
              output: ['text'],
            },
          },
          'mimo-v2.5': {
            modalities: {
              input: ['text', 'image', 'audio', 'video'],
              output: ['text'],
            },
          },
        },
      },
      'xiaomi-token-plan-sgp': {
        options: {
          baseURL: 'https://token-plan-sgp.xiaomimimo.com/v1',
        },
      },
      'xiaomi-token-plan-cn': {
        options: {
          baseURL: 'https://token-plan-cn.xiaomimimo.com/v1',
        },
      },
    })
  })

  test('seeds the official Kimi Code membership endpoint and stable model ids', () => {
    const managedConfig = buildManagedConfig()

    expect(managedConfig.provider).toMatchObject({
      'kimi-for-coding': {
        npm: '@ai-sdk/openai-compatible',
        name: 'Kimi Code Membership',
        options: {
          baseURL: 'https://api.kimi.com/coding/v1',
        },
        models: {
          k3: {
            name: 'Kimi K3',
            reasoning: true,
            tool_call: true,
            variants: {
              low: { reasoningEffort: 'low' },
              medium: { disabled: true },
              high: { reasoningEffort: 'high' },
              max: { reasoningEffort: 'max' },
            },
            limit: {
              context: 262_144,
              output: 32_768,
            },
            modalities: {
              input: ['text', 'image', 'video'],
              output: ['text'],
            },
          },
          'kimi-for-coding': {
            name: 'Kimi Code',
            reasoning: true,
            tool_call: true,
            limit: {
              context: 262_144,
              output: 32_768,
            },
            modalities: {
              input: ['text', 'image', 'video'],
              output: ['text'],
            },
          },
          'kimi-for-coding-highspeed': {
            name: 'Kimi Code HighSpeed',
          },
        },
      },
    })
  })

  test('refreshes imported K3 variant definitions with the managed catalog', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const previousConfigContent = process.env.OPENCODE_CONFIG_CONTENT
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = path.join(tempDir, 'app-data-k3-refresh')
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = path.join(tempDir, 'app-cache-k3-refresh')
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      provider: {
        'kimi-for-coding': {
          models: {
            k3: {
              variants: {
                medium: { reasoningEffort: 'medium' },
                max: { reasoningEffort: 'stale-max' },
                custom: { reasoningEffort: 'custom' },
              },
            },
          },
        },
      },
    })

    try {
      const projectPath = path.join(tempDir, 'project-k3-refresh')
      await mkdir(projectPath, { recursive: true })
      const profile = await new OpenCodeProfileManager().prepareProfile(
        projectPath,
        { includeAppMcp: false },
      )
      expect(profile.managedConfig).toMatchObject({
        provider: {
          'kimi-for-coding': {
            models: {
              k3: {
                variants: {
                  low: { reasoningEffort: 'low' },
                  medium: { disabled: true },
                  high: { reasoningEffort: 'high' },
                  max: { reasoningEffort: 'max' },
                  custom: { reasoningEffort: 'custom' },
                },
              },
            },
          },
        },
      })
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
      if (previousConfigContent === undefined) {
        delete process.env.OPENCODE_CONFIG_CONTENT
      } else {
        process.env.OPENCODE_CONFIG_CONTENT = previousConfigContent
      }
    }
  })

  test('seeds plugin-backed Cursor and Kiro providers even when models.dev lags', () => {
    const managedConfig = buildManagedConfig()

    expect(managedConfig.provider).toMatchObject({
      kiro: {
        name: 'Amazon Q Developer / Kiro',
        npm:
          'kiro-acp-ai-provider@https://github.com/777genius/kiro-acp-ai-provider/releases/download/agent-teams-mcp-readiness-v12/kiro-acp-ai-provider-3.0.0.tgz',
        models: {
          auto: {
            name: 'Auto',
            tool_call: true,
            limit: { context: 262_144, output: 32_768 },
          },
        },
      },
      'cursor-acp': {
        name: 'Cursor ACP',
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: 'http://127.0.0.1:32124/v1',
        },
        models: {
          auto: {
            name: 'Auto',
            tool_call: true,
            limit: { context: 262_144, output: 32_768 },
          },
        },
      },
    })
  })

  test('keeps OpenCode isolated while native subscription CLIs reuse the host login home', async () => {
    if (process.platform === 'win32') return

    const hostHomePath = path.join(tempDir, "host user's home")
    const hostBinPath = path.join(tempDir, 'host-bin')
    const profileRootPath = path.join(tempDir, 'profile-root')
    await mkdir(hostBinPath, { recursive: true })
    await writeFile(
      path.join(hostBinPath, 'cursor-agent'),
      '#!/bin/sh\nprintf "cursor:%s" "$HOME"\n',
      { encoding: 'utf8', mode: 0o700 },
    )
    await writeFile(
      path.join(hostBinPath, 'kiro-cli'),
      '#!/bin/sh\nprintf "kiro:%s" "$HOME"\n',
      { encoding: 'utf8', mode: 0o700 },
    )

    const bridge = await ensureOpenCodeNativeCliCredentialBridge(
      profileRootPath,
      {
        HOME: hostHomePath,
        PATH: hostBinPath,
      },
      process.platform,
    )
    const managedEnv = {
      HOME: path.join(profileRootPath, 'home'),
      USERPROFILE: path.join(profileRootPath, 'home'),
      PATH: `${bridge.binPath}${path.delimiter}${hostBinPath}`,
    }

    expect(await runCommandCapture(bridge.cursorAgentExecutablePath, [], managedEnv))
      .toBe(`cursor:${hostHomePath}`)
    expect(await runCommandCapture(path.join(bridge.binPath, 'kiro-cli'), [], managedEnv))
      .toBe(`kiro:${hostHomePath}`)
    const cursorBridgeSource = await readFile(bridge.cursorAgentExecutablePath, 'utf8')
    expect(cursorBridgeSource).toContain('AGENT_TEAMS_CURSOR_RESOURCE_EXHAUSTED_PATCH_DISABLED')
    expect(cursorBridgeSource).toContain('AGENT_TEAMS_CURSOR_ORIGINAL_NODE_OPTIONS')
    expect(cursorBridgeSource).toContain('cursor-resource-exhausted-preload.cjs')
    expect(await readFile(
      path.join(bridge.binPath, 'cursor-resource-exhausted-preload.cjs'),
      'utf8',
    )).toContain('RESOURCE_EXHAUSTED')
  })

  test('rejects a symlinked native bridge directory without writing its target', async () => {
    const profileRootPath = path.join(tempDir, 'bridge-link-profile')
    const outside = path.join(tempDir, 'bridge-link-outside')
    await mkdir(profileRootPath)
    await mkdir(outside)
    await symlink(outside, path.join(profileRootPath, 'native-subscription-cli-bin'))
    await expect(ensureOpenCodeNativeCliCredentialBridge(
      profileRootPath,
      { HOME: tempDir, PATH: '' },
      process.platform,
      'kiro',
    )).rejects.toThrow('bridge parent is not canonical')
    expect(await readdir(outside)).toEqual([])
  })

  test('applies the Cursor resource exhaustion override by default with a kill switch', async () => {
    if (process.platform === 'win32') return

    const nodePath = Bun.which('node')
    // The hosted source-test image can intentionally contain Bun without a
    // separate Node executable. The bridge behavior is covered when Node is
    // available; absence is an environment limitation, not a product failure.
    if (!nodePath) return
    const hostBinPath = path.join(tempDir, 'host-bin')
    const profileRootPath = path.join(tempDir, 'profile-root')
    const fixturePath = path.join(tempDir, 'cursor-agent-fixture.js')
    const cursorAgentOverridePath = path.join(tempDir, 'custom cursor-agent')
    await mkdir(hostBinPath, { recursive: true })
    await writeFile(
      fixturePath,
      [
        "const c={yM:{FREE_USER_USAGE_LIMIT:'free',GENERIC_RATE_LIMIT_EXCEEDED:'generic',RESOURCE_EXHAUSTED:'resource'}};",
        'R=new Set([c.yM.FREE_USER_USAGE_LIMIT,c.yM.GENERIC_RATE_LIMIT_EXCEEDED]);',
        'process.stdout.write(JSON.stringify({patched:R.has(c.yM.RESOURCE_EXHAUSTED),nodeOptions:process.env.NODE_OPTIONS||null}))',
      ].join(''),
      'utf8',
    )
    const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`
    await writeFile(
      path.join(hostBinPath, 'cursor-agent'),
      '#!/bin/sh\nprintf "wrong cursor-agent target"\n',
      { encoding: 'utf8', mode: 0o700 },
    )
    await writeFile(
      cursorAgentOverridePath,
      `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(fixturePath)} "$@"\n`,
      { encoding: 'utf8', mode: 0o700 },
    )
    await writeFile(
      path.join(hostBinPath, 'kiro-cli'),
      '#!/bin/sh\nexit 0\n',
      { encoding: 'utf8', mode: 0o700 },
    )
    const bridge = await ensureOpenCodeNativeCliCredentialBridge(
      profileRootPath,
      {
        HOME: tempDir,
        PATH: hostBinPath,
        CURSOR_AGENT_EXECUTABLE: cursorAgentOverridePath,
      },
      process.platform,
    )
    const baseEnv = {
      HOME: path.join(profileRootPath, 'home'),
      PATH: `${bridge.binPath}${path.delimiter}${hostBinPath}`,
    }

    expect(JSON.parse(await runCommandCapture(
      bridge.cursorAgentExecutablePath,
      [],
      baseEnv,
    ))).toEqual({ patched: true, nodeOptions: null })
    expect(JSON.parse(await runCommandCapture(
      bridge.cursorAgentExecutablePath,
      [],
      {
        ...baseEnv,
        AGENT_TEAMS_CURSOR_RESOURCE_EXHAUSTED_PATCH_DISABLED: '1',
      },
    ))).toEqual({ patched: false, nodeOptions: null })
  })

  test('writes cmd-safe Cursor preload and preserves an explicit Windows executable', async () => {
    const profileRootPath = path.join(tempDir, 'profile-root')
    const cursorAgentExecutable = 'C:\\Cursor Tools\\cursor-agent.cmd'
    const bridge = await ensureOpenCodeNativeCliCredentialBridge(
      profileRootPath,
      {
        USERPROFILE: 'C:\\Users\\Test User',
        PATH: 'C:\\Windows\\System32',
        CURSOR_AGENT_EXECUTABLE: cursorAgentExecutable,
      },
      'win32',
    )

    const cursorBridgeSource = await readFile(bridge.cursorAgentExecutablePath, 'utf8')
    expect(cursorBridgeSource).toContain('NODE_OPTIONS=--require="')
    expect(cursorBridgeSource).not.toContain('NODE_OPTIONS=--require=\\"')
    expect(cursorBridgeSource).toContain(`call "${cursorAgentExecutable}" %*`)
  })

  test('seeds the Cursor plugin marker after the official CLI reports authenticated', async () => {
    const globalAuthPath = path.join(tempDir, 'cursor-global-auth.json')
    const managedAuthPath = path.join(tempDir, 'cursor-managed-auth.json')
    const probe = mock(async () => true)

    expect(await ensureOpenCodeCursorPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      cursorAgentExecutablePath: '/test/cursor-agent',
      platform: 'linux',
      probe,
    })).toBe(true)

    for (const authPath of [globalAuthPath, managedAuthPath]) {
      expect(JSON.parse(await readFile(authPath, 'utf8'))).toMatchObject({
        'cursor-acp': { type: 'api', key: 'cursor-agent' },
      })
    }
    expect(probe).toHaveBeenCalledTimes(1)
  })

  test('removes only the managed Cursor marker after the official CLI logs out', async () => {
    const globalAuthPath = path.join(tempDir, 'cursor-logged-out-global.json')
    const managedAuthPath = path.join(tempDir, 'cursor-logged-out-managed.json')
    const store = JSON.stringify({
      'cursor-acp': { type: 'api', key: 'cursor-agent' },
      openai: { type: 'oauth', access: 'keep-me' },
    })
    await Promise.all([
      writeFile(globalAuthPath, store),
      writeFile(managedAuthPath, store),
    ])

    expect(await ensureOpenCodeCursorPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      cursorAgentExecutablePath: '/test/cursor-agent',
      probe: async () => false,
    })).toBe(false)

    for (const authPath of [globalAuthPath, managedAuthPath]) {
      expect(JSON.parse(await readFile(authPath, 'utf8'))).toEqual({
        openai: { type: 'oauth', access: 'keep-me' },
      })
    }
  })

  test('reuses a fresh Cursor marker without repeatedly probing the official CLI', async () => {
    const globalAuthPath = path.join(tempDir, 'cursor-fresh-global.json')
    const managedAuthPath = path.join(tempDir, 'cursor-fresh-managed.json')
    const credential = {
      type: 'api',
      key: 'cursor-agent',
      expires: 20 * 60 * 1000,
    }
    await writeFile(globalAuthPath, JSON.stringify({ 'cursor-acp': credential }))
    const probe = mock(async () => false)

    expect(await ensureOpenCodeCursorPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      cursorAgentExecutablePath: '/test/cursor-agent',
      probe,
      now: () => 1_000,
    })).toBe(false)

    expect(probe).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(managedAuthPath, 'utf8'))).toMatchObject({
      'cursor-acp': credential,
    })
  })

  test('preserves an explicit Cursor API credential without probing the CLI marker', async () => {
    const globalAuthPath = path.join(tempDir, 'cursor-explicit-global.json')
    const managedAuthPath = path.join(tempDir, 'cursor-explicit-managed.json')
    await writeFile(globalAuthPath, JSON.stringify({
      'cursor-acp': { type: 'api', key: 'real-user-key' },
    }))
    const probe = mock(async () => false)

    expect(await ensureOpenCodeCursorPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      cursorAgentExecutablePath: '/test/cursor-agent',
      probe,
    })).toBe(false)

    expect(JSON.parse(await readFile(managedAuthPath, 'utf8'))).toMatchObject({
      'cursor-acp': { type: 'api', key: 'real-user-key' },
    })
    expect(probe).not.toHaveBeenCalled()
  })

  test('seeds the Kiro plugin OAuth marker after the official CLI reports authenticated', async () => {
    const globalAuthPath = path.join(tempDir, 'kiro-global-auth.json')
    const managedAuthPath = path.join(tempDir, 'kiro-managed-auth.json')
    const probe = mock(async () => true)

    expect(await ensureOpenCodeKiroPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      kiroCliExecutablePath: '/test/kiro-cli',
      platform: 'linux',
      probe,
      now: () => 1_000,
    })).toBe(true)

    for (const authPath of [globalAuthPath, managedAuthPath]) {
      expect(JSON.parse(await readFile(authPath, 'utf8'))).toMatchObject({
        kiro: {
          type: 'oauth',
          access: 'authenticated',
          refresh: '',
          expires: 28_801_000,
        },
      })
    }
    expect(probe).toHaveBeenCalledTimes(1)
  })

  test('does not seed the Kiro plugin marker when the CLI is logged out', async () => {
    const globalAuthPath = path.join(tempDir, 'kiro-logged-out-global.json')
    const managedAuthPath = path.join(tempDir, 'kiro-logged-out-managed.json')

    expect(await ensureOpenCodeKiroPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      kiroCliExecutablePath: '/test/kiro-cli',
      probe: async () => false,
    })).toBe(false)

    expect(await lstat(globalAuthPath).then(() => true).catch(() => false)).toBe(false)
    expect(await lstat(managedAuthPath).then(() => true).catch(() => false)).toBe(false)
  })

  test('refreshes a stale Kiro marker after rechecking the official CLI', async () => {
    const globalAuthPath = path.join(tempDir, 'kiro-stale-global.json')
    const managedAuthPath = path.join(tempDir, 'kiro-stale-managed.json')
    await writeFile(globalAuthPath, JSON.stringify({
      kiro: { type: 'oauth', access: 'authenticated', refresh: '', expires: 2_000 },
    }))
    const probe = mock(async () => true)

    expect(await ensureOpenCodeKiroPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      kiroCliExecutablePath: '/test/kiro-cli',
      probe,
      now: () => 1_000,
    })).toBe(true)

    for (const authPath of [globalAuthPath, managedAuthPath]) {
      expect(JSON.parse(await readFile(authPath, 'utf8')).kiro.expires).toBe(28_801_000)
    }
    expect(probe).toHaveBeenCalledTimes(1)
  })

  test('removes a stale Kiro marker when the official CLI is logged out', async () => {
    const globalAuthPath = path.join(tempDir, 'kiro-stale-logged-out-global.json')
    const managedAuthPath = path.join(tempDir, 'kiro-stale-logged-out-managed.json')
    const staleStore = JSON.stringify({
      kiro: { type: 'oauth', access: 'authenticated', refresh: '', expires: 2_000 },
      openai: { type: 'oauth', access: 'keep-me' },
    })
    await Promise.all([
      writeFile(globalAuthPath, staleStore),
      writeFile(managedAuthPath, staleStore),
    ])

    expect(await ensureOpenCodeKiroPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      kiroCliExecutablePath: '/test/kiro-cli',
      probe: async () => false,
      now: () => 1_000,
    })).toBe(false)

    for (const authPath of [globalAuthPath, managedAuthPath]) {
      expect(JSON.parse(await readFile(authPath, 'utf8'))).toEqual({
        openai: { type: 'oauth', access: 'keep-me' },
      })
    }
  })

  test('rechecks and removes a fresh Kiro marker after CLI logout', async () => {
    const globalAuthPath = path.join(tempDir, 'kiro-fresh-logged-out-global.json')
    const managedAuthPath = path.join(tempDir, 'kiro-fresh-logged-out-managed.json')
    const freshStore = JSON.stringify({
      kiro: { type: 'oauth', access: 'authenticated', refresh: '', expires: 30_000_000 },
      openai: { type: 'oauth', access: 'keep-me' },
    })
    await Promise.all([
      writeFile(globalAuthPath, freshStore),
      writeFile(managedAuthPath, freshStore),
    ])
    const probe = mock(async () => false)

    expect(await ensureOpenCodeKiroPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      kiroCliExecutablePath: '/test/kiro-cli',
      probe,
      now: () => 1_000,
    })).toBe(false)

    expect(probe).toHaveBeenCalledTimes(1)
    for (const authPath of [globalAuthPath, managedAuthPath]) {
      expect(JSON.parse(await readFile(authPath, 'utf8'))).toEqual({
        openai: { type: 'oauth', access: 'keep-me' },
      })
    }
  })

  test('can prepare a managed profile without the app MCP overlay for model-only probes', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const previousMcpCommand = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND
    const previousMcpEntry = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY
    const appDataHome = path.join(tempDir, 'app-data-no-mcp')
    const appCacheHome = path.join(tempDir, 'app-cache-no-mcp')
    const mcpEntryPath = path.join(tempDir, 'agent-teams-mcp.js')
    await writeFile(mcpEntryPath, 'process.exit(0)\n', 'utf8')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = process.execPath
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY = mcpEntryPath

    try {
      const profile = await new OpenCodeProfileManager().prepareProfile(tempDir, {
        includeAppMcp: false,
      })

      expect(profile.managedConfig.mcp).toBeUndefined()
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
      if (previousMcpCommand === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND
      } else {
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = previousMcpCommand
      }
      if (previousMcpEntry === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY
      } else {
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY = previousMcpEntry
      }
    }
  }, 30_000)

  test('recovers a refreshed xAI OAuth credential from a peer during restart preparation', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const previousHome = process.env.HOME
    const previousXdgDataHome = process.env.XDG_DATA_HOME
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
    const appDataHome = path.join(tempDir, 'app-data-oauth-restart')
    const appCacheHome = path.join(tempDir, 'app-cache-oauth-restart')
    const homePath = path.join(tempDir, 'home-oauth-restart')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    process.env.HOME = homePath
    process.env.XDG_DATA_HOME = path.join(homePath, '.local', 'share')
    process.env.XDG_CONFIG_HOME = path.join(homePath, '.config')

    const now = Date.now()
    const stale = {
      type: 'oauth',
      access: 'expired-access',
      refresh: 'refresh-before-rotation',
      expires: now - 60_000,
      accountId: 'supergrok-account',
    }
    const rotated = {
      type: 'oauth',
      access: 'refreshed-access',
      refresh: 'refresh-after-rotation',
      expires: now + 3_600_000,
      accountId: 'supergrok-account',
    }

    try {
      const manager = new OpenCodeProfileManager()
      await upsertOpenCodeAuthCredential({
        authPath: manager.getGlobalAuthPath(),
        providerId: 'xai',
        credential: stale,
      })
      const activeProfile = await manager.prepareProfile(path.join(tempDir, 'active-project'), {
        includeAppMcp: false,
        includeManagedSubscriptionPlugins: false,
      })
      await upsertOpenCodeAuthCredential({
        authPath: activeProfile.managedAuthPath,
        providerId: 'xai',
        credential: rotated,
      })

      const restartedProfile = await manager.prepareProfile(path.join(tempDir, 'restarted-project'), {
        includeAppMcp: false,
        includeManagedSubscriptionPlugins: false,
      })

      await expect(Promise.all([
        readOpenCodeAuthCredential({ authPath: manager.getGlobalAuthPath(), providerId: 'xai' }),
        readOpenCodeAuthCredential({ authPath: activeProfile.managedAuthPath, providerId: 'xai' }),
        readOpenCodeAuthCredential({ authPath: restartedProfile.managedAuthPath, providerId: 'xai' }),
      ])).resolves.toEqual([rotated, rotated, rotated])
    } finally {
      if (previousDataHome === undefined) delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      else process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      if (previousCacheHome === undefined) delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      else process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previousXdgDataHome
      if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
    }
  }, 15_000)

  test('keeps app-managed LLM Gateway auth active when local OpenCode has a stale key', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const previousHome = process.env.HOME
    const previousXdgDataHome = process.env.XDG_DATA_HOME
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
    const appDataHome = path.join(tempDir, 'app-data-llmgateway')
    const appCacheHome = path.join(tempDir, 'app-cache-llmgateway')
    const homePath = path.join(tempDir, 'home-llmgateway')
    const localAuthPath = path.join(homePath, '.local', 'share', 'opencode', 'auth.json')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    process.env.HOME = homePath
    process.env.XDG_DATA_HOME = path.join(homePath, '.local', 'share')
    process.env.XDG_CONFIG_HOME = path.join(homePath, '.config')

    const freshCredential = { type: 'api', key: 'llmgateway-new-valid-key' }
    const staleCredential = { type: 'api', key: 'llmgateway-deleted-old-key' }

    try {
      const manager = new OpenCodeProfileManager()
      await Promise.all([
        upsertOpenCodeAuthCredential({
          authPath: manager.getGlobalAuthPath(),
          providerId: 'llmgateway',
          credential: freshCredential,
        }),
        upsertOpenCodeAuthCredential({
          authPath: localAuthPath,
          providerId: 'llmgateway',
          credential: staleCredential,
        }),
      ])

      const profile = await manager.prepareProfile(path.join(tempDir, 'llmgateway-project'), {
        includeAppMcp: false,
        includeManagedSubscriptionPlugins: false,
      })

      expect(profile.authState).toBe('ok')
      await expect(
        readOpenCodeAuthCredential({
          authPath: profile.managedAuthPath,
          providerId: 'llmgateway',
        }),
      ).resolves.toEqual(freshCredential)
      await expect(
        readOpenCodeAuthCredential({ authPath: localAuthPath, providerId: 'llmgateway' }),
      ).resolves.toEqual(staleCredential)
    } finally {
      if (previousDataHome === undefined) delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      else process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      if (previousCacheHome === undefined) delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      else process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previousXdgDataHome
      if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
    }
  }, 15_000)

  test('imports only safe user OpenCode config into managed profile content', async () => {
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
    const previousOpenCodeConfig = process.env.OPENCODE_CONFIG
    const previousOpenCodeConfigContent = process.env.OPENCODE_CONFIG_CONTENT
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-config-import')
    const appCacheHome = path.join(tempDir, 'app-cache-config-import')
    const xdgConfigHome = path.join(tempDir, 'real-xdg-config')
    const customConfigPath = path.join(tempDir, 'custom-opencode.jsonc')
    await mkdir(path.join(xdgConfigHome, 'opencode'), { recursive: true })
    await writeFile(
      path.join(xdgConfigHome, 'opencode', 'opencode.jsonc'),
      `{
        // Local Ollama route should be imported.
        "model": "ollama/qwen2.5-coder:0.5b",
        "provider": {
          "ollama": {
            "npm": "@ai-sdk/openai-compatible",
            "options": { "baseURL": "http://127.0.0.1:11434/v1" },
            "models": { "qwen2.5-coder:0.5b": {} }
          }
        },
        "mcp": { "unsafe": { "type": "local", "command": ["bad"] } },
        "permission": { "*": "allow" },
        "plugin": ["unsafe-plugin"],
        "agent": { "unsafe": { "mode": "primary" } }
      }`,
      'utf8',
    )
    await writeFile(
      customConfigPath,
      JSON.stringify({
        small_model: 'llama.cpp/qwen-test:0.5b',
        provider: {
          'llama.cpp': {
            npm: '@ai-sdk/openai-compatible',
            options: { baseURL: 'http://127.0.0.1:8080/v1' },
            models: { 'qwen-test:0.5b': {} },
          },
        },
        command: { unsafe: 'nope' },
      }),
      'utf8',
    )
    process.env.XDG_CONFIG_HOME = xdgConfigHome
    process.env.OPENCODE_CONFIG = customConfigPath
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      provider: {
        lmstudio: {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'http://localhost:1234/v1' },
          models: { 'google/gemma-3n-e4b': {} },
        },
      },
      command: { unsafeInline: 'nope' },
    })
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome

    try {
      const manager = new OpenCodeProfileManager()
      const profile = await manager.prepareProfile(path.join(tempDir, 'project-config-import'))
      const managedConfig = JSON.parse(profile.env.OPENCODE_CONFIG_CONTENT ?? '{}') as Record<string, unknown>
      const providers = managedConfig.provider as Record<string, unknown>
      const agents = managedConfig.agent as Record<string, unknown>
      const mcp = (managedConfig.mcp ?? {}) as Record<string, unknown>

      expect(profile.env.OPENCODE_CONFIG).toBeUndefined()
      expect(providers.ollama).toMatchObject({
        models: { 'qwen2.5-coder:0.5b': {} },
      })
      expect(providers['llama.cpp']).toMatchObject({
        options: { baseURL: 'http://127.0.0.1:8080/v1' },
      })
      expect(providers.lmstudio).toMatchObject({
        models: { 'google/gemma-3n-e4b': {} },
      })
      expect(managedConfig.model).toBe('ollama/qwen2.5-coder:0.5b')
      expect(profile.importedConfigDefaultModelId).toBe('ollama/qwen2.5-coder:0.5b')
      expect(managedConfig.small_model).toBe('llama.cpp/qwen-test:0.5b')
      expect(managedConfig.plugin).toEqual([
        'opencode-kiro@0.4.0',
        '@rama_nigg/open-cursor@2.5.2',
      ])
      expect(managedConfig).not.toHaveProperty('permission')
      expect(managedConfig).not.toHaveProperty('command')
      expect(mcp.unsafe).toBeUndefined()
      expect(agents.teammate).toBeDefined()
      expect(agents.unsafe).toBeUndefined()
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome
      }
      if (previousOpenCodeConfig === undefined) {
        delete process.env.OPENCODE_CONFIG
      } else {
        process.env.OPENCODE_CONFIG = previousOpenCodeConfig
      }
      if (previousOpenCodeConfigContent === undefined) {
        delete process.env.OPENCODE_CONFIG_CONTENT
      } else {
        process.env.OPENCODE_CONFIG_CONTENT = previousOpenCodeConfigContent
      }
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
    }
  })

  test('imports Ollama Cloud model routes from user opencode.json', async () => {
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
    const previousOpenCodeConfig = process.env.OPENCODE_CONFIG
    const previousOpenCodeConfigContent = process.env.OPENCODE_CONFIG_CONTENT
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-ollama-cloud-import')
    const appCacheHome = path.join(tempDir, 'app-cache-ollama-cloud-import')
    const xdgConfigHome = path.join(tempDir, 'xdg-config-ollama-cloud')
    await mkdir(path.join(xdgConfigHome, 'opencode'), { recursive: true })
    await writeFile(
      path.join(xdgConfigHome, 'opencode', 'opencode.json'),
      JSON.stringify({
        model: 'ollama/kimi-k2.6:cloud',
        provider: {
          ollama: {
            models: {
              'kimi-k2.6:cloud': {
                limit: {
                  context: 262_144,
                  output: 262_144,
                },
                attachment: true,
                modalities: {
                  input: ['text', 'image'],
                  output: ['text'],
                },
                name: 'kimi-k2.6:cloud',
              },
              'deepseek-v4-flash:cloud': {
                limit: {
                  context: 1_000_000,
                  output: 1_000_000,
                },
                name: 'deepseek-v4-flash:cloud',
              },
            },
          },
        },
      }),
      'utf8',
    )
    process.env.XDG_CONFIG_HOME = xdgConfigHome
    delete process.env.OPENCODE_CONFIG
    delete process.env.OPENCODE_CONFIG_CONTENT
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome

    try {
      const profile = await new OpenCodeProfileManager().prepareProfile(
        path.join(tempDir, 'project-ollama-cloud-import'),
      )
      const managedConfig = JSON.parse(profile.env.OPENCODE_CONFIG_CONTENT ?? '{}') as Record<string, unknown>
      const providers = managedConfig.provider as Record<string, unknown>

      expect(managedConfig.model).toBe('ollama/kimi-k2.6:cloud')
      expect(providers.ollama).toMatchObject({
        models: {
          'kimi-k2.6:cloud': {
            limit: {
              context: 262_144,
              output: 262_144,
            },
            attachment: true,
            modalities: {
              input: ['text', 'image'],
              output: ['text'],
            },
            name: 'kimi-k2.6:cloud',
          },
          'deepseek-v4-flash:cloud': {
            limit: {
              context: 1_000_000,
              output: 1_000_000,
            },
            name: 'deepseek-v4-flash:cloud',
          },
        },
      })
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome
      }
      if (previousOpenCodeConfig === undefined) {
        delete process.env.OPENCODE_CONFIG
      } else {
        process.env.OPENCODE_CONFIG = previousOpenCodeConfig
      }
      if (previousOpenCodeConfigContent === undefined) {
        delete process.env.OPENCODE_CONFIG_CONTENT
      } else {
        process.env.OPENCODE_CONFIG_CONTENT = previousOpenCodeConfigContent
      }
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
    }
  })

  test('exposes an app-owned global auth path separate from the real OpenCode auth store', () => {
    const previousXdgDataHome = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = tempDir
    try {
      const manager = new OpenCodeProfileManager()
      const realOpenCodeAuthPath = path.join(tempDir, 'opencode', 'auth.json')
      const globalAuthPath = manager.getGlobalAuthPath()
      expect(globalAuthPath).not.toBe(realOpenCodeAuthPath)
      expect(globalAuthPath.endsWith(path.join('opencode', 'auth.json'))).toBe(true)
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome
      }
    }
  })

  test('keeps generated OpenCode dependency caches outside per-profile HOME', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const previousMcpCommand = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND
    const previousMcpEntry = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY
    const previousMcpArgsJson = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON
    const previousMcpUrl = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
    const appDataHome = path.join(tempDir, 'app-data')
    const appCacheHome = path.join(tempDir, 'app-cache')
    const mcpEntryPath = path.join(tempDir, 'agent-teams-mcp.js')
    await writeFile(mcpEntryPath, 'process.stdin.resume()\n', 'utf8')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = process.execPath
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY = mcpEntryPath
    delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON
    delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
    try {
      const manager = new OpenCodeProfileManager()
      const profile = await manager.prepareProfile(path.join(tempDir, 'project'))
      const profileNodeModulesPath = path.join(profile.xdgConfigHome, 'opencode', 'node_modules')
      const sharedNodeModulesPath = path.join(profile.xdgCacheHome, 'config-node_modules')
      const tmpStat = await lstat(profile.tmpPath)
      const nodeModulesStat = await lstat(profileNodeModulesPath)
      const nodeModulesTarget = await readlink(profileNodeModulesPath)
      const appMcpConfig = (
        profile.managedConfig.mcp as Record<string, { environment?: Record<string, string> }>
      )?.['agent-teams']

      expect(profile.profileRootPath.startsWith(path.join(appDataHome, 'opencode', 'profiles'))).toBe(true)
      expect(profile.tmpPath).toBe(path.join(profile.profileRootPath, 'tmp'))
      expect(profile.env.TMPDIR).toBe(profile.tmpPath)
      expect(profile.env.TMP).toBe(profile.tmpPath)
      expect(profile.env.TEMP).toBe(profile.tmpPath)
      expect(tmpStat.isDirectory()).toBe(true)
      expect(profile.xdgCacheHome).toBe(path.join(appCacheHome, 'opencode', 'shared-cache'))
      expect(profile.env.NPM_CONFIG_CACHE).toBe(path.join(profile.xdgCacheHome, 'npm'))
      expect(profile.env.PLAYWRIGHT_BROWSERS_PATH).toBe(
        path.join(profile.xdgCacheHome, 'tools', 'ms-playwright'),
      )
      expect(profile.env.PUPPETEER_CACHE_DIR).toBe(
        path.join(profile.xdgCacheHome, 'tools', 'puppeteer'),
      )
      expect(profile.env.PIP_CACHE_DIR).toBe(path.join(profile.xdgCacheHome, 'tools', 'pip'))
      expect(profile.env.UV_CACHE_DIR).toBe(path.join(profile.xdgCacheHome, 'tools', 'uv'))
      expect(profile.env.npm_config_devdir).toBe(
        path.join(profile.xdgCacheHome, 'tools', 'node-gyp'),
      )
      expect(profile.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]).toBe(appDataHome)
      expect(profile.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]).toBe(appCacheHome)
      expect(appMcpConfig?.environment?.[CLAUDE_MULTIMODEL_DATA_HOME_ENV]).toBe(appDataHome)
      expect(appMcpConfig?.environment?.[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]).toBe(appCacheHome)
      expect(nodeModulesStat.isSymbolicLink()).toBe(true)
      expect(path.resolve(path.dirname(profileNodeModulesPath), nodeModulesTarget)).toBe(sharedNodeModulesPath)
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
      if (previousMcpCommand === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND
      } else {
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = previousMcpCommand
      }
      if (previousMcpEntry === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY
      } else {
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY = previousMcpEntry
      }
      if (previousMcpArgsJson === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON
      } else {
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON = previousMcpArgsJson
      }
      if (previousMcpUrl === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
      } else {
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = previousMcpUrl
      }
    }
  })

  test('does not add local environment keys to remote app MCP config', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const previousMcpUrl = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = path.join(tempDir, 'app-data-remote-mcp')
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = path.join(tempDir, 'app-cache-remote-mcp')
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = 'http://127.0.0.1:41004/mcp'
    try {
      const manager = new OpenCodeProfileManager()
      const profile = await manager.prepareProfile(path.join(tempDir, 'project-remote-mcp'))
      const appMcpConfig = (
        profile.managedConfig.mcp as Record<string, { environment?: Record<string, string> }>
      )?.['agent-teams']

      expect(appMcpConfig).toMatchObject({
        type: 'remote',
        url: 'http://127.0.0.1:41004/mcp',
      })
      expect(appMcpConfig?.environment).toBeUndefined()
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
      if (previousMcpUrl === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
      } else {
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = previousMcpUrl
      }
    }
  })

  test('repairs profile node_modules when a real directory was left behind', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-repair')
    const appCacheHome = path.join(tempDir, 'app-cache-repair')
    const projectPath = path.join(tempDir, 'project-repair')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    try {
      await mkdir(projectPath, { recursive: true })
      const manager = new OpenCodeProfileManager()
      const firstProfile = await manager.prepareProfile(projectPath)
      const profileNodeModulesPath = path.join(
        firstProfile.xdgConfigHome,
        'opencode',
        'node_modules',
      )
      const sharedNodeModulesPath = path.join(
        firstProfile.xdgCacheHome,
        'config-node_modules',
      )
      const sharedExistingPackagePath = path.join(
        sharedNodeModulesPath,
        'existing-shared-package',
      )
      await mkdir(sharedExistingPackagePath, { recursive: true })
      await writeFile(
        path.join(sharedExistingPackagePath, 'package.json'),
        '{"source":"shared-cache"}\n',
        'utf8',
      )
      await rm(profileNodeModulesPath, { recursive: true, force: true })
      const manuallyInstalledPackagePath = path.join(
        profileNodeModulesPath,
        'manually-installed-package',
      )
      await mkdir(manuallyInstalledPackagePath, { recursive: true })
      await writeFile(
        path.join(manuallyInstalledPackagePath, 'package.json'),
        '{"name":"manually-installed-package"}\n',
        'utf8',
      )
      const conflictingProfilePackagePath = path.join(
        profileNodeModulesPath,
        'existing-shared-package',
      )
      await mkdir(conflictingProfilePackagePath, { recursive: true })
      await writeFile(
        path.join(conflictingProfilePackagePath, 'package.json'),
        '{"source":"profile-directory"}\n',
        'utf8',
      )

      const repairedProfile = await manager.prepareProfile(projectPath)
      const repairedStat = await lstat(profileNodeModulesPath)
      const repairedTarget = await readlink(profileNodeModulesPath)

      expect(repairedProfile.profileRootKey).toBe(firstProfile.profileRootKey)
      expect(repairedStat.isSymbolicLink()).toBe(true)
      expect(path.resolve(path.dirname(profileNodeModulesPath), repairedTarget)).toBe(
        sharedNodeModulesPath,
      )
      expect(
        await readFile(
          path.join(sharedNodeModulesPath, 'manually-installed-package', 'package.json'),
          'utf8',
        ),
      ).toBe(
        '{"name":"manually-installed-package"}\n',
      )
      expect(
        await readFile(
          path.join(sharedNodeModulesPath, 'existing-shared-package', 'package.json'),
          'utf8',
        ),
      ).toBe('{"source":"shared-cache"}\n')
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
    }
  })

  test('preserves populated shared config node_modules across profile preparation', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-preserve-config-modules')
    const appCacheHome = path.join(tempDir, 'app-cache-preserve-config-modules')
    const projectPath = path.join(tempDir, 'project-preserve-config-modules')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    try {
      await mkdir(projectPath, { recursive: true })
      const manager = new OpenCodeProfileManager()
      const firstProfile = await manager.prepareProfile(projectPath, {
        includeAppMcp: false,
        includeManagedSubscriptionPlugins: false,
      })
      const sharedNodeModulesPath = path.join(
        firstProfile.xdgCacheHome,
        'config-node_modules',
      )
      const profileNodeModulesPath = path.join(
        firstProfile.xdgConfigHome,
        'opencode',
        'node_modules',
      )
      const markerPath = path.join(sharedNodeModulesPath, 'installed-package.marker')
      await writeFile(markerPath, 'preserve me\n', 'utf8')

      const secondProfile = await manager.prepareProfile(projectPath, {
        includeAppMcp: false,
        includeManagedSubscriptionPlugins: false,
      })
      const nodeModulesStat = await lstat(profileNodeModulesPath)
      const nodeModulesTarget = await readlink(profileNodeModulesPath)

      expect(secondProfile.profileRootKey).toBe(firstProfile.profileRootKey)
      expect(await readFile(markerPath, 'utf8')).toBe('preserve me\n')
      expect(nodeModulesStat.isSymbolicLink()).toBe(true)
      expect(path.resolve(path.dirname(profileNodeModulesPath), nodeModulesTarget)).toBe(
        sharedNodeModulesPath,
      )
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
    }
  })

  test('repairs an empty managed OpenCode plugin cache after an interrupted install', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-plugin-repair')
    const appCacheHome = path.join(tempDir, 'app-cache-plugin-repair')
    const projectPath = path.join(tempDir, 'project-plugin-repair')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    try {
      await mkdir(projectPath, { recursive: true })
      const manager = new OpenCodeProfileManager()
      const firstProfile = await manager.prepareProfile(projectPath)
      const interruptedCachePath = path.join(
        firstProfile.xdgCacheHome,
        'opencode',
        'packages',
        'opencode-kiro@0.4.0',
      )
      await mkdir(interruptedCachePath, { recursive: true })

      await manager.prepareProfile(projectPath)

      const interruptedCacheStillExists = await lstat(interruptedCachePath)
        .then(() => true)
        .catch(() => false)
      expect(interruptedCacheStillExists).toBe(false)
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
    }
  })

  test('serializes concurrent profile preparation for the same project profile', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-concurrent')
    const appCacheHome = path.join(tempDir, 'app-cache-concurrent')
    const projectPath = path.join(tempDir, 'project-concurrent')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    try {
      await mkdir(projectPath, { recursive: true })
      const manager = new OpenCodeProfileManager()
      const prepareOptions = {
        includeAppMcp: false,
        includeManagedSubscriptionPlugins: false,
      } as const
      const firstProfile = await manager.prepareProfile(projectPath, prepareOptions)
      const profileNodeModulesPath = path.join(
        firstProfile.xdgConfigHome,
        'opencode',
        'node_modules',
      )
      await rm(profileNodeModulesPath, { recursive: true, force: true })
      await mkdir(profileNodeModulesPath, { recursive: true })

      const profiles = await Promise.all(
        Array.from({ length: 8 }, () => manager.prepareProfile(projectPath, prepareOptions)),
      )
      const repairedStat = await lstat(profileNodeModulesPath)
      const repairedTarget = await readlink(profileNodeModulesPath)

      expect(new Set(profiles.map(profile => profile.profileRootKey))).toEqual(
        new Set([firstProfile.profileRootKey]),
      )
      expect(repairedStat.isSymbolicLink()).toBe(true)
      expect(path.resolve(path.dirname(profileNodeModulesPath), repairedTarget)).toBe(
        path.join(firstProfile.xdgCacheHome, 'config-node_modules'),
      )
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
    }
  }, 15_000)

  test('keeps later profile preparation queued when an earlier waiter is aborted', async () => {
    const manager = new OpenCodeProfileManager() as unknown as {
      withProfilePreparationLock<T>(
        profileRootKey: string,
        operation: () => Promise<T>,
        abortSignal?: AbortSignal,
      ): Promise<T>
    }
    let markFirstStarted!: () => void
    let releaseFirst!: () => void
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve
    })
    const firstRelease = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    let firstActive = false
    const first = manager.withProfilePreparationLock('abort-queue', async () => {
      firstActive = true
      markFirstStarted()
      try {
        await firstRelease
      } finally {
        firstActive = false
      }
    })
    await firstStarted

    const controller = new AbortController()
    const timeout = new Error('profile preparation deadline expired')
    let abortedOperationCalled = false
    const aborted = manager.withProfilePreparationLock('abort-queue', async () => {
      abortedOperationCalled = true
    }, controller.signal)
    controller.abort(timeout)
    await expect(aborted).rejects.toBe(timeout)

    let laterOperationCalled = false
    const later = manager.withProfilePreparationLock('abort-queue', async () => {
      laterOperationCalled = true
      expect(firstActive).toBe(false)
    })

    try {
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(abortedOperationCalled).toBe(false)
      expect(laterOperationCalled).toBe(false)
    } finally {
      releaseFirst()
      await first
      await later
    }
    expect(laterOperationCalled).toBe(true)
  })

  test('handles profile node_modules repair across separate process preparation races', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-process-race')
    const appCacheHome = path.join(tempDir, 'app-cache-process-race')
    const projectPath = path.join(tempDir, 'project-process-race')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    try {
      await mkdir(projectPath, { recursive: true })
      const manager = new OpenCodeProfileManager()
      const firstProfile = await manager.prepareProfile(projectPath, { includeAppMcp: false })
      const profileNodeModulesPath = path.join(
        firstProfile.xdgConfigHome,
        'opencode',
        'node_modules',
      )
      await rm(profileNodeModulesPath, { recursive: true, force: true })
      await mkdir(profileNodeModulesPath, { recursive: true })
      await writeFile(path.join(profileNodeModulesPath, 'stale.txt'), 'stale directory\n', 'utf8')

      const profileManagerUrl = pathToFileURL(
        path.resolve('src/services/opencode/OpenCodeProfileManager.ts'),
      ).href
      const scriptPath = path.join(tempDir, 'prepare-opencode-profile.mjs')
      await writeFile(
        scriptPath,
        `const { OpenCodeProfileManager } = await import(${JSON.stringify(profileManagerUrl)});
const startAt = Number(process.argv[3]);
while (Date.now() < startAt) {
  await Bun.sleep(5);
}
await new OpenCodeProfileManager().prepareProfile(process.argv[2], { includeAppMcp: false });
`,
        'utf8',
      )
      const childEnv = {
        ...process.env,
        [CLAUDE_MULTIMODEL_DATA_HOME_ENV]: appDataHome,
        [CLAUDE_MULTIMODEL_CACHE_HOME_ENV]: appCacheHome,
      }

      const startAt = String(Date.now() + 750)
      await Promise.all(Array.from(
        { length: 12 },
        () => runBunScript(scriptPath, [projectPath, startAt], childEnv),
      ))

      const repairedStat = await lstat(profileNodeModulesPath)
      const repairedTarget = await readlink(profileNodeModulesPath)
      expect(repairedStat.isSymbolicLink()).toBe(true)
      expect(path.resolve(path.dirname(profileNodeModulesPath), repairedTarget)).toBe(
        path.join(firstProfile.xdgCacheHome, 'config-node_modules'),
      )
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
    }
  }, 20_000)

  test('syncs app-global OpenCode auth before real local auth so fresh login wins conflicts', () => {
    expect(
      orderOpenCodeAuthSyncSources({
        globalAuthPath: '/Users/test/Library/Application Support/claude-multimodel-nodejs/opencode/auth.json',
        globalAuthFingerprint: 'old-global-openai',
        sourceAuthPath: '/Users/test/.local/share/opencode/auth.json',
        sourceAuthFingerprint: 'fresh-local-openai',
      })
    ).toEqual([
      '/Users/test/Library/Application Support/claude-multimodel-nodejs/opencode/auth.json',
      '/Users/test/.local/share/opencode/auth.json',
    ])
  })

  test('keeps canonical user OpenCode auth after isolated XDG auth sources', () => {
    expect(
      orderOpenCodeAuthSyncSources({
        globalAuthPath: '/Users/test/Library/Application Support/claude-multimodel-nodejs/opencode/auth.json',
        globalAuthFingerprint: 'old-global-openai',
        sourceAuthSources: [
          {
            path: '/tmp/isolated-xdg/opencode/auth.json',
            fingerprint: null,
          },
          {
            path: '/Users/test/.local/share/opencode/auth.json',
            fingerprint: 'fresh-local-openai',
          },
        ],
      })
    ).toEqual([
      '/Users/test/Library/Application Support/claude-multimodel-nodejs/opencode/auth.json',
      '/Users/test/.local/share/opencode/auth.json',
    ])
  })

  test('changes managed config fingerprint across behavior-affecting MCP environment values', async () => {
    const launchBase = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/usr/local/bin/node',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/tmp/agent-teams-mcp.js',
        HOME: '/Users/test',
        PATH: '/usr/local/bin:/usr/bin',
      },
      pathExists: async () => false,
    })
    const launchVolatile = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/usr/local/bin/node',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/tmp/agent-teams-mcp.js',
        HOME: '/Users/test',
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin',
        TMPDIR: '/var/folders/runtime-a',
        CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43123',
      },
      pathExists: async () => false,
    })
    const baseFingerprint = buildManagedConfigFingerprint(buildManagedConfig(launchBase.config))
    const volatileFingerprint = buildManagedConfigFingerprint(
      buildManagedConfig(launchVolatile.config)
    )

    expect(volatileFingerprint).not.toBe(baseFingerprint)
    expect(volatileFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(volatileFingerprint).not.toContain('43123')
    expect(volatileFingerprint).not.toContain('/var/folders/runtime-a')
  })

  test('changes managed config fingerprint across remote app MCP URL changes without leaking it', async () => {
    const launchFirst = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:41001/mcp',
      },
      pathExists: async () => false,
    })
    const launchSecond = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:41002/mcp',
      },
      pathExists: async () => false,
    })

    const first = buildManagedConfigFingerprint(buildManagedConfig(launchFirst.config))
    const second = buildManagedConfigFingerprint(buildManagedConfig(launchSecond.config))
    expect(second).not.toBe(first)
    expect(second).not.toContain('41002')
  })

  test('still changes managed config fingerprint when the MCP command changes', async () => {
    const launchNode = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/usr/local/bin/node',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/tmp/agent-teams-mcp.js',
      },
      pathExists: async () => false,
    })
    const launchBun = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/Users/belief/.bun/bin/bun',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/tmp/agent-teams-mcp.js',
      },
      pathExists: async () => false,
    })

    expect(
      buildManagedConfigFingerprint(buildManagedConfig(launchNode.config))
    ).not.toBe(buildManagedConfigFingerprint(buildManagedConfig(launchBun.config)))
  })

  test('disables OpenCode auto-update by default but keeps an explicit app override possible', () => {
    const managedConfig = buildManagedConfig()
    const overrideConfig = buildManagedConfig(null, { allowAutoUpdate: true })

    expect(managedConfig.autoupdate).toBe(false)
    expect(overrideConfig).not.toHaveProperty('autoupdate')
    expect(applyOpenCodeAutoUpdatePolicy({}).OPENCODE_DISABLE_AUTOUPDATE).toBe('1')
    expect(
      applyOpenCodeAutoUpdatePolicy({
        CLAUDE_TEAM_OPENCODE_ALLOW_AUTOUPDATE: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
      }).OPENCODE_DISABLE_AUTOUPDATE,
    ).toBeUndefined()
  })

  test('adds an app-managed default model only when explicitly configured', () => {
    const managedConfig = buildManagedConfig(null, {
      defaultModelId: 'openrouter/openai/gpt-oss-20b:free',
    })

    expect(managedConfig.model).toBe('openrouter/openai/gpt-oss-20b:free')
    expect(buildManagedConfig().model).toBeUndefined()
  })

  test('applies all-projects default to project profiles without overrides', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-all-projects-default')
    const appCacheHome = path.join(tempDir, 'app-cache-all-projects-default')
    const projectA = path.join(tempDir, 'project-a')
    const projectB = path.join(tempDir, 'project-b')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome

    try {
      await mkdir(projectA, { recursive: true })
      await mkdir(projectB, { recursive: true })
      await setOpenCodeManagedGlobalDefaultModel(
        appDataHome,
        'openrouter/openai/gpt-oss-20b:free',
      )

      const manager = new OpenCodeProfileManager()
      const profileA = await manager.prepareProfile(projectA, { includeAppMcp: false })
      const profileB = await manager.prepareProfile(projectB, { includeAppMcp: false })

      expect(profileA.managedConfig.model).toBe('openrouter/openai/gpt-oss-20b:free')
      expect(profileB.managedConfig.model).toBe('openrouter/openai/gpt-oss-20b:free')
      expect(profileA.projectDefaultModelId).toBeNull()
      expect(profileA.allProjectsDefaultModelId).toBe('openrouter/openai/gpt-oss-20b:free')
      expect(profileA.effectiveManagedDefaultSource).toBe('all_projects')
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
    }
  })

  test('project default overrides all-projects default', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-project-default-wins')
    const appCacheHome = path.join(tempDir, 'app-cache-project-default-wins')
    const projectPath = path.join(tempDir, 'project-default-wins')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome

    try {
      await mkdir(projectPath, { recursive: true })
      await setOpenCodeManagedGlobalDefaultModel(appDataHome, 'openrouter/global-model')
      const manager = new OpenCodeProfileManager()
      const initialProfile = await manager.prepareProfile(projectPath, { includeAppMcp: false })
      await setOpenCodeManagedDefaultModel(initialProfile.profileRootPath, 'openrouter/project-model')

      const profile = await manager.prepareProfile(projectPath, { includeAppMcp: false })

      expect(profile.managedConfig.model).toBe('openrouter/project-model')
      expect(profile.projectDefaultModelId).toBe('openrouter/project-model')
      expect(profile.allProjectsDefaultModelId).toBe('openrouter/global-model')
      expect(profile.effectiveManagedDefaultSource).toBe('project')
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
    }
  })

  test('applies app-managed local model limits without changing user or project config', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-local-limits')
    const appCacheHome = path.join(tempDir, 'app-cache-local-limits')
    const projectPath = path.join(tempDir, 'project-local-limits')
    const projectConfigPath = path.join(projectPath, 'opencode.json')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome

    try {
      await mkdir(projectPath, { recursive: true })
      await writeFile(
        projectConfigPath,
        JSON.stringify({ provider: { local: { models: { qwen: { name: 'Qwen local' } } } } }),
      )
      const originalProjectConfig = await readFile(projectConfigPath, 'utf8')
      const manager = new OpenCodeProfileManager()
      const initialProfile = await manager.prepareProfile(projectPath, { includeAppMcp: false })
      await setOpenCodeManagedModelLimits(initialProfile.profileRootPath, {
        modelId: 'local/qwen',
        contextTokens: 128_000,
        outputTokens: 32_000,
      })

      const profile = await manager.prepareProfile(projectPath, { includeAppMcp: false })

      expect(profile.managedConfig).toMatchObject({
        provider: {
          local: {
            models: {
              qwen: {
                limit: { context: 128_000, output: 32_000 },
              },
            },
          },
        },
      })
      expect(await readFile(projectConfigPath, 'utf8')).toBe(originalProjectConfig)
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
    }
  }, 15_000)

  test('can cap a provider-scoped model output limit in managed config overrides', () => {
    const managedConfig = buildManagedConfig(null, {
      modelOutputLimitOverrides: [
        {
          modelId: 'openrouter/anthropic/claude-3.5-haiku',
          outputTokens: 512,
          contextTokens: 32_000,
        },
      ],
    })

    expect(managedConfig.provider).toMatchObject({
      atlascloud: {
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: 'https://api.atlascloud.ai/v1',
        },
        models: {
          'zai-org/glm-5.1': {
            tool_call: true,
          },
        },
      },
      openrouter: {
        models: {
          'anthropic/claude-3.5-haiku': {
            limit: {
              context: 32_000,
              output: 512,
            },
          },
        },
      },
    })
  })
})
