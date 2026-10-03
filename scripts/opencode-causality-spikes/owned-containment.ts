// TEST-only Linux cgroup v2 custody. Root preallocates one empty private group;
// this module never creates/deletes groups or moves any process into them.
import { constants } from 'node:fs';
import { open, lstat, realpath, readFile, readdir, statfs, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, resolve, dirname, basename } from 'node:path';
import { processBirth, SOURCE, TASK, within, type Sandbox } from '../opencode-generation-spikes/sandbox';

const CGROUP2 = 0x63677270;
const ROOT = '/sys/fs/cgroup';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export type BoundaryID = { path: string; bootId: string; dev: string; ino: string };
type Birth = Awaited<ReturnType<typeof processBirth>>;
type Leader = { pid: number; birth: Birth };
export type ContainmentReceipt = { authority: 'private-TEST-cgroup-v2'; identity: BoundaryID;
  containedTreeDrained: boolean; killIssued: boolean; errors: string[] };

export function containmentOptions(env: Record<string, string | undefined>) {
  const keys = ['TEST_OPENCODE_CGROUP_V2_PATH', 'TEST_OPENCODE_CGROUP_V2_ID',
    'TEST_OPENCODE_CONTAINMENT_PYTHON', 'TEST_OPENCODE_CONTAINMENT_UID', 'TEST_OPENCODE_CONTAINMENT_GID'];
  if (keys.every(k => env[k] === undefined)) return undefined;
  if (keys.some(k => !env[k])) throw Error('incomplete TEST containment opt-in');
  const [path, encoded, python, uid, gid] = keys.map(k => env[k]!);
  if (!new RegExp(`^${ROOT}/TEST-opencode-owned-${UUID}$`).test(path!) || resolve(path!) !== path)
    throw Error('containment requires a canonical unique TEST cgroup path');
  const match = /^([0-9a-f-]{36}):([0-9]+):([0-9]+)$/.exec(encoded!);
  if (!match || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(match[1]!)) throw Error('invalid cgroup identity');
  if (!isAbsolute(python!) || resolve(python!) !== python) throw Error('explicit absolute Python interpreter required');
  if (![uid, gid].every(n => /^[1-9][0-9]*$/.test(n!) && Number.isSafeInteger(Number(n)) && Number(n) < 2 ** 32))
    throw Error('dedicated unprivileged TEST uid/gid required');
  return { identity: { path: path!, bootId: match[1]!, dev: match[2]!, ino: match[3]! },
    python: python!, uid: Number(uid), gid: Number(gid) };
}

export function populated(text: string) {
  const rows = text.trim().split('\n').map(line => line.trim().split(/\s+/));
  if (rows.some(r => r.length !== 2 || !/^[0-9]+$/.test(r[1]!)) || new Set(rows.map(r => r[0])).size !== rows.length)
    throw Error('invalid cgroup events');
  const value = rows.find(r => r[0] === 'populated')?.[1];
  if (value !== '0' && value !== '1') throw Error('missing/invalid populated readback');
  return value === '1';
}
export function pids(text: string) {
  const tokens = text.trim() ? text.trim().split(/\s+/) : [];
  if (tokens.some(t => !/^[1-9][0-9]*$/.test(t))) throw Error('invalid cgroup PID syntax');
  const values = tokens.map(Number);
  if (values.some(n => !Number.isSafeInteger(n) || n <= 0) || new Set(values).size !== values.length || values.length > 4096)
    throw Error('invalid/budget-exceeded cgroup process list');
  return values;
}

