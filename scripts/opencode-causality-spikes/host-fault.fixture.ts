// Isolated fault injector run by safety.test.ts; only a fake subprocess handle.
import { expect, mock } from 'bun:test';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { testSpace } from './test-space';
import { cleanupBound } from './owned-cleanup';
import * as sandbox from '../opencode-generation-spikes/sandbox';
const original = { ...sandbox }, mode = process.argv[2];
let stops = 0, constructors = 0, killed = 0, spawned = 0, cancelled = 0;
const birth = { format: 'TEST', value: 'owned', bootId: 'TEST' };
mock.module('../opencode-generation-spikes/sandbox', () => ({ ...original,
  processBirth: async () => { if (mode === 'birth') throw Error('injected birth'); return birth; },
  OwnedProcessTree: class {
    readonly processes: Map<number, typeof birth>;
    constructor(pid: number, token: typeof birth) {
      if (++constructors === 1 && mode === 'ownership') throw Error('injected ownership');
      this.processes = new Map([[pid, token]]);
    }
  },
}));
mock.module('./owned-cleanup', () => ({
  OwnedCleanup: class {
    readonly processes;
    constructor(readonly proc: any, token: typeof birth, tree: any) {
      this.processes = tree.processes; expect(this.processes.get(proc.pid)).toEqual(token);
    }
    start() { if (mode === 'start') throw Error('injected start'); }
    async stop() { stops++; this.proc.kill('SIGTERM'); await this.proc.exited; return { errors: [], results: [{ result: 'TEST-drained' }] }; }
  },
  cleanupBound,
}));
mock.module('../opencode-generation-spikes/auth', () => ({ OwnedEndpoint: class {
  constructor() { if (mode === 'endpoint') throw Error('injected endpoint'); }
  stdout() { if (mode === 'capture') throw Error('injected capture'); return Promise.resolve('TEST'); }
  retire() {} revoke() {} scrub(s: string) { return s; }
} }));
const originalWire = await import('./wire');
mock.module('./wire', () => ({ ...originalWire, Wire: class { constructor() { throw Error('injected wire'); } }, Missing: class extends Error {} }));
const { host } = await import('./host');
const dir = await testSpace('host-fault');
let finish!: (code: number) => void;
const exited = new Promise<number>(resolve => { finish = resolve; });
const proc: any = { pid: 12345, exitCode: null, exited,
  kill(signal: string) { expect(signal).toBe(['birth', 'ownership'].includes(mode) ? 'SIGKILL' : 'SIGTERM'); killed++; finish(0); },
  stdout: new ReadableStream({ cancel() { cancelled++; } }), stderr: new Response('').body };
exited.then(code => { proc.exitCode = code; });
const spawn = Bun.spawn, serve = Bun.serve, records: any[] = [];
const binary = join(dir, 'TEST-dummy-bytes'); await writeFile(binary, 'dummy bytes');
(Bun as any).spawn = () => { spawned++; return proc; };
(Bun as any).serve = () => ({ port: 12345, stop() {} });
try {
  await expect(host({ root: dir, validate: async () => {}, path: async () => {}, env: () => ({}) } as any,
    { binary, sha256: original.sha('dummy bytes'), generation: 'v2', version: '2.0.0', packages: [] },
    { generation: 'v2', version: '2.0.0', scenario: 'default' },
    { raw: async () => {}, json: async (name: string, value: any) => records.push({ name, value }) } as any,
    AbortSignal.timeout(100))).rejects.toThrow('injected ' + mode);
  expect(spawned).toBe(1);
  expect(killed).toBe(1);
  expect(stops).toBe(['birth', 'ownership'].includes(mode) ? 0 : 1);
  expect(records.find(r => r.name === 'host-cleanup.json')?.value.drained).toBe(true);
  expect(proc.exitCode).toBe(0);
  if (mode !== 'wire') expect(cancelled).toBe(1);
} finally { (Bun as any).spawn = spawn; (Bun as any).serve = serve; await rm(dir, { recursive: true, force: true }); }
