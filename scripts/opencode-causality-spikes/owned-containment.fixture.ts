// Actual OS process controls, never OpenCode/provider/model execution.
// Root alone runs positive mode with a fresh preallocated cgroup for EACH case.
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir, chown, chmod, readdir, rm, lstat, realpath } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import assert from 'node:assert/strict';
import { cleanupBound, OwnedCleanup } from './owned-cleanup';
import { LinuxTestContainment } from './owned-containment';
import { OwnedProcessTree, processBirth } from '../opencode-generation-spikes/sandbox';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const mode = process.argv[2], positive = process.argv[3] === 'positive';
const early = mode === 'early-leader-exit' || mode === 'early-admission-red';
const releaseFailure = mode === 'release-write-failure';
// after-admit-failure deliberately withholds ACK after setup; it is not a release failure.
const withheld = ['ack-missing', 'ack-malformed', 'ack-late', 'after-admit-failure'].includes(mode!);
if (!['term-fork', 'leader-fork', 'setsid', 'double-fork', 'nonempty', 'early-leader-exit', 'early-admission-red', 'ack-missing', 'ack-malformed', 'ack-late', 'after-admit-failure', 'release-write-failure'].includes(mode!)) throw Error('explicit fixture case required');
if (!positive && (mode === 'nonempty' || early || withheld || releaseFailure)) throw Error('case requires Root physical containment');
const rejectedLauncher = process.env.TEST_OPENCODE_REJECTED_LAUNCHER;
if (mode === 'early-admission-red') {
  if (!rejectedLauncher || !isAbsolute(rejectedLauncher)) throw Error('explicit immutable rejected launcher required');
  const source = await lstat(rejectedLauncher);
  if (!source.isFile() || source.isSymbolicLink() || source.uid !== 0 || source.nlink !== 1 ||
      (source.mode & 0o022) || await realpath(rejectedLauncher) !== rejectedLauncher)
    throw Error('untrusted rejected launcher');
}
const parent = process.env.TEST_OPENCODE_CONTROL_TMP;
if (!parent || !isAbsolute(parent)) throw Error('explicit private TEST control scratch required');
await mkdir(parent, { recursive: true });
const root = await mkdtemp(join(parent, 'TEST-owned-control-'));
const evidence = await mkdtemp(join(parent, 'TEST-owned-evidence-'));
const boundary = positive ? await LinuxTestContainment.prepare() : undefined;
if (positive && !boundary) throw Error('positive requires complete containment opt-in');
if (boundary) { await chown(root, boundary.options.uid, boundary.options.gid); await chmod(root, 0o700); }
const program = String.raw`
import os, sys, signal, json, time
root, mode = sys.argv[1:]
def record():
    pid = os.getpid()
    with open('/proc/self/stat') as f: ticks = f.read().rsplit(')',1)[1].split()[19]
    with open('/proc/sys/kernel/random/boot_id') as f: boot = f.read().strip()
    with open(root + '/birth-' + str(pid) + '.json', 'w') as f:
        json.dump(dict(pid=pid,sessionID=os.getsid(0),birth=dict(format='linux-start-ticks',value=ticks,bootId=boot)),f)
def leaf():
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    record()
    while True: time.sleep(.05)
def fork_term(*_):
    if os.fork() == 0:
        os.setsid()
        leaf()
    os._exit(0)
record()
if mode == 'term-fork':
    child = os.fork()
    if child == 0:
        signal.signal(signal.SIGTERM, fork_term)
        record()
        with open(root + '/child-ready','w') as f: f.write('ready')
        while True: time.sleep(.05)
    while not os.path.exists(root + '/child-ready'): time.sleep(.01)
elif mode in ('early-leader-exit', 'early-admission-red'):
    if os.fork() != 0: os._exit(0)
    os.setsid()
    record()
    if os.fork() != 0: os._exit(0)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    record()
    with open(root + '/ready','w') as f: f.write('ready')
    while True: time.sleep(.05)
elif mode == 'leader-fork': signal.signal(signal.SIGTERM, fork_term)
elif mode in ('setsid', 'double-fork'):
    if os.fork() == 0:
        os.setsid()
        if mode == 'double-fork':
            record()
            if os.fork() != 0: os._exit(0)
        leaf()
    while len([n for n in os.listdir(root) if n.startswith('birth-')]) < (3 if mode == 'double-fork' else 2): time.sleep(.01)
else: signal.signal(signal.SIGTERM, signal.SIG_IGN)
with open(root + '/ready','w') as f: f.write('ready')
while True: time.sleep(.05)
`;
function bunHandle(argv: string[]) {
  const child = Bun.spawn(argv, { cwd: root, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
  return { pid: child.pid, exited: child.exited,
    pipe: { write: (data: string) => child.stdin.write(data), end: () => child.stdin.end() },
    kill: (signal: 'SIGTERM' | 'SIGKILL') => child.kill(signal) };
}
function handle(argv: string[]) {
  const child = spawn(argv[0]!, argv.slice(1), { cwd: root, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? -1)); });
  child.stdin!.on('error', () => {}); // write/end promises carry errors to caller
  const pipe = {
    write: (data: string) => new Promise<number>((resolve, reject) => child.stdin!.write(data, e => e ? reject(e) : resolve(Buffer.byteLength(data)))),
    end: () => new Promise<void>((resolve, reject) => {
      if (child.stdin!.destroyed) { resolve(); return; }
      child.stdin!.end((e?: Error | null) => e ? reject(e) : resolve());
    }),
  };
  return { pid: child.pid!, exited, pipe, kill: (signal: 'SIGTERM' | 'SIGKILL') => child.kill(signal) };
}
const sentinel = handle(['/usr/bin/python3', '-I', '-B', '-c', 'import time; time.sleep(30)']);
const sentinelBirth = await processBirth(sentinel.pid);
const receipt = join(evidence, 'launch.json');
const args = ['-I', '-B', '-c', program, root, mode!];
const argv = boundary ? boundary.command('/usr/bin/python3', args, receipt) : ['/usr/bin/python3', ...args];
if (mode === 'early-admission-red') argv[3] = rejectedLauncher!;
const leader = releaseFailure ? bunHandle(argv) : handle(argv);
if (!boundary) await leader.pipe.end();
// The red leader can exit before even the first /proc observation. Its Root-
// private receipt preserves the birth for the attempted (rejected) admission;
// it never becomes cleanup authority. Positive mode samples the live launcher.
const birth = mode === 'early-admission-red' ? await (async () => {
  const deadline = performance.now() + 3000;
  while (true) {
    try {
      const value = JSON.parse(await readFile(receipt, 'utf8'));
      assert.equal(value.pid, leader.pid);
      assert.deepEqual(value.identity, boundary!.identity);
      return { format: 'linux-start-ticks', value: String(value.startTicks), bootId: String(value.identity.bootId) };
    } catch (e: any) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
    if (performance.now() >= deadline) throw Error('red receipt deadline');
    await sleep(10);
  }
})() : await processBirth(leader.pid);
const cleanup = new OwnedCleanup(leader, birth, new OwnedProcessTree(leader.pid, birth));
try {
  if (early) {
    const receiptDeadline = performance.now() + 3000;
    while (true) {
      try { JSON.parse(await readFile(receipt, 'utf8')); break; }
      catch (e: any) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
      if (performance.now() >= receiptDeadline) throw Error('receipt deadline');
      await sleep(10);
    }
    // Deliberately defer admission long enough for the rejected launcher to
    // fork, detach and exit. The corrected launcher cannot create ANY native birth.
    await sleep(500);
    if (mode === 'early-admission-red') {
      // A delay alone cannot prove the detached grandchild has run. Require
      // its marker (written only after its birth record closes) before admit.
      const forkDeadline = performance.now() + 3000;
      while (true) {
        try { await readFile(join(root, 'ready')); break; }
        catch (e: any) { if (e.code !== 'ENOENT') throw e; }
        if (performance.now() >= forkDeadline) throw Error('red detached-grandchild readiness deadline');
        await sleep(10);
      }
      await cleanupBound(leader.exited, 'fixture leader exit', 12000);
      await assert.rejects(boundary!.admit(leader.pid, birth, receipt));
      const names = (await readdir(root)).filter(n => n.startsWith('birth-'));
      assert(names.length >= 3, 'old source must actually double fork before admission');
      const records = await Promise.all(names.map(async n => JSON.parse(await readFile(join(root, n), 'utf8'))));
      const live = [];
      for (const item of records) {
        const stat = await readFile(`/proc/${item.pid}/stat`, 'utf8').catch((e: any) => { if (e.code === 'ENOENT') return ''; throw e; });
        if (stat && stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z' && JSON.stringify(await processBirth(item.pid)) === JSON.stringify(item.birth)) live.push(item.pid);
      }
      const main = records.find(item => item.pid === leader.pid);
      assert(main);
      assert(records.some(item => item.pid !== leader.pid && item.pid !== item.sessionID && item.sessionID !== main.sessionID && records.some(session => session.pid === item.sessionID && session.sessionID === session.pid)), 'red schedule must actually detach and double fork');
      assert(live.length > 0, 'rejected admission must leave a live uncaptured child');
      assert.equal(cleanup.processes.size, 1);
      assert.deepEqual(await processBirth(sentinel.pid), sentinelBirth);
      console.log(JSON.stringify({ mode, positive, admissionRejected: true, live, delayedAdmissionMs: 500, nativeReadyBeforeAdmission: true, leaderExitedBeforeAdmission: true, recoveryAlreadyPerformed: false }));
      // Recovery remains separately authorized by exact fixture birth records.
      process.exitCode = 0;
    } else {
      assert.equal((await readdir(root)).filter(n => n.startsWith('birth-')).length, 0, 'no execution before parent admission');
      assert.deepEqual(await processBirth(leader.pid), birth);
    }
  }
  if (mode !== 'early-admission-red' && boundary) {
    await boundary.admit(leader.pid, birth, receipt);
    if (releaseFailure) {
      assert(boundary.hasAdmission);
      assert.equal((await readdir(root)).filter(n => n.startsWith('birth-')).length, 0);
      // Real intrinsic FileSink failure: close before ACK, then enter release.
      // No injected rejection or foreign pipe can qualify this physical control.
      await leader.pipe.end();
      let writeCalls = 0, endCalls = 0, writeResult: number | undefined;
      let releaseError: unknown;
      try {
        await cleanupBound(boundary.release({
          write: async data => { writeCalls++; writeResult = await leader.pipe.write(data); return writeResult; },
          end: () => { endCalls++; return leader.pipe.end(); },
        }), 'physical failed release');
      } catch (e) { releaseError = e; }
      assert(releaseError instanceof Error, 'closed intrinsic FileSink must fail release');
      assert(!releaseError.message.includes('timeout'), 'timeout is not deliberate pipe failure');
      assert.equal(writeCalls, 1); assert.equal(endCalls, 0);
      assert(writeResult === undefined || writeResult !== 4, 'exact ACK must not be delivered');
      assert(boundary.hasAdmission, 'release failure retains admitted custody');
      await assert.rejects(boundary.release(leader.pipe), /single trusted admission/);
      const result = await cleanup.stop(boundary);
      await cleanupBound(leader.exited, 'failed-release launcher exit', 12000);
      assert(result.containedTreeDrained); assert.equal(result.errors.length, 0);
      assert.equal((await readdir(root)).filter(n => n.startsWith('birth-')).length, 0, 'failed release must create zero native births');
      assert.deepEqual(await processBirth(sentinel.pid), sentinelBirth);
      console.log(JSON.stringify({ mode, positive, releaseEntered: true, intrinsicPipe: 'Bun.spawn/FileSink', writeCalls, endCalls, writeResult: writeResult ?? null, releaseError: releaseError.message, nativeBirths: 0, sentinelAlive: true, result, recoveryAlreadyPerformed: false }));
    } else if (withheld) {
      if (mode === 'ack-malformed') await leader.pipe.write('NO\n');
      if (mode === 'ack-late') {
        await sleep(10500);
        await Promise.resolve().then(() => leader.pipe.write('ACK\n')).catch(() => {});
      }
      await leader.pipe.end();
      await cleanupBound(leader.exited, 'fixture leader exit', 12000);
      assert.equal((await readdir(root)).filter(n => n.startsWith('birth-')).length, 0, 'invalid ACK must never execute native');
      assert(boundary.hasAdmission, 'post-admission failure must retain cleanup custody');
      const result = await cleanup.stop(boundary);
      assert(result.containedTreeDrained); assert.equal(result.errors.length, 0);
      assert.deepEqual(await processBirth(sentinel.pid), sentinelBirth);
      console.log(JSON.stringify({ mode, positive, executionWithheld: true, failureKind: mode === 'after-admit-failure' ? 'post-admission-setup-no-ACK' : mode, releaseEntered: false, result, recoveryAlreadyPerformed: false }));
    } else await boundary.release(leader.pipe);
  }
  if (mode !== 'early-admission-red' && !withheld && !releaseFailure) {
    const deadline = performance.now() + 3000;
    while (true) {
      try { await readFile(join(root, 'ready')); break; } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      if (performance.now() >= deadline) throw Error('fixture readiness deadline');
      await sleep(10);
    }
    if (mode === 'early-leader-exit') { await cleanupBound(leader.exited, 'fixture leader exit', 12000); assert.equal(cleanup.processes.size, 1); }
    if (mode === 'term-fork') { await cleanup.capture(); assert(cleanup.processes.size >= 2); }
    else if (mode === 'leader-fork') assert.equal(cleanup.processes.size, 1);
    // Sentinel independently remains outside custody, including after leader death.
    if (boundary) assert(!(await readFile(`/proc/${sentinel.pid}/cgroup`, 'utf8')).includes(boundary.identity.path.slice('/sys/fs/cgroup'.length)));
    if (mode === 'nonempty') {
      // Regression: a live, already admitted fixture cannot be reused as empty custody.
      await assert.rejects(LinuxTestContainment.prepare(), /nonempty/);
      assert.deepEqual(await processBirth(leader.pid), birth);
      assert.deepEqual(await processBirth(sentinel.pid), sentinelBirth);
      console.log(JSON.stringify({ mode, positive, nonemptyRefused: true, sentinelAlive: true, recoveryAlreadyPerformed: false }));
    } else {
      // Regressions: TERM child fork, first child during leader TERM, setsid and
      // double-fork retain kernel membership; fallback remains explicitly unknown.
      const result = await cleanup.stop(boundary);
      await cleanupBound(leader.exited, 'fixture leader exit', 12000);
      assert.equal(result.containedTreeDrained, positive);
      assert.deepEqual(await processBirth(sentinel.pid), sentinelBirth);
      const records = await Promise.all((await readdir(root)).filter(n => n.startsWith('birth-')).map(async n => JSON.parse(await readFile(join(root, n), 'utf8'))));
      const live: number[] = [];
      for (const item of records) {
        const stat = await readFile(`/proc/${item.pid}/stat`, 'utf8').catch((e: any) => { if (e.code === 'ENOENT') return ''; throw e; });
        if (stat && stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z' && JSON.stringify(await processBirth(item.pid)) === JSON.stringify(item.birth)) live.push(item.pid);
      }
      if (mode === 'double-fork' || mode === 'early-leader-exit') {
        const main = records.find(item => item.pid === leader.pid);
        assert(main, 'main leader birth must be recorded');
        assert(records.some(item => item.pid !== leader.pid && item.pid !== item.sessionID && item.sessionID !== main.sessionID &&
          records.some(session => session.pid === item.sessionID && session.sessionID === session.pid)),
          'grandchild must inherit the recorded detached intermediate session');
      } else assert(records.some(item => item.sessionID === item.pid && item.pid !== leader.pid), 'detached fixture session must actually exist');
      if (mode === 'term-fork') assert(records.length >= 3, 'TERM must actually create an uncaptured grandchild');
      if (mode === 'leader-fork') assert(records.length >= 2, 'leader TERM must actually create its first child');
      if (positive) { assert.equal(live.length, 0); assert.equal(result.errors.length, 0); }
      else { assert(result.errors.some(e => e.includes('creation after capture closure unproven'))); if (mode === 'setsid') assert.equal(live.length, 0); else assert(live.length > 0); }
      console.log(JSON.stringify({ mode, positive, result, live, sentinelAlive: true, knownLeaderExited: true, ...(early ? { delayedAdmissionMs: 500, noNativeBirthBeforeAdmission: true, leaderExitedBeforeCleanup: true, ledgerSizeBeforeCleanup: 1 } : {}), recoveryAlreadyPerformed: false }));
    }
  }
} finally {
  await Promise.resolve().then(async () => { await leader.pipe.end(); }).catch(() => {});
  // Recovery only AFTER assertions; exact fixture births are separate authority.
  for (const name of (await readdir(root)).filter(n => n.startsWith('birth-'))) {
    const item = JSON.parse(await readFile(join(root, name), 'utf8'));
    try { if (JSON.stringify(await processBirth(item.pid)) === JSON.stringify(item.birth)) process.kill(item.pid, 'SIGKILL'); }
    catch (e: any) { if (!['ENOENT', 'ESRCH'].includes(e.code)) throw e; }
  }
  if (!boundary || boundary.hasAdmission) leader.kill('SIGKILL');
  sentinel.kill('SIGKILL'); await Promise.all([leader.exited, sentinel.exited]);
  await boundary?.close(); await rm(root, { recursive: true, force: true }); await rm(evidence, { recursive: true, force: true });
}
