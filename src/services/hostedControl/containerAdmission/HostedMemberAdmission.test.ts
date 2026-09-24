import { afterEach, describe, expect, test } from 'bun:test'
import { createHmac, generateKeyPairSync, sign, createPublicKey } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HostedMemberAdmissionVerifier, HOSTED_MEMBER_ADMISSION_FORMAT,
  type HostedMemberAdmissionPayload, type LiveProductMemberAuthority } from './HostedMemberAdmission.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const now = 1_800_000_000_000
const payload: HostedMemberAdmissionPayload = {
  admissionId: 'a'.repeat(32),
  authorizationGeneration: 'authorization-generation_abcdefgh',
  bootId: 'boot_12345678', deploymentId: 'deployment_12345678',
  expiresAtMs: now + 60_000, format: HOSTED_MEMBER_ADMISSION_FORMAT,
  grantId: 'grant_abcdefgh', grantRevision: 'b'.repeat(64), issuedAtMs: now,
  laneId: 'lane_12345678', memberId: 'member_12345678', memberName: 'Member α',
  memberOrdinal: 0, model: 'opencode/model', mountGeneration: 1,
  operationId: 'operation_12345678', ownerGeneration: 1,
  ownerSessionId: 'owner-session_12345678',
  planGeneration: `plan-generation_${'c'.repeat(64)}`, planSha256: 'c'.repeat(64),
  policyId: 'hosted-opencode-member-v1', promptSha256: 'd'.repeat(64),
  restoreGeneration: 0, runId: 'run_12345678', teamId: 'team_12345678',
  workspaceId: 'workspace_12345678',
}

function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])))
}

function envelope(input: HostedMemberAdmissionPayload, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']): Buffer {
  const bytes = Buffer.concat([Buffer.from(`${HOSTED_MEMBER_ADMISSION_FORMAT}\0`),
    Buffer.from(canonical(input as unknown as Record<string, unknown>))])
  const signature = sign(null, bytes, privateKey).toString('base64url')
  return Buffer.from(canonical({ payload: JSON.parse(canonical(input as unknown as Record<string, unknown>)), signature }))
}

async function fixture(readClock: () => number = () => now) {
  const directory = await mkdtemp(join(tmpdir(), 'hosted-admission-'))
  roots.push(directory)
  await chmod(directory, 0o700)
  const pair = generateKeyPairSync('ed25519')
  let live = true
  let current: HostedMemberAdmissionPayload = payload
  const verifier = new HostedMemberAdmissionVerifier({
    stateDirectory: directory, testOnlyAllowNonRoot: true,
    productPublicKeyDer: pair.publicKey.export({ format: 'der', type: 'spki' }),
    now: readClock,
    readLiveProductAuthority: async () => {
      if (!live) return null
      const { admissionId: _admissionId, expiresAtMs: _expiresAtMs,
        format: _format, issuedAtMs: _issuedAtMs, ...authority } = current
      return authority
    },
  })
  return { directory, pair, verifier, raw: envelope(payload, pair.privateKey),
    setLive: (value: boolean) => { live = value },
    setAuthority: (value: HostedMemberAdmissionPayload) => { current = value },
  }
}

