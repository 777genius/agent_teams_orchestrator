import { Wire, Evidence, Missing, RequestFailure, readBounded } from './wire';

// Transparent, one-mutation-only response-loss boundary. This is not a native
// emulator: the saved path/body is forwarded to the owned native Wire unchanged.
export class LossBoundary {
  private forwarded?: Promise<void>;
  private accepted = false;
  private server?: ReturnType<typeof Bun.serve>;
  readonly nonce = crypto.randomUUID();
  witness?: { status: number; value: any };
  constructor(readonly native: Wire, readonly path: string, readonly body: unknown,
    readonly phase: 'before-forward' | 'after-response', readonly evidence: Evidence) {}
  private failedResponse() {
    return Response.json({ observation: 'deliberately-suppressed', automaticMutationReplay: false }, {
      status: 503, headers: { 'x-test-observation': 'deliberately-suppressed' },
    });
  }
  handle = async (request: Request) => {
    if (new URL(request.url).pathname !== '/loss/' + this.nonce || request.method !== 'POST') return new Response('unselected request', { status: 404 });
    if (this.accepted) return new Response('one-forward budget exhausted', { status: 409 });
    this.accepted = true;
    const raw = await readBounded(request.body, 4 * 1024 * 1024, this.native.signal, this.evidence.raw, 'loss-caller-request.raw');
    if (raw.toString() !== JSON.stringify(this.body)) throw new Error('loss boundary body differs from saved native mutation');
    await this.evidence.json('loss-channel.json', { phase: this.phase, nativePath: this.path, mutationCount: 1,
      mechanism: 'deliberate-observer-loss-owned-503', trueTCPLossQualified: false, beforeEffectQualified: false });
    const forward = async () => {
      const reply = await this.native.call(this.path, 'POST', this.body);
      this.witness = { status: reply.status, value: reply.value };
      await this.evidence.json('loss-native-witness.json', { ...this.witness, nativePath: this.path, forwardedExactlyOnce: true });
    };
    if (this.phase === 'before-forward') {
      // Select suppression before forwarding; this does not qualify before-effect loss.
      const failed = this.failedResponse();
      this.forwarded = forward(); this.forwarded.catch(() => {});
      return failed;
    }
    this.forwarded = forward(); await this.forwarded;
    return this.failedResponse(); // native response witness captured before loss
  };
  start() {
    if (this.server) throw new Error('loss boundary already started');
    this.server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: this.handle });
  }
  async observe() {
    if (!this.server) throw new Error('loss boundary not listening');
    let lost = false, response: Response | undefined;
    try {
      response = await fetch(`http://127.0.0.1:${this.server.port}/loss/${this.nonce}`, {
        method: 'POST', body: JSON.stringify(this.body), signal: this.native.signal, redirect: 'error', keepalive: false,
      });
    } catch (error) {
      this.native.signal.throwIfAborted();
      lost = true;
      await this.evidence.json('loss-observer.json', { error: String(error), automaticMutationReplay: false });
    }
    if (response) {
      // The owned 503 is deliberate suppression; native admission remains unknown
      // until its independent witness and readback, even for native 204/null.
      lost = response.status >= 500;
      try {
        await this.evidence.json('loss-downstream-status.json', { status: response.status });
        await readBounded(response.body, 8 * 1024 * 1024, this.native.signal, this.evidence.raw, 'loss-downstream-response.raw');
      } catch (error) {
        this.native.signal.throwIfAborted();
        if (!(error instanceof RequestFailure)) throw error;
        lost = true;
        await this.evidence.json('loss-observer.json', { error: String(error), automaticMutationReplay: false });
      } finally { await response.body?.cancel().catch(() => {}); }
    }
    if (!lost) throw new Error('response loss not observed');
    await this.drain(); // readback follows the native exactly-once forwarding witness
    if (!this.witness) throw new Missing('native forwarding witness missing');
  }
  async stop() {
    try {
      if (this.forwarded) await this.drain();
    } finally { this.server?.stop(true); this.server = undefined; }
  }
  private async drain() {
    this.native.signal.throwIfAborted();
    let abort!: () => void;
    try {
      await Promise.race([this.forwarded, new Promise<never>((_, reject) => {
        abort = () => reject(this.native.signal.reason);
        this.native.signal.addEventListener('abort', abort, { once: true });
        if (this.native.signal.aborted) abort();
      })]);
    } finally { this.native.signal.removeEventListener('abort', abort); }
  }
}
