import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { Evidence, Wire } from './wire';
import { LossBoundary } from './loss';

for (const phase of ['before-forward', 'after-response'] as const) {
  test(`real HTTP 204: ${phase} suppresses observation, retains native witness, one POST then recovery GET`, async () => {
    const entries: any[] = [], raw = new Map<string, Buffer>();
    const evidence = new Evidence('/unused', async () => {});
    evidence.raw = async (name, bytes) => { raw.set(name, Buffer.from(bytes)); };
    const native = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(r) {
      entries.push({ method: r.method, path: new URL(r.url).pathname, body: r.method === 'POST' ? await r.json() : null });
      return r.method === 'POST' ? new Response(null, { status: 204 }) : Response.json({ persisted: true });
    } });
    const wire = new Wire(`http://127.0.0.1:${native.port}`, async () => ({}), evidence.raw, AbortSignal.timeout(2500));
    const boundary = new LossBoundary(wire, '/session/TEST/prompt_async', { messageID: 'TEST-one' }, phase, evidence);
    try {
      boundary.start();
      await boundary.observe();
      expect(boundary.witness).toEqual({ status: 204, value: null });
      expect(JSON.parse(raw.get('headers-0.json')!.toString()).status).toBe(204);
      expect(raw.get('response-0.raw')!.length).toBe(0);
      expect(JSON.parse(raw.get('loss-downstream-status.json')!.toString()).status).toBe(503);
      expect((await wire.call('/session/TEST/message')).value).toEqual({ persisted: true });
      const duplicate = await boundary.handle(new Request('http://127.0.0.1/loss/' + boundary.nonce, {
        method: 'POST', body: JSON.stringify(boundary.body),
      }));
      expect(duplicate.status).toBe(409);
      await expect(boundary.observe()).rejects.toThrow('response loss not observed');
      expect(JSON.parse(raw.get('loss-downstream-status.json')!.toString()).status).toBe(409);
      await Bun.sleep(100);
      expect(entries).toEqual([
        { method: 'POST', path: '/session/TEST/prompt_async', body: { messageID: 'TEST-one' } },
        { method: 'GET', path: '/session/TEST/message', body: null },
      ]);
    } finally { await boundary.stop(); native.stop(true); }
  });
}

for (const mode of ['escalation', 'ESRCH', 'EACCES', 'foreign', 'pipe', 'host', 'host-pipe', 'boot-ENOENT', 'boot-ESRCH', 'identity-stall', 'late-capture', 'ancestry', 'shutdown-fork', 'leader-fork'] as const) {
  test(`intrinsic fake owned subprocess ${mode}: known processes drain, unresolved creation is explicit, sentinel survives`, async () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'native-boundaries.fixture.ts'), mode], {
      stdout: 'pipe', stderr: 'pipe', env: { ...process.env },
    });
    const stdout = new Response(proc.stdout).text(), stderr = new Response(proc.stderr).text();
    const code = await proc.exited;
    expect({ code, stdout: await stdout, stderr: await stderr }).toEqual({ code: 0, stdout: '', stderr: '' });
  }, 12000);
}
