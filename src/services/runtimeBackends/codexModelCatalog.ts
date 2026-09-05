import readline from 'node:readline'
import type { ChildProcess, SpawnOptions } from 'node:child_process'

import { CODEX_MODELS, DEFAULT_CODEX_MODEL } from '../../utils/model/codex.js'
import { spawnPortableCli } from '../../utils/portableCli.js'
import { resolveCodexCliBinary } from './codexBackendResolver.js'
import type {
  RuntimeProviderModelCatalog,
  RuntimeProviderModelCatalogItem,
  RuntimeReasoningEffort,
} from './types.js'

const MODEL_LIST_PAGE_LIMIT = 100
const MODEL_LIST_MAX_PAGES = 5
const MODEL_LIST_REQUEST_TIMEOUT_MS = 4_500
const MODEL_LIST_INITIALIZE_TIMEOUT_MS = 6_000
const MODEL_LIST_TOTAL_TIMEOUT_MS = 9_000
const MODEL_CATALOG_TTL_MS = 10 * 60_000

const DEFAULT_CODEX_EFFORTS: RuntimeReasoningEffort[] = ['low', 'medium', 'high', 'xhigh']
const MINI_CODEX_EFFORTS: RuntimeReasoningEffort[] = ['medium', 'high']

type JsonRpcErrorPayload = {
  code?: number
  message?: string
  data?: unknown
}

type JsonRpcResponse<T> = {
  id?: number
  result?: T
  error?: JsonRpcErrorPayload
}

type CodexAppServerModel = {
  id?: string
  model?: string
  displayName?: string
  hidden?: boolean
  supportedReasoningEfforts?: unknown[]
  defaultReasoningEffort?: unknown
  additionalSpeedTiers?: unknown
  serviceTiers?: unknown
  supportedServiceTiers?: unknown
  supportsFastMode?: unknown
  inputModalities?: unknown
  supportsPersonality?: boolean
  isDefault?: boolean
  upgrade?: unknown
  availabilityNux?: {
    message?: unknown
  } | null
}

type CodexAppServerListModelsResponse = {
  data?: CodexAppServerModel[]
  models?: CodexAppServerModel[]
  nextCursor?: string | null
  truncated?: boolean
}

