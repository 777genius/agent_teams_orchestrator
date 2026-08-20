import type {
  ProviderActionDescriptor,
  ProviderDirectoryEntry,
  ProviderDirectoryFilter,
  ProviderDirectoryView,
} from '../../features/runtimeProviderManagement/domain/types.js'
import { OpenCodePassiveStatusProductionReader } from './OpenCodePassiveStatusProductionReader.js'
import type { OpenCodePassiveStatusV1 } from './OpenCodePassiveStatusContract.js'
import { OPEN_CODE_PASSIVE_MAX_PROVIDERS } from './OpenCodePassiveStatusContract.js'
import {
  readOpenCodePassiveStatusWithinRouteDeadline,
  type OpenCodePassiveRouteDeadlineDeps,
  type OpenCodePassiveRouteRead,
} from './OpenCodePassiveRouteDeadline.js'
import { getOpenCodeCuratedSubscriptionProviderIds } from './OpenCodeCuratedSubscriptionCatalog.js'

const OPEN_CODE_PASSIVE_BASE_PROVIDER_IDS = [
  'amazon-bedrock', 'anthropic', 'azure', 'cerebras', 'cloudflare-ai-gateway',
  'cohere', 'cursor', 'cursor-acp', 'deepinfra', 'fireworks-ai', 'github-copilot',
  'google', 'groq', 'kiro', 'llama.cpp', 'llmgateway', 'lmstudio', 'mistral',
  'ollama', 'openai', 'opencode', 'openrouter', 'perplexity', 'togetherai',
  'venice', 'vertexai', 'xai',
] as const

// Passive status stays bounded to the summary allowlist, but the allowlist
// must include every app-supported curated subscription route. The curated
// catalog is authoritative so newly supported ids cannot become invisible in
// stored evidence merely because this read-only summary was not hand-edited.
export const OPEN_CODE_PASSIVE_DIRECTORY_PROVIDER_IDS: readonly string[] = Object.freeze(
  Array.from(new Set([
    ...OPEN_CODE_PASSIVE_BASE_PROVIDER_IDS,
    ...getOpenCodeCuratedSubscriptionProviderIds(),
  ])),
)

if (OPEN_CODE_PASSIVE_DIRECTORY_PROVIDER_IDS.length > OPEN_CODE_PASSIVE_MAX_PROVIDERS) {
  throw new Error('OpenCode passive provider directory exceeds the shared request capacity')
}

export type OpenCodePassiveProviderDirectoryInput = Readonly<{
  projectPath: string
  query?: string | null
  filter?: ProviderDirectoryFilter | null
  limit?: number | null
  cursor?: string | null
  timeoutMs?: number
}>

const READ_ONLY_ACTIONS: readonly ProviderActionDescriptor[] = Object.freeze([{
  id: 'connect',
  label: 'Connect',
  enabled: false,
  disabledReason: 'Passive summary cannot mutate provider configuration.',
  requiresSecret: false,
  ownershipScope: 'runtime',
}])

let defaultReader: OpenCodePassiveStatusProductionReader | null = null

export async function readOpenCodePassiveProviderDirectory(
  input: OpenCodePassiveProviderDirectoryInput,
  read: OpenCodePassiveRouteRead | null = null,
  deadlineDeps: OpenCodePassiveRouteDeadlineDeps = {},
): Promise<ProviderDirectoryView> {
  const readStatus = read ?? (request => {
    defaultReader ??= new OpenCodePassiveStatusProductionReader()
    return defaultReader.reader.read(request)
  })
  const status = await readOpenCodePassiveStatusWithinRouteDeadline(readStatus, {
    projectPath: input.projectPath,
    providerIds: OPEN_CODE_PASSIVE_DIRECTORY_PROVIDER_IDS,
    timeoutMs: input.timeoutMs ?? 250,
  }, deadlineDeps)
  return buildOpenCodePassiveProviderDirectory(status, input)
}

export function buildOpenCodePassiveProviderDirectory(
  status: OpenCodePassiveStatusV1,
  input: Omit<OpenCodePassiveProviderDirectoryInput, 'projectPath' | 'timeoutMs'> = {},
): ProviderDirectoryView {
  const filter = input.filter ?? 'all'
  const query = input.query?.trim().toLowerCase() || null
  const all = status.providers.map(provider => {
    const connected = provider.lastConnected.value.state === 'connected'
    const configured = provider.configured.value === 'configured'
    const state: ProviderDirectoryEntry['state'] = connected
      ? 'connected'
      : configured ? 'not-connected' : 'available'
    return {
      providerId: provider.providerId,
      displayName: displayName(provider.providerId),
      state,
      connectedAuthHint: null,
      setupKind: 'available-readonly' as const,
      ownership: [] as const,
      recommended: false,
      modelCount: null,
      authMethods: [] as const,
      defaultModelId: null,
      sources: ['inventory'] as const,
      sourceLabel: 'passive redacted snapshot',
      providerSource: null,
      detail: passiveDetail(provider),
      actions: READ_ONLY_ACTIONS,
      metadata: {
        hasKnownModels: provider.catalogAvailable.value === 'available',
        requiresManualConfig: false,
        supportedInlineAuth: false,
        configuredAuthless: false,
      },
    } satisfies ProviderDirectoryEntry
  })
  const filtered = all.filter(entry => {
    if (query && !`${entry.providerId} ${entry.displayName}`.toLowerCase().includes(query)) return false
    if (filter === 'connected') return entry.state === 'connected'
    if (filter === 'configured') return entry.state === 'connected' || entry.state === 'not-connected'
    if (filter === 'connectable') return false
    if (filter === 'manual') return false
    if (filter === 'has-models') return entry.metadata.hasKnownModels
    return true
  })
  const parsedCursor = input.cursor && /^\d+$/.test(input.cursor) ? Number(input.cursor) : 0
  const offset = Number.isSafeInteger(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0
  const requestedLimit = input.limit ?? filtered.length
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit >= 0
    ? Math.min(requestedLimit, 100)
    : filtered.length
  const entries = filtered.slice(offset, offset + limit)
  const nextOffset = offset + entries.length
  return {
    runtimeId: 'opencode',
    totalCount: filtered.length,
    returnedCount: entries.length,
    query,
    filter,
    limit,
    cursor: input.cursor ?? null,
    nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
    entries,
    diagnostics: status.projectScope === null
      ? ['passive_scope_unavailable']
      : status.providers.some(provider => provider.configured.condition === 'degraded')
        ? ['passive_status_degraded']
        : [],
    fetchedAt: new Date(status.completedAt).toISOString(),
  }
}

function displayName(providerId: string): string {
  return providerId.split(/[-.]/g).filter(Boolean)
    .map(part => part.length <= 3 ? part.toUpperCase() : `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function passiveDetail(provider: OpenCodePassiveStatusV1['providers'][number]): string {
  return [
    `configured=${provider.configured.value}`,
    `last_connected=${provider.lastConnected.value.state}`,
    `catalog=${provider.catalogAvailable.value}`,
    `execution=${provider.executionVerified.value}`,
  ].join('; ')
}
