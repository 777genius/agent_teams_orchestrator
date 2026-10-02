import { test, expect } from 'bun:test';
import { mkdir, writeFile, readFile, lstat, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { testSpace } from './test-space';
import { admitRoots } from './preflight';
const absent = async (path: string) => {
  try { await lstat(path); return false; } catch (e: any) { if (e.code === 'ENOENT') return true; throw e; }
};
const deadline = async <T>(work: Promise<T>, ms: number, fallback: T) => {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([work, new Promise<T>(r => { timer = setTimeout(() => r(fallback), ms); })]); }
  finally { clearTimeout(timer!); }
};

test('R2-FIFO public preflight rejects canonical metadata FIFO without a writer and leaves roots absent', async () => {
  const parent = await testSpace('fifo'), bundle = join(parent, 'TEST-bundle');
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await mkdir(bundle);
    const reference = join(parent, 'TEST-reference'); await writeFile(reference, 'preserved reference');
    const fifo = join(bundle, 'root.metadata.json');
    const mkfifo = Bun.spawn(['/usr/bin/mkfifo', fifo], { stdout: 'pipe', stderr: 'pipe' });
    const [mkcode, mkout, mkerr] = await Promise.all([mkfifo.exited, new Response(mkfifo.stdout).text(), new Response(mkfifo.stderr).text()]);
    expect({ mkcode, mkout, mkerr }).toEqual({ mkcode: 0, mkout: '', mkerr: '' });
    proc = Bun.spawn([process.execPath, join(import.meta.dir, 'preflight-fifo.fixture.ts'), bundle], { stdout: 'pipe', stderr: 'pipe' });
    let output = '', ready!: () => void;
    const readiness = new Promise<void>(r => { ready = r; });
    const stdout = (async () => {
      for await (const bytes of proc!.stdout as ReadableStream<Uint8Array>) {
        output += Buffer.from(bytes).toString(); if (output.includes('READY\n')) ready();
      }
    })();
    const stderr = new Response(proc.stderr).text();
    // Startup has its own generous barrier; only preflight after READY is bounded.
    const started = await deadline(readiness.then(() => true), 10000, false);
    const exited = started && await deadline(proc.exited.then(() => true), 2000, false);
    if (!exited && proc.exitCode === null) proc.kill('SIGKILL');
    await proc.exited; await stdout; const errors = await stderr;
    expect(started).toBe(true);
    expect(await absent(join(parent, 'TEST-root'))).toBe(true);
    expect(await absent(join(parent, 'TEST-evidence'))).toBe(true);
    expect(await readFile(reference, 'utf8')).toBe('preserved reference');
    expect((await lstat(fifo)).isFIFO()).toBe(true);
    console.log(JSON.stringify({ started, exited, output, errors }));
    expect(exited).toBe(true);
    expect(output).toContain('REJECTED Error: nonregular');
    expect(errors).toBe('');
  } finally {
    if (proc && proc.exitCode === null) { proc.kill('SIGKILL'); await proc.exited; }
    await rm(parent, { recursive: true, force: true });
  }
}, 20000);

test('R3-BINARY-REFERENCE public admission protects independently staged binary container for either root', async () => {
  const parent = await testSpace('binary-reference');
  try {
    const inputs = join(parent, 'TEST-inputs'), reference = join(parent, 'TEST-binary-reference');
    await mkdir(inputs); await mkdir(reference);
    const binary = join(reference, 'native-opencode'); await writeFile(binary, 'preserved binary bytes');
    const selected = { root: join(parent, 'TEST-root'), evidence: join(parent, 'TEST-evidence'), binary,
      bundle: join(inputs, 'bundle'), receipt: { path: join(inputs, 'receipt'), sha256: '1'.repeat(64) },
      acceptance: { path: join(inputs, 'acceptance'), sha256: '2'.repeat(64) } };
    const before = await readdir(reference);
    await admitRoots(selected, { subject: {} }); // Valid unrelated roots remain admissible.
    for (const key of ['root', 'evidence'] as const) {
      for (const path of [join(reference, 'TEST-child'), reference, parent]) {
        const attempt = { ...selected, [key]: path };
        let rejected = false;
        try { await admitRoots(attempt, { subject: {} }); } catch { rejected = true; }
        expect(await absent(selected.root)).toBe(true); expect(await absent(selected.evidence)).toBe(true);
        expect(await absent(join(reference, 'TEST-child'))).toBe(true);
        expect(await readFile(binary, 'utf8')).toBe('preserved binary bytes');
        expect(await readdir(reference)).toEqual(before);
        expect(rejected).toBe(true);
      }
    }
  } finally { await rm(parent, { recursive: true, force: true }); }
});
