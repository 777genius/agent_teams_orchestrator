import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'

import { OpenCodeCatalogAuthorityClient, OpenCodeCatalogCommitUncertainError,
  type OpenCodeCatalogAuthorityLaunch } from './OpenCodeCatalogAuthorityClient.js'
import type { OpenCodeCatalogAuthorityIdentity } from './OpenCodeCatalogAuthorityProtocol.js'

const roots: string[] = []
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }) })

function sha(value: string) { return createHash('sha256').update(value).digest('hex') }
function identity(key = sha('key')): OpenCodeCatalogAuthorityIdentity {
  return { project_path: '/sandbox/project', provider_id: 'deepinfra',
    config_fingerprint: 'config', auth_fingerprint: 'auth', binary_fingerprint: 'binary',
    cache_key: key }
}
function envelopeFor(generation: number, attemptIdentity: string,
  exact: OpenCodeCatalogAuthorityIdentity, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ schema: 'opencode-provider-catalog-cache-v44307', authorityIdentity: exact,
    catalog: { generation }, catalogEvidence: { requestGeneration: generation, attemptIdentity }, ...extra })
}
async function root() { const value = await mkdtemp(path.join(os.tmpdir(), 'catalog-authority-')); roots.push(value); return value }
function client(cacheHome: string, timeout = 2_000, launch?: OpenCodeCatalogAuthorityLaunch) {
  const controller = new AbortController()
  return new OpenCodeCatalogAuthorityClient({ cacheHome, deadline: performance.now() + timeout,
    signal: controller.signal, launch })
}
function faultLaunch(fault: string): OpenCodeCatalogAuthorityLaunch {
  return input => Bun.spawn({ cmd: [input.launcherPath, input.workerPath, input.cacheHome],
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, OPENCODE_CATALOG_TEST_FAULT: fault } }) as never
}
async function seedLegacy(cache: string, version: 44305 | 44306, staged: number,
  exact = identity(), envelope = '{"legacy":true}') {
  const directory = path.join(cache, 'opencode', 'provider-catalog-authority-v44307')
  await mkdir(directory, { recursive: true }); const db = new Database(path.join(directory, 'authority.sqlite'))
  db.exec(`PRAGMA journal_mode=PERSIST; CREATE TABLE allocation_state(generation INTEGER);
    INSERT INTO allocation_state VALUES(7);
    CREATE TABLE migration_state(staged_generation INTEGER); INSERT INTO migration_state VALUES(${staged});
    CREATE TABLE catalog_entry(cache_key TEXT,identity_json TEXT,envelope_json TEXT,request_generation INTEGER);
    PRAGMA user_version=${version}`)
  db.query('INSERT INTO catalog_entry VALUES(?1,?2,?3,?4)')
    .run(exact.cache_key, JSON.stringify(exact), envelope, 9)
  db.close(); return exact
}
async function seedExternalLegacy(cache: string, exact: OpenCodeCatalogAuthorityIdentity) {
  const directory = path.join(cache, 'opencode', 'provider-catalog-attempts-v2')
  await mkdir(directory, { recursive: true }); const db = new Database(path.join(directory, 'attempts.sqlite'))
  db.exec(`PRAGMA journal_mode=PERSIST; CREATE TABLE allocation_state(generation INTEGER);
    INSERT INTO allocation_state VALUES(30);
    CREATE TABLE catalog_entry(cache_key TEXT,request_generation INTEGER,attempt_identity TEXT,
      attempt_id TEXT,pointer_json TEXT,envelope_json TEXT,retained_order INTEGER);
    PRAGMA user_version=44306`)
  db.query('INSERT INTO catalog_entry VALUES(?1,?2,?3,?4,?5,?6,?7)')
    .run(exact.cache_key, 29, `sha256:${'1'.repeat(64)}`, 'legacy-attempt', '{}', '{"external":true}', 29)
  db.close()
}

