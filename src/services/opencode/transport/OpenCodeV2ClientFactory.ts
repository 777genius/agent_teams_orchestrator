import { openCodeV2EngineVersion } from '../compatibility/OpenCodeV2Registry.js'
import path from 'node:path'
import { realpath } from 'node:fs/promises'
import type { OpenCodeClientRequestContext } from '../OpenCodeClientRequestContext.js'
import { assertOpenCodeV2EndpointAuthority, type OpenCodeV2EndpointAuthority } from '../host/OpenCodeHostNativeAdapter.js'
import { OPENCODE_V2_CLIENT_GRAPH_ENTRIES, verifyOpenCodePackage } from '../host/OpenCodeV2ServerGraph.js'
import { importOpenCodeV2ClientModule, resolveOpenCodeV2ClientEntry } from './OpenCodeV2ClientModule.js'
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
  const entry = await resolveOpenCodeV2ClientEntry(openCodeV2EngineVersion(authority.native), undefined, authority.delivery)
  for (const [dependency, subpath] of OPENCODE_V2_CLIENT_GRAPH_ENTRIES) {
    await verifyOpenCodePackage(await realpath(Bun.resolveSync(`@opencode/${dependency}/${subpath}`, path.dirname(entry))),
      `@opencode/${dependency}`, openCodeV2EngineVersion(authority.native))
  }
  const wire = new OpenCodeBoundedFetch(authority.baseUrl, openCodeV2EngineVersion(authority.native),
    authority.directory, authority.authorization, context)
  try {
    const selected = await importOpenCodeV2ClientModule(openCodeV2EngineVersion(authority.native), entry)
    const client = selected.wire === 'floor'
      ? (await import('./OpenCodeV2FloorClient.js')).createOpenCodeV2FloorClient(selected.module, authority.baseUrl, wire)
      : (await import('./OpenCodeV2CurrentClient.js')).createOpenCodeV2CurrentClient(selected.module, authority.baseUrl, wire)
    return { client, check: () => wire.check(), dispose: () => wire.dispose() }
  } catch (error) { await wire.dispose(); throw error }
}
