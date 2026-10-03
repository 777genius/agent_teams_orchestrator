import { test, expect } from 'bun:test';
import { containmentOptions, LinuxTestContainment, populated, pids, prepareTestFilesystemAccess, sandboxEnvironment } from './owned-containment';
const path = '/sys/fs/cgroup/TEST-opencode-owned-12345678-1234-4234-8234-123456789abc';
const env = { TEST_OPENCODE_CGROUP_V2_PATH: path,
  TEST_OPENCODE_CGROUP_V2_ID: '12345678-1234-1234-1234-123456789abc:29:123',
  TEST_OPENCODE_CONTAINMENT_PYTHON: '/usr/bin/python3', TEST_OPENCODE_CONTAINMENT_UID: '65534', TEST_OPENCODE_CONTAINMENT_GID: '65534' };

// Regression: partial opt-in or broad/shared paths must fail before spawn.
test('explicit complete TEST opt-in only; no default path', () => {
  expect(containmentOptions({})).toBeUndefined();
  expect(containmentOptions(env)?.identity.path).toBe(path);
  for (const key of Object.keys(env)) {
    const incomplete = { ...env }; delete (incomplete as any)[key];
    expect(() => containmentOptions(incomplete)).toThrow();
  }
  for (const bad of ['/sys/fs/cgroup', '/sys/fs/cgroup/user.slice', path + '/..', path + '/child', '/tmp/TEST-opencode-owned-123'])
    expect(() => containmentOptions({ ...env, TEST_OPENCODE_CGROUP_V2_PATH: bad })).toThrow();
  for (const value of ['0', '-1', '1.2', '4294967296'])
    expect(() => containmentOptions({ ...env, TEST_OPENCODE_CONTAINMENT_UID: value })).toThrow();
});

// Regression: absent/malformed populated readback cannot become a clean receipt.
test('bounded strict kernel readback parsers', () => {
  expect(populated('populated 0\nfrozen 0\n')).toBe(false);
  expect(populated('populated 1\nfrozen 0\n')).toBe(true);
  for (const bad of ['', 'frozen 0', 'populated 2', 'populated 0\npopulated 1', 'populated 0 extra'])
    expect(() => populated(bad)).toThrow();
  expect(pids('1\n22\n')).toEqual([1, 22]); expect(pids('')).toEqual([]);
  for (const bad of ['0', '-2', '1.1', '1\n1', Array(4097).fill('1').join('\n')]) expect(() => pids(bad)).toThrow();
});

function contractBoundary() {
  let writes = 0;
  // Pure authority contract, explicitly not physical kernel qualification.
  const b: any = new (LinuxTestContainment as any)(containmentOptions(env), { close: async () => {} });
  b.kill = { write: async () => { writes++; }, close: async () => {} };
  b.events = { close: async () => {} };
  return { b, writes: () => writes };
}

// Regression: no admission and revoked custody must refuse every group signal.
test('no launch/admission is never group kill authority', async () => {
  const { b, writes } = contractBoundary();
  const r = await b.drain();
  expect(r.containedTreeDrained).toBe(false); expect(r.killIssued).toBe(false);
  expect(r.errors.length).toBeGreaterThan(0); expect(writes()).toBe(0);
});

// Pure propagation contract only. Deleted/replaced/symlink/foreign physical
// boundary qualification remains pending for Root's fresh kernel controls.
test('failed verification refuses signals and propagates the error', async () => {
  const { b, writes } = contractBoundary();
  b.admitted = true; b.leader = { pid: 1, birth: {} };
  b.verify = async () => { throw Error('verification failed'); };
  const result = await b.drain();
  expect(result.errors.join()).toContain('verification failed');
  expect(result.containedTreeDrained).toBe(false);
  expect(result.killIssued).toBe(false); expect(writes()).toBe(0);
});

// Regression: timed-out observation continuing later cannot authorize group kill.
test('deadline revokes late continuations', async () => {
  const { b, writes } = contractBoundary();
  let finish!: () => void;
  await expect(b.bounded(new Promise<void>(r => { finish = r; }), performance.now() + 20)).rejects.toThrow('timeout');
  finish(); await Bun.sleep(5);
  expect(() => b.guard(performance.now() + 1000)).toThrow('revoked');
  expect((await b.drain()).containedTreeDrained).toBe(false); expect(writes()).toBe(0);
});