describe('HostedMemberAdmissionVerifier', () => {
  test('accepts the exact Product golden v1 envelope with RFC8032 public key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hosted-admission-golden-'))
    roots.push(directory)
    await chmod(directory, 0o700)
    const golden: HostedMemberAdmissionPayload = {
      admissionId: '0123456789abcdef0123456789abcdef',
      authorizationGeneration: 'authorization-generation_12345678',
      bootId: 'boot_1', deploymentId: 'deployment_1', expiresAtMs: now + 60_000,
      format: HOSTED_MEMBER_ADMISSION_FORMAT, grantId: 'grant_12345678',
      grantRevision: 'c'.repeat(64), issuedAtMs: now, laneId: 'lane_1',
      memberId: 'member_1', memberName: 'Reviewer', memberOrdinal: 0,
      model: 'openai/gpt-5.1-codex', mountGeneration: 1, operationId: 'operation_1',
      ownerGeneration: 1, ownerSessionId: 'owner-session_12345678',
      planGeneration: `plan-generation_${'a'.repeat(64)}`, planSha256: 'a'.repeat(64),
      policyId: 'hosted-opencode-member-v1', promptSha256: 'b'.repeat(64),
      restoreGeneration: 0, runId: 'run_1', teamId: 'team_1', workspaceId: 'workspace_1',
    }
    const signature = 'r9TVAIMyF9lV2fOxwKbUJ2WNuudrQOQZ69m4920vIf1RxVqWySA5i9FnrXWiJC93W1frzHSlA4lPRIo07lKUCw'
    const wire = Buffer.from(canonical({ payload: JSON.parse(canonical(golden as unknown as Record<string, unknown>)), signature }))
    const spki = Buffer.from('302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex')
    const verifier = new HostedMemberAdmissionVerifier({ stateDirectory: directory, testOnlyAllowNonRoot: true,
      productPublicKeyDer: createPublicKey({ key: spki, format: 'der', type: 'spki' })
        .export({ format: 'der', type: 'spki' }),
      now: () => now,
      readLiveProductAuthority: async () => {
        const { admissionId: _admissionId, format: _format, issuedAtMs: _issuedAtMs,
          expiresAtMs: _expiresAtMs, ...authority } = golden
        return authority
      },
    })
    expect(verifier.verify(wire).payload).toEqual(golden)
    const claim = await verifier.claim(wire)
    expect((await verifier.assertCurrent(wire, claim)).memberId).toBe('member_1')
  })

  test('requires independently supplied Product key and liveness before verification', async () => {
    const f = await fixture()
    const withoutKey = new HostedMemberAdmissionVerifier({
      stateDirectory: f.directory, testOnlyAllowNonRoot: true, now: () => now,
      readLiveProductAuthority: async () => payload as never,
    })
    const withoutLiveness = new HostedMemberAdmissionVerifier({
      stateDirectory: f.directory, testOnlyAllowNonRoot: true, now: () => now,
      productPublicKeyDer: f.pair.publicKey.export({ format: 'der', type: 'spki' }),
    })
    expect(() => withoutKey.verify(f.raw)).toThrow('unavailable')
    expect(() => withoutLiveness.verify(f.raw)).toThrow('unavailable')
    f.setLive(false)
    await expect(f.verifier.claim(f.raw)).rejects.toThrow('unavailable')
  })

  test('rejects Owner HMAC, wrong Product key, changed member/run/policy and noncanonical bytes', async () => {
    const f = await fixture()
    const forged = Buffer.from(canonical({ payload: JSON.parse(canonical(payload as unknown as Record<string, unknown>)),
      signature: createHmac('sha512', 'owner-secret').update(f.raw).digest('base64url') }))
    expect(() => f.verifier.verify(forged)).toThrow('invalid')
    const other = generateKeyPairSync('ed25519')
    expect(() => f.verifier.verify(envelope(payload, other.privateKey))).toThrow('invalid')
    for (const change of [{ memberId: 'member_changed' }, { runId: 'run_changed' }]) {
      const changed = { ...payload, ...change }
      await expect(f.verifier.claim(envelope(changed, f.pair.privateKey))).rejects.toThrow('unavailable')
    }
    expect(() => f.verifier.verify(envelope({ ...payload, policyId: 'hosted-member-dangerous-v1' },
      f.pair.privateKey))).toThrow('invalid')
    expect(() => f.verifier.verify(Buffer.from(` ${f.raw.toString()}`))).toThrow('invalid')
    expect(() => f.verifier.verify(Buffer.from(f.raw.toString().replace('"admissionId":',
      '"admissionId":"' + 'f'.repeat(32) + '","admissionId":')))).toThrow('invalid')
  })

  test('durable one-shot claim fences replay, changed raw bytes, restart and liveness loss', async () => {
    const f = await fixture()
    const claim = await f.verifier.claim(f.raw)
    expect((await f.verifier.assertCurrent(f.raw, claim)).admissionId).toBe(payload.admissionId)
    await expect(f.verifier.claim(f.raw)).rejects.toThrow('unavailable')
    await expect(f.verifier.assertCurrent(Buffer.from(`${f.raw.toString()}\n`), claim)).rejects.toThrow()
    const restarted = new HostedMemberAdmissionVerifier({ stateDirectory: f.directory, testOnlyAllowNonRoot: true,
      productPublicKeyDer: f.pair.publicKey.export({ format: 'der', type: 'spki' }),
      now: () => now,
      readLiveProductAuthority: async () => {
        const { admissionId: _admissionId, format: _format, issuedAtMs: _issuedAtMs,
          expiresAtMs: _expiresAtMs, ...authority } = payload
        return authority
      },
    })
    await expect(restarted.claim(f.raw)).rejects.toThrow('unavailable')
    await expect(restarted.assertCurrent(f.raw, claim)).rejects.toThrow('unavailable')
    f.setLive(false)
    await expect(f.verifier.assertCurrent(f.raw, claim)).rejects.toThrow('unavailable')
  })

  test('revoke tombstone fences effects and survives restart', async () => {
    const f = await fixture()
    const claim = await f.verifier.claim(f.raw)
    await f.verifier.revoke(f.raw)
    await expect(f.verifier.assertCurrent(f.raw, claim)).rejects.toThrow('unavailable')
    await expect(f.verifier.claim(f.raw)).rejects.toThrow('unavailable')
  })

  test('revoke before claim and partial tombstone after a crash both deny admission', async () => {
    const f = await fixture()
    await f.verifier.revoke(f.raw)
    await expect(f.verifier.claim(f.raw)).rejects.toThrow('unavailable')
    const other = await fixture()
    await writeFile(join(other.directory, `admission-${payload.admissionId}.revoked`),
      'incomplete', { mode: 0o600 })
    await expect(other.verifier.claim(other.raw)).rejects.toThrow('unavailable')
  })

  test('signed admission can be durably revoked after expiry', async () => {
    let clock = now
    const f = await fixture(() => clock)
    await f.verifier.claim(f.raw)
    clock = now + 60_001
    await f.verifier.revoke(f.raw)
    await expect(f.verifier.claim(f.raw)).rejects.toThrow('invalid')
  })

  test('ambiguous claim and corrupt records fail closed', async () => {
    const f = await fixture()
    await writeFile(join(f.directory, `admission-${payload.admissionId}.claim`), 'e'.repeat(64), { mode: 0o600 })
    await expect(f.verifier.claim(f.raw)).rejects.toThrow('unavailable')
    await writeFile(join(f.directory, `admission-${payload.admissionId}.claim`), 'partial', { mode: 0o600 })
    await expect(f.verifier.claim(f.raw)).rejects.toThrow('unavailable')
  })

  test('current Product authority must match signed mount, grant and plan pins', async () => {
    const f = await fixture()
    f.setAuthority({ ...payload, grantRevision: 'e'.repeat(64) })
    await expect(f.verifier.claim(f.raw)).rejects.toThrow('unavailable')
    f.setAuthority({ ...payload, mountGeneration: 2 })
    await expect(f.verifier.claim(f.raw)).rejects.toThrow('unavailable')
    f.setAuthority(payload)
    expect((await f.verifier.claim(f.raw)).admissionId).toBe(payload.admissionId)
  })

  test('effect check reobserves expiry after durable reads', async () => {
    let clockReads = 0
    let expiryOnRead = Infinity
    const f = await fixture(() => ++clockReads < expiryOnRead ? now : now + 60_001)
    const claim = await f.verifier.claim(f.raw)
    clockReads = 0
    expiryOnRead = 3
    await expect(f.verifier.assertCurrent(f.raw, claim)).rejects.toThrow('invalid')
  })

  test('effect check reobserves Product authority after durable reads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hosted-admission-live-'))
    roots.push(directory)
    await chmod(directory, 0o700)
    const pair = generateKeyPairSync('ed25519')
    const { admissionId: _admissionId, format: _format, issuedAtMs: _issuedAtMs,
      expiresAtMs: _expiresAtMs, ...authority } = payload
    let reads = 0
    let revokeOnRead = Infinity
    const verifier = new HostedMemberAdmissionVerifier({ stateDirectory: directory, testOnlyAllowNonRoot: true,
      productPublicKeyDer: pair.publicKey.export({ format: 'der', type: 'spki' }),
      now: () => now,
      readLiveProductAuthority: async () => ++reads < revokeOnRead ? authority : null,
    })
    const raw = envelope(payload, pair.privateKey)
    const claim = await verifier.claim(raw)
    reads = 0
    revokeOnRead = 2
    await expect(verifier.assertCurrent(raw, claim)).rejects.toThrow('unavailable')
  })

  test('constructor captures the independent liveness callback identity', async () => {
    const f = await fixture()
    const { admissionId: _admissionId, format: _format, issuedAtMs: _issuedAtMs,
      expiresAtMs: _expiresAtMs, ...authority } = payload
    const config = {
      stateDirectory: f.directory, testOnlyAllowNonRoot: true,
      productPublicKeyDer: f.pair.publicKey.export({ format: 'der', type: 'spki' }),
      now: () => now, readLiveProductAuthority: async (): Promise<LiveProductMemberAuthority | null> => authority,
    }
    const verifier = new HostedMemberAdmissionVerifier(config)
    config.readLiveProductAuthority = async () => null
    expect((await verifier.claim(f.raw)).admissionId).toBe(payload.admissionId)
  })

  test('production rejects writable ancestors and directory replacement cannot reset one-shot claims', async () => {
    const f = await fixture()
    expect(() => new HostedMemberAdmissionVerifier({ stateDirectory: f.directory,
      productPublicKeyDer: f.pair.publicKey.export({ format: 'der', type: 'spki' }),
      now: () => now,
      readLiveProductAuthority: async () => {
        const { admissionId: _admissionId, format: _format, issuedAtMs: _issuedAtMs,
          expiresAtMs: _expiresAtMs, ...authority } = payload
        return authority
      },
    })).toThrow('unavailable')
    await f.verifier.claim(f.raw)
    const oldDirectory = `${f.directory}-old`
    await rename(f.directory, oldDirectory)
    roots.push(oldDirectory)
    await mkdir(f.directory, { mode: 0o700 })
    await expect(f.verifier.claim(f.raw)).rejects.toThrow('unavailable')
  })
})
