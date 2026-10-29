import { openCodeBunVersion } from '../../../constants/openCodeBunVersion.js'
import { isOpenCodeV2Pin, openCodeV2QualifiedVersions, openCodeV2LaunchRefusal } from '../compatibility/OpenCodeV2Registry.js'

export const OPENCODE_V2_SUPPORT_ROOT_ENV = 'CLAUDE_MULTIMODEL_OPENCODE_V2_SUPPORT_ROOT'
export const OPENCODE_V2_DELIVERY_MANIFEST_FILE = 'opencode-v2-engine-manifest.json'
export const OPENCODE_V2_DELIVERY_LIMITS = Object.freeze({ archive: 1024 ** 3, expanded: 4 * 1024 ** 3,
  file: 256 * 1024 ** 2, files: 65_536, entries: 100_000, manifest: 32 * 1024 ** 2, path: 1024 })
const HASH = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export const OPENCODE_V2_INSTANCE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

type DeliveryIdentity = Readonly<{ schemaVersion: 1; runtimeVersion: string; sourceCommit: string; bridgeProtocol: 1;
  platform: string; arch: string; requiredBunVersion: '1.3.11' | '1.4.3'; engineVersions: readonly string[] }>
export type OpenCodeV2DeliveryFile = Readonly<{ path: string; bytes: number; sha256: string; executable: boolean }>
export type OpenCodeV2DeliveryManifest = DeliveryIdentity & Readonly<{ files: readonly OpenCodeV2DeliveryFile[] }>
export type OpenCodeV2DeliveryDescriptor = DeliveryIdentity & Readonly<{
  archive: Readonly<{ file: string; kind: 'zip'; sha256: string; bytes: number; entries: number; expandedBytes: number }>
  manifest: Readonly<{ file: typeof OPENCODE_V2_DELIVERY_MANIFEST_FILE; sha256: string; bytes: number; files: number }>
}>
/** The private parent seals this location and manifest identity after checking its pinned descriptor. */
export type OpenCodeV2DeliveryBinding = Readonly<{ root: string; manifestSha256: string }>
export type OpenCodeV2DeliveryInstallReceipt = Readonly<{ schemaVersion: 1; runtimeVersion: string; sourceCommit: string;
  bridgeProtocol: 1; platform: string; arch: string; archiveSha256: string; manifestSha256: string; instance: string }>

function assert(value: unknown): asserts value { if (!value) throw new Error('opencode_v2_support_contract_invalid') }
function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  assert(Object.keys(value).sort().join(',') === [...expected].sort().join(','))
}
function bounded(value: unknown, maximum: number, minimum = 1): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}
const identityKeys = ['schemaVersion', 'runtimeVersion', 'sourceCommit', 'bridgeProtocol', 'platform', 'arch', 'requiredBunVersion', 'engineVersions']
function identity(row: Record<string, unknown>): DeliveryIdentity {
  assert(row.schemaVersion === 1 && row.bridgeProtocol === 1 && typeof row.runtimeVersion === 'string' && VERSION.test(row.runtimeVersion) &&
    typeof row.sourceCommit === 'string' && COMMIT.test(row.sourceCommit) && typeof row.platform === 'string' && typeof row.arch === 'string')
  const platform = `${row.platform}-${row.arch}`
  assert(['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64', 'win32-arm64'].includes(platform) && row.requiredBunVersion === openCodeBunVersion(row.platform))
  const expected = openCodeV2QualifiedVersions().filter(pin => openCodeV2LaunchRefusal(pin, platform) === null)
  assert(Array.isArray(row.engineVersions) && row.engineVersions.length > 0 && row.engineVersions.every(isOpenCodeV2Pin) &&
    JSON.stringify(row.engineVersions) === JSON.stringify(expected))
  return { schemaVersion: 1, runtimeVersion: row.runtimeVersion, sourceCommit: row.sourceCommit, bridgeProtocol: 1,
    platform: row.platform, arch: row.arch, requiredBunVersion: row.requiredBunVersion as DeliveryIdentity['requiredBunVersion'], engineVersions: Object.freeze([...row.engineVersions]) }
}

export function isOpenCodeV2DeliveryPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > OPENCODE_V2_DELIVERY_LIMITS.path ||
    /[\\:\x00-\x1f]/.test(value) || value.startsWith('/')) return false
  return value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part) &&
    !/^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(part))
}