// Regression: a second launch could mix custody with a foreign leader.
test('launch is single use and preserves explicit argv without a shell', () => {
  const { b } = contractBoundary();
  const argv = b.command('/TEST/binary', ['literal; $(no-shell)'], '/TEST/evidence/receipt');
  expect(argv.slice(-3)).toEqual(['--', '/TEST/binary', 'literal; $(no-shell)']);
  expect(argv.slice(0, 3)).toEqual(['/usr/bin/python3', '-I', '-B']);
  expect(() => b.command('/TEST/binary', [], '/TEST/evidence/second')).toThrow();
});

import { mkdir, mkdtemp, writeFile, readFile, lstat, symlink, link, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { TASK, SOURCE } from '../opencode-generation-spikes/sandbox';

// Real local filesystem checks only: no process privilege drop, cgroups, native
// OpenCode or models. These do not qualify physical kernel custody.
async function filesystemCase(run: (scope: Parameters<typeof prepareTestFilesystemAccess>[0]) => Promise<void>) {
  const unitRoot = join(SOURCE, '.task-output', 'unit-roots');
  await mkdir(unitRoot, { recursive: true });
  const parent = await mkdtemp(join(unitRoot, 'TEST-opencode-access-'));
  // Child identity must traverse the fixture's parent. This directory is fresh
  // test-owned scratch, not a real project or a global permission adjustment.
  await chmod(parent, 0o711);
  const root = join(parent, 'TEST-project'), evidence = join(parent, 'evidence');
  await mkdir(root, { mode: 0o700 }); await mkdir(evidence, { mode: 0o700 });
  const marker = { task: TASK, case: 'filesystem-unit', nonce: randomUUID(), root, evidence, created: new Date().toISOString() };
  for (const dir of [root, evidence]) await writeFile(join(dir, '.test-project-owner.json'), JSON.stringify(marker), { mode: 0o600 });
  try { await run({ root, evidence, marker }); }
  finally { await rm(parent, { recursive: true, force: true }); }
}
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

test('owned TEST access preserves binary/config bytes and Root-private evidence', async () => {
  await filesystemCase(async scope => {
    for (const name of ['home', 'config', 'artifacts']) await mkdir(join(scope.root, name), { mode: 0o700 });
    const binary = join(scope.root, 'artifacts', 'binary'), config = join(scope.root, 'config', 'opencode.json');
    await writeFile(binary, Buffer.from([0, 1, 2, 255]), { mode: 0o700 });
    await writeFile(config, '{"TEST":true}\n', { mode: 0o600 });
    const before = await Promise.all([binary, config].map(async path => digest(await readFile(path))));
    const env = await prepareTestFilesystemAccess(scope, 65534, 65534);
    expect(env).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: scope.root });
    const after = await Promise.all([binary, config].map(async path => digest(await readFile(path))));
    expect(after).toEqual(before);
    for (const [path, mode] of [[scope.root, 0o770], [join(scope.root, 'home'), 0o770], [binary, 0o770], [config, 0o660]] as const) {
      const stat = await lstat(path);
      expect(stat.uid).toBe(0); expect(stat.gid).toBe(65534); expect(stat.mode & 0o7777).toBe(mode);
    }
    for (const [path, mode] of [[scope.evidence, 0o700], [join(scope.root, '.test-project-owner.json'), 0o600], [join(scope.evidence, '.test-project-owner.json'), 0o600]] as const) {
      const stat = await lstat(path); expect(stat.uid).toBe(0); expect(stat.mode & 0o777).toBe(mode);
    }
  });
});

test('symlink, hardlink and changed marker fail before any access grant', async () => {
  for (const kind of ['symlink', 'hardlink', 'marker']) await filesystemCase(async scope => {
    const config = join(scope.root, 'config');
    await writeFile(config, 'TEST bytes', { mode: 0o600 });
    if (kind === 'symlink') await symlink(scope.evidence, join(scope.root, 'escape'));
    if (kind === 'hardlink') await link(config, join(scope.root, 'alias'));
    if (kind === 'marker') await writeFile(join(scope.root, '.test-project-owner.json'), '{}');
    await expect(prepareTestFilesystemAccess(scope, 65534, 65534)).rejects.toThrow();
    expect((await lstat(scope.root)).mode & 0o777).toBe(0o700);
    expect((await lstat(config)).mode & 0o777).toBe(0o600);
    expect((await lstat(config)).gid).toBe(0);
    expect(await readFile(config, 'utf8')).toBe('TEST bytes');
  });
});

