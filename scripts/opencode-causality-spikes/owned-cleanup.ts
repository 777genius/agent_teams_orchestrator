import { readFile } from 'node:fs/promises';
import type { LinuxTestContainment, ContainmentReceipt } from './owned-containment';
import { processBirth, OwnedProcessTree } from '../opencode-generation-spikes/sandbox';

type Birth = Awaited<ReturnType<typeof processBirth>>;
const absent = (e: any) => e?.code === 'ENOENT' || e?.code === 'ESRCH';
const same = (a: Birth, b: Birth) => JSON.stringify(a) === JSON.stringify(b);

// Separate TEST cleanup policy. The frozen exact-birth ledger is retained;
// its scanner is never started, so a rejected scan cannot poison cleanup.
export class OwnedCleanup {
  readonly processes: Map<number, Birth>;
  readonly errors: string[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private scan = Promise.resolve();
  private captureOpen = true;
  constructor(readonly proc: { pid: number; exited: Promise<number>; kill(signal: 'SIGTERM' | 'SIGKILL'): unknown }, birth: Birth,
    tree: OwnedProcessTree) {
    this.processes = tree.processes;
    if (!this.processes) throw new Error('owned cleanup requires an exact-birth ledger');
    if (!same(this.processes.get(proc.pid)!, birth)) throw new Error('leader ledger mismatch');
  }
  private async processFile(pid: number, children = false) {
    const path = children ? `/proc/${pid}/task/${pid}/children` : `/proc/${pid}/stat`;
    try { return await readFile(path, 'utf8'); }
    catch (e) { if (absent(e)) return null; throw e; }
  }
  private async inspect(pid: number) {
    const stat = await this.processFile(pid);
    if (stat === null) return null;
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields.length < 22 || !/^\d+$/.test(fields[19]!) || !/^\d+$/.test(fields[1]!))
      throw new Error('invalid owned process stat');
    // This global kernel identity file is NOT a disappearing-process read.
    // Its ENOENT/ESRCH must remain unknown, never authority to declare absence.
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    if (!bootId) throw new Error('empty kernel boot identity');
    return { birth: { format: 'linux-start-ticks', value: fields[19]!, bootId },
      parent: Number(fields[1]), state: fields[0] === 'Z' ? 'zombie' : 'live' };
  }
  private async identity(pid: number, birth: Birth) {
    const observed = await this.inspect(pid);
    return !observed ? 'absent' : !same(observed.birth, birth) ? 'changed' : observed.state;
  }
  private async liveAncestry(pid: number) {
    const seen = new Set<number>();
    while (!seen.has(pid) && seen.size < 256 && this.captureOpen) {
      seen.add(pid);
      const birth = this.processes.get(pid);
      if (!birth) return false;
      const observed = await this.inspect(pid);
      if (!observed || observed.state !== 'live' || !same(observed.birth, birth)) return false;
      if (pid === this.proc.pid) return this.captureOpen;
      pid = observed.parent;
    }
    return false;
  }
  async capture() {
    for (const [pid] of this.processes) {
      if (!this.captureOpen) return;
      try {
        if (!await this.liveAncestry(pid)) continue;
        const children = await this.processFile(pid, true);
        if (children === null) continue;
        for (const child of children.trim().split(/\s+/).filter(Boolean).map(Number)) {
          if (!this.captureOpen) return;
          if (!Number.isSafeInteger(child) || child <= 0) throw new Error('invalid child PID');
          if (this.processes.has(child)) continue; // never replace an earlier birth
          if (this.processes.size >= 256) {
            this.errors.push('owned process ledger budget exceeded; uncaptured children unknown'); return;
          }
          try {
            const observed = await this.inspect(child);
            if (!observed || observed.parent !== pid || observed.state !== 'live') continue;
            if (!await this.liveAncestry(pid) || !this.captureOpen) continue;
            this.processes.set(child, observed.birth);
          } catch (e) { this.errors.push(`capture child ${child}: ${String(e)}`); }
        }
      } catch (e) { this.errors.push(`capture ${pid}: ${String(e)}`); }
    }
  }
  start() {
    this.timer = setInterval(() => {
      this.scan = this.scan.then(() => this.capture()).catch(e => { this.errors.push('scan: ' + String(e)); });
    }, 100);
  }
  async stop(containment?: LinuxTestContainment) {
    clearInterval(this.timer);
    if (containment && !containment.hasAdmission) {
      this.captureOpen = false;
      // The caller closes the launch pipe; never signal an unadmitted boundary.
      await cleanupBound(this.proc.exited, 'unadmitted launcher exit', 11000);
      return { containedTreeDrained: false, containment: null, errors: ['no trusted containment admission; execution withheld'] };
    }
    try {
      await cleanupBound(this.scan, 'owned scan');
      await cleanupBound(this.capture(), 'owned final capture');
    } catch (e) { this.errors.push('capture deadline: ' + String(e)); }
    finally { this.captureOpen = false; } // late observations cannot create authority
    // Revoking capture also revokes authority to discover any later children.
    // A captured descendant may fork between the last scan and termination,
    // including before its own exit. Draining recorded births proves only those
    // processes stopped; it cannot prove closure of their descendant tree.
    // Retain the obligation even when a later identity read sees it absent.
    // The leader itself may create its first child during TERM, even when
    // no descendant has previously entered the ledger. Its intrinsic exit
    // proves only leader termination, never closure of that creation window.
    const obligations = ['leader creation after capture closure unproven: ' + this.proc.pid];
    const descendants = [...this.processes.keys()].filter(pid => pid !== this.proc.pid);
    if (descendants.length) obligations.push(
      'descendant creation after capture closure unproven: ' + descendants.join(','));
    const results: any[] = [];
    // The intrinsic spawn handle remains authority if kernel observation fails.
    try { this.proc.kill('SIGTERM'); }
    catch (e) { if (!absent(e)) this.errors.push('leader signal: ' + String(e)); }
    const started = performance.now(), deadline = started + 3000;
    let escalated = false;
    // Under containment, give captured descendants the same bounded TERM grace.
    // Exact births remain mandatory; unknown observation never grants a signal.
    if (containment) {
      for (const pid of descendants) {
        if (performance.now() - started >= 250) break;
        try {
          const state = await cleanupBound(this.identity(pid, this.processes.get(pid)!), `grace identity ${pid}`,
            Math.max(1, 250 - (performance.now() - started)));
          if (state === 'live') process.kill(pid, 'SIGTERM');
        } catch (e) { if (!absent(e)) this.errors.push(`descendant grace ${pid}: ${String(e)}`); }
      }
    }
    // Escalation remains bounded even when every kernel observation is unknown.
    try {
      const exited = await Promise.race([this.proc.exited.then(() => true), Bun.sleep(250).then(() => false)]);
      if (!exited) { escalated = true; this.proc.kill('SIGKILL'); }
    } catch (e) {
      if (!absent(e)) this.errors.push('leader grace: ' + String(e));
      escalated = true;
      try { this.proc.kill('SIGKILL'); }
      catch (signal) { if (!absent(signal)) this.errors.push('leader escalation: ' + String(signal)); }
    }
    // Only the admitted kernel boundary can discharge creation obligations.
    // Kernel/scan errors still remain errors, even with a positive tree proof.
    let boundary: ContainmentReceipt | undefined;
    if (containment) {
      await Bun.sleep(Math.max(0, 250 - (performance.now() - started)));
      try { boundary = await containment.drain(); this.errors.push(...boundary.errors); }
      catch (e) { this.errors.push('containment drain: ' + String(e)); }
    }
    if (!boundary?.containedTreeDrained) this.errors.push(...obligations);
    const pending = new Map(this.processes);
    do {
      if (!escalated && performance.now() - started >= 250) {
        escalated = true;
        try { this.proc.kill('SIGKILL'); }
        catch (e) { if (!absent(e)) this.errors.push('leader escalation: ' + String(e)); }
      }
      for (const [pid, birth] of pending) {
        if (performance.now() >= deadline) break;
        try {
          const state = await cleanupBound(this.identity(pid, birth), `owned identity ${pid}`,
            Math.max(1, deadline - performance.now()));
          if (state !== 'live') { results.push({ pid, birth, result: state }); pending.delete(pid); continue; }
          if (pid !== this.proc.pid) {
            // Descendants require their separately captured exact birth token.
            try { process.kill(pid, escalated ? 'SIGKILL' : 'SIGTERM'); } catch (e) { if (!absent(e)) throw e; }
          }
        } catch (e) {
          this.errors.push(`drain ${pid}: ${String(e)}`);
          results.push({ pid, birth, result: 'unknown' }); pending.delete(pid);
        }
      }
      if (pending.size && performance.now() < deadline) await Bun.sleep(25);
    } while (pending.size && performance.now() < deadline);
    for (const [pid, birth] of pending) {
      this.errors.push(`owned process drain unproven at deadline: ${pid}`);
      results.push({ pid, birth, result: 'unknown' });
    }
    return { containedTreeDrained: boundary?.containedTreeDrained === true, containment: boundary ?? null, authority: 'intrinsic-spawn-handle-and-exact-descendant-births', signal: 'SIGTERM', escalation: escalated ? 'SIGKILL' : null, graceMs: 250, results, errors: [...this.errors] };
  }
}

export async function cleanupBound<T>(promise: Promise<T>, label: string, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timeout')), ms);
    })]);
  } finally { clearTimeout(timer); }
}
