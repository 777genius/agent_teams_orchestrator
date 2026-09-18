import {
  formatOpenCodeModelRef,
  normalizeOpenCodeProviderId,
  parseOpenCodeProviderScopedModelRef,
} from './OpenCodeModelRef.js'
import { isOpenCodeBuiltinFreeModelId } from './OpenCodeInventoryService.js'
import {
  isLiteralLoopbackOpenCodeUrl,
  isLocalInexactOpenCodeLaunchProviderId,
} from './OpenCodeProviderIdentity.js'

import type {
  OpenCodeConfigProvidersResponse,
  OpenCodeExecutionProbeResult,
  OpenCodeInventorySnapshot,
  OpenCodeProviderListEntry,
  OpenCodeProviderResponse,
  OpenCodeProvisioningSnapshot,
} from './types.js'

export type OpenCodeModelAccessCatalog = {
  connectedProviders: readonly string[]
  models: readonly string[]
  modelMetadata?: OpenCodeProvisioningSnapshot['modelMetadata']
  configProviders?: OpenCodeConfigProvidersResponse | null
  providers?: OpenCodeProviderResponse | null
}

export type OpenCodeModelAccessKind =
  | 'no_model'
  | 'unknown_model'
  | 'credentialed'
  | 'builtin_free'
  | 'configured_authless'
  | 'verified'
  | 'not_authenticated'
  | 'execution_failed'

export type OpenCodeModelAccessEvaluation = {
  kind: OpenCodeModelAccessKind
  providerId: string | null
  modelId: string | null
  launchAllowed: boolean
  requiresExecutionProof: boolean
  reason: string | null
}

export type OpenCodeModelRouteKind =
  | 'connected_provider'
  | 'builtin_free'
  | 'configured_local'
  | 'catalog_provider'

export type OpenCodeModelProofState =
  | 'not_required'
  | 'needs_probe'
  | 'verified'
  | 'failed'

export type OpenCodeModelRouteMetadata = {
  providerId: string | null
  modelId: string | null
  sourceLabel: string | null
  accessKind: OpenCodeModelAccessKind
  routeKind: OpenCodeModelRouteKind
  proofState: OpenCodeModelProofState
  requiresExecutionProof: boolean
  reason: string | null
}

const KNOWN_AUTHLESS_OPEN_CODE_PROVIDER_IDS = new Set([
  'atomic-chat',
  // These managed plugins authenticate through their provider-owned local CLI
  // sessions. They do not put a credential in OpenCode's auth store, so every
  // route still requires a successful execution proof before launch.
  'cursor-acp',
  'kiro',
  'llama.cpp',
  'llamacpp',
  'lmstudio',
  'lm-studio',
  'local',
  'ollama',
  'vllm',
])

export function isKnownAuthlessOpenCodeProviderId(providerId: string | null | undefined): boolean {
  const normalized = normalizeOpenCodeProviderId(providerId)
  return normalized ? KNOWN_AUTHLESS_OPEN_CODE_PROVIDER_IDS.has(normalized) : false
}

const OPEN_CODE_CLOUD_MODEL_TAG = /:cloud\b/i

