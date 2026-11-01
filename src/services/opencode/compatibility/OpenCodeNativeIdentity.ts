import { createHash } from 'node:crypto'
import filesystem, { lstat, open, stat } from 'node:fs/promises'
import path from 'node:path'
import { resolveOpenCodeBinaryPath } from '../OpenCodeBinaryResolver.js'
import { classifyOpenCodeReadGeneration, type OpenCodeReadGeneration } from './OpenCodeGenerationPolicy.js'
import { resolveOpenCodeV2EngineVersion, openCodeV2Dialect, type OpenCodeV2Dialect, type OpenCodeV2Pin } from './OpenCodeV2Registry.js'
import { createOpenCodeVersionReadRoots } from '../profile/OpenCodeV2ManagedConfig.js'
import { readOpenCodeOwnedVersion } from './OpenCodeVersionProbe.js'

export type OpenCodeV2NativeIdentity = {
  generation: 'v2'; version: OpenCodeV2Pin
  /** Exact owned engine; absent only in legacy records. dialect always belongs to this engine. */
  engineVersion?: OpenCodeV2Pin; dialect: OpenCodeV2Dialect
  executablePath: string; executableSha256: string; packageName: string | null
  /** Missing only in legacy npm-bound records. */
  origin?: 'npm' | 'standalone'
}

export async function readOpenCodePackageManifest(file: string): Promise<unknown> {
  const leaf = await lstat(file)
  if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.size > 64 * 1024) throw new Error('identity_mismatch')
  const handle = await open(file, 'r')
  try {
    const info = await handle.stat()
    if (info.dev !== leaf.dev || info.ino !== leaf.ino || info.size > 64 * 1024) throw new Error('identity_mismatch')
    const bytes = Buffer.alloc(64 * 1024 + 1)
    const result = await handle.read(bytes, 0, bytes.length, 0)
    if (result.bytesRead > 64 * 1024) throw new Error('identity_mismatch')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, result.bytesRead)))
  } finally { await handle.close() }
}

/** Our legacy console shim delegates through environment state; it is not a CLI identity. */
export function assertOpenCodeStandaloneNativePath(executablePath: string): void {
  if (/(?:^|\/)runtime\/opencode-console\/opencode\.exe$/i.test(executablePath.replaceAll('\\', '/'))) {
    throw new Error('identity_mismatch')
  }
}

/** Only lstat's absence admits standalone; broken links and read errors remain failures. */
export async function readOpenCodeNativePackageMetadata(executablePath: string): Promise<unknown | undefined> {
  const file = path.join(path.dirname(path.dirname(executablePath)), 'package.json')
  try { await lstat(file) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      assertOpenCodeStandaloneNativePath(executablePath)
      return undefined
    }
    throw error
  }
  return readOpenCodePackageManifest(file)
}

export async function hashOpenCodeFile(file: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const handle = await open(file, 'r')
  try {
    signal?.throwIfAborted()
    const before = await handle.stat()
    if (!before.isFile() || before.size > 256 * 1024 * 1024) throw new Error('identity_mismatch')
    const hash = createHash('sha256')
    // Keep one explicit handle owner. Bun 1.3.11's streamed FileHandle reads
    // can invalidate later child stdio after hashing a large package graph.
    const bytes = Buffer.alloc(Math.max(1, Math.min(64 * 1024, before.size)))
    for (let offset = 0; offset < before.size;) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(bytes, 0, Math.min(bytes.length, before.size - offset), offset)
      signal?.throwIfAborted()
      if (bytesRead === 0) throw new Error('identity_mismatch')
      offset += bytesRead
      if (offset > 256 * 1024 * 1024) throw new Error('identity_mismatch')
      hash.update(bytes.subarray(0, bytesRead))
    }
    signal?.throwIfAborted()
    const after = await handle.stat()
    const current = await stat(file)
    signal?.throwIfAborted()
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || after.ino !== current.ino || after.dev !== current.dev) {
      throw new Error('identity_mismatch')
    }
    return hash.digest('hex')
  } finally { await handle.close() }
}

