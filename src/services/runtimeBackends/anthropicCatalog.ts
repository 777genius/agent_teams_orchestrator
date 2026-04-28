import axios from 'axios'

import {
  convertEffortValueToLevel,
  getDefaultEffortForModel,
  modelSupportsEffort,
  modelSupportsMaxEffort,
} from '../../utils/effort.js'
import {
  getAuthHeaders,
  getUserAgent,
  withOAuth401Retry,
} from '../../utils/http.js'
import {
  getFastModeUnavailableReason,
  isFastModeEnabled,
  isFastModeSupportedByModel,
} from '../../utils/fastMode.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import type {
  RuntimeProviderModelCatalog,
  RuntimeProviderModelCatalogItem,
  RuntimeProviderModelCatalogStatus,
  RuntimeProviderCapabilities,
  RuntimeReasoningEffort,
} from './types.js'

const ANTHROPIC_MODELS_API_VERSION = '2023-06-01'
const ANTHROPIC_MODELS_API_LIMIT = 1_000
const ANTHROPIC_SUCCESS_CACHE_TTL_MS = 10 * 60 * 1_000
const ANTHROPIC_FALLBACK_CACHE_TTL_MS = 60 * 1_000
const ONE_MILLION_INPUT_TOKENS = 1_000_000
const ANTHROPIC_DEFAULT_LAUNCH_MODEL = 'opus[1m]'
const ANTHROPIC_STATIC_VISIBLE_MODELS = new Set(['opus', 'claude-opus-4-6', 'sonnet', 'haiku'])
const ANTHROPIC_EFFORT_ORDER: RuntimeReasoningEffort[] = ['low', 'medium', 'high', 'max']

type AnthropicCatalogFamily = 'opus' | 'sonnet' | 'haiku'

export type AnthropicApiModelInfo = {
  id?: string
  type?: string
  display_name?: string
  created_at?: string
  max_input_tokens?: number | null
  max_tokens?: number | null
  capabilities?: Record<string, unknown> | null
}

type AnthropicApiModelListResponse = {
  data?: AnthropicApiModelInfo[]
}

type AnthropicLaunchDefinition = {
  launchModel: string
  family: AnthropicCatalogFamily
  preferredLiveIds: string[]
  fallbackDisplayName: string
  fallbackReasoningEfforts: RuntimeReasoningEffort[]
  hidden: boolean
  requiresOneMillionContext: boolean
}

type CachedAnthropicCatalog = {
  catalog: RuntimeProviderModelCatalog
  expiresAt: number
}

