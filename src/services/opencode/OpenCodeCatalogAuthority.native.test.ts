import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'

import { OpenCodeCatalogAbortError, OpenCodeCatalogAuthorityClient, OpenCodeCatalogCommitUncertainError,
  OpenCodeCatalogDeadlineError,
  type OpenCodeCatalogAuthorityLaunch } from './OpenCodeCatalogAuthorityClient.js'
import type { OpenCodeCatalogAuthorityIdentity } from './OpenCodeCatalogAuthorityProtocol.js'

const roots: string[] = []
const clients = new Set<OpenCodeCatalogAuthorityClient>()
setDefaultTimeout(60_000)
async function cleanupFixtures() {
  const ownedClients = [...clients]; clients.clear()
  await Promise.allSettled(ownedClients.map(authority => authority.close()))
  const ownedRoots = roots.splice(0)
  await Promise.all(ownedRoots.map(root => rm(root, { recursive: true, force: true })))
  for (const root of ownedRoots) await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })
}
afterEach(cleanupFixtures)
afterAll(cleanupFixtures)

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
function client(cacheHome: string, timeout = 10_000, launch?: OpenCodeCatalogAuthorityLaunch) {
  const controller = new AbortController()
  const authority = new OpenCodeCatalogAuthorityClient({ cacheHome,
    deadline: performance.now() + timeout, signal: controller.signal, launch })
  clients.add(authority); return authority
}
async function withTemporaryAuthorityRoot<T>(work: (root: string) => Promise<T>): Promise<T> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'catalog-authority-scoped-'))
  try { return await work(temporary) }
  finally { await rm(temporary, { recursive: true, force: true }) }
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
  db.exec(`PRAGMA journal_mode=PERSIST;
    CREATE TABLE allocation_ticket (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_hash TEXT NOT NULL CHECK(length(scope_hash) = 64),
      started_at INTEGER NOT NULL CHECK(started_at >= 0)${version === 44306
        ? ', cache_key TEXT CHECK(cache_key IS NULL OR length(cache_key) = 64)' : ''}
    );
    CREATE TABLE allocation_state (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      generation INTEGER NOT NULL CHECK(generation >= 0)
    ); INSERT INTO allocation_state VALUES(1,${staged});
    ${version === 44306 ? `CREATE TABLE catalog_entry (
      cache_key TEXT PRIMARY KEY CHECK(length(cache_key) = 64),
      request_generation INTEGER NOT NULL CHECK(request_generation > 0),
      attempt_identity TEXT NOT NULL CHECK(length(attempt_identity) = 71),
      attempt_id TEXT NOT NULL, pointer_json TEXT NOT NULL, envelope_json TEXT NOT NULL,
      retained_order INTEGER NOT NULL CHECK(retained_order > 0)
    );` : ''}
    PRAGMA user_version=${version}`)
  const ticket = db.query(version === 44306
    ? 'INSERT INTO allocation_ticket(scope_hash,started_at,cache_key) VALUES(?1,?2,?3)'
    : 'INSERT INTO allocation_ticket(scope_hash,started_at) VALUES(?1,?2)')
  for (let generation = Math.max(1, staged - 63); generation <= staged; generation += 1) {
    if (version === 44306) ticket.run(sha(`scope-${generation}`), generation,
      generation === staged ? exact.cache_key : null)
    else ticket.run(sha(`scope-${generation}`), generation)
  }
  if (version === 44306) db.query('INSERT INTO catalog_entry VALUES(?1,?2,?3,?4,?5,?6,?7)')
    .run(exact.cache_key, staged - 1, `sha256:${'1'.repeat(64)}`, 'legacy-attempt', '{}', envelope, staged - 1)
  db.close(); return exact
}
async function seedExternalLegacy(cache: string, exact: OpenCodeCatalogAuthorityIdentity) {
  const directory = path.join(cache, 'opencode', 'provider-catalog-attempts-v2')
  await mkdir(directory, { recursive: true }); const db = new Database(path.join(directory, 'attempts.sqlite'))
  db.exec(`PRAGMA journal_mode=PERSIST; CREATE TABLE allocation_ticket (
      id INTEGER PRIMARY KEY AUTOINCREMENT, scope_hash TEXT NOT NULL CHECK(length(scope_hash) = 64),
      started_at INTEGER NOT NULL CHECK(started_at >= 0),
      cache_key TEXT CHECK(cache_key IS NULL OR length(cache_key) = 64));
    CREATE TABLE allocation_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      generation INTEGER NOT NULL CHECK(generation >= 0)); INSERT INTO allocation_state VALUES(1,30);
    CREATE TABLE catalog_entry (cache_key TEXT PRIMARY KEY CHECK(length(cache_key) = 64),
      request_generation INTEGER NOT NULL CHECK(request_generation > 0),
      attempt_identity TEXT NOT NULL CHECK(length(attempt_identity) = 71), attempt_id TEXT NOT NULL,
      pointer_json TEXT NOT NULL,envelope_json TEXT NOT NULL,
      retained_order INTEGER NOT NULL CHECK(retained_order > 0)); PRAGMA user_version=44306`)
  const ticket = db.query('INSERT INTO allocation_ticket(scope_hash,started_at,cache_key) VALUES(?1,?2,?3)')
  for (let generation = 1; generation <= 30; generation += 1) {
    ticket.run(sha(`external-${generation}`), generation, generation === 30 ? exact.cache_key : null)
  }
  db.query('INSERT INTO catalog_entry VALUES(?1,?2,?3,?4,?5,?6,?7)')
    .run(exact.cache_key, 29, `sha256:${'1'.repeat(64)}`, 'legacy-attempt', '{}', '{"external":true}', 29)
  db.close()
}