// Absolute deadlines also revoke late continuations: no timeout can authorize a
// later kill write. All writes use the original pinned descriptor, never a name.
export class LinuxTestContainment {
  private revoked = false;
  private leader?: Leader;
  private kill?: FileHandle;
  private events?: FileHandle;
  private admitted = false;
  private launched = false;
  private released = false;
  get hasAdmission() { return this.admitted && !this.revoked; }
  private constructor(readonly options: NonNullable<ReturnType<typeof containmentOptions>>, private directory: FileHandle) {}
  get identity() { return this.options.identity; }
  private guard(deadline: number) {
    if (this.revoked || performance.now() >= deadline) throw Error('containment authority revoked/deadline');
  }
  private async bounded<T>(operation: Promise<T>, deadline: number): Promise<T> {
    // Close handles returned after revocation instead of leaking late opens.
    void operation.then((value: any) => { if ((this.revoked || performance.now() >= deadline) && value?.close) void value.close().catch(() => {}); }, () => {});
    this.guard(deadline);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { this.revoked = true; reject(Error('containment observation timeout')); }, Math.max(1, deadline - performance.now()));
    })]); } finally { clearTimeout(timer); }
  }
  private async text(file: FileHandle) {
    const bytes = Buffer.alloc(65537);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65536) throw Error('containment observation budget exceeded');
    return bytes.subarray(0, bytesRead).toString('utf8');
  }
  private async control(name: string, flags = constants.O_RDONLY) {
    const file = await open(`/proc/self/fd/${this.directory.fd}/${name}`, flags | constants.O_NOFOLLOW);
    try {
      const s = await file.stat({ bigint: true });
      if (this.revoked) throw Error('containment authority revoked');
      if (!s.isFile() || s.uid !== 0n || (s.mode & 0o022n) || s.dev.toString() !== this.identity.dev)
        throw Error('foreign cgroup control authority');
      return file;
    } catch (e) { await file.close(); throw e; }
  }
  private async readControl(name: string) {
    const file = await this.control(name);
    try { return await this.text(file); } finally { await file.close(); }
  }
  private async verify(deadline: number) {
    const id = this.identity;
    const [s, pinned, canonical, boot, fs] = await this.bounded(Promise.all([
      lstat(id.path, { bigint: true }), this.directory.stat({ bigint: true }), realpath(id.path),
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'), statfs(id.path),
    ]), deadline);
    this.guard(deadline);
    if (canonical !== id.path || !s.isDirectory() || s.isSymbolicLink() || s.uid !== 0n || (s.mode & 0o022n) ||
        s.ino.toString() !== id.ino || s.dev.toString() !== id.dev || pinned.ino !== s.ino || pinned.dev !== s.dev ||
        boot.trim() !== id.bootId || Number(fs.type) !== CGROUP2) throw Error('cgroup boundary identity/authority changed');
    // No subgroups: otherwise the native could migrate away from the one group
    // represented by the admission receipt. Root sets these before delegation.
    const [depth, descendants, entries] = await this.bounded(Promise.all([
      this.readControl('cgroup.max.depth'), this.readControl('cgroup.max.descendants'),
      readdir(id.path, { withFileTypes: true }),
    ]), deadline);
    this.guard(deadline);
    if (depth.trim() !== '0' || descendants.trim() !== '0' || entries.some(e => e.isDirectory() || e.isSymbolicLink()))
      throw Error('cgroup is not a private leaf boundary');
  }
  static async prepare(env: Record<string, string | undefined> = process.env) {
    const options = containmentOptions(env);
    if (!options) return undefined;
    if (process.platform !== 'linux' || process.geteuid?.() !== 0) throw Error('containment admission requires the Linux Root TEST operator');
    const deadline = performance.now() + 3000;
    // Bootstrap also has a hard observation deadline; late opens are disposed.
    const observe = async <T>(operation: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      void operation.then((value: any) => { if (performance.now() >= deadline && value?.close) void value.close().catch(() => {}); }, () => {});
      try {
        if (performance.now() >= deadline) throw Error('containment bootstrap deadline');
        return await Promise.race([operation, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('containment bootstrap timeout')), Math.max(1, deadline - performance.now()));
        })]);
      } finally { clearTimeout(timer); }
    };
    const [root, rootProcs, canonicalRoot] = await observe(Promise.all([lstat(ROOT), lstat(join(ROOT, 'cgroup.procs')), realpath(ROOT)]));
    if (!rootProcs.isFile() || rootProcs.uid !== 0 || (rootProcs.mode & 0o022)) throw Error('untrusted common-ancestor migration authority');
    if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== 0 || (root.mode & 0o022) || canonicalRoot !== ROOT)
      throw Error('untrusted cgroup mount');
    const python = await observe(realpath(options.python)), interpreter = await observe(lstat(python));
    if (!interpreter.isFile() || interpreter.uid !== 0 || (interpreter.mode & 0o022)) throw Error('untrusted explicit interpreter');
    options.python = python;
    const directory = await observe(open(options.identity.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    const boundary = new LinuxTestContainment(options, directory);
    try {
      await boundary.verify(deadline);
      const [members, events, self] = await boundary.bounded(Promise.all([
        boundary.readControl('cgroup.procs'), boundary.readControl('cgroup.events'), readFile('/proc/self/cgroup', 'utf8'),
      ]), deadline);
      boundary.guard(deadline);
      if (pids(members).length || populated(events) || self.split('\n').includes('0::' + options.identity.path.slice(ROOT.length)))
        throw Error('refusing nonempty/shared/worker cgroup');
      boundary.kill = await boundary.bounded(boundary.control('cgroup.kill', constants.O_WRONLY), deadline);
      boundary.events = await boundary.bounded(boundary.control('cgroup.events'), deadline);
      boundary.guard(deadline);
      return boundary;
    } catch (e) { void boundary.close(); throw e; }
  }
  command(binary: string, args: string[], receipt: string) {
    if (this.revoked || this.launched || !isAbsolute(binary) || !isAbsolute(receipt)) throw Error('invalid containment launch');
    this.launched = true;
    return [this.options.python, '-I', '-B', join(import.meta.dir, 'owned-containment-launcher.py'),
      '--boundary', this.identity.path, '--identity', `${this.identity.bootId}:${this.identity.dev}:${this.identity.ino}`,
      '--uid', String(this.options.uid), '--gid', String(this.options.gid), '--receipt', receipt, '--', binary, ...args];
  }
  async release(pipe: { write(data: string): number | Promise<number>; end(): unknown }) {
    if (!this.hasAdmission || this.released) throw Error('execution requires single trusted admission');
    this.released = true;
    // Release errors must retain already established cleanup custody.
    if (await pipe.write('ACK\n') !== 4) throw Error('short parent admission ACK');
    await pipe.end();
  }
  async admit(pid: number, birth: Birth, receipt: string) {
    const deadline = performance.now() + 3000;
    if (!this.launched || this.admitted || this.revoked) throw Error('invalid/repeated admission');
    try {
      let value: any;
      while (!value) {
        this.guard(deadline);
        try {
          const f = await this.bounded(open(receipt, constants.O_RDONLY | constants.O_NOFOLLOW), deadline);
          try {
            const s = await this.bounded(f.stat(), deadline);
            if (!s.isFile() || s.uid !== 0 || s.nlink !== 1 || (s.mode & 0o077)) throw Error('untrusted launch receipt');
            const text = await this.bounded(this.text(f), deadline);
            if (text) value = JSON.parse(text);
          } finally { await f.close(); }
          if (!value) await Bun.sleep(10);
        } catch (e: any) { if (e.code !== 'ENOENT') throw e; await Bun.sleep(10); }
      }
      await this.verify(deadline);
      this.guard(deadline);
      if (value.pid !== pid || JSON.stringify(value.identity) !== JSON.stringify(this.identity) ||
          value.startTicks !== (birth as any).value || (birth as any).bootId !== this.identity.bootId ||
          value.uid !== this.options.uid || value.gid !== this.options.gid) throw Error('containment launch receipt mismatch');
      // The launcher waits on the intrinsic ACK pipe before exec/fork. Live
      // membership and exact birth independently bind that receipt to our handle.
      const [members, current, membership] = await this.bounded(Promise.all([
        this.readControl('cgroup.procs'), processBirth(pid), readFile(`/proc/${pid}/cgroup`, 'utf8'),
      ]), deadline);
      this.guard(deadline);
      if (JSON.stringify(pids(members)) !== JSON.stringify([pid]) || JSON.stringify(current) !== JSON.stringify(birth) ||
          !membership.split('\n').includes('0::' + this.identity.path.slice(ROOT.length))) throw Error('known leader not in trusted boundary');
      this.leader = { pid, birth }; this.admitted = true;
    } catch (e) { this.revoked = true; throw e; }
  }
  async drain(): Promise<ContainmentReceipt> {
    const receipt: ContainmentReceipt = { authority: 'private-TEST-cgroup-v2', identity: this.identity,
      containedTreeDrained: false, killIssued: false, errors: [] };
    const deadline = performance.now() + 3000;
    try {
      this.guard(deadline);
      if (!this.admitted || !this.leader || !this.kill || !this.events) throw Error('no trusted containment admission');
      await this.verify(deadline);
      // A surviving leader may not have moved out. An absent leader does not
      // revoke inherited kernel custody; it also does not prove a tree drain.
      const stat = await this.bounded(readFile(`/proc/${this.leader.pid}/stat`, 'utf8').catch((e: any) => {
        if (e.code === 'ENOENT' || e.code === 'ESRCH') return null; throw e;
      }), deadline);
      if (stat !== null) {
        const [birth, membership] = await this.bounded(Promise.all([
          processBirth(this.leader.pid), readFile(`/proc/${this.leader.pid}/cgroup`, 'utf8'),
        ]), deadline);
        if (JSON.stringify(birth) !== JSON.stringify(this.leader.birth) ||
            !membership.split('\n').includes('0::' + this.identity.path.slice(ROOT.length))) throw Error('leader identity/membership changed');
      }
      await this.verify(deadline);
      this.guard(deadline);
      if (populated(await this.bounded(this.text(this.events), deadline))) {
        this.guard(deadline);
        await this.bounded(this.kill.write('1', 0, 'utf8'), deadline); receipt.killIssued = true;
      }
      do {
        await this.verify(deadline);
        const occupied = populated(await this.bounded(this.text(this.events), deadline));
        this.guard(deadline);
        if (!occupied) {
          await this.verify(deadline); this.guard(deadline);
          receipt.containedTreeDrained = true; break;
        }
        await Bun.sleep(20);
      } while (true);
    } catch (e) { receipt.errors.push(String(e)); }
    finally { void this.close(); }
    return receipt;
  }
  async close() {
    this.revoked = true;
    await Promise.allSettled([this.kill?.close(), this.events?.close(), this.directory.close()]);
  }
}

