import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { openCodeBunVersion } from '../src/constants/openCodeBunVersion.js'
import { openCodeV2ReleaseContract } from '../src/services/opencode/compatibility/OpenCodeV2Registry.js'
import { validateOpenCodeV2DeliveryDescriptor, type OpenCodeV2DeliveryDescriptor } from '../src/services/opencode/host/OpenCodeV2DeliveryContract.js'
import runtimeBunPins from './runtime-bun-pins.json' with { type: 'json' }

type Platform = keyof typeof runtimeBunPins.assets
const platforms = (Object.keys(runtimeBunPins.assets) as Platform[]).sort()
type BaseAsset = { file: string; archiveKind: 'tar.gz' | 'zip'; binaryName: string; sha256: string }
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Aggregate one actual build's platform sidecars before flattening its public asset roster. */
export function generateRuntimeReleaseManifest(options: {
  releaseDirectory: string; runtimeVersion: string; targetReleaseTag: string; sourceCommit: string
  sourceRepository?: string; sourceRef?: string
}) {
  const { releaseDirectory, runtimeVersion, sourceCommit } = options
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(runtimeVersion) || !/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error('Runtime release version/source identity is required')
  }
  const manifestFile = `agent-teams-runtime-manifest-v${runtimeVersion}.json`
  const checksumsFile = `agent-teams-runtime-SHA256SUMS-v${runtimeVersion}`
  const qualification = openCodeV2ReleaseContract()
  const manifest = {
    version: runtimeVersion, targetReleaseTag: options.targetReleaseTag, generatedAt: new Date().toISOString(),
    sourceRepository: options.sourceRepository, sourceRef: options.sourceRef, sourceCommit, bridgeProtocol: 1 as const,
    opencodeV2: qualification,
    opencodeV2Delivery: {} as Partial<Record<Platform, OpenCodeV2DeliveryDescriptor>>,
    assets: {} as Record<Platform, BaseAsset>,
  }
  const checksums = new Map<string, string>()
  for (const platformKey of platforms) {
    const metadata = path.join(releaseDirectory, 'metadata', platformKey)
    if (readFileSync(path.join(metadata, 'VERSION'), 'utf8').trim() !== runtimeVersion ||
      readFileSync(path.join(metadata, 'COMMIT_SHA'), 'utf8').trim() !== sourceCommit) throw new Error(`Base runtime source mismatch: ${platformKey}`)
    const archiveKind = platformKey.startsWith('win32-') ? 'zip' as const : 'tar.gz' as const
    const file = `agent-teams-runtime-${platformKey}-v${runtimeVersion}.${archiveKind}`
    const binaryName = platformKey.startsWith('win32-') ? 'claude-multimodel.exe' : 'claude-multimodel'
    const digest = sha(readFileSync(path.join(releaseDirectory, file)))
    manifest.assets[platformKey] = { file, archiveKind, binaryName, sha256: digest }
    checksums.set(file, digest)
    const sidecar = path.join(metadata, 'opencode-v2-delivery.json')
    const engines = qualification.qualified[platformKey]
    if (engines.length === 0) {
      if (existsSync(sidecar)) throw new Error(`Unqualified V2 release sidecar: ${platformKey}`)
      continue
    }
    const descriptor = validateOpenCodeV2DeliveryDescriptor(JSON.parse(readFileSync(sidecar, 'utf8')))
    if (`${descriptor.platform}-${descriptor.arch}` !== platformKey || descriptor.runtimeVersion !== runtimeVersion ||
      descriptor.sourceCommit !== sourceCommit || descriptor.bridgeProtocol !== manifest.bridgeProtocol ||
      descriptor.requiredBunVersion !== openCodeBunVersion(descriptor.platform) ||
      JSON.stringify(descriptor.engineVersions) !== JSON.stringify(engines)) throw new Error(`V2 release sidecar identity mismatch: ${platformKey}`)
    const support = readFileSync(path.join(releaseDirectory, descriptor.archive.file))
    if (support.length !== descriptor.archive.bytes || sha(support) !== descriptor.archive.sha256) throw new Error(`V2 release archive changed: ${platformKey}`)
    manifest.opencodeV2Delivery[platformKey] = descriptor
    checksums.set(descriptor.archive.file, descriptor.archive.sha256)
  }
  const archiveNames = [...checksums.keys()].sort()
  writeFileSync(path.join(releaseDirectory, manifestFile), JSON.stringify(manifest, null, 2) + '\n')
  writeFileSync(path.join(releaseDirectory, checksumsFile), archiveNames.map(name => `${checksums.get(name)}  ${name}\n`).join(''))
  const publicAssets = [...archiveNames, manifestFile, checksumsFile].sort()
  writeFileSync(path.join(releaseDirectory, 'expected-assets.txt'), publicAssets.join('\n') + '\n')
  return { manifest, publicAssets }
}

if (import.meta.main) {
  const runtimeVersion = process.env.RUNTIME_VERSION, targetReleaseTag = process.env.TARGET_RELEASE_TAG
  const sourceCommit = process.env.RUNTIME_SOURCE_COMMIT ?? process.env.GITHUB_SHA
  if (!runtimeVersion || !targetReleaseTag || !sourceCommit) throw new Error('Runtime release environment is incomplete')
  generateRuntimeReleaseManifest({ releaseDirectory: path.join(process.cwd(), 'release-flat'), runtimeVersion, targetReleaseTag,
    sourceCommit, sourceRepository: process.env.GITHUB_REPOSITORY, sourceRef: process.env.RUNTIME_SOURCE_REF ?? process.env.GITHUB_REF_NAME })
}
