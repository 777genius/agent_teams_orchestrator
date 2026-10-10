import type { OpenCodeClientRequestContext } from '../OpenCodeClientRequestContext.js'
import type { OpenCodeInventorySnapshot } from '../types.js'
import { hashOpenCodeFile, type OpenCodeV2NativeIdentity } from '../compatibility/OpenCodeNativeIdentity.js'
import { acquireOpenCodeV2ReadHost } from '../host/OpenCodeHostNativeAdapter.js'
import { createOpenCodeV2ReadClient } from '../transport/OpenCodeV2ClientFactory.js'
import { openCodeReadAssert } from '../transport/OpenCodeBoundedFetch.js'
import { emptyOpenCodeV2ReadStatus, readAgent, readArray, readConfiguration, readLocation, readModel,
  readProvider, readRecord, readWrapped, type OpenCodeV2ReadStatus } from './OpenCodeV2ReadStatus.js'

export function openCodeV2InventorySnapshot(native: OpenCodeV2NativeIdentity, directory: string,
  readStatus = emptyOpenCodeV2ReadStatus(native, directory), probeError: string | null = null): OpenCodeInventorySnapshot {
  return { detected: true, binaryPath: native.executablePath, version: native.version, projectPath: directory,
    profile: null, authStorePath: null, connectedProviders: [], availableProviders: readStatus.providers.map(row => row.id),
    models: readStatus.models.map(row => `${row.providerId}/${row.catalogId}`), modelMetadata: [],
    agents: readStatus.agents.map(row => ({ id: row.id, mode: row.mode === 'all' ? 'unknown' : row.mode })),
    probeError, diagnostics: ['capabilities_pending: V2 catalog reads do not qualify authentication, team launch or one-shot execution.'],
    readStatus, readGeneration: 'v2' }
}

export async function probeOpenCodeV2Inventory(native: OpenCodeV2NativeIdentity, directory: string,
  context: OpenCodeClientRequestContext = {}): Promise<OpenCodeInventorySnapshot> {
  const deadline = Date.now() + Math.min(60_000, context.remainingMs?.() ?? 60_000)
  const boundedContext = { ...context, remainingMs: () => Math.min(deadline - Date.now(), context.remainingMs?.() ?? Infinity) }
  let status = emptyOpenCodeV2ReadStatus(native, directory)
  let host: Awaited<ReturnType<typeof acquireOpenCodeV2ReadHost>> | undefined
  let reader: Awaited<ReturnType<typeof createOpenCodeV2ReadClient>> | undefined
  let failure: string | null = null
  try {
    host = await acquireOpenCodeV2ReadHost(native, directory, boundedContext)
    reader = await createOpenCodeV2ReadClient(host.authority, boundedContext)
    const sdk = reader.client, wrap = (value: unknown) => readWrapped(value, directory, projectId)
    const identity = readRecord(await sdk.identity())
    openCodeReadAssert(identity.pid === host.authority.pid && identity.version === native.version &&
      (native.version !== '2.0.0' || identity.healthy === true), 'identity_mismatch')
    const urls = readArray(await sdk.urls())
    openCodeReadAssert(urls.includes(host.authority.baseUrl), 'identity_mismatch')
    const projectId = readLocation(await sdk.location(directory), directory)
    // Native location construction does not imply plugin activation completion.
    await sdk.ready(directory)
    reader.check()
    const providers = readArray(wrap(await sdk.providers(directory))).map(readProvider)
    const models = readArray(wrap(await sdk.models(directory))).map(readModel)
    const agents = readArray(wrap(await sdk.agents(directory))).map(readAgent)
    openCodeReadAssert(providers.length <= 256 && agents.length <= 256)
    const unique = (values: string[]) => new Set(values).size === values.length
    openCodeReadAssert(unique(providers.map(row => row.id)) && unique(agents.map(row => row.id)) &&
      unique(models.map(row => `${row.providerId}\0${row.catalogId}`)))
    for (const provider of providers) {
      const detail = readProvider(wrap(await sdk.provider(directory, provider.id)))
      openCodeReadAssert(JSON.stringify(detail) === JSON.stringify(provider), 'identity_mismatch')
    }
    for (const agent of agents) {
      const detail = readAgent(wrap(await sdk.agent(directory, agent.id)))
      openCodeReadAssert(JSON.stringify(detail) === JSON.stringify(agent), 'identity_mismatch')
    }
    openCodeReadAssert(models.every(model => providers.some(provider => provider.id === model.providerId)))
    const configuration = readConfiguration(await sdk.config(directory))
    const defaultValue = wrap(await sdk.defaultModel(directory))
    const defaultRow = defaultValue === null ? null : readModel(defaultValue)
    if (defaultRow) openCodeReadAssert(models.some(row => row.providerId === defaultRow.providerId && row.catalogId === defaultRow.catalogId))
    openCodeReadAssert(readLocation(await sdk.location(directory), directory) === projectId, 'identity_mismatch')
    openCodeReadAssert(await hashOpenCodeFile(native.executablePath) === native.executableSha256, 'identity_mismatch')
    reader.check()
    status = { ...status, projectId, catalog: 'ready', configuration, providers, models, agents,
      defaultModel: defaultRow ? { providerId: defaultRow.providerId, catalogId: defaultRow.catalogId } : null }
  } catch (error) {
    // Only this fixed delivery fence is public; never serialize native errors.
    failure = error instanceof Error && error.message === 'v2_compiled_runtime_unsupported'
      ? 'V2 catalog reads require the packaged JS wrapper; compiled binary mode is unsupported.'
      : error instanceof Error && error.message === 'cleanup_unknown'
        ? 'V2 owned server cleanup unknown.'
        : 'V2 read status unavailable; authentication and execution remain unqualified.'
  } finally {
    try { if (reader) await reader.dispose() } catch { failure = 'V2 HTTP cleanup unknown.' }
    try { if (host) await host.close() } catch { failure = 'V2 owned server cleanup unknown.' }
  }
  if (failure) status = emptyOpenCodeV2ReadStatus(native, directory)
  return openCodeV2InventorySnapshot(native, directory, status, failure)
}