describe.serial('native v44307 catalog authority', () => {
  test('warm authority serializes eight simultaneous clients for repeated rounds without leaks', async () => {
    const cache = await root()
    const warm = client(cache, 10_000)
    expect((await warm.beginAttempt(0, sha('concurrency-warm'))).generation).toBe(1)
    await warm.close()

    const processes: Array<{ exited: Promise<number> }> = []
    const trackedLaunch: OpenCodeCatalogAuthorityLaunch = input => {
      const child = Bun.spawn({ cmd: [input.launcherPath, input.workerPath, input.cacheHome],
        stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
      processes.push(child)
      return child as never
    }
    let expected = 2
    for (let round = 0; round < 3; round += 1) {
      const authorities = Array.from({ length: 8 }, () => client(cache, 15_000, trackedLaunch))
      const begun = await Promise.all(authorities.map((authority, index) =>
        authority.beginAttempt(round * 8 + index + 1, sha(`concurrency-${round}-${index}`))))
      const generations = begun.map(value => value.generation).sort((a, b) => a - b)
      expect(generations).toEqual(Array.from({ length: 8 }, (_, index) => expected + index))
      expect(new Set(begun.map(value => value.attemptIdentity)).size).toBe(8)
      expected += 8
      await Promise.all(authorities.map(authority => authority.close()))
    }
    expect(await Promise.all(processes.map(process => process.exited)))
      .toEqual(Array.from({ length: 24 }, () => 0))

    const check = new Database(path.join(cache, 'opencode',
      'provider-catalog-authority-v44307', 'authority.sqlite'), { readonly: true })
    expect(check.query('SELECT generation FROM authority_state').get()).toEqual({ generation: 25 })
    check.close()
  })

  test('a lock contender with a tiny deadline fails precisely and leaves later allocation healthy', async () => {
    const cache = await root(); const warm = client(cache, 5_000)
    expect((await warm.beginAttempt(0, sha('tiny-warm'))).generation).toBe(1)
    await warm.close()
    const dbPath = path.join(cache, 'opencode', 'provider-catalog-authority-v44307', 'authority.sqlite')
    const blocker = new Database(dbPath)
    blocker.exec('BEGIN IMMEDIATE')
    const late = client(cache, 35)
    const started = performance.now()
    try {
      await expect(late.beginAttempt(1, sha('tiny-contender')))
        .rejects.toBeInstanceOf(OpenCodeCatalogDeadlineError)
      expect(performance.now() - started).toBeLessThan(500)
    } finally {
      blocker.exec('ROLLBACK'); blocker.close()
    }
    const restart = client(cache, 5_000)
    expect((await restart.beginAttempt(2, sha('tiny-restart'))).generation).toBe(2)
    await restart.close()
  })

  test('post-COMMIT abort resolves exactly in repeated eight-client contention rounds', async () => {
    const cache = await root(); let expectedGeneration = 1
    for (let round = 0; round < 3; round += 1) {
      const exact = identity(sha(`post-commit-contention-${round}`))
      const controller = new AbortController()
      const authority = new OpenCodeCatalogAuthorityClient({ cacheHome: cache,
        deadline: performance.now() + 15_000, signal: controller.signal,
        launch: faultLaunch('stall:finalize-after-commit-before-reply') })
      clients.add(authority)
      const begun = await authority.beginAttempt(round, sha(`post-commit-contention-scope-${round}`))
      expect(begun.generation).toBe(expectedGeneration)
      await authority.bindAndRead(begun.generation, begun.attemptIdentity, exact)
      const envelope = envelopeFor(begun.generation, begun.attemptIdentity, exact, { round })
      const finalizing = authority.finalize(begun.generation, begun.attemptIdentity,
        exact, envelope, round, round + 1)
      const dbPath = path.join(cache, 'opencode',
        'provider-catalog-authority-v44307', 'authority.sqlite')
      const committedBy = performance.now() + 5_000
      for (;;) {
        try {
          const check = new Database(dbPath, { readonly: true })
          const committed = check.query('SELECT count(*) AS count FROM committed_result WHERE generation=?1')
            .get(begun.generation) as { count: number }
          check.close()
          if (committed.count === 1) break
        } catch {}
        if (performance.now() >= committedBy) throw new Error('post-COMMIT fixture deadline')
        await new Promise(resolve => setTimeout(resolve, 2))
      }

      const blocker = new Database(dbPath); blocker.exec('BEGIN IMMEDIATE')
      const contenders = Array.from({ length: 8 }, (_, index) => {
        const contender = client(cache, 12_000)
        return { contender, begun: contender.beginAttempt(round * 8 + index + 100,
          sha(`post-commit-contender-${round}-${index}`)) }
      })
      controller.abort()
      await new Promise(resolve => setTimeout(resolve, 50))
      blocker.exec('ROLLBACK'); blocker.close()
      await expect(finalizing).resolves.toEqual({ committed: true, generation: begun.generation })
      const allocations = await Promise.all(contenders.map(value => value.begun))
      const generations = allocations.map(value => value.generation).sort((a, b) => a - b)
      expect(generations).toEqual(Array.from({ length: 8 }, (_, index) =>
        begun.generation + index + 1))
      await Promise.all(contenders.map(value => value.contender.close()))
      expectedGeneration += 9
    }
  })

  test('abort and native deadline remain distinct client results', async () => {
    const cache = await root(); const controller = new AbortController()
    const authority = new OpenCodeCatalogAuthorityClient({ cacheHome: cache,
      deadline: performance.now() + 5_000, signal: controller.signal,
      launch: faultLaunch('stall:begin-open') })
    clients.add(authority)
    const pending = authority.beginAttempt(0, sha('abort-distinction'))
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(OpenCodeCatalogAbortError)
  })

  test.each(['failure', 'timeout'])('scoped fixture cleanup survives injected %s', async mode => {
    let fixture = ''
    const operation = withTemporaryAuthorityRoot(async temporary => {
      fixture = temporary; await writeFile(path.join(temporary, 'owned'), 'fixture')
      if (mode === 'failure') throw new Error('injected assertion failure')
      await new Promise((_, reject) => setTimeout(() => reject(new Error('injected timeout')), 5))
    })
    await expect(operation).rejects.toThrow(mode)
    await expect(lstat(fixture)).rejects.toMatchObject({ code: 'ENOENT' })
  })

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

  test('same-key A remains exactly resolvable after committed B overwrites the catalog head', async () => {
    const cache = await root(); const exact = identity(sha('same-key'))
    const a = client(cache); const ar = await a.beginAttempt(1, sha('same-key-a'))
    await a.bindAndRead(ar.generation, ar.attemptIdentity, exact)
    const aEnvelope = envelopeFor(ar.generation, ar.attemptIdentity, exact, { winner: 'A' })
    await a.finalize(ar.generation, ar.attemptIdentity, exact, aEnvelope, 1, 2); await a.close()
    const b = client(cache); const br = await b.beginAttempt(2, sha('same-key-b'))
    await b.bindAndRead(br.generation, br.attemptIdentity, exact)
    const bEnvelope = envelopeFor(br.generation, br.attemptIdentity, exact, { winner: 'B' })
    await b.finalize(br.generation, br.attemptIdentity, exact, bEnvelope, 2, 3); await b.close()
    const resolver = client(cache)
    await expect(resolver.finalize(ar.generation, ar.attemptIdentity, exact, aEnvelope, 1, 2))
      .resolves.toEqual({ committed: true, generation: ar.generation })
    await expect(resolver.resolve(ar.generation, ar.attemptIdentity, exact)).resolves.toEqual({
      resolved: true, committed: true, generation: ar.generation, envelopeJson: aEnvelope,
    })
    await resolver.close()
  })

  test('abort after native COMMIT spends the non-cancellable reserve on exact resolve', async () => {
    const cache = await root(); const exact = identity(sha('post-commit-abort'))
    const controller = new AbortController()
    const authority = new OpenCodeCatalogAuthorityClient({ cacheHome: cache,
      deadline: performance.now() + 2_000, signal: controller.signal,
      launch: faultLaunch('stall:finalize-after-commit-before-reply') })
    clients.add(authority)
    const begun = await authority.beginAttempt(1, sha('post-commit-abort-scope'))
    await authority.bindAndRead(begun.generation, begun.attemptIdentity, exact)
    const durable = envelopeFor(begun.generation, begun.attemptIdentity, exact, { durable: 'abort' })
    const finalizing = authority.finalize(begun.generation, begun.attemptIdentity, exact, durable, 1, 2)
    const dbPath = path.join(cache, 'opencode', 'provider-catalog-authority-v44307', 'authority.sqlite')
    for (;;) {
      try {
        const check = new Database(dbPath, { readonly: true })
        const committed = check.query('SELECT count(*) AS count FROM committed_result').get() as { count: number }
        check.close(); if (committed.count === 1) break
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    controller.abort()
    await expect(finalizing).resolves.toEqual({ committed: true, generation: begun.generation })
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
    clients.add(authority)
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

  test('44305 exact allocation ledger is burned without inventing catalog bytes', async () => {
    const cache = await root(); const exact = await seedLegacy(cache, 44305, 14, identity(sha('44305')))
    const authority = client(cache); const begun = await authority.beginAttempt(1, sha('scope-44305'))
    expect(begun.generation).toBe(15)
    expect((await authority.bindAndRead(begun.generation, begun.attemptIdentity, exact)).previousEnvelope).toBeNull()
    await authority.close()
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

  test('user_version zero with legacy authority objects is ambiguous and never reset', async () => {
    const cache = await root(); const directory = path.join(cache, 'opencode', 'provider-catalog-authority-v44307')
    await mkdir(directory, { recursive: true }); const dbPath = path.join(directory, 'authority.sqlite')
    const db = new Database(dbPath); db.exec('CREATE TABLE legacy_authority(generation INTEGER); INSERT INTO legacy_authority VALUES(41)'); db.close()
    const authority = client(cache, 500)
    await expect(authority.beginAttempt(1, sha('version-zero-nonempty'))).rejects.toThrow()
    const check = new Database(dbPath, { readonly: true })
    expect(check.query('SELECT generation FROM legacy_authority').get()).toEqual({ generation: 41 })
    expect(check.query('PRAGMA user_version').get()).toEqual({ user_version: 0 }); check.close()
  })

  test('deleted retained allocation history and replayed sqlite_sequence fail closed', async () => {
    const cache = await root(); await seedLegacy(cache, 44306, 20)
    const dbPath = path.join(cache, 'opencode', 'provider-catalog-authority-v44307', 'authority.sqlite')
    const db = new Database(dbPath); db.exec(`DELETE FROM allocation_ticket WHERE id=19;
      UPDATE sqlite_sequence SET seq=18 WHERE name='allocation_ticket'`); db.close()
    const authority = client(cache, 500)
    await expect(authority.beginAttempt(1, sha('deleted-ledger'))).rejects.toThrow()
    const check = new Database(dbPath, { readonly: true })
    expect(check.query('SELECT generation FROM allocation_state').get()).toEqual({ generation: 20 })
    check.close()
  })

  test('legacy allocation values with SQLite type confusion fail closed', async () => {
    const cache = await root(); await seedLegacy(cache, 44306, 8)
    const dbPath = path.join(cache, 'opencode', 'provider-catalog-authority-v44307', 'authority.sqlite')
    const db = new Database(dbPath)
    db.query('UPDATE allocation_ticket SET scope_hash=?1 WHERE id=8').run(Buffer.alloc(64, 0x61)); db.close()
    const authority = client(cache, 500)
    await expect(authority.beginAttempt(1, sha('legacy-type-confusion'))).rejects.toThrow()
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

  test('POSIX sibling symlink/ELOOP is corruption, not genuine legacy absence', async () => {
    if (process.platform === 'win32') return
    const cache = await root(); const opencode = path.join(cache, 'opencode'); const outside = await root()
    await mkdir(opencode, { recursive: true }); await symlink(outside,
      path.join(opencode, 'provider-catalog-attempts-v2'), 'dir')
    const authority = client(cache, 500)
    await expect(authority.beginAttempt(1, sha('legacy-eloop'))).rejects.toThrow()
  })

  test('POSIX retained legacy handles expose and recover a hot rollback journal', async () => {
    if (process.platform === 'win32') return
    const cache = await root(); const exact = identity(sha('hot-journal')); await seedExternalLegacy(cache, exact)
    const dbPath = path.join(cache, 'opencode', 'provider-catalog-attempts-v2', 'attempts.sqlite')
    const script = `import { Database } from 'bun:sqlite'; import { writeFileSync } from 'node:fs';
      const db=new Database(${JSON.stringify(dbPath)}); db.exec("PRAGMA journal_mode=PERSIST; BEGIN IMMEDIATE; UPDATE catalog_entry SET envelope_json='{\\"dirty\\":true}'");
      writeFileSync(${JSON.stringify(`${dbPath}.dirty`)},''); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`
    const dirty = Bun.spawn({ cmd: [process.execPath, '-e', script], stdout: 'ignore', stderr: 'pipe' })
    while (!await Bun.file(`${dbPath}.dirty`).exists()) await new Promise(resolve => setTimeout(resolve, 2))
    dirty.kill('SIGKILL'); await dirty.exited
    expect(await Bun.file(`${dbPath}-journal`).exists()).toBe(true)
    const authority = client(cache, 10_000); const begun = await authority.beginAttempt(1, sha('hot-recovery'))
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

  test.each(['journal-before-directory-sync', 'journal-after-directory-sync'])(
    'first rollback-journal barrier at %s permits no page-change acknowledgement', async phase => {
      const cache = await root(); const interrupted = client(cache, 300, faultLaunch(`exit:${phase}`))
      await expect(interrupted.beginAttempt(1, sha(phase))).rejects.toThrow()
      const restart = client(cache); expect((await restart.beginAttempt(2, sha(`${phase}-restart`))).generation).toBe(1)
      await restart.close()
    })
})