const ANTHROPIC_LAUNCH_DEFINITIONS: readonly AnthropicLaunchDefinition[] = [
  {
    launchModel: 'opus',
    family: 'opus',
    preferredLiveIds: ['claude-opus-4-7', 'claude-opus-4-6'],
    fallbackDisplayName: 'Opus 4.7',
    fallbackReasoningEfforts: ['low', 'medium', 'high', 'max'],
    hidden: false,
    requiresOneMillionContext: false,
  },
  {
    launchModel: 'opus[1m]',
    family: 'opus',
    preferredLiveIds: ['claude-opus-4-7', 'claude-opus-4-6'],
    fallbackDisplayName: 'Opus 4.7 (1M)',
    fallbackReasoningEfforts: ['low', 'medium', 'high', 'max'],
    hidden: true,
    requiresOneMillionContext: true,
  },
  {
    launchModel: 'claude-opus-4-7',
    family: 'opus',
    preferredLiveIds: ['claude-opus-4-7'],
    fallbackDisplayName: 'Opus 4.7',
    fallbackReasoningEfforts: ['low', 'medium', 'high', 'max'],
    hidden: true,
    requiresOneMillionContext: false,
  },
  {
    launchModel: 'claude-opus-4-7[1m]',
    family: 'opus',
    preferredLiveIds: ['claude-opus-4-7'],
    fallbackDisplayName: 'Opus 4.7 (1M)',
    fallbackReasoningEfforts: ['low', 'medium', 'high', 'max'],
    hidden: true,
    requiresOneMillionContext: true,
  },
  {
    launchModel: 'claude-opus-4-6',
    family: 'opus',
    preferredLiveIds: ['claude-opus-4-6'],
    fallbackDisplayName: 'Opus 4.6',
    fallbackReasoningEfforts: ['low', 'medium', 'high', 'max'],
    hidden: false,
    requiresOneMillionContext: false,
  },
  {
    launchModel: 'claude-opus-4-6[1m]',
    family: 'opus',
    preferredLiveIds: ['claude-opus-4-6'],
    fallbackDisplayName: 'Opus 4.6 (1M)',
    fallbackReasoningEfforts: ['low', 'medium', 'high', 'max'],
    hidden: true,
    requiresOneMillionContext: true,
  },
  {
    launchModel: 'sonnet',
    family: 'sonnet',
    preferredLiveIds: ['claude-sonnet-4-6'],
    fallbackDisplayName: 'Sonnet 4.6',
    fallbackReasoningEfforts: ['low', 'medium', 'high', 'max'],
    hidden: false,
    requiresOneMillionContext: false,
  },
  {
    launchModel: 'sonnet[1m]',
    family: 'sonnet',
    preferredLiveIds: ['claude-sonnet-4-6'],
    fallbackDisplayName: 'Sonnet 4.6 (1M)',
    fallbackReasoningEfforts: ['low', 'medium', 'high', 'max'],
    hidden: true,
    requiresOneMillionContext: true,
  },
  {
    launchModel: 'claude-sonnet-4-6',
    family: 'sonnet',
    preferredLiveIds: ['claude-sonnet-4-6'],
    fallbackDisplayName: 'Sonnet 4.6',
    fallbackReasoningEfforts: ['low', 'medium', 'high', 'max'],
    hidden: true,
    requiresOneMillionContext: false,
  },
  {
    launchModel: 'claude-sonnet-4-6[1m]',
    family: 'sonnet',
    preferredLiveIds: ['claude-sonnet-4-6'],
    fallbackDisplayName: 'Sonnet 4.6 (1M)',
    fallbackReasoningEfforts: ['low', 'medium', 'high', 'max'],
    hidden: true,
    requiresOneMillionContext: true,
  },
  {
    launchModel: 'haiku',
    family: 'haiku',
    preferredLiveIds: ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
    fallbackDisplayName: 'Haiku 4.5',
    fallbackReasoningEfforts: ['low', 'medium', 'high'],
    hidden: false,
    requiresOneMillionContext: false,
  },
  {
    launchModel: 'claude-haiku-4-5',
    family: 'haiku',
    preferredLiveIds: ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
    fallbackDisplayName: 'Haiku 4.5',
    fallbackReasoningEfforts: ['low', 'medium', 'high'],
    hidden: true,
    requiresOneMillionContext: false,
  },
  {
    launchModel: 'claude-haiku-4-5-20251001',
    family: 'haiku',
    preferredLiveIds: ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
    fallbackDisplayName: 'Haiku 4.5',
    fallbackReasoningEfforts: ['low', 'medium', 'high'],
    hidden: true,
    requiresOneMillionContext: false,
  },
] as const

let cachedAnthropicCatalog: CachedAnthropicCatalog | null = null
let inFlightAnthropicCatalogPromise: Promise<RuntimeProviderModelCatalog> | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeModelKey(value: string | undefined | null): string {
  return value?.trim().toLowerCase() ?? ''
}

function getAnthropicApiBaseUrl(): string {
  const configured = process.env.ANTHROPIC_BASE_URL?.trim()
  const baseUrl = configured && configured.length > 0 ? configured : 'https://api.anthropic.com'
  return baseUrl.replace(/\/+$/, '')
}

function readCapabilitySupport(value: unknown): boolean {
  if (value === true) {
    return true
  }
  if (!isRecord(value)) {
    return false
  }
  return value.supported === true
}

function cleanAnthropicDisplayName(displayName: string | undefined, fallback: string): string {
  const normalized = displayName?.trim().replace(/^Claude\s+/i, '')
  return normalized && normalized.length > 0 ? normalized : fallback
}

function supportsOneMillionContext(model: AnthropicApiModelInfo | null): boolean {
  return typeof model?.max_input_tokens === 'number' && model.max_input_tokens >= ONE_MILLION_INPUT_TOKENS
}

function hasCompleteCapabilityData(model: AnthropicApiModelInfo | null | undefined): boolean {
  return Boolean(
    model
    && isRecord(model.capabilities)
    && typeof model.max_input_tokens === 'number'
    && typeof model.max_tokens === 'number',
  )
}

function normalizeResolvedModelId(model: AnthropicApiModelInfo | null): string | null {
  const resolvedId = model?.id?.trim()
  return resolvedId && resolvedId.length > 0 ? resolvedId : null
}

