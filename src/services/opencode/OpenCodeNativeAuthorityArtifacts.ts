import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync } from 'node:fs'
import path from 'node:path'

export type OpenCodeNativeAuthorityArtifacts = Readonly<{ launcherPath: string; workerPath: string }>

function artifactName(base: string, platform: NodeJS.Platform): string {
  return `${base}${platform === 'win32' ? '.exe' : ''}`
}

export function resolveOpenCodeCatalogSourceArtifacts(sourceRoot: string,
  platform: NodeJS.Platform = process.platform,
  exists: (filePath: string) => boolean = existsSync): OpenCodeNativeAuthorityArtifacts & {
    profile: 'release' | 'debug' | 'missing'
  } {
  const pair = (profile: 'release' | 'debug') => ({
    launcherPath: path.join(sourceRoot, 'native', 'opencode-catalog-launcher', 'target', profile,
      artifactName('opencode-catalog-launcher', platform)),
    workerPath: path.join(sourceRoot, 'native', 'opencode-catalog-authority', 'target', profile,
      artifactName('opencode-catalog-authority', platform)),
  })
  for (const profile of ['release', 'debug'] as const) {
    const candidate = pair(profile)
    if (exists(candidate.launcherPath) && exists(candidate.workerPath)) return { ...candidate, profile }
  }
  return { ...pair('release'), profile: 'missing' }
}

export function resolveOpenCodeNativeAuthorityArtifacts(overrides: Partial<OpenCodeNativeAuthorityArtifacts> = {}): OpenCodeNativeAuthorityArtifacts {
  if (overrides.launcherPath && overrides.workerPath) return overrides as OpenCodeNativeAuthorityArtifacts
  const bunHostedBundle = /(?:^|[\\/])bun(?:\.exe)?$/i.test(process.execPath)
  const packaged = bunHostedBundle ? import.meta.dir : path.dirname(process.execPath)
  const source = resolveOpenCodeCatalogSourceArtifacts(path.resolve(import.meta.dir, '../../..'))
  const sourceRuntime = import.meta.url.endsWith('.ts')
  return {
    launcherPath: overrides.launcherPath ?? (sourceRuntime ? source.launcherPath
      : path.join(packaged, artifactName('opencode-catalog-launcher', process.platform))),
    workerPath: overrides.workerPath ?? (sourceRuntime ? source.workerPath
      : path.join(packaged, artifactName('opencode-catalog-authority', process.platform))),
  }
}

export function verifyOpenCodeNativeAuthorityArtifacts(artifacts: OpenCodeNativeAuthorityArtifacts): void {
  for (const filePath of [artifacts.launcherPath, artifacts.workerPath]) {
    if (!existsSync(filePath)) throw new Error('OpenCode native authority is unavailable [redacted]')
    const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const held = fstatSync(fd, { bigint: true }); const named = lstatSync(filePath, { bigint: true })
      if (!held.isFile() || !named.isFile() || named.isSymbolicLink()
        || held.dev !== named.dev || held.ino !== named.ino
        || (typeof process.getuid === 'function' && held.uid !== BigInt(process.getuid()))
        || (process.platform !== 'win32' && (held.mode & 0o022n) !== 0n)) {
        throw new Error('OpenCode native authority is unavailable [redacted]')
      }
    } finally { closeSync(fd) }
  }
}

export type OpenCodeNativeAuthorityChild = Readonly<{
  pid: number
  stdin: { write(value: string): number; flush(): number | Promise<number>; end(): void }
  stdout: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill(signal?: NodeJS.Signals | number): void
  unref(): void
}>

export function launchOpenCodeNativeAuthority(input: OpenCodeNativeAuthorityArtifacts & Readonly<{ argument: string }>): OpenCodeNativeAuthorityChild {
  return Bun.spawn({ cmd: [input.launcherPath, input.workerPath, input.argument],
    stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' }) as unknown as OpenCodeNativeAuthorityChild
}
