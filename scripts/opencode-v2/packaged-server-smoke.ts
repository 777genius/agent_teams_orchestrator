// Starts every staged official V2 server of a packaged delivery the way the CLI
// host does: the shipped Bun runs local-cli/opencodeV2Server.js under private read
// roots and receives the start request over IPC. The smoke then reads the identity
// and provider routes, requires an acknowledged close and loads the native bash
// grammar each staged core uses. It proves that the delivered graphs load and serve
// after staging, without a native OpenCode binary or provider credentials. Run it
// on an extracted archive outside the checkout so resolution cannot reach the
// source install.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { isOpenCodeV2Pin, openCodeV2GraphPackages, openCodeV2Wire } from '../../src/services/opencode/compatibility/OpenCodeV2Registry.js'
import { createOpenCodeV2ReadRoots } from '../../src/services/opencode/profile/OpenCodeV2ManagedConfig.js'
import { collectOpenCodeV2GraphFiles } from '../../src/services/opencode/host/OpenCodeV2GraphFiles.js'
import type { OpenCodeV2DeliveryBinding } from '../../src/services/opencode/host/OpenCodeV2DeliveryManifest.js'
import { loadPackagedOpenCodeV2Support } from './packaged-support.js'

const READY_MS = 60_000, REQUEST_MS = 15_000, CLOSE_MS = 15_000

const sha = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')

async function inventory(directory: string): Promise<{ files: number; bytes: number }> {
  const size = { files: 0, bytes: 0 }
  for (const relative of await readdir(directory, { recursive: true })) {
    const entry = await stat(path.join(directory, relative))
    if (entry.isFile()) { size.files += 1; size.bytes += entry.size }
  }
  return size
}

function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms)
  })]).finally(() => clearTimeout(timer))
}

type Row = Record<string, unknown>
/** Resolves with the first matching IPC message; rejects as soon as the child exits. */
function messages(child: ReturnType<typeof spawn>, exited: Promise<number | null>) {
  const rows: Row[] = []
  const waiters = new Set<() => void>()
  child.on('message', message => {
    if (message && typeof message === 'object') rows.push(message as Row)
    for (const wake of waiters) wake()
  })
  return (accept: (row: Row) => boolean, ms: number, label: string) => within(new Promise<Row>((resolve, reject) => {
    const check = () => {
      const row = rows.find(accept)
      if (row) { waiters.delete(check); resolve(row) }
    }
    waiters.add(check)
    void exited.then(code => { waiters.delete(check); reject(new Error(`Server child exited (${code}) before ${label}`)) })
    check()
  }), ms, label)
}

async function request(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_MS) })
  return { status: response.status, body: await response.text() }
}

/** The bash grammar is the only staged package whose foreign prebuilds are left out. */
function loadBashGrammar(core: string): string[] {
  const grammar = createRequire(core)('tree-sitter-bash') as Record<string, unknown>
  assert(grammar && typeof grammar === 'object', 'Bash grammar binding did not load')
  return Object.keys(grammar).sort()
}