function resolveFallbackPreferredModelId(
  definition: AnthropicLaunchDefinition,
): string | null {
  const preferredModelId = definition.preferredLiveIds[0]?.trim()
  return preferredModelId && preferredModelId.length > 0 ? preferredModelId : null
}

function resolveRuntimeBackedAnthropicEfforts(model: AnthropicApiModelInfo | null): RuntimeReasoningEffort[] {
  const resolvedModelId = normalizeResolvedModelId(model)
  if (!resolvedModelId || !modelSupportsEffort(resolvedModelId)) {
    return []
  }

  const efforts: RuntimeReasoningEffort[] = ['low', 'medium', 'high']
  if (modelSupportsMaxEffort(resolvedModelId)) {
    efforts.push('max')
  }
  return efforts
}

function resolveAnthropicDefaultReasoningEffort(
  model: AnthropicApiModelInfo | null,
): RuntimeReasoningEffort | null {
  const resolvedModelId = normalizeResolvedModelId(model)
  if (!resolvedModelId || !modelSupportsEffort(resolvedModelId)) {
    return null
  }

  try {
    const defaultEffort = getDefaultEffortForModel(resolvedModelId)
    return defaultEffort === undefined ? 'high' : convertEffortValueToLevel(defaultEffort)
  } catch {
    // Runtime catalog fallback must stay usable even when auth-scoped
    // subscriber metadata is unavailable in the current process.
    return 'high'
  }
}

function resolveAnthropicFastModeSupport(model: AnthropicApiModelInfo | null): boolean {
  const resolvedModelId = normalizeResolvedModelId(model)
  if (!resolvedModelId) {
    return false
  }

  return isFastModeSupportedByModel(resolvedModelId)
}

function parseAnthropicInputModalities(model: AnthropicApiModelInfo | null): string[] {
  const capabilities = model?.capabilities
  if (!isRecord(capabilities)) {
    return ['text']
  }

  const modalities = ['text']
  if (readCapabilitySupport(capabilities.image_input)) {
    modalities.push('image')
  }
  if (readCapabilitySupport(capabilities.pdf_input)) {
    modalities.push('pdf')
  }
  return modalities
}

function mergeAnthropicModels(
  existing: AnthropicApiModelInfo | undefined,
  nextModel: AnthropicApiModelInfo,
): AnthropicApiModelInfo {
  if (!existing) {
    return nextModel
  }

  return {
    ...existing,
    ...nextModel,
    capabilities:
      isRecord(nextModel.capabilities)
        ? nextModel.capabilities
        : existing.capabilities ?? nextModel.capabilities,
  }
}

function formatAnthropicCatalogItemDisplayName(
  definition: AnthropicLaunchDefinition,
  liveModel: AnthropicApiModelInfo | null,
): string {
  const fallbackDisplayName = definition.fallbackDisplayName.replace(/\s+\(1M\)$/i, '')
  const liveDisplayName = cleanAnthropicDisplayName(liveModel?.display_name, fallbackDisplayName)
  return definition.requiresOneMillionContext ? `${liveDisplayName} (1M)` : liveDisplayName
}

function createAnthropicCatalogItem(params: {
  definition: AnthropicLaunchDefinition
  liveModel: AnthropicApiModelInfo | null
  isDefault: boolean
  source: 'anthropic-models-api' | 'static-fallback'
  statusMessage?: string | null
}): RuntimeProviderModelCatalogItem {
  const displayName = formatAnthropicCatalogItemDisplayName(params.definition, params.liveModel)
  const supportedReasoningEfforts =
    params.source === 'anthropic-models-api'
      ? resolveRuntimeBackedAnthropicEfforts(params.liveModel)
      : params.definition.fallbackReasoningEfforts
  const defaultReasoningEffort =
    params.source === 'anthropic-models-api'
      ? resolveAnthropicDefaultReasoningEffort(params.liveModel)
      : resolveAnthropicDefaultReasoningEffort({
          id: resolveFallbackPreferredModelId(params.definition),
        })

  return {
    id: params.definition.launchModel,
    launchModel: params.definition.launchModel,
    displayName,
    hidden: params.definition.hidden,
    supportedReasoningEfforts,
    defaultReasoningEffort,
    supportsFastMode:
      params.source === 'anthropic-models-api'
        ? resolveAnthropicFastModeSupport(params.liveModel)
        : false,
    inputModalities:
      params.source === 'anthropic-models-api'
        ? parseAnthropicInputModalities(params.liveModel)
        : ['text', 'image'],
    supportsPersonality: false,
    isDefault: params.isDefault,
    upgrade: false,
    source: params.source,
    badgeLabel: params.definition.hidden ? null : displayName,
    statusMessage: params.statusMessage ?? null,
  }
}

