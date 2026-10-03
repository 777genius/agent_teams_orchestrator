import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Sandbox, sha, inventory } from '../opencode-generation-spikes/sandbox';
import { selectedModel } from '../opencode-generation-spikes/collections';
import { acquire } from '../opencode-generation-spikes/artifacts';
import { configFor } from '../opencode-generation-spikes/model';
import { parseNativeVersion, successfulHelp } from '../opencode-generation-spikes/version';
import { Selection, promptBody, REMAINING } from './contracts';
import { prerequisite, bindArtifact, anchor, PinFile } from './gate';
import { Evidence, Missing, Wire } from './wire';
import { consumeSSE, log, transcript, LogCut } from './collect';
import { facts } from './facts';
import { CausalModel } from './model';
import { host } from './host';
import { LossBoundary } from './loss';
import { admitRoots, preflightArtifact } from './preflight';

export type Options = Selection & {
  root: string; evidence: string; receipt: PinFile; acceptance: PinFile;
  bundle: string; binary: string; platformMetadataSha256: string;
};
const nativeID = (prefix: string) => prefix + '_' + Date.now().toString(16).padStart(12, '0') + '000' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
export async function measure(options: Options) {
  // Trust admission happens before creating roots, ports, native or model fixture.
  const trusted = await prerequisite(options, options.receipt, options.acceptance, [options.root, options.evidence]);
  await admitRoots(options, trusted);
  const checked = await preflightArtifact(options, trusted.subject);
  const s = await Sandbox.create(options.root, options.evidence, 'S1a-' + options.scenario);
  const evidence = new Evidence(s.evidence, () => s.validate());
  const signal = AbortSignal.timeout(90000), globalStop = new AbortController();
  const token = crypto.randomUUID(), marker = 'TEST-S1a-user:' + token;
  const callerID = nativeID('msg'), reservedSessionID = nativeID('ses');
  const saved = { ...options, trusted, callerID, reservedSessionID, marker, token, mutationReplay: false };
  await evidence.json('intent.json', saved); // IDs durably retained before any mutation
  let native: Awaited<ReturnType<typeof host>> | undefined, fixture: CausalModel | undefined;
  let startupWire: Wire | undefined;
  let loss: LossBoundary | undefined;
  let globalTask: Promise<void> | undefined, sessionID = reservedSessionID;
  let contractObservation: any;
  let receipt: any, cut: LogCut | undefined, rows: any[] = [], complete = false;
  let scenarioError: string | undefined, invalid = false;
  const cleanupErrors: string[] = [];
  try {
    const artifact = await acquire(s, anchor(options), options.bundle, options.binary, options.platformMetadataSha256);
    bindArtifact(artifact, trusted.subject);
    await checked.rebind(artifact);
    // Only version/help executes here, on ROOT's explicitly selected native run.
    const version = await s.command(artifact.binary, ['--version']);
    await evidence.json('version.json', version);
    if (version.code !== 0 || parseNativeVersion(options.generation, version.stdout) !== options.version) throw new Error('actual selected version mismatch');
    const help = await s.command(artifact.binary, ['serve', '--help']);
    await evidence.json('serve-help.json', help);
    const advertised = successfulHelp(options.generation, help);
    if (!advertised.includes('--hostname') || !advertised.includes('--port')) throw new Error('foreground serve not advertised');
    const seed = join(s.root, 'q0-seed.txt'), output = join(s.root, 'q0-written.txt'), shell = join(s.root, 'q0-shell.txt');
    await writeFile(seed, `native-read:${token}\n`, { flag: 'wx' });
    fixture = new CausalModel(s.root, seed, output, shell, token, marker, evidence, signal);
    await fixture.start(s);
    const configPath = join(s.root, 'opencode.json'), config = configFor(anchor(options), fixture.url);
    await writeFile(configPath, JSON.stringify(config, null, 2), { flag: 'wx' });
    const configBytes = await readFile(configPath);
    await evidence.raw('config-before.raw', configBytes);
    await evidence.json('model-authority.json', { protocol: '/v1/chat/completions', selectedS3a: trusted, url: fixture.url,
      configSha256: sha(configBytes), provider: 'test-model', catalog: 'q0-catalog', upstream: 'q0-upstream' });
    native = await host(s, artifact, options, evidence, signal, wire => { startupWire = wire; });
    const wire = native.wire;
    if (options.generation === 'v2') {
      let connected!: () => void;
      const ready = new Promise<void>(resolve => { connected = resolve; });
      const globalSignal = AbortSignal.any([signal, globalStop.signal]);
      const globalWire = new Wire(wire.base, wire.headers, evidence.raw, globalSignal);
      const opened = await globalWire.stream('/api/event');
      globalTask = consumeSSE(opened.body, globalSignal, evidence.raw, value => {
        if (value.type === 'server.connected') connected();
      }, 'global').catch(async e => {
        if (!globalStop.signal.aborted) { scenarioError = 'global stream: ' + String(e); await evidence.json('global-error.json', { error: String(e) }); }
        throw e;
      });
      globalTask.catch(() => {});
      await Promise.race([ready, globalTask]);
    }
    let catalog: any;
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await wire.call(options.generation === 'v1' ? '/provider' : '/api/model');
      if (response.status === 200 && selectedModel(response.value, options.generation)) { catalog = response.value; break; }
      await Bun.sleep(100);
    }
    if (!catalog) throw new Missing('selected native catalog absent (raw attempts retained)');
    const model = selectedModel(catalog, options.generation);
    await evidence.json('selected-native-catalog.json', catalog);
    if (options.generation === 'v2') {
      const provider = await wire.call('/api/provider/test-model');
      const effective = await wire.call('/api/config');
      await evidence.json('effective-native-config.json', effective.value);
      if (provider.status !== 200 || provider.value?.data?.package !== trusted.subject.reportedSelector ||
          provider.value.data.settings?.baseURL !== fixture.url || model?.package !== trusted.subject.reportedSelector ||
          model?.settings?.baseURL !== fixture.url) throw new Error('actual native selected provider route differs from accepted S3a');
    } else {
      if (!catalog.all?.some((p: any) => p.id === 'test-model' && p.options?.baseURL === fixture.url)) throw new Error('V1 actual native provider route differs from TEST config');
      const doc = await wire.call('/doc');
      contractObservation = { status: doc.status, value: doc.value, kind: 'native declared schema, not observed feature behavior' };
      await evidence.json('v1-native-declared-contract.json', contractObservation);
    }
    const createLoss = options.scenario.startsWith('create-loss');
    const body = options.generation === 'v2' ? { id: reservedSessionID, title: 'TEST S1a ' + options.scenario,
      location: { directory: s.root }, agent: 'build', model: { providerID: 'test-model', id: 'q0-catalog' } } : { title: 'TEST S1a ' + options.scenario };
    if (options.generation === 'v1' && createLoss) throw new Missing('V1 reserved session.create id not in accepted native contract; no guessed id mutation sent');
    if (createLoss) {
      loss = new LossBoundary(wire, '/api/session', body,
        options.scenario === 'create-loss-before' ? 'before-forward' : 'after-response', evidence);
      loss.start(); await loss.observe(); await loss.stop();
      await evidence.json('saved-session.json', { sessionID: reservedSessionID, callerID, unknownCreationRecoveredByExactIDOnly: true });
    } else {
      const created = await wire.call(options.generation === 'v1' ? '/session' : '/api/session', 'POST', body);
      if (created.status !== 200) throw new Missing('session.create native HTTP ' + created.status);
      const session = options.generation === 'v1' ? created.value : created.value.data;
      if (typeof session?.id !== 'string') throw new Missing('created session ID missing');
      sessionID = session.id;
      await evidence.json('saved-session.json', { sessionID, reservedSessionID, callerID });
    }
    const path = options.generation === 'v1' ? `/session/${encodeURIComponent(sessionID)}` : `/api/session/${encodeURIComponent(sessionID)}`;
    const readback = await wire.call(path);
    await evidence.json('session-readback.json', { sessionID, response: readback.value, status: readback.status });
    if (readback.status !== 200) throw new Missing('saved exact session not recovered; no replay');
    if (options.generation === 'v2') cut = await log(wire, sessionID, s.root); // synced BEFORE submit
    const before = await transcript(wire, sessionID, options.generation);
    await evidence.json('transcript-before.json', before);
    if (createLoss) {
      rows = before.rows; complete = before.complete;
    } else {
      const prompt = promptBody(options, callerID, marker);
      if (!prompt) throw new Missing('V1 has no qualified delivery/resume fields for selected scenario; no substitute prompt sent');
      const promptPath = path + (options.generation === 'v1' ? '/prompt_async' : '/prompt');
      await evidence.json('prepared-prompt.json', { path: promptPath, body: prompt, callerID, sessionID });
      if (options.scenario === 'admission-response-loss') {
        loss = new LossBoundary(wire, promptPath, prompt, 'after-response', evidence);
        loss.start(); await loss.observe(); await loss.stop();
        // Measurement witness is distinct from the lost caller receipt.
        await evidence.json('admission-observer-loss.json', { callerID, sessionID, callerReceipt: null, replay: false });
      } else {
        const reply = await wire.call(promptPath, 'POST', prompt);
        await evidence.json('prompt-result.json', { status: reply.status, value: reply.value });
        if (reply.status >= 400) throw new Missing('native prompt rejection/raw error: HTTP ' + reply.status);
        if (options.generation === 'v2') receipt = reply.value?.data;
      }
      if (['same-id-same-body', 'same-id-conflict'].includes(options.scenario)) {
        const retry = options.scenario === 'same-id-same-body' ? prompt : options.generation === 'v1'
          ? { ...prompt, parts: [{ type: 'text', text: marker + ':different' }] } : { ...prompt, text: marker + ':different' };
        const reply = await wire.call(promptPath, 'POST', retry);
        await evidence.json('explicit-retry-result.json', { status: reply.status, value: reply.value, deliberatelySelected: true });
        if (options.scenario === 'same-id-conflict' && reply.status < 400) { invalid = true; scenarioError = 'different-body same-ID mutation accepted'; }
      }
      // Bounded read-only recovery/observation, never a mutation retry.
      for (let poll = 0; poll < 20; poll++) {
        if (options.generation === 'v2') {
          const inbox = await wire.call(path + '/inbox');
          await evidence.json(`inbox-${poll}.json`, { status: inbox.status, value: inbox.value });
          cut = await log(wire, sessionID, s.root);
        }
        const snap = await transcript(wire, sessionID, options.generation);
        rows = snap.rows; complete = snap.complete;
        await evidence.json(`transcript-${poll}.json`, snap);
        await evidence.json(`session-${poll}.json`, (await wire.call(path)).value);
        if (options.generation === 'v2') cut = await log(wire, sessionID, s.root);
        if (rows.some(m => { const info = options.generation === 'v1' ? m.info : m;
          return info?.time?.completed && info.finish === 'stop' && !info.error; }) && fixture.requests.length === 4) break;
        await Bun.sleep(500);
      }
      await evidence.raw('config-after.raw', await readFile(configPath));
      if (sha(await readFile(configPath)) !== sha(configBytes)) throw new Error('TEST config changed');
    }
  } catch (e) {
    scenarioError = String(e); if (!(e instanceof Missing) && !signal.aborted) invalid = true;
    await evidence.json('measurement-error.json', { error: String(e), invalid, expired: signal.aborted });
  } finally {
    globalStop.abort();
    if (globalTask) await globalTask.catch(() => {});
    try { await loss?.stop(); } catch (e) { cleanupErrors.push('loss boundary: ' + String(e)); }
    try { fixture?.stop(); } catch (e) { cleanupErrors.push('fixture: ' + String(e)); }
    try { await native?.stop(); } catch (e) { cleanupErrors.push('native: ' + String(e)); }
    await evidence.json('model-wire.json', { requests: fixture?.requests ?? [], streamedFrames: fixture?.frames ?? [], decisions: fixture?.decisions ?? [], failures: fixture?.failures ?? [] });
    await evidence.json('calls.json', startupWire?.calls ?? []);
    await evidence.json('disk-inventory.json', await inventory(s.root));
    await evidence.json('cleanup.json', { modelStopped: !fixture?.server, hostStopAttempted: !!native, errors: cleanupErrors });
    const observed = facts({ generation: options.generation, sessionID, callerID, marker, receipt, cut, rows, complete });
    await evidence.json('prompt-causality.json', { ...observed, status: invalid || observed.failures.length || cleanupErrors.length ? 'FAIL' : 'MISSING',
      selected: options, scenarioError, contractObservation, fullS1: 'MISSING', remaining: REMAINING, cleanupErrors,
      counts: { HTTP: startupWire?.calls.length ?? 0, forwardedMutations: startupWire?.calls.filter(c => c.method !== 'GET' && c.sent).length ?? 0,
        nativeModelRequests: fixture?.requests.length ?? 0, nativeToolDecisions: fixture?.decisions.length ?? 0 },
      lossSimulation: 'owned one-forward HTTP boundary errors the downstream response body; raw native witness retained; no mutation replay',
      lossNativeWitness: loss?.witness ?? null,
    });
  }
}
