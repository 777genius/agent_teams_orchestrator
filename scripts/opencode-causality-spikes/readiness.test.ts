import { test, expect } from 'bun:test';
import { join } from 'node:path';
for (const mode of ['headers', 'body', 'reset', 'abort', 'exhaust', 'identity', 'recorder']) {
  test(`native readiness ${mode}: dummy HTTP public host behavior and owned cleanup`, async () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'readiness.fixture.ts'), mode], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (mode === 'reset' && code === 0) {
      const observed = JSON.parse(stdout);
      expect(observed).toMatchObject({ mode: 'reset', health: 2, stops: 1, closed: 1, mutations: 0, partialBody: '{', drained: true, globalAborted: false });
      expect(observed.readiness).toHaveLength(1);
    }
    expect({ code, stdout: mode === 'reset' && code === 0 ? '' : stdout, stderr }).toEqual({ code: 0, stdout: '', stderr: '' });
  }, 10000);
}

test('readiness signal cancels body and preserves recorder failure without retry', async () => {
  const { Wire, RecordingFailure } = await import('./wire');
  for (const failRecord of [false, true]) {
    let cancelled = 0, sent = 0;
    const global = new AbortController(), attempt = new AbortController();
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from('{')); }, cancel() { cancelled++; } });
    const wire = new Wire('http://127.0.0.1:12345', async () => ({}), async name => {
      if (name.startsWith('response') && failRecord) throw Error('TEST-recorder');
    }, global.signal, (async () => { sent++; return new Response(body); }) as typeof fetch);
    const timer = setTimeout(() => attempt.abort(Error('TEST-attempt')), 25);
    let error: any;
    try { await wire.call('/global/health', 'GET', undefined, false, attempt.signal); } catch (e) { error = e; }
    finally { clearTimeout(timer); }
    expect(cancelled).toBe(1); expect(sent).toBe(1); expect(global.signal.aborted).toBe(false);
    if (failRecord) { expect(error instanceof RecordingFailure).toBe(true); expect(error.cause.message).toBe('TEST-recorder'); }
    else expect(error.message).toBe('TEST-attempt');
  }
});


test('body reset classification releases reader/listener, preserves partial witness and never replays mutation', async () => {
  const { Wire, RequestFailure, RecordingFailure, Missing, readBounded } = await import('./wire');
  for (const outcome of ['transport', 'recorder', 'global', 'attempt', 'budget', 'schema']) {
    const global = new AbortController(), attempt = new AbortController();
    let sent = 0, cancels = 0, released = 0, listeners = 0;
    const signal = global.signal;
    const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<typeof add>) => { listeners++; return add(...args); }) as typeof add;
    signal.removeEventListener = ((...args: Parameters<typeof remove>) => { listeners--; return remove(...args); }) as typeof remove;
    let reads = 0;
    const reset = Object.assign(Error('TEST-reset'), { code: 'ECONNRESET' });
    const stream = { getReader: () => ({
      read: async () => {
        if (reads++ === 0) return { done: false, value: Buffer.from('{') };
        if (outcome === 'schema') return { done: true };
        if (outcome === 'global') global.abort(Error('TEST-global'));
        if (outcome === 'attempt') attempt.abort(Error('TEST-attempt'));
        throw reset;
      },
      cancel: async () => { cancels++; }, releaseLock: () => { released++; },
    }) } as unknown as ReadableStream<Uint8Array>;
    let partial = '';
    const record = async (name: string, bytes: Uint8Array) => {
      if (name.startsWith('response')) { partial = Buffer.from(bytes).toString(); if (outcome === 'recorder') throw Error('TEST-disk'); }
    };
    const wire = new Wire('http://127.0.0.1:12345', async () => ({}), record, signal,
      (async () => { sent++; return { status: 200, headers: new Headers(), body: stream }; }) as typeof fetch);
    let error: any;
    try {
      if (outcome === 'budget') await readBounded(stream, 0, signal, record, 'response-budget.raw');
      else await wire.call('/mutation', 'POST', { TEST: true }, false, outcome === 'attempt' ? attempt.signal : signal);
    } catch (e) { error = e; }
    expect(partial).toBe('{'); expect(released).toBe(1); expect(listeners).toBe(0);
    expect(cancels).toBeGreaterThanOrEqual(1); expect(sent).toBe(outcome === 'budget' ? 0 : 1);
    if (outcome === 'transport') { expect(error instanceof RequestFailure).toBe(true); expect(error.cause).toBe(reset); }
    if (outcome === 'recorder') { expect(error instanceof RecordingFailure).toBe(true); expect(error.cause.message).toBe('TEST-disk'); }
    if (outcome === 'global' || outcome === 'attempt') expect(error.message).toBe('TEST-' + outcome);
    if (outcome === 'budget' || outcome === 'schema') expect(error instanceof Missing).toBe(true);
  }
});