function dedupeCatalogModels(
  models: RuntimeProviderModelCatalogItem[],
): RuntimeProviderModelCatalogItem[] {
  const seen = new Set<string>()
  const deduped: RuntimeProviderModelCatalogItem[] = []

  for (const model of models) {
    const key = normalizeModelKey(model.launchModel)
    if (!key || seen.has(key)) {
      continue
    }
    seen.add(key)
    deduped.push(model)
  }

  return deduped
}

function buildAnthropicCatalogDiagnostics(params: {
  status: RuntimeProviderModelCatalogStatus
  message?: string | null
  code?: string | null
}): RuntimeProviderModelCatalog['diagnostics'] {
  if (params.status === 'ready') {
    return {
      configReadState: 'ready',
      appServerState: 'healthy',
      message: params.message ?? null,
      code: params.code ?? null,
    }
  }

  return {
    configReadState: params.code === 'anthropic-auth-missing' ? 'skipped' : 'failed',
    appServerState: 'degraded',
    message: params.message ?? null,
    code: params.code ?? null,
  }
}

function buildAnthropicCatalogFromDefinitions(params: {
  fetchedAt: string
  staleAt: string
  liveModelsById: Map<string, AnthropicApiModelInfo>
  liveSourceEnabled: boolean
  status: RuntimeProviderModelCatalogStatus
  diagnosticsMessage?: string | null
  diagnosticsCode?: string | null
}): RuntimeProviderModelCatalog {
  const models = dedupeCatalogModels(
    ANTHROPIC_LAUNCH_DEFINITIONS.flatMap((definition) => {
      const liveModel = definition.preferredLiveIds
        .map((candidateId) => params.liveModelsById.get(normalizeModelKey(candidateId)) ?? null)
        .find((candidate) => {
          if (!candidate) {
            return false
          }
          if (definition.requiresOneMillionContext) {
            return supportsOneMillionContext(candidate)
          }
          return true
        }) ?? null

      if (liveModel && !isModelAllowed(definition.launchModel)) {
        return []
      }

      if (liveModel) {
        return [
          createAnthropicCatalogItem({
            definition,
            liveModel,
            isDefault: definition.launchModel === ANTHROPIC_DEFAULT_LAUNCH_MODEL,
            source: 'anthropic-models-api',
          }),
        ]
      }

      if (!isModelAllowed(definition.launchModel)) {
        return []
      }

      return [
        createAnthropicCatalogItem({
          definition,
          liveModel: null,
          isDefault: definition.launchModel === ANTHROPIC_DEFAULT_LAUNCH_MODEL,
          source: 'static-fallback',
          statusMessage: params.liveSourceEnabled
            ? 'Using compatibility fallback because the live Anthropic catalog did not confirm this launch value.'
            : 'Using static fallback because the live Anthropic catalog is unavailable.',
        }),
      ]
    }),
  )

  const defaultModelId =
    models.find((model) => model.launchModel === ANTHROPIC_DEFAULT_LAUNCH_MODEL)?.id
    ?? models.find((model) => model.launchModel === 'opus')?.id
    ?? models[0]?.id
    ?? null
  const defaultLaunchModel =
    models.find((model) => model.launchModel === ANTHROPIC_DEFAULT_LAUNCH_MODEL)?.launchModel
    ?? models.find((model) => model.launchModel === 'opus')?.launchModel
    ?? models[0]?.launchModel
    ?? null

  return {
    schemaVersion: 1,
    providerId: 'anthropic',
    source: params.liveSourceEnabled ? 'anthropic-models-api' : 'static-fallback',
    status: params.status,
    fetchedAt: params.fetchedAt,
    staleAt: params.staleAt,
    defaultModelId,
    defaultLaunchModel,
    models,
    diagnostics: buildAnthropicCatalogDiagnostics({
      status: params.status,
      message: params.diagnosticsMessage ?? null,
      code: params.diagnosticsCode ?? null,
    }),
  }
}

