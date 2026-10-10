import path from 'node:path'
import { realpath } from 'node:fs/promises'
import type { OpenCodeClientRequestContext } from '../OpenCodeClientRequestContext.js'
import { assertOpenCodeV2EndpointAuthority, type OpenCodeV2EndpointAuthority } from '../host/OpenCodeHostNativeAdapter.js'
import { verifyOpenCodePackage } from '../host/OpenCodeV2ServerGraph.js'
import { OpenCodeBoundedFetch } from './OpenCodeBoundedFetch.js'

/** Only finite catalog operations are exposed; no generated types or mutation client escapes. */
export type OpenCodeV2ReadClient = {
  identity(): Promise<unknown>; urls(): Promise<unknown>
  location(directory: string): Promise<unknown>; ready(directory: string): Promise<void>
  models(directory: string): Promise<unknown>; defaultModel(directory: string): Promise<unknown>
  providers(directory: string): Promise<unknown>; provider(directory: string, id: string): Promise<unknown>
  agents(directory: string): Promise<unknown>; agent(directory: string, id: string): Promise<unknown>
  config(directory: string): Promise<unknown>
}
export async function createOpenCodeV2ReadClient(authority: OpenCodeV2EndpointAuthority,
  context: OpenCodeClientRequestContext = {}) {
  assertOpenCodeV2EndpointAuthority(authority)
  const name = authority.native.version === '2.0.0' ? '@opencode/client-v2-floor' : '@opencode/client'
  const entry = await realpath(Bun.resolveSync(name, import.meta.dir))
  await verifyOpenCodePackage(entry, '@opencode/client', authority.native.version)
  for (const [dependency, subpath] of [['schema', 'installation-event'], ['protocol', 'groups/pty']]) {
    await verifyOpenCodePackage(await realpath(Bun.resolveSync(`@opencode/${dependency}/${subpath}`, path.dirname(entry))),
      `@opencode/${dependency}`, authority.native.version)
  }
  const wire = new OpenCodeBoundedFetch(authority.baseUrl, authority.native.version,
    authority.directory, authority.authorization, context)
  try {
    const client = authority.native.version === '2.0.0'
      ? (await import('./OpenCodeV2FloorClient.js')).createOpenCodeV2FloorClient(authority.baseUrl, wire)
      : (await import('./OpenCodeV2CurrentClient.js')).createOpenCodeV2CurrentClient(authority.baseUrl, wire)
    return { client, check: () => wire.check(), dispose: () => wire.dispose() }
  } catch (error) { await wire.dispose(); throw error }
}
