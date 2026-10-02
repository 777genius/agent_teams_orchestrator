import { readFile, readlink } from 'node:fs/promises';
import { Sandbox, processBirth, OwnedProcessTree, sha, boundedText } from '../opencode-generation-spikes/sandbox';
import { OwnedEndpoint } from '../opencode-generation-spikes/auth';
import { NativeArtifact } from '../opencode-generation-spikes/artifacts';
import { Evidence, Wire, Missing, RequestFailure, RecordingFailure } from './wire';
import { Selection } from './contracts';

// S0/start/stop's existing authentication and process ownership are reused read-only.
// A small separate launcher exposes raw HTTP/SSE; the S0 requester drops raw 4xx.
export async function host(sandbox: Sandbox, artifact: NativeArtifact, selected: Selection, evidence: Evidence, signal: AbortSignal, observeWire?: (wire: Wire) => void) {
  await sandbox.validate(); await sandbox.path(artifact.binary);
  if (sha(await readFile(artifact.binary)) !== artifact.sha256) throw new Error('binary changed before spawn');
  const port = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('TEST reserved') });
  const base = `http://127.0.0.1:${port.port}`; const selectedPort = port.port; port.stop(true);
  const proc = Bun.spawn([artifact.binary, 'serve', '--hostname', '127.0.0.1', '--port', String(selectedPort)], {
    cwd: sandbox.root, env: { ...sandbox.env(), TEST_Q0_MODEL_API_KEY: 'TEST-DUMMY-KEY' }, stdout: 'pipe', stderr: 'pipe',
  });
  let birth: Awaited<ReturnType<typeof processBirth>> | undefined;
  let tree: OwnedProcessTree | undefined, owner: OwnedEndpoint | undefined;
  let stdout: Promise<string> | undefined, stderr: Promise<string> | undefined;
  let captureError: unknown, stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const errors: string[] = [];
    let cleanup: unknown, drained = false;
    try {
      owner?.retire();
      try {
        if (birth) {
          // Even ownership construction/start failure retains the exact birth token.
          cleanup = await (tree ?? new OwnedProcessTree(proc.pid, birth)).stop();
        } else {
          // Only the intrinsic handle returned by this spawn is authority pre-birth.
          proc.kill('SIGKILL');
          cleanup = { authority: 'fresh-subprocess-handle', signal: 'SIGKILL' };
        }
      } catch (e) { errors.push('termination: ' + String(e)); }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([proc.exited, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('owned subprocess drain timeout')), 10000);
        })]);
        drained = true;
      } catch (e) { errors.push('drain: ' + String(e)); }
      finally { clearTimeout(timer); }
      // Failed setup may never have attached either capture; close those pipes too.
      for (const [name, stream, capture] of [
        ['stdout', proc.stdout, stdout], ['stderr', proc.stderr, stderr],
      ] as const) {
        try {
          if (capture && drained) {
            const text = await capture;
            await evidence.raw('host-' + name + '.raw', Buffer.from(owner!.scrub(text)));
          } else if (!stream.locked) await stream.cancel();
        } catch (e) { errors.push(name + ': ' + String(e)); }
      }
      await evidence.json('host-cleanup.json', { pid: proc.pid, birth: birth ?? null,
        cleanup, drained, exitCode: proc.exitCode, errors });
      if (errors.length) throw new Error('host cleanup incomplete: ' + errors.join('; '));
    } finally { owner?.revoke(); }
  };
  try {
    birth = await processBirth(proc.pid);
    tree = new OwnedProcessTree(proc.pid, birth); tree.start();
    owner = new OwnedEndpoint(sandbox, base, proc.pid, birth);
    stdout = owner.stdout(proc.stdout); stdout.catch(e => { captureError = e; });
    stderr = boundedText(proc.stderr); stderr.catch(e => { captureError = e; });
    const wire = new Wire(base, u => owner!.headers(u), evidence.raw, signal);
    observeWire?.(wire);
    let identity: any;
    const path = selected.generation === 'v1' ? '/global/health' : selected.version === '2.0.0' ? '/api/health' : '/api/info';
    for (let i = 0; i < 40; i++) {
      signal.throwIfAborted(); if (captureError) throw captureError;
      if (proc.exitCode !== null) throw new Missing('native exited before readiness');
      const attempt = new AbortController();
      const timer = setTimeout(() => attempt.abort(), 500);
      const requestSignal = AbortSignal.any([signal, attempt.signal]);
      let failure: string | undefined, status: number | undefined;
      try {
        const reply = await wire.call(path, 'GET', undefined, false, requestSignal);
        if (reply.status === 200) { identity = reply.value; break; }
        status = reply.status; failure = 'http-status';
      } catch (e) {
        signal.throwIfAborted();
        if (e instanceof RecordingFailure) throw e;
        if (attempt.signal.aborted) failure = 'attempt-timeout';
        else if (e instanceof RequestFailure) failure = 'request-failed';
        else if (e instanceof Missing) failure = 'invalid-response';
        else throw e;
      } finally { clearTimeout(timer); }
      // Bounded enums and fixed paths only: never exception text, URLs or credentials.
      await evidence.json(`readiness-${i}.json`, { attempt: i, path, failure, status, timeoutMs: 500 });
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(pause); reject(signal.reason); };
        const pause = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 100);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    signal.throwIfAborted();
    if (identity === undefined) throw new Missing('native readiness exhausted (bounded read-only attempts)');
    if (identity?.version !== selected.version || identity?.healthy === false ||
        (selected.generation === 'v2' && identity.pid !== proc.pid) ||
        await readlink(`/proc/${proc.pid}/exe`) !== artifact.binary ||
        sha(await readFile(`/proc/${proc.pid}/exe`)) !== artifact.sha256 ||
        JSON.stringify(await processBirth(proc.pid)) !== JSON.stringify(birth)) throw new Error('live native identity mismatch');
    const location = await wire.call(selected.generation === 'v1' ? '/path' : '/api/location');
    if (location.status !== 200 || location.value.directory !== sandbox.root) throw new Error('native location mismatch');
    await evidence.json('authority.json', { identity, location: location.value, pid: proc.pid, birth, base, artifact });
    return { wire, stop };
  } catch (e) {
    try { await stop(); } catch (cleanup) { throw new AggregateError([e, cleanup], String(e)); }
    throw e;
  }
}
