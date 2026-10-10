import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { validatePackagedOpenCodeIdentity } from '../../src/cli/packagedOpenCodeDelivery.js'

const candidate = process.env.CANDIDATE_PLATFORM
if (candidate !== 'linux-x64' && candidate !== 'win32-x64') throw new Error('Unsupported candidate platform')
const [platform, arch] = candidate.split('-')
const identity = validatePackagedOpenCodeIdentity(JSON.parse(readFileSync('dist/opencode-delivery.json', 'utf8')))
if (identity.platform !== platform || identity.arch !== arch || identity.bunVersion !== '1.3.11') {
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
  'dist/local-cli/opencodeV2ExecutionServer.js', 'dist/local-cli/opencodeV2RunOwner.js']) {
  if (!existsSync(file)) throw new Error('Portable graph missing')
}
const metadata: unknown = JSON.parse(readFileSync('package.json', 'utf8'))
if (!metadata || typeof metadata !== 'object' || !('version' in metadata) ||
  typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(metadata.version)) throw new Error('Invalid runtime version')
writeFileSync('candidate/runtime/VERSION', metadata.version + '\n')