test('escaped scope and noncanonical TEST Git trust are rejected', async () => {
  await filesystemCase(async scope => {
    await expect(prepareTestFilesystemAccess({ ...scope, evidence: scope.root }, 65534, 65534)).rejects.toThrow();
    await expect(prepareTestFilesystemAccess(scope, 0, 65534)).rejects.toThrow();
  });
  for (const root of ['/real-project', 'TEST-relative', '/tmp/TEST-project/..'])
    expect(() => sandboxEnvironment(root)).toThrow();
});

test('inaccessible or writable ancestors are refused without changing them', async () => {
  for (const mode of [0o700, 0o777]) await filesystemCase(async scope => {
    const parent = scope.root.slice(0, scope.root.lastIndexOf('/'));
    await chmod(parent, mode);
    await expect(prepareTestFilesystemAccess(scope, 65534, 65534)).rejects.toThrow();
    expect((await lstat(parent)).mode & 0o7777).toBe(mode);
    expect((await lstat(scope.root)).mode & 0o7777).toBe(0o700);
  });
});

// Pure pipe contracts: never execute a process or touch a kernel boundary.
test('ACK requires admission and is single use; release failure retains custody', async () => {
  const { b } = contractBoundary();
  const calls: string[] = [];
  const pipe = { write: (data: string) => { calls.push(data); return data.length; }, end: () => { calls.push('EOF'); } };
  await expect(b.release(pipe)).rejects.toThrow('admission');
  expect(calls).toEqual([]);
  b.admitted = true;
  await b.release(pipe);
  expect(calls).toEqual(['ACK\n', 'EOF']);
  await expect(b.release(pipe)).rejects.toThrow();
  expect(b.hasAdmission).toBe(true);
  for (const failure of ['write', 'short', 'end']) {
    const { b: failed } = contractBoundary(); failed.admitted = true;
    await expect(failed.release({
      write: () => { if (failure === 'write') throw Error('write failure'); return failure === 'short' ? 1 : 4; },
      end: () => { throw Error('end failure'); },
    })).rejects.toThrow();
    expect(failed.hasAdmission).toBe(true);
    expect(failed.revoked).toBe(false);
  }
});

test('repeated admission cannot revoke previously established custody', async () => {
  const { b } = contractBoundary(); b.admitted = true; b.launched = true;
  await expect(b.admit(1, {}, '/unused')).rejects.toThrow('admission');
  expect(b.hasAdmission).toBe(true);
});

// Execute only the isolated ACK function with mocked syscall/time providers.
// No launcher main, kernel controls, privilege drop or native exec is run.
import { spawnSync } from 'node:child_process';
test('launcher ACK body fails closed for missing, malformed, trailing and late data', () => {
  const result = spawnSync('/usr/bin/python3', ['-I', '-B', '-c', String.raw`
import ast, pathlib, stat, types
source = pathlib.Path(__import__('sys').argv[1]).read_text()
module = ast.parse(source)
function = next(n for n in module.body if isinstance(n, ast.FunctionDef) and n.name == 'await_parent_ack')
code = compile(ast.Module(body=[function], type_ignores=[]), '<isolated-ACK>', 'exec')
cases = [
    ('valid-fragments', [b'A', b'CK\n', b''], [0]*20, True, stat.S_IFIFO, True),
    ('missing', [b''], [0]*20, True, stat.S_IFIFO, False),
    ('malformed', [b'NO\n'], [0]*20, True, stat.S_IFIFO, False),
    ('trailing', [b'ACK\nx'], [0]*20, True, stat.S_IFIFO, False),
    ('no-eof', [b'ACK\n'], [0]*20, [True, False], stat.S_IFIFO, False),
    ('timeout', [], [0]*20, False, stat.S_IFIFO, False),
    ('late', [b'ACK\n'], [0,0,10], True, stat.S_IFIFO, False),
    ('late-eof', [b'ACK\n', b''], [0,0,0,0,10], True, stat.S_IFIFO, False),
    ('pathname-stdin', [], [0]*20, True, stat.S_IFREG, False),
]
for name, chunks, ticks, readiness, mode, expected in cases:
    reads, clock = iter(chunks), iter(ticks)
    ready = iter(readiness) if isinstance(readiness, list) else None
    namespace = dict(stat=stat,
        os=types.SimpleNamespace(fstat=lambda fd: types.SimpleNamespace(st_mode=mode), read=lambda fd, size: next(reads)),
        time=types.SimpleNamespace(monotonic=lambda: next(clock)),
        select=types.SimpleNamespace(select=lambda *args: ([0] if (next(ready) if ready else readiness) else [], [], [])))
    exec(code, namespace)
    accepted = True
    try: namespace['await_parent_ack']()
    except RuntimeError: accepted = False
    assert accepted == expected, name
print('9 isolated ACK cases PASS')
`, join(import.meta.dir, 'owned-containment-launcher.py')], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout.trim()).toBe('9 isolated ACK cases PASS');
});

