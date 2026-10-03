// TEST-only candidate. Native qualification must precede any production implementation.
export type StopCause = 'timeout' | 'cancelled' | 'body_limit' | 'frame_limit' | null;
export type Trace = { sent: number; headers: number; bytes: number; status: number | null;
  cause: StopCause; released: boolean; maxReceived: number; maxForwarded: number };
const hardBodyBytes = { metadata: 8 * 1048576, transcript: 32 * 1048576, export: 128 * 1048576 };
export function boundedTransport(options: {
  deadlineMs: number; bodyBytes: number; frameBytes?: number; signal?: AbortSignal;
  fetch?: typeof fetch; bodyKind?: keyof typeof hardBodyBytes; errorBodyBytes?: number;
}) {
  if (!Object.hasOwn(hardBodyBytes, options.bodyKind ?? 'metadata')) throw new Error('Unknown TEST body family');
  for (const value of [options.deadlineMs, options.bodyBytes, options.frameBytes ?? 1, options.errorBodyBytes ?? 8 * 1048576])
    if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid TEST bound');
  if (options.bodyBytes > hardBodyBytes[options.bodyKind ?? 'metadata'] ||
      (options.frameBytes ?? 1) > 16 * 1048576 || (options.errorBodyBytes ?? 8 * 1048576) > 8 * 1048576)
    throw new Error('TEST override cannot raise reviewed hard cap');
  const trace: Trace = { sent: 0, headers: 0, bytes: 0, status: null,
    cause: null, released: false, maxReceived: 0, maxForwarded: 0 };
  const expires = performance.now() + options.deadlineMs;
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners: Array<[AbortSignal, () => void]> = [];
  function release() {
    if (trace.released) return;
    trace.released = true;
    clearTimeout(timer);
    for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
  }
  function stop(cause: Exclude<StopCause, null>) {
    if (trace.cause || trace.released) return;
    trace.cause = cause;
    controller.abort(new Error(cause));
    streamController?.error(new Error(cause));
    void reader?.cancel().then(() => { try { reader?.releaseLock(); } catch {} }).catch(() => {});
    release();
  }
  function link(signal?: AbortSignal | null) {
    if (!signal) return;
    if (signal.aborted) { stop('cancelled'); return; }
    const listener = () => stop('cancelled');
    listeners.push([signal, listener]);
    signal.addEventListener('abort', listener, { once: true });
  }
  const ownedFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    link(options.signal);
    link(init?.signal);
    if (!trace.cause && expires <= performance.now()) stop('timeout');
    if (trace.cause) throw new Error(trace.cause);
    timer = setTimeout(() => stop('timeout'), Math.max(1, expires - performance.now()));
    // Invocation is the conservative submission boundary, even for synchronous throws.
    trace.sent++;
    let response: Response;
    try { response = await (options.fetch ?? globalThis.fetch)(input, { ...init, signal: controller.signal }); }
    catch (error) { release(); throw error; }
    trace.headers++;
    trace.status = response.status;
    if (!response.body) { release(); return response; }
    reader = response.body.getReader();
    const sse = response.ok && response.headers.get('content-type')?.startsWith('text/event-stream');
    const bodyCap = response.ok ? options.bodyBytes : Math.min(options.bodyBytes, options.errorBodyBytes ?? 8 * 1048576);
    let pending: Uint8Array | undefined;
    let offset = 0;
    // CRLF counts as one line end; blank lines terminate blocks, across arbitrary chunks.
    let frame = 0, lineBytes = 0, previousCR = false, blankCR = false;
    function countByte() {
      frame++;
      if (frame > (options.frameBytes ?? 16 * 1048576)) { stop('frame_limit'); throw new Error('frame_limit'); }
    }
    function scan(bytes: Uint8Array) {
      for (const byte of bytes) {
        if (previousCR) {
          previousCR = false;
          if (byte === 10) {
            countByte();
            if (blankCR) frame = 0;
            blankCR = false;
            continue;
          }
          if (blankCR) frame = 0;
          blankCR = false;
        }
        countByte();
        if (byte === 13) {
          previousCR = true; blankCR = lineBytes === 0; lineBytes = 0;
        } else if (byte === 10) {
          if (lineBytes === 0) frame = 0;
          lineBytes = 0;
        } else lineBytes++;
      }
    }
    const body = new ReadableStream<Uint8Array>({
      start(c) { streamController = c; if (controller.signal.aborted) c.error(new Error(trace.cause ?? 'cancelled')); },
      async pull(c) {
        try {
          if (controller.signal.aborted) throw new Error(trace.cause ?? 'cancelled');
          if (!pending) {
            const next = await reader!.read();
            if (controller.signal.aborted) throw new Error(trace.cause ?? 'cancelled');
            if (next.done) { release(); reader!.releaseLock(); c.close(); return; }
            pending = next.value; offset = 0;
            trace.maxReceived = Math.max(trace.maxReceived, pending.byteLength);
            trace.bytes += pending.byteLength;
            if (!sse && trace.bytes > bodyCap) { stop('body_limit'); return; }
          }
          const slice = pending.subarray(offset, offset + 64 * 1024);
          if (sse) scan(slice);
          offset += slice.byteLength;
          if (offset === pending.byteLength) pending = undefined;
          trace.maxForwarded = Math.max(trace.maxForwarded, slice.byteLength);
          c.enqueue(slice);
        } catch (error) {
          if (!trace.released) {
            c.error(error); release();
            void reader!.cancel().then(() => { try { reader!.releaseLock(); } catch {} }).catch(() => {});
          }
        }
      },
      async cancel() { controller.abort(); release(); await reader!.cancel().catch(() => {}); reader!.releaseLock(); },
    }, { highWaterMark: 0 });
    if (controller.signal.aborted) { stop(trace.cause ?? 'cancelled'); await reader.cancel().catch(() => {}); }
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  return { fetch: ownedFetch as typeof fetch, trace };
}

