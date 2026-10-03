import { test, expect } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { testSpace } from './test-space';
import { argumentsFor } from '../opencode-causality-spike';
import { selection, promptBody } from './contracts';
import { Wire, Evidence, readBounded } from './wire';
import { transcript, LogCut, consumeSSE } from './collect';
import { facts } from './facts';
import { CausalModel } from './model';
import { pinned, bindArtifact } from './gate';
import { Sandbox, OwnedProcessTree, processBirth, sha } from '../opencode-generation-spikes/sandbox';

const noop = async () => {};
const event = (type: string, data: any, id = type, seq = 44) => ({ id, type, created: 2,
  durable: { aggregateID: 'ses_test', seq, version: 1 }, location: { directory: '/TEST-project' }, data: { sessionID: 'ses_test', ...data } });
// Public Request/Response unit transport: no native or TCP qualification claim.
const server = (handle: (r: Request) => Response | Promise<Response>) => ({
  port: 12345, stop: (_force: boolean) => {},
  transport: (async (input: any, init: any) => {
    const request = new Request(input, init);
    const abort = new Promise<never>((_, reject) => {
      if (request.signal.aborted) reject(request.signal.reason);
      else request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    });
    return Promise.race([Promise.resolve(handle(request)), abort]);
  }) as typeof fetch,
});
const wireFor = (s: ReturnType<typeof server>, signal = AbortSignal.timeout(1000), record = noop) => new Wire(`http://127.0.0.1:${s.port}`, async () => ({}), record, signal, s.transport);

test('only explicit exact generation/pin/scenario is admitted (blocks accidental matrix/runtime defaults)', () => {
  for (const [g, pins] of [['v1', ['1.16.0', '1.18.34']], ['v2', ['2.0.0', '2.0.21']]] as const) {
    for (const pin of pins) expect(selection(g, pin, 'default').version).toBe(pin);
  }
  expect(() => selection('v2', '1.16.0', 'default')).toThrow();
  expect(() => selection('v2', '2.0.22', 'default')).toThrow();
  expect(() => selection('v1', '1.16.0', 'all')).toThrow();
  expect(() => argumentsFor([])).toThrow();
  expect(() => argumentsFor(['--pin', '2.0.0', '--pin', '2.0.21'])).toThrow();
  expect(promptBody(selection('v1', '1.16.0', 'queue'), 'msg_x', 'marker')).toBeNull();
  expect(promptBody(selection('v2', '2.0.0', 'default'), 'msg_x', 'marker')).toEqual({ id: 'msg_x', text: 'marker' });
});

test('HTTP response loss preserves raw 4xx witness and forwards once; subsequent recovery is GET only', async () => {
  const incoming: string[] = [], evidence: Record<string, string> = {};
  const s = server(r => { incoming.push(r.method); return Response.json({ _tag: 'ConflictError', native: 'untouched' }, { status: 409 }); });
  try {
    const wire = wireFor(s, AbortSignal.timeout(1000), async (name, bytes) => { evidence[name] = Buffer.from(bytes).toString(); });
    await expect(wire.call('/prompt', 'POST', { id: 'msg_x' }, true)).rejects.toThrow('AFTER forwarding once');
    const readback = await wire.call('/inbox');
    expect(readback.status).toBe(409);
    expect(incoming).toEqual(['POST', 'GET']);
    expect(evidence['response-0.raw']).toBe('{"_tag":"ConflictError","native":"untouched"}');
    expect(wire.calls.filter(c => c.method === 'POST' && c.sent)).toHaveLength(1);
  } finally { s.stop(true); }
});