import { OwnedCleanup } from './owned-cleanup';
import { OwnedProcessTree } from '../opencode-generation-spikes/sandbox';
test('cleanup before trusted admission never signals or discovers descendants', async () => {
  const { b } = contractBoundary();
  const birth = { format: 'linux-start-ticks', value: '1', bootId: env.TEST_OPENCODE_CGROUP_V2_ID.split(':')[0]! };
  let signals = 0;
  const proc = { pid: 1, exited: Promise.resolve(1), kill: () => { signals++; } };
  const tree = { processes: new Map([[1, birth]]) } as unknown as OwnedProcessTree;
  const cleanup = new OwnedCleanup(proc, birth, tree);
  const result = await cleanup.stop(b);
  expect(signals).toBe(0);
  expect(cleanup.processes.size).toBe(1);
  expect(result.containedTreeDrained).toBe(false);
  expect(result.errors.join()).toContain('no trusted containment admission');
});

// Regression rationale was recorded in REGRESSION.md before these tests.
// Narrow typed seams replace kernel observations only, never release or stop.
import { cleanupBound } from './owned-cleanup';
import type { ContainmentReceipt } from './owned-containment';
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function releaseContractBoundary() {
  type Seam = { admitted: boolean; revoked: boolean };
  const boundary = contractBoundary().b as Pick<LinuxTestContainment, keyof LinuxTestContainment> & Seam;
  return boundary;
}
for (const stage of ['write', 'end'] as const) {
  test(`deferred ${stage} rejection awaits settlement and retains single-use custody`, async () => {
    const b = releaseContractBoundary(), gate = deferred<number>();
    const entered = deferred<void>(), calls: string[] = [];
    let settled = false;
    const pipe: Parameters<LinuxTestContainment['release']>[0] = {
      write: data => { calls.push(data); if (stage === 'write') { entered.resolve(); return gate.promise; } return 4; },
      end: () => { calls.push('EOF-attempt'); entered.resolve(); return gate.promise; },
    };
    await expect(b.release(pipe)).rejects.toThrow('admission');
    expect(calls).toEqual([]);
    b.admitted = true;
    const release = b.release(pipe);
    const outcome = release.then(() => { settled = true; return 'success'; }, e => { settled = true; return e; });
    await entered.promise;
    expect(settled).toBe(false); expect(b.hasAdmission).toBe(true);
    await expect(b.release(pipe)).rejects.toThrow('single trusted admission');
    expect(calls).toEqual(stage === 'write' ? ['ACK\n'] : ['ACK\n', 'EOF-attempt']);
    const error = Error(`deferred ${stage} failure`);
    gate.reject(error);
    expect(await outcome).toBe(error); expect(settled).toBe(true);
    expect(b.hasAdmission).toBe(true); expect(b.revoked).toBe(false);
    expect(calls).toEqual(stage === 'write' ? ['ACK\n'] : ['ACK\n', 'EOF-attempt']);
    await expect(b.release(pipe)).rejects.toThrow('single trusted admission');
  });
}

