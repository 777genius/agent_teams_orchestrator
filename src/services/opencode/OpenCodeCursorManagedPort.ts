import { createServer } from 'node:net'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const CURSOR_MANAGED_PROXY_PORT_ENV = 'AGENT_TEAMS_CURSOR_PROXY_PORT'
export const CURSOR_PROVIDER_ID = 'cursor-acp'

/**
 * The upstream plugin binds one well-known port for every Cursor profile on the
 * machine, and the provider config points at exactly that address. A stale or
 * foreign holder therefore receives another profile's traffic. A managed profile
 * gets its own retained port instead, so there is nothing to hijack.
 */
export async function reserveCursorManagedProxyPort(statePath: string): Promise<number> {
  const retained = await readRetainedPort(statePath)
  if (retained) return retained
  const port = await allocateLoopbackPort()
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 })
  await writeFile(statePath, JSON.stringify({ version: 1, port }) + '\n', { mode: 0o600 })
  // A racing preparation may have retained a different port first; honour theirs.
  return await readRetainedPort(statePath) ?? port
}

async function readRetainedPort(statePath: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath, 'utf8')) as { version?: unknown; port?: unknown }
    if (parsed.version !== 1) return null
    return isUsablePort(parsed.port) ? parsed.port : null
  } catch {
    return null
  }
}

function isUsablePort(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 1024 && value < 65_536
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(error => {
        if (error) reject(error)
        else if (isUsablePort(port)) resolve(port)
        else reject(new Error('Cursor managed proxy port allocation failed'))
      })
    })
  })
}

/**
 * Keeps the provider endpoint and the plugin's bind target in step. Without this
 * the model would dial the catalog's shared default while the plugin listens
 * somewhere else, which fails as an opaque connection error.
 */
export function applyCursorManagedProxyEndpoint(
  config: Record<string, unknown>,
  port: number,
): void {
  if (!isUsablePort(port)) throw new Error('Cursor managed proxy port is invalid')
  const providers = config.provider
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return
  const provider = (providers as Record<string, unknown>)[CURSOR_PROVIDER_ID]
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return
  const options = (provider as Record<string, unknown>).options
  const nextOptions = options && typeof options === 'object' && !Array.isArray(options)
    ? { ...(options as Record<string, unknown>) }
    : {}
  nextOptions.baseURL = `http://127.0.0.1:${port}/v1`
  ;(providers as Record<string, unknown>)[CURSOR_PROVIDER_ID] = { ...provider, options: nextOptions }
}
