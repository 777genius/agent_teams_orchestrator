import { createHash } from 'node:crypto'

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
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from '../../utils/model/providers.js'
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
const ANTHROPIC_STATIC_VISIBLE_MODELS = new Set([
  'opus',
  'claude-opus-4-6',
  'sonnet',
  'haiku',
])
const ANTHROPIC_EFFORT_ORDER: RuntimeReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'max',
]

type AnthropicCatalogFamily = 'opus' | 'sonnet' | 'haiku'

export type AnthropicApiModelInfo = {
  id?: string
  type?: string
  object?: string
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
  cacheKey: string
  expiresAt: number
}

const ANTHROPIC_LAUNCH_DEFINITIONS: readonly AnthropicLaunchDefinition[] = [
  {
    launchModel: 'opus',
    family: 'opus',
    preferredLiveIds: [
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
    ],
    fallbackDisplayName: 'Opus 4.8',
    fallbackReasoningEfforts: ['low', 'medium', 'high', 'max'],
    hidden: false,
    requiresOneMillionContext: false,
  },
  {
    launchModel: 'opus[1m]',
    family: 'opus',
    preferredLiveIds: [
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
    ],
    fallbackDisplayName: 'Opus 4.8 (1M)',
    fallbackReasoningEfforts: ['low', 'medium', 'high', 'max'],
    hidden: true,
    requiresOneMillionContext: true,
  },
  {
    launchModel: 'claude-opus-4-8',
    family: 'opus',
    preferredLiveIds: ['claude-opus-4-8'],
    fallbackDisplayName: 'Opus 4.8',
    fallbackReasoningEfforts: ['low', 'medium', 'high', 'max'],
    hidden: true,
    requiresOneMillionContext: false,
  },
  {
    launchModel: 'claude-opus-4-8[1m]',
    family: 'opus',
    preferredLiveIds: ['claude-opus-4-8'],
    fallbackDisplayName: 'Opus 4.8 (1M)',
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
    fallbackReasoningEfforts: [],
    hidden: false,
    requiresOneMillionContext: false,
  },
  {
    launchModel: 'claude-haiku-4-5',
    family: 'haiku',
    preferredLiveIds: ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
    fallbackDisplayName: 'Haiku 4.5',
    fallbackReasoningEfforts: [],
    hidden: true,
    requiresOneMillionContext: false,
  },
  {
    launchModel: 'claude-haiku-4-5-20251001',
    family: 'haiku',
    preferredLiveIds: ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
    fallbackDisplayName: 'Haiku 4.5',
    fallbackReasoningEfforts: [],
    hidden: true,
    requiresOneMillionContext: false,
  },
] as const

let cachedAnthropicCatalog: CachedAnthropicCatalog | null = null
let inFlightAnthropicCatalogPromise: Promise<RuntimeProviderModelCatalog> | null =
  null
let inFlightAnthropicCatalogCacheKey: string | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeModelKey(value: string | undefined | null): string {
  return value?.trim().toLowerCase() ?? ''
}

function getAnthropicApiBaseUrl(): string {
  const configured = process.env.ANTHROPIC_BASE_URL?.trim()
  const baseUrl =
    configured && configured.length > 0
      ? configured
      : 'https://api.anthropic.com'
  return baseUrl.replace(/\/+$/, '')
}