for (const stage of ['write-reject', 'end-reject', 'write-success-after-timeout'] as const) {
  test(`pending release overlaps admitted cleanup: ${stage}`, async () => {
    const b = releaseContractBoundary(), pending = deferred<number>();
    const entered = deferred<void>(), draining = deferred<void>(), finishDrain = deferred<void>();
    const calls: string[] = [];
    let releaseSettled = false, eofObserved = false, drains = 0, signals = 0;
    const birth = { format: 'linux-start-ticks', value: '1', bootId: env.TEST_OPENCODE_CGROUP_V2_ID.split(':')[0]! };
    const proc = { pid: 1, exited: Promise.resolve(1), kill: () => { signals++; expect(b.admitted).toBe(true); } };
    const tree = { processes: new Map([[1, birth]]) } as unknown as OwnedProcessTree;
    const cleanup = new OwnedCleanup(proc, birth, tree);
    // Replace physical observations, retaining the real cleanup scheduling/policy.
    cleanup.capture = async () => { calls.push('capture'); };
    (cleanup as unknown as { inspect: (pid: number) => Promise<null> }).inspect = async () => null;
    b.drain = async (): Promise<ContainmentReceipt> => {
      drains++; expect(b.hasAdmission).toBe(true); calls.push('drain-enter'); draining.resolve();
      await finishDrain.promise;
      b.revoked = true;
      return { authority: 'private-TEST-cgroup-v2', identity: b.identity, containedTreeDrained: true, killIssued: true, errors: [] };
    };
    // Pre-admission cleanup must not capture, signal, or drain even with this seam.
    const unadmitted = await cleanup.stop(b as unknown as LinuxTestContainment);
    expect(unadmitted.containedTreeDrained).toBe(false);
    expect(signals).toBe(0); expect(drains).toBe(0); expect(calls).toEqual([]);
    // Use a fresh cleanup: stop closes capture permanently.
    const admittedCleanup = new OwnedCleanup(proc, birth, tree);
    admittedCleanup.capture = cleanup.capture;
    (admittedCleanup as unknown as { inspect: (pid: number) => Promise<null> }).inspect = async () => null;
    b.admitted = true;
    const release = b.release({
      write: data => { calls.push(data); if (stage !== 'end-reject') { entered.resolve(); return pending.promise; } return 4; },
      end: () => { calls.push('EOF-attempt'); if (stage === 'end-reject') { entered.resolve(); return pending.promise; } eofObserved = true; },
    });
    const outcome = release.then(() => { releaseSettled = true; return 'success'; }, (e: unknown) => { releaseSettled = true; return e; });
    await entered.promise;
    if (stage === 'write-success-after-timeout') {
      await expect(cleanupBound(release, 'pending ACK', 10)).rejects.toThrow('timeout');
      expect(releaseSettled).toBe(false); expect(b.hasAdmission).toBe(true);
    }
    const stopping = admittedCleanup.stop(b as unknown as LinuxTestContainment);
    await draining.promise;
    expect(releaseSettled).toBe(false); expect(eofObserved).toBe(false);
    expect(signals).toBeGreaterThan(0); expect(drains).toBe(1);
    expect(b.hasAdmission).toBe(true);
    await expect(b.release({ write: () => { throw Error('second ACK'); }, end: () => {} })).rejects.toThrow('single trusted admission');
    if (stage === 'write-success-after-timeout') {
      // Queued exact ACK and EOF can settle during cleanup, under admitted custody.
      pending.resolve(4); expect(await outcome).toBe('success'); expect(eofObserved).toBe(true);
      expect(calls.indexOf('EOF-attempt')).toBeGreaterThan(calls.indexOf('drain-enter'));
    } else {
      const error = Error(stage); pending.reject(error); expect(await outcome).toBe(error);
      expect(eofObserved).toBe(false);
    }
    expect(releaseSettled).toBe(true); expect(b.hasAdmission).toBe(true);
    expect(calls.filter(c => c === 'ACK\n').length).toBe(1);
    expect(calls.filter(c => c === 'EOF-attempt').length).toBe(stage === 'write-reject' ? 0 : 1);
    finishDrain.resolve();
    const result = await stopping;
    expect(result.containedTreeDrained).toBe(true); expect(result.errors).toEqual([]);
    expect(drains).toBe(1); expect(admittedCleanup.processes.size).toBe(1);
    expect(b.hasAdmission).toBe(false);
  });
}
