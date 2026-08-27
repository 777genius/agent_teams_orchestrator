import { describe, expect, test } from 'bun:test'

import { createOpenCodePassiveCapabilityVersions, decodeOpenCodePassiveCapabilityVersions, isOpenCodeCanonicalModelId, isOpenCodeCanonicalProviderId, isOpenCodePassiveBinaryVersion } from './OpenCodePassiveStatusContract.js'

describe('OpenCode passive capability decoder', () => {
  test('accepts only the one supported integral version', () => {
    expect(decodeOpenCodePassiveCapabilityVersions(createOpenCodePassiveCapabilityVersions(1, 1))).toEqual({ passiveStatusContract: 1, redactedSnapshot: 1, execution: 'unsupported' })
    for (const bad of [undefined, null, -1, 0, 1.5, 2, Number.NaN, '1']) {
      expect(decodeOpenCodePassiveCapabilityVersions(createOpenCodePassiveCapabilityVersions(bad, bad))).toEqual({ passiveStatusContract: 0, redactedSnapshot: 0, execution: 'unsupported' })
    }
  })

  test('does not synthesize capabilities from legacy or future payload fields', () => {
    expect(decodeOpenCodePassiveCapabilityVersions({
      authenticated: true,
      teamLaunch: true,
      models: ['secret/model'],
      labels: { passiveStatusContract: 1 },
      passiveStatusContract: 99,
      redactedSnapshot: { version: 1 },
    })).toEqual({ passiveStatusContract: 0, redactedSnapshot: 0, execution: 'unsupported' })
    expect(decodeOpenCodePassiveCapabilityVersions('malformed')).toEqual({ passiveStatusContract: 0, redactedSnapshot: 0, execution: 'unsupported' })
  })

  test('accepts canonical identifiers but rejects path, traversal, control and credential-like identifiers', () => {
    expect(isOpenCodeCanonicalProviderId('deepinfra')).toBe(true)
    expect(isOpenCodeCanonicalModelId('deepinfra/llama-4')).toBe(true)
    expect(isOpenCodeCanonicalModelId('kiro/anthropic/claude')).toBe(true)
    expect(isOpenCodeCanonicalModelId('xai/org/Team:Model-v2')).toBe(true)
    expect(isOpenCodeCanonicalModelId('deepinfra/model@rev.8+stable')).toBe(true)
    for (const value of ['etc/passwd', '../model', '/root', './relative', 'ghp_abcd', 'xoxb-abcd', 'rk_live_abcd', 'sk-abcd', 'bearer-token', 'api-key', 'secret-value', 'token.value', 'deepinfra/../../passwd', 'model\nname', 'aB3dE5fG7hI9jK1mN3pQ5rS7tU9vW1xY3zA5bC7dE9fG']) {
      expect(isOpenCodeCanonicalProviderId(value)).toBe(false)
      expect(isOpenCodeCanonicalModelId(value)).toBe(false)
    }
    expect(isOpenCodeCanonicalProviderId('a'.repeat(65))).toBe(false)
    expect(isOpenCodeCanonicalModelId(`${'a'.repeat(65)}/model`)).toBe(false)
  })

  test('requires plain records and own inert capability fields', () => {
    const inherited = Object.create({ passiveStatusContract: 1, redactedSnapshot: 1 })
    expect(decodeOpenCodePassiveCapabilityVersions(inherited)).toEqual({ passiveStatusContract: 0, redactedSnapshot: 0, execution: 'unsupported' })
    const accessor = Object.create(null)
    Object.defineProperty(accessor, 'passiveStatusContract', { get: () => 1, enumerable: true })
    Object.defineProperty(accessor, 'redactedSnapshot', { get: () => 1, enumerable: true })
    expect(decodeOpenCodePassiveCapabilityVersions(accessor)).toEqual({ passiveStatusContract: 0, redactedSnapshot: 0, execution: 'unsupported' })
    const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error('hostile') } })
    expect(decodeOpenCodePassiveCapabilityVersions(hostile)).toEqual({ passiveStatusContract: 0, redactedSnapshot: 0, execution: 'unsupported' })
    let traps = 0
    const forgingProxy = new Proxy({}, {
      getPrototypeOf: () => Object.prototype,
      ownKeys: () => { traps += 1; return ['passiveStatusContract', 'redactedSnapshot'] },
      getOwnPropertyDescriptor: (_target, key) => ({ value: key === 'passiveStatusContract' ? 1 : 1, enumerable: true, configurable: true }),
    })
    expect(decodeOpenCodePassiveCapabilityVersions(forgingProxy)).toEqual({ passiveStatusContract: 0, redactedSnapshot: 0, execution: 'unsupported' })
    expect(traps).toBe(0)
  })

  test('rejects sensitive semver components and shorter opaque credentials conservatively', () => {
    for (const separator of ['.', '-', '+']) {
      for (const sensitive of ['xoxb', 'api-key', 'secret', 'token', 'bearer', 'sk', 'ghp', 'password']) {
        expect(isOpenCodePassiveBinaryVersion(`1.2.3${separator}${sensitive}`)).toBe(false)
        expect(isOpenCodeCanonicalProviderId(`deepinfra${separator}${sensitive}`)).toBe(false)
        expect(isOpenCodeCanonicalModelId(`deepinfra/model${separator}${sensitive}`)).toBe(false)
      }
    }
    const opaque39 = 'aB3dE5fG7hI9jK1mN3pQ5rS7tU9vW1xY3zA'.padEnd(39, 'B')
    expect(opaque39).toHaveLength(39)
    expect(isOpenCodeCanonicalProviderId(opaque39)).toBe(false)
    expect(isOpenCodeCanonicalProviderId('untrusted-custom-provider')).toBe(false)
    expect(isOpenCodeCanonicalModelId(`deepinfra/${opaque39}`)).toBe(false)
    expect(isOpenCodeCanonicalProviderId(`sha256:${'a'.repeat(64)}`)).toBe(true)
    for (const prefixed of ['xoxb123456', 'ghpabcdef', 'sklive123456']) {
      expect(isOpenCodePassiveBinaryVersion(`1.2.3+${prefixed}`)).toBe(false)
      expect(isOpenCodeCanonicalModelId(`deepinfra/${prefixed}`)).toBe(false)
    }
    for (const concatenated of ['BearerAb12', 'bearerab12cd34', 'tokenAb12', 'apiKeyCd34', 'secretEf56', 'skGh78']) {
      expect(isOpenCodePassiveBinaryVersion(`1.2.3+${concatenated}`)).toBe(false)
      expect(isOpenCodeCanonicalModelId(`deepinfra/${concatenated.toLowerCase()}`)).toBe(false)
      expect(isOpenCodeCanonicalProviderId(concatenated.toLowerCase())).toBe(false)
    }
    for (const reservedSuffix of ['tokenabcdefghijklmnop', 'token0000000000000000', 'apikeyabcdefghijkl', 'apikey000000000000']) {
      expect(isOpenCodePassiveBinaryVersion(`1.2.3+${reservedSuffix}`)).toBe(false)
      expect(isOpenCodeCanonicalProviderId(reservedSuffix)).toBe(false)
      expect(isOpenCodeCanonicalModelId(reservedSuffix)).toBe(false)
      expect(isOpenCodeCanonicalModelId(`deepinfra/${reservedSuffix}`)).toBe(false)
    }
    for (const sensitive of ['tokenabcdefg', 'token1234567', 'tokena1', 'a1b2c3d4e-f5g6h7i8j-k9l0m1n2o-p3q4r5s6t']) {
      expect(isOpenCodePassiveBinaryVersion(`1.2.3+${sensitive}`)).toBe(false)
      expect(isOpenCodePassiveBinaryVersion(`1.2.3-${sensitive}`)).toBe(false)
      expect(isOpenCodeCanonicalProviderId(sensitive)).toBe(false)
      expect(isOpenCodeCanonicalModelId(sensitive)).toBe(false)
      expect(isOpenCodeCanonicalModelId(`deepinfra/${sensitive}`)).toBe(false)
    }
  })

  test('requires strict canonical component and SemVer grammars', () => {
    expect(isOpenCodeCanonicalModelId('deepinfra/model-name.v2')).toBe(true)
    expect(isOpenCodePassiveBinaryVersion('1.2.3-alpha.1+build.5')).toBe(true)
    for (const model of ['model..name', 'model--name', 'model__name', 'model-', 'model.', '-model', '.model']) {
      expect(isOpenCodeCanonicalModelId(model)).toBe(false)
      expect(isOpenCodeCanonicalModelId(`deepinfra/${model}`)).toBe(false)
    }
    for (const version of ['1', '1.2', 'v1.2.3', '01.2.3', '1.02.3', '1.2.03', '1.2.3-', '1.2.3+', '1.2.3+build.', '1.2.3+build..5', '1.2.3-01']) {
      expect(isOpenCodePassiveBinaryVersion(version)).toBe(false)
    }
  })

  test('rejects lowercase high-entropy scalars from 16 characters while preserving common words', () => {
    expect(isOpenCodeCanonicalProviderId('cloudflare-ai-gateway')).toBe(true)
    const boundaryMatrix = [
      ['qmxncbvlasdkfjw', 15, true],
      ['qmxncbvlasdkfjwu', 16, false],
      ['qmxncbvlasdkfjwuepz', 19, false],
      ['abcdefghijklmnopqrst', 20, false],
      ['abcdefghijklmnopqrstuvwx', 24, false],
    ] as const
    for (const [payload, length, accepted] of boundaryMatrix) {
      expect(payload).toHaveLength(length)
      expect(isOpenCodeCanonicalModelId(payload)).toBe(false)
      expect(isOpenCodeCanonicalModelId(`deepinfra/${payload}`)).toBe(accepted)
      expect(isOpenCodePassiveBinaryVersion(`1.2.3+${payload}`)).toBe(accepted)
    }
    for (const model of ['deepinfra/claude-sonnet-latest', 'deepinfra/model-name.v2', 'deepinfra/versioncandidate', 'deepinfra/deepinframodellatest']) {
      expect(isOpenCodeCanonicalModelId(model)).toBe(true)
    }
    for (const unsafe of [
      'deepinfra/etc/passwd', 'deepinfra/home/alice/model', 'deepinfra/model?token=value',
      'deepinfra/model#fragment', 'deepinfra/https://example.invalid/model',
      'deepinfra/127.0.0.1:8080/model', 'deepinfra/user:password@example.invalid/model',
      'deepinfra/org/Team\u0000Model', 'deepinfra/org/Mödel', 'deepinfra/org/token/value',
    ]) expect(isOpenCodeCanonicalModelId(unsafe)).toBe(false)
    for (const version of ['1.2.3+linux.amd64', '1.2.3+versioncandidate', '1.2.3+claudesonnetlatest']) {
      expect(isOpenCodePassiveBinaryVersion(version)).toBe(true)
    }
  })
})
