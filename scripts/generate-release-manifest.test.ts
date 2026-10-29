import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openCodeBunVersion } from '../src/constants/openCodeBunVersion.js'
import { openCodeV2ReleaseContract } from '../src/services/opencode/compatibility/OpenCodeV2Registry.js'
import { generateRuntimeReleaseManifest } from './generate-release-manifest.js'

const platforms = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-arm64', 'win32-x64'] as const
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
async function fixture() {
  const releaseDirectory = await mkdtemp(path.join(os.tmpdir(), 'TEST-v2-release-roster-'))
  const options = { releaseDirectory, runtimeVersion: '0.0.999', sourceCommit: 'c'.repeat(40), targetReleaseTag: 'runtime-v0.0.999' }
  for (const key of platforms) {
    const directory = path.join(releaseDirectory, 'metadata', key)
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'VERSION'), options.runtimeVersion + '\n')
    await writeFile(path.join(directory, 'COMMIT_SHA'), options.sourceCommit + '\n')
    await writeFile(path.join(releaseDirectory, `agent-teams-runtime-${key}-v0.0.999.${key.startsWith('win32-') ? 'zip' : 'tar.gz'}`), `TEST base ${key}`)
    const engines = openCodeV2ReleaseContract().qualified[key]
    if (engines.length === 0) continue
    const [platform, arch] = key.split('-'), bytes = `TEST support ${key}`
    const file = `agent-teams-opencode-v2-support-${key}-v0.0.999.zip`
    await writeFile(path.join(releaseDirectory, file), bytes)
    await writeFile(path.join(directory, 'opencode-v2-delivery.json'), JSON.stringify({ schemaVersion: 1,
      runtimeVersion: options.runtimeVersion, sourceCommit: options.sourceCommit, bridgeProtocol: 1, platform, arch,
      requiredBunVersion: openCodeBunVersion(platform), engineVersions: engines,
      archive: { file, kind: 'zip', sha256: sha(bytes), bytes: Buffer.byteLength(bytes), entries: 5, expandedBytes: 512 },
      manifest: { file: 'opencode-v2-engine-manifest.json', sha256: 'b'.repeat(64), bytes: 256, files: 4 } }))
  }
  return options
}

test('release aggregation preserves all platform sidecars and derives the complete public roster', async () => {
  const f = await fixture()
  try {
    const { manifest, publicAssets } = generateRuntimeReleaseManifest(f)
    expect(Object.keys(manifest.assets)).toHaveLength(5)
    expect(Object.keys(manifest.opencodeV2Delivery)).toEqual(['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'])
    expect(publicAssets).toHaveLength(11)
    expect(publicAssets.filter(name => name.startsWith('agent-teams-opencode-v2-support-'))).toHaveLength(4)
    const sums = await readFile(path.join(f.releaseDirectory, 'agent-teams-runtime-SHA256SUMS-v0.0.999'), 'utf8')
    for (const descriptor of Object.values(manifest.opencodeV2Delivery)) expect(sums).toContain(`${descriptor!.archive.sha256}  ${descriptor!.archive.file}\n`)
    expect((await readFile(path.join(f.releaseDirectory, 'expected-assets.txt'), 'utf8')).trim().split('\n')).toEqual(publicAssets)
  } finally { await rm(f.releaseDirectory, { recursive: true, force: true }) }
})

test('aggregation rejects a platform built from another source and support bytes changed after staging', async () => {
  const f = await fixture()
  try {
    const commit = path.join(f.releaseDirectory, 'metadata/darwin-x64/COMMIT_SHA')
    await writeFile(commit, 'd'.repeat(40))
    expect(() => generateRuntimeReleaseManifest(f)).toThrow('Base runtime source mismatch')
    await writeFile(commit, f.sourceCommit)
    await writeFile(path.join(f.releaseDirectory, 'agent-teams-opencode-v2-support-darwin-x64-v0.0.999.zip'), 'TEST modified')
    expect(() => generateRuntimeReleaseManifest(f)).toThrow('archive changed')
  } finally { await rm(f.releaseDirectory, { recursive: true, force: true }) }
})
