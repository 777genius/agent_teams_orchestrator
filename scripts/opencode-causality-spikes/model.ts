import { ModelFixture } from '../opencode-generation-spikes/model';
import { Evidence, readBounded } from './wire';

// Same S3a-tested tool/stream/token protocol, with one additional user-origin gate.
// The fixture only decides read/write/shell/reply; native owns all effects and logs.
export class CausalModel extends ModelFixture {
  private requestIndex = 0;
  constructor(root: string, seed: string, output: string, shell: string, token: string,
    readonly marker: string, readonly evidence: Evidence, readonly signal: AbortSignal) {
    super(root, seed, output, shell, token);
  }
  override async respond(request: Request) {
    try {
      const clone = request.clone();
      const raw = await readBounded(clone.body, 4 * 1024 * 1024, this.signal, this.evidence.raw, `model-request-${this.requestIndex++}.raw`);
      const body = JSON.parse(raw.toString());
      if (!body.messages?.some((m: any) => m.role === 'user' &&
          (typeof m.content === 'string' ? m.content.includes(this.marker) : Array.isArray(m.content) && m.content.some((c: any) => c.type === 'text' && c.text?.includes(this.marker))))) {
        throw new Error('actual user marker absent; no model tool/reply decision');
      }
      return await super.respond(request);
    } catch (e) {
      this.failures.push(String(e));
      return Response.json({ error: { message: String(e), type: 'invalid_request_error' } }, { status: 400 });
    }
  }
}
