// Starts every staged official V2 server of a packaged delivery the way the CLI
// host does: the shipped Bun runs local-cli/opencodeV2Server.js under private read
// roots and receives the start request over IPC. The smoke then reads the identity
// and provider routes and requires an acknowledged close. It proves that the
// delivered graphs load and serve after staging, without a native OpenCode
// binary or provider credentials, and bounds how many files the delivery carries.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { isOpenCodeV2Pin, openCodeV2GraphPackages, openCodeV2Wire } from '../../src/services/opencode/compatibility/OpenCodeV2Registry.js'
import { createOpenCodeV2ReadRoots } from '../../src/services/opencode/profile/OpenCodeV2ManagedConfig.js'

// Staging leaves out files Bun never loads (staged-files.ts); three graphs then
// carry about 42k files. Signing, notarization and antivirus scans scale with the
// count, so a new graph or a regression in staging must raise this deliberately.
export const MAX_STAGED_GRAPH_FILES = 50_000
const READY_MS = 60_000, CLOSE_MS = 15_000

const sha = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')

async function inventory(directory: string): Promise<{ files: number; bytes: number }> {
  const size = { files: 0, bytes: 0 }
  for (const relative of await readdir(directory, { recursive: true })) {
    const entry = await stat(path.join(directory, relative))
    if (entry.isFile()) { size.files += 1; size.bytes += entry.size }
  }
  return size
}

type Row = Record<string, unknown>
function messages(child: ReturnType<typeof spawn>) {
  const rows: Row[] = []
  const waiters = new Set<() => void>()
  child.on('message', message => {
    if (message && typeof message === 'object') rows.push(message as Row)
    for (const wake of waiters) wake()
  })
  return (accept: (row: Row) => boolean, ms: number, label: string) => new Promise<Row>((resolve, reject) => {
    const check = () => {
      const row = rows.find(accept)
      if (row) { finish(); resolve(row) }
    }
    const timer = setTimeout(() => { finish(); reject(new Error(`Timed out waiting for ${label}`)) }, ms)
    const finish = () => { clearTimeout(timer); waiters.delete(check) }
    waiters.add(check)
    check()
  })
}

async function serveGraph(bundle: string, bun: string, executableSha256: string, version: string) {
  assert(isOpenCodeV2Pin(version), 'Staged graph manifest invalid')
  const { server } = openCodeV2GraphPackages(version)
  const moduleSha256 = await sha(await realpath(Bun.resolveSync(`${server}/process`, bundle)))
  const roots = await createOpenCodeV2ReadRoots()
  const project = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-server-smoke-project-')))
  const nonce = randomUUID(), password = randomBytes(32).toString('base64url')
  const started = performance.now()
  const child = spawn(bun, [path.join(bundle, 'opencodeV2Server.js')], { cwd: roots.root, env: roots.env,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true })
  let stderr = ''
  child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000) })
  const exit = new Promise<number | null>(resolve => child.once('close', code => resolve(code)))
  const next = messages(child)
  const evidence: Row = { version, wire: openCodeV2Wire(version), server }
  try {
    child.send({ type: 'start', nonce, pin: version, root: roots.root, password, executableSha256, moduleSha256 })
    const ready = await next(row => row.nonce === nonce && (row.type === 'ready' || row.type === 'failed'), READY_MS, 'ready')
    assert.equal(ready.type, 'ready', 'Server child reported a failed start')
    assert(ready.pid === child.pid && ready.version === version && ready.moduleSha256 === moduleSha256 &&
      ready.executableSha256 === executableSha256, 'Server child identity mismatch')
    const baseUrl = String(ready.baseUrl)
    assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/)
    evidence.readyMs = Math.round(performance.now() - started)
    const identity = openCodeV2Wire(version) === 'floor' ? '/api/health' : '/api/info'
    const authorization = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64')
    const anonymous = await fetch(baseUrl + identity)
    await anonymous.body?.cancel()
    assert.equal(anonymous.status, 401, 'Server accepted an unauthenticated request')
    const info = await fetch(baseUrl + identity, { headers: { authorization } })
    const body = await info.json() as Row
    assert.equal(info.status, 200)
    assert.equal(body.version, version, 'Server reported another version')
    const providers = await fetch(`${baseUrl}/api/provider?location%5Bdirectory%5D=${encodeURIComponent(project)}`,
      { headers: { authorization } })
    assert.equal(providers.status, 200, 'Provider route failed')
    assert.equal(typeof await providers.json(), 'object')
    child.send({ type: 'close', nonce })
    await next(row => row.type === 'closed' && row.nonce === nonce, CLOSE_MS, 'close acknowledgement')
    evidence.exitCode = await exit
    assert.equal(evidence.exitCode, 0, 'Server child did not exit cleanly')
    evidence.ok = true
  } catch (error) {
    evidence.ok = false
    evidence.failure = error instanceof Error ? error.message.slice(0, 512) : 'Unknown server smoke failure'
    evidence.stderr = stderr
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exit
  } finally {
    await roots.remove()
    await rm(project, { recursive: true, force: true })
  }
  return evidence
}

export async function main(deliveryArgument: string, receipt: string): Promise<void> {
  const evidence: Row = { schemaVersion: 1, ok: false, platform: process.platform, arch: process.arch,
    bunVersion: Bun.version, graphs: [] }
  try {
    const delivery = await realpath(deliveryArgument)
    const bundle = await realpath(path.join(delivery, 'local-cli'))
    const bun = await realpath(path.join(delivery, 'bun', process.platform === 'win32' ? 'bun.exe' : 'bun'))
    assert.equal(await realpath(process.execPath), bun, 'Smoke must execute the shipped physical Bun')
    const staged = await inventory(path.join(bundle, 'node_modules'))
    evidence.stagedFiles = staged.files
    evidence.stagedMegabytes = Math.round(staged.bytes / 1e5) / 10
    assert(staged.files <= MAX_STAGED_GRAPH_FILES,
      `Staged graphs carry ${staged.files} files, above the ${MAX_STAGED_GRAPH_FILES} budget`)
    const manifest = JSON.parse(await readFile(path.join(bundle, 'opencode-v2-graphs.json'), 'utf8')) as {
      schema: number; graphs: { version: string }[] }
    assert(manifest.schema === 2 && Array.isArray(manifest.graphs) && manifest.graphs.length > 0, 'Staged graph manifest invalid')
    const executableSha256 = await sha(bun)
    for (const { version } of manifest.graphs) {
      const graph = await serveGraph(bundle, bun, executableSha256, version)
      ;(evidence.graphs as Row[]).push(graph)
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
  const [delivery, receipt] = process.argv.slice(2)
  assert(delivery && receipt, 'Expected delivery and receipt arguments')
  await main(delivery, receipt)
}