type SpawnCodexAppServer = (
  binaryPath: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess

type CachedCodexModelCatalog = {
  cacheKey: string
  catalog: RuntimeProviderModelCatalog
  expiresAtMs: number
}

let cachedCodexModelCatalog: CachedCodexModelCatalog | null = null
let inFlightCodexModelCatalog: {
  cacheKey: string
  promise: Promise<RuntimeProviderModelCatalog>
} | null = null

class JsonRpcRequestError extends Error {
  readonly code: number | null
  readonly method: string

  constructor(method: string, payload: JsonRpcErrorPayload) {
    super(payload.message ?? 'Unknown JSON-RPC error')
    this.name = 'JsonRpcRequestError'
    this.method = method
    this.code = typeof payload.code === 'number' ? payload.code : null
  }
}

function nowIso(now: () => Date): string {
  return now().toISOString()
}

function staleAtIso(now: () => Date): string {
  return new Date(now().getTime() + MODEL_CATALOG_TTL_MS).toISOString()
}

function getCatalogCacheKey(
  env: NodeJS.ProcessEnv,
  binary: ReturnType<typeof resolveCodexCliBinary>,
): string {
  return [
    binary?.executableSource ?? 'missing',
    binary?.executablePath ?? '',
    env.CODEX_HOME?.trim() ?? '',
    env.HOME?.trim() ?? '',
    env.USERPROFILE?.trim() ?? '',
  ].join('\0')
}

function createFallbackModel(options: {
  id: string
  label: string
  isDefault?: boolean
  efforts?: RuntimeReasoningEffort[]
}): RuntimeProviderModelCatalogItem {
  return {
    id: options.id,
    launchModel: options.id,
    displayName: options.label,
    hidden: false,
    supportedReasoningEfforts: [...(options.efforts ?? DEFAULT_CODEX_EFFORTS)],
    defaultReasoningEffort: 'medium',
    supportsFastMode: options.id === 'gpt-5.4',
    inputModalities: ['text', 'image'],
    supportsPersonality: false,
    isDefault: options.isDefault === true,
    upgrade: false,
    source: 'static-fallback',
    badgeLabel: options.id.replace(/^gpt-/, ''),
    statusMessage: null,
  }
}

export function createStaticCodexModelCatalog(options: {
  status?: RuntimeProviderModelCatalog['status']
  message?: string | null
  appServerState?: RuntimeProviderModelCatalog['diagnostics']['appServerState']
  code?: string | null
  now?: () => Date
} = {}): RuntimeProviderModelCatalog {
  const now = options.now ?? (() => new Date())
  const models = CODEX_MODELS.map(model =>
    createFallbackModel({
      id: model.id,
      label: model.label,
      isDefault: model.id === DEFAULT_CODEX_MODEL,
      efforts: model.id.includes('mini') ? MINI_CODEX_EFFORTS : DEFAULT_CODEX_EFFORTS,
    }),
  )
  const defaultModel =
    models.find(model => model.id === DEFAULT_CODEX_MODEL) ??
    models.find(model => model.isDefault) ??
    models[0] ??
    null

  return {
    schemaVersion: 1,
    providerId: 'codex',
    source: 'static-fallback',
    status: options.status ?? 'degraded',
    fetchedAt: nowIso(now),
    staleAt: staleAtIso(now),
    defaultModelId: defaultModel?.id ?? null,
    defaultLaunchModel: defaultModel?.launchModel ?? null,
    models,
    diagnostics: {
      configReadState: 'skipped',
      appServerState: options.appServerState ?? 'degraded',
      message: options.message ?? null,
      code: options.code ?? null,
    },
  }
}

function normalizeReasoningEffort(value: unknown): RuntimeReasoningEffort | null {
  const raw =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && 'reasoningEffort' in value
        ? String((value as { reasoningEffort?: unknown }).reasoningEffort ?? '')
        : ''
  const normalized = raw.trim().toLowerCase().replace(/[-_\s]+/g, '')
  if (normalized === 'xhigh' || normalized === 'extrahigh') return 'xhigh'
  if (normalized === 'minimal') return 'minimal'
  if (normalized === 'low') return 'low'
  if (normalized === 'medium') return 'medium'
  if (normalized === 'high') return 'high'
  if (normalized === 'max') return 'max'
  if (normalized === 'none') return 'none'
  return null
}

function normalizeEfforts(model: CodexAppServerModel): RuntimeReasoningEffort[] {
  const values = model.supportedReasoningEfforts?.flatMap(value => {
    const effort = normalizeReasoningEffort(value)
    return effort ? [effort] : []
  })
  return values && values.length > 0 ? Array.from(new Set(values)) : ['low', 'medium', 'high']
}

function normalizeDefaultEffort(
  value: unknown,
  supported: RuntimeReasoningEffort[],
): RuntimeReasoningEffort | null {
  const normalized = normalizeReasoningEffort(value)
  if (normalized && supported.includes(normalized)) return normalized
  return supported.includes('medium') ? 'medium' : (supported[0] ?? null)
}

function normalizeModalities(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return ['text', 'image']
  }
  const seen = new Set<string>()
  const modalities: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const normalized = item.trim().toLowerCase()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    modalities.push(normalized)
  }
  return modalities.length > 0 ? modalities : ['text', 'image']
}

function normalizeSpeedTier(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim().toLowerCase() || null
  }
  if (!value || typeof value !== 'object') {
    return null
  }
  const candidate = value as {
    id?: unknown
    name?: unknown
    serviceTier?: unknown
    service_tier?: unknown
    speedTier?: unknown
    speed_tier?: unknown
    tier?: unknown
  }
  return (
    normalizeSpeedTier(candidate.serviceTier) ??
    normalizeSpeedTier(candidate.service_tier) ??
    normalizeSpeedTier(candidate.speedTier) ??
    normalizeSpeedTier(candidate.speed_tier) ??
    normalizeSpeedTier(candidate.tier) ??
    normalizeSpeedTier(candidate.id) ??
    normalizeSpeedTier(candidate.name)
  )
}

