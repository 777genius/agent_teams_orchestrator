import { expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { canonicalOpenCodeV2DeliveryManifest, validateOpenCodeV2DeliveryDescriptor, validateOpenCodeV2DeliveryManifest,
  type OpenCodeV2DeliveryDescriptor, type OpenCodeV2DeliveryManifest } from './OpenCodeV2DeliveryContract.js'
import { resolveInstalledOpenCodeV2Delivery, resolveOpenCodeV2Delivery, verifyOpenCodeV2DeliveryFile } from './OpenCodeV2DeliveryManifest.js'
import { openCodeBunVersion } from '../../../constants/openCodeBunVersion.js'
import { openCodeV2QualifiedVersions, openCodeV2LaunchRefusal } from '../compatibility/OpenCodeV2Registry.js'

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const names = ['opencode-v2-graphs.json', 'opencodeV2ExecutionServer.js', 'opencodeV2RunOwner.js', 'opencodeV2Server.js']
function manifest(platform = 'linux', arch = 'x64', engines: readonly string[] = ['2.0.0', '2.0.32', '2.1.4']): OpenCodeV2DeliveryManifest {
  return { schemaVersion: 1, runtimeVersion: '0.0.999', sourceCommit: 'a'.repeat(40), bridgeProtocol: 1, platform, arch,
    requiredBunVersion: openCodeBunVersion(platform), engineVersions: engines,
    files: names.map(name => ({ path: `local-cli/${name}`, bytes: 4, sha256: sha('TEST'), executable: false })) }
}
function descriptor(value: OpenCodeV2DeliveryManifest, raw = canonicalOpenCodeV2DeliveryManifest(value)): OpenCodeV2DeliveryDescriptor {
  const { files, ...identity } = value
  return { ...identity, archive: { file: `agent-teams-opencode-v2-support-${value.platform}-${value.arch}-v${value.runtimeVersion}.zip`,
    kind: 'zip', sha256: 'b'.repeat(64), bytes: 100, entries: files.length + 1,
    expandedBytes: files.reduce((sum, row) => sum + row.bytes, Buffer.byteLength(raw)) },
    manifest: { file: 'opencode-v2-engine-manifest.json', sha256: sha(raw), bytes: Buffer.byteLength(raw), files: files.length } }
}

test('published descriptor requires the exact qualified engine set and existing platform Bun pin', () => {
  const valid = descriptor(manifest())
  expect(validateOpenCodeV2DeliveryDescriptor(valid).engineVersions).toEqual(['2.0.0', '2.0.32', '2.1.4'])
  for (const change of [{ engineVersions: ['2.1.4'] }, { bridgeProtocol: 2 }, { sourceCommit: 'TEST' },
    { archive: { ...valid.archive, bytes: 1024 ** 3 + 1 } }, { manifest: { ...valid.manifest, files: 65_537 } }])
    expect(() => validateOpenCodeV2DeliveryDescriptor({ ...valid, ...change })).toThrow('opencode_v2_support_contract_invalid')
  expect(() => validateOpenCodeV2DeliveryDescriptor({ ...valid, platform: 'win32', requiredBunVersion: '1.3.11' })).toThrow()
})

test('manifest refuses self inventory, aliases, file-directory collisions and unsafe paths', () => {
  const valid = manifest(), row = valid.files[0]!
  for (const candidate of ['opencode-v2-engine-manifest.json', '../outside', '/outside', 'local-cli/../outside',
    'local-cli\\outside', 'local-cli/C:outside', 'local-cli/con', 'local-cli/file.'])
    expect(() => validateOpenCodeV2DeliveryManifest({ ...valid, files: [{ ...row, path: candidate }, ...valid.files] })).toThrow()
  const sorted = (rows: OpenCodeV2DeliveryManifest['files']) => [...rows].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
  expect(() => validateOpenCodeV2DeliveryManifest({ ...valid, files: sorted([...valid.files, { ...row, path: row.path.toUpperCase() }]) })).toThrow()
  expect(() => validateOpenCodeV2DeliveryManifest({ ...valid, files: sorted([...valid.files, { ...row, path: row.path + '/child' }]) })).toThrow()
})

const qualifiedHere = openCodeV2QualifiedVersions().filter(pin => openCodeV2LaunchRefusal(pin) === null)
test.skipIf(process.versions.bun !== openCodeBunVersion() || qualifiedHere.length === 0)('repair publishes B while a frozen A acquisition retains A; tampering still refuses', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-delivery-')))
  try {
    const value = manifest(process.platform, process.arch, qualifiedHere), raw = canonicalOpenCodeV2DeliveryManifest(value), pin = descriptor(value, raw)
    const parent = path.join(root, pin.runtimeVersion, `${pin.platform}-${pin.arch}`, pin.archive.sha256)
    async function install(instance: string) {
      const instanceRoot = path.join(parent, instance)
      await mkdir(path.join(instanceRoot, 'local-cli'), { recursive: true })
      for (const name of names) await writeFile(path.join(instanceRoot, 'local-cli', name), 'TEST', { mode: 0o644 })
      await writeFile(path.join(instanceRoot, pin.manifest.file), raw)
      await writeFile(path.join(parent, 'installed.json'), JSON.stringify({ schemaVersion: 1, runtimeVersion: pin.runtimeVersion,
        sourceCommit: pin.sourceCommit, bridgeProtocol: 1, platform: pin.platform, arch: pin.arch,
        archiveSha256: pin.archive.sha256, manifestSha256: pin.manifest.sha256, instance }))
      return instanceRoot
    }
    const firstRoot = await install(randomUUID()), first = await resolveInstalledOpenCodeV2Delivery(pin, root)
    const secondRoot = await install(randomUUID()), second = await resolveInstalledOpenCodeV2Delivery(pin, root)
    expect(first.binding.root).toBe(firstRoot); expect(second.binding.root).toBe(secondRoot)
    expect((await resolveOpenCodeV2Delivery(first.binding)).binding.root).toBe(firstRoot)
    const firstFile = path.join(first.root, names[1]!), secondFile = path.join(second.root, names[1]!)
    await writeFile(firstFile, 'EVIL')
    await expect(verifyOpenCodeV2DeliveryFile(first, firstFile)).rejects.toThrow('opencode_v2_support_identity_invalid')
    expect(await verifyOpenCodeV2DeliveryFile(second, secondFile)).toBe(sha('TEST'))
    const manifestFile = path.join(secondRoot, pin.manifest.file)
    const changedWhitespace = (await readFile(manifestFile, 'utf8')).replace('\n  "schemaVersion"', '\n "schemaVersion" ')
    expect(JSON.parse(changedWhitespace)).toEqual(JSON.parse(raw))
    await writeFile(manifestFile, changedWhitespace)
    await expect(resolveInstalledOpenCodeV2Delivery(pin, root)).rejects.toThrow('opencode_v2_support_identity_invalid')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test.skipIf(process.platform === 'win32' || process.versions.bun !== openCodeBunVersion() || qualifiedHere.length === 0)('native helper execute mode is part of the pinned manifest contract', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-mode-')))
  try {
    const base = manifest(process.platform, process.arch, qualifiedHere)
    const value = { ...base, files: base.files.map((row, index) => ({ ...row, executable: index === 1 })) }
    const raw = canonicalOpenCodeV2DeliveryManifest(value), pin = descriptor(value, raw), instance = randomUUID()
    const parent = path.join(root, pin.runtimeVersion, `${pin.platform}-${pin.arch}`, pin.archive.sha256), actual = path.join(parent, instance)
    await mkdir(path.join(actual, 'local-cli'), { recursive: true })
    for (const row of value.files) await writeFile(path.join(actual, row.path), 'TEST', { mode: row.executable ? 0o755 : 0o644 })
    await writeFile(path.join(actual, pin.manifest.file), raw)
    await writeFile(path.join(parent, 'installed.json'), JSON.stringify({ schemaVersion: 1, runtimeVersion: pin.runtimeVersion,
      sourceCommit: pin.sourceCommit, bridgeProtocol: 1, platform: pin.platform, arch: pin.arch,
      archiveSha256: pin.archive.sha256, manifestSha256: pin.manifest.sha256, instance }))
    const snapshot = await resolveInstalledOpenCodeV2Delivery(pin, root), file = path.join(actual, value.files[1]!.path)
    expect(await verifyOpenCodeV2DeliveryFile(snapshot, file)).toBe(sha('TEST'))
    await chmod(file, 0o644)
    await expect(verifyOpenCodeV2DeliveryFile(snapshot, file)).rejects.toThrow('opencode_v2_support_identity_invalid')
  } finally { await rm(root, { recursive: true, force: true }) }
})
