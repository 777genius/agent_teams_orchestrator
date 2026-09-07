import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, readFile } from 'node:fs/promises'
import path from 'node:path'

export const CURSOR_MANAGED_ASSET_ROOT_ENV = 'AGENT_TEAMS_CURSOR_MANAGED_ASSETS'

const NATIVE_SCRIPT_NAMES = ['supervisor.mjs', 'preload.cjs', 'group-cleanup.mjs', 'scope-sweep.mjs'] as const
const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(['darwin'])
const SUPPORTED_ARCHITECTURES = new Set(['arm64', 'x64'])

export type OpenCodeCursorManagedAssets = {
  /** Absolute path to the reviewed plugin entrypoint OpenCode must load. */
  pluginEntryPath: string
  /** Directory holding the supervisor, preload, sweep and compiled gate. */
  nativeAssetsPath: string
  supervisorPath: string
  /** Absolute interpreter the bridge uses to run the supervisor. */
  interpreterPath: string
  /** Identity of exactly what was staged, for readiness binding and drift checks. */
  fingerprint: string
}

export type OpenCodeCursorManagedAssetsUnavailable = {
  reason:
    | 'unsupported_platform'
    | 'not_staged'
    | 'plugin_artifact_mismatch'
    | 'native_asset_mismatch'
    | 'no_interpreter'
}

export type OpenCodeCursorManagedAssetsResult =
  | { available: true; assets: OpenCodeCursorManagedAssets }
  | ({ available: false } & OpenCodeCursorManagedAssetsUnavailable)

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/**
 * The supervisor is an ES module using node: builtins, so the bridge needs a real
 * interpreter. The single-file runtime executable cannot run it.
 */
export async function resolveCursorManagedInterpreter(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const explicit = env.AGENT_TEAMS_CURSOR_SUPERVISOR_NODE?.trim()
  if (explicit) {
    return await isExecutable(explicit) ? path.resolve(explicit) : null
  }
  const directories = (env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const name of ['node', 'bun']) {
    for (const directory of directories) {
      const candidate = path.resolve(directory, name)
      if (await isExecutable(candidate)) return candidate
    }
  }
  return null
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    const stats = await lstat(candidate)
    if (!stats.isFile() && !stats.isSymbolicLink()) return false
    await access(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function readPrivateFile(filePath: string, maxBytes: number): Promise<Uint8Array> {
  const stats = await lstat(filePath)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxBytes) {
    throw new Error('Cursor managed asset is not a plain file')
  }
  return readFile(filePath)
}

async function verifyStagedPlugin(root: string): Promise<string> {
  const manifestBytes = await readPrivateFile(path.join(root, 'manifest.json'), 64 * 1024)
  const manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as Record<string, unknown>
  if (manifest.schema !== 1 || typeof manifest.entrypoint !== 'string'
    || typeof manifest.artifactSha256 !== 'string' || manifest.backend !== 'cursor-agent') {
    throw new Error('Cursor managed plugin manifest is not the reviewed shape')
  }
  const entrypoint = path.join(root, manifest.entrypoint)
  if (path.relative(root, entrypoint).startsWith('..')) {
    throw new Error('Cursor managed plugin entrypoint escapes its asset root')
  }
  const artifact = await readPrivateFile(entrypoint, 32 * 1024 * 1024)
  if (digest(artifact) !== manifest.artifactSha256) {
    throw new Error('Cursor managed plugin artifact does not match its manifest')
  }
  return digest(manifestBytes)
}

async function verifyStagedNative(root: string, platform: NodeJS.Platform, arch: string): Promise<string> {
  const manifestBytes = await readPrivateFile(path.join(root, 'manifest.json'), 64 * 1024)
  const manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as Record<string, unknown>
  const files = manifest.files as Record<string, string> | undefined
  if (manifest.schema !== 1 || manifest.platform !== platform || manifest.arch !== arch || !files) {
    throw new Error('Cursor native assets were staged for another platform')
  }
  const expected = ['gate', ...NATIVE_SCRIPT_NAMES].sort()
  if (Object.keys(files).sort().join(',') !== expected.join(',')) {
    throw new Error('Cursor native assets are incomplete')
  }
  for (const [name, hash] of Object.entries(files)) {
    const bytes = await readPrivateFile(path.join(root, name), 8 * 1024 * 1024)
    if (digest(bytes) !== hash) throw new Error(`Cursor native asset ${name} does not match its manifest`)
  }
  await access(path.join(root, 'gate'), constants.X_OK)
  return digest(manifestBytes)
}

/**
 * Fails closed. An unavailable result must keep the managed Cursor Stop path off
 * rather than degrade to a transport-only abort that cannot prove cleanup.
 */
export async function resolveOpenCodeCursorManagedAssets(input: {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  arch?: string
  defaultRoot?: string
} = {}): Promise<OpenCodeCursorManagedAssetsResult> {
  const platform = input.platform ?? process.platform
  const arch = input.arch ?? process.arch
  if (!SUPPORTED_PLATFORMS.has(platform) || !SUPPORTED_ARCHITECTURES.has(arch)) {
    return { available: false, reason: 'unsupported_platform' }
  }
  const configured = (input.env ?? process.env)[CURSOR_MANAGED_ASSET_ROOT_ENV]?.trim()
  const root = configured || input.defaultRoot
  if (!root) return { available: false, reason: 'not_staged' }
  const pluginRoot = path.join(root, 'plugin')
  const nativeRoot = path.join(root, 'native')
  let pluginFingerprint: string
  try {
    pluginFingerprint = await verifyStagedPlugin(pluginRoot)
  } catch (error) {
    return { available: false, reason: isMissing(error) ? 'not_staged' : 'plugin_artifact_mismatch' }
  }
  let nativeFingerprint: string
  try {
    nativeFingerprint = await verifyStagedNative(nativeRoot, platform, arch)
  } catch (error) {
    return { available: false, reason: isMissing(error) ? 'not_staged' : 'native_asset_mismatch' }
  }
  const interpreterPath = await resolveCursorManagedInterpreter(input.env ?? process.env)
  if (!interpreterPath) return { available: false, reason: 'no_interpreter' }
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'manifest.json'), 'utf8')) as { entrypoint: string }
  return {
    available: true,
    assets: {
      pluginEntryPath: path.join(pluginRoot, manifest.entrypoint),
      nativeAssetsPath: nativeRoot,
      supervisorPath: path.join(nativeRoot, 'supervisor.mjs'),
      interpreterPath,
      fingerprint: digest(Buffer.from(`${pluginFingerprint}:${nativeFingerprint}:${platform}:${arch}`)),
    },
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}
