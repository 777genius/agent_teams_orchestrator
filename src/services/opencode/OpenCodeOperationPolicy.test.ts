import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import {
  canonicalSerializeOpenCodePolicyIdentity,
  planScopedProfile,
  resolveOpenCodeOperationPolicy,
  type OpenCodeOperationIdentityFingerprints,
  type OpenCodeOperationPurpose,
} from './OpenCodeOperationPolicy.js'
import type { OpenCodePlanScopedProfileInput } from './types.js'

const PURPOSES: OpenCodeOperationPurpose[] = [
  'passive-status',
  'provider-catalog',
  'provider-connect',
  'execution-probe',
  'launch',
  'session-resume',
  'legacy-diagnostic',
]

const PROVIDERS = ['kiro', 'cursor-acp', 'deepinfra', 'custom', 'other'] as const

const PROVIDER_REQUIRED_PURPOSES: OpenCodeOperationPurpose[] = [
  'provider-catalog',
  'provider-connect',
  'execution-probe',
  'launch',
  'session-resume',
]

const fingerprints: OpenCodeOperationIdentityFingerprints = {
  project: 'project-fingerprint',
  model: 'model-fingerprint',
  policy: 'policy-fingerprint',
  plugin: 'plugin-fingerprint',
  version: 'version-fingerprint',
  config: 'config-fingerprint',
  auth: 'auth-fingerprint',
  environment: 'environment-fingerprint',
  binary: 'binary-fingerprint',
  layout: 'layout-fingerprint',
}

const sha256 = (value: unknown): string => createHash('sha256')
  .update(typeof value === 'string' ? value : canonicalSerializeOpenCodePolicyIdentity(value))
  .digest('hex')

function fakeScopedPlanInput(): OpenCodePlanScopedProfileInput {
  const bytesBase64 = Buffer.from('{"name":"opencode-kiro","version":"0.4.0"}').toString('base64')
  const treeIdentity = [{
    path: 'opencode-kiro/package.json',
    mode: 0o400,
    fingerprint: sha256(Buffer.from(bytesBase64, 'base64').toString()),
  }]
  const dependencyTreeFingerprint = sha256(treeIdentity)
  const packageIntegrity = `sha512-${createHash('sha512')
    .update(dependencyTreeFingerprint)
    .digest('base64')}`
  const resolvedIdentity = `sha256:${sha256({
    packageName: 'opencode-kiro',
    version: '0.4.0',
    packageIntegrity,
    manifestFingerprint: sha256(Buffer.from(bytesBase64, 'base64').toString()),
    dependencyTreeFingerprint,
  })}`
  return {
    purpose: 'launch',
    providerId: 'kiro',
    modelId: 'kiro/model',
    runtimeInstanceId: 'runtime-a',
    projectPath: '/redacted/project',
    evidence: {
      canonicalProjectPathFingerprint: sha256('project-path'),
      projectBehaviorFingerprint: sha256('project-behavior'),
      providerEnvironmentFingerprint: sha256('provider-environment'),
      selectedAuthFingerprint: sha256('selected-auth'),
      binaryFingerprint: sha256('binary'),
      configFingerprint: sha256('config'),
      nativeAccountIdentityFingerprint: sha256('official-account-id'),
      nativeAccountIdentitySource: 'official-provider-cli',
      nativeTargetExecutableFingerprint: sha256('native-target'),
      profileLayoutFingerprint: sha256('layout'),
      plugins: [{
        spec: 'opencode-kiro@0.4.0',
        provenance: 'app-managed',
        dependencyTreeFingerprint,
        resolvedIdentity,
        immutableTreeEntries: [{
          path: 'opencode-kiro/package.json',
          bytesBase64,
          mode: 0o400,
        }],
      }],
    },
  }
}

function bindFakePluginTree(
  input: OpenCodePlanScopedProfileInput,
  manifests: Array<{ path: string; manifest: Record<string, unknown> }>,
): void {
  const plugin = input.evidence.plugins[0]!
  plugin.immutableTreeEntries = manifests.map(({ path, manifest }) => ({
    path,
    bytesBase64: Buffer.from(JSON.stringify(manifest)).toString('base64'),
    mode: 0o400 as const,
  }))
  rebindFakePluginEvidence(input)
}

