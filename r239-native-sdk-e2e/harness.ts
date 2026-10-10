import assert from 'node:assert/strict'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readlink, realpath, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import type { ConfigEntry as FloorConfig } from '../node_modules/@opencode/client-v2-floor/dist/promise/generated/types.js'
import type { ConfigEntry as CurrentConfig } from '../node_modules/@opencode/client/dist/promise/generated/types.js'
import { acquireExecutionLease, type ExecutionLease } from '../src/services/opencode/host/OpenCodeV2ExecutionHost.js'
import { readExecutionBirth, type SelectedExecutionProfile, type ValidatedExecutionNative } from '../src/services/opencode/host/OpenCodeV2ExecutionBinding.js'
import { createOpenCodeV2ExecutionClient, type ExecutionClient, type ExecutionModel } from '../src/services/opencode/transport/OpenCodeV2ExecutionClientFactory.js'
import { OpenCodeV2AdmissionStore } from '../src/services/opencode/execution/OpenCodeV2AdmissionStore.js'
import { OpenCodeV2AdmissionService, type QueueIntent } from '../src/services/opencode/execution/OpenCodeV2AdmissionService.js'
import { OpenCodeV2SessionService } from '../src/services/opencode/execution/OpenCodeV2SessionService.js'
import { executionHash, executionRecord, type ExecutionPin, type SessionAuthority } from '../src/services/opencode/execution/OpenCodeV2ExecutionContracts.js'