function hasFastSpeedTier(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(item => normalizeSpeedTier(item) === 'fast')
  }
  return normalizeSpeedTier(value) === 'fast'
}

function normalizeSupportsFastMode(model: CodexAppServerModel): boolean {
  return (
    model.supportsFastMode === true ||
    hasFastSpeedTier(model.additionalSpeedTiers) ||
    hasFastSpeedTier(model.serviceTiers) ||
    hasFastSpeedTier(model.supportedServiceTiers)
  )
}

function normalizeCodexAppServerModels(models: readonly CodexAppServerModel[] | undefined): {
  models: RuntimeProviderModelCatalogItem[]
  diagnostics: string[]
} {
  const diagnostics: string[] = []
  const seenIds = new Set<string>()
  const seenLaunchModels = new Set<string>()
  const normalizedModels: RuntimeProviderModelCatalogItem[] = []

  for (const model of models ?? []) {
    const id = model.id?.trim() || model.model?.trim() || null
    if (!id) {
      diagnostics.push('model/list returned a model without id/model.')
      continue
    }
    if (seenIds.has(id)) {
      diagnostics.push(`model/list returned duplicate model id ${id}.`)
      continue
    }
    seenIds.add(id)

    const hidden = model.hidden === true
    const launchModel = model.model?.trim() || id
    if (seenLaunchModels.has(launchModel)) {
      diagnostics.push(`model/list returned duplicate launch model ${launchModel}.`)
      continue
    }
    seenLaunchModels.add(launchModel)

    const supportedReasoningEfforts = normalizeEfforts(model)
    const rawAvailabilityNuxMessage = model.availabilityNux?.message
    const availabilityNuxMessage =
      typeof rawAvailabilityNuxMessage === 'string'
        ? rawAvailabilityNuxMessage.trim() || null
        : null
    normalizedModels.push({
      id,
      launchModel,
      displayName: model.displayName?.trim() || id,
      hidden,
      supportedReasoningEfforts,
      defaultReasoningEffort: normalizeDefaultEffort(
        model.defaultReasoningEffort,
        supportedReasoningEfforts,
      ),
      supportsFastMode: normalizeSupportsFastMode(model),
      inputModalities: normalizeModalities(model.inputModalities),
      supportsPersonality: model.supportsPersonality === true,
      isDefault: model.isDefault === true,
      upgrade: Boolean(model.upgrade),
      source: 'app-server',
      badgeLabel: id.replace(/^gpt-/, ''),
      statusMessage: availabilityNuxMessage,
      metadata: availabilityNuxMessage ? { recentlyReleased: true } : null,
    })
  }

  return { models: normalizedModels, diagnostics }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId)
  }) as Promise<T>
}

