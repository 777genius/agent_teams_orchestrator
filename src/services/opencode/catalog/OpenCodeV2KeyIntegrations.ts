import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveClaudeMultimodelPaths } from '../OpenCodeManagedPaths.js'
import type { OpenCodeConnectedProvider } from '../types.js'
import { openCodeV2Wire, type OpenCodeV2Pin } from '../compatibility/OpenCodeV2Registry.js'

/**
 * Native OpenCode V2 integrations the provider-management surface offers with the
 * native key method. This is the only list; the directory, setup form and
 * display name all read it. Ids and names are the native integration catalog's.
 */
const KEY_INTEGRATIONS: readonly Readonly<{ providerId: string; displayName: string }>[] = Object.freeze([
  Object.freeze({ providerId: 'kimi-code-plan-global', displayName: 'Kimi For Coding (kimi.ai)' }),
  Object.freeze({ providerId: 'kimi-code-plan-cn', displayName: 'Kimi For Coding (kimi.com)' }),
])

/** The setup form's single option; V2 connect admits exactly this id or none. */
export const OPENCODE_V2_NATIVE_KEY_OPTION_ID = 'api:native'

/** The native integration catalog of the floor release predates these integrations. */
export function openCodeV2KeyIntegrations(version: OpenCodeV2Pin): readonly Readonly<{ providerId: string; displayName: string }>[] {
  return openCodeV2Wire(version) === 'current' ? KEY_INTEGRATIONS : []
}
export function openCodeV2KeyIntegration(providerId: string, version?: OpenCodeV2Pin): Readonly<{ providerId: string; displayName: string }> | null {
  const entry = KEY_INTEGRATIONS.find(candidate => candidate.providerId === providerId) ?? null
  return entry && (version === undefined || openCodeV2Wire(version) === 'current') ? entry : null
}

/** Owner-private V2 connection transaction receipts (one per project, provider and key). */
export function openCodeV2ProviderConnectionsDirectory(): string {
  return path.join(resolveClaudeMultimodelPaths().data, 'opencode/v2/provider-connections')
}

/**
 * Providers with a completed V2 connection for this exact project and selected
 * version. Only private, owner-written, completed receipts count; pending or
 * foreign files never do. Windows has no POSIX owner or mode; the receipts live
 * in the user's private data directory there.
 */
export async function readOpenCodeV2ConnectedProviders(project: string, version: OpenCodeV2Pin): Promise<OpenCodeConnectedProvider[]> {
  const directory = openCodeV2ProviderConnectionsDirectory()
  let names: string[]
  try { names = await readdir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const connected = new Map<string, OpenCodeConnectedProvider>()
  for (const name of names.filter(entry => /^[a-f0-9]{64}\.json$/.test(entry)).sort()) {
    const file = path.join(directory, name)
    try {
      const stat = await lstat(file)
      const owned = process.platform === 'win32' || (stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0)
      if (!stat.isFile() || stat.isSymbolicLink() || !owned || stat.size >= 64 * 1024) continue
      const saved: unknown = JSON.parse(await readFile(file, 'utf8'))
      const receipt = saved !== null && typeof saved === 'object' ? saved as Record<string, unknown> : {}
      const connection = receipt.connection !== null && typeof receipt.connection === 'object' ? receipt.connection as Record<string, unknown> : {}
      const proof = receipt.proof !== null && typeof receipt.proof === 'object' ? receipt.proof as Record<string, unknown> : {}
      if (receipt.state !== 'complete' || connection.state !== 'connected' || typeof connection.providerId !== 'string' ||
        proof.projectPath !== project || proof.opencodeVersion !== version) continue
      connected.set(connection.providerId, { id: connection.providerId, authHint: 'api', source: 'credentials', credentialScopes: ['managed'] })
    } catch { /* An unreadable receipt is not evidence of a connection. */ }
  }
  return [...connected.values()]
}