interface PeerState { calls: number; bodyClosed: number; bodyFinished: number; active: number; finalReceived: boolean; failure: string | undefined; pid: number | undefined }
interface Input { testRoot: string; nodePath: string; nativeReceipts: Record<ExecutionPin, string>; sourceManifest: string; hostPidNamespace: string; hostNetNamespace: string }
const cfg: Input = JSON.parse(await readFile(process.argv[2]!, 'utf8'))
assert.equal(process.platform, 'linux'); assert.equal(process.versions.bun, '1.3.11')
assert(path.isAbsolute(cfg.testRoot) && path.basename(cfg.testRoot).startsWith('TEST-'))
assert(path.isAbsolute(cfg.nodePath))
assert(/^pid:\[\d+\]$/.test(cfg.hostPidNamespace)); assert(/^net:\[\d+\]$/.test(cfg.hostNetNamespace))
assert.notEqual(await readlink('/proc/self/ns/pid'), cfg.hostPidNamespace, 'fresh TEST PID namespace required')
assert.notEqual(await readlink('/proc/self/ns/net'), cfg.hostNetNamespace, 'fresh TEST NET namespace required')
await mkdir(cfg.testRoot, { mode: 0o700 }) // exclusive fresh root: no continuation/replay
const testRoot = await realpath(cfg.testRoot)
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const sourceRoot = await realpath(fileURLToPath(new URL('../', import.meta.url)))
const manifestRaw: unknown = JSON.parse(await readFile(cfg.sourceManifest, 'utf8'))
const manifest = Array.isArray(manifestRaw) ? manifestRaw : executionRecord(manifestRaw).files
assert(Array.isArray(manifest) && manifest.length >= 17)
for (const value of manifest) { const row = executionRecord(value); assert(typeof row.path === 'string' && typeof row.sha256 === 'string'); assert(!path.isAbsolute(row.path) && !row.path.split('/').includes('..')); assert.equal(sha(await readFile(path.join(sourceRoot, row.path))), row.sha256, 'exact source hash: ' + row.path) }
async function save(root: string, name: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2) + '\n'; assert(Buffer.byteLength(text) < 8 * 1024 * 1024)
  await writeFile(path.join(root, name + '.json'), text, { flag: 'wx', mode: 0o600 })
}
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('TEST observation UNKNOWN')), ms) })]) }
  finally { clearTimeout(timer) }
}
async function peer(root: string, mode: 'complete' | 'held', env: Record<string, string>) {
  const child = spawn(cfg.nodePath, ['--experimental-strip-types', fileURLToPath(new URL('./provider-peer.ts', import.meta.url)), root, mode], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let stderr = '', stdout = '', calls = 0, bodyClosed = 0, bodyFinished = 0, active = 0, finalReceived = false, failure: string | undefined
  assert(child.stderr && child.stdout, 'TEST fixture must expose captured stdout/stderr pipes')
  child.stderr.on('data', (value: Buffer) => { stderr += value.toString(); assert(stderr.length < 65536) })
  child.stdout.on('data', (value: Buffer) => { stdout += value.toString(); assert(stdout.length < 65536) })
  const exited = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
  let readyResolve: (port: number) => void = () => undefined
  const ready = new Promise<number>(resolve => { readyResolve = resolve })
  child.on('message', message => {
    const row = executionRecord(message)
    if (row.kind === 'ready') { assert(row.nativeNode === true && row.node === '24.21.0' && typeof row.port === 'number'); readyResolve(row.port) }
    if (row.kind !== 'ready') {
      assert(typeof row.calls === 'number' && typeof row.closed === 'number' && typeof row.finished === 'number' && typeof row.active === 'number')
      calls = row.calls; bodyClosed = row.closed; bodyFinished = row.finished; active = row.active
    }
    if (row.kind === 'failed') failure ??= String(row.message)
    if (row.kind === 'finished') { finalReceived = true; if (row.failure !== undefined) failure ??= String(row.failure) }
  })
  const port = await bounded(Promise.race([ready, exited.then(() => { throw new Error('TEST provider startup failed') })]), 5000)
  return { baseURL: `http://127.0.0.1:${port}/v1`, state: (): PeerState => ({ calls, bodyClosed, bodyFinished, active, finalReceived, failure, pid: child.pid }),
    close: async () => { if (child.connected) child.send({ kind: 'close' }); assert.equal(await bounded(exited, 5000), 0); assert.equal(stderr, ''); assert.equal(stdout, ''); assert(finalReceived, 'TEST final peer IPC must drain before exit'); assert.equal(failure, undefined, failure ?? 'TEST late provider failure'); assert.equal(calls, 1, 'TEST late/duplicate provider calls'); assert.equal(active, 0, 'TEST provider responses still active'); return { calls, bodyClosed, bodyFinished, active, finalReceived, failure, pid: child.pid } } }
}
async function profile(root: string, baseURL: string, variant: boolean): Promise<SelectedExecutionProfile> {
  const env: Record<string, string> = { PATH: '/usr/bin:/bin' }
  const directories: Record<string, string> = { HOME: 'home', USERPROFILE: 'home', XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state', TMPDIR: 'tmp', TMP: 'tmp', TEMP: 'tmp', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata' }
  for (const [key, relative] of Object.entries(directories)) env[key] = path.join(root, relative)
  for (const name of new Set(Object.values(directories))) await mkdir(path.join(root, name), { mode: 0o700 })
  const permissions = [{ action: '*', resource: '*', effect: 'deny' }, { action: 'provider.use', resource: 'TEST-r239', effect: 'allow' }] as const
  const model: ExecutionModel = { providerID: 'TEST-r239', id: 'TEST-catalog', ...(variant ? { variant: 'TEST-variant' } : {}) }
  const content = JSON.stringify({ update: 'disable', share: 'disabled', snapshots: false, warming: false, plugins: [], default_agent: 'TEST-agent', model: 'TEST-r239/TEST-catalog',
    providers: { 'TEST-r239': { name: 'TEST-r239', env: [], package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL, apiKey: 'TEST-dummy-key' }, models: { 'TEST-catalog': { modelID: 'TEST-upstream', name: 'TEST-catalog', variants: [{ id: 'TEST-variant' }] } } } },
    agents: { 'TEST-agent': { mode: 'primary', model: variant ? { providerID: model.providerID, model: model.id, variant: 'TEST-variant' } : 'TEST-r239/TEST-catalog', permissions: [...permissions] } }
  } satisfies Extract<FloorConfig, { type: 'document' }>['info'] & Extract<CurrentConfig, { type: 'document' }>['info'])
  return { root, epoch: randomUUID(), directory: root, databasePath: path.join(root, 'data/native.sqlite'), env, envSha256: executionHash(env), config: { directory: env.XDG_CONFIG_HOME!, content, sha256: sha(content) }, selection: { agent: 'TEST-agent', model, permissions } }
}

// Independent namespace-local /proc census, never signal these PIDs. Each
// captured descendant is checked by birth after production lease retirement.
async function descendants(leader: number) {
  const rows: { pid: number; ppid: number; birth: NonNullable<Awaited<ReturnType<typeof readExecutionBirth>>> }[] = []
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    try {
      const stat = await readFile('/proc/' + name + '/stat', 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const birth = await readExecutionBirth(pid)
      if (birth) rows.push({ pid, ppid: Number(fields[1]), birth })
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
  }
  const owned = new Set([leader]); let changed = true
  while (changed) { changed = false; for (const row of rows) if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true } }
  return rows.filter(row => row.pid !== leader && owned.has(row.pid))
}

