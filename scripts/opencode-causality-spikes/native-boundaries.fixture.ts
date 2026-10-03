// Faults affect kernel observations only; all subprocess effects are real and owned.
import { expect, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { testSpace } from './test-space';
import { processBirth, OwnedProcessTree } from '../opencode-generation-spikes/sandbox';
const mode = process.argv[2], originalRead = fs.readFile;
const { sha } = await import('../opencode-generation-spikes/sandbox');
// The ancestry case uses a dummy child that owns and recovers its own later
// grandchild through its intrinsic Bun handle; the observer never signals it.
if (mode === 'shutdown-root') {
  process.on('SIGTERM', () => { void (async () => {
    const child = Bun.spawn(['/bin/sleep', '30'], { cwd: process.cwd(), stdout: 'ignore', stderr: 'ignore' });
    await fs.writeFile('TEST-shutdown-grandchild', JSON.stringify({ pid: child.pid, birth: await processBirth(child.pid), parentAtFork: process.pid }));
    process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); }); });
  console.log(process.pid); // No descendant exists during the final capture.
  await new Promise(() => { setInterval(() => {}, 1000); });
}
if (mode === 'shutdown-parent') {
  const child = Bun.spawn([process.execPath, import.meta.filename, 'shutdown-child'], { cwd: process.cwd(), stdout: 'ignore', stderr: 'inherit' });
  const deadline = performance.now() + 2000;
  while (!await Bun.file('TEST-child-ready').exists()) {
    if (performance.now() >= deadline) throw Error('TEST shutdown child readiness timeout');
    await Bun.sleep(10);
  }
  console.log(child.pid);
  await new Promise(() => { setInterval(() => {}, 1000); });
}
if (mode === 'shutdown-child') {
  process.on('SIGTERM', () => { void (async () => {
    const stat = await originalRead(`/proc/${process.pid}/stat`, 'utf8');
    const parentAtFork = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    const grandchild = Bun.spawn(['/bin/sleep', '30'], { cwd: process.cwd(), stdout: 'ignore', stderr: 'ignore' });
    await fs.writeFile('TEST-shutdown-grandchild', JSON.stringify({ pid: grandchild.pid, birth: await processBirth(grandchild.pid), parentAtFork }));
    process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); }); });
  await fs.writeFile('TEST-child-ready', 'ready');
  await new Promise(() => { setInterval(() => {}, 1000); });
}
if (mode === 'ancestry-parent') {
  const child = Bun.spawn([process.execPath, import.meta.filename, 'ancestry-child'], { cwd: process.cwd(), stdout: 'ignore', stderr: 'inherit' });
  const readyDeadline = performance.now() + 2000;
  while (!await Bun.file('TEST-child-ready').exists()) {
    if (performance.now() >= readyDeadline) throw Error('TEST child readiness timeout');
    await Bun.sleep(10);
  }
  console.log(child.pid);
  await new Promise(() => { setInterval(() => {}, 1000); });
}
if (mode === 'ancestry-child') {
  let grandchild: ReturnType<typeof Bun.spawn> | undefined;
  const deadline = performance.now() + 7000;
  try {
    await fs.writeFile('TEST-child-ready', 'ready');
    while (!await Bun.file('TEST-release-child').exists()) {
      if (performance.now() >= deadline) throw Error('TEST child release timeout');
      await Bun.sleep(10);
    }
    grandchild = Bun.spawn(['/bin/sleep', '30'], { cwd: process.cwd(), stdout: 'ignore', stderr: 'ignore' });
    await fs.writeFile('TEST-grandchild-pid', String(grandchild.pid));
    while (!await Bun.file('TEST-child-recovery').exists()) {
      if (performance.now() >= deadline) throw Error('TEST child recovery timeout');
      await Bun.sleep(10);
    }
  } finally { grandchild?.kill('SIGKILL'); if (grandchild) await grandchild.exited; }
  process.exit(0);
}
const dir = await testSpace('native-boundary');
const leader = Bun.spawn(mode === 'leader-fork' ? [process.execPath, import.meta.filename, 'shutdown-root'] : mode === 'shutdown-fork' ? [process.execPath, import.meta.filename, 'shutdown-parent'] : mode === 'ancestry' ? [process.execPath, import.meta.filename, 'ancestry-parent'] : ['/bin/sh', '-c', (mode === 'escalation' ? 'trap "" TERM; ' : '') + 'sleep 30 & echo $!; wait'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
const sentinel = Bun.spawn(['/bin/sleep', '30'], { cwd: dir, stdout: 'ignore', stderr: 'ignore' });
const reader = leader.stdout.getReader();
let text = '';
while (!text.includes('\n')) { const next = await reader.read(); if (next.done) throw Error('child missing'); text += Buffer.from(next.value!).toString(); }
const child = Number(text.trim()), leaderBirth = await processBirth(leader.pid), childBirth = await processBirth(child);
reader.releaseLock();
const sentinelBirth = await processBirth(sentinel.pid);
const tree = new OwnedProcessTree(leader.pid, leaderBirth);
// Capture through verified parent ancestry BEFORE injecting observational errors.
await tree.capture();
expect(tree.processes.get(child)).toEqual(childBirth);
const fixtureLedger = new OwnedProcessTree(leader.pid, leaderBirth);
fixtureLedger.processes.set(child, childBirth); // separate pre-death recovery authority
if (mode === 'foreign') tree.processes.set(sentinel.pid, { ...sentinelBirth, value: 'foreign' });
let faults = 0, inject = true;
let releaseRead!: () => void;
const delayedRead = new Promise<void>(resolve => { releaseRead = resolve; });
const originalChildren = await originalRead(`/proc/${leader.pid}/task/${leader.pid}/children`, 'utf8');
mock.module('node:fs/promises', () => ({ ...fs, readFile: async (...args: any[]) => {
  if (!inject) return (originalRead as any)(...args);
  if (mode === 'late-capture' && String(args[0]) === `/proc/${leader.pid}/task/${leader.pid}/children`) {
    faults++; await delayedRead; return originalChildren;
  }
  if (mode.startsWith('boot-') && String(args[0]) === '/proc/sys/kernel/random/boot_id') {
    faults++; throw Object.assign(Error('TEST boot identity unavailable'), { code: mode.slice(5) });
  }
  if (mode === 'identity-stall' && String(args[0]) === `/proc/${child}/stat`) {
    faults++; return new Promise(() => {});
  }
  if ((mode === 'ESRCH' || mode === 'EACCES' || mode.startsWith('host')) && String(args[0]) === `/proc/${child}/task/${child}/children`) {
    faults++; throw Object.assign(Error('TEST disappearing child observation'), { code: mode.startsWith('host') ? 'ESRCH' : mode });
  }
  return (originalRead as any)(...args);
} }));
const { OwnedCleanup, cleanupBound } = process.env.S1A_OWNED_CLEANUP_MODULE
  ? await import(process.env.S1A_OWNED_CLEANUP_MODULE) : await import('./owned-cleanup');
let keeper: ReturnType<typeof Bun.spawn> | undefined;
try {
  if (mode === 'pipe') {
    // Independently owned pipe holder is deliberately outside the leader ledger.
    keeper = Bun.spawn(['/bin/sleep', '30'], { cwd: dir, stdout: 'pipe', stderr: 'ignore' });
    const capture = new Response(keeper.stdout).text();
    await expect(cleanupBound(capture, 'active pipe', 30)).rejects.toThrow('active pipe timeout');
    keeper.kill('SIGKILL'); await keeper.exited;
  }
  let report: any;
  const unresolved = mode.startsWith('boot-') || mode === 'identity-stall' || mode === 'late-capture';
  if (mode.startsWith('host')) {
    // Only HTTP observations and launcher selection are substituted. The exact
    // dummy spawn handle, child, kernel reads, output pipes and cleanup are real.
    const originalWire = await import('./wire');
    mock.module('./wire', () => ({ ...originalWire, Wire: class {
      async call() { await Bun.sleep(180); return { status: 200, value: { version: 'TEST-wrong' } }; }
    } }));
    const spawn = Bun.spawn, serve = Bun.serve, records: any[] = [];
    const binary = join(dir, 'TEST-fake-host'); await fs.writeFile(binary, 'TEST-fake-host-bytes');
    if (mode === 'host-pipe') keeper = Bun.spawn(['/bin/sleep', '30'], { cwd: dir, stdout: 'pipe', stderr: 'ignore' });
    (Bun as any).spawn = () => mode === 'host-pipe' ? {
      pid: leader.pid, exited: leader.exited, get exitCode() { return leader.exitCode; },
      kill: leader.kill.bind(leader), stdout: keeper!.stdout, stderr: leader.stderr,
    } : leader;
    (Bun as any).serve = () => ({ port: 12345, stop() {} });
    try {
      const { host } = await import('./host');
      await expect(host({ root: dir, validate: async () => {}, path: async () => {}, env: () => ({}) } as any,
        { binary, sha256: sha('TEST-fake-host-bytes') } as any,
        { generation: 'v1', version: 'TEST-correct' } as any,
        { raw: async () => {}, json: async (name: string, value: any) => records.push({ name, value }) } as any,
        AbortSignal.timeout(2000))).rejects.toThrow('live native identity mismatch');
      const record = records.find(r => r.name === 'host-cleanup.json').value;
      expect(record.drained).toBe(true); // intrinsic leader exit, not whole-tree success
      expect(record.errors.some((e: string) => e.includes('descendant creation after capture closure unproven'))).toBe(true);
      if (mode === 'host-pipe') {
        expect(record.errors).toContain('stdout: Error: stdout capture timeout');
        expect(keeper!.exitCode).toBeNull(); // foreign pipe holder was never signaled
      }
      report = record.cleanup;
    } finally { (Bun as any).spawn = spawn; (Bun as any).serve = serve; }
  } else if (mode === 'shutdown-fork' || mode === 'leader-fork') {
    // The grandchild is created by stop()'s child TERM, after leader death.
    // Recovery below occurs only after observing and asserting the receipt.
    const cleanup = new OwnedCleanup(leader, leaderBirth, tree);
    report = await cleanup.stop();
    const grandchild = JSON.parse(await Bun.file(join(dir, 'TEST-shutdown-grandchild')).text());
    if (mode === 'leader-fork') {
      expect(tree.processes.size).toBe(1);
      expect(grandchild.parentAtFork).toBe(leader.pid);
    } else expect(grandchild.parentAtFork).not.toBe(leader.pid);
    expect(await processBirth(grandchild.pid)).toEqual(grandchild.birth);
    expect(cleanup.processes.has(grandchild.pid)).toBe(false);
    expect(sentinel.exitCode).toBeNull();
    await fs.writeFile(join(import.meta.dir, '..', '..', `.task-output/${mode}-observation.json`), JSON.stringify({
      report, grandchild, liveGrandchild: true, sentinelBirth, recoveryAlreadyPerformed: false,
    }, null, 2));
    // Old code returns errors=[] while the newly created orphan is alive.
    expect(report.errors.some((e: string) => e.includes(mode === 'leader-fork' ? 'leader creation after capture closure unproven' : 'descendant creation after capture closure unproven'))).toBe(true);
  } else if (mode === 'ancestry') {
    const cleanup = new OwnedCleanup(leader, leaderBirth, tree);
    leader.kill('SIGKILL'); await leader.exited;
    await fs.writeFile(join(dir, 'TEST-release-child'), 'release');
    const grandchildFile = Bun.file(join(dir, 'TEST-grandchild-pid'));
    const deadline = performance.now() + 2000;
    while (!await Bun.file(join(dir, 'TEST-grandchild-pid')).exists()) {
      if (performance.now() >= deadline) throw Error('TEST grandchild missing');
      await Bun.sleep(10);
    }
    const grandchild = Number(await grandchildFile.text());
    await cleanup.capture();
    expect(cleanup.processes.has(grandchild)).toBe(false);
    expect(await processBirth(grandchild)).toBeDefined(); // no authority inferred after leader death
    await fs.writeFile(join(dir, 'TEST-child-recovery'), 'recover');
    for (let i = 0; i < 200; i++) {
      const stat = await originalRead(`/proc/${grandchild}/stat`, 'utf8').catch((e: any) => { if (e.code === 'ENOENT' || e.code === 'ESRCH') return null; throw e; });
      if (!stat || stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] === 'Z') break;
      if (i === 199) throw Error('intrinsic grandchild recovery incomplete');
      await Bun.sleep(10);
    }
    report = await cleanup.stop();
  } else {
    const signals: string[] = [];
    const handle = { pid: leader.pid, exited: leader.exited, kill(signal: 'SIGTERM' | 'SIGKILL') { signals.push(signal); return leader.kill(signal); } };
    const cleanup = new OwnedCleanup(handle, leaderBirth,
      mode === 'late-capture' ? new OwnedProcessTree(leader.pid, leaderBirth) : tree);
    cleanup.start();
    if (mode === 'late-capture') await Bun.sleep(120);
    const started = performance.now();
    report = await cleanup.stop();
    if (mode === 'escalation') {
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(report.escalation).toBe('SIGKILL');
      expect(performance.now() - started).toBeGreaterThanOrEqual(250);
      expect(performance.now() - started).toBeLessThan(3500);
    }
    if (mode === 'late-capture') {
      releaseRead(); await Bun.sleep(50);
      expect(cleanup.processes.has(child)).toBe(false);
    }
    if (unresolved) {
      expect(performance.now() - started).toBeLessThan(7000);
      expect(report.errors.length).toBeGreaterThan(0);
      if (mode !== 'late-capture') expect(report.results.find((r: any) => r.pid === child).result).toBe('unknown');
      const stat = await originalRead(`/proc/${child}/stat`, 'utf8');
      expect(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]).not.toBe('Z');
      inject = false;
      // Separate, pre-death fixture ledger recovers the unresolved obligation.
      const recovery = await new OwnedCleanup(leader, leaderBirth, fixtureLedger).stop();
      expect(recovery.errors.some((e: string) => e.includes('descendant creation after capture closure unproven'))).toBe(true);
      expect(recovery.results.every((r: any) => r.result !== 'live' && r.result !== 'unknown')).toBe(true);
    }
  }
  await leader.exited;
  const leaderStat = await originalRead(`/proc/${leader.pid}/stat`, 'utf8').catch((e: any) => {
    if (e.code === 'ENOENT' || e.code === 'ESRCH') return null; throw e;
  });
  if (leaderStat) expect(leaderStat.slice(leaderStat.lastIndexOf(')') + 2).split(' ')[0]).toBe('Z');
  const childStat = await originalRead(`/proc/${child}/stat`, 'utf8').catch((e: any) => {
    if (e.code === 'ENOENT' || e.code === 'ESRCH') return null; throw e;
  });
  if (childStat) expect(childStat.slice(childStat.lastIndexOf(')') + 2).split(' ')[0]).toBe('Z');
  if (mode === 'ESRCH' || mode === 'EACCES' || mode.startsWith('host')) expect(faults).toBeGreaterThan(0);
  expect(report.errors.length).toBeGreaterThan(0);
  if (!unresolved) expect(report.errors.some((e: string) => e.includes(mode === 'leader-fork' ? 'leader creation after capture closure unproven' : 'descendant creation after capture closure unproven'))).toBe(true);
  expect(sentinel.exitCode).toBeNull(); expect(await processBirth(sentinel.pid)).toEqual(sentinelBirth);
} finally {
  inject = false; releaseRead();
  if (mode === 'shutdown-fork' || mode === 'leader-fork') {
    const file = Bun.file(join(dir, 'TEST-shutdown-grandchild'));
    if (await file.exists()) {
      const owned = JSON.parse(await file.text());
      // This explicit fixture birth was recorded by the owned creator. It is
      // separate recovery authority, never added to the stopped observer ledger.
      if (JSON.stringify(await processBirth(owned.pid)) !== JSON.stringify(owned.birth))
        throw Error('TEST shutdown grandchild recovery birth mismatch');
      process.kill(owned.pid, 'SIGKILL');
      for (let i = 0; i < 200; i++) {
        const stat = await originalRead(`/proc/${owned.pid}/stat`, 'utf8').catch((e: any) => {
          if (e.code === 'ENOENT' || e.code === 'ESRCH') return null; throw e;
        });
        if (!stat || stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] === 'Z') break;
        if (i === 199) throw Error('TEST shutdown grandchild recovery unproven');
        await Bun.sleep(10);
      }
    }
  }
  if (mode === 'ancestry') {
    await fs.writeFile(join(dir, 'TEST-child-recovery'), 'recover');
    const file = Bun.file(join(dir, 'TEST-grandchild-pid'));
    if (await file.exists()) {
      const pid = Number(await file.text());
      for (let i = 0; i < 200; i++) {
        const stat = await originalRead(`/proc/${pid}/stat`, 'utf8').catch((e: any) => { if (e.code === 'ENOENT' || e.code === 'ESRCH') return null; throw e; });
        if (!stat || stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] === 'Z') break;
        if (i === 199) throw Error('intrinsic grandchild teardown unproven');
        await Bun.sleep(10);
      }
    }
  }
  await new OwnedCleanup(leader, leaderBirth, fixtureLedger).stop();
  leader.kill('SIGKILL'); sentinel.kill('SIGKILL'); keeper?.kill('SIGKILL');
  await Promise.all([leader.exited, sentinel.exited, keeper?.exited]);
  if (!leader.stdout.locked) await leader.stdout.cancel().catch(() => {});
  await fs.rm(dir, { recursive: true, force: true });
}
