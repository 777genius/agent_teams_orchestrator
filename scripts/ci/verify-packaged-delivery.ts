import { openCodeBunVersion } from '../../src/constants/openCodeBunVersion.js'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validatePackagedOpenCodeIdentity } from '../../src/cli/packagedOpenCodeDelivery.js'

/** A release must refuse old/help output, false capability claims and unrelated data. */
export function parsePackagedSecurityCapabilities(stdout: string): {
  schemaVersion: 1; mcpHttpAuthorizationHeaders: true
} {
  let value: unknown
  try { value = JSON.parse(stdout) } catch { throw new Error('Invalid packaged security capabilities') }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'mcpHttpAuthorizationHeaders,schemaVersion'
    || (value as Record<string, unknown>).schemaVersion !== 1
    || (value as Record<string, unknown>).mcpHttpAuthorizationHeaders !== true) {
    throw new Error('Invalid packaged security capabilities')
  }
  return { schemaVersion: 1, mcpHttpAuthorizationHeaders: true }
}

function verifyPackagedDelivery(): void {
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
    'dist/local-cli/opencodeV2ExecutionServer.js', 'dist/local-cli/opencodeV2RunOwner.js']) {
    if (!existsSync(file)) throw new Error('Portable graph missing')
  }
  if (platform !== process.platform || arch !== process.arch) throw new Error('Candidate cannot execute on this host')
  const sourceSha = process.env.CANDIDATE_SOURCE_SHA
  if (!sourceSha || !/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Missing candidate source identity')
  const binary = path.resolve(platform === 'win32' ? 'dist/cli.exe' : 'dist/cli')
  const shippedBun = path.resolve(platform === 'win32' ? 'dist/bun/bun.exe' : 'dist/bun/bun')
  const entry = path.resolve('dist/local-cli/cli.js')
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'TEST-packaged-capabilities-'))
  try {
    const directories = Object.fromEntries(['home', 'tmp', 'config', 'data', 'cache', 'appdata', 'localappdata', 'project']
      .map(name => [name, path.join(fixture, name)]))
    for (const directory of Object.values(directories)) mkdirSync(directory, { mode: 0o700 })
    const env: NodeJS.ProcessEnv = {
      PATH: path.dirname(shippedBun), HOME: directories.home, USERPROFILE: directories.home,
      TMPDIR: directories.tmp, TMP: directories.tmp, TEMP: directories.tmp,
      XDG_CONFIG_HOME: directories.config, XDG_DATA_HOME: directories.data, XDG_CACHE_HOME: directories.cache,
      APPDATA: directories.appdata, LOCALAPPDATA: directories.localappdata, NODE_ENV: 'test', NO_COLOR: '1',
      ...(platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
        WINDIR: process.env.SystemRoot ?? 'C:\\Windows' } : {}),
    }
    const capabilityArgs = ['runtime', 'security-capabilities', '--json']
    const probe = (label: string, executable: string, args: string[]) => {
      try {
        return parsePackagedSecurityCapabilities(execFileSync(executable, args, {
          cwd: directories.project, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 4096,
          windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        }))
      } catch { throw new Error(`Packaged security capability execution failed: ${label}`) }
    }
    // Execute the physical compiled front door and the digest-verified shipped JS delivery.
    // The capability fast path precedes runtime delegation; other delegated commands
    // retain their existing compiled delivery/cancellation tests.
    const compiled = probe('compiled-front-door', binary, capabilityArgs)
    const shippedJs = probe('shipped-js', shippedBun, ['--no-env-file', entry, ...capabilityArgs])
    writeFileSync('candidate/runtime/security-capabilities.json', JSON.stringify({
      schemaVersion: 1, sourceSha, platform, arch,
      compiled: { sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'), capabilities: compiled },
      shippedJs: { entrySha256: identity.entrySha256, bunSha256: identity.bunSha256, capabilities: shippedJs },
      isolatedProfile: true,
    }, null, 2) + '\n')
  } finally { rmSync(fixture, { recursive: true, force: true }) }
  const metadata: unknown = JSON.parse(readFileSync('package.json', 'utf8'))
  if (!metadata || typeof metadata !== 'object' || !('version' in metadata) ||
    typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(metadata.version)) throw new Error('Invalid runtime version')
  writeFileSync('candidate/runtime/VERSION', metadata.version + '\n')
}

if (import.meta.main) verifyPackagedDelivery()
