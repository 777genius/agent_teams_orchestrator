import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveClaudeMultimodelPaths } from '../OpenCodeManagedPaths.js'
import type { OpenCodeConnectedProvider } from '../types.js'

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

export function openCodeV2KeyIntegrations(): readonly Readonly<{ providerId: string; displayName: string }>[] {
  return KEY_INTEGRATIONS
}
export function openCodeV2KeyIntegration(providerId: string): Readonly<{ providerId: string; displayName: string }> | null {
  return KEY_INTEGRATIONS.find(entry => entry.providerId === providerId) ?? null
}

/** Owner-private V2 connection transaction receipts (one per project, provider and key). */
export function openCodeV2ProviderConnectionsDirectory(): string {
  return path.join(resolveClaudeMultimodelPaths().data, 'opencode/v2/provider-connections')
}

/**
 * Providers with a completed V2 connection for this exact project. Only private,
 * owner-written, completed receipts count; pending or foreign files never do.
 */
export async function readOpenCodeV2ConnectedProviders(project: string): Promise<OpenCodeConnectedProvider[]> {
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
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size >= 64 * 1024) continue
      const saved: unknown = JSON.parse(await readFile(file, 'utf8'))
      const receipt = saved !== null && typeof saved === 'object' ? saved as Record<string, unknown> : {}
      const connection = receipt.connection !== null && typeof receipt.connection === 'object' ? receipt.connection as Record<string, unknown> : {}
      const proof = receipt.proof !== null && typeof receipt.proof === 'object' ? receipt.proof as Record<string, unknown> : {}
      if (receipt.state !== 'complete' || connection.state !== 'connected' || typeof connection.providerId !== 'string' ||
        proof.projectPath !== project) continue
      connected.set(connection.providerId, { id: connection.providerId, authHint: 'api', source: 'credentials', credentialScopes: ['managed'] })
    } catch { /* An unreadable receipt is not evidence of a connection. */ }
  }
  return [...connected.values()]
}