async function readCodexAppServerModels(options: {
  binaryPath: string
  env: NodeJS.ProcessEnv
  spawnCli: SpawnCodexAppServer
  requestTimeoutMs: number
  initializeTimeoutMs: number
}): Promise<CodexAppServerListModelsResponse> {
  const child = options.spawnCli(options.binaryPath, ['app-server'], {
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  if (!child.stdin || !child.stdout) {
    throw new Error('Codex app-server stdio is unavailable.')
  }

  const lineReader = readline.createInterface({ input: child.stdout })
  child.stderr?.on('data', () => {
    // Drain stderr so warnings never block JSON-RPC stdout.
  })

  let nextRequestId = 1
  const pending = new Map<
    number,
    {
      method: string
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timeoutId: ReturnType<typeof setTimeout>
    }
  >()

  const rejectAll = (error: Error) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timeoutId)
      entry.reject(error)
      pending.delete(id)
    }
  }

  lineReader.on('line', line => {
    let message: JsonRpcResponse<unknown>
    try {
      message = JSON.parse(line) as JsonRpcResponse<unknown>
    } catch {
      return
    }
    if (typeof message.id !== 'number') {
      return
    }
    const entry = pending.get(message.id)
    if (!entry) {
      return
    }
    clearTimeout(entry.timeoutId)
    pending.delete(message.id)
    if (message.error) {
      entry.reject(new JsonRpcRequestError(entry.method, message.error))
      return
    }
    entry.resolve(message.result)
  })

  child.once('error', error => {
    rejectAll(error instanceof Error ? error : new Error(String(error)))
  })
  child.once('exit', (code, signal) => {
    if (pending.size > 0) {
      rejectAll(
        new Error(
          `Codex app-server exited unexpectedly (code=${code ?? 'null'} signal=${signal ?? 'null'})`,
        ),
      )
    }
  })

  const request = <T>(
    method: string,
    params?: unknown,
    timeoutMs = options.requestTimeoutMs,
  ): Promise<T> => {
    const id = nextRequestId++
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(
        () => {
          pending.delete(id)
          reject(new Error(`JSON-RPC request timed out: ${method}`))
        },
        timeoutMs,
      )
      pending.set(id, {
        method,
        resolve: value => resolve(value as T),
        reject,
        timeoutId,
      })
      child.stdin!.write(payload)
    })
  }

  const notify = (method: string, params?: unknown): void => {
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  try {
    await request(
      'initialize',
      {
        clientInfo: {
          name: 'agent-teams-orchestrator',
          title: 'Agent Teams Orchestrator',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: false,
          optOutNotificationMethods: [],
        },
      },
      options.initializeTimeoutMs,
    )
    notify('initialized')

    const data: CodexAppServerModel[] = []
    let cursor: string | null = null
    let nextCursor: string | null = null
    for (let page = 0; page < MODEL_LIST_MAX_PAGES; page += 1) {
      const payload = await request<CodexAppServerListModelsResponse>('model/list', {
        cursor,
        limit: MODEL_LIST_PAGE_LIMIT,
        includeHidden: false,
      })
      data.push(...(payload.data ?? payload.models ?? []))
      nextCursor = payload.nextCursor ?? null
      if (!nextCursor) break
      cursor = nextCursor
    }
    return {
      data,
      nextCursor,
      truncated: nextCursor !== null,
    }
  } finally {
    lineReader.close()
    child.stdin.end()
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
      }
    }, 250).unref()
  }
}

function classifyCatalogFailure(error: unknown): {
  appServerState: RuntimeProviderModelCatalog['diagnostics']['appServerState']
  message: string
  code: string | null
} {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  const code = error instanceof JsonRpcRequestError && error.code !== null ? String(error.code) : null
  if (
    code === '-32601' ||
    lower.includes('method not found') ||
    lower.includes('unknown method') ||
    lower.includes('unknown command') ||
    lower.includes('no such command')
  ) {
    return {
      appServerState: 'incompatible',
      message: 'The installed Codex binary does not support app-server model/list yet.',
      code: code ?? 'method-not-found',
    }
  }
  return {
    appServerState: 'degraded',
    message,
    code,
  }
}

function createStaleCodexModelCatalog(options: {
  cached: RuntimeProviderModelCatalog
  failure: ReturnType<typeof classifyCatalogFailure>
  now: () => Date
}): RuntimeProviderModelCatalog {
  const message = options.failure.message
    ? `${options.failure.message} Showing the last successful Codex app-server model catalog.`
    : 'Showing the last successful Codex app-server model catalog.'

  return {
    ...options.cached,
    status: 'stale',
    staleAt: staleAtIso(options.now),
    diagnostics: {
      ...options.cached.diagnostics,
      appServerState: options.failure.appServerState,
      message,
      code: options.failure.code,
    },
  }
}

export function clearCodexRuntimeModelCatalogCacheForTesting(): void {
  cachedCodexModelCatalog = null
  inFlightCodexModelCatalog = null
}