async function scenario(pin: ExecutionPin, held: boolean): Promise<void> {
  const root = path.join(testRoot, `TEST-${pin}-${held ? 'lost-held-variant' : 'complete'}`); await mkdir(root, { mode: 0o700 })
  let fixture: Awaited<ReturnType<typeof peer>> | undefined, lease: ExecutionLease | undefined, client: ExecutionClient | undefined
  const calls = { create: 0, prompt: 0 }; let status = 'UNKNOWN', cleanup: unknown, failure: unknown
  let nativeAcquisitionAttempted = false, nativeLeaseAcquired = false
  try {
    // The loopback provider has its own clean env, no credentials or real project.
    const fixtureHome = path.join(root, 'fixture-home'); await mkdir(fixtureHome, { mode: 0o700 })
    fixture = await peer(root, held ? 'held' : 'complete', { HOME: fixtureHome, TMPDIR: fixtureHome, PATH: '/usr/bin:/bin' })
    const selected = await profile(root, fixture.baseURL, held)
    const context = { teamId: 'TEST-r239', runId: randomUUID(), laneId: 'TEST-' + pin, memberId: 'TEST-member', deadline: Date.now() + 60_000 }
    const native: ValidatedExecutionNative = JSON.parse(await readFile(cfg.nativeReceipts[pin], 'utf8'))
    assert.equal(native.version, pin)
    await save(root, 'intent-before-acquisition', { context, selected: { root: selected.root, epoch: selected.epoch, databasePath: selected.databasePath, model: selected.selection.model }, sourceManifestSHA256: sha(await readFile(cfg.sourceManifest)), nativeGraphSHA256: native.graph.sha256 })
    nativeAcquisitionAttempted = true
    lease = await acquireExecutionLease(native, selected, context)
    nativeLeaseAcquired = true
    client = await createOpenCodeV2ExecutionClient(lease.authority, context)
    const actual = client
    // Passthrough observer uses the real generated SDK. Deliberately discard
    // one *returned* original receipt to reproduce caller response loss. This
    // is not a socket-loss claim and never retries the underlying mutation.
    const observed: ExecutionClient = { ...actual,
      createSession: async input => { calls.create++; assert.equal(calls.create, 1); return actual.createSession(input) },
      promptQueue: async (id, input) => { calls.prompt++; assert.equal(calls.prompt, 1); const result = await actual.promptQueue(id, input); if (held) throw new Error('TEST caller receipt discarded after real SDK response'); return result } }
    const sessionID = 'ses_' + randomUUID().replaceAll('-', '')
    const authority: SessionAuthority = { host: lease.authority, ...context, sessionID, agent: selected.selection.agent, model: selected.selection.model }
    // Exact authority avoids leaking context-only deadline/signal fields.
    const sessionAuthority: SessionAuthority = { host: authority.host, teamId: context.teamId, runId: context.runId, laneId: context.laneId, memberId: context.memberId, sessionID, agent: authority.agent, model: authority.model }
    const storeRoot = path.join(root, 'journal'); await mkdir(storeRoot, { mode: 0o700 })
    const store = await OpenCodeV2AdmissionStore.open(storeRoot, sessionAuthority)
    const sessions = new OpenCodeV2SessionService(observed, store, sessionAuthority)
    const created = await sessions.createSession('TEST-R239-native-SDK'); await save(root, 'session-create', created)
    assert.equal(created.disposition, 'accepted'); assert(created.session)
    const reread = await actual.getSession(sessionID); assert.equal(reread.id, sessionID); assert.equal(executionHash(reread.model), executionHash(selected.selection.model))
    const admission = new OpenCodeV2AdmissionService(observed, store, sessionAuthority)
    const nativeInputID = 'msg_' + randomUUID().replaceAll('-', '')
    const intent: QueueIntent = { identity: { requestId: randomUUID(), deliveryAttemptId: randomUUID(), localMessageId: randomUUID(), nativeInputID }, input: { nativeInputID, text: 'TEST-R239-original', resume: true }, delivery: 'queue' }
    await save(root, 'original-intent', intent)
    const result = await admission.admitQueue(intent, true); await save(root, 'admission', result)
    assert.equal(result.state, held ? 'unknown' : 'accepted'); assert.equal(calls.prompt, 1)
    let reconciled = result, terminal = false
    for (let observation = 0; observation < 40; observation++) {
      const providerFailure: string | undefined = fixture.state().failure
      assert.equal(providerFailure, undefined, providerFailure ?? 'TEST provider fixture failure')
      reconciled = await admission.reconcileOriginalInput(intent) // read-only native operations, no create/prompt
      const log = await actual.log(sessionID)
      terminal = log.events.some(event => event.type === 'session.execution.succeeded')
      if (reconciled.complete && reconciled.returnedInboxID === nativeInputID && fixture.state().calls === 1 && (held || terminal)) break
      await delay(100)
    }
    await save(root, 'original-recovery', { reconciled, terminal, calls, provider: fixture.state(), log: await actual.log(sessionID), messages: await actual.messages(sessionID) })
    assert(reconciled.complete); assert.equal(reconciled.returnedInboxID, nativeInputID); assert.equal(calls.create, 1); assert.equal(calls.prompt, 1); assert.equal(fixture.state().calls, 1)
    if (!held) { assert(terminal); const messages = await actual.messages(sessionID); assert(messages.data.some(message => message.type === 'assistant' && JSON.stringify(message.data).includes('TEST-R239-completed'))) }
    if (held) { const state = fixture.state(); assert.equal(state.bodyClosed, 0, 'held stream closed before stop fence'); assert.equal(state.bodyFinished, 0, 'held stream finished before stop fence'); assert.equal(state.active, 1, 'held stream must still be live before stop fence') }
    await admission.fenceStop(); await save(root, 'stop-fence', await store.snapshot())
    const beforeCalls = { ...calls }; const recoveryAfterFence = await admission.readOriginalInput(intent)
    assert.deepEqual(calls, beforeCalls); assert.equal(recoveryAfterFence.identity.nativeInputID, nativeInputID)
    await save(root, 'read-only-after-fence', recoveryAfterFence)
    const nativeDescendants = await descendants(lease.authority.child.pid)
    await save(root, 'native-descendants-before-stop', nativeDescendants)
    await actual.dispose(); client = undefined
    const child = lease.authority.child
    if (held) { const state = fixture.state(); assert.equal(state.bodyClosed, 0, 'held stream closed before lease close'); assert.equal(state.bodyFinished, 0, 'held stream finished before lease close'); assert.equal(state.active, 1, 'held stream must remain live until lease close') }
    cleanup = await lease.close(); lease = undefined
    assert.equal(await readExecutionBirth(child.pid), null, 'original server PID still live')
    for (const row of nativeDescendants) { const live = await readExecutionBirth(row.pid); assert(live === null || executionHash(live) !== executionHash(row.birth), 'captured native descendant still live: ' + row.pid) }
    await save(root, 'native-descendants-retired', { captured: nativeDescendants.length, allOriginalBirthsGone: true })
    if (held) {
      for (let n = 0; n < 30 && fixture.state().bodyClosed === 0; n++) await delay(50)
      assert.equal(fixture.state().bodyClosed, 1, 'native stop must independently close held provider socket before fixture teardown')
      assert.equal(fixture.state().bodyFinished, 0, 'held stream must be cancelled, not completed')
      assert.equal(fixture.state().active, 0)
    }
    assert.deepEqual(cleanup, { pid: child.pid, birth: child.birth, scopeClosed: true, processRetired: true, descendantsRetired: true })
    status = 'PASS'
  } catch (error) { failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) }
  finally {
    const cleanupFailures: string[] = []
    if (client) try { await client.dispose() } catch (error) { cleanupFailures.push(String(error)) }
    if (lease) try { cleanup = await lease.close() } catch (error) { cleanupFailures.push(String(error)) }
    let provider = fixture?.state()
    if (fixture) try { provider = await fixture.close() } catch (error) { provider = fixture.state(); cleanupFailures.push(String(error)) }
    if (cleanupFailures.length) status = 'UNKNOWN'
    const nativeProviderRequestObserved = (provider?.calls ?? 0) > 0
    await save(root, 'final', { pin, held, status, calls, provider, cleanup, cleanupFailures, failure,
      nativeAcquisitionAttempted, nativeLeaseAcquired, sdkSessionMutationInvoked: calls.create > 0, nativeProviderRequestObserved,
      nativeEffectStarted: nativeLeaseAcquired || nativeProviderRequestObserved ? true : nativeAcquisitionAttempted ? null : false,
      nativeExecutionDisposition: nativeLeaseAcquired || nativeProviderRequestObserved ? 'observed' : nativeAcquisitionAttempted ? 'UNKNOWN' : 'not_attempted', retainedRoot: root })
    console.log(JSON.stringify({ pin, held, status, root }))
    assert.equal(status, 'PASS', 'scenario failure/unknown preserved; no automatic replay')
  }
}
// A failed/uncertain scenario stops the ordered run. The fresh root is retained.
for (const pin of ['2.0.0', '2.0.21'] as const) await scenario(pin, false)
for (const pin of ['2.0.0', '2.0.21'] as const) await scenario(pin, true)
