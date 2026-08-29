import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

import {
  buildOpenCodeExpectedBehaviorEvidence,
  computeOpenCodeExpectedBehaviorFingerprint,
  OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_SCHEMA_VERSION,
  validateOpenCodeExpectedBehaviorEvidence,
} from './OpenCodeExpectedBehaviorFingerprint.js'

import type { OpenCodeExpectedBehaviorEvidence, OpenCodePreparedProfile } from './types.js'

type Fixture = {
  cases: Array<OpenCodeExpectedBehaviorEvidence & { name: string }>
}

const fixture = JSON.parse(await readFile(
  new URL('./fixtures/expected-behavior-fingerprint-v2.json', import.meta.url),
  'utf8',
)) as Fixture

function profile(): OpenCodePreparedProfile {
  return {
    projectPath: '/tmp/project',
    canonicalProjectPath: '/tmp/project',
    workingDirectoryPath: '/tmp/project',
    scopeToken: null,
    profileRootKey: 'root',
    profileRootPath: '/tmp/profile',
    projectBehaviorFingerprint: 'b'.repeat(64),
    behaviorSources: [],
    managedConfig: {},
    managedConfigFingerprint: 'c'.repeat(64),
    homePath: '/tmp/home',
    tmpPath: '/tmp/tmp',
    xdgConfigHome: '/tmp/config',
    xdgDataHome: '/tmp/data',
    xdgCacheHome: '/tmp/cache',
    managedAuthPath: '/tmp/auth.json',
    sourceAuthPath: null,
    sourceAuthFingerprint: null,
    managedAuthFingerprint: null,
    authState: 'missing',
    env: {},
  }
}

describe('OpenCode expected behavior fingerprint v2', () => {
  test('matches every committed literal golden vector', () => {
    for (const vector of fixture.cases) {
      const { name: _name, ...evidence } = vector
      expect(computeOpenCodeExpectedBehaviorFingerprint(evidence)).toBe(
        evidence.expectedBehaviorFingerprint,
      )
      expect(validateOpenCodeExpectedBehaviorEvidence(evidence)).toBe(true)
    }
  })

  test('rejects the requested digest after each tuple component changes independently', () => {
    const baseline = fixture.cases[0]!
    for (const changed of fixture.cases.slice(1, 7)) {
      const { name: _name, ...evidence } = changed
      expect(validateOpenCodeExpectedBehaviorEvidence({
        ...evidence,
        expectedBehaviorFingerprint: baseline.expectedBehaviorFingerprint,
      })).toBe(false)
    }
  })

  test('rejects evidence with fields outside the exact v2 schema', () => {
    const { name: _name, ...baseline } = fixture.cases[0]!
    expect(validateOpenCodeExpectedBehaviorEvidence({
      ...baseline,
      unexpected: true,
    } as OpenCodeExpectedBehaviorEvidence)).toBe(false)
  })

  test('known selected credential absence is deterministic without exposing auth bytes', async () => {
    const build = () => buildOpenCodeExpectedBehaviorEvidence({
      profile: profile(),
      fullModelId: 'OLLAMA/Library/Gemma',
      effectiveConfigFingerprint: 'd'.repeat(64),
      readCredential: async () => null,
    })
    const first = await build()
    const second = await build()
    expect(first).toEqual(second)
    expect(first.modelProviderId).toBe('ollama')
    expect(first.fullModelId).toBe('ollama/Library/Gemma')
  })

  test('fingerprints selected credentials canonically without publishing their bytes', async () => {
    const build = (credential: Record<string, unknown>) =>
      buildOpenCodeExpectedBehaviorEvidence({
        profile: profile(),
        fullModelId: 'deepinfra/org/Model',
        effectiveConfigFingerprint: 'd'.repeat(64),
        readCredential: async () => credential,
      })
    const first = await build({ type: 'api', key: 'top-secret', metadata: { z: 1, a: 2 } })
    const second = await build({ metadata: { a: 2, z: 1 }, key: 'top-secret', type: 'api' })
    expect(first).toEqual(second)
    expect(JSON.stringify(first)).not.toContain('top-secret')
  })

  test('folds scoped authority-source rotation into the opaque auth component without v2 drift', async () => {
    const build = (authoritySourceFingerprint: string) => buildOpenCodeExpectedBehaviorEvidence({
      profile: {
        ...profile(),
        profileScope: {
          purpose: 'launch_runtime', providerId: 'deepinfra',
          configFingerprint: 'e'.repeat(64), selectedAuthIdentity: 'absent',
          scopeToken: 'f'.repeat(64),
        },
        authoritySourceFingerprint,
      },
      fullModelId: 'deepinfra/model',
      effectiveConfigFingerprint: 'd'.repeat(64),
      readCredential: async () => null,
    })
    const first = await build('1'.repeat(64))
    const rotated = await build('2'.repeat(64))
    expect(rotated.effectiveSelectedAuthFingerprint)
      .not.toBe(first.effectiveSelectedAuthFingerprint)
    expect(rotated.expectedBehaviorFingerprint).not.toBe(first.expectedBehaviorFingerprint)
    expect(OPEN_CODE_EXPECTED_BEHAVIOR_FINGERPRINT_SCHEMA_VERSION).toBe(2)
    expect(Object.keys(rotated).sort()).toEqual(Object.keys(first).sort())
  })

  test('auth read errors and unavailable live config fail closed', async () => {
    await expect(buildOpenCodeExpectedBehaviorEvidence({
      profile: profile(),
      fullModelId: 'ollama/model',
      effectiveConfigFingerprint: 'd'.repeat(64),
      readCredential: async () => { throw new Error('secret parse detail') },
    })).rejects.toThrow('effective selected authentication is unavailable')
    await expect(buildOpenCodeExpectedBehaviorEvidence({
      profile: profile(),
      fullModelId: 'ollama/model',
      effectiveConfigFingerprint: null,
      readCredential: async () => null,
    })).rejects.toThrow('effective live config fingerprint is unavailable')
  })
})
