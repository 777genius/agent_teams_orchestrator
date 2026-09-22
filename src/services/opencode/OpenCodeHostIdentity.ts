import { createHash } from 'node:crypto'
import { readlink, stat } from 'node:fs/promises'
import path from 'node:path'

export const OPEN_CODE_MANAGED_HOST_CONFIG_GENERATION = 'provider-plugins-v1'

export async function resolveOpenCodeBinaryHostIdentity(binaryPath: string): Promise<string> {
  let resolvedPath = path.resolve(binaryPath)
  try {
    const target = await readlink(resolvedPath)
    resolvedPath = path.resolve(path.dirname(resolvedPath), target)
  } catch {
    // The executable is not a symlink or cannot be resolved. Its absolute path
    // remains a stable part of the identity.
  }
  const metadata = await stat(resolvedPath).catch(() => null)
  const source = [
    resolvedPath,
    metadata?.size ?? 'unknown-size',
    metadata?.mtimeMs ?? 'unknown-mtime',
  ].join('\0')
  return createHash('sha256').update(source).digest('hex').slice(0, 16)
}

export function buildOpenCodeHostTransportIdentity(config: { mcp?: unknown }): string {
  const mcp = config.mcp as Record<string, unknown> | undefined
  const transportJson = JSON.stringify(mcp?.['agent-teams'] ?? null, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value)
  return createHash('sha256').update(transportJson).digest('hex')
}