function buildAnthropicApiUrl(pathname: string): string {
  const baseUrl = getAnthropicApiBaseUrl()
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`
  if (baseUrl.endsWith('/v1/models')) {
    if (normalizedPath === '/v1/models') {
      return baseUrl
    }
    if (normalizedPath.startsWith('/v1/models/')) {
      return `${baseUrl}${normalizedPath.slice('/v1/models'.length)}`
    }
  }
  if (baseUrl.endsWith('/v1') && normalizedPath.startsWith('/v1/')) {
    return `${baseUrl}${normalizedPath.slice('/v1'.length)}`
  }
  return `${baseUrl}${normalizedPath}`
}

export function isAnthropicCompatibleRuntimeBaseUrl(): boolean {
  const configured = process.env.ANTHROPIC_BASE_URL?.trim()
  return Boolean(configured) && !isFirstPartyAnthropicBaseUrl()
}

function isOllamaLikeAnthropicRuntimeBaseUrl(): boolean {
  const configured = process.env.ANTHROPIC_BASE_URL?.trim()
  if (process.env.ANTHROPIC_AUTH_TOKEN?.trim().toLowerCase() === 'ollama') {
    return true
  }
  if (!configured) {
    return false
  }
  try {
    const url = new URL(configured)
    return url.port === '11434'
  } catch {
    return false
  }
}

export function getAnthropicCompatibleRuntimeBackendLabel():
  | 'ollama'
  | 'anthropic-compatible' {
  return isOllamaLikeAnthropicRuntimeBaseUrl()
    ? 'ollama'
    : 'anthropic-compatible'
}

function getAnthropicCompatibleAuthHeaders(): Record<string, string> {
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim()
  if (authToken) {
    return { Authorization: `Bearer ${authToken}` }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim()
  if (apiKey) {
    return { 'x-api-key': apiKey }
  }

  return {}
}

function getAnthropicCustomHeaders(): Record<string, string> {
  const customHeadersEnv = process.env.ANTHROPIC_CUSTOM_HEADERS
  if (!customHeadersEnv) {
    return {}
  }

  const headers: Record<string, string> = {}
  for (const headerString of customHeadersEnv.split(/\n|\r\n/)) {
    const colonIdx = headerString.indexOf(':')
    if (colonIdx === -1) {
      continue
    }
    const name = headerString.slice(0, colonIdx).trim()
    if (!name) {
      continue
    }
    headers[name] = headerString.slice(colonIdx + 1).trim()
  }
  return headers
}

export function getAnthropicCustomAuthorizationHeader(): string | null {
  for (const [name, value] of Object.entries(getAnthropicCustomHeaders())) {
    if (name.toLowerCase() === 'authorization') {
      const normalizedValue = value.trim()
      return normalizedValue.length > 0 ? normalizedValue : null
    }
  }
  return null
}

function fingerprintCacheInput(value: string | undefined): string {
  const normalizedValue = value?.trim()
  if (!normalizedValue) {
    return ''
  }
  return createHash('sha256').update(normalizedValue).digest('hex')
}

function getAnthropicCatalogCacheKey(): string {
  return JSON.stringify({
    apiProvider: getAPIProvider(),
    baseUrl: getAnthropicApiBaseUrl(),
    authToken: fingerprintCacheInput(process.env.ANTHROPIC_AUTH_TOKEN),
    apiKey: fingerprintCacheInput(process.env.ANTHROPIC_API_KEY),
    customHeaders: fingerprintCacheInput(process.env.ANTHROPIC_CUSTOM_HEADERS),
    userType: process.env.USER_TYPE?.trim() ?? '',
  })
}

function shouldAcceptAnthropicCompatibleModel(
  model: AnthropicApiModelInfo,
): boolean {
  const id = model.id?.trim()
  if (!id) {
    return false
  }
  const type = model.type?.trim()
  const object = model.object?.trim()
  return !type && !object ? true : type === 'model' || object === 'model'
}

function shouldAcceptFirstPartyAnthropicModel(
  model: AnthropicApiModelInfo,
): boolean {
  return (
    model.type === 'model' && normalizeModelKey(model.id).startsWith('claude-')
  )
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

function cleanAnthropicDisplayName(
  displayName: string | undefined,
  fallback: string,
): string {
  const normalized = displayName?.trim().replace(/^Claude\s+/i, '')
  return normalized && normalized.length > 0 ? normalized : fallback
}

function supportsOneMillionContext(
  model: AnthropicApiModelInfo | null,
): boolean {
  return (
    typeof model?.max_input_tokens === 'number' &&
    model.max_input_tokens >= ONE_MILLION_INPUT_TOKENS
  )
}

function hasCompleteCapabilityData(
  model: AnthropicApiModelInfo | null | undefined,
): boolean {
  return Boolean(
    model &&
    isRecord(model.capabilities) &&
    typeof model.max_input_tokens === 'number' &&
    typeof model.max_tokens === 'number',
  )
}

function normalizeResolvedModelId(
  model: AnthropicApiModelInfo | null,
): string | null {
  const resolvedId = model?.id?.trim()
  return resolvedId && resolvedId.length > 0 ? resolvedId : null
}

function resolveFallbackPreferredModelId(
  definition: AnthropicLaunchDefinition,
): string | null {
  const preferredModelId = definition.preferredLiveIds[0]?.trim()
  return preferredModelId && preferredModelId.length > 0
    ? preferredModelId
    : null
}

function resolveEffortsFromCapabilities(
  model: AnthropicApiModelInfo | null,
): RuntimeReasoningEffort[] | null {
  const capabilities = model?.capabilities
  if (!isRecord(capabilities)) {
    return null
  }
  const effortCapability = capabilities.effort
  if (!readCapabilitySupport(effortCapability)) {
    return null
  }
  if (!isRecord(effortCapability)) {
    return ['low', 'medium', 'high']
  }

  const efforts = ANTHROPIC_EFFORT_ORDER.filter((effort) =>
    readCapabilitySupport(effortCapability[effort]),
  )
  const resolvedModelId = normalizeResolvedModelId(model)
  if (
    resolvedModelId &&
    effortCapability.max === undefined &&
    modelSupportsMaxEffort(resolvedModelId) &&
    !efforts.includes('max')
  ) {
    efforts.push('max')
  }
  return efforts.length > 0 ? efforts : ['low', 'medium', 'high']
}

function resolveRuntimeBackedAnthropicEfforts(
  model: AnthropicApiModelInfo | null,
): RuntimeReasoningEffort[] {
  const capabilityEfforts = resolveEffortsFromCapabilities(model)
  if (capabilityEfforts) {
    return capabilityEfforts
  }

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
    return defaultEffort === undefined
      ? 'high'
      : convertEffortValueToLevel(defaultEffort)
  } catch {
    // Runtime catalog fallback must stay usable even when auth-scoped
    // subscriber metadata is unavailable in the current process.
    return 'high'
  }
}

function resolveAnthropicFastModeSupport(
  model: AnthropicApiModelInfo | null,
): boolean {
  const resolvedModelId = normalizeResolvedModelId(model)
  if (!resolvedModelId) {
    return false
  }

  return isFastModeSupportedByModel(resolvedModelId)
}

function parseAnthropicInputModalities(
  model: AnthropicApiModelInfo | null,
): string[] {
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
    capabilities: isRecord(nextModel.capabilities)
      ? nextModel.capabilities
      : (existing.capabilities ?? nextModel.capabilities),
  }
}

function formatAnthropicCatalogItemDisplayName(
  definition: AnthropicLaunchDefinition,
  liveModel: AnthropicApiModelInfo | null,
): string {
  const fallbackDisplayName = definition.fallbackDisplayName.replace(
    /\s+\(1M\)$/i,
    '',
  )
  const liveDisplayName = cleanAnthropicDisplayName(
    liveModel?.display_name,
    fallbackDisplayName,
  )
  return definition.requiresOneMillionContext
    ? `${liveDisplayName} (1M)`
    : liveDisplayName
}

function createAnthropicCatalogItem(params: {
  definition: AnthropicLaunchDefinition
  liveModel: AnthropicApiModelInfo | null
  isDefault: boolean
  source: 'anthropic-models-api' | 'static-fallback'
  statusMessage?: string | null
}): RuntimeProviderModelCatalogItem {
  const displayName = formatAnthropicCatalogItemDisplayName(
    params.definition,
    params.liveModel,
  )
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

function createLiveAnthropicCatalogItem(params: {
  model: AnthropicApiModelInfo
  isDefault: boolean
}): RuntimeProviderModelCatalogItem | null {
  const id = params.model.id?.trim()
  if (!id || !isModelAllowed(id)) {
    return null
  }

  return {
    id,
    launchModel: id,
    displayName: cleanAnthropicDisplayName(params.model.display_name, id),
    hidden: false,
    supportedReasoningEfforts: resolveRuntimeBackedAnthropicEfforts(
      params.model,
    ),
    defaultReasoningEffort: resolveAnthropicDefaultReasoningEffort(
      params.model,
    ),
    supportsFastMode: resolveAnthropicFastModeSupport(params.model),
    inputModalities: parseAnthropicInputModalities(params.model),
    supportsPersonality: false,
    isDefault: params.isDefault,
    upgrade: false,
    source: 'anthropic-models-api',
    badgeLabel: null,
    statusMessage: null,
    metadata: {
      context:
        typeof params.model.max_input_tokens === 'number'
          ? params.model.max_input_tokens
          : null,
    },
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
    configReadState:
      params.code === 'anthropic-auth-missing' ? 'skipped' : 'failed',
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
  const curatedModels = ANTHROPIC_LAUNCH_DEFINITIONS.flatMap((definition) => {
    const liveModel =
      definition.preferredLiveIds
        .map(
          (candidateId) =>
            params.liveModelsById.get(normalizeModelKey(candidateId)) ?? null,
        )
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
          isDefault:
            definition.launchModel === ANTHROPIC_DEFAULT_LAUNCH_MODEL,
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
  })

  const representedLiveIds = new Set(
    curatedModels.flatMap((model) => [
      normalizeModelKey(model.id),
      normalizeModelKey(model.launchModel),
    ]),
  )
  const livePassthroughModels = params.liveSourceEnabled
    ? Array.from(params.liveModelsById.values()).flatMap((model) => {
        const id = normalizeModelKey(model.id)
        if (!id || representedLiveIds.has(id)) {
          return []
        }
        const item = createLiveAnthropicCatalogItem({
          model,
          isDefault: false,
        })
        return item ? [item] : []
      })
    : []

  const models = dedupeCatalogModels([
    ...curatedModels,
    ...livePassthroughModels,
  ])

  const defaultModelId =
    models.find((model) => model.launchModel === ANTHROPIC_DEFAULT_LAUNCH_MODEL)
      ?.id ??
    models.find((model) => model.launchModel === 'opus')?.id ??
    models[0]?.id ??
    null
  const defaultLaunchModel =
    models.find((model) => model.launchModel === ANTHROPIC_DEFAULT_LAUNCH_MODEL)
      ?.launchModel ??
    models.find((model) => model.launchModel === 'opus')?.launchModel ??
    models[0]?.launchModel ??
    null

  return {
    schemaVersion: 1,
    providerId: 'anthropic',
    source: params.liveSourceEnabled
      ? 'anthropic-models-api'
      : 'static-fallback',
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

    indexedModels.set(
      modelId,
      mergeAnthropicModels(indexedModels.get(modelId), model),
    )
  }

  return indexedModels
}

async function fetchAnthropicModelList(): Promise<AnthropicApiModelInfo[]> {
  const compatibleEndpoint = isAnthropicCompatibleRuntimeBaseUrl()
  const auth = compatibleEndpoint ? null : getAuthHeaders()
  if (auth?.error) {
    throw new Error(auth.error)
  }

  const response = await withOAuth401Retry(() =>
    axios.get<AnthropicApiModelListResponse>(
      buildAnthropicApiUrl('/v1/models'),
      {
        headers: {
          ...getAnthropicCustomHeaders(),
          ...(compatibleEndpoint
            ? getAnthropicCompatibleAuthHeaders()
            : auth?.headers),
          'anthropic-version': ANTHROPIC_MODELS_API_VERSION,
          'user-agent': getUserAgent(),
        },
        params: {
          limit: ANTHROPIC_MODELS_API_LIMIT,
        },
        timeout: 10_000,
      },
    ),
  )

  const predicate = compatibleEndpoint
    ? shouldAcceptAnthropicCompatibleModel
    : shouldAcceptFirstPartyAnthropicModel
  return response.data.data?.filter(predicate) ?? []
}

async function fetchAnthropicModelById(
  modelId: string,
): Promise<AnthropicApiModelInfo | null> {
  const auth = getAuthHeaders()
  if (auth.error) {
    return null
  }

  const response = await withOAuth401Retry(() =>
    axios.get<AnthropicApiModelInfo>(
      buildAnthropicApiUrl(`/v1/models/${modelId}`),
      {
        headers: {
          ...getAnthropicCustomHeaders(),
          ...auth.headers,
          'anthropic-version': ANTHROPIC_MODELS_API_VERSION,
          'user-agent': getUserAgent(),
        },
        timeout: 10_000,
      },
    ),
  )

  return response.data
}

async function enrichAnthropicCuratedModels(
  liveModelsById: Map<string, AnthropicApiModelInfo>,
): Promise<Map<string, AnthropicApiModelInfo>> {
  const curatedIds = Array.from(
    new Set(
      ANTHROPIC_LAUNCH_DEFINITIONS.flatMap(
        (definition) => definition.preferredLiveIds,
      ).map(normalizeModelKey),
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
  cacheKey: string,
  ttlMs: number,
): RuntimeProviderModelCatalog {
  cachedAnthropicCatalog = {
    catalog,
    cacheKey,
    expiresAt: Date.now() + ttlMs,
  }
  return catalog
}

export function getAnthropicVisibleRuntimeModels(
  catalog: RuntimeProviderModelCatalog,
): string[] {
  if (
    catalog.source === 'anthropic-compatible-api' ||
    catalog.source === 'anthropic-models-api'
  ) {
    return catalog.models
      .filter((model) => !model.hidden)
      .map((model) => model.launchModel)
  }

  return catalog.models
    .filter(
      (model) =>
        !model.hidden && ANTHROPIC_STATIC_VISIBLE_MODELS.has(model.launchModel),
    )
    .map((model) => model.launchModel)
}

export function getAnthropicRuntimeReasoningEfforts(
  catalog: RuntimeProviderModelCatalog,
): RuntimeReasoningEffort[] {
  return ANTHROPIC_EFFORT_ORDER.filter((effort) =>
    catalog.models.some((model) =>
      model.supportedReasoningEfforts.includes(effort),
    ),
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
    supported &&
    (runtimeUnavailableReason === null ||
      runtimeUnavailableReason ===
        'Fast mode is not available in the Agent SDK')

  return {
    supported,
    available,
    reason: available ? null : runtimeUnavailableReason,
    source: 'runtime',
  }
}

export function createStaticAnthropicRuntimeModelCatalog(
  params: {
    fetchedAt?: string
    staleAt?: string
    status?: RuntimeProviderModelCatalogStatus
    message?: string | null
    code?: string | null
  } = {},
): RuntimeProviderModelCatalog {
  const fetchedAt = params.fetchedAt ?? new Date().toISOString()
  const staleAt =
    params.staleAt ??
    new Date(Date.now() + ANTHROPIC_FALLBACK_CACHE_TTL_MS).toISOString()

  return buildAnthropicCatalogFromDefinitions({
    fetchedAt,
    staleAt,
    liveModelsById: new Map(),
    liveSourceEnabled: false,
    status: params.status ?? 'stale',
    diagnosticsMessage:
      params.message ?? 'Using the static Anthropic compatibility catalog.',
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
  const staleAt =
    params.staleAt ??
    new Date(Date.now() + ANTHROPIC_SUCCESS_CACHE_TTL_MS).toISOString()

  return buildAnthropicCatalogFromDefinitions({
    fetchedAt,
    staleAt,
    liveModelsById: createLiveModelIndex(models),
    liveSourceEnabled: true,
    status: 'ready',
  })
}

export function buildAnthropicCompatibleRuntimeModelCatalogFromApiModels(
  models: AnthropicApiModelInfo[],
  params: {
    fetchedAt?: string
    staleAt?: string
    status?: RuntimeProviderModelCatalogStatus
    message?: string | null
    code?: string | null
  } = {},
): RuntimeProviderModelCatalog {
  const fetchedAt = params.fetchedAt ?? new Date().toISOString()
  const staleAt =
    params.staleAt ??
    new Date(Date.now() + ANTHROPIC_SUCCESS_CACHE_TTL_MS).toISOString()
  const catalogModels = dedupeCatalogModels(
    models.flatMap((model, index) => {
      const id = model.id?.trim()
      if (!id || !isModelAllowed(id)) {
        return []
      }
      const displayName = model.display_name?.trim() || id
      return [
        {
          id,
          launchModel: id,
          displayName,
          hidden: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          supportsFastMode: false,
          inputModalities: parseAnthropicInputModalities(model),
          supportsPersonality: false,
          isDefault: index === 0,
          upgrade: false,
          source: 'anthropic-compatible-api',
          badgeLabel: 'From gateway',
          statusMessage: null,
          metadata: {
            context:
              typeof model.max_input_tokens === 'number'
                ? model.max_input_tokens
                : null,
          },
        } satisfies RuntimeProviderModelCatalogItem,
      ]
    }),
  )
  const defaultModel = catalogModels[0] ?? null

  return {
    schemaVersion: 1,
    providerId: 'anthropic',
    source: 'anthropic-compatible-api',
    status: params.status ?? 'ready',
    fetchedAt,
    staleAt,
    defaultModelId: defaultModel?.id ?? null,
    defaultLaunchModel: defaultModel?.launchModel ?? null,
    models: catalogModels,
    diagnostics: buildAnthropicCatalogDiagnostics({
      status: params.status ?? 'ready',
      message: params.message ?? null,
      code: params.code ?? null,
    }),
  }
}

export function resetAnthropicRuntimeCatalogCache(): void {
  cachedAnthropicCatalog = null
  inFlightAnthropicCatalogPromise = null
  inFlightAnthropicCatalogCacheKey = null
}

export async function getAnthropicRuntimeModelCatalog(): Promise<RuntimeProviderModelCatalog> {
  const cacheKey = getAnthropicCatalogCacheKey()
  if (
    cachedAnthropicCatalog &&
    cachedAnthropicCatalog.cacheKey === cacheKey &&
    cachedAnthropicCatalog.expiresAt > Date.now()
  ) {
    return cachedAnthropicCatalog.catalog
  }

  if (
    inFlightAnthropicCatalogPromise &&
    inFlightAnthropicCatalogCacheKey === cacheKey
  ) {
    return inFlightAnthropicCatalogPromise
  }

  const catalogPromise = (async () => {
    const fetchedAt = new Date().toISOString()
    const liveStaleAt = new Date(
      Date.now() + ANTHROPIC_SUCCESS_CACHE_TTL_MS,
    ).toISOString()
    const fallbackStaleAt = new Date(
      Date.now() + ANTHROPIC_FALLBACK_CACHE_TTL_MS,
    ).toISOString()
    const apiProvider = getAPIProvider()
    if (isAnthropicCompatibleRuntimeBaseUrl()) {
      try {
        const listedModels = await fetchAnthropicModelList()
        return cacheAnthropicCatalog(
          buildAnthropicCompatibleRuntimeModelCatalogFromApiModels(
            listedModels,
            {
              fetchedAt,
              staleAt: liveStaleAt,
            },
          ),
          cacheKey,
          ANTHROPIC_SUCCESS_CACHE_TTL_MS,
        )
      } catch (error) {
        return cacheAnthropicCatalog(
          buildAnthropicCompatibleRuntimeModelCatalogFromApiModels([], {
            fetchedAt,
            staleAt: fallbackStaleAt,
            status: 'degraded',
            message:
              `Anthropic-compatible model discovery unavailable. ${getErrorMessage(error)}`.trim(),
            code:
              getErrorCode(error) ?? 'anthropic-compatible-models-api-error',
          }),
          cacheKey,
          ANTHROPIC_FALLBACK_CACHE_TTL_MS,
        )
      }
    }

    if (apiProvider !== 'firstParty') {
      return cacheAnthropicCatalog(
        createStaticAnthropicRuntimeModelCatalog({
          fetchedAt,
          staleAt: fallbackStaleAt,
          status: 'stale',
          message: `Using the static Anthropic catalog because model listing is not available through the ${apiProvider} runtime backend.`,
          code: 'anthropic-external-backend-catalog',
        }),
        cacheKey,
        ANTHROPIC_FALLBACK_CACHE_TTL_MS,
      )
    }

    let auth: ReturnType<typeof getAuthHeaders>
    try {
      auth = getAuthHeaders()
    } catch (error) {
      return cacheAnthropicCatalog(
        createStaticAnthropicRuntimeModelCatalog({
          fetchedAt,
          staleAt: fallbackStaleAt,
          status: 'stale',
          message:
            `Using the static Anthropic catalog because no authenticated Anthropic API session is available. ${getErrorMessage(error)}`.trim(),
          code: 'anthropic-auth-missing',
        }),
        cacheKey,
        ANTHROPIC_FALLBACK_CACHE_TTL_MS,
      )
    }

    if (auth.error) {
      return cacheAnthropicCatalog(
        createStaticAnthropicRuntimeModelCatalog({
          fetchedAt,
          staleAt: fallbackStaleAt,
          status: 'stale',
          message:
            'Using the static Anthropic catalog because no authenticated Anthropic API session is available.',
          code: 'anthropic-auth-missing',
        }),
        cacheKey,
        ANTHROPIC_FALLBACK_CACHE_TTL_MS,
      )
    }

    try {
      const listedModels = await fetchAnthropicModelList()
      const liveModelsById = await enrichAnthropicCuratedModels(
        createLiveModelIndex(listedModels),
      )
      const catalog = buildAnthropicCatalogFromDefinitions({
        fetchedAt,
        staleAt: liveStaleAt,
        liveModelsById,
        liveSourceEnabled: true,
        status: 'ready',
      })
      return cacheAnthropicCatalog(
        catalog,
        cacheKey,
        ANTHROPIC_SUCCESS_CACHE_TTL_MS,
      )
    } catch (error) {
      return cacheAnthropicCatalog(
        createStaticAnthropicRuntimeModelCatalog({
          fetchedAt,
          staleAt: fallbackStaleAt,
          status: 'degraded',
          message:
            `Anthropic Models API unavailable. Using static fallback. ${getErrorMessage(error)}`.trim(),
          code: getErrorCode(error) ?? 'anthropic-models-api-error',
        }),
        cacheKey,
        ANTHROPIC_FALLBACK_CACHE_TTL_MS,
      )
    }
  })()
  inFlightAnthropicCatalogPromise = catalogPromise
  inFlightAnthropicCatalogCacheKey = cacheKey

  try {
    return await catalogPromise
  } finally {
    if (inFlightAnthropicCatalogPromise === catalogPromise) {
      inFlightAnthropicCatalogPromise = null
      inFlightAnthropicCatalogCacheKey = null
    }
  }
}
