import { createHash } from 'node:crypto'

export type RuntimeReleasePlatform =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-x64'
  | 'win32-arm64'
  | 'win32-x64'

export type RuntimeArchiveLayout = Readonly<{
  binaryName: string
  authorityName: string
  launcherName: string
  entries: readonly string[]
}>

const PLATFORMS = new Set<RuntimeReleasePlatform>([
  'darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-arm64', 'win32-x64',
])

export function runtimeArchiveLayout(platform: RuntimeReleasePlatform): RuntimeArchiveLayout {
  if (!PLATFORMS.has(platform)) throw new Error(`Unsupported runtime release platform: ${platform}`)
  const windows = platform.startsWith('win32-')
  const binaryName = `claude-multimodel${windows ? '.exe' : ''}`
  const authorityName = `opencode-catalog-authority${windows ? '.exe' : ''}`
  const launcherName = `opencode-catalog-launcher${windows ? '.exe' : ''}`
  return Object.freeze({
    binaryName,
    authorityName,
    launcherName,
    entries: Object.freeze([
      'runtime/',
      `runtime/${binaryName}`,
      `runtime/${authorityName}`,
      `runtime/${launcherName}`,
      'runtime/NATIVE_SHA256SUMS',
      'runtime/VERSION',
      'runtime/COMMIT_SHA',
    ]),
  })
}

export function assertRuntimeArchiveLayout(
  platform: RuntimeReleasePlatform,
  unsafeEntries: readonly string[],
): void {
  const normalize = (entry: string) => entry.replace(/^\.\//, '').replaceAll('\\', '/')
  const actual = [...new Set(unsafeEntries.map(normalize).filter(Boolean))].sort()
  const expected = [...runtimeArchiveLayout(platform).entries].sort()
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    throw new Error(`Invalid ${platform} runtime archive layout: ${JSON.stringify(actual)}`)
  }
}

export function assertRuntimeNativeChecksums(platform: RuntimeReleasePlatform, checksumFile: string,
  files: Readonly<Record<string, Uint8Array>>): void {
  const layout = runtimeArchiveLayout(platform)
  const expectedNames = [layout.authorityName, layout.launcherName].sort()
  const rows = checksumFile.trim().split(/\r?\n/).map(line => {
    const match = /^([0-9a-fA-F]{64})  ([^/\\]+)$/.exec(line)
    if (!match) throw new Error(`Invalid ${platform} native checksum file`)
    return { hash: match[1]!.toLowerCase(), name: match[2]! }
  }).sort((left, right) => left.name.localeCompare(right.name))
  if (rows.length !== expectedNames.length
    || rows.some((row, index) => row.name !== expectedNames[index])) {
    throw new Error(`Invalid ${platform} native checksum names`)
  }
  for (const row of rows) {
    const bytes = files[row.name]
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== row.hash) {
      throw new Error(`Invalid ${platform} native artifact hash: ${row.name}`)
    }
  }
}

if (import.meta.main) {
  const platform = process.argv[2] as RuntimeReleasePlatform | undefined
  if (!platform) throw new Error('Usage: release-archive-layout.ts <platform>')
  const entries = (await Bun.stdin.text()).split(/\r?\n/)
  assertRuntimeArchiveLayout(platform, entries)
}
