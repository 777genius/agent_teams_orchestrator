import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { openCodeBunVersion } from '../../../constants/openCodeBunVersion.js'
import { hashOpenCodeFile } from '../compatibility/OpenCodeNativeIdentity.js'
import { OPENCODE_V2_DELIVERY_LIMITS, OPENCODE_V2_DELIVERY_MANIFEST_FILE, OPENCODE_V2_SUPPORT_ROOT_ENV,
  validateOpenCodeV2DeliveryDescriptor, validateOpenCodeV2DeliveryInstallReceipt, validateOpenCodeV2DeliveryManifest,
  type OpenCodeV2DeliveryBinding, type OpenCodeV2DeliveryDescriptor, type OpenCodeV2DeliveryManifest } from './OpenCodeV2DeliveryContract.js'
export * from './OpenCodeV2DeliveryContract.js'

declare const OPENCODE_V2_DELIVERY_DESCRIPTOR: OpenCodeV2DeliveryDescriptor | undefined
declare const OPENCODE_RUNTIME_VERSION: string | undefined
declare const OPENCODE_RUNTIME_SOURCE_COMMIT: string | undefined
export type OpenCodeV2DeliverySnapshot = Readonly<{ binding: OpenCodeV2DeliveryBinding; root: string; manifest: OpenCodeV2DeliveryManifest }>
const snapshots = new WeakMap<OpenCodeV2DeliveryBinding, Promise<OpenCodeV2DeliverySnapshot>>()
const inventories = new WeakMap<OpenCodeV2DeliverySnapshot, ReadonlyMap<string, OpenCodeV2DeliveryManifest['files'][number]>>()
function assert(value: unknown): asserts value { if (!value) throw new Error('opencode_v2_support_identity_invalid') }

async function boundedBytes(file: string, maximum: number): Promise<Buffer> {
  const leaf = await lstat(file); assert(leaf.isFile() && !leaf.isSymbolicLink() && leaf.size <= maximum && await realpath(file) === file)
  const handle = await open(file, 'r')
  try {
    const before = await handle.stat(); assert(before.dev === leaf.dev && before.ino === leaf.ino && before.size <= maximum)
    const bytes = Buffer.alloc(before.size + 1); let count = 0
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count)
      if (!read.bytesRead) break
      count += read.bytesRead
    }
    const after = await handle.stat()
    assert(count === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ino === before.ino && after.dev === before.dev)
    return bytes.subarray(0, count)
  } finally { await handle.close() }
}

function sameIdentity(manifest: OpenCodeV2DeliveryManifest, expected?: OpenCodeV2DeliveryDescriptor): void {
  assert(manifest.platform === process.platform && manifest.arch === process.arch && manifest.requiredBunVersion === openCodeBunVersion() &&
    process.versions.bun === manifest.requiredBunVersion)
  if (expected) {
    for (const key of ['runtimeVersion', 'sourceCommit', 'bridgeProtocol', 'platform', 'arch', 'requiredBunVersion'] as const) assert(manifest[key] === expected[key])
    assert(JSON.stringify(manifest.engineVersions) === JSON.stringify(expected.engineVersions) && manifest.files.length === expected.manifest.files)
  } else {
    assert(typeof OPENCODE_RUNTIME_VERSION !== 'undefined' && manifest.runtimeVersion === OPENCODE_RUNTIME_VERSION &&
      typeof OPENCODE_RUNTIME_SOURCE_COMMIT !== 'undefined' && manifest.sourceCommit === OPENCODE_RUNTIME_SOURCE_COMMIT)
  }
}

async function readBinding(binding: OpenCodeV2DeliveryBinding, expected?: OpenCodeV2DeliveryDescriptor): Promise<OpenCodeV2DeliverySnapshot> {
  assert(binding && Object.keys(binding).sort().join(',') === 'manifestSha256,root' && path.isAbsolute(binding.root) && /^[a-f0-9]{64}$/.test(binding.manifestSha256))
  const root = await realpath(binding.root); assert(root === binding.root && (await lstat(root)).isDirectory())
  const bytes = await boundedBytes(path.join(root, OPENCODE_V2_DELIVERY_MANIFEST_FILE), expected?.manifest.bytes ?? OPENCODE_V2_DELIVERY_LIMITS.manifest)
  assert(createHash('sha256').update(bytes).digest('hex') === binding.manifestSha256 && (!expected || bytes.length === expected.manifest.bytes))
  const manifest = validateOpenCodeV2DeliveryManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  sameIdentity(manifest, expected)
  if (expected) assert(manifest.files.reduce((sum, row) => sum + row.bytes, bytes.length) === expected.archive.expandedBytes)
  const localRoot = path.join(root, 'local-cli'); assert(await realpath(localRoot) === localRoot && (await lstat(localRoot)).isDirectory())
  const snapshot = Object.freeze({ binding: Object.freeze(binding), root: localRoot, manifest })
  inventories.set(snapshot, new Map(manifest.files.map(row => [row.path, row])))
  return snapshot
}

