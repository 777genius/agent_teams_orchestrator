import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import type * as OwnerAnchorLibrary from '@agent-teams/owner-anchor-library'

const PUBLIC_ENTRY = 'lib/src/features/team-runtime-control/main/infrastructure/process-supervision/OwnerAnchorLibrary.js'
const PROVENANCE = 'provenance.json'
const NATIVE_ARTIFACT = 'native/process-anchor'
const MAX_PROVENANCE_BYTES = 512 * 1024
const MAX_OUTPUTS = 256

export type HostedOwnerAnchorLibrary = typeof OwnerAnchorLibrary

export type HostedOwnerAnchorLibraryAdmission = Readonly<{
  /** Opaque evidence from the image/admission owner. This loader does not verify its signature. */
  admissionId: string
  packageRoot: string
  expectedProvenanceSha256: `sha256:${string}`
  expectedNativeSha256: `sha256:${string}`
}>

export type LoadedHostedOwnerAnchorLibrary = Readonly<{
  library: HostedOwnerAnchorLibrary
  anchorExecutablePath: string
  admission: HostedOwnerAnchorLibraryAdmission
}>

type ProvenanceOutput = { path: string; bytes: number; sha256: string }

/**
 * Loads only a caller-admitted, private, absolute package root. Exact provenance bytes are checked
 * first, then every declared output is checked before the public ESM entry is imported. Integrity
 * is deliberately not treated as a signature or as admission.
 */
export async function loadHostedOwnerAnchorLibrary(
  admission: HostedOwnerAnchorLibraryAdmission,
): Promise<LoadedHostedOwnerAnchorLibrary> {
  requireAdmission(admission)
  const packageRoot = await canonicalDirectory(admission.packageRoot, 'owner-anchor-package-root')
  const provenancePath = path.join(packageRoot, PROVENANCE)
  const provenanceBytes = await readCanonicalFile(provenancePath, MAX_PROVENANCE_BYTES)
  if (sha256(provenanceBytes) !== admission.expectedProvenanceSha256) {
    throw new Error('owner-anchor-provenance-integrity-mismatch')
  }

  const provenance = parseProvenance(provenanceBytes)
  requireExpectedProvenance(provenance, admission.expectedNativeSha256)
  const outputs = parseOutputs(provenance.outputs)
  const outputPaths = new Set(outputs.map(output => output.path))
  if (!outputPaths.has(PUBLIC_ENTRY) || !outputPaths.has(NATIVE_ARTIFACT)) {
    throw new Error('owner-anchor-required-output-missing')
  }
  await Promise.all(outputs.map(async output => {
    const absolute = path.join(packageRoot, output.path)
    const bytes = await readCanonicalFile(absolute, output.bytes)
    if (bytes.byteLength !== output.bytes || sha256(bytes) !== output.sha256) {
      throw new Error(`owner-anchor-output-integrity-mismatch:${output.path}`)
    }
  }))

  const entryPath = path.join(packageRoot, PUBLIC_ENTRY)
  const nativePath = path.join(packageRoot, NATIVE_ARTIFACT)
  if (sha256(await readCanonicalFile(nativePath)) !== admission.expectedNativeSha256) {
    throw new Error('owner-anchor-native-integrity-mismatch')
  }
  const library = await import(pathToFileURL(entryPath).href) as HostedOwnerAnchorLibrary
  requirePublicApi(library)
  return Object.freeze({
    library,
    anchorExecutablePath: nativePath,
    admission: Object.freeze({ ...admission, packageRoot }),
  })
}

function requireAdmission(value: HostedOwnerAnchorLibraryAdmission): void {
  if (!value || typeof value.admissionId !== 'string' || value.admissionId.length < 16 ||
    !path.isAbsolute(value.packageRoot) || value.packageRoot.includes('\0') ||
    !isSha256(value.expectedProvenanceSha256) || !isSha256(value.expectedNativeSha256)) {
    throw new TypeError('owner-anchor-admission-invalid')
  }
}

async function canonicalDirectory(value: string, diagnostic: string): Promise<string> {
  const canonical = await realpath(value)
  const stat = await lstat(value)
  if (canonical !== value || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new TypeError(`${diagnostic}-invalid`)
  }
  return canonical
}

async function readCanonicalFile(value: string, maximumBytes = Number.MAX_SAFE_INTEGER): Promise<Buffer> {
  const canonical = await realpath(value)
  const stat = await lstat(value)
  if (canonical !== value || stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > maximumBytes) {
    throw new TypeError('owner-anchor-output-not-canonical-file')
  }
  const handle = await open(value, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) {
      throw new TypeError('owner-anchor-output-replaced')
    }
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

function parseProvenance(bytes: Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('owner-anchor-provenance-invalid')
  return value as Record<string, unknown>
}

function requireExpectedProvenance(value: Record<string, unknown>, expectedNativeSha256: string): void {
  const capability = value.capability
  if (value.schemaVersion !== 1 || value.artifact !== 'owner-anchor-library' ||
    value.trust !== 'provenance-only-not-signature-or-admission' ||
    !capability || typeof capability !== 'object' || Array.isArray(capability)) {
    throw new TypeError('owner-anchor-provenance-contract-invalid')
  }
  const record = capability as Record<string, unknown>
  if (record.lifecycleProtocolVersion !== 1 || record.providerStdioVersion !== 1 ||
    record.providerStdioHash !== 'sha256:8ef0fab620172bdb761af87fc471cb3a1abb46710f148037762cee5d403720b5' ||
    record.nativeSha256 !== expectedNativeSha256) {
    throw new TypeError('owner-anchor-provenance-capability-invalid')
  }
}

function parseOutputs(value: unknown): readonly ProvenanceOutput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_OUTPUTS) {
    throw new TypeError('owner-anchor-provenance-outputs-invalid')
  }
  const seen = new Set<string>()
  return Object.freeze(value.map((item): ProvenanceOutput => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('owner-anchor-output-invalid')
    const output = item as Record<string, unknown>
    if (typeof output.path !== 'string' || !isSafeRelativePath(output.path) || seen.has(output.path) ||
      !Number.isSafeInteger(output.bytes) || (output.bytes as number) < 1 || !isSha256(output.sha256)) {
      throw new TypeError('owner-anchor-output-invalid')
    }
    seen.add(output.path)
    return Object.freeze({ path: output.path, bytes: output.bytes as number, sha256: output.sha256 })
  }))
}

function isSafeRelativePath(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !value.includes('\0') && !path.isAbsolute(value) &&
    path.posix.normalize(value) === value && value !== '..' && !value.startsWith('../') && !value.includes('/../')
}

function isSha256(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function requirePublicApi(library: HostedOwnerAnchorLibrary): void {
  for (const name of ['AnchorProcessSupervisorAdapter', 'NodeAnchorLaunchMaterializer', 'NodeAnchorSpawner',
    'parseOwnedProcessRef', 'parseSpawnNonce', 'parseProcessControllerInstanceId', 'parseProcessOwnerBinding']) {
    if (typeof (library as unknown as Record<string, unknown>)[name] !== 'function') {
      throw new TypeError(`owner-anchor-public-api-missing:${name}`)
    }
  }
  if (library.NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_VERSION !== 1 ||
    library.NODE_ANCHOR_PROVIDER_STDIO_CAPABILITY_HASH !== 'sha256:8ef0fab620172bdb761af87fc471cb3a1abb46710f148037762cee5d403720b5') {
    throw new TypeError('owner-anchor-public-api-capability-mismatch')
  }
}