// Closed TEST operation registry, selected from inspected generated Promise/Protocol routes.
const tags: Record<string, Record<string, string>> = {
  prompt: { InvalidRequestError: 'invalid_input', UnauthorizedError: 'auth_required',
    SessionNotFoundError: 'not_found', ConflictError: 'conflict' },
  permission: { InvalidRequestError: 'invalid_input', UnauthorizedError: 'auth_required',
    PermissionNotFoundError: 'not_found', SessionNotFoundError: 'not_found' },
  form: { InvalidRequestError: 'invalid_input', UnauthorizedError: 'auth_required',
    SessionNotFoundError: 'not_found', FormNotFoundError: 'not_found',
    FormInvalidAnswerError: 'invalid_input', FormAlreadySettledError: 'conflict' },
};
const reasons = new Set(['Transport', 'UnexpectedStatus', 'UnsupportedContentType', 'MalformedResponse', 'SseEventTooLarge']);
export function failureCandidate(error: unknown, trace: Trace, context: {
  operation: 'prompt' | 'permission' | 'form'; mutation: boolean; requestId: string;
  commandId: string; hostInstanceId: string; sessionId: string; nativeInputId: string;
}) {
  const shape = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const reason = typeof shape.reason === 'string' && reasons.has(shape.reason) ? shape.reason : null;
  const nativeTag = typeof shape._tag === 'string' && Object.hasOwn(tags[context.operation], shape._tag) ? shape._tag : null;
  let code = nativeTag ? tags[context.operation][nativeTag] : 'invalid_response';
  if (reason === 'Transport') code = 'transport';
  if (reason === 'UnexpectedStatus') code = trace.status === 429 ? 'rate_limited' :
    trace.status && trace.status >= 500 ? 'service_unavailable' : 'invalid_response';
  if (reason === 'SseEventTooLarge' || trace.cause === 'frame_limit') code = 'observation_incomplete';
  if (trace.cause === 'body_limit') code = 'invalid_response';
  if (trace.cause === 'cancelled' || trace.cause === 'timeout') code = trace.cause;
  const outcome = !context.mutation ? 'not_applicable' : trace.sent ? 'unknown' : 'not_submitted';
  function identity(value: string) {
    // Context must be retained app authority, never copied from the error or HTTP response.
    return /^[a-zA-Z0-9_.:-]+$/.test(value) && new TextEncoder().encode(value).length <= 256 ? value : null;
  }
  return { schemaVersion: 1, code, operation: context.operation, generation: 'v2',
    phase: trace.sent ? 'request' : 'before-send', mutationOutcome: outcome,
    recovery: outcome === 'unknown' ? 'read_only_reconcile' : outcome === 'not_submitted' ? 'retry_before_submission' : 'none',
    nativeTag, clientReason: reason, httpStatus: trace.status, requestId: identity(context.requestId),
    commandId: identity(context.commandId), hostInstanceId: identity(context.hostInstanceId),
    sessionId: identity(context.sessionId), nativeInputId: identity(context.nativeInputId), receiptId: null,
    safeMessage: 'TEST transport qualification failure; inspect retained operation.' };
}