/** A location hint never supplies the expected digest. Read the per-descriptor receipt exactly once. */
export async function verifyOpenCodeV2DeliveryBinding(binding: OpenCodeV2DeliveryBinding,
  descriptorValue: unknown): Promise<OpenCodeV2DeliverySnapshot> {
  const descriptor = validateOpenCodeV2DeliveryDescriptor(descriptorValue)
  assert(binding.manifestSha256 === descriptor.manifest.sha256)
  const snapshot = await readBinding(binding, descriptor)
  snapshots.set(snapshot.binding, Promise.resolve(snapshot))
  return snapshot
}

export async function resolveInstalledOpenCodeV2Delivery(descriptorValue: unknown, cacheRoot: string): Promise<OpenCodeV2DeliverySnapshot> {
  const descriptor = validateOpenCodeV2DeliveryDescriptor(descriptorValue)
  assert(path.isAbsolute(cacheRoot))
  const cache = await realpath(cacheRoot)
  const directory = path.join(cache, descriptor.runtimeVersion, `${descriptor.platform}-${descriptor.arch}`, descriptor.archive.sha256)
  assert(await realpath(directory) === directory)
  const receipt = validateOpenCodeV2DeliveryInstallReceipt(JSON.parse((await boundedBytes(path.join(directory, 'installed.json'), 4096)).toString('utf8')), descriptor)
  const binding = Object.freeze({ root: path.join(directory, receipt.instance), manifestSha256: descriptor.manifest.sha256 })
  return verifyOpenCodeV2DeliveryBinding(binding, descriptor)
}

/** Explicit bindings arrive over the existing private parent IPC, never from an environment hash. */
export async function resolveOpenCodeV2Delivery(binding?: OpenCodeV2DeliveryBinding): Promise<OpenCodeV2DeliverySnapshot> {
  if (binding) {
    let pending = snapshots.get(binding)
    if (!pending) { pending = readBinding(binding); snapshots.set(binding, pending); pending.catch(() => snapshots.delete(binding)) }
    return pending
  }
  if (typeof OPENCODE_V2_DELIVERY_DESCRIPTOR === 'undefined') throw new Error('opencode_v2_support_required')
  const cacheRoot = process.env[OPENCODE_V2_SUPPORT_ROOT_ENV]
  if (!cacheRoot) throw new Error('opencode_v2_support_required')
  try { return await resolveInstalledOpenCodeV2Delivery(OPENCODE_V2_DELIVERY_DESCRIPTOR, cacheRoot) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('opencode_v2_support_required')
    throw error
  }
}

/** Compare an already hashed graph row to the pinned bytes without a second full graph hash pass. */
export function assertOpenCodeV2DeliveryFileRow(snapshot: OpenCodeV2DeliverySnapshot, file: string, sha256: string): void {
  const relative = path.relative(snapshot.binding.root, file).split(path.sep).join('/')
  const row = inventories.get(snapshot)?.get(relative)
  assert(path.isAbsolute(file) && row && !relative.startsWith('../') && !path.isAbsolute(relative) && row.sha256 === sha256)
}

export async function verifyOpenCodeV2DeliveryFile(snapshot: OpenCodeV2DeliverySnapshot, file: string, sha256?: string): Promise<string> {
  assert(path.isAbsolute(file) && await realpath(file) === file)
  const relative = path.relative(snapshot.binding.root, file).split(path.sep).join('/')
  const row = inventories.get(snapshot)?.get(relative)
  assert(row && !relative.startsWith('../') && !path.isAbsolute(relative))
  const info = await lstat(file)
  assert(info.isFile() && !info.isSymbolicLink() && info.size === row.bytes &&
    (process.platform === 'win32' || ((info.mode & 0o111) !== 0) === row.executable))
  const actual = sha256 ?? await hashOpenCodeFile(file)
  assertOpenCodeV2DeliveryFileRow(snapshot, file, actual)
  return actual
}

export async function resolveOpenCodeV2DeliveryEntry(snapshot: OpenCodeV2DeliverySnapshot,
  name: 'opencodeV2Server' | 'opencodeV2ExecutionServer' | 'opencodeV2RunOwner'): Promise<Readonly<{ entryPath: string; entrySha256: string }>> {
  const entryPath = path.join(snapshot.root, `${name}.js`)
  return { entryPath, entrySha256: await verifyOpenCodeV2DeliveryFile(snapshot, entryPath) }
}
