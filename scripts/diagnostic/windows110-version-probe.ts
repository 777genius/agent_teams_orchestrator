import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createOpenCodeV2ReadRoots } from '../../src/services/opencode/profile/OpenCodeV2ManagedConfig.js'
import { readOpenCodeOwnedVersion } from '../../src/services/opencode/compatibility/OpenCodeVersionProbe.js'

const packageName = 'opencode-windows-x64'
const version = '1.19.0'
const archiveSri = 'sha512-FsCVPchl5kjXg/UWGOtc2HuD5Fz+o6LtszUVdlVGmfVA+j/o0fSxjcYBHmIAU9/7P3KezAoQ2kL8YNn40O1DwQ=='
const executableSha256 = 'bb731f311416df16691fa16763eb87657c4a5f5f3bcff5202718c416e8f7ab1a'
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

async function anonymousRegistryBytes(url: string, cap: number): Promise<Buffer> {
  const selected = new URL(url)
  assert.equal(selected.origin, 'https://registry.npmjs.org')
  assert(!selected.username && !selected.password)
  const response = await fetch(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(60000) })
  assert(response.ok, `Official registry HTTP ${response.status}`)
  assert(response.body, 'Official registry response has no body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      assert(size <= cap, 'Official registry response exceeds diagnostic cap')
      chunks.push(next.value)
    }
  } finally { await reader.cancel() }
  return Buffer.concat(chunks)
}

// Validate every header before writing one canonical regular executable.
// No tar entry path is passed to a filesystem extractor; links/overrides fail closed.
function canonicalNativeBytes(archive: Buffer): Buffer {
  const tar = gunzipSync(archive, { maxOutputLength: 512 * 1024 * 1024 })
  const names = new Set<string>()
  let executable: Buffer | undefined
  let manifest: Buffer | undefined
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(value => value === 0)) {
      assert(tar.subarray(offset).every(value => value === 0), 'Unexpected tar trailing data')
      assert(executable && manifest, 'Canonical package binary/manifest missing')
      const identity = JSON.parse(manifest.toString('utf8')) as { name?: unknown; version?: unknown }
      assert.equal(identity.name, packageName)
      assert.equal(identity.version, version)
      return executable
    }
    const field = (start: number, length: number): string => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')
    const octal = (value: string): number => {
      assert(/^[0-7]+$/.test(value.trim()), 'Unsupported tar number')
      const number = Number.parseInt(value.trim(), 8)
      assert(Number.isSafeInteger(number), 'Unsafe tar size')
      return number
    }
    let checksum = 0
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index]!
    assert.equal(checksum, octal(field(148, 8)), 'Tar checksum mismatch')
    const prefix = field(345, 155)
    const name = (prefix ? `${prefix}/` : '') + field(0, 100)
    const type = field(156, 1)
    const size = octal(field(124, 12))
    assert(['', '0', '5'].includes(type), 'Tar links/special entries/path overrides refused')
    const clean = name.replace(/\/$/, '')
    assert(clean === 'package' ? type === '5' : clean.startsWith('package/'), 'Foreign package archive path')
    assert(!clean.includes('\\') && !clean.includes(':'), 'Package path alias refused')
    assert(clean.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)), 'Package path alias refused')
    assert(!names.has(clean.toLowerCase()), 'Duplicate package path refused')
    names.add(clean.toLowerCase())
    assert(offset + 512 + size <= tar.length && (type !== '5' || size === 0), 'Truncated/invalid tar entry')
    const body = tar.subarray(offset + 512, offset + 512 + size)
    if (clean === 'package/bin/opencode.exe') { assert(type !== '5'); executable = body }
    if (clean === 'package/package.json') { assert(type !== '5'); manifest = body }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('Missing tar terminator')
}

assert.equal(process.platform, 'win32')
assert.equal(process.arch, 'x64')
assert.equal(process.env.TEST_SOURCE_COMMIT, 'd64fda3f249153e1d6a828817343a508053099b9')
assert(process.env.TEST_VERSION_DIAGNOSTIC_TRACE)
assert(/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? ''), 'Harness commit missing')
const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'TEST-win110-native-version-observation-'))
const metadataUrl = `https://registry.npmjs.org/${packageName}/${version}`
const metadataBytes = await anonymousRegistryBytes(metadataUrl, 4 * 1024 * 1024)
const metadata = JSON.parse(metadataBytes.toString('utf8')) as { name?: unknown; version?: unknown; dist?: { tarball?: unknown; integrity?: unknown } }
assert.equal(metadata.name, packageName)
assert.equal(metadata.version, version)
assert.equal(metadata.dist?.integrity, archiveSri)
const tarballUrl = `https://registry.npmjs.org/${packageName}/-/${packageName}-${version}.tgz`
assert.equal(metadata.dist?.tarball, tarballUrl)
const archive = await anonymousRegistryBytes(tarballUrl, 256 * 1024 * 1024)
assert.equal(`sha512-${createHash('sha512').update(archive).digest('base64')}`, archiveSri, 'Pinned archive SRI mismatch')
const nativeBytes = canonicalNativeBytes(archive)
assert.equal(sha256(nativeBytes), executableSha256, 'Product native byte binding mismatch')
const executable = path.join(fixtureRoot, 'opencode.exe')
await writeFile(executable, nativeBytes, { flag: 'wx' })
const acquisition = { packageName, version, metadataUrl, metadataSha256: sha256(metadataBytes), tarballUrl, archiveSri, archiveSha256: sha256(archive), archiveBytes: archive.length, executable, executableSha256, executableBytes: nativeBytes.length, anonymous: true }
const roots = await createOpenCodeV2ReadRoots()
const started = Date.now()
let result: unknown
try {
  // Its first native invocation: no separate warm-up, retries or holds.
  result = { status: 'RETURNED', version: await readOpenCodeOwnedVersion(executable, roots), elapsedMs: Date.now() - started }
} catch (error) {
  result = { status: 'THREW', name: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message : 'unknown', elapsedMs: Date.now() - started }
}
await writeFile(process.env.TEST_VERSION_DIAGNOSTIC_RESULT ?? path.join(fixtureRoot, 'result.json'), JSON.stringify({ schema: 2, diagnosticOnly: true, sourceCommit: process.env.TEST_SOURCE_COMMIT, harnessCommit: process.env.GITHUB_SHA, bunVersion: process.versions.bun, acquisition, fixtureRoot, privateRoot: roots.root, result, noModel: true, cleanup: 'Retained; no extra kill authority or acceptance change' }, null, 2))
console.log(JSON.stringify({ fixtureRoot, result }))
