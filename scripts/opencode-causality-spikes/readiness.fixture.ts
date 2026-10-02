// Isolated host regression: only a mock spawn handle and a real localhost dummy HTTP server.
import { expect, mock } from 'bun:test';
import { createServer } from 'node:http';
import { readlink, readFile, rm } from 'node:fs/promises';
import { testSpace } from './test-space';
import * as sandbox from '../opencode-generation-spikes/sandbox';
import { Missing } from './wire';
const original = { ...sandbox }, mode = process.argv[2];
const birth = await original.processBirth(process.pid);
let finish!: (code: number) => void, stops = 0;
const exited = new Promise<number>(resolve => { finish = resolve; });
mock.module('../opencode-generation-spikes/sandbox', () => ({ ...original,
  OwnedProcessTree: class { start() {} async stop() { stops++; finish(0); return 'TEST-drained'; } },
}));
mock.module('../opencode-generation-spikes/auth', () => ({ OwnedEndpoint: class {
  async headers() { return { Authorization: 'Basic TEST-SECRET' }; }
  stdout() { return Promise.resolve('TEST'); } retire() {} revoke() {} scrub(s: string) { return s; }
} }));
const { host } = await import('./host');
const dir = await testSpace('readiness');
const binary = await readlink(`/proc/${process.pid}/exe`);
const artifact = { binary, sha256: original.sha(await readFile(binary)), generation: 'v1', version: '1.16.0', packages: [] } as const;
const abort = new AbortController(), deadline = setTimeout(() => abort.abort(Error('TEST-global-deadline')), 2200);
let health = 0, closed = 0, mutations = 0;
const sockets = new Set<any>(), timers: ReturnType<typeof setTimeout>[] = [], records: any[] = [], rawBodies = new Map<string, Buffer>();
const server = createServer((req, res) => {
  if (req.method !== 'GET') mutations++;
  const send = (value: any, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (req.url === '/global/health') {
    health++;
    if (mode === 'exhaust') return send({ healthy: false }, 503);
    if (mode === 'identity') return send({ version: 'WRONG' });
    if (health === 1 && mode !== 'recorder') {
      res.on('close', () => { closed++; });
      if (mode === 'body' || mode === 'reset') {
        res.writeHead(200, { 'content-type': 'application/json' }); res.write('{');
        if (mode === 'reset') timers.push(setTimeout(() => res.destroy(), 30));
      }
      if (mode === 'abort') timers.push(setTimeout(() => abort.abort(Error('TEST-stop')), 100));
      return; // Real connection remains open until the client cancels.
    }
    return send({ healthy: true, version: '1.16.0' });
  }
  if (req.url === '/path') return send({ directory: dir });
  if (req.url === '/provider') { timers.push(setTimeout(() => send({ TEST: 'slow-provider' }), 650)); return; }
  return send({ TEST: 'unexpected' }, 404);
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
const spawn = Bun.spawn;
const proc: any = { pid: process.pid, exitCode: null, exited, stdout: new Response('').body, stderr: new Response('').body };
exited.then(code => { proc.exitCode = code; });
(Bun as any).spawn = (argv: string[]) => { server.listen(Number(argv.at(-1)), '127.0.0.1'); return proc; };
let result: Awaited<ReturnType<typeof host>> | undefined, error: any;
const evidence: any = {
  raw: async (name: string, bytes: Uint8Array) => { rawBodies.set(name, Buffer.from(bytes)); if (mode === 'recorder' && name.startsWith('headers')) throw Error('TEST-disk-failure'); },
  json: async (name: string, value: any) => { records.push({ name, value }); },
};
if (mode === 'exhaust') { clearTimeout(deadline); timers.push(setTimeout(() => abort.abort(Error('TEST-global-deadline')), 6000)); }
const start = performance.now();
try {
  try { result = await host({ root: dir, validate: async () => {}, path: async () => {}, env: () => ({}) } as any,
    artifact, { generation: 'v1', version: '1.16.0', scenario: 'default' }, evidence, abort.signal); }
  catch (e) { error = e; }
  if (mode === 'reset' && error) console.log(JSON.stringify({ mode, health, stops, closed, errorCode: error.code, globalAborted: abort.signal.aborted, partialBody: rawBodies.get('response-0.raw')?.toString(), readiness: records.filter(r => r.name.startsWith('readiness-')), drained: records.find(r => r.name === 'host-cleanup.json')?.value.drained }));
  if (['headers', 'body', 'reset'].includes(mode)) {
    expect(error).toBeUndefined(); expect(result).toBeDefined();
    expect(performance.now() - start).toBeLessThan(1700);
    expect(health).toBe(2);
    expect((await result!.wire.call('/provider')).value).toEqual({ TEST: 'slow-provider' });
    expect(abort.signal.aborted).toBe(false);
    const breadcrumbs = records.filter(r => r.name.startsWith('readiness-'));
    expect(breadcrumbs.map(r => r.value.failure)).toEqual([mode === 'reset' ? 'request-failed' : 'attempt-timeout']);
    if (mode === 'reset') {
      expect(rawBodies.get('response-0.raw')?.toString()).toBe('{');
      expect(JSON.parse(rawBodies.get('headers-0.json')!.toString()).status).toBe(200);
      expect(closed).toBe(1);
      expect(breadcrumbs[0].value).toEqual({ attempt: 0, path: '/global/health', failure: 'request-failed', timeoutMs: 500 });
    }
    expect(JSON.stringify(breadcrumbs)).not.toContain('TEST-SECRET');
    expect(result!.wire.calls.filter(c => c.method !== 'GET')).toEqual([]);
    await result!.stop(); result = undefined;
  } else if (mode === 'abort') {
    expect(error?.message).toBe('TEST-stop'); expect(health).toBe(1);
    await Bun.sleep(650); expect(health).toBe(1);
  } else if (mode === 'exhaust') {
    expect(error instanceof Missing).toBe(true); expect(error?.message).toContain('readiness exhausted');
    expect(health).toBe(40); expect(records.filter(r => r.name.startsWith('readiness-')).length).toBe(40);
  } else if (mode === 'identity') {
    expect(error?.message).toBe('live native identity mismatch'); expect(health).toBe(1);
  } else if (mode === 'recorder') {
    expect(error?.cause?.message ?? error?.message).toBe('TEST-disk-failure'); expect(health).toBe(1);
  }
  expect(stops).toBe(1); expect(proc.exitCode).toBe(0); expect(mutations).toBe(0);
  expect(records.find(r => r.name === 'host-cleanup.json')?.value.drained).toBe(true);
  expect(await original.processBirth(process.pid)).toEqual(birth);
  if (mode === 'reset') console.log(JSON.stringify({ mode, health, stops, closed, mutations, partialBody: rawBodies.get('response-0.raw')?.toString(), readiness: records.filter(r => r.name.startsWith('readiness-')), drained: records.find(r => r.name === 'host-cleanup.json')?.value.drained, globalAborted: abort.signal.aborted }));
} finally {
  if (result) await result.stop();
  (Bun as any).spawn = spawn; clearTimeout(deadline); timers.forEach(clearTimeout);
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  expect(sockets.size).toBe(0); expect(server.listening).toBe(false);
  await rm(dir, { recursive: true, force: true });
}