test('malformed, foreign and conflicting duplicate durable inputs never form a cut; exact overlap is deduped', () => {
  const cut = new LogCut('ses_test', '/TEST-project');
  const e = event('session.execution.started', {});
  cut.accept(e); cut.accept(structuredClone(e)); expect(cut.events).toHaveLength(1);
  expect(() => cut.accept({ ...e, created: 3 })).toThrow('duplicate');
  expect(() => cut.accept({ ...e, id: 'other' })).toThrow('sequence');
  expect(() => cut.accept({ ...e, data: { sessionID: 'ses_foreign' } })).toThrow();
  expect(() => cut.accept({ ...e, location: { directory: '/user-project' } })).toThrow();
  expect(() => cut.accept({ ...e, durable: { aggregateID: 'ses_foreign', seq: 44, version: 1 } })).toThrow();
  expect(() => cut.accept({ type: 'session.execution.started' })).toThrow();
});

test('empty synced watermark is valid but a foreign/data-wrapped watermark is rejected', () => {
  const cut = new LogCut('ses_test', '/TEST-project');
  expect(cut.accept({ type: 'log.synced', aggregateID: 'ses_test' })).toBe(true);
  expect(cut.synced).toEqual({ type: 'log.synced', aggregateID: 'ses_test' });
  expect(() => cut.accept({ type: 'log.synced', aggregateID: 'ses_test' })).toThrow('duplicate');
  expect(() => new LogCut('ses_test', '/TEST-project').accept({ type: 'log.synced', aggregateID: 'ses_other' })).toThrow();
  expect(() => new LogCut('ses_test', '/TEST-project').accept({ type: 'log.synced', data: { aggregateID: 'ses_test', seq: 0 } })).toThrow();
});

test('execution before delivery stays separate; opaque seq is never sorted and ID mapping is observed independently', () => {
  const cut = new LogCut('ses_test', '/TEST-project');
  cut.accept(event('session.inbox.enqueued', { inboxID: 'msg_receipt', item: { type: 'user', payload: { text: 'marker' } } }, 'enq', 999));
  cut.accept(event('session.execution.started', {}, 'start', 4));
  cut.accept(event('session.inbox.delivered', { inboxID: 'msg_receipt' }, 'delivered', 2));
  cut.accept(event('session.execution.succeeded', {}, 'terminal', 1));
  cut.accept({ type: 'log.synced', aggregateID: 'ses_test', seq: 1 });
  const f = facts({ generation: 'v2', sessionID: 'ses_test', callerID: 'msg_caller', marker: 'marker',
    receipt: { id: 'msg_receipt', sessionID: 'ses_test', type: 'user', payload: { text: 'marker' } }, cut,
    rows: [{ id: 'msg_projection', type: 'user', text: 'marker' }], complete: true });
  expect(f.executionStartBeforeDeliveryObserved).toBe(true);
  expect(f.executionStart[0]!.seq).toBe(4); expect(f.delivery[0]!.seq).toBe(2);
  expect(f.callerID).toBe('msg_caller'); expect(f.receiptID).toBe('msg_receipt');
  expect(f.projectedUserID).toBe('msg_projection'); expect(f.inboxProjectedEqualityObserved).toBe(false);
  expect(f.status).toBe('MISSING'); // these unit rows are never native qualification
});

test('foreign/batched projection and malformed receipt remain unknown/FAIL, never settlement', () => {
  const cut = new LogCut('ses_test', '/TEST-project');
  cut.accept(event('session.inbox.enqueued', { inboxID: 'msg_foreign', item: { type: 'user', payload: { text: 'foreign' } } }));
  const input = { generation: 'v2', sessionID: 'ses_test', callerID: 'msg_x', marker: 'marker', rows: [], complete: false, cut };
  expect(facts(input).missing).toContain('foreign/control/batch input');
  expect(facts({ ...input, receipt: { id: 'msg_x', sessionID: 'foreign', type: 'user', payload: { text: 'marker' } } }).status).toBe('FAIL');
  expect(facts({ ...input, rows: [{ id: 'a', type: 'user', text: 'marker' }, { id: 'b', type: 'user', text: 'marker' }] }).status).toBe('FAIL');
});

