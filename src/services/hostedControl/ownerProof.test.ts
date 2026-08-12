import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHostedControlSecret, resolveHostedControlOwnerBinding } from './ownerProof.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('hosted owner proof identity', () => {
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
