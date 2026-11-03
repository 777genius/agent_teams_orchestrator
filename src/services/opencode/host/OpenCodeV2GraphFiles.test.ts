import { expect, test, mock, afterAll } from 'bun:test'
import * as filesystem from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { OpenCodeV2DeliveryManifest } from './OpenCodeV2DeliveryContract.js'
import { openCodeV2LaunchRefusal, openCodeV2QualifiedVersions } from '../compatibility/OpenCodeV2Registry.js'
import { openCodeBunVersion } from '../../../constants/openCodeBunVersion.js'

// Install before production imports: Bun captures named fs imports at load time.
// Every observed open still delegates to the real filesystem with unchanged args.
const actualFs = { ...filesystem }, openedPaths: unknown[] = []
let observeOpens = false, afterLstat: ((file: unknown) => Promise<void>) | undefined
const observedOpen: typeof filesystem.open = async (...args) => { if (observeOpens) openedPaths.push(args[0]); return actualFs.open(...args) }
const observedLstat = async (...args: Parameters<typeof filesystem.lstat>) => { const result = await actualFs.lstat(...args); await afterLstat?.(args[0]); return result }
mock.module('node:fs/promises', () => ({ ...actualFs, open: observedOpen, lstat: observedLstat, default: { ...actualFs, open: observedOpen, lstat: observedLstat } }))
const { collectOpenCodeV2GraphFiles } = await import('./OpenCodeV2GraphFiles.js')
const delivery = await import('./OpenCodeV2DeliveryManifest.js')
const { canonicalOpenCodeV2DeliveryManifest } = await import('./OpenCodeV2DeliveryContract.js')
const { validateExecutionGraph } = await import('./OpenCodeV2ExecutionBinding.js')
const { executionHash } = await import('../execution/OpenCodeV2ExecutionContracts.js')
afterAll(() => { observeOpens = false; afterLstat = undefined; openedPaths.length = 0; mock.module('node:fs/promises', () => ({ ...actualFs })); mock.restore() })

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const pin = '2.0.32'
const enabled = process.versions.bun === openCodeBunVersion() && openCodeV2LaunchRefusal(pin) === null
async function fixture(nestedBatch = false) {
  const platform = process.platform, arch = process.arch
  if ((platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') || (arch !== 'arm64' && arch !== 'x64')) throw new Error('TEST unsupported platform')
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-sdk-candidates-'))), sdk = path.join(root, 'sdk')
  const files: OpenCodeV2DeliveryManifest['files'][number][] = []
  async function put(relative: string, content: string) {
    const file = path.join(sdk, relative)
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content, { mode: 0o644 })
    files.push({ path: relative, sha256: sha(content), bytes: Buffer.byteLength(content), executable: false })
    return file
  }
  async function pkg(directory: string, name: string, entry: string, version = '1.0.0') {
    await put(`local-cli/packages/${directory}/package.json`, JSON.stringify({ name, version, dependencies: {} }))
    return put(`local-cli/packages/${directory}/${entry}`, 'export {}')
  }
  const server = await pkg('server', '@opencode/server', 'process.js', pin)
  const client = await pkg('client', '@opencode/client', 'index.js', pin)
  const effect = await pkg('effect', 'effect', 'index.js', '4.0.1')
  const mcp = await pkg('mcp', '@modelcontextprotocol/sdk', 'client/index.js')
  const payload = await put('local-cli/packages/server/payload.bin', 'TEST expected payload')
  for (let index = 0; index < 32; index++) await put(`local-cli/packages/server/batch/${String(index).padStart(2, '0')}${nestedBatch ? '/entry' : ''}.bin`, 'TEST')
  for (const name of ['opencode-v2-graphs.json', 'opencodeV2ExecutionServer.js', 'opencodeV2RunOwner.js', 'opencodeV2Server.js']) await put(`local-cli/${name}`, 'TEST')
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
  const manifest: OpenCodeV2DeliveryManifest = { schemaVersion: 1, runtimeVersion: '0.0.999', sourceCommit: 'a'.repeat(40),
    bridgeProtocol: 1, platform, arch, requiredBunVersion: openCodeBunVersion(),
    engineVersions: openCodeV2QualifiedVersions().filter(version => openCodeV2LaunchRefusal(version) === null), files }
  const raw = canonicalOpenCodeV2DeliveryManifest(manifest)
  await writeFile(path.join(sdk, 'opencode-v2-engine-manifest.json'), raw)
  const { files: rows, ...identity } = manifest
  const snapshot = await delivery.verifyOpenCodeV2DeliveryBinding({ root: sdk, manifestSha256: sha(raw) }, { ...identity,
    archive: { file: `agent-teams-opencode-v2-support-${process.platform}-${process.arch}-v0.0.999.zip`, kind: 'zip', sha256: 'b'.repeat(64), bytes: 100,
      entries: rows.length + 1, expandedBytes: rows.reduce((sum, row) => sum + row.bytes, Buffer.byteLength(raw)) },
    manifest: { file: 'opencode-v2-engine-manifest.json', sha256: sha(raw), bytes: Buffer.byteLength(raw), files: rows.length } })
  const resolution = new Map([['@opencode/server-v2.0.32/process', server], ['@opencode/client-v2.0.32', client],
    ['effect', effect], ['@modelcontextprotocol/sdk/client/index.js', mcp]])
  const previous = Bun.resolveSync
  Bun.resolveSync = ((name: string) => { const file = resolution.get(name); if (!file) throw new Error('TEST unexpected package resolution'); return file }) as typeof Bun.resolveSync
  return { root, payload, snapshot, collect: (mode: 'actual' | 'expected' = 'actual', signal?: AbortSignal) => collectOpenCodeV2GraphFiles(pin, snapshot.root, snapshot.binding, signal, mode),
    close: async () => { Bun.resolveSync = previous; await rm(root, { recursive: true, force: true }) } }
}

test.skipIf(!enabled)('packaged receipt candidates equal full hashes for valid SDK bytes', async () => {
  const f = await fixture()
  try {
    observeOpens = true
    openedPaths.length = 0
    const actual = (await f.collect()).files
    expect(openedPaths.filter(file => file === f.payload)).toHaveLength(1)
    openedPaths.length = 0
    const expected = (await f.collect('expected')).files
    expect(openedPaths.filter(file => file === f.payload)).toHaveLength(0)
    expect(expected).toEqual(actual)
    expect(expected).toContainEqual({ path: f.payload, sha256: sha('TEST expected payload') })
  } finally { observeOpens = false; openedPaths.length = 0; await f.close() }
})

test.skipIf(!enabled)('candidate checks batch across small directories and cancellation joins only claimed reads', async () => {
  const f = await fixture(true), controller = new AbortController(), reason = new Error('TEST-candidate-cancelled')
  let release!: () => void, claimed!: () => void, started = 0, completed = 0, settled = false
  const gate = new Promise<void>(resolve => { release = resolve }), firstBatch = new Promise<void>(resolve => { claimed = resolve })
  afterLstat = async file => {
    if (typeof file !== 'string' || !file.includes('/server/batch/')) return
    if (++started === 16) claimed()
    await gate; completed++
  }
  const work = f.collect('expected', controller.signal)
  void work.then(() => { settled = true }, () => { settled = true })
  try {
    await firstBatch; controller.abort(reason)
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await expect(work).rejects.toBe(reason)
    expect(started).toBe(16); expect(completed).toBe(16)
  } finally { release(); await work.catch(() => undefined); afterLstat = undefined; await f.close() }
})

test.skipIf(!enabled)('expected receipt rows never rebless tampered payload; fresh full checks and catalog hashing reject it', async () => {
  const f = await fixture()
  try {
    await writeFile(f.payload, 'EVIL expected payload') // Same size/mode; candidate construction must not hash these bytes.
    const candidate = await f.collect('expected')
    expect(candidate.files).toContainEqual({ path: f.payload, sha256: sha('TEST expected payload') })
    const files = [...candidate.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    for (const freshCheck of ['first fresh validation', 'second fresh validation']) {
      const phases: string[] = []
      await expect(validateExecutionGraph(pin, { files, sha256: executionHash(files), delivery: f.snapshot.binding }, row => phases.push(row.phase)), freshCheck)
        .rejects.toThrow('execution_graph_changed')
      expect(phases).not.toContain('closure')
    }
    // Both existing catalog callers omit the option and retain full byte verification.
    await expect(f.collect()).rejects.toThrow('opencode_v2_support_identity_invalid')
  } finally { await f.close() }
})

test.skipIf(!enabled)('candidate preparation still rejects altered SDK size, executable mode and canonical identity', async () => {
  const f = await fixture()
  try {
    await writeFile(f.payload, 'wrong size')
    await expect(delivery.readOpenCodeV2ExpectedDeliveryFileHash(f.snapshot, f.payload)).rejects.toThrow('opencode_v2_support_identity_invalid')
    await writeFile(f.payload, 'TEST expected payload')
    if (process.platform !== 'win32') {
      await chmod(f.payload, 0o755)
      await expect(delivery.readOpenCodeV2ExpectedDeliveryFileHash(f.snapshot, f.payload)).rejects.toThrow('opencode_v2_support_identity_invalid')
      await chmod(f.payload, 0o644)
      const outside = path.join(f.root, 'outside.bin')
      await writeFile(outside, 'TEST expected payload'); await rm(f.payload); await symlink(outside, f.payload)
      await expect(delivery.readOpenCodeV2ExpectedDeliveryFileHash(f.snapshot, f.payload)).rejects.toThrow('opencode_v2_support_identity_invalid')
    }
  } finally { await f.close() }
})

test.skipIf(!enabled)('source and local controller package rows keep hashing actual bytes', async () => {
  const f = await fixture()
  try {
    await writeFile(f.payload, 'EVIL expected payload')
    const source = await collectOpenCodeV2GraphFiles(pin, f.snapshot.root)
    expect(source.files).toContainEqual({ path: f.payload, sha256: sha('EVIL expected payload') })
    await writeFile(f.payload, 'TEST expected payload')
    const controller = path.join(f.root, 'controller'), entry = path.join(controller, 'entry.js')
    await mkdir(controller); await writeFile(path.join(controller, 'package.json'), JSON.stringify({ name: 'TEST-controller', version: '1.0.0' }))
    await writeFile(entry, 'TEST controller')
    const first = await f.collect('expected'); await first.visit(controller)
    expect(first.files).toContainEqual({ path: entry, sha256: sha('TEST controller') })
    await writeFile(entry, 'EVIL controller')
    const second = await f.collect('expected'); await second.visit(controller)
    expect(second.files).toContainEqual({ path: entry, sha256: sha('EVIL controller') })
  } finally { await f.close() }
})