test('V1 only canonical parent belongs to caller; partial text/tools and unrelated completed assistant cannot settle', () => {
  const f = facts({ generation: 'v1', sessionID: 'ses_test', callerID: 'msg_user', marker: 'marker', complete: true,
    rows: [ { info: { id: 'msg_user', role: 'user' }, parts: [{ type: 'text', text: 'marker' }] },
      { info: { id: 'a', role: 'assistant', parentID: 'msg_foreign', time: { completed: 4 }, finish: 'stop' }, parts: [{ type: 'text', text: 'done' }] },
      { info: { id: 'b', role: 'assistant', parentID: 'msg_user', time: { completed: 4 }, finish: 'stop' }, parts: [{ type: 'tool', state: { status: 'running' } }] } ] });
  expect(f.terminalAssistantIDs).toEqual([]); expect(f.executionStart).toEqual([]); expect(f.synced).toBeNull();
});

test('complete pagination preserves arbitrary real union rows and sends opaque cursor without order', async () => {
  const paths: string[] = [];
  const s = server(r => {
    paths.push(new URL(r.url).search);
    return Response.json(paths.length === 1 ? { data: [{ id: 'msg_x', type: 'compaction', raw: { keep: true } }], cursor: { next: 'z&/opaque?not-ordered' } } : { data: [], cursor: {} });
  });
  try {
    const result = await transcript(wireFor(s), 'ses_test', 'v2');
    expect(result.rows).toEqual([{ id: 'msg_x', type: 'compaction', raw: { keep: true } }]);
    expect(paths).toEqual(['?limit=100&order=asc', '?limit=100&cursor=z%26%2Fopaque%3Fnot-ordered']);
    expect(result.complete).toBe(true);
  } finally { s.stop(true); }
});

for (const variant of ['missing', 'cyclic', 'duplicate', 'empty-next'] as const) {
  test(`pagination ${variant} cannot be labelled complete`, async () => {
    let requests = 0;
    const s = server(() => {
      requests++;
      const data = variant === 'empty-next' ? [] : [{ id: variant === 'duplicate' ? 'same' : 'msg_' + requests, type: 'user', text: 'raw' }];
      return Response.json({ data, cursor: variant === 'missing' ? {} : { next: variant === 'duplicate' ? 'page-' + requests : 'cycle' } });
    });
    try { await expect(transcript(wireFor(s), 'ses_test', 'v2')).rejects.toThrow(); expect(requests).toBeLessThan(4); }
    finally { s.stop(true); }
  });
}

test('page budget finite even with ever-new cursors', async () => {
  let count = 0;
  const s = server(() => Response.json({ data: [{ id: 'm' + count, type: 'shell' }], cursor: { next: 'c' + count++ } }));
  try { await expect(transcript(wireFor(s, AbortSignal.timeout(5000)), 'ses_test', 'v2')).rejects.toThrow('page budget'); expect(count).toBe(64); }
  finally { s.stop(true); }
});

test('delayed headers and stalled body cancelled under finite deadline with partial raw retained', async () => {
  const s = server(async () => { await Bun.sleep(200); return Response.json({ late: true }); });
  try { await expect(wireFor(s, AbortSignal.timeout(20)).call('/slow')).rejects.toThrow(); }
  finally { s.stop(true); }
  let cancelled = false; const evidence: string[] = [];
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from('partial')); }, cancel() { cancelled = true; } });
  await expect(readBounded(body, 100, AbortSignal.timeout(20), async (_, raw) => { evidence.push(Buffer.from(raw).toString()); }, 'body.raw')).rejects.toThrow();
  expect(cancelled).toBe(true); expect(evidence).toEqual(['partial']);
});

test('oversized body and unfinished SSE frame cancel source; malformed SSE never reaches causal state', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from('123456')); }, cancel() { cancelled = true; } });
  await expect(readBounded(body, 5, AbortSignal.timeout(100), noop, 'raw')).rejects.toThrow('byte budget');
  expect(cancelled).toBe(true);
  const stream = new Response('data: {bad}\n\n').body!;
  let visits = 0;
  await expect(consumeSSE(stream, AbortSignal.timeout(100), noop, () => { visits++; }, 'sse')).rejects.toThrow(); expect(visits).toBe(0);
});

