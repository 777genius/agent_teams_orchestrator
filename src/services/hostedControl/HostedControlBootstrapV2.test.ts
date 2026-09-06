import { describe, expect, test } from 'bun:test'
import { AUTH_V2, BOOTSTRAP_V2, canonicalV2, decodeCanonicalV2, decodeFramesV2, hashV2, verifyLeaseV2 } from './HostedControlBootstrapV2Wire.js'
import { assembleFixtureV2, fixtureHeaderV2 } from './fixtures/bootstrapV2Producer.js'

function reject(header: any, options?: Parameters<typeof assembleFixtureV2>[1]) {
  const f = assembleFixtureV2(header, options)
  expect(() => decodeFramesV2(f.bootstrapFrame, f.authFrame)).toThrow()
  expect(f.bootstrapFrame.every(b => b === 0)).toBe(true)
  expect(f.authFrame.every(b => b === 0)).toBe(true)
}
describe('corrected Product bootstrap-v2 wire', () => {
  test('producer-equivalent H0 -> lease -> H2, separate digests and immutable W1 inputs', () => {
    const f = assembleFixtureV2(), decoded = decodeFramesV2(f.bootstrapFrame, f.authFrame)
    verifyLeaseV2(f.lease, decoded.header)
    expect(decoded.header.approvalActivationV2.signedManifest).not.toHaveProperty('manifestDigest')
    expect(decoded.header.bootstrapBinding.bootstrapDigest).not.toBe(decoded.bootstrapV2HeaderSha256)
    expect(decoded.header.leaseEvidence.leaseArtifactSha256).not.toBe(decoded.header.leaseEvidence.launcherArtifactDigest)
    expect(decoded.bootstrapV2HeaderSha256).toBe(hashV2(canonicalV2(decoded.header)))
    expect(Object.isFrozen(decoded.header.expectedHost.profile.sourceAuthSources[0])).toBe(true)
    expect(decoded.credentials).toEqual({ id: 'server-auth-test', username: 'test-user', password: 'test-password' })
    expect(f.authFrame.every(b => b === 0) && f.bootstrapFrame.every(b => b === 0)).toBe(true)
    const altered = JSON.parse(canonicalV2(decoded.header)); altered.rawRetention.captureId = 'f'.repeat(64)
    expect(() => verifyLeaseV2(f.lease, altered)).toThrow()
    decoded.secret.fill(0)
  })
  test('rejects HMAC, domain substitution, tampered private binding and proof-key digest', () => {
    for (const which of ['bootstrapFrame', 'authFrame'] as const) {
      const f = assembleFixtureV2(); f[which][f[which].length - 1] ^= 1
      expect(() => decodeFramesV2(f.bootstrapFrame, f.authFrame)).toThrow()
      expect(f.bootstrapFrame.every(b => b === 0)).toBe(true)
    }
    reject(fixtureHeaderV2(), { mutateAuth: a => { a.spawnNonce = '9'.repeat(64) } })
    reject(fixtureHeaderV2(), { mutateAuth: a => { a.bootstrapDigest = '9'.repeat(64) } })
    reject(fixtureHeaderV2(), { bootstrapMacDomain: AUTH_V2 })
    reject(fixtureHeaderV2(), { authMacDomain: BOOTSTRAP_V2 })
    reject(fixtureHeaderV2(), { bootstrapMacDomain: BOOTSTRAP_V2 + '\0' })
    const h = fixtureHeaderV2(); h.bootstrapBinding.proofKeyId = '0'.repeat(64); reject(h)
    const legacy = fixtureHeaderV2(); legacy.format = 'agent-teams.hosted-control.bootstrap/v1'; reject(legacy)
  })
  test('rejects duplicate keys, invalid UTF8/Unicode, BOM, LF, trailing frames and alternate number spellings', () => {
    for (const rewrite of [
      (s: string) => s.replace('"restoreGeneration":4', '"restoreGeneration":4,"restoreGeneration":4'),
      (s: string) => s.replace('"restoreGeneration":4', '"restoreGeneration":4e0'),
      (s: string) => s.replace('"restoreGeneration":4', '"restoreGeneration":-0'),
      (s: string) => '\ufeff' + s, (s: string) => s + '\n',
      (s: string) => s.replace('test-team', '\\ud800'),
    ]) reject(fixtureHeaderV2(), { headerText: rewrite })
    reject(fixtureHeaderV2(), { authText: s => s.replace('"username":"test-user"', '"username":"test-user","username":"test-user"') })
    expect(() => decodeCanonicalV2(Buffer.from([123, 34, 255, 34, 58, 49, 125]), 8192)).toThrow()
    for (const suffix of [Buffer.from('\n'), Buffer.alloc(1), assembleFixtureV2().bootstrapFrame]) {
      const f = assembleFixtureV2()
      expect(() => decodeFramesV2(Buffer.concat([f.bootstrapFrame, suffix]), f.authFrame)).toThrow()
    }
  })
  test('exact roles, alias rejection, unsigned bounds, strict nested fields, no partial manifest widening', () => {
    const mutations: ((h: any) => void)[] = [
      h => { h.descriptorMap.descriptors[7].childFd = 10 },
      h => { h.descriptorMap.descriptors[1].role = 'liveness' },
      h => { h.descriptorMap.descriptors[6].inode = h.descriptorMap.descriptors[5].inode },
      h => { h.expectedHost.process.startTicks = '01' },
      h => { h.expectedHost.executable.device = '18446744073709551616' },
      h => { h.expectedHost.process.pid = 0x80000000 },
      h => { h.expectedHost.process.startIdentity = 'start_' + '0'.repeat(64) },
      h => { h.expectedHost.profile.sourceAuthSources.push(h.expectedHost.profile.sourceAuthSources[0]) },
      h => { h.expectedHost.endpoint.baseUrl += '/' },
      h => { h.expectedHost.activation.ownerGeneration++ },
      h => { h.approvalActivationV2.signedManifest.manifestDigest = 'sha256:' + '3'.repeat(64) },
      h => { delete h.approvalActivationV2.signedManifest.launcherKeyId },
      h => { h.leaseEvidence.uid = 2 ** 32 },
      h => { h.rawRetention.initialSha256 = '0'.repeat(64) },
    ]
    for (const mutate of mutations) { const h = fixtureHeaderV2(); mutate(h); reject(h) }
    reject(fixtureHeaderV2(), { mutateAuth: a => { a.username = 'bad:user' } })
    reject(fixtureHeaderV2(), { mutateAuth: a => { a.password = 'a'.repeat(4097) } })
  })
  test('bounded header and authentication allocations', () => {
    reject(fixtureHeaderV2(), { headerText: s => s + ' '.repeat(65536) })
    reject(fixtureHeaderV2(), { authText: s => s + ' '.repeat(8192) })
    const f = assembleFixtureV2(); f.bootstrapFrame.writeUInt32BE(0xffffffff)
    expect(() => decodeFramesV2(f.bootstrapFrame, f.authFrame)).toThrow()
  })
})
