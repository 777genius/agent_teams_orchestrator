import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHostedRawDomainProof,
  parseStrictHostedProofLastJsonFrame,
  readHostedControlSecret,
  resolveHostedControlOwnerBinding,
  validateHostedControlOwnerBindingSync,
} from './ownerProof.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('hosted owner proof identity', () => {
  test('retains canonical proof-last bytes and rejects alternate JSON spellings and duplicate keys', () => {
    const secret = Buffer.alloc(32, 7)
    const unsigned = JSON.stringify({ schemaVersion: 2, operation: 'control_state', payload: { teamId: 'team-a' } })
    const proof = createHostedRawDomainProof(secret, 'test-domain', 'request', unsigned)
    const line = `${unsigned.slice(0, -1)},"ownerProof":"${proof}"}`
    expect(parseStrictHostedProofLastJsonFrame(line, 'ownerProof')).toEqual({
      value: JSON.parse(line), serializedUnsignedEnvelope: unsigned, proof,
    })

    expect(() => parseStrictHostedProofLastJsonFrame(
      `{ "schemaVersion":2,"operation":"control_state","payload":{"teamId":"team-a"},"ownerProof":"${proof}"}`,
      'ownerProof',
    )).toThrow('canonical')
    expect(() => parseStrictHostedProofLastJsonFrame(
      `{"schemaVersion":2,"schemaVersion":2,"ownerProof":"${proof}"}`,
      'ownerProof',
    )).toThrow()
    expect(() => parseStrictHostedProofLastJsonFrame(
      `{"ownerProof":"${proof}","schemaVersion":2}`,
      'ownerProof',
    )).toThrow('final')
    for (const invalid of [
      `{"value":tru,"ownerProof":"${proof}"}`,
      `{"value":01,"ownerProof":"${proof}"}`,
      `{"value":"\\x20","ownerProof":"${proof}"}`,
    ]) expect(() => parseStrictHostedProofLastJsonFrame(invalid, 'ownerProof')).toThrow()
  })

  test('binds descriptor identities and accepts only an owner-private secret', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-owner-test-'))
    roots.push(root)
    await mkdir(join(root, 'teams', 'team'), { recursive: true })
    const identity = await resolveHostedControlOwnerBinding({ claudeRoot: root, legacyKey: 'team' })
    expect(identity.rootIdentity.claudeRoot).toHaveLength(2)
    expect(identity.rootIdentity.teamRoot).toHaveLength(2)
    const secretPath = join(await realpath(root), 'secret')
    await writeFile(secretPath, Buffer.alloc(32, 4).toString('hex'), { mode: 0o600 })
    expect((await readHostedControlSecret(secretPath)).byteLength).toBe(32)
    await chmod(secretPath, 0o644)
    await expect(readHostedControlSecret(secretPath)).rejects.toThrow('private owner-only')
  })

  test('does not follow a symlinked team directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-owner-link-test-'))
    const outside = await mkdtemp(join(tmpdir(), 'hosted-owner-outside-test-'))
    roots.push(root, outside)
    await mkdir(join(root, 'teams'), { recursive: true })
    await symlink(outside, join(root, 'teams', 'team'))
    await expect(resolveHostedControlOwnerBinding({ claudeRoot: root, legacyKey: 'team' })).rejects.toThrow()
  })

  test('accepts exactly 64 lowercase hex characters and decodes 32 bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-secret-format-test-'))
    roots.push(root)
    const path = join(await realpath(root), 'secret')
    for (const invalid of [
      Buffer.alloc(32, 4),
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      `${'a'.repeat(64)}\n`,
      'g'.repeat(64),
    ]) {
      await writeFile(path, invalid, { mode: 0o600 })
      await expect(readHostedControlSecret(path)).rejects.toThrow('invalid length')
    }
    await writeFile(path, 'ab'.repeat(32), { mode: 0o600 })
    expect(await readHostedControlSecret(path)).toEqual(Buffer.from('ab'.repeat(32), 'hex'))
  })
})

const nativeRootTest = process.platform === 'linux' ? test : test.skip
nativeRootTest('synchronous native fence detects replaced directory after asynchronous admission', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hosted-native-root-'))
  roots.push(temporary)
  const root = await realpath(temporary)
  const team = join(root, 'teams', 'team')
  await mkdir(team, { recursive: true })
  const admitted = await resolveHostedControlOwnerBinding({ claudeRoot: root, legacyKey: 'team' })
  const input = { claudeRoot: root, legacyKey: 'team', expectedRootIdentity: admitted.rootIdentity }
  expect(validateHostedControlOwnerBindingSync(input)).toBe(true)
  await rename(team, team + '-retained')
  await mkdir(team)
  expect(validateHostedControlOwnerBindingSync(input)).toBe(false)
  await rm(team, { recursive: true })
  await symlink(team + '-retained', team)
  // Even a link to the original inode must not substitute the admitted path.
  expect(validateHostedControlOwnerBindingSync(input)).toBe(false)
})

nativeRootTest('synchronous native fence rejects a replaced ancestor pointing at retained team', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hosted-native-ancestor-'))
  roots.push(temporary)
  const root = await realpath(temporary)
  await mkdir(join(root, 'teams', 'team'), { recursive: true })
  const admitted = await resolveHostedControlOwnerBinding({ claudeRoot: root, legacyKey: 'team' })
  await rename(join(root, 'teams'), join(root, 'original-teams'))
  await symlink(join(root, 'original-teams'), join(root, 'teams'))
  expect(validateHostedControlOwnerBindingSync({ claudeRoot: root, legacyKey: 'team',
    expectedRootIdentity: admitted.rootIdentity })).toBe(false)
})