test('SSE split CRLF frames retain bytes and late timestamps do not become ordering evidence', async () => {
  const chunks = [Buffer.from('data: {"type":"server.connected"}\r'), Buffer.from('\n\r\n')];
  const raw: Uint8Array[] = [];
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const bytes of chunks) c.enqueue(bytes); c.close(); } });
  let seen: any;
  await consumeSSE(stream, AbortSignal.timeout(100), async (_, bytes) => { raw.push(bytes); }, value => { seen = value; return true; }, 'sse');
  expect(seen).toEqual({ type: 'server.connected' }); expect(Buffer.concat(raw)).toEqual(Buffer.concat(chunks));
});

test('foreign endpoint and pre-cancelled mutation refused before forwarding', async () => {
  expect(() => new Wire('http://localhost:1234', async () => ({}), noop, AbortSignal.timeout(100))).toThrow();
  let calls = 0; const s = server(() => { calls++; return Response.json({}); });
  try {
    const abort = new AbortController(); abort.abort();
    await expect(wireFor(s, abort.signal).call('/prompt', 'POST', {})).rejects.toThrow();
    await expect(wireFor(s).call('http://127.0.0.1:1/foreign', 'POST', {})).rejects.toThrow();
    expect(calls).toBe(0);
  } finally { s.stop(true); }
});

test('model fixture refuses system-only/foreign marker before any tools or reply decision', async () => {
  const fixture = new CausalModel('/TEST-fixture', 'seed', 'output', 'shell', 'token', 'expected-marker', new Evidence('/unused', noop), AbortSignal.timeout(1000));
  // Independent public HTTP boundary; recorder injected so no private source/capture needed.
  fixture.evidence.raw = noop;
  const response = await fixture.respond(new Request('http://127.0.0.1/v1/chat/completions', { method: 'POST',
    body: JSON.stringify({ model: 'q0-upstream', stream: true, messages: [{ role: 'system', content: 'expected-marker' }, { role: 'user', content: 'foreign' }] }) }));
  expect(response.status).toBe(400); expect(fixture.decisions).toEqual([]); expect(fixture.requests).toEqual([]);
});

