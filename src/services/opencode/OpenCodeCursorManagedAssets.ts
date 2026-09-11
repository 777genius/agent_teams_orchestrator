import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export const CURSOR_MANAGED_ASSET_ROOT_ENV = 'AGENT_TEAMS_CURSOR_MANAGED_ASSETS'

const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(['darwin'])
const SUPPORTED_ARCHITECTURES = new Set(['arm64', 'x64'])

export type OpenCodeCursorManagedAssets = {
  /** Absolute path to the reviewed plugin entrypoint OpenCode must load. */
  pluginEntryPath: string
  /** The plugin's MCP CLI, which the agent shell needs to reach MCP servers. */
  mcpToolPath: string
  /** Absolute interpreter the profile shim uses to run the MCP CLI. */
  interpreterPath: string
  /** Identity of exactly what was staged, for readiness binding and drift checks. */
  fingerprint: string
}

export type OpenCodeCursorManagedAssetsUnavailable = {
  reason:
    | 'unsupported_platform'
    | 'not_staged'
    | 'plugin_artifact_mismatch'
    | 'no_interpreter'
}

export type OpenCodeCursorManagedAssetsResult =
  | { available: true; assets: OpenCodeCursorManagedAssets }
  | ({ available: false } & OpenCodeCursorManagedAssetsUnavailable)

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/**
 * Assets ship beside the built runtime, so a packaged install needs no manual
 * staging. The directory is only trusted when it belongs to this user and is not
 * group or world writable: it decides which plugin code OpenCode loads, and a
 * writable sibling of the executable would be an easy way to swap it.
 */
export async function resolveShippedCursorManagedAssetRoot(input: {
  execPath?: string
  moduleDir?: string
  stat?: (target: string) => Promise<{ uid: number; mode: number; isDirectory: () => boolean }>
  uid?: number
} = {}): Promise<string | null> {
  // Two homes, because the runtime has two shapes: the compiled binary sits
  // beside its own assets, while the bundle is started by an interpreter whose
  // executable is somewhere else entirely. The app does not forward this
  // location in the environment, so guessing from argv alone would leave the
  // managed path off in development.
  const candidates = [
    path.dirname(input.execPath ?? process.execPath),
    input.moduleDir ?? import.meta.dir,
  ].map(directory => path.join(directory, 'cursor-managed'))
  const currentUid = input.uid ?? process.getuid?.() ?? -1
  for (const candidate of candidates) {
    try {
      // Resolve through symlinks on purpose: `lstat` reports the link's own
      // mode, so a link pointing at a world-writable directory looked safe.
      const stats = input.stat ? await input.stat(candidate) : await stat(candidate)
      if (!stats.isDirectory()) continue
      if (stats.uid !== currentUid) continue
      if ((stats.mode & 0o022) !== 0) continue
      return candidate
    } catch {
      continue
    }
  }
  return null
}

/**
 * The MCP CLI is a standalone bundle, so the profile shim needs a real
 * interpreter. The single-file runtime executable cannot run it.
 */
export async function resolveCursorManagedInterpreter(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const explicit = env.AGENT_TEAMS_CURSOR_SUPERVISOR_NODE?.trim()
  if (explicit) {
    return await isExecutable(explicit) ? path.resolve(explicit) : null
  }
  // The caller's PATH is a curated launch environment that need not contain an
  // interpreter, and answering "no interpreter" then turns managed Cursor off
  // with no way to tell that from unstaged assets. This process is already
  // running on one, so search its own PATH next and accept itself last.
  const searchPaths = [env.PATH, env.PATH === process.env.PATH ? undefined : process.env.PATH]
  for (const searchPath of searchPaths) {
    const directories = (searchPath ?? '').split(path.delimiter).filter(Boolean)
    for (const name of ['node', 'bun']) {
      for (const directory of directories) {
        const candidate = path.resolve(directory, name)
        if (await isExecutable(candidate)) return candidate
      }
    }
  }
  const self = process.execPath
  return /(^|\/)(node|bun)$/.test(self) && await isExecutable(self) ? self : null
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

function assertProtected(stats: { uid: number; mode: number }): void {
  if (stats.uid !== process.getuid?.() || (stats.mode & 0o022) !== 0) {
    throw new Error('Cursor managed asset is not protected')
  }
}

async function protectedEntrypoint(root: string, relative: string): Promise<string> {
  const parts = relative.split(/[\\/]/)
  if (path.isAbsolute(relative) || parts.some(part => !part || part === '..' || part === '.')) {
    throw new Error('Cursor managed entrypoint escapes its asset root')
  }
  let target = root
  for (const part of parts.slice(0, -1)) {
    target = path.join(target, part)
    const stats = await lstat(target)
    assertProtected(stats)
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Unsafe asset directory')
  }
  return path.join(target, parts[parts.length - 1]!)
}

async function readPrivateFile(filePath: string, maxBytes: number): Promise<Uint8Array> {
  const stats = await lstat(filePath)
  assertProtected(stats)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxBytes) {
    throw new Error('Cursor managed asset is not a plain file')
  }
  return readFile(filePath)
}

async function verifyStagedPlugin(root: string) {
  const rootStats = await lstat(root)
  assertProtected(rootStats)
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error('Unsafe plugin root')
  const manifestBytes = await readPrivateFile(path.join(root, 'manifest.json'), 64 * 1024)
  const manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as Record<string, unknown>
  if (manifest.schema !== 1 || typeof manifest.entrypoint !== 'string'
    || typeof manifest.artifactSha256 !== 'string' || manifest.backend !== 'cursor-agent'
    || typeof manifest.mcpToolEntrypoint !== 'string'
    || typeof manifest.mcpToolSha256 !== 'string') {
    throw new Error('Cursor managed plugin manifest is not the reviewed shape')
  }
  const entrypoint = await protectedEntrypoint(root, manifest.entrypoint)
  const mcpToolPath = await protectedEntrypoint(root, manifest.mcpToolEntrypoint)
  const artifact = await readPrivateFile(entrypoint, 32 * 1024 * 1024)
  if (digest(artifact) !== manifest.artifactSha256) {
    throw new Error('Cursor managed plugin artifact does not match its manifest')
  }
  const mcpTool = await readPrivateFile(
    mcpToolPath, 32 * 1024 * 1024)
  if (digest(mcpTool) !== manifest.mcpToolSha256) {
    throw new Error('Cursor managed MCP CLI does not match its manifest')
  }
  return { fingerprint: digest(manifestBytes), entrypoint, mcpToolPath }
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
  const root = configured
    || input.defaultRoot
    || await resolveShippedCursorManagedAssetRoot()
  if (!root) return { available: false, reason: 'not_staged' }
  let verified: Awaited<ReturnType<typeof verifyStagedPlugin>>
  try {
    const canonicalRoot = await realpath(root)
    const rootStats = await stat(canonicalRoot)
    assertProtected(rootStats)
    if (!rootStats.isDirectory()) throw new Error('Unsafe asset root')
    verified = await verifyStagedPlugin(path.join(canonicalRoot, 'plugin'))
  } catch (error) {
    return { available: false, reason: isMissing(error) ? 'not_staged' : 'plugin_artifact_mismatch' }
  }
  const interpreterPath = await resolveCursorManagedInterpreter(input.env ?? process.env)
  if (!interpreterPath) return { available: false, reason: 'no_interpreter' }
  return {
    available: true,
    assets: {
      pluginEntryPath: verified.entrypoint,
      mcpToolPath: verified.mcpToolPath,
      interpreterPath,
      fingerprint: digest(Buffer.from(`${verified.fingerprint}:${platform}:${arch}`)),
    },
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}