function rebindFakePluginEvidence(input: OpenCodePlanScopedProfileInput): void {
  const plugin = input.evidence.plugins[0]!
  const treeIdentity = plugin.immutableTreeEntries.map(entry => ({
    path: entry.path,
    mode: entry.mode,
    fingerprint: sha256(Buffer.from(entry.bytesBase64, 'base64').toString()),
  })).sort((left, right) => left.path.localeCompare(right.path))
  plugin.dependencyTreeFingerprint = sha256(treeIdentity)
  const rootBytes = Buffer.from(plugin.immutableTreeEntries.find(
    entry => entry.path === 'opencode-kiro/package.json',
  )!.bytesBase64, 'base64')
  const packageIntegrity = `sha512-${createHash('sha512')
    .update(plugin.dependencyTreeFingerprint).digest('base64')}`
  plugin.resolvedIdentity = `sha256:${sha256({
    packageName: 'opencode-kiro',
    version: '0.4.0',
    packageIntegrity,
    manifestFingerprint: sha256(rootBytes.toString()),
    dependencyTreeFingerprint: plugin.dependencyTreeFingerprint,
  })}`
}

describe('OpenCodeOperationPolicy', () => {
  test('binds automatic user-plugin content independently of runtime instance identity', () => {
    const baseline = fakeScopedPlanInput()
    baseline.evidence.automaticUserPluginFingerprint = sha256('automatic-plugin-a')
    const changed = fakeScopedPlanInput()
    changed.evidence.automaticUserPluginFingerprint = sha256('automatic-plugin-b')
    expect(planScopedProfile(changed).expectedHostKey)
      .not.toBe(planScopedProfile(baseline).expectedHostKey)
    expect(planScopedProfile({ ...baseline, runtimeInstanceId: 'another-runtime' }).expectedHostKey)
      .toBe(planScopedProfile(baseline).expectedHostKey)
  })
  test('pure scoped plans are stable, frozen, redacted, and runtime-instance independent', () => {
    const input = fakeScopedPlanInput()
    const first = planScopedProfile(input)
    const second = planScopedProfile({ ...input, runtimeInstanceId: 'runtime-b' })

    expect(second).toEqual(first)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.plugins)).toBe(true)
    expect(first.expectedHostKey).toMatch(/^opencode-host-v2:[a-f0-9]{64}$/)
    expect(JSON.stringify(first)).not.toContain('/redacted/project')
    expect(JSON.stringify(first)).not.toContain('official-account-id')
    expect(JSON.stringify(first)).not.toContain('bytesBase64')
  })

  test('every immutable planning identity mutation changes the plan digest', () => {
    const baseline = fakeScopedPlanInput()
    const baselineDigest = planScopedProfile(baseline).digest
    const digestFields = [
      'canonicalProjectPathFingerprint', 'projectBehaviorFingerprint',
      'providerEnvironmentFingerprint', 'selectedAuthFingerprint',
      'binaryFingerprint', 'configFingerprint', 'nativeAccountIdentityFingerprint',
      'nativeTargetExecutableFingerprint', 'profileLayoutFingerprint',
    ] as const
    for (const field of digestFields) {
      const changed = structuredClone(baseline)
      changed.evidence[field] = sha256(`changed-${field}`)
      expect(planScopedProfile(changed).digest).not.toBe(baselineDigest)
    }
    const changedPurpose = structuredClone(baseline)
    changedPurpose.purpose = 'session-resume'
    expect(planScopedProfile(changedPurpose).digest).not.toBe(baselineDigest)
    const changedModel = structuredClone(baseline)
    changedModel.modelId = 'kiro/other-model'
    expect(planScopedProfile(changedModel).digest).not.toBe(baselineDigest)
  })

  test('fails closed without official Kiro account and immutable package evidence', () => {
    const ambiguousAccount = fakeScopedPlanInput()
    ambiguousAccount.evidence.nativeAccountIdentitySource = 'managed-auth'
    expect(() => planScopedProfile(ambiguousAccount)).toThrow('official stable account identity')

    const noPackageBytes = fakeScopedPlanInput()
    noPackageBytes.evidence.plugins[0]!.immutableTreeEntries = []
    expect(() => planScopedProfile(noPackageBytes)).toThrow('dependency tree is unavailable')

    const mutatedPackage = fakeScopedPlanInput()
    mutatedPackage.evidence.plugins[0]!.immutableTreeEntries[0]!.bytesBase64 =
      Buffer.from('{"name":"opencode-kiro","version":"MUTATED"}').toString('base64')
    expect(() => planScopedProfile(mutatedPackage)).toThrow('tree fingerprint mismatch')
  })

  test('rejects mutable and non-registry plugin package specifiers', () => {
    for (const spec of [
      'opencode-kiro@latest', 'opencode-kiro@^0.4.0', 'opencode-kiro@~0.4.0',
      'opencode-kiro@workspace:*', 'opencode-kiro@file:../plugin',
      'opencode-kiro@git+https://example.invalid/plugin.git', '../plugin',
    ]) {
      const input = fakeScopedPlanInput()
      input.evidence.plugins[0]!.spec = spec
      expect(() => planScopedProfile(input)).toThrow('exact registry package version')
    }
  })

  test('accepts ordinary mutable specs only when bound to an explicit resolved local tree name', () => {
    for (const spec of [
      'opencode-kiro', 'opencode-kiro@latest', 'file:../plugin',
      'https://plugins.example.invalid/plugin.tgz',
    ]) {
      const input = fakeScopedPlanInput()
      input.evidence.plugins[0] = {
        ...input.evidence.plugins[0]!, spec, packageName: 'opencode-kiro', provenance: 'user',
      }
      const planned = planScopedProfile(input)
      expect(planned.plugins[0]).toMatchObject({
        spec, provenance: 'user', executionSpecifier: 'file:./node_modules/opencode-kiro',
      })
      expect(planned.plugins[0]!.resolvedIdentity).toBe(input.evidence.plugins[0]!.resolvedIdentity)
    }
  })

  test('derives package integrity, manifest digest, and lock binding and rejects missing closure', () => {
    const planned = planScopedProfile(fakeScopedPlanInput())
    expect(planned.plugins[0]!.packageIntegrity).toMatch(/^sha512-/)
    expect(planned.plugins[0]!.manifestFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(planned.plugins[0]!.lockBindingFingerprint).toBe(
      planned.plugins[0]!.resolvedIdentity.slice('sha256:'.length),
    )

    const input = fakeScopedPlanInput()
    const manifest = '{"name":"opencode-kiro","version":"0.4.0","dependencies":{"absent":"1.0.0"}}'
    const entry = input.evidence.plugins[0]!.immutableTreeEntries[0]!
    entry.bytesBase64 = Buffer.from(manifest).toString('base64')
    const treeFingerprint = sha256([{
      path: entry.path,
      mode: entry.mode,
      fingerprint: sha256(manifest),
    }])
    input.evidence.plugins[0]!.dependencyTreeFingerprint = treeFingerprint
    const packageIntegrity = `sha512-${createHash('sha512').update(treeFingerprint).digest('base64')}`
    input.evidence.plugins[0]!.resolvedIdentity = `sha256:${sha256({
      packageName: 'opencode-kiro',
      version: '0.4.0',
      packageIntegrity,
      manifestFingerprint: sha256(manifest),
      dependencyTreeFingerprint: treeFingerprint,
    })}`
    expect(() => planScopedProfile(input)).toThrow('dependency closure is incomplete')
  })

  test('proves peer and transitive package resolution from the snapshotted closure', () => {
    const input = fakeScopedPlanInput()
    bindFakePluginTree(input, [
      {
        path: 'opencode-kiro/package.json',
        manifest: {
          name: 'opencode-kiro', version: '0.4.0',
          dependencies: { dependency: '^1.0.0' }, peerDependencies: { peer: '2.x' },
        },
      },
      {
        path: 'opencode-kiro/node_modules/dependency/package.json',
        manifest: { name: 'dependency', version: '1.2.0', dependencies: { transitive: '~3.1.0' } },
      },
      {
        path: 'opencode-kiro/node_modules/dependency/node_modules/transitive/package.json',
        manifest: { name: 'transitive', version: '3.1.4' },
      },
      {
        path: 'opencode-kiro/node_modules/peer/package.json',
        manifest: { name: 'peer', version: '2.0.0' },
      },
    ])
    expect(() => planScopedProfile(input)).not.toThrow()
  })

  test('enforces npm caret-zero and prerelease range semantics exactly', () => {
    const planWithDependency = (declaredSpec: string, resolvedVersion: string): void => {
      const input = fakeScopedPlanInput()
      bindFakePluginTree(input, [
        {
          path: 'opencode-kiro/package.json',
          manifest: {
            name: 'opencode-kiro', version: '0.4.0', dependencies: { dependency: declaredSpec },
          },
        },
        {
          path: 'opencode-kiro/node_modules/dependency/package.json',
          manifest: { name: 'dependency', version: resolvedVersion },
        },
      ])
      planScopedProfile(input)
    }

    expect(() => planWithDependency('^0.0.5', '0.0.5')).not.toThrow()
    expect(() => planWithDependency('^0.0.5', '0.0.6')).toThrow('does not match its declaration')
    expect(() => planWithDependency('^0.2.3', '0.2.9')).not.toThrow()
    expect(() => planWithDependency('^0.2.3', '0.3.0')).toThrow('does not match its declaration')
    expect(() => planWithDependency('^1.2.3-beta.2', '1.2.3-beta.4')).not.toThrow()
    expect(() => planWithDependency('^1.2.3-beta.2', '1.2.4-beta.1'))
      .toThrow('does not match its declaration')
    expect(() => planWithDependency('^1.2.3', '1.3.0-beta.1'))
      .toThrow('does not match its declaration')
    expect(() => planWithDependency('1.2.3-beta.2', '1.2.3-beta.3'))
      .toThrow('does not match its declaration')
  })

  test('rejects missing peers, ambiguous duplicates, unbound packages, and mutable closure edges', () => {
    const root = (extra: Record<string, unknown>) => ({
      path: 'opencode-kiro/package.json',
      manifest: { name: 'opencode-kiro', version: '0.4.0', ...extra },
    })

    const missingPeer = fakeScopedPlanInput()
    bindFakePluginTree(missingPeer, [root({ peerDependencies: { peer: '^2.0.0' } })])
    expect(() => planScopedProfile(missingPeer)).toThrow('dependency closure is incomplete')

    const ambiguous = fakeScopedPlanInput()
    bindFakePluginTree(ambiguous, [
      root({ dependencies: { duplicate: '1.0.0' } }),
      { path: 'duplicate/package.json', manifest: { name: 'duplicate', version: '1.0.0' } },
      {
        path: 'opencode-kiro/node_modules/duplicate/package.json',
        manifest: { name: 'duplicate', version: '1.0.0' },
      },
    ])
    expect(() => planScopedProfile(ambiguous)).toThrow('resolution is ambiguous')

    const unbound = fakeScopedPlanInput()
    bindFakePluginTree(unbound, [
      root({}),
      { path: 'substitution/package.json', manifest: { name: 'substitution', version: '9.9.9' } },
    ])
    expect(() => planScopedProfile(unbound)).toThrow('unbound package')

    const mutable = fakeScopedPlanInput()
    bindFakePluginTree(mutable, [
      root({ dependencies: { local: 'file:../local' } }),
      { path: 'local/package.json', manifest: { name: 'local', version: '1.0.0' } },
    ])
    expect(() => planScopedProfile(mutable)).toThrow('declaration is not immutable')
  })

  test('rejects executable ghost package roots without manifests', () => {
    const input = fakeScopedPlanInput()
    input.evidence.plugins[0]!.immutableTreeEntries = [
      ...input.evidence.plugins[0]!.immutableTreeEntries,
      {
      path: 'opencode-kiro/node_modules/ghost/bin/ghost',
      bytesBase64: Buffer.from('#!/bin/sh\nexit 0\n').toString('base64'),
      mode: 0o500,
      },
    ]
    rebindFakePluginEvidence(input)
    expect(() => planScopedProfile(input)).toThrow('package manifest is unavailable')
  })

  test('preserves selected-provider user package duplicates in order without injecting an app pin', () => {
    const input = fakeScopedPlanInput()
    input.purpose = 'execution-probe'
    input.modelId = 'kiro/model'
    const selectedUserPackage = {
      ...input.evidence.plugins[0]!,
      provenance: 'user' as const,
    }
    input.evidence.plugins = [
      selectedUserPackage,
      { ...selectedUserPackage, provenance: 'project' as const },
      { ...selectedUserPackage, provenance: 'environment' as const },
    ]
    const planned = planScopedProfile(input)
    expect(planned.plugins.map(plugin => [plugin.spec, plugin.provenance])).toEqual([
      ['opencode-kiro@0.4.0', 'user'],
      ['opencode-kiro@0.4.0', 'project'],
      ['opencode-kiro@0.4.0', 'environment'],
    ])
    expect(planned.plugins.some(plugin => plugin.provenance === 'app-managed')).toBe(false)
  })

  test.each(PURPOSES.flatMap(purpose => PROVIDERS.map(provider => [purpose, provider] as const)))(
    'covers purpose %s with provider %s',
    (purpose, providerId) => {
      const policy = resolveOpenCodeOperationPolicy({ purpose, providerId, fingerprints })
      const passive = purpose === 'passive-status'

      expect(policy.profile.prepared).toBe(!passive)
      expect(policy.profile.hostRequired).toBe(!passive)
      expect(policy.profile.mutationCapabilities.length === 0).toBe(passive)
      expect(policy.identity.profileKey === null).toBe(passive)
      expect(policy.identity.pluginKey === null).toBe(passive)
      expect(policy.identity.cacheKey === null).toBe(passive)

      const appPlugins = policy.plugins.filter(plugin => plugin.provenance === 'app-managed')
      expect(appPlugins.map(plugin => plugin.spec)).toEqual(
        passive
          ? []
          : providerId === 'kiro'
          ? ['opencode-kiro@0.4.0']
          : providerId === 'cursor-acp'
            ? ['@rama_nigg/open-cursor@2.5.2']
            : [],
      )
    },
  )

  test('passive status explicitly has no profile, host, provider scope, auth, or mutation', () => {
    const policy = resolveOpenCodeOperationPolicy({
      purpose: 'passive-status',
      providerId: 'kiro',
      fingerprints,
    })

    expect(policy).toMatchObject({
      profile: {
        prepared: false,
        hostRequired: false,
        mutationCapabilities: [],
      },
      providerScope: { kind: 'none' },
      appMcp: 'disabled',
      toolApproval: 'none',
      auth: 'none',
      identity: {
        profileKey: null,
        pluginKey: null,
        cacheKey: null,
      },
    })
  })

  test('defines purpose-specific scope, App MCP, approval, and auth behavior', () => {
    const policies = Object.fromEntries(PURPOSES.map(purpose => [
      purpose,
      resolveOpenCodeOperationPolicy({ purpose, providerId: 'deepinfra', fingerprints }),
    ])) as Record<OpenCodeOperationPurpose, ReturnType<typeof resolveOpenCodeOperationPolicy>>

    expect(policies['provider-catalog'].providerScope).toEqual({
      kind: 'provider',
      providerId: 'deepinfra',
    })
    expect(policies['legacy-diagnostic'].providerScope).toEqual({ kind: 'all' })
    expect(policies['provider-connect'].providerScope).toEqual({
      kind: 'provider',
      providerId: 'deepinfra',
    })
    expect(policies['provider-connect'].auth).toBe('connect')
    expect(policies['provider-catalog'].auth).toBe('read-only')
    expect(policies['legacy-diagnostic'].auth).toBe('read-only')
    expect(policies['execution-probe']).toMatchObject({
      profile: {
        prepared: true,
        hostRequired: true,
        isolation: 'process-scoped',
        hostLifetime: 'temporary',
      },
      providerScope: { kind: 'provider', providerId: 'deepinfra' },
      appMcp: 'disabled',
      toolApproval: 'none',
      auth: 'read-only',
      session: 'temporary-always-cleaned',
      inventory: 'none',
      inventoryFallback: 'forbidden',
      launchAuthorization: 'forbidden',
    })
    expect(policies['execution-probe'].profile.mutationCapabilities).not.toContain('auth')
    for (const purpose of ['launch', 'session-resume'] as const) {
      expect(policies[purpose]).toMatchObject({
        appMcp: 'enabled',
        toolApproval: 'auto',
        auth: 'synchronize',
      })
    }
  })

  test.each(PROVIDER_REQUIRED_PURPOSES)(
    '%s fails closed without a provider identity',
    purpose => {
      for (const providerId of [undefined, null, '', '   ']) {
        expect(() => resolveOpenCodeOperationPolicy({ purpose, providerId, fingerprints }))
          .toThrow(`OpenCode operation ${purpose} requires a providerId`)
      }
    },
  )

  test('only legacy diagnostics use all-provider scope', () => {
    const legacy = resolveOpenCodeOperationPolicy({
      purpose: 'legacy-diagnostic',
      fingerprints,
    })
    const passive = resolveOpenCodeOperationPolicy({
      purpose: 'passive-status',
      fingerprints,
    })

    expect(legacy.providerScope).toEqual({ kind: 'all' })
    expect(passive.providerScope).toEqual({ kind: 'none' })
  })

  test('execution probes preserve user/project plugins and add only the selected managed plugin', () => {
    const probe = resolveOpenCodeOperationPolicy({
      purpose: 'execution-probe',
      providerId: 'kiro',
      preservedPlugins: [
        { spec: 'user-plugin@1.0.0', provenance: 'user' },
        { spec: 'project-plugin@1.0.0', provenance: 'project' },
      ],
      fingerprints,
    })

    expect(probe.plugins).toEqual([
      { spec: 'user-plugin@1.0.0', packageName: 'user-plugin', provenance: 'user' },
      { spec: 'project-plugin@1.0.0', packageName: 'project-plugin', provenance: 'project' },
      {
        spec: 'opencode-kiro@0.4.0',
        packageName: 'opencode-kiro',
        provenance: 'app-managed',
      },
    ])
  })

  test('grants inventory only at the explicit catalog and legacy diagnostic boundaries', () => {
    const expected: Record<OpenCodeOperationPurpose, 'none' | 'selected-provider-only' | 'full'> = {
      'passive-status': 'none',
      'provider-catalog': 'selected-provider-only',
      'provider-connect': 'none',
      'execution-probe': 'none',
      launch: 'none',
      'session-resume': 'none',
      'legacy-diagnostic': 'full',
    }

    for (const purpose of PURPOSES) {
      const policy = resolveOpenCodeOperationPolicy({ purpose, providerId: 'deepinfra', fingerprints })
      expect(policy.inventory).toBe(expected[purpose])
      expect(policy.inventoryFallback).toBe(
        purpose === 'legacy-diagnostic' ? 'legacy-full' : 'forbidden',
      )
    }
  })

  test('execution probes retain user collision ownership and exclude unrelated managed plugins', () => {
    const probe = resolveOpenCodeOperationPolicy({
      purpose: 'execution-probe',
      providerId: 'cursor-acp',
      preservedPlugins: [
        { spec: '@rama_nigg/open-cursor@user-selected', provenance: 'user' },
        { spec: 'project-plugin@2.0.0', provenance: 'project' },
      ],
      fingerprints,
    })

    expect(probe.plugins).toEqual([
      {
        spec: '@rama_nigg/open-cursor@user-selected',
        packageName: '@rama_nigg/open-cursor',
        provenance: 'user',
      },
      { spec: 'project-plugin@2.0.0', packageName: 'project-plugin', provenance: 'project' },
    ])
    expect(probe.plugins.some(plugin => plugin.spec === 'opencode-kiro@0.4.0')).toBe(false)
  })

  test('execution-probe and launch identities and authorization are separated', () => {
    const probe = resolveOpenCodeOperationPolicy({
      purpose: 'execution-probe', providerId: 'kiro', fingerprints,
    })
    const launch = resolveOpenCodeOperationPolicy({
      purpose: 'launch', providerId: 'kiro', fingerprints,
    })

    expect(probe.launchAuthorization).toBe('forbidden')
    expect(launch.launchAuthorization).toBe('fresh-retained-host-exact-proof')
    expect(launch.profile.hostLifetime).toBe('retained')
    for (const key of ['operationKey', 'profileKey', 'pluginKey', 'cacheKey'] as const) {
      expect(probe.identity[key]).not.toBe(launch.identity[key])
    }

    const laterProbe = resolveOpenCodeOperationPolicy({
      purpose: 'execution-probe',
      providerId: 'kiro',
      fingerprints: { ...fingerprints, config: 'next-attempt-config' },
    })
    expect(laterProbe.launchAuthorization).toBe('forbidden')
    expect(laterProbe.identity.operationKey).not.toBe(probe.identity.operationKey)
  })

  test('uses canonical provider identity for aliases and plugin selection', () => {
    const canonical = resolveOpenCodeOperationPolicy({
      purpose: 'provider-connect',
      providerId: 'kiro',
      fingerprints,
    })
    const alias = resolveOpenCodeOperationPolicy({
      purpose: 'provider-connect',
      providerId: 'Amazon Q Developer / Kiro',
      fingerprints,
    })

    expect(alias.providerScope).toEqual({ kind: 'provider', providerId: 'kiro' })
    expect(alias.plugins).toEqual(canonical.plugins)
    expect(alias.identity).toEqual(canonical.identity)

    const otherwiseDifferentAliases = [
      resolveOpenCodeOperationPolicy({
        purpose: 'launch',
        providerId: 'Amazon Q Developer / Kiro',
        fingerprints,
      }),
      ...Object.keys(fingerprints).map(key => resolveOpenCodeOperationPolicy({
        purpose: 'provider-connect',
        providerId: 'Amazon Q Developer / Kiro',
        fingerprints: { ...fingerprints, [key]: `${key}-changed` },
      })),
      resolveOpenCodeOperationPolicy({
        purpose: 'provider-connect',
        providerId: 'Amazon Q Developer / Kiro',
        preservedPlugins: [{ spec: 'user-plugin@1.0.0', provenance: 'user' }],
        fingerprints,
      }),
    ]

    for (const different of otherwiseDifferentAliases) {
      expect(different.identity.profileKey).not.toBe(canonical.identity.profileKey)
      expect(different.identity.pluginKey).not.toBe(canonical.identity.pluginKey)
      expect(different.identity.cacheKey).not.toBe(canonical.identity.cacheKey)
    }
  })

  test('preserves user and project plugins in order and leaves collisions user-owned', () => {
    const policy = resolveOpenCodeOperationPolicy({
      purpose: 'launch',
      providerId: 'cursor-acp',
      preservedPlugins: [
        { spec: 'first-plugin@1.0.0', provenance: 'user' },
        { spec: '@rama_nigg/open-cursor@latest', provenance: 'user' },
        { spec: 'project-plugin', provenance: 'project' },
      ],
      fingerprints,
    })

    expect(policy.plugins).toEqual([
      { spec: 'first-plugin@1.0.0', packageName: 'first-plugin', provenance: 'user' },
      {
        spec: '@rama_nigg/open-cursor@latest',
        packageName: '@rama_nigg/open-cursor',
        provenance: 'user',
      },
      { spec: 'project-plugin', packageName: 'project-plugin', provenance: 'project' },
    ])
  })

  test('appends the one applicable managed plugin after preserved plugins', () => {
    const policy = resolveOpenCodeOperationPolicy({
      purpose: 'launch',
      providerId: 'kiro',
      preservedPlugins: [
        { spec: 'user-first', provenance: 'user' },
        { spec: 'project-second', provenance: 'project' },
      ],
      fingerprints,
    })

    expect(policy.plugins.map(plugin => [plugin.spec, plugin.provenance])).toEqual([
      ['user-first', 'user'],
      ['project-second', 'project'],
      ['opencode-kiro@0.4.0', 'app-managed'],
    ])
  })

  test('plugin provenance and the resolved plugin set separate every mutable identity', () => {
    const withUserPlugin = resolveOpenCodeOperationPolicy({
      purpose: 'launch',
      providerId: 'deepinfra',
      preservedPlugins: [{ spec: 'same-plugin@1.0.0', provenance: 'user' }],
      fingerprints,
    })
    const withProjectPlugin = resolveOpenCodeOperationPolicy({
      purpose: 'launch',
      providerId: 'deepinfra',
      preservedPlugins: [{ spec: 'same-plugin@1.0.0', provenance: 'project' }],
      fingerprints,
    })
    const withDifferentSet = resolveOpenCodeOperationPolicy({
      purpose: 'launch',
      providerId: 'deepinfra',
      preservedPlugins: [
        { spec: 'same-plugin@1.0.0', provenance: 'user' },
        { spec: 'additional-plugin@1.0.0', provenance: 'project' },
      ],
      fingerprints,
    })

    for (const identityKind of ['profileKey', 'pluginKey', 'cacheKey'] as const) {
      expect(withProjectPlugin.identity[identityKind])
        .not.toBe(withUserPlugin.identity[identityKind])
      expect(withDifferentSet.identity[identityKind])
        .not.toBe(withUserPlugin.identity[identityKind])
    }
  })

  test('every v2 mutable identity separates the complete canonical identity input', () => {
    const baseline = resolveOpenCodeOperationPolicy({
      purpose: 'launch',
      providerId: 'deepinfra',
      fingerprints,
    })
    const variants = [
      resolveOpenCodeOperationPolicy({ purpose: 'session-resume', providerId: 'deepinfra', fingerprints }),
      resolveOpenCodeOperationPolicy({ purpose: 'launch', providerId: 'custom', fingerprints }),
      ...Object.keys(fingerprints).map(key => resolveOpenCodeOperationPolicy({
        purpose: 'launch',
        providerId: 'deepinfra',
        fingerprints: { ...fingerprints, [key]: `${key}-changed` },
      })),
      resolveOpenCodeOperationPolicy({
        purpose: 'launch',
        providerId: 'deepinfra',
        preservedPlugins: [{ spec: 'user-plugin', provenance: 'user' }],
        fingerprints,
      }),
    ]

    for (const variant of variants) {
      expect(variant.identity.operationKey).not.toBe(baseline.identity.operationKey)
      expect(variant.identity.profileKey).not.toBe(baseline.identity.profileKey)
      expect(variant.identity.pluginKey).not.toBe(baseline.identity.pluginKey)
      expect(variant.identity.cacheKey).not.toBe(baseline.identity.cacheKey)
    }
    expect(baseline.identity.operationKey).toStartWith('opencode-operation-policy-v2:operation:')
  })

  test('separates profile, plugin, and cache identity when only profile layout generation changes', () => {
    const current = resolveOpenCodeOperationPolicy({
      purpose: 'launch',
      providerId: 'kiro',
      fingerprints,
    })
    const nextLayout = resolveOpenCodeOperationPolicy({
      purpose: 'launch',
      providerId: 'kiro',
      fingerprints: { ...fingerprints, layout: 'next-layout-fingerprint' },
    })

    for (const key of ['profileKey', 'pluginKey', 'cacheKey'] as const) {
      expect(nextLayout.identity[key]).not.toBe(current.identity[key])
    }
  })

  test('projects, purposes, providers, auth, models, and plugin policies never share mutable identity', () => {
    const baseline = resolveOpenCodeOperationPolicy({
      purpose: 'launch',
      providerId: 'deepinfra',
      fingerprints,
    })
    const distinctPolicies = {
      project: resolveOpenCodeOperationPolicy({
        purpose: 'launch',
        providerId: 'deepinfra',
        fingerprints: { ...fingerprints, project: 'second-project' },
      }),
      purpose: resolveOpenCodeOperationPolicy({
        purpose: 'session-resume',
        providerId: 'deepinfra',
        fingerprints,
      }),
      provider: resolveOpenCodeOperationPolicy({
        purpose: 'launch',
        providerId: 'custom',
        fingerprints,
      }),
      auth: resolveOpenCodeOperationPolicy({
        purpose: 'launch',
        providerId: 'deepinfra',
        fingerprints: { ...fingerprints, auth: 'second-auth' },
      }),
      model: resolveOpenCodeOperationPolicy({
        purpose: 'launch',
        providerId: 'deepinfra',
        fingerprints: { ...fingerprints, model: 'second-model' },
      }),
      pluginPolicy: resolveOpenCodeOperationPolicy({
        purpose: 'launch',
        providerId: 'deepinfra',
        preservedPlugins: [{ spec: 'second-plugin@2.0.0', provenance: 'project' }],
        fingerprints: { ...fingerprints, policy: 'second-policy', plugin: 'second-plugin-policy' },
      }),
    }

    for (const policy of Object.values(distinctPolicies)) {
      expect(policy.identity.profileKey).not.toBe(baseline.identity.profileKey)
      expect(policy.identity.pluginKey).not.toBe(baseline.identity.pluginKey)
      expect(policy.identity.cacheKey).not.toBe(baseline.identity.cacheKey)
    }
  })

  test('canonical identity serialization and policy identities ignore object key ordering', () => {
    expect(canonicalSerializeOpenCodePolicyIdentity({ z: 1, nested: { b: 2, a: 1 }, a: 2 }))
      .toBe(canonicalSerializeOpenCodePolicyIdentity({ a: 2, nested: { a: 1, b: 2 }, z: 1 }))

    const reorderedFingerprints = Object.fromEntries(
      Object.entries(fingerprints).reverse(),
    ) as OpenCodeOperationIdentityFingerprints
    const first = resolveOpenCodeOperationPolicy({
      purpose: 'launch',
      providerId: 'kiro',
      fingerprints,
    })
    const second = resolveOpenCodeOperationPolicy({
      fingerprints: reorderedFingerprints,
      providerId: 'kiro',
      purpose: 'launch',
    })
    expect(second.identity).toEqual(first.identity)
  })

  test('identity input contains only named redacted fingerprints, never secret fields', () => {
    const policy = resolveOpenCodeOperationPolicy({
      purpose: 'launch',
      providerId: 'kiro',
      fingerprints,
    })
    const parsed = JSON.parse(policy.identity.canonicalInput) as Record<string, unknown>

    expect(parsed).toEqual({
      fingerprints,
      plugins: [{
        packageName: 'opencode-kiro',
        provenance: 'app-managed',
        spec: 'opencode-kiro@0.4.0',
      }],
      provider: { kind: 'provider', providerId: 'kiro' },
      purpose: 'launch',
      schema: 'opencode-operation-policy-v2',
    })
    expect(policy.identity.canonicalInput).not.toMatch(/token|secret|credential/i)
  })
})
