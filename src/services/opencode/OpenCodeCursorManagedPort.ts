import { createServer } from 'node:net'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { lock } from '../../utils/lockfile.js'

export const CURSOR_MANAGED_PROXY_PORT_ENV = 'AGENT_TEAMS_CURSOR_PROXY_PORT'
export const CURSOR_PROVIDER_ID = 'cursor-acp'

/** Retains an endpoint assignment, not a live OS reservation. The plugin must
 * bind this exact port and fail on EADDRINUSE; only host ownership can authorize
 * reuse of a running listener. statePath must belong to one host generation. */
export async function reserveCursorManagedProxyPort(statePath: string): Promise<number> {
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 })
  const release = await lock(statePath, {
    realpath: false, stale: 10_000,
    retries: { retries: 100, minTimeout: 10, maxTimeout: 100, factor: 1.2 },
  })
  try {
    const retained = await readRetainedPort(statePath)
    // A live owned host also occupies this port. Do not probe or reject reuse
    // here: this API has no host identity. Exclusive plugin bind is the gate.
    if (retained !== null) return retained
    const port = await allocateLoopbackPort()
    const temporary = `${statePath}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, port }) + '\n', { mode: 0o600, flag: 'wx' })
      await rename(temporary, statePath)
    } finally {
      await rm(temporary, { force: true })
    }
    return port
  } finally {
    await release()
  }
}

async function readRetainedPort(statePath: string): Promise<number | null> {
  let raw: string
  try {
    raw = await readFile(statePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed.version === 1 && isUsablePort(parsed.port)) return parsed.port
  } catch { /* report corrupt state without silently changing identity */ }
  throw new Error('Cursor managed proxy port state is corrupt')
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