function createLiveModelIndex(
  models: AnthropicApiModelInfo[],
): Map<string, AnthropicApiModelInfo> {
  const indexedModels = new Map<string, AnthropicApiModelInfo>()

  for (const model of models) {
    const modelId = normalizeModelKey(model.id)
    if (!modelId) {
      continue
    }

    indexedModels.set(modelId, mergeAnthropicModels(indexedModels.get(modelId), model))
  }

  return indexedModels
}

async function fetchAnthropicModelList(): Promise<AnthropicApiModelInfo[]> {
  const auth = getAuthHeaders()
  if (auth.error) {
    throw new Error(auth.error)
  }

  const response = await withOAuth401Retry(() =>
    axios.get<AnthropicApiModelListResponse>(`${getAnthropicApiBaseUrl()}/v1/models`, {
      headers: {
        ...auth.headers,
        'anthropic-version': ANTHROPIC_MODELS_API_VERSION,
        'user-agent': getUserAgent(),
      },
      params: {
        limit: ANTHROPIC_MODELS_API_LIMIT,
      },
      timeout: 10_000,
    }),
  )

  return response.data.data?.filter((model) => model.type === 'model' && normalizeModelKey(model.id).startsWith('claude-')) ?? []
}

async function fetchAnthropicModelById(
  modelId: string,
): Promise<AnthropicApiModelInfo | null> {
  const auth = getAuthHeaders()
  if (auth.error) {
    return null
  }

  const response = await withOAuth401Retry(() =>
    axios.get<AnthropicApiModelInfo>(`${getAnthropicApiBaseUrl()}/v1/models/${modelId}`, {
      headers: {
        ...auth.headers,
        'anthropic-version': ANTHROPIC_MODELS_API_VERSION,
        'user-agent': getUserAgent(),
      },
      timeout: 10_000,
    }),
  )

  return response.data
}

async function enrichAnthropicCuratedModels(
  liveModelsById: Map<string, AnthropicApiModelInfo>,
): Promise<Map<string, AnthropicApiModelInfo>> {
  const curatedIds = Array.from(
    new Set(
      ANTHROPIC_LAUNCH_DEFINITIONS.flatMap((definition) => definition.preferredLiveIds).map(
        normalizeModelKey,
      ),
    ),
  )

  for (const curatedId of curatedIds) {
    const existing = liveModelsById.get(curatedId)
    if (hasCompleteCapabilityData(existing)) {
      continue
    }

    try {
      const retrieved = await fetchAnthropicModelById(curatedId)
      if (!retrieved) {
        continue
      }

      liveModelsById.set(curatedId, mergeAnthropicModels(existing, retrieved))
      const resolvedId = normalizeModelKey(retrieved.id)
      if (resolvedId) {
        liveModelsById.set(
          resolvedId,
          mergeAnthropicModels(liveModelsById.get(resolvedId), retrieved),
        )
      }
    } catch {
      // Fall back to the current partial metadata or static compatibility entries.
    }
  }

  return liveModelsById
}