export function requiresExactOpenCodeLaunchOutput(
  selectedModel: string,
  catalog?: OpenCodeModelAccessCatalog | null,
): boolean {
  const parsed = parseOpenCodeProviderScopedModelRef(selectedModel)
  if (!parsed) return true
  if (OPEN_CODE_CLOUD_MODEL_TAG.test(parsed.modelId)) return true
  if (!isLocalInexactOpenCodeLaunchProviderId(parsed.providerId)) return true
  const entries = catalog ? findProviderEntries(catalog, parsed.providerId) : []
  if (entries.length > 0) {
    return !entries.some(entry => isLiteralLoopbackOpenCodeUrl(getProviderEntryBaseUrl(entry)))
  }
  // vLLM is often a remote OpenAI-compatible server. Without a loopback URL,
  // keep the STRICT nonce instead of accepting PONG from an untrusted host.
  return parsed.providerId === 'vllm'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeProviderIdSet(providerIds: readonly string[]): Set<string> {
  return new Set(
    providerIds
      .map(providerId => normalizeOpenCodeProviderId(providerId))
      .filter((providerId): providerId is string => Boolean(providerId)),
  )
}

function getProviderEntryId(entry: OpenCodeProviderListEntry): string | null {
  return normalizeOpenCodeProviderId(asString(entry.id))
}

function getProviderEntryModels(entry: OpenCodeProviderListEntry): Record<string, unknown> | null {
  return asRecord(entry.models)
}

function getProviderEntryBaseUrl(entry: OpenCodeProviderListEntry): string | null {
  const record = asRecord(entry)
  const options = asRecord(record?.options)
  return asString(options?.baseURL) ?? asString(options?.baseUrl)
}

function isOpenAiCompatibleProviderEntry(entry: OpenCodeProviderListEntry): boolean {
  const record = asRecord(entry)
  return asString(record?.npm) === '@ai-sdk/openai-compatible'
}

function isAuthlessCapableProviderEntry(entry: OpenCodeProviderListEntry): boolean {
  const providerId = getProviderEntryId(entry)
  if (providerId && KNOWN_AUTHLESS_OPEN_CODE_PROVIDER_IDS.has(providerId)) {
    return true
  }
  return isOpenAiCompatibleProviderEntry(entry)
    && isLiteralLoopbackOpenCodeUrl(getProviderEntryBaseUrl(entry))
}

function findProviderEntries(
  catalog: OpenCodeModelAccessCatalog,
  providerId: string,
): OpenCodeProviderListEntry[] {
  return [
    ...(catalog.configProviders?.providers ?? []),
    ...(catalog.providers?.all ?? []),
  ].filter(entry => getProviderEntryId(entry) === providerId)
}

function hasModelInProviderEntries(
  entries: readonly OpenCodeProviderListEntry[],
  modelId: string,
): boolean {
  return entries.some(entry => {
    const models = getProviderEntryModels(entry)
    return models ? Object.prototype.hasOwnProperty.call(models, modelId) : false
  })
}

function hasKnownOpenCodeModel(
  catalog: OpenCodeModelAccessCatalog,
  providerId: string,
  modelId: string,
): boolean {
  const scopedModel = formatOpenCodeModelRef(providerId, modelId)
  if (
    catalog.models.some(model => parseOpenCodeProviderScopedModelRef(model)?.raw === scopedModel)
  ) {
    return true
  }
  return hasModelInProviderEntries(findProviderEntries(catalog, providerId), modelId)
}

function isAuthlessCapableKnownModel(
  catalog: OpenCodeModelAccessCatalog,
  providerId: string,
  modelId: string,
): boolean {
  const entries = findProviderEntries(catalog, providerId)
  if (
    entries.some(entry =>
      isAuthlessCapableProviderEntry(entry) && hasModelInProviderEntries([entry], modelId)
    )
  ) {
    return true
  }
  return KNOWN_AUTHLESS_OPEN_CODE_PROVIDER_IDS.has(providerId)
    && catalog.models.some(model =>
      parseOpenCodeProviderScopedModelRef(model)?.raw === formatOpenCodeModelRef(providerId, modelId)
    )
}

export function isOpenCodeAuthlessCapableKnownModel(
  catalog: OpenCodeModelAccessCatalog,
  providerId: string,
  modelId: string,
): boolean {
  return isAuthlessCapableKnownModel(catalog, providerId, modelId)
}

function executionFailureKind(
  outcome: OpenCodeExecutionProbeResult['outcome'] | undefined,
): OpenCodeModelAccessKind {
  return outcome === 'not_authenticated' ? 'not_authenticated' : 'execution_failed'
}

export function evaluateOpenCodeModelAccess(input: {
  selectedModel: string | null | undefined
  catalog: OpenCodeModelAccessCatalog
  executionOutcome?: Pick<OpenCodeExecutionProbeResult, 'outcome' | 'reason'> | null
}): OpenCodeModelAccessEvaluation {
  const selected = input.selectedModel?.trim() ?? ''
  if (!selected) {
    return {
      kind: 'no_model',
      providerId: null,
      modelId: null,
      launchAllowed: false,
      requiresExecutionProof: false,
      reason: 'No OpenCode model is available',
    }
  }

  const parsed = parseOpenCodeProviderScopedModelRef(selected)
  if (!parsed) {
    return {
      kind: 'unknown_model',
      providerId: null,
      modelId: null,
      launchAllowed: false,
      requiresExecutionProof: false,
      reason: `OpenCode model must be provider-scoped, received "${selected}"`,
    }
  }

  const executionOutcome = input.executionOutcome ?? null
  if (executionOutcome?.outcome === 'available') {
    return {
      kind: 'verified',
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      launchAllowed: true,
      requiresExecutionProof: false,
      reason: null,
    }
  }

  const modelKnown = hasKnownOpenCodeModel(input.catalog, parsed.providerId, parsed.modelId)
  if (!modelKnown) {
    return {
      kind: 'unknown_model',
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      launchAllowed: false,
      requiresExecutionProof: false,
      reason: `OpenCode provider-scoped model "${parsed.raw}" was not found in the live provider catalog`,
    }
  }

  if (executionOutcome && executionOutcome.outcome !== 'available') {
    return {
      kind: executionFailureKind(executionOutcome.outcome),
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      launchAllowed: false,
      requiresExecutionProof: false,
      reason: executionOutcome.reason ?? 'OpenCode selected model execution is unavailable',
    }
  }

  if (isAuthlessCapableKnownModel(input.catalog, parsed.providerId, parsed.modelId)) {
    return {
      kind: 'configured_authless',
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      launchAllowed: false,
      requiresExecutionProof: true,
      reason: `OpenCode provider "${parsed.providerId}" for selected model "${parsed.raw}" requires execution verification before launch`,
    }
  }

  if (normalizeProviderIdSet(input.catalog.connectedProviders).has(parsed.providerId)) {
    return {
      kind: 'credentialed',
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      launchAllowed: true,
      requiresExecutionProof: false,
      reason: null,
    }
  }

  if (isOpenCodeBuiltinFreeModelId(parsed.raw, input.catalog.modelMetadata)) {
    return {
      kind: 'builtin_free',
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      launchAllowed: true,
      requiresExecutionProof: false,
      reason: null,
    }
  }

  return {
    kind: 'not_authenticated',
    providerId: parsed.providerId,
    modelId: parsed.modelId,
    launchAllowed: false,
    requiresExecutionProof: false,
    reason: `OpenCode provider "${parsed.providerId}" for selected model "${parsed.raw}" is not connected`,
  }
}

function getOpenCodeModelRouteKind(input: {
  catalog: OpenCodeModelAccessCatalog
  selectedModel: string
  providerId: string | null
  modelId: string | null
  accessKind: OpenCodeModelAccessKind
}): OpenCodeModelRouteKind {
  if (
    input.accessKind === 'builtin_free'
    || isOpenCodeBuiltinFreeModelId(input.selectedModel, input.catalog.modelMetadata)
  ) {
    return 'builtin_free'
  }

  if (
    input.providerId
    && input.modelId
    && (
      input.accessKind === 'configured_authless'
      || isAuthlessCapableKnownModel(input.catalog, input.providerId, input.modelId)
    )
  ) {
    return 'configured_local'
  }

  if (
    input.accessKind === 'credentialed'
    || (
      input.providerId
      && normalizeProviderIdSet(input.catalog.connectedProviders).has(input.providerId)
    )
  ) {
    return 'connected_provider'
  }

  return 'catalog_provider'
}

function getOpenCodeModelProofState(input: {
  accessKind: OpenCodeModelAccessKind
  requiresExecutionProof: boolean
  executionOutcome?: Pick<OpenCodeExecutionProbeResult, 'outcome' | 'reason'> | null
}): OpenCodeModelProofState {
  if (input.accessKind === 'verified') {
    return 'verified'
  }
  if (input.requiresExecutionProof) {
    return 'needs_probe'
  }
  if (input.executionOutcome && input.executionOutcome.outcome !== 'available') {
    return 'failed'
  }
  return 'not_required'
}

export function buildOpenCodeModelRouteMetadata(input: {
  selectedModel: string | null | undefined
  catalog: OpenCodeModelAccessCatalog
  executionOutcome?: Pick<OpenCodeExecutionProbeResult, 'outcome' | 'reason'> | null
  sourceLabel?: string | null
}): OpenCodeModelRouteMetadata {
  const selectedModel = input.selectedModel?.trim() ?? ''
  const access = evaluateOpenCodeModelAccess({
    selectedModel,
    catalog: input.catalog,
    executionOutcome: input.executionOutcome ?? null,
  })
  return {
    providerId: access.providerId,
    modelId: access.modelId,
    sourceLabel: input.sourceLabel ?? access.providerId,
    accessKind: access.kind,
    routeKind: getOpenCodeModelRouteKind({
      catalog: input.catalog,
      selectedModel,
      providerId: access.providerId,
      modelId: access.modelId,
      accessKind: access.kind,
    }),
    proofState: getOpenCodeModelProofState({
      accessKind: access.kind,
      requiresExecutionProof: access.requiresExecutionProof,
      executionOutcome: input.executionOutcome ?? null,
    }),
    requiresExecutionProof: access.requiresExecutionProof,
    reason: access.reason,
  }
}

export function buildOpenCodeModelAccessCatalogFromProvisioningSnapshot(
  snapshot: OpenCodeProvisioningSnapshot,
): OpenCodeModelAccessCatalog {
  return {
    connectedProviders: snapshot.providers?.connected ?? [],
    models: snapshot.models ?? [],
    modelMetadata: snapshot.modelMetadata,
    configProviders: snapshot.configProviders,
    providers: snapshot.providers,
  }
}

export function buildOpenCodeModelAccessCatalogFromInventorySnapshot(
  snapshot: OpenCodeInventorySnapshot,
): OpenCodeModelAccessCatalog {
  return {
    connectedProviders: snapshot.connectedProviders.map(provider => provider.id),
    models: snapshot.models,
    modelMetadata: snapshot.modelMetadata,
    configProviders: null,
    providers: null,
  }
}

export function hasOpenCodeConfiguredAuthlessModel(
  catalog: OpenCodeModelAccessCatalog,
): boolean {
  for (const model of catalog.models) {
    const parsed = parseOpenCodeProviderScopedModelRef(model)
    if (!parsed || normalizeProviderIdSet(catalog.connectedProviders).has(parsed.providerId)) {
      continue
    }
    if (
      !isOpenCodeBuiltinFreeModelId(parsed.raw, catalog.modelMetadata)
      && isAuthlessCapableKnownModel(catalog, parsed.providerId, parsed.modelId)
    ) {
      return true
    }
  }

  for (const entry of [
    ...(catalog.configProviders?.providers ?? []),
    ...(catalog.providers?.all ?? []),
  ]) {
    const providerId = getProviderEntryId(entry)
    const models = getProviderEntryModels(entry)
    if (
      !providerId
      || !models
      || normalizeProviderIdSet(catalog.connectedProviders).has(providerId)
      || !isAuthlessCapableProviderEntry(entry)
    ) {
      continue
    }
    if (Object.keys(models).length > 0) {
      return true
    }
  }

  return false
}
