import { resolveOpenCodeArtifactDigest, type OpenCodeArtifactDigest } from './OpenCodeArtifactDigest.js'

const OFFICIAL_V1_18_32_LINUX_X64_SHA256: OpenCodeArtifactDigest =
  'sha256:513f500a1a5ea1dc7d865547ac87b32a8936334e8d5abd5b3ff585c45a170080'

export function assertHostedOfficialOpenCodeArtifact(binaryPath: string | null): OpenCodeArtifactDigest | null {
  const mode = process.env.HOSTED_OPENCODE_RUNTIME_MODE
  if (mode === undefined) return null
  if (mode !== 'official-v1.18.32') {
    throw new Error(`Unsupported hosted OpenCode runtime mode: ${mode || '<empty>'}`)
  }
  if (process.platform !== 'linux' || !binaryPath) {
    throw new Error('Hosted official OpenCode requires a direct Linux executable')
  }
  const digest = resolveOpenCodeArtifactDigest(binaryPath)
  if (digest !== OFFICIAL_V1_18_32_LINUX_X64_SHA256) {
    throw new Error('Hosted official OpenCode binary does not match v1.18.32 linux-x64 SHA-256')
  }
  return digest
}
