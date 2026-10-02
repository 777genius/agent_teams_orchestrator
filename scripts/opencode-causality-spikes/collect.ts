import { Missing, Wire, Recorder } from './wire';
import { object } from './contracts';

// Preserve the actual SSE bytes before interpreting any data. No fake flattened rows.
export async function consumeSSE(stream: ReadableStream<Uint8Array>, signal: AbortSignal, record: Recorder,
  visit: (value: any) => boolean | void, prefix: string) {
  const reader = stream.getReader(), decoder = new TextDecoder();
  let pending = '', bytes = 0, frames = 0, chunks = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted(); const next = await reader.read(); signal.throwIfAborted();
      if (next.done) break;
      await record(`${prefix}-chunk-${chunks++}.raw`, next.value);
      bytes += next.value.length;
      if (bytes > 16 * 1024 * 1024 || chunks > 4096) throw new Missing('stream byte/chunk budget');
      pending += decoder.decode(next.value, { stream: true });
      // Accept LF and CRLF without altering persisted bytes.
      pending = pending.replace(/\r\n/g, '\n');
      let end: number;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, end); pending = pending.slice(end + 2);
        if (++frames > 4096 || Buffer.byteLength(frame) > 1024 * 1024) throw new Missing('SSE frame budget');
        const data = frame.split('\n').filter(x => x.startsWith('data:')).map(x => x.slice(5).replace(/^ /, '')).join('\n');
        if (data && visit(JSON.parse(data)) === true) return;
      }
      if (Buffer.byteLength(pending) > 1024 * 1024) throw new Missing('unfinished SSE frame budget');
    }
    throw new Missing('stream ended before required boundary');
  } finally {
    signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
export class LogCut {
  readonly events: any[] = [];
  synced?: any;
  private ids = new Map<string, string>();
  private positions = new Map<string, string>();
  constructor(readonly sessionID: string, readonly directory: string) {}
  accept(value: any) {
    const v = object(value);
    if (v.type === 'log.synced') {
      if (v.aggregateID !== this.sessionID || ('seq' in v && !Number.isFinite(v.seq))) throw new Error('foreign/malformed synced');
      if (this.synced) throw new Error('duplicate synced');
      this.synced = v; return true; // absent seq is a valid empty captured watermark
    }
    if (typeof v.id !== 'string' || typeof v.type !== 'string' || !v.type.startsWith('session.') ||
      v.durable?.aggregateID !== this.sessionID || !Number.isFinite(v.durable?.seq) || (v.durable?.version !== 1 && !(v.durable?.version === 2 &&
        ['session.instructions.updated', 'session.tool.success'].includes(v.type))) ||
      v.data?.sessionID !== this.sessionID || (v.location && v.location.directory !== this.directory)) throw new Error('foreign/malformed durable event');
    const raw = JSON.stringify(v), prior = this.ids.get(v.id), position = String(v.durable.seq);
    if (prior && prior !== raw) throw new Error('conflicting duplicate event');
    if (this.positions.has(position) && this.positions.get(position) !== raw) throw new Error('conflicting sequence');
    if (!prior) { this.events.push(v); this.ids.set(v.id, raw); this.positions.set(position, raw); }
    return false;
  }
}
export async function log(wire: Wire, sessionID: string, directory: string) {
  const cut = new LogCut(sessionID, directory);
  const { reply, n } = await wire.open(`/api/experimental/session/${encodeURIComponent(sessionID)}/log?after=0&follow=false`);
  if (!reply.ok || !reply.body) {
    const { readBounded } = await import('./wire');
    await readBounded(reply.body, 8 * 1024 * 1024, wire.signal, wire.record, `log-error-${n}.raw`);
    throw new Missing(`native log HTTP ${reply.status}`);
  }
  await consumeSSE(reply.body, wire.signal, wire.record, v => cut.accept(v), `log-${n}`);
  return cut;
}
export async function transcript(wire: Wire, sessionID: string, generation: string) {
  const rows: any[] = [], pages: any[] = [], ids = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined, bytes = 0;
  for (let n = 0; n < 64; n++) {
    const path = generation === 'v1' ? `/session/${encodeURIComponent(sessionID)}/message` :
      `/api/session/${encodeURIComponent(sessionID)}/message?limit=100&${cursor === undefined ? 'order=asc' : 'cursor=' + encodeURIComponent(cursor)}`;
    const response = await wire.call(path); pages.push({ path, status: response.status, value: response.value });
    if (response.status !== 200) throw new Missing(`transcript HTTP ${response.status}`);
    bytes += response.bytes.length; if (bytes > 32 * 1024 * 1024) throw new Missing('transcript byte budget');
    const data = generation === 'v1' ? response.value : object(response.value).data;
    if (!Array.isArray(data) || data.length > 10000) throw new Missing('malformed transcript page');
    for (const row of data) {
      const id = generation === 'v1' ? row?.info?.id : row?.id;
      if (typeof id !== 'string' || ids.has(id)) throw new Missing('duplicate/malformed message boundary');
      ids.add(id); rows.push(row); // preserve every native union, including unknown variants
    }
    if (generation === 'v1') return { rows, pages, complete: true };
    const next = object(response.value).cursor?.next;
    if (data.length === 0) {
      if (next) throw new Missing('empty page with continuation');
      return { rows, pages, complete: true };
    }
    if (typeof next !== 'string' || !next || next.length > 8192 || cursors.has(next)) throw new Missing('incomplete/cyclic pagination');
    cursors.add(next); cursor = next; // cursor opaque; order never accompanies cursor
  }
  throw new Missing('page budget exhausted');
}
