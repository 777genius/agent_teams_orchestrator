import { expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  buildCursorReadinessFingerprint,
  probeCursorAccountIdentity,
  reconcileCursorNativeAuthority,
  resolveCursorExecutableIdentity,
  type CursorNativeAuthority,
} from './OpenCodeCursorNativeAuthority.js'

async function sandbox(): Promise<{ root: string; executable: string; statePath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-authority-'))
  const executable = path.join(root, 'cursor-agent')
  await writeFile(executable, '#!/bin/sh\nexit 0\n', 'utf8')
  await chmod(executable, 0o700)
  return { root, executable, statePath: path.join(root, 'control/native-authority.json') }
}

test('reuses a probe within its window and never stores the account in the clear', async () => {
  const { root, executable, statePath } = await sandbox()
  try {
    let probes = 0
    const probe = async () => { probes += 1; return 'a'.repeat(64) }
    const first = await reconcileCursorNativeAuthority({
      statePath, executablePath: executable, probe, now: () => 1_000,
    })
    expect(first.state).toBe('refreshed')
    expect(first.authority?.accountHash).toBe('a'.repeat(64))
    expect(probes).toBe(1)

    const reused = await reconcileCursorNativeAuthority({
      statePath, executablePath: executable, probe, now: () => 1_000 + 60_000,
    })
    expect(reused.state).toBe('reused')
    expect(probes).toBe(1)

    const persisted = await readFile(statePath, 'utf8')
    expect(persisted).not.toContain('@')
    expect(JSON.parse(persisted).accountHash).toMatch(/^[a-f0-9]{64}$/)
    expect((await readFile(statePath, 'utf8')).length).toBeLessThan(400)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a different account or a replaced binary invalidates readiness at once', async () => {
  const { root, executable, statePath } = await sandbox()
  try {
    await reconcileCursorNativeAuthority({
      statePath, executablePath: executable, probe: async () => 'a'.repeat(64), now: () => 1_000,
    })
    // Same window, but the user signed into another account.
    const switched = await reconcileCursorNativeAuthority({
      statePath, executablePath: executable, probe: async () => 'b'.repeat(64),
      now: () => 1_000 + CURSOR_TTL + 1,
    })
    expect(switched.state).toBe('account-changed')
    expect(switched.authority?.accountHash).toBe('b'.repeat(64))

    // A replaced binary re-probes inside the window instead of trusting the record.
    await writeFile(executable, '#!/bin/sh\nexit 1\n', 'utf8')
    let probes = 0
    const replaced = await reconcileCursorNativeAuthority({
      statePath, executablePath: executable, now: () => 1_000 + CURSOR_TTL + 2,
      probe: async () => { probes += 1; return 'b'.repeat(64) },
    })
    expect(probes).toBe(1)
    expect(replaced.state).toBe('executable-changed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
const CURSOR_TTL = 30 * 60 * 1000

test('a signed-out probe never yields an authority, and a corrupt record is not trusted', async () => {
  const { root, executable, statePath } = await sandbox()
  try {
    expect(await reconcileCursorNativeAuthority({
      statePath, executablePath: executable, probe: async () => null,
    })).toEqual({ authority: null, state: 'signed-out' })
    expect(await reconcileCursorNativeAuthority({
      statePath, executablePath: executable, probe: async () => { throw new Error('cli exploded') },
    })).toEqual({ authority: null, state: 'signed-out' })

    await mkdir(path.dirname(statePath), { recursive: true })
    for (const corrupt of ['{}', 'not json', '{"version":2}', '{"version":1,"accountHash":"short"}']) {
      await writeFile(statePath, corrupt, 'utf8')
      let probes = 0
      const result = await reconcileCursorNativeAuthority({
        statePath, executablePath: executable,
        probe: async () => { probes += 1; return 'c'.repeat(64) },
      })
      expect(probes).toBe(1)
      expect(result.state).toBe('refreshed')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reads only the account line and hashes it', async () => {
  const { root } = await sandbox()
  try {
    const executable = path.join(root, 'fake-status')
    await writeFile(executable,
      '#!/bin/sh\necho "\\342\\234\\223 Logged in as Person@Example.com"\n', 'utf8')
    await chmod(executable, 0o700)
    const first = await probeCursorAccountIdentity(executable, 'darwin')
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    // Case and surrounding decoration must not change the identity.
    await writeFile(executable, '#!/bin/sh\necho "logged in as person@example.com (Pro)"\n', 'utf8')
    expect(await probeCursorAccountIdentity(executable, 'darwin')).toBe(first)
    await writeFile(executable, '#!/bin/sh\necho "Not logged in"\n', 'utf8')
    expect(await probeCursorAccountIdentity(executable, 'darwin')).toBeNull()
    await writeFile(executable, '#!/bin/sh\nexit 3\n', 'utf8')
    expect(await probeCursorAccountIdentity(executable, 'darwin')).toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the readiness fingerprint changes with every bound input', () => {
  const authority: CursorNativeAuthority = {
    version: 1, accountHash: 'a'.repeat(64), executableHash: 'b'.repeat(64), probedAt: 1,
  }
  const base = {
    authority, assetsFingerprint: 'assets', profileScopeToken: 'scope',
    managedConfigFingerprint: 'config', proxyPort: 45123,
  }
  const fingerprint = buildCursorReadinessFingerprint(base)
  expect(fingerprint).toMatch(/^[a-f0-9]{64}$/)
  // Probe time is deliberately not bound: a fresh probe of the same identity is not drift.
  expect(buildCursorReadinessFingerprint({
    ...base, authority: { ...authority, probedAt: 999 },
  })).toBe(fingerprint)
  const variants = [
    { authority: { ...authority, accountHash: 'c'.repeat(64) } },
    { authority: { ...authority, executableHash: 'c'.repeat(64) } },
    { assetsFingerprint: 'other' },
    { profileScopeToken: 'other' },
    { managedConfigFingerprint: 'other' },
    { proxyPort: 45124 },
  ]
  for (const variant of variants) {
    expect(buildCursorReadinessFingerprint({ ...base, ...variant })).not.toBe(fingerprint)
  }
  for (const invalid of [{ assetsFingerprint: ' ' }, { profileScopeToken: '' }, { managedConfigFingerprint: '  ' }]) {
    expect(() => buildCursorReadinessFingerprint({ ...base, ...invalid })).toThrow('requires')
  }
  for (const port of [0, 1024, 1.5]) {
    expect(() => buildCursorReadinessFingerprint({ ...base, proxyPort: port }))
      .toThrow('retained proxy port')
  }
})

test('executable identity follows the resolved target, not the path used to reach it', async () => {
  const { root, executable } = await sandbox()
  try {
    const identity = await resolveCursorExecutableIdentity(executable)
    expect(identity).toMatch(/^[a-f0-9]{64}$/)
    expect(await resolveCursorExecutableIdentity(executable)).toBe(identity)
    await writeFile(executable, '#!/bin/sh\nexit 2\n', 'utf8')
    expect(await resolveCursorExecutableIdentity(executable)).not.toBe(identity)
    expect(resolveCursorExecutableIdentity(path.join(root, 'missing'))).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