// Only a fresh, Root-private Sandbox-owned TEST tree can be delegated. Pin the
// entire validated tree before changing access; never mutate a path by name.
// Keep Root ownership so Sandbox's Root Git validation remains valid. Grant the
// explicit child GID access, with no world access and no evidence delegation.
export async function prepareTestFilesystemAccess(
  sandbox: Pick<Sandbox, 'root' | 'evidence' | 'marker'>, uid: number, gid: number,
) {
  if (process.platform !== 'linux' || process.geteuid?.() !== 0 ||
      ![uid, gid].every(n => Number.isSafeInteger(n) && n > 0 && n < 2 ** 32))
    throw Error('Root and explicit unprivileged TEST identity required');
  const { root, evidence, marker } = sandbox;
  const unitRoot = join(SOURCE, '.task-output', 'unit-roots');
  for (const path of [root, evidence]) {
    if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path ||
        (within(SOURCE, path) && !within(unitRoot, path))) throw Error('noncanonical/source TEST scope');
  }
  if (!basename(root).startsWith('TEST-') || within(root, evidence) || within(evidence, root) ||
      marker.task !== TASK || marker.root !== root || marker.evidence !== evidence ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(marker.nonce))
    throw Error('explicit owned TEST scope required');
  const handles: Array<{ file: FileHandle; path: string; directory: boolean; mode: number; dev: bigint; ino: bigint }> = [];
  const privateHandles: FileHandle[] = [];
  const checkPrivate = async (path: string, directory: boolean) => {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW |
      (directory ? constants.O_DIRECTORY : constants.O_NONBLOCK));
    privateHandles.push(file);
    const s = await file.stat({ bigint: true });
    if (s.uid !== 0n || (s.mode & 0o777n) !== (directory ? 0o700n : 0o600n) ||
        (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1n))
      throw Error('Root-private TEST ownership required');
    return file;
  };
  try {
    const evidenceDirectory = await checkPrivate(evidence, true);
    const evidenceMarker = await checkPrivate('/proc/self/fd/' + evidenceDirectory.fd + '/.test-project-owner.json', false);
    if (JSON.stringify(JSON.parse(await evidenceMarker.readFile('utf8'))) !== JSON.stringify(marker))
      throw Error('TEST evidence ownership changed');
    // Ancestors are read-only checks. An inaccessible parent must be prepared by
    // Root independently; this helper cannot chmod/chown outside its owned tree.
    for (const scope of [root, evidence]) {
      for (let path = dirname(scope); ; path = dirname(path)) {
        const s = await lstat(path);
        const execute = s.uid === uid ? 0o100 : s.gid === gid ? 0o010 : 0o001;
        if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 ||
            ((s.mode & 0o022) && !(s.mode & 0o1000)))
          throw Error('untrusted TEST ancestor');
        if (scope === root && !(s.mode & execute))
          throw Error('TEST ancestor is inaccessible to explicit child identity');
        if (path === '/') break;
      }
    }
    const rootHandle = await checkPrivate(root, true);
    const rootStat = await rootHandle.stat({ bigint: true });
    // Include root last in the grant, keeping descendants inaccessible until all
    // validation and descriptor-based changes have completed.
    const visit = async (file: FileHandle, path: string): Promise<void> => {
      const s = await file.stat({ bigint: true });
      if (handles.length >= 8192 || s.uid !== 0n || (s.mode & 0o022n) || s.dev !== rootStat.dev ||
          (!s.isDirectory() && (!s.isFile() || s.nlink !== 1n)))
        throw Error('foreign/link/special/budget-exceeded TEST entry');
      const entry = { file, path, directory: s.isDirectory(), mode: Number(s.mode), dev: s.dev, ino: s.ino };
      handles.push(entry);
      if (entry.directory) {
        for (const name of await readdir('/proc/self/fd/' + file.fd)) {
          if (path === root && name === '.test-project-owner.json') continue;
          const child = await open('/proc/self/fd/' + file.fd + '/' + name,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          privateHandles.push(child);
          await visit(child, join(path, name));
        }
      }
    };
    const rootMarker = await checkPrivate('/proc/self/fd/' + rootHandle.fd + '/.test-project-owner.json', false);
    if (JSON.stringify(JSON.parse(await rootMarker.readFile('utf8'))) !== JSON.stringify(marker))
      throw Error('TEST project ownership changed');
    await visit(rootHandle, root);
    // Detect name replacement before any grant. All mutations still use pins.
    for (const entry of handles) {
      const s = await lstat(entry.path, { bigint: true });
      if (s.isSymbolicLink() || s.dev !== entry.dev || s.ino !== entry.ino)
        throw Error('TEST entry identity changed');
    }
    for (const entry of handles.filter(e => e.path !== root)) {
      await entry.file.chown(0, gid);
      await entry.file.chmod(entry.directory || (entry.mode & 0o111) ? 0o770 : 0o660);
    }
    await rootHandle.chown(0, gid);
    await rootHandle.chmod(0o770);
    for (const entry of handles) {
      const s = await entry.file.stat();
      const mode = entry.directory || (entry.mode & 0o111) ? 0o770 : 0o660;
      if (s.uid !== 0 || s.gid !== gid || (s.mode & 0o7777) !== mode)
        throw Error('TEST access grant readback mismatch');
    }
    const privateStat = await evidenceDirectory.stat();
    if (privateStat.uid !== 0 || (privateStat.mode & 0o777) !== 0o700)
      throw Error('TEST evidence privacy changed');
    return sandboxEnvironment(root);
  } finally {
    await Promise.allSettled(privateHandles.map(file => file.close()));
  }
}

// Native Git trust applies to this child and this exact TEST root only.
export function sandboxEnvironment(root: string) {
  if (!isAbsolute(root) || resolve(root) !== root || !basename(root).startsWith('TEST-'))
    throw Error('explicit canonical TEST Git root required');
  return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: root };
}