export function validateOpenCodeV2DeliveryDescriptor(value: unknown): OpenCodeV2DeliveryDescriptor {
  const row = record(value); keys(row, [...identityKeys, 'archive', 'manifest'])
  const common = identity(row), archive = record(row.archive), manifest = record(row.manifest)
  keys(archive, ['file', 'kind', 'sha256', 'bytes', 'entries', 'expandedBytes']); keys(manifest, ['file', 'sha256', 'bytes', 'files'])
  assert(archive.file === `agent-teams-opencode-v2-support-${common.platform}-${common.arch}-v${common.runtimeVersion}.zip` && archive.kind === 'zip' &&
    typeof archive.sha256 === 'string' && HASH.test(archive.sha256) && bounded(archive.bytes, OPENCODE_V2_DELIVERY_LIMITS.archive) &&
    bounded(archive.entries, OPENCODE_V2_DELIVERY_LIMITS.entries) && bounded(archive.expandedBytes, OPENCODE_V2_DELIVERY_LIMITS.expanded) &&
    manifest.file === OPENCODE_V2_DELIVERY_MANIFEST_FILE && typeof manifest.sha256 === 'string' && HASH.test(manifest.sha256) &&
    bounded(manifest.bytes, OPENCODE_V2_DELIVERY_LIMITS.manifest) && bounded(manifest.files, OPENCODE_V2_DELIVERY_LIMITS.files) &&
    archive.entries >= manifest.files + 1 && archive.expandedBytes >= manifest.bytes)
  return Object.freeze({ ...common, archive: Object.freeze({ ...archive }) as OpenCodeV2DeliveryDescriptor['archive'],
    manifest: Object.freeze({ ...manifest }) as OpenCodeV2DeliveryDescriptor['manifest'] })
}

export function validateOpenCodeV2DeliveryManifest(value: unknown): OpenCodeV2DeliveryManifest {
  const row = record(value); keys(row, [...identityKeys, 'files']); const common = identity(row)
  assert(Array.isArray(row.files) && bounded(row.files.length, OPENCODE_V2_DELIVERY_LIMITS.files))
  const paths = new Set<string>(), directories = new Set<string>(); let previous = '', expanded = 0
  const files = row.files.map(value => {
    const item = record(value); keys(item, ['path', 'bytes', 'sha256', 'executable'])
    assert(isOpenCodeV2DeliveryPath(item.path) && item.path !== OPENCODE_V2_DELIVERY_MANIFEST_FILE && item.path.startsWith('local-cli/') &&
      bounded(item.bytes, OPENCODE_V2_DELIVERY_LIMITS.file, 0) && typeof item.sha256 === 'string' && HASH.test(item.sha256) && typeof item.executable === 'boolean')
    assert(!previous || Buffer.compare(Buffer.from(previous), Buffer.from(item.path)) < 0); previous = item.path
    const key = item.path.toLowerCase(); assert(!paths.has(key) && !directories.has(key)); paths.add(key)
    const parts = key.split('/'); parts.pop()
    while (parts.length) { const directory = parts.join('/'); assert(!paths.has(directory)); directories.add(directory); parts.pop() }
    expanded += item.bytes; assert(expanded <= OPENCODE_V2_DELIVERY_LIMITS.expanded)
    return Object.freeze({ path: item.path, bytes: item.bytes, sha256: item.sha256, executable: item.executable }) as OpenCodeV2DeliveryFile
  })
  for (const entry of ['opencodeV2Server.js', 'opencodeV2ExecutionServer.js', 'opencodeV2RunOwner.js', 'opencode-v2-graphs.json'])
    assert(paths.has(`local-cli/${entry.toLowerCase()}`))
  assert(!paths.has('local-cli/cli.js'))
  return Object.freeze({ ...common, files: Object.freeze(files) })
}

export function canonicalOpenCodeV2DeliveryManifest(value: OpenCodeV2DeliveryManifest): string {
  const manifest = validateOpenCodeV2DeliveryManifest(value)
  return JSON.stringify(manifest, null, 2) + '\n'
}

export function validateOpenCodeV2DeliveryInstallReceipt(value: unknown, descriptor: OpenCodeV2DeliveryDescriptor): OpenCodeV2DeliveryInstallReceipt {
  const row = record(value); keys(row, ['schemaVersion', 'runtimeVersion', 'sourceCommit', 'bridgeProtocol', 'platform', 'arch', 'archiveSha256', 'manifestSha256', 'instance'])
  for (const key of ['schemaVersion', 'runtimeVersion', 'sourceCommit', 'bridgeProtocol', 'platform', 'arch'] as const) assert(row[key] === descriptor[key])
  assert(row.archiveSha256 === descriptor.archive.sha256 && row.manifestSha256 === descriptor.manifest.sha256 && typeof row.instance === 'string' && OPENCODE_V2_INSTANCE_ID.test(row.instance))
  return Object.freeze({ ...row }) as OpenCodeV2DeliveryInstallReceipt
}