export async function getCodexRuntimeModelCatalog(options: {
  env?: NodeJS.ProcessEnv
  which?: (command: string) => string | null | undefined
  spawnCli?: SpawnCodexAppServer
  now?: () => Date
  requestTimeoutMs?: number
  initializeTimeoutMs?: number
  totalTimeoutMs?: number
} = {}): Promise<RuntimeProviderModelCatalog> {
  const env = options.env ?? process.env
  const now = options.now ?? (() => new Date())
  const binary = resolveCodexCliBinary({ env, which: options.which })
  const cacheKey = getCatalogCacheKey(env, binary)
  const nowMs = now().getTime()
  const cacheEnabled = options.spawnCli === undefined

  if (
    cacheEnabled &&
    cachedCodexModelCatalog &&
    cachedCodexModelCatalog.cacheKey === cacheKey &&
    cachedCodexModelCatalog.expiresAtMs > nowMs
  ) {
    return cachedCodexModelCatalog.catalog
  }

  if (!binary) {
    return createStaticCodexModelCatalog({
      status: 'unavailable',
      appServerState: 'runtime-missing',
      message: 'Codex CLI was not found. Showing static fallback model list.',
      now,
    })
  }

  const loadCatalog = async (): Promise<RuntimeProviderModelCatalog> => {
    const payload = await withTimeout(
      readCodexAppServerModels({
        binaryPath: binary.executablePath,
        env,
        spawnCli: options.spawnCli ?? spawnPortableCli,
        requestTimeoutMs: options.requestTimeoutMs ?? MODEL_LIST_REQUEST_TIMEOUT_MS,
        initializeTimeoutMs: options.initializeTimeoutMs ?? MODEL_LIST_INITIALIZE_TIMEOUT_MS,
      }),
      options.totalTimeoutMs ?? MODEL_LIST_TOTAL_TIMEOUT_MS,
      'codex app-server model/list',
    )
    const normalized = normalizeCodexAppServerModels(payload.data ?? payload.models)
    if (normalized.models.length === 0) {
      throw new Error('Codex app-server model/list returned no visible models.')
    }
    const defaultModel =
      normalized.models.find(model => model.isDefault) ??
      normalized.models.find(model => model.id === DEFAULT_CODEX_MODEL) ??
      normalized.models.find(model => !model.hidden) ??
      normalized.models[0] ??
      null
    const diagnostics = [
      ...normalized.diagnostics,
      payload.truncated
        ? 'model/list pagination reached the safety page limit; some Codex models may be omitted.'
        : null,
    ].filter((item): item is string => Boolean(item))

    return {
      schemaVersion: 1,
      providerId: 'codex',
      source: 'app-server',
      status: 'ready',
      fetchedAt: nowIso(now),
      staleAt: staleAtIso(now),
      defaultModelId: defaultModel?.id ?? null,
      defaultLaunchModel: defaultModel?.launchModel ?? null,
      models: normalized.models,
      diagnostics: {
        configReadState: 'skipped',
        appServerState: 'healthy',
        message: diagnostics.length > 0 ? diagnostics.join(' ') : null,
        code: null,
      },
    }
  }

  try {
    let catalog: RuntimeProviderModelCatalog
    if (!cacheEnabled) {
      catalog = await loadCatalog()
    } else {
      if (!inFlightCodexModelCatalog || inFlightCodexModelCatalog.cacheKey !== cacheKey) {
        const promise = loadCatalog().finally(() => {
          if (inFlightCodexModelCatalog?.cacheKey === cacheKey) {
            inFlightCodexModelCatalog = null
          }
        })
        inFlightCodexModelCatalog = { cacheKey, promise }
      }
      catalog = await inFlightCodexModelCatalog.promise
    }

    if (cacheEnabled) {
      cachedCodexModelCatalog = {
        cacheKey,
        catalog,
        expiresAtMs: nowMs + MODEL_CATALOG_TTL_MS,
      }
    }
    return catalog
  } catch (error) {
    const failure = classifyCatalogFailure(error)
    if (
      cachedCodexModelCatalog &&
      cachedCodexModelCatalog.cacheKey === cacheKey &&
      cachedCodexModelCatalog.catalog.source === 'app-server'
    ) {
      return createStaleCodexModelCatalog({
        cached: cachedCodexModelCatalog.catalog,
        failure,
        now,
      })
    }
    return createStaticCodexModelCatalog({
      message: failure.message,
      appServerState: failure.appServerState,
      code: failure.code,
      now,
    })
  }
}

export function getVisibleCodexRuntimeModels(catalog: RuntimeProviderModelCatalog): string[] {
  return catalog.models
    .filter(model => !model.hidden)
    .map(model => model.launchModel.trim())
    .filter(Boolean)
}