export function selectedOpenCodeReadPath(): string | null {
  // Keep the legacy resolver's blank/stale override fallback, then bind the
  // one resolved executable to the same strict generation and native checks.
  const selected = resolveOpenCodeBinaryPath()
  for (const explicit of [process.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH, process.env.OPENCODE_BIN_PATH]) {
    if (explicit?.trim() && !path.isAbsolute(explicit.trim())) throw new Error('identity_mismatch')
    if (explicit?.trim() && path.resolve(explicit.trim()) === selected) break
  }
  return selected
}

/** Execute only --version, in private roots, before any V1 profile/registry is opened. */
export async function inspectOpenCodeReadSelection(signal?: AbortSignal, onAcquisitionStarted?: () => void, acquisitionDeadlineMs?: number): Promise<{
  path: string | null; policy: OpenCodeReadGeneration; native: OpenCodeV2NativeIdentity | null; fingerprint: string | null
}> {
  signal?.throwIfAborted()
  const selected = selectedOpenCodeReadPath()
  if (!selected) return { path: null, policy: { generation: 'unsupported', version: null }, native: null, fingerprint: null }
  onAcquisitionStarted?.()
  signal?.throwIfAborted()
  const executablePath = await filesystem.realpath(selected)
  signal?.throwIfAborted()
  const executableSha256 = await hashOpenCodeFile(executablePath, signal)
  signal?.throwIfAborted()
  const roots = await createOpenCodeVersionReadRoots()
  const output = await readOpenCodeOwnedVersion(executablePath, roots, signal, acquisitionDeadlineMs)
  signal?.throwIfAborted()
  const policy = classifyOpenCodeReadGeneration(output)
  if (policy.generation !== 'v2') return { path: executablePath, policy, native: null, fingerprint: executableSha256 }
  const metadata = await readOpenCodeNativePackageMetadata(executablePath)
  signal?.throwIfAborted()
  if (metadata !== undefined && (metadata === null || typeof metadata !== 'object' || !('name' in metadata) || !('version' in metadata) ||
    typeof metadata.name !== 'string' || !/^@opencode\/cli-[a-z0-9-]+$/.test(metadata.name) ||
    metadata.version !== policy.version)) throw new Error('identity_mismatch')
  if (!/^opencode(?:\.exe)?$/.test(path.basename(executablePath)) ||
    await hashOpenCodeFile(executablePath, signal) !== executableSha256) throw new Error('identity_mismatch')
  signal?.throwIfAborted()
  const expectedPlatform = process.platform === 'win32' ? 'windows' : process.platform
  if (metadata !== undefined && !(metadata as { name: string }).name.startsWith(`@opencode/cli-${expectedPlatform}-${process.arch}`)) throw new Error('identity_mismatch')
  const binary = await open(executablePath, 'r')
  try {
    signal?.throwIfAborted()
    const header = Buffer.alloc(4); await binary.read(header, 0, 4, 0)
    signal?.throwIfAborted()
    const magic = header.toString('hex')
    if (process.platform === 'linux' ? magic !== '7f454c46' : process.platform === 'win32' ? !magic.startsWith('4d5a') :
      !['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca'].includes(magic)) throw new Error('identity_mismatch')
  } finally { await binary.close() }
  signal?.throwIfAborted()
  const engineVersion = resolveOpenCodeV2EngineVersion(policy.version) ?? policy.version
  return { path: executablePath, policy, fingerprint: executableSha256,
    native: { ...policy, engineVersion, dialect: openCodeV2Dialect(engineVersion), executablePath, executableSha256,
      origin: metadata === undefined ? 'standalone' : 'npm', packageName: metadata === undefined ? null : (metadata as { name: string }).name } }
}
