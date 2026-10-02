import { Wire, Evidence, Missing, readBounded } from './wire';

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
    return new Response(new ReadableStream({ start(controller) {
      controller.error(new Missing('selected native response channel dropped'));
    } }), { headers: { 'content-type': 'application/json' } });
  }
  handle = async (request: Request) => {
    if (new URL(request.url).pathname !== '/loss/' + this.nonce || request.method !== 'POST') return new Response('unselected request', { status: 404 });
    if (this.accepted) return new Response('one-forward budget exhausted', { status: 409 });
    this.accepted = true;
    const raw = await readBounded(request.body, 4 * 1024 * 1024, this.native.signal, this.evidence.raw, 'loss-caller-request.raw');
    if (raw.toString() !== JSON.stringify(this.body)) throw new Error('loss boundary body differs from saved native mutation');
    await this.evidence.json('loss-channel.json', { phase: this.phase, nativePath: this.path, mutationCount: 1 });
    const forward = async () => {
      const reply = await this.native.call(this.path, 'POST', this.body);
      this.witness = { status: reply.status, value: reply.value };
      await this.evidence.json('loss-native-witness.json', { ...this.witness, nativePath: this.path, forwardedExactlyOnce: true });
    };
    if (this.phase === 'before-forward') {
      // The downstream body is permanently errored before any upstream fetch.
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
    let lost = false;
    try {
      const response = await fetch(`http://127.0.0.1:${this.server.port}/loss/${this.nonce}`, {
        method: 'POST', body: JSON.stringify(this.body), signal: this.native.signal, redirect: 'error',
      });
      // Bun may represent an errored response stream as a proxy 500 or connection
      // loss. Neither delivers the original native reply; record the actual form.
      lost = response.status >= 500;
      await this.evidence.json('loss-downstream-status.json', { status: response.status });
      await readBounded(response.body, 8 * 1024 * 1024, this.native.signal, this.evidence.raw, 'loss-downstream-response.raw');
    } catch (error) {
      lost = true;
      await this.evidence.json('loss-observer.json', { error: String(error), automaticMutationReplay: false });
    }
    if (!lost) throw new Error('response loss not observed');
    await this.forwarded; // readback follows the native exactly-once forwarding witness
    if (!this.witness) throw new Missing('native forwarding witness missing');
  }
  async stop() {
    try { await this.forwarded; } finally { this.server?.stop(true); this.server = undefined; }
  }
}
