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

test('probes the account every time, so a sign-out inside the old window is caught', async () => {
  const { root, executable, statePath } = await sandbox()
  try {
    let account: string | null = 'a'.repeat(64)
    let probes = 0
    const probe = async () => { probes += 1; return account }
    const reconcile = (now: number) => reconcileCursorNativeAuthority({
      statePath, executablePath: executable, probe, now: () => now, dedupeMs: 0,
    })

    expect((await reconcile(1_000)).state).toBe('refreshed')
    expect(probes).toBe(1)

    // The defect this pins: with a trust window, a logout one second later stayed
    // invisible for half an hour. Nothing but a fresh probe can see it.
    account = null
    expect(await reconcile(2_000)).toEqual({ authority: null, state: 'signed-out' })
    expect(probes).toBe(2)

    // And a switch to another account is reported the moment it happens.
    account = 'b'.repeat(64)
    const switched = await reconcile(3_000)
    expect(switched.state).toBe('account-changed')
    expect(switched.authority?.accountHash).toBe('b'.repeat(64))

    const persisted = await readFile(statePath, 'utf8')
    expect(persisted).not.toContain('@')
    expect(JSON.parse(persisted).accountHash).toMatch(/^[a-f0-9]{64}$/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('deduplicates repeated probes inside a single launch burst', async () => {
  const { root, executable, statePath } = await sandbox()
  try {
    let probes = 0
    const probe = async () => { probes += 1; return 'a'.repeat(64) }
    const reconcile = (now: number) => reconcileCursorNativeAuthority({
      statePath, executablePath: executable, probe, now: () => now, dedupeMs: 5_000,
    })
    await reconcile(10_000)
    await reconcile(11_000)
    expect(probes).toBe(1)
    // Past the dedupe window the account is asked again, not assumed.
    await reconcile(20_000)
    expect(probes).toBe(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a replaced binary is reported even when the account is unchanged', async () => {
  const { root, executable, statePath } = await sandbox()
  try {
    const probe = async () => 'a'.repeat(64)
    await reconcileCursorNativeAuthority({
      statePath, executablePath: executable, probe, now: () => 1_000, dedupeMs: 0,
    })
    await writeFile(executable, '#!/bin/sh\nexit 1\n', 'utf8')
    expect((await reconcileCursorNativeAuthority({
      statePath, executablePath: executable, probe, now: () => 2_000, dedupeMs: 0,
    })).state).toBe('executable-changed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

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
        probe: async () => { probes += 1; return 'c'.repeat(64) }, dedupeMs: 0,
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

test('steady traffic cannot keep a stale account alive: the window never slides', async () => {
  const { root, executable, statePath } = await sandbox()
  try {
    let account: string | null = 'a'.repeat(64)
    let probes = 0
    const probe = async () => { probes += 1; return account }
    const reconcile = (now: number) => reconcileCursorNativeAuthority({
      statePath, executablePath: executable, probe, now: () => now, dedupeMs: 5_000,
    })

    // Asked every four seconds, inside a five second window. A window measured
    // from the last question would answer from cache forever.
    await reconcile(0)
    expect(probes).toBe(1)
    account = null
    let last = await reconcile(4_000)
    expect(probes).toBe(1)
    for (let at = 8_000; at <= 80_000; at += 4_000) last = await reconcile(at)

    expect(probes).toBeGreaterThan(1)
    expect(last).toEqual({ authority: null, state: 'signed-out' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
