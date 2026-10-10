import { createHash } from 'node:crypto'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { resolveOpenCodeBinaryPath } from '../OpenCodeBinaryResolver.js'
import { classifyOpenCodeReadGeneration, type OpenCodeReadGeneration, type OpenCodeV2Pin } from './OpenCodeGenerationPolicy.js'
import { createOpenCodeV2ReadRoots } from '../profile/OpenCodeV2ManagedConfig.js'
import { readOpenCodeOwnedVersion } from './OpenCodeVersionProbe.js'

export type OpenCodeV2NativeIdentity = {
  generation: 'v2'; version: OpenCodeV2Pin; dialect: 'v2-2.0.0' | 'v2-2.0.21'
  executablePath: string; executableSha256: string; packageName: string
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

export async function hashOpenCodeFile(file: string): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > 256 * 1024 * 1024) throw new Error('identity_mismatch')
    const hash = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
    const after = await handle.stat()
    const current = await stat(file)
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
export async function inspectOpenCodeReadSelection(signal?: AbortSignal, onAcquisitionStarted?: () => void): Promise<{
  path: string | null; policy: OpenCodeReadGeneration; native: OpenCodeV2NativeIdentity | null; fingerprint: string | null
}> {
  signal?.throwIfAborted()
  const selected = selectedOpenCodeReadPath()
  if (!selected) return { path: null, policy: { generation: 'unsupported', version: null }, native: null, fingerprint: null }
  onAcquisitionStarted?.()
  signal?.throwIfAborted()
  const executablePath = await realpath(selected)
  signal?.throwIfAborted()
  const executableSha256 = await hashOpenCodeFile(executablePath)
  signal?.throwIfAborted()
  const roots = await createOpenCodeV2ReadRoots()
  const output = await readOpenCodeOwnedVersion(executablePath, roots, signal)
  signal?.throwIfAborted()
  const policy = classifyOpenCodeReadGeneration(output)
  if (policy.generation !== 'v2') return { path: executablePath, policy, native: null, fingerprint: executableSha256 }
  const metadataPath = path.join(path.dirname(path.dirname(executablePath)), 'package.json')
  const metadata = await readOpenCodePackageManifest(metadataPath)
  signal?.throwIfAborted()
  if (!metadata || typeof metadata !== 'object' || !('name' in metadata) || !('version' in metadata) ||
    typeof metadata.name !== 'string' || !/^@opencode\/cli-[a-z0-9-]+$/.test(metadata.name) ||
    metadata.version !== policy.version || !/^opencode(?:\.exe)?$/.test(path.basename(executablePath)) ||
    await hashOpenCodeFile(executablePath) !== executableSha256) throw new Error('identity_mismatch')
  signal?.throwIfAborted()
  const expectedPlatform = process.platform === 'win32' ? 'windows' : process.platform
  if (!metadata.name.startsWith(`@opencode/cli-${expectedPlatform}-${process.arch}`)) throw new Error('identity_mismatch')
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
  return { path: executablePath, policy, fingerprint: executableSha256,
    native: { ...policy, executablePath, executableSha256, packageName: metadata.name } }
}