async function serveGraph(bundle: string, bun: string, executableSha256: string, version: string, delivery: OpenCodeV2DeliveryBinding) {
  assert(isOpenCodeV2Pin(version), 'Staged graph manifest invalid')
  await collectOpenCodeV2GraphFiles(version, bundle, delivery)
  const { server } = openCodeV2GraphPackages(version)
  const serverEntry = await realpath(Bun.resolveSync(`${server}/process`, bundle))
  const moduleSha256 = await sha(serverEntry)
  const evidence: Row = { version, wire: openCodeV2Wire(version), server }
  const core = await realpath(Bun.resolveSync('@opencode/core/bus', path.dirname(serverEntry)))
  evidence.bashGrammar = loadBashGrammar(core)
  const roots = await createOpenCodeV2ReadRoots()
  const project = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-server-smoke-project-')))
  const nonce = randomUUID(), password = randomBytes(32).toString('base64url')
  const started = performance.now()
  const child = spawn(bun, ['--no-install', path.join(bundle, 'opencodeV2Server.js')], { cwd: roots.root, env: roots.env,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true })
  let stderr = ''
  child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000) })
  // 'exit' rather than 'close': a descendant holding stderr must not delay the result.
  const exited = new Promise<number | null>(resolve => {
    child.once('exit', code => resolve(code))
    child.once('error', () => resolve(null))
  })
  const next = messages(child, exited)
  try {
    child.send({ type: 'start', nonce, pin: version, root: roots.root, password, executableSha256, moduleSha256, delivery })
    const ready = await next(row => row.nonce === nonce && (row.type === 'ready' || row.type === 'failed'), READY_MS, 'ready')
    assert.equal(ready.type, 'ready', 'Server child reported a failed start')
    assert(ready.pid === child.pid && ready.version === version && ready.moduleSha256 === moduleSha256 &&
      ready.executableSha256 === executableSha256, 'Server child identity mismatch')
    const baseUrl = String(ready.baseUrl)
    assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/)
    evidence.readyMs = Math.round(performance.now() - started)
    const identity = openCodeV2Wire(version) === 'floor' ? '/api/health' : '/api/info'
    const authorization = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64')
    const anonymous = await request(baseUrl + identity)
    assert.equal(anonymous.status, 401, 'Server accepted an unauthenticated request')
    const info = await request(baseUrl + identity, { authorization })
    assert.equal(info.status, 200, `Identity route answered ${info.status}`)
    assert.equal((JSON.parse(info.body) as Row).version, version, 'Server reported another version')
    const providers = await request(`${baseUrl}/api/provider?location%5Bdirectory%5D=${encodeURIComponent(project)}`, { authorization })
    assert.equal(providers.status, 200, `Provider route answered ${providers.status}`)
    assert.equal(typeof JSON.parse(providers.body), 'object')
    child.send({ type: 'close', nonce })
    await next(row => row.type === 'closed' && row.nonce === nonce, CLOSE_MS, 'close acknowledgement')
    evidence.exitCode = await within(exited, CLOSE_MS, 'server exit')
    assert.equal(evidence.exitCode, 0, 'Server child did not exit cleanly')
    evidence.ok = true
  } catch (error) {
    evidence.ok = false
    evidence.failure = error instanceof Error ? error.message.slice(0, 512) : 'Unknown server smoke failure'
    evidence.stderr = stderr
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await within(exited, CLOSE_MS, 'killed server exit').catch(() => undefined)
  } finally {
    await roots.remove()
    await rm(project, { recursive: true, force: true })
  }
  return evidence
}

export async function main(baseArgument: string, supportArgument: string, receipt: string): Promise<void> {
  const evidence: Row = { schemaVersion: 1, ok: false, platform: process.platform, arch: process.arch,
    bunVersion: Bun.version, graphs: [] }
  try {
    const { delivery, descriptor, bun } = await loadPackagedOpenCodeV2Support(baseArgument, supportArgument)
    const bundle = delivery.root
    const staged = await inventory(path.join(bundle, 'node_modules'))
    evidence.stagedFiles = staged.files
    evidence.stagedMegabytes = Math.round(staged.bytes / 1e5) / 10
    const manifest = JSON.parse(await readFile(path.join(bundle, 'opencode-v2-graphs.json'), 'utf8')) as {
      schema: number; graphs: { version: string }[] }
    assert(manifest.schema === 2 && Array.isArray(manifest.graphs) && manifest.graphs.length > 0, 'Staged graph manifest invalid')
    assert.deepEqual(manifest.graphs.map(row => row.version), descriptor.engineVersions, 'Support graph set differs from its platform descriptor')
    const executableSha256 = await sha(bun)
    for (const { version } of manifest.graphs) {
      ;(evidence.graphs as Row[]).push(await serveGraph(bundle, bun, executableSha256, version, delivery.binding))
    }
    evidence.ok = (evidence.graphs as Row[]).every(graph => graph.ok === true)
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message.slice(0, 512) : 'Unknown server smoke failure'
  }
  await writeFile(receipt, JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
  if (evidence.ok !== true) process.exitCode = 1
}

if (import.meta.main) {
  const [base, support, receipt] = process.argv.slice(2)
  assert(base && support && receipt, 'Expected base, support and receipt arguments')
  await main(base, support, receipt)
}
