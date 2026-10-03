import { assertExternalDestination, assertTestProject } from './isolation';
import { afterAll, expect, test } from 'bun:test';
import { createServer, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boundedTransport, failureCandidate } from './bounded-transport';

await assertExternalDestination(process.env.S6_EVIDENCE_DIR!, process.env.S6_SOURCE_ROOT!);
await assertTestProject(process.env.S6_TEST_ROOT!, process.env.S6_SOURCE_ROOT!);
const referenceOnly = process.env.S6_REFERENCE_ONLY === '1';
const referenceRoot = join(process.env.S6_SOURCE_ROOT!, '.task-inputs/reference');
const { OpenCode: Current, ClientError: CurrentError } = await import(referenceOnly ?
  join(referenceRoot, 'opencode-client-2.0.21/package/dist/promise/index.js') : '@opencode/client');
const { OpenCode: Floor, ClientError: FloorError } = await import(referenceOnly ?
  join(referenceRoot, 'opencode-client-2.0.0/package/dist/promise/index.js') : '@opencode/client-v2-floor');

const root = process.env.S6_TEST_ROOT!;
const evidence = process.env.S6_EVIDENCE_DIR!;
const marker = JSON.parse(await readFile(join(root, '.test-project-owner.json'), 'utf8'));
if (marker.root !== process.cwd() || marker.task !== 'hosted-v1-opencode-dual-q0-client-20261001')
  throw new Error('Refusing non-TEST transport execution');
const results: unknown[] = [];
const fixtures: unknown[] = [];
const canary = 'TEST_CANARY_SECRET_f7d4c8';
const context = { operation: 'prompt' as const, mutation: true, requestId: 'req_test',
  commandId: 'cmd_test', hostInstanceId: 'host_test', sessionId: 'ses_test', nativeInputId: 'msg_test' };
let evidenceIndex = 0;
async function fixture(handler: (response: ServerResponse, requestBody: unknown) => void | Promise<void>) {
  const requests: { method?: string; path?: string; body: unknown }[] = [];
  const effectsFile = join(root, `transport-effects-${++evidenceIndex}.jsonl`);
  await writeFile(effectsFile, '');
  let effects = 0, closed = 0;
  const sockets = new Set<any>();
  const received = Promise.withResolvers<void>();
  const responseClosed = Promise.withResolvers<void>();
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    const parsed = body ? JSON.parse(body) : null;
    requests.push({ method: request.method, path: request.url, body: parsed });
    if (request.method === 'POST' && request.url?.endsWith('/prompt')) {
      effects++;
      await appendFile(effectsFile, JSON.stringify({ id: parsed.id, effect: effects }) + '\n');
    }
    response.on('close', () => { closed++; responseClosed.resolve(); });
    received.resolve();
    await handler(response, parsed);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'LANG', 'TZ', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'TMPDIR', 'TMP', 'TEMP'])
    if (process.env[key]) env[key] = process.env[key]!;
  const proxy = Bun.spawn(['/opt/nodejs/node-v24.21.0-linux-x64/bin/node', join(import.meta.dir, 'http-proxy.cjs'), String(address.port)],
    { cwd: root, env, stdout: 'pipe', stderr: 'pipe', stdin: 'pipe' });
  const ready = Promise.withResolvers<any>();
  const proxyClosed = Promise.withResolvers<void>();
  const observations: any[] = [];
  let proxyCloses = 0;
  const closeWaiters: Array<{ count: number; resolve: () => void }> = [];
  const observing = (async () => {
    let pending = '';
    const decoder = new TextDecoder();
    for await (const chunk of proxy.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const row = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1);
        observations.push(row);
        if (row.ready) ready.resolve(row);
        if (row.closed) {
          proxyCloses = row.closed; proxyClosed.resolve();
          for (let index = closeWaiters.length - 1; index >= 0; index--)
            if (proxyCloses >= closeWaiters[index].count) closeWaiters.splice(index, 1)[0].resolve();
        }
      }
    }
  })();
  void proxy.exited.then(code => { if (code) ready.reject(new Error('Independent proxy failed')); });
  const identity = await ready.promise;
  return { url: `http://127.0.0.1:${identity.port}`, requests, received: received.promise,
    responseClosed: proxyClosed.promise,
    whenClosed(count: number) { return proxyCloses >= count ? Promise.resolve() :
      new Promise<void>(resolve => closeWaiters.push({ count, resolve })); },
    counters: async () => ({ requests: requests.length, effects, closed, effectsFile,
      effectRows: (await readFile(effectsFile, 'utf8')).trim().split('\n').filter(Boolean).length }),
    async close() {
      proxy.stdin.write('close\n'); proxy.stdin.end();
      const exitCode = await proxy.exited;
      await observing;
      if (exitCode !== 0) throw new Error('Independent proxy cleanup failed');
      // A receipt emitted before destroyed handles close used to retain nonzero counts.
      // Exit alone misses that observable cleanup regression in the independent proxy.
      const cleanup = observations.at(-1);
      if (!cleanup?.cleanup || cleanup.sockets !== 0 || cleanup.upstreams !== 0)
        throw new Error('Independent proxy reported undrained handles');
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      const copyPath = join(evidence, `transport-effects-${evidenceIndex}-${address.port}.jsonl`);
      const bytes = await readFile(effectsFile);
      await writeFile(copyPath, bytes);
      fixtures.push({ port: address.port, pid: process.pid, requests, effects, closed,
        proxyIdentity: identity, proxyObservations: observations, proxyExitCode: exitCode,
        copiedEffectsFile: copyPath, effectsBytes: bytes.byteLength, serverClosed: true, socketsRemaining: sockets.size });
    },
  };
}
function json(response: ServerResponse, data: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(data));
}
async function closes(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([promise, new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owned HTTP request failed to close')), 1000);
    })]);
  } finally { clearTimeout(timer!); }
}
async function caught(action: Promise<unknown>) {
  try { await action; } catch (error) { return error; }
  throw new Error('Expected public client failure');
}
function recordTest(id: string, regression: string, action: () => Promise<unknown>, timeout = 15000) {
  test(id, async () => {
    const started = performance.now();
    try { const detail = await action(); results.push({ id, status: 'PASS', regression,
      existingCoverageGap: 'Existing V1 transport tests do not execute BOTH official V2 Promise packages at this public boundary.',
      packageMode: referenceOnly ? 'read-only official reference inputs; registry/install/alias NOT qualified' : 'installed official npm alias/current',
      elapsedMs: performance.now() - started, detail }); }
    catch (error) { results.push({ id, status: 'FAIL', regression, elapsedMs: performance.now() - started,
      error: error instanceof Error ? error.name : 'unknown' }); throw error; }
  }, timeout);
}
afterAll(async () => {
  await writeFile(join(evidence, 'case-results.json'), JSON.stringify(results, null, 2));
  await writeFile(join(evidence, 'transport-fixtures.json'), JSON.stringify(fixtures, null, 2));
});

