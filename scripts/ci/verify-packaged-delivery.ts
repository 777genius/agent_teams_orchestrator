import { openCodeBunVersion } from '../../src/constants/openCodeBunVersion.js'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { validatePackagedOpenCodeIdentity } from '../../src/cli/packagedOpenCodeDelivery.js'
import { validateOpenCodeV2DeliveryDescriptor, validateOpenCodeV2DeliveryManifest } from '../../src/services/opencode/host/OpenCodeV2DeliveryContract.js'

const candidate = process.env.CANDIDATE_PLATFORM
if (candidate !== 'linux-x64' && candidate !== 'win32-x64') throw new Error('Unsupported candidate platform')
const [platform, arch] = candidate.split('-')
const identity = validatePackagedOpenCodeIdentity(JSON.parse(readFileSync('dist/opencode-delivery.json', 'utf8')))
if (identity.platform !== platform || identity.arch !== arch || identity.bunVersion !== openCodeBunVersion(platform)) {
  throw new Error('Delivery identity mismatch')
}
const digests: readonly (readonly [string, string])[] = [
  [platform === 'win32' ? 'dist/bun/bun.exe' : 'dist/bun/bun', identity.bunSha256],
  ['dist/local-cli/cli.js', identity.entrySha256],
]
for (const [file, digest] of digests) {
  if (createHash('sha256').update(readFileSync(file)).digest('hex') !== digest) throw new Error('Delivery digest mismatch')
}
for (const file of ['dist/local-cli/opencode-v2-graphs.json', 'dist/local-cli/opencodeV2Server.js',
  'dist/local-cli/opencodeV2ExecutionServer.js', 'dist/local-cli/opencodeV2RunOwner.js', 'dist/local-cli/node_modules']) {
  if (existsSync(file)) throw new Error('Optional V2 bytes leaked into the graph-free base')
}
const metadata: unknown = JSON.parse(readFileSync('package.json', 'utf8'))
if (!metadata || typeof metadata !== 'object' || !('version' in metadata) ||
  typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(metadata.version)) throw new Error('Invalid runtime version')
const descriptor = validateOpenCodeV2DeliveryDescriptor(JSON.parse(readFileSync('dist/opencode-v2-delivery.json', 'utf8')))
if (`${descriptor.platform}-${descriptor.arch}` !== candidate || descriptor.runtimeVersion !== metadata.version ||
  descriptor.sourceCommit !== process.env.CANDIDATE_SOURCE_SHA) throw new Error('Optional V2 source identity mismatch')
const manifestBytes = readFileSync('dist/opencode-v2-support/opencode-v2-engine-manifest.json')
if (manifestBytes.length !== descriptor.manifest.bytes || createHash('sha256').update(manifestBytes).digest('hex') !== descriptor.manifest.sha256) {
  throw new Error('Optional V2 manifest identity mismatch')
}
const manifest = validateOpenCodeV2DeliveryManifest(JSON.parse(manifestBytes.toString('utf8')))
if (manifest.files.length !== descriptor.manifest.files) throw new Error('Optional V2 inventory mismatch')
const archive = readFileSync(`dist/${descriptor.archive.file}`)
if (archive.length !== descriptor.archive.bytes || createHash('sha256').update(archive).digest('hex') !== descriptor.archive.sha256) {
  throw new Error('Optional V2 archive identity mismatch')
}
writeFileSync('candidate/runtime/VERSION', metadata.version + '\n')
