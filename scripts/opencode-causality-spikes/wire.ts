import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha } from '../opencode-generation-spikes/sandbox';

export class Missing extends Error {}
export class RequestFailure extends Error {}
export class RecordingFailure extends Error {}
export type RawReply = { status: number; headers: [string, string][]; bytes: Buffer; value: any };
export type Recorder = (name: string, bytes: Uint8Array) => Promise<void>;
export class Evidence {
  private serial = 0;
  constructor(readonly directory: string, readonly validate: () => Promise<void>) {}
  raw: Recorder = async (name, bytes) => {
    await this.validate();
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('invalid evidence name');
    await writeFile(join(this.directory, `${String(this.serial++).padStart(5, '0')}-${name}`), bytes, { flag: 'wx', mode: 0o600 });
  };
  json(name: string, value: unknown) { return this.raw(name, Buffer.from(JSON.stringify(value, null, 2) + '\n')); }
}
export async function readBounded(stream: ReadableStream<Uint8Array> | null, cap: number, signal: AbortSignal, record: Recorder, name: string) {
  if (!stream) { await record(name, Buffer.alloc(0)); return Buffer.alloc(0); }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      // Classify only transport rejection at the read boundary. Budget/schema and
      // recorder errors retain their types; abort reasons take precedence.
      let next: ReadableStreamReadResult<Uint8Array>;
      try { next = await reader.read(); }
      catch (cause) { signal.throwIfAborted(); throw new RequestFailure('native request failed', { cause }); }
      signal.throwIfAborted();
      if (next.done) break;
      chunks.push(next.value); bytes += next.value.length;
      if (bytes > cap) throw new Missing('body byte budget exceeded');
    }
    return Buffer.concat(chunks);
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {}); reader.releaseLock();
    await record(name, Buffer.concat(chunks));
  }
}
// Mutations use a fresh Bun connection to prevent pooled-reset transport replay.
// Response loss retains the reply witness; submission remains unknown, never retried.
export class Wire {
  readonly calls: any[] = [];
  constructor(readonly base: string, readonly headers: (u: URL) => Promise<Record<string, string>>,
    readonly record: Recorder, readonly signal: AbortSignal, readonly transport: typeof fetch = fetch) {
    const u = new URL(base);
    if (u.origin !== base || u.hostname !== '127.0.0.1' || u.protocol !== 'http:' || !u.port || u.username || u.password) throw new Error('foreign endpoint');
  }
  private save: Recorder = async (name, bytes) => {
    try { await this.record(name, bytes); }
    catch (cause) { throw new RecordingFailure('wire recorder failed', { cause }); }
  };
  async open(path: string, method = 'GET', body?: unknown, requestSignal = this.signal) {
    const signal = requestSignal === this.signal ? this.signal : AbortSignal.any([this.signal, requestSignal]);
    signal.throwIfAborted();
    const url = new URL(path, this.base);
    if (url.origin !== this.base || url.username || url.password) throw new Error('foreign request');
    if (this.calls.length >= 160) throw new Missing('request budget');
    const headers = await this.headers(url);
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const n = this.calls.length;
    const call = { index: n, path, method, body, bodySha256: raw === undefined ? null : sha(raw), sent: false };
    this.calls.push(call);
    await this.save(`request-${n}.json`, Buffer.from(JSON.stringify(call)));
    signal.throwIfAborted(); call.sent = true;
    // Bun 1.3.11 can replay a mutation after a pooled connection reset.
    // Disable pooling per mutation; leave read-only readiness pooling unchanged.
    // redirect:error separately prevents redirected mutation replay.
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
    let reply: Response;
    try { reply = await this.transport(url, { method, headers: { ...headers, ...(raw === undefined ? {} : { 'content-type': 'application/json' }) },
      body: raw, signal, redirect: 'error', ...(mutation ? { keepalive: false } : {}) });
    } catch (cause) { signal.throwIfAborted(); throw new RequestFailure('native request failed', { cause }); }
    try {
      signal.throwIfAborted();
      await this.save(`headers-${n}.json`, Buffer.from(JSON.stringify({ status: reply.status, headers: [...reply.headers] })));
      signal.throwIfAborted();
      return { reply, n, signal };
    } catch (e) {
      await reply.body?.cancel().catch(() => {});
      throw e;
    }
  }
  async stream(path: string) {
    const opened = await this.open(path);
    if (opened.reply.status !== 200 || !opened.reply.body) {
      await opened.reply.body?.cancel().catch(() => {});
      throw new Missing('global stream unavailable');
    }
    return { ...opened, body: opened.reply.body };
  }
  async call(path: string, method = 'GET', body?: unknown, loss = false, requestSignal = this.signal): Promise<RawReply> {
    const { reply, n, signal } = await this.open(path, method, body, requestSignal);
    const bytes = await readBounded(reply.body, 8 * 1024 * 1024, signal, this.save, `response-${n}.raw`);
    if (loss) throw new Missing(`simulated response loss AFTER forwarding once; witness response-${n}.raw status=${reply.status}`);
    let value: any;
    try { value = bytes.length ? JSON.parse(bytes.toString()) : null; } catch { throw new Missing('non-JSON native response (raw preserved)'); }
    return { status: reply.status, headers: [...reply.headers], bytes, value };
  }
}