for (const [dialect, API, ErrorClass] of [['current', Current, CurrentError], ['floor', Floor, FloorError]] as const) {
  const prompt = (client: any, signal?: AbortSignal) => client.session.prompt({ sessionID: 'ses_test',
    id: 'msg_test', text: 'TEST transport mutation', delivery: 'queue', resume: true }, { signal });
  async function writeChunk(response: ServerResponse, bytes: string | Buffer) {
    if (!response.write(bytes)) await new Promise<void>(resolve => response.once('drain', resolve));
  }
  async function padding(response: ServerResponse, count: number, progress: { bytes: number }) {
    const chunk = Buffer.alloc(65536, 120);
    while (count > 0) {
      const bytes = chunk.subarray(0, Math.min(count, chunk.length));
      await writeChunk(response, bytes); count -= bytes.length; progress.bytes += bytes.length;
    }
  }
  recordTest(`${dialect}/invalid-bound-config-no-request`, 'Invalid configuration or raised hard caps reaches the public SDK request boundary', async () => {
    const server = await fixture(res => json(res, { data: {} }));
    try {
      for (const options of [{ bodyBytes: 0 }, { bodyBytes: NaN }, { bodyBytes: Infinity },
        { bodyBytes: 8 * 1048576 + 1 }, { bodyBytes: 32 * 1048576 + 1, bodyKind: 'transcript' },
        { bodyBytes: 128 * 1048576 + 1, bodyKind: 'export' }, { bodyBytes: 1024, bodyKind: 'unrecognized' },
        { bodyBytes: 1024, frameBytes: 16 * 1048576 + 1 }, { bodyBytes: 1024, errorBodyBytes: 8 * 1048576 + 1 }]) {
        expect(() => boundedTransport({ deadlineMs: 1000, ...options } as any)).toThrow();
      }
      expect((await server.counters()).requests).toBe(0);
      return { rejectedConfigurations: 9, counters: await server.counters() };
    } finally { await server.close(); }
  });
  for (const [kind, cap] of [['metadata', 8 * 1048576], ['transcript', 32 * 1048576], ['export', 128 * 1048576]] as const) {
    recordTest(`${dialect}/full-${kind}-body-cap`, 'Reviewed operation cap is character/header based, inclusive boundary wrong, or export overrides metadata error cap', async () => {
      const outcomes = [];
      for (const over of [0, 1]) {
        const prefix = '{"data":{"padding":"', suffix = '"}}';
        const overhead = Buffer.byteLength(prefix + suffix);
        const progress = { bytes: 0 };
        const server = await fixture(async res => {
          res.writeHead(200, { 'content-type': 'application/json' });
          await writeChunk(res, prefix); progress.bytes += Buffer.byteLength(prefix);
          await padding(res, cap + over - overhead, progress);
          await writeChunk(res, suffix); progress.bytes += Buffer.byteLength(suffix); res.end();
        });
        const transport = boundedTransport({ deadlineMs: 30000, bodyBytes: cap, bodyKind: kind });
        try {
          const client: any = API.make({ baseUrl: server.url, fetch: transport.fetch });
          const action = kind === 'export' ? client.session.export({ sessionID: 'ses_test' }) :
            kind === 'transcript' ? client.message.list({ sessionID: 'ses_test', limit: 200 }) :
              client.session.get({ sessionID: 'ses_test' });
          if (!over) {
            const value = await action;
            expect((kind === 'transcript' ? value.data : value).padding.length).toBe(cap - overhead);
            expect(transport.trace.cause).toBeNull();
          } else {
            expect(await caught(action)).toBeInstanceOf(ErrorClass);
            expect(transport.trace.cause).toBe('body_limit');
          }
          expect(progress.bytes).toBe(cap + over);
          expect(transport.trace.bytes).toBe(cap + over);
          expect((await server.counters()).requests).toBe(1); expect((await server.counters()).effects).toBe(0);
          outcomes.push({ producerBytes: progress.bytes, cap, over, trace: transport.trace, counters: await server.counters() });
        } finally { await server.close(); }
      }
      return { outcomes, kind: 'full-size controlled JSON transport bytes; NOT native response schema/size qualification' };
    }, 60000);
  }
  recordTest(`${dialect}/export-declared-error-metadata-cap`, 'Export success allowance accidentally admits a declared error body beyond 8MiB', async () => {
    const progress = { bytes: 0 };
    const prefix = '{"_tag":"SessionNotFoundError","sessionID":"ses_test","message":"TEST","padding":"', suffix = '"}';
    const size = 8 * 1048576 + 1;
    const server = await fixture(async res => {
      res.writeHead(404, { 'content-type': 'application/json' });
      await writeChunk(res, prefix); progress.bytes += Buffer.byteLength(prefix);
      await padding(res, size - Buffer.byteLength(prefix + suffix), progress);
      await writeChunk(res, suffix); progress.bytes += Buffer.byteLength(suffix); res.end();
    });
    const transport = boundedTransport({ deadlineMs: 30000, bodyBytes: 128 * 1048576, bodyKind: 'export' });
    try {
      const error: any = await caught(API.make({ baseUrl: server.url, fetch: transport.fetch }).session.export({ sessionID: 'ses_test' }));
      expect(error).toBeInstanceOf(ErrorClass); expect(error.reason).toBe('Transport');
      expect(transport.trace.cause).toBe('body_limit'); expect(transport.trace.status).toBe(404);
      expect(transport.trace.bytes).toBe(size); expect(progress.bytes).toBe(size);
      return { trace: transport.trace, producerBytes: progress.bytes, counters: await server.counters() };
    } finally { await server.close(); }
  }, 40000);
  recordTest(`${dialect}/full-frame-and-long-sse`, '16MiB frame byte budget undercounts framing or a cumulative 128MiB limit cuts a legitimate SSE lifetime', async () => {
    const details = [];
    for (const [frameBytes, frames, cap] of [[16 * 1048576, 1, 16 * 1048576],
      [16 * 1048576 + 1, 1, 16 * 1048576], [1048576, 129, 1048576]] as const) {
      const progress = { bytes: 0 };
      const tail = '\ndata: {"type":"transport.fixture","data":{"complete":true}}\n\n';
      const server = await fixture(async res => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (let index = 0; index < frames; index++) {
          await writeChunk(res, ':'); progress.bytes++;
          await padding(res, frameBytes - Buffer.byteLength(':' + tail), progress);
          await writeChunk(res, tail); progress.bytes += Buffer.byteLength(tail);
        }
        res.end();
      });
      const transport = boundedTransport({ deadlineMs: 30000, bodyBytes: 8 * 1048576, frameBytes: cap });
      try {
        let observed = 0, error: unknown;
        try { for await (const event of API.make({ baseUrl: server.url, fetch: transport.fetch }).event.subscribe()) {
          expect(event.data.complete).toBe(true); observed++;
        } } catch (value) { error = value; }
        if (frameBytes > cap) {
          expect(error).toBeInstanceOf(ErrorClass); expect(transport.trace.cause).toBe('frame_limit'); expect(observed).toBe(0);
        } else {
          expect(error).toBeUndefined(); expect(observed).toBe(frames); expect(transport.trace.cause).toBeNull();
          expect(transport.trace.bytes).toBe(frameBytes * frames);
        }
        expect(progress.bytes).toBe(frameBytes * frames);
        expect(transport.trace.maxForwarded).toBeLessThanOrEqual(65536);
        details.push({ frameBytes, frames, cap, observed, producerBytes: progress.bytes,
          trace: transport.trace, counters: await server.counters() });
      } finally { await server.close(); }
    }
    return { details, kind: 'full-size authored transport framing and lifetime; NOT native event proof' };
  }, 90000);
  recordTest(`${dialect}/large-chunk-many-small-frames`, 'One large received chunk is forwarded unsplit and trips the SDK buffer guard despite valid small frames', async () => {
    const tail = '\ndata: {"type":"transport.fixture","data":{"complete":true}}\n\n';
    const frame = ':' + 'x'.repeat(8192 - Buffer.byteLength(':' + tail)) + tail;
    const frames = 2050;
    const wire = Buffer.from(frame.repeat(frames));
    const server = await fixture(res => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(wire); });
    let networkBytes = 0;
    const transport = boundedTransport({ deadlineMs: 15000, bodyBytes: 8 * 1048576, frameBytes: 8192,
      fetch: (async (input, init) => {
        const response = await fetch(input, init);
        const bytes = await response.arrayBuffer(); networkBytes = bytes.byteLength;
        // Controlled coalescing fault: bytes were requested/read from the independent
        // HTTP proxy. Re-expose them as one large chunk at the public fetch boundary.
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new Uint8Array(bytes)); controller.close();
        } }), { status: response.status, headers: response.headers });
      }) as typeof fetch });
    try {
      let observed = 0;
      for await (const event of API.make({ baseUrl: server.url, fetch: transport.fetch }).event.subscribe()) {
        expect(event.data.complete).toBe(true); observed++;
      }
      expect(observed).toBe(frames); expect(networkBytes).toBe(wire.byteLength);
      expect(transport.trace.maxReceived).toBeGreaterThan(16 * 1048576);
      expect(transport.trace.maxForwarded).toBe(65536); expect(transport.trace.cause).toBeNull();
      expect((await server.counters()).requests).toBe(1);
      return { observed, networkBytes, frameBytes: Buffer.byteLength(frame), trace: transport.trace,
        counters: await server.counters(), kind: 'controlled public-fetch coalescing of real HTTP bytes; NOT native events' };
    } finally { await server.close(); }
  }, 30000);
  recordTest(`${dialect}/public-prompt-wire`, 'Wrong Promise root, dropped caller ID or duplicate HTTP mutation', async () => {
    const server = await fixture((res, body: any) => json(res, { data: { id: body.id, type: 'user' } }));
    const transport = boundedTransport({ deadlineMs: 2000, bodyBytes: 1024 });
    try {
      const result = await prompt(API.make({ baseUrl: server.url, fetch: transport.fetch }));
      expect(result.id).toBe('msg_test');
      expect(server.requests).toEqual([{ method: 'POST', path: '/api/session/ses_test/prompt', body: {
        id: 'msg_test', text: 'TEST transport mutation', delivery: 'queue', resume: true } }]);
      const counters = await server.counters();
      expect(counters.effects).toBe(1); expect(counters.effectRows).toBe(1);
      expect(transport.trace.released).toBe(true);
      return { counters, trace: transport.trace };
    } finally { await server.close(); }
  });
  recordTest(`${dialect}/before-fetch-abort`, 'Already-aborted local mutation reaches HTTP or is mislabeled unknown', async () => {
    const server = await fixture(res => json(res, { data: {} }));
    const abort = new AbortController(); abort.abort();
    const transport = boundedTransport({ deadlineMs: 2000, bodyBytes: 1024, signal: abort.signal });
    try {
      const error = await caught(prompt(API.make({ baseUrl: server.url, fetch: transport.fetch })));
      expect(error).toBeInstanceOf(ErrorClass);
      const dto = failureCandidate(error, transport.trace, context);
      expect(dto.code).toBe('cancelled'); expect(dto.phase).toBe('before-send');
      expect(dto.mutationOutcome).toBe('not_submitted'); expect(transport.trace.sent).toBe(0);
      expect((await server.counters()).requests).toBe(0);
      return { dto, counters: await server.counters(), trace: transport.trace };
    } finally { await server.close(); }
  });
  recordTest(`${dialect}/sync-fetch-throw`, 'Synchronous fetch invocation incorrectly classified not_submitted', async () => {
    const transport = boundedTransport({ deadlineMs: 2000, bodyBytes: 1024,
      fetch: (() => { throw new Error(canary); }) as typeof fetch });
    const error = await caught(prompt(API.make({ baseUrl: 'http://127.0.0.1:1', fetch: transport.fetch })));
    expect(error).toBeInstanceOf(ErrorClass);
    const dto = failureCandidate(error, transport.trace, context);
    expect(dto.mutationOutcome).toBe('unknown'); expect(dto.clientReason).toBe('Transport');
    expect(JSON.stringify(dto)).not.toContain(canary);
    return { dto, trace: transport.trace, kind: 'injectable public fetch synchronous throw; no native claims' };
  });
  for (const stage of ['before-headers', 'after-headers', 'during-body'] as const) {
    recordTest(`${dialect}/abort-${stage}`, 'Abort after possible submission reported rejection/non-submission or resent', async () => {
      const server = await fixture(res => {
        if (stage !== 'before-headers') { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); }
        if (stage === 'during-body') res.write('{"data":');
      });
      const abort = new AbortController();
      let headersSeen = Promise.withResolvers<void>();
      const bodyConsumed = Promise.withResolvers<void>();
      const transport = boundedTransport({ deadlineMs: 2000, bodyBytes: 1024, signal: abort.signal,
        fetch: (async (input, init) => { const response = await fetch(input, init); headersSeen.resolve(); return response; }) as typeof fetch });
      try {
        const publicFetch = (async (input, init) => {
          const response = await transport.fetch(input, init);
          if (stage !== 'during-body') return response;
          const body = response.body!.pipeThrough(new TransformStream({ transform(chunk, controller) {
            controller.enqueue(chunk); bodyConsumed.resolve();
          } }));
          return new Response(body, { headers: response.headers, status: response.status });
        }) as typeof fetch;
        const pending = caught(prompt(API.make({ baseUrl: server.url, fetch: publicFetch })));
        await server.received;
        if (stage !== 'before-headers') await headersSeen.promise;
        if (stage === 'during-body') await bodyConsumed.promise;
        abort.abort();
        const error = await pending;
        const dto = failureCandidate(error, transport.trace, context);
        expect(error).toBeInstanceOf(ErrorClass); expect(dto.code).toBe('cancelled');
        expect(dto.mutationOutcome).toBe('unknown'); expect(dto.recovery).toBe('read_only_reconcile');
        expect(transport.trace.released).toBe(true);
        if (stage === 'during-body') expect(transport.trace.bytes).toBeGreaterThan(0);
        await closes(server.responseClosed);
        const counters = await server.counters();
        expect(counters.requests).toBe(1); expect(counters.effects).toBe(1); expect(counters.effectRows).toBe(1);
        return { counters, dto, trace: transport.trace };
      } finally { await server.close(); }
    });
  }
  recordTest(`${dialect}/deadline-200-stalled-body`, 'Timer cleared at 200 headers leaves actual SDK JSON read unbounded', async () => {
    const server = await fixture(res => { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); res.write('{"data":'); });
    const transport = boundedTransport({ deadlineMs: 250, bodyBytes: 1024 });
    const began = performance.now();
    try {
      const error = await caught(prompt(API.make({ baseUrl: server.url, fetch: transport.fetch })));
      const elapsedMs = performance.now() - began;
      const dto = failureCandidate(error, transport.trace, context);
      expect(transport.trace.headers).toBe(1); expect(transport.trace.bytes).toBeGreaterThan(0);
      expect(dto.code).toBe('timeout'); expect(dto.httpStatus).toBe(200); expect(dto.mutationOutcome).toBe('unknown');
      expect(elapsedMs).toBeLessThan(1500); expect(transport.trace.released).toBe(true);
      await closes(server.responseClosed);
      expect((await server.counters()).effects).toBe(1);
      return { elapsedMs, dto, counters: await server.counters(), trace: transport.trace };
    } finally { await server.close(); }
  });
  for (const encoding of ['missing-length', 'multibyte', 'gzip-short-wire-length', 'misleading-long-length'] as const) {
    recordTest(`${dialect}/actual-bytes-${encoding}`, 'Content-Length/compressed length or JS characters replaces consumed-byte limit', async () => {
      const text = JSON.stringify({ data: { text: encoding === 'multibyte' ? '猫'.repeat(80) : 'x'.repeat(240) } });
      const body = encoding === 'gzip-short-wire-length' ? gzipSync(text) : Buffer.from(text);
      const cap = 128;
      expect(body.byteLength < cap).toBe(encoding === 'gzip-short-wire-length');
      const server = await fixture(res => {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (encoding === 'gzip-short-wire-length') Object.assign(headers, { 'content-encoding': 'gzip', 'content-length': String(body.byteLength) });
        if (encoding === 'misleading-long-length') headers['content-length'] = '9999';
        res.writeHead(200, headers); res.write(body);
        if (encoding !== 'misleading-long-length') res.end();
      });
      const transport = boundedTransport({ deadlineMs: 2000, bodyBytes: cap });
      try {
        const error = await caught(prompt(API.make({ baseUrl: server.url, fetch: transport.fetch })));
        const dto = failureCandidate(error, transport.trace, context);
        expect(transport.trace.bytes).toBeGreaterThan(cap); expect(transport.trace.cause).toBe('body_limit');
        expect(dto.code).toBe('invalid_response'); expect(dto.mutationOutcome).toBe('unknown');
        expect((await server.counters()).effects).toBe(1);
        return { cap, wireBytes: body.byteLength, exposedDecodedBytes: transport.trace.bytes,
          dto, counters: await server.counters(), trace: transport.trace };
      } finally { await server.close(); }
    });
  }
  recordTest(`${dialect}/small-body-boundary`, 'Inclusive actual byte cap rejects a valid exact-size response or accepts cap+1', async () => {
    const body = JSON.stringify({ data: { text: '猫' } });
    const bytes = Buffer.byteLength(body);
    const details = [];
    for (const cap of [bytes, bytes - 1]) {
      const server = await fixture(res => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); });
      const transport = boundedTransport({ deadlineMs: 2000, bodyBytes: cap });
      try {
        const action = prompt(API.make({ baseUrl: server.url, fetch: transport.fetch }));
        if (cap === bytes) expect((await action).text).toBe('猫');
        else { await caught(action); expect(transport.trace.cause).toBe('body_limit'); }
        details.push({ cap, trace: transport.trace, counters: await server.counters() });
      } finally { await server.close(); }
    }
    return details;
  });
  for (const [status, body, reason, code] of [
    [403, '{}', 'UnexpectedStatus', 'invalid_response'], [429, '{}', 'UnexpectedStatus', 'rate_limited'],
    [500, '{}', 'UnexpectedStatus', 'service_unavailable'], [503, '{}', 'UnexpectedStatus', 'service_unavailable'],
    [200, '<bad>', 'MalformedResponse', 'invalid_response'], [200, '', 'MalformedResponse', 'invalid_response'],
  ] as const) {
    recordTest(`${dialect}/error-${status}-${reason}-${body.length}`, 'Official ClientError shape/status leaks raw detail or triggers mutation resend', async () => {
      const server = await fixture(res => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body); });
      const transport = boundedTransport({ deadlineMs: 2000, bodyBytes: 1024 });
      try {
        const error: any = await caught(prompt(API.make({ baseUrl: server.url, fetch: transport.fetch })));
        expect(error).toBeInstanceOf(ErrorClass); expect(error.reason).toBe(reason);
        const dto = failureCandidate(error, transport.trace, context);
        expect(dto.clientReason).toBe(reason); expect(dto.code).toBe(code); expect(dto.httpStatus).toBe(status);
        expect(dto.mutationOutcome).toBe('unknown'); expect((await server.counters()).requests).toBe(1);
        return { dto, counters: await server.counters(), trace: transport.trace };
      } finally { await server.close(); }
    });
  }
  recordTest(`${dialect}/unsupported-type-canary`, 'Official unsupported-content-type detail exported as diagnostic', async () => {
    const server = await fixture(res => { res.writeHead(200, { 'content-type': `text/${canary}` }); res.end(canary); });
    const transport = boundedTransport({ deadlineMs: 2000, bodyBytes: 1024 });
    try {
      const error: any = await caught(prompt(API.make({ baseUrl: server.url, fetch: transport.fetch })));
      expect(error).toBeInstanceOf(ErrorClass); expect(error.reason).toBe('UnsupportedContentType');
      const dto = failureCandidate(error, transport.trace, context);
      expect(JSON.stringify(dto)).not.toContain(canary); expect(dto.clientReason).toBe('UnsupportedContentType');
      expect(transport.trace.released).toBe(true);
      return { dto, trace: transport.trace, counters: await server.counters() };
    } finally { await server.close(); }
  });
  for (const [operation, tag, status, code] of [
    ['prompt', 'UnauthorizedError', 401, 'auth_required'], ['prompt', 'InvalidRequestError', 400, 'invalid_input'],
    ['prompt', 'SessionNotFoundError', 404, 'not_found'], ['prompt', 'ConflictError', 409, 'conflict'],
    ['permission', 'PermissionNotFoundError', 404, 'not_found'],
    ['permission', 'SessionNotFoundError', 404, 'not_found'],
    ['form', 'FormInvalidAnswerError', 400, 'invalid_input'], ['form', 'FormAlreadySettledError', 409, 'conflict'],
    ['form', 'FormNotFoundError', 404, 'not_found'], ['form', 'SessionNotFoundError', 404, 'not_found'],
    // At declared statuses Promise decoders throw JSON even when the route never declares
    // that tag. A tag known on another route must remain untrusted at this boundary.
    ['prompt', 'FormAlreadySettledError', 409, 'invalid_response'],
    ['permission', 'FormNotFoundError', 404, 'invalid_response'],
    ['prompt', 'UnreviewedSecretTag', 400, 'invalid_response'],
  ] as const) {
    recordTest(`${dialect}/declared-${operation}-${tag}`, 'Only instanceof Error handles current/floor, arbitrary _tag/cause/native data escapes DTO', async () => {
      const server = await fixture(res => json(res, { _tag: tag, message: canary,
        sessionID: 'ses_test', requestID: 'per_test', id: 'form_test',
        detail: canary, cause: canary, data: { message: canary, response: { body: canary } }, stack: canary }, status));
      const transport = boundedTransport({ deadlineMs: 2000, bodyBytes: 1024 });
      const client: any = API.make({ baseUrl: server.url, fetch: transport.fetch });
      try {
        const action = operation === 'prompt' ? prompt(client) : operation === 'permission' ?
          client.permission.reply({ sessionID: 'ses_test', requestID: 'per_test', reply: 'once', decision: 'once' }) :
          dialect === 'floor' ? client.form.reply({ sessionID: 'ses_test', formID: 'form_test', answer: {} }) :
            client.session.form.reply({ sessionID: 'ses_test', formID: 'form_test', answer: {} });
        const error: any = await caught(action);
        expect(error._tag).toBe(tag); expect(error instanceof Error).toBe(dialect === 'current');
        const dto = failureCandidate(error, transport.trace, { ...context, operation });
        expect(dto.code).toBe(code); expect(dto.nativeTag).toBe(code === 'invalid_response' ? null : tag);
        expect(dto.clientReason).toBeNull(); expect(dto.httpStatus).toBe(status); expect(dto.mutationOutcome).toBe('unknown');
        const serialized = JSON.stringify(dto);
        expect(serialized).not.toContain(canary); expect(Buffer.byteLength(serialized)).toBeLessThan(8192);
        expect(dto.sessionId).toBe('ses_test'); expect(dto.nativeInputId).toBe('msg_test');
        expect((await server.counters()).requests).toBe(1);
        return { dto, declaredShape: dialect === 'floor' ? 'parsed plain object' : 'Error with _tag',
          counters: await server.counters(), trace: transport.trace, kind: 'authored transport fault; NOT native pre-effect rejection proof' };
      } finally { await server.close(); }
    });
  }
  recordTest(`${dialect}/read-only-and-identity-bounds`, 'Read-only failures carry write outcome or arbitrary oversized authority copied to failure', async () => {
    const server = await fixture(res => json(res, { _tag: 'InvalidRequestError', message: canary }, 400));
    const transport = boundedTransport({ deadlineMs: 2000, bodyBytes: 1024 });
    try {
      const error = await caught(API.make({ baseUrl: server.url, fetch: transport.fetch }).session.get({ sessionID: 'ses_test' }));
      const dto = failureCandidate(error, transport.trace, { ...context, mutation: false,
        sessionId: 'x'.repeat(257), commandId: 'not/a/retained/id' });
      expect(dto.mutationOutcome).toBe('not_applicable'); expect(dto.sessionId).toBeNull(); expect(dto.commandId).toBeNull();
      expect((await server.counters()).effects).toBe(0);
      return { dto, counters: await server.counters() };
    } finally { await server.close(); }
  });
  recordTest(`${dialect}/frame-byte-boundary-cr-lf-crlf`, 'Blank CRLF scanner resets before LF and undercounts delimiters or UTF8 frame bytes', async () => {
    const details = [];
    for (const delimiter of ['\r', '\n', '\r\n']) {
      const wire = `data: ${JSON.stringify({ type: 'transport.fixture', data: { text: '猫🙂' } })}${delimiter}${delimiter}`;
      const size = Buffer.byteLength(wire);
      for (const cap of [size, size - 1]) {
        const server = await fixture(res => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(wire); });
        const transport = boundedTransport({ deadlineMs: 2000, bodyBytes: 128, frameBytes: cap });
        try {
          let count = 0, error: unknown;
          try { for await (const row of API.make({ baseUrl: server.url, fetch: transport.fetch }).event.subscribe()) count++; }
          catch (caughtError) { error = caughtError; }
          if (cap === size) { expect(error).toBeUndefined(); expect(count).toBe(1); }
          else { expect(error).toBeInstanceOf(ErrorClass); expect(transport.trace.cause).toBe('frame_limit'); expect(count).toBe(0); }
          details.push({ delimiter: JSON.stringify(delimiter), size, cap, count, trace: transport.trace, counters: await server.counters() });
        } finally { await server.close(); }
      }
    }
    return details;
  });
  recordTest(`${dialect}/sdk-lazy-cached-marker-overflow-peer`, 'Lazy subscription makes premature request, cached connected replays missed facts, or SDK lagging queue blocks peer', async () => {
    const upstreamReady = Promise.withResolvers<ServerResponse>();
    const server = await fixture(res => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
      upstreamReady.resolve(res);
    });
    const transport = boundedTransport({ deadlineMs: 5000, bodyBytes: 128, frameBytes: 256 });
    const client = API.make({ baseUrl: server.url, fetch: transport.fetch });
    const slowAbort = new AbortController();
    const slow = client.event.subscribe({ signal: slowAbort.signal })[Symbol.asyncIterator]();
    const fast = client.event.subscribe()[Symbol.asyncIterator]();
    // Authored RPC definition only exercises the real Promise event reader/filter.
    const rpc = (client as any).rpc({ id: 's6-contract', methods: {}, events: { pulse: {} } })
      .events.subscribe('pulse')[Symbol.asyncIterator]();
    expect((await server.counters()).requests).toBe(0);
    const slowFirst = slow.next(), fastFirst = fast.next(), rpcFirst = rpc.next();
    try {
      const response = await upstreamReady.promise;
      const emit = (row: unknown) => response.write('data: ' + JSON.stringify(row) + '\n\n');
      emit({ type: 'server.connected', data: {} });
      expect((await slowFirst).value.type).toBe('server.connected');
      expect((await fastFirst).value.type).toBe('server.connected');
      const received = Promise.withResolvers<void>();
      let progress = 0;
      const consuming = (async () => {
        for (;;) {
          const item = await fast.next();
          if (item.done) return;
          if (item.value.type === 'rpc.s6-contract.pulse') {
            progress++;
            if (item.value.data.index === 5000) received.resolve();
          }
        }
      })();
      // The late peer joins only after a public observer has consumed this missed fact.
      emit({ type: 'rpc.s6-contract.pulse', data: { index: 5000 } });
      await received.promise;
      expect((await rpcFirst).value.data.index).toBe(5000);
      let rpcProgress = 1;
      const rpcConsuming = (async () => {
        for (;;) { const row = await rpc.next(); if (row.done) return; rpcProgress++; }
      })();
      const late = client.event.subscribe()[Symbol.asyncIterator]();
      expect((await late.next()).value.type).toBe('server.connected');
      const lateNext = late.next();
      emit({ type: 'rpc.s6-contract.pulse', data: { index: -1 } });
      expect((await lateNext).value.data.index).toBe(-1);
      await late.return!();
      for (let index = 0; index <= 5000; index++) {
        if (!emit({ type: 'rpc.s6-contract.pulse', data: { index } }))
          await new Promise<void>(resolve => response.once('drain', resolve));
      }
      response.end();
      await Promise.all([consuming, rpcConsuming]);
      const overflow = await caught(slow.next());
      // Shared queue overflow is an ordinary SDK Error, not a fabricated ClientError.
      expect(overflow).toBeInstanceOf(Error);
      expect((overflow as Error).message).toContain('4096');
      expect(progress).toBe(5003);
      expect(rpcProgress).toBe(5003);
      expect((await server.counters()).requests).toBe(1);
      expect((await server.counters()).effects).toBe(0);
      expect(transport.trace.released).toBe(true);
      return { peerProgress: progress, rpcPeerProgress: rpcProgress, overflow: 'ordinary SDK Error after 4096 queued events',
        lazyRequests: 0, cachedConnectedWasNotReplay: true, counters: await server.counters(), trace: transport.trace,
        kind: 'public shared SDK/live/RPC readers using authored transport frames; NOT native RPC/event proof' };
    } finally { slowAbort.abort(); await fast.return!(); await rpc.return!(); await server.close(); }
  });
  recordTest(`${dialect}/sdk-eof-backlog-recreate-local-abort`, 'Clean EOF loses queued old facts, source cannot recreate, stale/local abort cancels a peer, or last subscriber fails disposal', async () => {
    const responses: ServerResponse[] = [];
    const secondReady = Promise.withResolvers<ServerResponse>();
    const server = await fixture(res => {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); responses.push(res);
      if (responses.length === 2) secondReady.resolve(res);
    });
    const traces: any[] = [];
    const expires = performance.now() + 5000;
    const client = API.make({ baseUrl: server.url, fetch: (async (input, init) => {
      const remaining = expires - performance.now();
      if (remaining <= 0) throw new Error('Expired TEST observation lifetime');
      const transport = boundedTransport({ deadlineMs: remaining, bodyBytes: 1024, frameBytes: 256 });
      traces.push(transport.trace); return transport.fetch(input, init);
    }) as typeof fetch });
    const oldAbort = new AbortController(), freshAbort = new AbortController();
    const old = client.event.subscribe({ signal: oldAbort.signal })[Symbol.asyncIterator]();
    const live = client.event.subscribe()[Symbol.asyncIterator]();
    const oldFirst = old.next(), liveFirst = live.next();
    const emit = (res: ServerResponse, row: unknown) => res.write('data: ' + JSON.stringify(row) + '\n\n');
    let fresh: any, peer: any;
    try {
      await server.received;
      emit(responses[0], { type: 'server.connected', data: { source: 1 } });
      await Promise.all([oldFirst, liveFirst]);
      emit(responses[0], { type: 'transport.fixture', data: { source: 1 } }); responses[0].end();
      expect((await live.next()).value.data.source).toBe(1); expect((await live.next()).done).toBe(true);
      // Actual SDK drains queued old business rows after source EOF. This is a gap fact,
      // not evidence for any app/native ready epoch; production must fence it separately.
      expect((await old.next()).value.data.source).toBe(1);
      fresh = client.event.subscribe({ signal: freshAbort.signal })[Symbol.asyncIterator]();
      const freshFirst = fresh.next();
      const second = await secondReady.promise;
      oldAbort.abort(); expect((await old.next()).done).toBe(true);
      emit(second, { type: 'server.connected', data: { source: 2 } });
      expect((await freshFirst).value.data.source).toBe(2);
      peer = client.event.subscribe()[Symbol.asyncIterator]();
      expect((await peer.next()).value.data.source).toBe(2);
      freshAbort.abort(); expect((await fresh.next()).done).toBe(true);
      const peerNext = peer.next(); emit(second, { type: 'transport.fixture', data: { source: 2 } });
      expect((await peerNext).value.data.source).toBe(2);
      expect((await server.counters()).requests).toBe(2);
      await peer.return(); await closes(server.whenClosed(2));
      expect(traces.every(trace => trace.released)).toBe(true);
      return { traces, sourceRequests: 2, oldBacklogAfterEof: true, localAbortPreservedNewPeer: true,
        counters: await server.counters(), kind: 'public SDK transport lifetime facts; native/readiness reconciliation NOT qualified' };
    } finally { oldAbort.abort(); freshAbort.abort(); await live.return!(); await fresh?.return(); await peer?.return(); await server.close(); }
  });
  for (const kind of ['malformed', 'truncated', 'split-crlf-utf8', 'many-small-frames', 'per-frame-overflow', 'sdk-too-large'] as const) {
    recordTest(`${dialect}/sse-${kind}`, 'SDK decode/per-frame bytes corrupted, cumulative cap applied or malformed/truncated stream called success', async () => {
      const frame = (text: string) => `data: ${JSON.stringify({ type: 'transport.fixture', data: { text } })}\r\n\r\n`;
      const valid = frame('猫🙂');
      const many = Array.from({ length: 300 }, () => valid).join('');
      const wire = kind === 'malformed' ? 'data: {bad}\n\n' : kind === 'truncated' ? 'data: {"type":' :
        kind === 'many-small-frames' ? many : kind === 'sdk-too-large' ? 'data: ' + 'x'.repeat(16 * 1024 * 1024 + 1) : valid;
      const wireBytes = Buffer.from(wire);
      const server = await fixture(async res => {
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
        if (kind === 'split-crlf-utf8') {
          // Flush each byte in separate event-loop turns; byte boundaries include UTF8 and CRLF.
          for (const byte of wireBytes) { res.write(Buffer.from([byte])); await new Promise(resolve => setImmediate(resolve)); }
          res.end();
        } else res.end(wireBytes);
      });
      const transport = boundedTransport({ deadlineMs: 3000, bodyBytes: 128,
        frameBytes: kind === 'per-frame-overflow' ? 40 : 256 });
      try {
        // Negative control: use the SDK's unmodified public fetch for its independent
        // 16MiB string guard. Do not raise the candidate's byte/frame cap to reach it.
        const client = API.make({ baseUrl: server.url, fetch: kind === 'sdk-too-large' ? fetch : transport.fetch });
        let count = 0, text: string | undefined, error: any;
        try { for await (const row of client.event.subscribe()) { count++; text = row.data?.text; } }
        catch (caughtError) { error = caughtError; }
        if (kind === 'split-crlf-utf8' || kind === 'many-small-frames') {
          expect(error).toBeUndefined(); expect(count).toBe(kind === 'many-small-frames' ? 300 : 1); expect(text).toBe('猫🙂');
          if (kind === 'many-small-frames') expect(transport.trace.bytes).toBeGreaterThan(128);
        } else {
          expect(error).toBeInstanceOf(ErrorClass);
          expect(error.reason).toBe(kind === 'per-frame-overflow' ? 'Transport' : kind === 'sdk-too-large' ? 'SseEventTooLarge' : 'MalformedResponse');
          const dto = failureCandidate(error, transport.trace, { ...context, mutation: false });
          expect(dto.code).toBe(kind === 'per-frame-overflow' || kind === 'sdk-too-large' ? 'observation_incomplete' : 'invalid_response');
          expect(JSON.stringify(dto)).not.toContain(canary);
        }
        expect(transport.trace.maxForwarded).toBeLessThanOrEqual(65536);
        if (kind !== 'sdk-too-large') expect(transport.trace.released).toBe(true);
        expect((await server.counters()).requests).toBe(1);
        return { count, clientReason: error?.reason ?? null, trace: transport.trace, counters: await server.counters(),
          kind: kind === 'sdk-too-large' ? 'unmodified SDK string-guard negative control; no candidate byte-limit claim' :
            'controlled transport SSE; synthetic frames are NOT native events' };
      } finally { await server.close(); }
    });
  }
}