describe.serial('native v44307 catalog authority', () => {
  test('a canceled intervening attempt permanently fences an older exact-key candidate', async () => {
    const cache = await root(); const x = identity(sha('x')); const y = identity(sha('y'))
    const a = client(cache); const ar = await a.beginAttempt(1, sha('scope-a')); await a.bindAndRead(ar.generation, ar.attemptIdentity, x)
    const b = client(cache); const br = await b.beginAttempt(2, sha('scope-b')); await b.bindAndRead(br.generation, br.attemptIdentity, y); await b.close()
    await expect(a.finalize(ar.generation, ar.attemptIdentity, x,
      envelopeFor(ar.generation, ar.attemptIdentity, x, { candidate: 'A' }), 2, 3)).rejects.toThrow(/SUPERSEDED/)
    await a.close()
    const c = client(cache); const cr = await c.beginAttempt(3, sha('scope-c'))
    expect(cr.generation).toBe(br.generation + 1)
    await c.bindAndRead(cr.generation, cr.attemptIdentity, x)
    await expect(c.finalize(cr.generation, cr.attemptIdentity, x,
      envelopeFor(cr.generation + 1, cr.attemptIdentity, x), 3, 4)).rejects.toThrow(/CANDIDATE_MISMATCH/)
    await c.finalize(cr.generation, cr.attemptIdentity, x,
      envelopeFor(cr.generation, cr.attemptIdentity, x, { candidate: 'C' }), 3, 4)
    await c.close()
  })

  test('commit-before-reply timeout resolves the exact committed envelope idempotently', async () => {
    const cache = await root(); const exact = identity();
    const first = client(cache, 1_000, faultLaunch('stall:finalize-after-commit-before-reply'))
    const begun = await first.beginAttempt(1, sha('scope'))
    await first.bindAndRead(begun.generation, begun.attemptIdentity, exact)
    const durable = envelopeFor(begun.generation, begun.attemptIdentity, exact, { durable: true })
    await expect(first.finalize(begun.generation, begun.attemptIdentity, exact,
      durable, 1, 2)).resolves.toEqual({ committed: true, generation: begun.generation })
    const restart = client(cache); const next = await restart.beginAttempt(2, sha('scope-next'))
    expect(next.generation).toBe(begun.generation + 1)
    const prior = await restart.bindAndRead(next.generation, next.attemptIdentity, exact)
    expect(prior.previousEnvelope).toBe(durable)
    await restart.close()
  })

  test('bounded resolve failure reports explicit uncertainty and never authorizes stale proof', async () => {
    const cache = await root(); const exact = identity(sha('uncertain')); let launches = 0
    const launch: OpenCodeCatalogAuthorityLaunch = input => {
      const fault = launches++ === 0
        ? 'stall:finalize-after-commit-before-reply' : 'stall:resolve-open'
      return Bun.spawn({ cmd: [input.launcherPath, input.workerPath, input.cacheHome],
        stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, OPENCODE_CATALOG_TEST_FAULT: fault } }) as never
    }
    const authority = client(cache, 700, launch)
    const begun = await authority.beginAttempt(1, sha('uncertain-scope'))
    await authority.bindAndRead(begun.generation, begun.attemptIdentity, exact)
    await expect(authority.finalize(begun.generation, begun.attemptIdentity, exact,
      envelopeFor(begun.generation, begun.attemptIdentity, exact), 1, 2))
      .rejects.toBeInstanceOf(OpenCodeCatalogCommitUncertainError)
  })

  test('kill immediately before FINALIZE commit publishes nothing and never reuses generation', async () => {
    const cache = await root(); const exact = identity(sha('before-finalize'))
    const first = client(cache, 1_000, faultLaunch('exit:finalize-before-commit'))
    const begun = await first.beginAttempt(1, sha('before-finalize-scope'))
    await first.bindAndRead(begun.generation, begun.attemptIdentity, exact)
    await expect(first.finalize(begun.generation, begun.attemptIdentity, exact,
      envelopeFor(begun.generation, begun.attemptIdentity, exact), 1, 2)).rejects.toThrow()
    const restart = client(cache); const next = await restart.beginAttempt(2, sha('after-finalize-kill'))
    expect(next.generation).toBe(begun.generation + 1)
    expect((await restart.bindAndRead(next.generation, next.attemptIdentity, exact)).previousEnvelope).toBeNull()
    await restart.close()
  })

  test.each([20, 100])('a stalled native open is killed by the %dms absolute deadline', async timeout => {
    const cache = await root(); const stalled = client(cache, timeout, faultLaunch('stall:begin-open'))
    const started = performance.now()
    await expect(stalled.beginAttempt(1, sha('scope'))).rejects.toThrow(/deadline/)
    expect(performance.now() - started).toBeLessThan(timeout + 250)
  })

  test.each(['vfs-open', 'vfs-read', 'vfs-lock', 'vfs-write', 'vfs-sync', 'vfs-commit'])(
    '%s stalls are preempted without an acknowledgement', async phase => {
      const cache = await root(); const stalled = client(cache, 40, faultLaunch(`stall:${phase}`))
      await expect(stalled.beginAttempt(1, sha(phase))).rejects.toThrow(/deadline/)
    })

  test('a stalled native close remains bounded by the attempt deadline', async () => {
    const cache = await root(); const authority = client(cache, 300, faultLaunch('stall:vfs-close'))
    await authority.beginAttempt(1, sha('close-stall')); const started = performance.now()
    await authority.close(); expect(performance.now() - started).toBeLessThan(400)
  })

  test('an authority DB pathname replacement after BEGIN fails closed at actual use', async () => {
    if (process.platform === 'win32') return
    const cache = await root(); const authority = client(cache); const begun = await authority.beginAttempt(1, sha('scope'))
    const dbPath = path.join(cache, 'opencode', 'provider-catalog-authority-v44307', 'authority.sqlite')
    await rename(dbPath, `${dbPath}.swapped`); await writeFile(dbPath, 'replacement')
    await expect(authority.bindAndRead(begun.generation, begun.attemptIdentity, identity())).rejects.toThrow(/DB_REPLACED/)
    await authority.close()
  })

  test('launcher executes its held worker object after a gated pathname swap', async () => {
    if (process.platform !== 'linux') return
    const cache = await root(); const artifacts = await root(); const gate = path.join(artifacts, 'launch-gate')
    const sourceRoot = path.resolve(import.meta.dir, '../../..')
    const launcherPath = path.join(artifacts, 'opencode-catalog-launcher')
    const workerPath = path.join(artifacts, 'opencode-catalog-authority')
    await copyFile(path.join(sourceRoot, 'native/opencode-catalog-launcher/target/debug/opencode-catalog-launcher'), launcherPath)
    await copyFile(path.join(sourceRoot, 'native/opencode-catalog-authority/target/debug/opencode-catalog-authority'), workerPath)
    await chmod(launcherPath, 0o755); await chmod(workerPath, 0o755)
    const launch: OpenCodeCatalogAuthorityLaunch = input => Bun.spawn({
      cmd: [input.launcherPath, input.workerPath, input.cacheHome], stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, OPENCODE_CATALOG_LAUNCHER_TEST_GATE: gate },
    }) as never
    const controller = new AbortController()
    const authority = new OpenCodeCatalogAuthorityClient({ cacheHome: cache,
      deadline: performance.now() + 2_000, signal: controller.signal, launch, launcherPath, workerPath })
    while (!await Bun.file(`${gate}.entered`).exists()) await new Promise(resolve => setImmediate(resolve))
    await rename(workerPath, `${workerPath}.held`)
    await writeFile(workerPath, '#!/bin/sh\nexit 97\n'); await chmod(workerPath, 0o755)
    await writeFile(`${gate}.release`, '')
    expect((await authority.beginAttempt(1, sha('launcher-swap'))).generation).toBe(1)
    await authority.close()
  })

  test.each(['authority.sqlite-journal', 'root', 'intermediate'])(
    'an authority %s replacement after BEGIN fails closed at actual use', async target => {
      if (process.platform === 'win32') return
      const cache = await root(); const authority = client(cache)
      const begun = await authority.beginAttempt(1, sha(`swap-${target}`))
      const authorityRoot = path.join(cache, 'opencode', 'provider-catalog-authority-v44307')
      if (target === 'root') {
        await rename(authorityRoot, `${authorityRoot}.swapped`); await mkdir(authorityRoot)
      } else if (target === 'intermediate') {
        const intermediate = path.dirname(authorityRoot)
        await rename(intermediate, `${intermediate}.swapped`); await mkdir(intermediate)
      } else {
        const selected = path.join(authorityRoot, target)
        await rename(selected, `${selected}.swapped`); await writeFile(selected, 'replacement')
      }
      await expect(authority.bindAndRead(begun.generation, begun.attemptIdentity, identity()))
        .rejects.toThrow(/REPLACED/)
      await authority.close()
    })

  test('44306 migration burns staged high water and retains exact identity catalog bytes', async () => {
    const cache = await root(); const exact = await seedLegacy(cache, 44306, 11)
    const authority = client(cache); const begun = await authority.beginAttempt(1, sha('scope'))
    expect(begun.generation).toBe(12)
    const prior = await authority.bindAndRead(begun.generation, begun.attemptIdentity, exact)
    expect(prior.previousEnvelope).toBe('{"legacy":true}')
    await authority.close()
  })

  test('44305 live-journal migration retains bytes and burns its maximum marker', async () => {
    const cache = await root(); const exact = await seedLegacy(cache, 44305, 14, identity(sha('44305')),
      '{"from":44305}')
    const dbPath = path.join(cache, 'opencode', 'provider-catalog-authority-v44307', 'authority.sqlite')
    const legacy = new Database(dbPath)
    const zero = '0'.repeat(64); const payloadHash = sha('legacy-audit')
    const eventHash = sha(`${zero}\0${1}\0${14}\0LEGACY\0${payloadHash}`)
    legacy.exec(`CREATE TABLE audit_anchor(singleton INTEGER,pruned_through INTEGER,anchor_hash TEXT);
      INSERT INTO audit_anchor VALUES(1,0,'${zero}');
      CREATE TABLE audit_event(sequence INTEGER,generation INTEGER,kind TEXT,payload_hash TEXT,
        previous_hash TEXT,event_hash TEXT);
      INSERT INTO audit_event VALUES(1,14,'LEGACY','${payloadHash}','${zero}','${eventHash}')`)
    legacy.close()
    const authority = client(cache); const begun = await authority.beginAttempt(1, sha('scope-44305'))
    expect(begun.generation).toBe(15)
    expect((await authority.bindAndRead(begun.generation, begun.attemptIdentity, exact)).previousEnvelope)
      .toBe('{"from":44305}')
    await authority.close()
    const migrated = new Database(dbPath, { readonly: true })
    expect(migrated.query('SELECT min(sequence) AS sequence,previous_hash FROM audit_event').get())
      .toEqual({ sequence: 2, previous_hash: eventHash })
    migrated.close()
  })

  test('44306 missing allocation state is corruption and cannot reset generation to one', async () => {
    const cache = await root()
    const directory = path.join(cache, 'opencode', 'provider-catalog-authority-v44307')
    await mkdir(directory, { recursive: true })
    const db = new Database(path.join(directory, 'authority.sqlite'))
    db.exec(`PRAGMA journal_mode=PERSIST;
      CREATE TABLE catalog_entry(cache_key TEXT,identity_json TEXT,envelope_json TEXT,request_generation INTEGER);
      PRAGMA user_version=44306`)
    db.close()
    const authority = client(cache, 500)
    await expect(authority.beginAttempt(1, sha('missing-allocation'))).rejects.toThrow()
    await authority.close()
    const check = new Database(path.join(directory, 'authority.sqlite'), { readonly: true })
    expect(check.query('PRAGMA user_version').get()).toEqual({ user_version: 44306 })
    check.close()
  })

  test('bounded sibling import burns the real 44306 authority and retains its exact key', async () => {
    const cache = await root(); const exact = identity(sha('external-key'))
    await seedExternalLegacy(cache, exact)
    const authority = client(cache); const begun = await authority.beginAttempt(1, sha('external-scope'))
    expect(begun.generation).toBe(31)
    expect((await authority.bindAndRead(begun.generation, begun.attemptIdentity, exact)).previousEnvelope)
      .toBe('{"external":true}')
    await authority.close()
  })

  test('POSIX sibling import reads the retained legacy fd across pathname ABA replacement', async () => {
    if (process.platform === 'win32') return
    const cache = await root(); const exact = identity(sha('legacy-aba')); await seedExternalLegacy(cache, exact)
    const gate = path.join(cache, 'legacy-import-gate')
    const launch: OpenCodeCatalogAuthorityLaunch = input => Bun.spawn({
      cmd: [input.launcherPath, input.workerPath, input.cacheHome], stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, OPENCODE_CATALOG_TEST_GATE_PHASE: 'legacy-after-handle',
        OPENCODE_CATALOG_TEST_GATE: gate },
    }) as never
    const authority = client(cache, 2_000, launch)
    const pending = authority.beginAttempt(1, sha('legacy-aba-scope'))
    while (!await Bun.file(`${gate}.entered`).exists()) await new Promise(resolve => setImmediate(resolve))
    const dbPath = path.join(cache, 'opencode', 'provider-catalog-attempts-v2', 'attempts.sqlite')
    await rename(dbPath, `${dbPath}.original`); await writeFile(dbPath, 'replacement')
    await writeFile(`${gate}.release`, '')
    const begun = await pending
    expect(begun.generation).toBe(31)
    expect((await authority.bindAndRead(begun.generation, begun.attemptIdentity, exact)).previousEnvelope)
      .toBe('{"external":true}')
    await authority.close()
  })

  test.each(['migration-before-commit', 'migration-after-commit', 'migration-after-directory-sync'])(
    'restart after %s never wedges or reuses a legacy generation', async phase => {
      const cache = await root(); await seedLegacy(cache, 44306, 20)
      const interrupted = client(cache, 200, faultLaunch(`exit:${phase}`))
      await expect(interrupted.beginAttempt(1, sha(phase))).rejects.toThrow()
      const restart = client(cache); const begun = await restart.beginAttempt(2, sha(`${phase}-restart`))
      expect(begun.generation).toBe(21); await restart.close()
    })

  test('a resumed migration directory-sync stall cannot acknowledge BEGIN', async () => {
    const cache = await root(); const initial = client(cache)
    await initial.beginAttempt(1, sha('initialize')); await initial.close()
    const stalled = client(cache, 40, faultLaunch('stall:migration-resume-before-directory-sync'))
    await expect(stalled.beginAttempt(2, sha('resume-sync'))).rejects.toThrow(/deadline/)
    const restart = client(cache); expect((await restart.beginAttempt(3, sha('resume-restart'))).generation)
      .toBe(2)
    await restart.close()
  })

  test('first-use directory sync failure acknowledges no generation', async () => {
    const cache = await root(); const interrupted = client(cache, 200,
      faultLaunch('exit:root-before-directory-sync'))
    await expect(interrupted.beginAttempt(1, sha('first-use'))).rejects.toThrow()
    const restart = client(cache); expect((await restart.beginAttempt(2, sha('restart'))).generation).toBe(1)
    await restart.close()
  })
})
