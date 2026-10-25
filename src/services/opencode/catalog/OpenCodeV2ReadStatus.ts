import { createHash } from 'node:crypto'
import { openCodeReadAssert } from '../transport/OpenCodeBoundedFetch.js'
import type { OpenCodeV2NativeIdentity } from '../compatibility/OpenCodeNativeIdentity.js'
import { openCodeV2EngineVersion, type OpenCodeV2Dialect, type OpenCodeV2Pin } from '../compatibility/OpenCodeV2Registry.js'

/** Serialized SDK contract for the later product reader. No generated native types. */
export type OpenCodeV2ReadStatus = {
  schemaVersion: 1
  generation: 'v2'
  version: OpenCodeV2Pin
  engineVersion?: OpenCodeV2Pin
  dialect: OpenCodeV2Dialect
  nativeSha256: string
  selectionKey: string
  locationKey: string
  projectId: string | null
  catalog: 'ready' | 'unavailable'
  configuration: { documents: number; directories: number } | null
  authentication: 'unknown'
  supportState: 'capabilities_pending'
  teamLaunch: false
  oneShot: false
  providers: Array<{ id: string; integrationId: string | null; activation: 'auto' | 'enabled' | 'disabled' }>
  models: Array<{ providerId: string; catalogId: string; upstreamModelId: string; variants: string[];
    enabled: boolean; status: 'active' | 'alpha' | 'beta' | 'deprecated';
    tools: boolean; input: string[]; output: string[]; context: number; outputTokens: number }>
  agents: Array<{ id: string; mode: 'primary' | 'subagent' | 'all' }>
  defaultModel: { providerId: string; catalogId: string } | null
}

export function readStatusKey(value: string): string { return createHash('sha256').update(value).digest('hex') }
export function emptyOpenCodeV2ReadStatus(native: OpenCodeV2NativeIdentity, directory: string): OpenCodeV2ReadStatus {
  return {
    schemaVersion: 1, generation: 'v2', version: native.version, engineVersion: openCodeV2EngineVersion(native), dialect: native.dialect,
    nativeSha256: native.executableSha256,
    selectionKey: readStatusKey(`${native.executablePath}\0${native.executableSha256}\0${native.dialect}${openCodeV2EngineVersion(native) === native.version ? '' : `\0${native.version}`}${native.origin === 'standalone' ? '\0standalone' : ''}`),
    locationKey: readStatusKey(directory), projectId: null, catalog: 'unavailable', configuration: null,
    authentication: 'unknown', supportState: 'capabilities_pending', teamLaunch: false, oneShot: false,
    providers: [], models: [], agents: [], defaultModel: null,
  }
}
export function readRecord(value: unknown): Record<string, unknown> {
  openCodeReadAssert(value !== null && typeof value === 'object' && !Array.isArray(value))
  return Object.fromEntries(Object.entries(value))
}
export function readToken(value: unknown): string {
  openCodeReadAssert(typeof value === 'string' && Buffer.byteLength(value) <= 256 && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value))
  return value
}
export function readArray(value: unknown): unknown[] {
  openCodeReadAssert(Array.isArray(value) && value.length <= 10_000)
  return value
}
export function readLocation(value: unknown, directory: string): string {
  const location = readRecord(value)
  openCodeReadAssert(location.directory === directory, 'identity_mismatch')
  const project = readRecord(location.project)
  // The native project root may be an ancestor; its ID must remain stable across every wrapper.
  openCodeReadAssert(typeof project.directory === 'string' && typeof project.canonical === 'string')
  return readToken(project.id)
}
export function readWrapped(value: unknown, directory: string, projectId: string): unknown {
  const wrapper = readRecord(value)
  // Catalog location refs contain directory, rather than the full location project info.
  const location = readRecord(wrapper.location)
  openCodeReadAssert(location.directory === directory, 'identity_mismatch')
  if (location.project !== undefined) openCodeReadAssert(readLocation(location, directory) === projectId, 'identity_mismatch')
  return wrapper.data
}
export function readProvider(value: unknown): OpenCodeV2ReadStatus['providers'][number] {
  const row = readRecord(value), activation = row.activation
  openCodeReadAssert(activation === 'auto' || activation === 'enabled' || activation === 'disabled')
  return { id: readToken(row.id), integrationId: row.integrationID === undefined ? null : readToken(row.integrationID), activation }
}
export function readModel(value: unknown): OpenCodeV2ReadStatus['models'][number] {
  const row = readRecord(value), status = row.status, capabilities = readRecord(row.capabilities), limit = readRecord(row.limit)
  openCodeReadAssert(status === 'active' || status === 'alpha' || status === 'beta' || status === 'deprecated')
  openCodeReadAssert(typeof row.enabled === 'boolean' && typeof capabilities.tools === 'boolean')
  openCodeReadAssert(typeof limit.context === 'number' && Number.isSafeInteger(limit.context) && limit.context >= 0)
  openCodeReadAssert(typeof limit.output === 'number' && Number.isSafeInteger(limit.output) && limit.output >= 0)
  return { providerId: readToken(row.providerID), catalogId: readToken(row.id), upstreamModelId: readToken(row.modelID),
    variants: readArray(row.variants).map(item => readToken(readRecord(item).id)), enabled: row.enabled, status,
    tools: capabilities.tools, input: readArray(capabilities.input).map(readToken), output: readArray(capabilities.output).map(readToken),
    context: limit.context, outputTokens: limit.output }
}
export function readAgent(value: unknown): OpenCodeV2ReadStatus['agents'][number] {
  const row = readRecord(value), mode = row.mode
  openCodeReadAssert(mode === 'primary' || mode === 'subagent' || mode === 'all')
  return { id: readToken(row.id), mode }
}
export function readConfiguration(value: unknown): NonNullable<OpenCodeV2ReadStatus['configuration']> {
  let documents = 0, directories = 0
  for (const entry of readArray(value)) {
    const row = readRecord(entry)
    if (row.type === 'document') { readRecord(row.info); documents++ }
    else if (row.type === 'directory') { openCodeReadAssert(typeof row.path === 'string'); directories++ }
    else throw new Error('invalid_response')
  }
  return { documents, directories }
}
