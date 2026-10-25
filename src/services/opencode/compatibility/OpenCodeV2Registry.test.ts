import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  assertOpenCodeV2Launchable, classifyOpenCodeV2Version, isOpenCodeV2Identity, openCodeV2Dialect,
  openCodeV2GraphPackages, openCodeV2LaunchRefusal, openCodeV2Qualification, openCodeV2QualifiedVersions,
  openCodeV2ReleaseContract, openCodeV2StagedVersions, openCodeV2Wire, parseOpenCodeV2GraphAlias, type OpenCodeV2Pin,
} from './OpenCodeV2Registry.js'
import { validateRunLaunchPlan } from '../bridge/OpenCodeV2RunOwner.js'
import type { RunLaunchPlan } from '../bridge/OpenCodeV2RunTypes.js'

const manifest = JSON.parse(readFileSync(path.join(import.meta.dir, '../../../../package.json'), 'utf8')) as {
  dependencies: Record<string, string>
}

test('range classification boundaries: >=2.0.0 <3.0.0, exact stable releases only', () => {
  for (const version of ['2.0.0', '2.0.32', '2.1.4', '2.999.999'] as const) {
    expect(classifyOpenCodeV2Version(version)).toEqual({ status: 'recognized', version, dialect: `v2-${version}` as const })
  }
  for (const version of ['1.18.34', '1.99.99', '0.0.1']) expect(classifyOpenCodeV2Version(version).status).toBe('too_old')
  for (const version of ['3.0.0', '3.1.0', '10.0.0']) expect(classifyOpenCodeV2Version(version).status).toBe('too_new')
  for (const version of ['2.1.4-rc.1', '2.1.4-beta', '2.1.4+build', 'v2.1.4', '02.1.4', '2.1', '2.1.4.1', ' 2.1.4', '', null, 214]) {
    expect(classifyOpenCodeV2Version(version)).toEqual({ status: 'unsupported', version: null })
  }
})

test('dialect, wire family and graph aliases derive from any in-range version without a table', () => {
  const version = '2.37.105' as OpenCodeV2Pin
  expect(openCodeV2Dialect(version)).toBe('v2-2.37.105')
  expect(isOpenCodeV2Identity(version, 'v2-2.37.105')).toBe(true)
  expect(isOpenCodeV2Identity(version, 'v2-2.37.10')).toBe(false)
  expect(openCodeV2Wire(version)).toBe('current')
  expect(openCodeV2GraphPackages(version)).toEqual({ server: '@opencode/server-v2.37.105', client: '@opencode/client-v2.37.105' })
  expect(parseOpenCodeV2GraphAlias('@opencode/server-v2.37.105')).toEqual({ kind: 'server', version })
  for (const name of ['@opencode/server', '@opencode/server-v3.0.0', '@opencode/server-v2.1.4-rc.1', '@opencode/core-v2.1.4']) {
    expect(parseOpenCodeV2GraphAlias(name)).toBeNull()
  }
  expect(openCodeV2StagedVersions({
    '@opencode/server-v2.37.105': 'npm:@opencode/server@2.37.105', '@opencode/client-v2.37.105': 'npm:@opencode/client@2.37.105',
    effect: '4.0.1',
  })).toEqual([version])
})

test('existing 2.0.0 floor and 2.0.32 current identities are unchanged', () => {
  expect(openCodeV2Dialect('2.0.0')).toBe('v2-2.0.0')
  expect(openCodeV2Dialect('2.0.32')).toBe('v2-2.0.32')
  expect(openCodeV2Wire('2.0.0')).toBe('floor')
  expect(openCodeV2Wire('2.0.32')).toBe('current')
  // Both keep every platform where V2 execution already ran.
  for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']) {
    expect(openCodeV2LaunchRefusal('2.0.0', platform)).toBeNull()
    expect(openCodeV2LaunchRefusal('2.0.32', platform)).toBeNull()
  }
})

test('qualification is per platform: a version is admitted only where its evidence ran', () => {
  const record = openCodeV2Qualification('2.1.4')
  expect(record?.platforms.length).toBeGreaterThan(0)
  for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']) {
    expect(openCodeV2LaunchRefusal('2.1.4', platform)).toBe(record?.platforms.includes(platform as never) ? null : 'opencode_v2_version_unqualified')
  }
  // The published contract lists, per platform, exactly the versions admitted there.
  const contract = openCodeV2ReleaseContract()
  for (const [platform, versions] of Object.entries(contract.qualified)) {
    for (const version of openCodeV2QualifiedVersions()) {
      expect(versions.includes(version)).toBe(openCodeV2LaunchRefusal(version, platform) === null)
    }
  }
})

test('staged graph aliases must name the official package at the same exact version, in pairs', () => {
  expect(() => openCodeV2StagedVersions({ '@opencode/server-v2.1.4': 'npm:@opencode/server@2.1.5',
    '@opencode/client-v2.1.4': 'npm:@opencode/client@2.1.4' })).toThrow('opencode_v2_graph_alias_invalid')
  expect(() => openCodeV2StagedVersions({ '@opencode/server-v2.1.4': 'npm:@opencode/server@2.1.4' }))
    .toThrow('opencode_v2_graph_alias_incomplete')
  expect(() => openCodeV2StagedVersions({ '@opencode/server-v3.0.0': 'npm:@opencode/server@3.0.0' }))
    .toThrow('opencode_v2_graph_alias_invalid')
})

test('every qualification record ships a staged graph in the install manifest', () => {
  const staged = openCodeV2StagedVersions(manifest.dependencies)
  expect(openCodeV2QualifiedVersions().length).toBeGreaterThan(0)
  for (const version of openCodeV2QualifiedVersions()) {
    expect(staged).toContain(version)
    expect(openCodeV2Qualification(version)?.evidence.length).toBeGreaterThan(0)
  }
})

test('launch is refused with a coded error for in-range unqualified and for out-of-range versions', () => {
  expect(openCodeV2LaunchRefusal('2.0.40')).toBe('opencode_v2_version_unqualified')
  expect(openCodeV2LaunchRefusal('3.0.0')).toBe('opencode_v2_version_out_of_range')
  expect(openCodeV2LaunchRefusal('2.1.4-rc.1')).toBe('opencode_v2_version_out_of_range')
  expect(() => assertOpenCodeV2Launchable('2.0.40')).toThrow('opencode_v2_version_unqualified')
  expect(() => assertOpenCodeV2Launchable('1.18.34')).toThrow('opencode_v2_version_out_of_range')
  // The run owner admits no member before the same gate, independent of the rest of the plan.
  const plan = (version: string) => ({
    dataRoot: '/TEST-data', deadline: Date.now() + 60_000,
    binding: { teamId: 'TEST-team', runId: 'TEST-run', ownerId: 'TEST-owner', controllerInstanceId: 'TEST-controller' },
    source: { entryPath: '/TEST-entry.ts', entrySha256: 'd'.repeat(64), bunPath: '/TEST-bun', bunSha256: 'c'.repeat(64),
      files: [{ path: '/TEST-entry.ts', sha256: 'd'.repeat(64) }], env: {} },
    members: [{ memberId: 'worker', laneId: 'primary', originalSessionId: 'ses_TESToriginal',
      native: { generation: 'v2', version, dialect: `v2-${version}` }, profile: { root: '/TEST-profile' } }],
  }) as unknown as RunLaunchPlan
  expect(() => validateRunLaunchPlan(plan('2.0.40'))).toThrow('opencode_v2_version_unqualified')
  expect(() => validateRunLaunchPlan(plan('3.0.0'))).toThrow('opencode_v2_version_out_of_range')
})