function getErrorCode(error: unknown): string | null {
  if (!axios.isAxiosError(error)) {
    return null
  }

  const status = error.response?.status
  if (typeof status === 'number') {
    return `http-${status}`
  }

  return error.code ?? null
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function cacheAnthropicCatalog(
  catalog: RuntimeProviderModelCatalog,
  ttlMs: number,
): RuntimeProviderModelCatalog {
  cachedAnthropicCatalog = {
    catalog,
    expiresAt: Date.now() + ttlMs,
  }
  return catalog
}

export function getAnthropicVisibleRuntimeModels(
  catalog: RuntimeProviderModelCatalog,
): string[] {
  return catalog.models
    .filter((model) => !model.hidden && ANTHROPIC_STATIC_VISIBLE_MODELS.has(model.launchModel))
    .map((model) => model.launchModel)
}

export function getAnthropicRuntimeReasoningEfforts(
  catalog: RuntimeProviderModelCatalog,
): RuntimeReasoningEffort[] {
  return ANTHROPIC_EFFORT_ORDER.filter((effort) =>
    catalog.models.some((model) => model.supportedReasoningEfforts.includes(effort)),
  )
}

export function getAnthropicRuntimeFastModeCapability(): NonNullable<
  RuntimeProviderCapabilities['fastMode']
> {
  const supported = isFastModeEnabled()
  const runtimeUnavailableReason = supported
    ? getFastModeUnavailableReason()
    : 'Fast mode is not available'
  const available =
    supported
    && (runtimeUnavailableReason === null
      || runtimeUnavailableReason === 'Fast mode is not available in the Agent SDK')

  return {
    supported,
    available,
    reason: available ? null : runtimeUnavailableReason,
    source: 'runtime',
  }
}

export function createStaticAnthropicRuntimeModelCatalog(params: {
  fetchedAt?: string
  staleAt?: string
  status?: RuntimeProviderModelCatalogStatus
  message?: string | null
  code?: string | null
} = {}): RuntimeProviderModelCatalog {
  const fetchedAt = params.fetchedAt ?? new Date().toISOString()
  const staleAt = params.staleAt ?? new Date(Date.now() + ANTHROPIC_FALLBACK_CACHE_TTL_MS).toISOString()

  return buildAnthropicCatalogFromDefinitions({
    fetchedAt,
    staleAt,
    liveModelsById: new Map(),
    liveSourceEnabled: false,
    status: params.status ?? 'stale',
    diagnosticsMessage: params.message ?? 'Using the static Anthropic compatibility catalog.',
    diagnosticsCode: params.code ?? null,
  })
}

export function buildAnthropicRuntimeModelCatalogFromApiModels(
  models: AnthropicApiModelInfo[],
  params: {
    fetchedAt?: string
    staleAt?: string
  } = {},
): RuntimeProviderModelCatalog {
  const fetchedAt = params.fetchedAt ?? new Date().toISOString()
  const staleAt = params.staleAt ?? new Date(Date.now() + ANTHROPIC_SUCCESS_CACHE_TTL_MS).toISOString()

  return buildAnthropicCatalogFromDefinitions({
    fetchedAt,
    staleAt,
    liveModelsById: createLiveModelIndex(models),
    liveSourceEnabled: true,
    status: 'ready',
  })
}

export function resetAnthropicRuntimeCatalogCache(): void {
  cachedAnthropicCatalog = null
  inFlightAnthropicCatalogPromise = null
}

export async function getAnthropicRuntimeModelCatalog(): Promise<RuntimeProviderModelCatalog> {
  if (cachedAnthropicCatalog && cachedAnthropicCatalog.expiresAt > Date.now()) {
    return cachedAnthropicCatalog.catalog
  }

  if (inFlightAnthropicCatalogPromise) {
    return inFlightAnthropicCatalogPromise
  }

  inFlightAnthropicCatalogPromise = (async () => {
    const fetchedAt = new Date().toISOString()
    const liveStaleAt = new Date(Date.now() + ANTHROPIC_SUCCESS_CACHE_TTL_MS).toISOString()
    const fallbackStaleAt = new Date(Date.now() + ANTHROPIC_FALLBACK_CACHE_TTL_MS).toISOString()
    const auth = getAuthHeaders()

    if (auth.error) {
      return cacheAnthropicCatalog(
        createStaticAnthropicRuntimeModelCatalog({
          fetchedAt,
          staleAt: fallbackStaleAt,
          status: 'stale',
          message: 'Using the static Anthropic catalog because no authenticated Anthropic API session is available.',
          code: 'anthropic-auth-missing',
        }),
        ANTHROPIC_FALLBACK_CACHE_TTL_MS,
      )
    }

    try {
      const listedModels = await fetchAnthropicModelList()
      const liveModelsById = await enrichAnthropicCuratedModels(createLiveModelIndex(listedModels))
      const catalog = buildAnthropicCatalogFromDefinitions({
        fetchedAt,
        staleAt: liveStaleAt,
        liveModelsById,
        liveSourceEnabled: true,
        status: 'ready',
      })
      return cacheAnthropicCatalog(catalog, ANTHROPIC_SUCCESS_CACHE_TTL_MS)
    } catch (error) {
      return cacheAnthropicCatalog(
        createStaticAnthropicRuntimeModelCatalog({
          fetchedAt,
          staleAt: fallbackStaleAt,
          status: 'degraded',
          message: `Anthropic Models API unavailable. Using static fallback. ${getErrorMessage(error)}`.trim(),
          code: getErrorCode(error) ?? 'anthropic-models-api-error',
        }),
        ANTHROPIC_FALLBACK_CACHE_TTL_MS,
      )
    }
  })()

  try {
    return await inFlightAnthropicCatalogPromise
  } finally {
    inFlightAnthropicCatalogPromise = null
  }
}
