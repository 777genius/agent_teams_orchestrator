export type RuntimeReleasePlatform =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-x64'
  | 'win32-arm64'
  | 'win32-x64'

export type RuntimeArchiveLayout = Readonly<{
  binaryName: string
  workerName: string
  entries: readonly string[]
}>

const PLATFORMS = new Set<RuntimeReleasePlatform>([
  'darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-arm64', 'win32-x64',
])

export function runtimeArchiveLayout(platform: RuntimeReleasePlatform): RuntimeArchiveLayout {
  if (!PLATFORMS.has(platform)) throw new Error(`Unsupported runtime release platform: ${platform}`)
  const windows = platform.startsWith('win32-')
  const binaryName = `claude-multimodel${windows ? '.exe' : ''}`
  const workerName = `opencode-catalog-allocation-worker${windows ? '.exe' : ''}`
  return Object.freeze({
    binaryName,
    workerName,
    entries: Object.freeze([
      'runtime/',
      `runtime/${binaryName}`,
      `runtime/${workerName}`,
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

if (import.meta.main) {
  const platform = process.argv[2] as RuntimeReleasePlatform | undefined
  if (!platform) throw new Error('Usage: release-archive-layout.ts <platform>')
  const entries = (await Bun.stdin.text()).split(/\r?\n/)
  assertRuntimeArchiveLayout(platform, entries)
}
