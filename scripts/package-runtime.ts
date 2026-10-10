import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { unzipSync } from 'fflate'
import { validatePackagedOpenCodeIdentity } from '../src/cli/packagedOpenCodeDelivery.js'

const args = process.argv.slice(2)
const option = (name: string) => args[args.indexOf(name) + 1]
const platform = option('--platform')
const pins = JSON.parse(await readFile(new URL('./runtime-bun-pins.json', import.meta.url), 'utf8')) as {
  version: '1.3.11'; assets: Record<string, { file: string; sha256: string; entry: string }>
}
if (!args.includes('--platform') || !platform || !Object.hasOwn(pins.assets, platform) || pins.version !== '1.3.11') {
  throw new Error('Unsupported runtime release platform')
}
type Asset = { file: string; sha256: string; entry: string }
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function pinnedBinary(selected: Asset, localArchive?: string): Promise<Uint8Array> {
  const archive = localArchive ? await readFile(path.resolve(localArchive)) :
    new Uint8Array(await (async () => {
      const response = await fetch(`https://github.com/oven-sh/bun/releases/download/bun-v${pins.version}/${selected.file}`, {
        signal: AbortSignal.timeout(120_000),
      })
      if (!response.ok) throw new Error('Pinned Bun archive download failed')
      return response.arrayBuffer()
    })())
  if (sha(archive) !== selected.sha256) throw new Error('Pinned Bun archive checksum mismatch')
  const binary = unzipSync(archive)[selected.entry]
  if (!binary || binary.length === 0) throw new Error('Pinned Bun archive entry missing')
  return binary
}
async function stageBinary(directory: string, target: string, binary: Uint8Array): Promise<string> {
  await mkdir(directory, { recursive: true })
  const file = path.resolve(directory, target.startsWith('win32-') ? 'bun.exe' : 'bun')
  await writeFile(file, binary)
  if (!target.startsWith('win32-')) await chmod(file, 0o755)
  return file
}
const binary = await pinnedBinary(pins.assets[platform]!, args.includes('--bun-archive') ? option('--bun-archive') : undefined)
const shipped = await stageBinary('./dist/bun', platform, binary)
// The physical delivery is parsed by 1.3.11. A newer compiler's minifier may
// emit syntax it cannot parse, so build that JS with the exact shipped version.
// Cross-compiled assets use the same pinned version's runnable host executable.
const host = `${process.platform}-${process.arch}`
if (!Object.hasOwn(pins.assets, host)) throw new Error('Unsupported runtime release build host')
const jsBuilder = host === platform ? shipped :
  await stageBinary('./dist/build-bun', host, await pinnedBinary(pins.assets[host]!))
function build(executable: string, buildArgs: string[]): void {
  const result = Bun.spawnSync({ cmd: [executable, './scripts/build.ts', ...buildArgs], stdout: 'inherit', stderr: 'inherit' })
  if (result.exitCode !== 0) throw new Error('Runtime delivery build failed')
}
build(jsBuilder, ['--portable-graph', `--release-platform=${platform}`])
const [targetPlatform, arch] = platform.split('-')
const identity = validatePackagedOpenCodeIdentity({ schema: 1, platform: targetPlatform, arch,
  bunVersion: pins.version, bunSha256: sha(binary), entrySha256: sha(await readFile('./dist/local-cli/cli.js')) })
await writeFile('./dist/opencode-delivery.json', JSON.stringify(identity, null, 2) + '\n')
build(process.execPath, ['--compile', '--packaged-delivery'])
console.log(`Prepared compiled front door, physical graph and pinned Bun for ${platform}`)