test('controller pin refuses changed/producer-owned receipts and artifact source/archive mismatches', async () => {
  const dir = await testSpace('receipt');
  try {
    const path = join(dir, 'receipt.json'); await writeFile(path, '{"independent":true}');
    const file = { path, sha256: sha('{"independent":true}') };
    expect(await pinned(file)).toEqual({ independent: true });
    await expect(pinned(file, [dir])).rejects.toThrow();
    await expect(pinned({ ...file, sha256: '0'.repeat(64) })).rejects.toThrow();
    expect(() => bindArtifact({ binary: 'x', sha256: 'a', generation: 'v2', version: '2.0.0', packages: [] }, { binarySha256: 'b' })).toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('fresh TEST sandbox refuses historical roots; cleanup stops only exact owned birth, preserves peer', async () => {
  const parent = await testSpace('unit');
  const root = join(parent, 'TEST-s1a-' + crypto.randomUUID()), evidence = root + '-evidence';
  const s = await Sandbox.create(root, evidence, 'S1a-unit');
  const owned = Bun.spawn(['/bin/sleep', '20'], { cwd: root, env: s.env() });
  const peer = Bun.spawn(['/bin/sleep', '20'], { cwd: root, env: s.env() });
  const birth = await processBirth(owned.pid), peerBirth = await processBirth(peer.pid);
  try {
    await expect(Sandbox.create(root, evidence, 'overwrite')).rejects.toThrow('existing');
    const changed = new OwnedProcessTree(peer.pid, { ...peerBirth, value: 'foreign-birth' });
    expect((await changed.stop())[0]!.result).toBe('absent-or-changed');
    const tree = new OwnedProcessTree(owned.pid, birth); tree.start(); await tree.stop();
    expect(await owned.exited).not.toBe(0); expect(peer.exitCode).toBeNull();
    expect(await processBirth(peer.pid)).toEqual(peerBirth);
  } finally {
    await new OwnedProcessTree(peer.pid, peerBirth).stop(); await peer.exited;
    await new OwnedProcessTree(owned.pid, birth).stop();
    await rm(root, { recursive: true, force: true }); await rm(evidence, { recursive: true, force: true }); await rm(parent, { recursive: true, force: true });
  }
});

for (const phase of ['before-forward', 'after-response'] as const) {
  test(`loss boundary ${phase} forwards unchanged exactly once, retains native persistence/error witness and refuses duplicate caller`, async () => {
    const { LossBoundary } = await import('./loss');
    const evidence = new Evidence('/unused', noop); evidence.raw = noop;
    const incoming: any[] = [];
    const native = server(async r => { incoming.push({ method: r.method, path: new URL(r.url).pathname, body: await r.json() });
      return Response.json({ data: { id: 'ses_reserved' } }); });
    const boundary = new LossBoundary(wireFor(native), '/api/session', { id: 'ses_reserved' }, phase, evidence);
    const request = () => new Request('http://127.0.0.1:1234/loss/' + boundary.nonce, { method: 'POST', body: '{"id":"ses_reserved"}' });
    const response = await boundary.handle(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ observation: 'deliberately-suppressed', automaticMutationReplay: false });
    await boundary.stop();
    expect(boundary.witness).toEqual({ status: 200, value: { data: { id: 'ses_reserved' } } });
    expect(incoming).toEqual([{ method: 'POST', path: '/api/session', body: { id: 'ses_reserved' } }]);
    expect((await boundary.handle(request())).status).toBe(409); expect(incoming).toHaveLength(1);
  });
}

// A synced head alone cannot reconstruct pre-existing durable admission events.
// This public TCP contract goes red when log() omits the explicit replay cursor.
test('durable log replays existing admission and execution through the captured watermark', async () => {
  const historical = [event('session.inbox.enqueued', { inboxID: 'msg_existing', item: { type: 'user', payload: { text: 'retained' } } }, 'enqueued', 1),
    event('session.execution.started', {}, 'started', 2)];
  const synced = { type: 'log.synced', aggregateID: 'ses_test', seq: 2 };
  const native = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const query = new URL(request.url).searchParams;
    const rows = query.get('after') === '0' ? [...historical, synced] : [synced];
    return new Response(rows.map(row => 'data: ' + JSON.stringify(row) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
  } });
  try {
    const { log } = await import('./collect');
    const cut = await log(new Wire(`http://127.0.0.1:${native.port}`, async () => ({}), noop, AbortSignal.timeout(2000)), 'ses_test', '/TEST-project');
    expect(cut.events).toEqual(historical);
    expect(cut.synced).toEqual(synced);
  } finally { await native.stop(true); }
});

// Both qualified native V2 anchors emit these event-specific durable versions.
test('native instruction and tool-success v2 retain a cut while unsupported event versions fail closed', () => {
  const cut = new LogCut('ses_test', '/TEST-project');
  for (const [type, seq] of [['session.instructions.updated', 3], ['session.tool.success', 9]] as const) {
    const native = event(type, {}, type, seq); native.durable.version = 2;
    cut.accept(native);
  }
  expect(cut.events.map(e => [e.type, e.durable.version])).toEqual([['session.instructions.updated', 2], ['session.tool.success', 2]]);
  for (const [type, version] of [['session.instructions.updated', 3], ['session.tool.success', 3], ['session.execution.started', 2]] as const) {
    const unsupported = event(type, {}, type, 10); unsupported.durable.version = version;
    expect(() => new LogCut('ses_test', '/TEST-project').accept(unsupported)).toThrow('foreign/malformed');
  }
});
