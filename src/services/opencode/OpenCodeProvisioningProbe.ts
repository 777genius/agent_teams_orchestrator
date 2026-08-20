import { openCodeClientFactory } from './OpenCodeClientFactory.js'
import {
  createOpenCodePreflightHostLeaseInput,
  openCodeHostManager,
} from './OpenCodeHostManager.js'
import {
  openCodeInventoryService,
  type OpenCodeInventoryProbeMode,
} from './OpenCodeInventoryService.js'
import { openCodeMcpManager } from './OpenCodeMcpManager.js'
import {
  canonicalizeOpenCodeProviderId,
  parseOpenCodeExactProviderModelRef,
} from './OpenCodeProviderIdentity.js'
import {
  OPEN_CODE_PASSIVE_STATUS_DEFAULT_TIMEOUT_MS,
  OpenCodePassiveStatusProductionReader,
} from './OpenCodePassiveStatusProductionReader.js'
import {
  mergeOpenCodeModelMetadata,
  normalizeOpenCodeLiveConfigProvidersResponse,
  normalizeOpenCodeLiveModelMetadata,
  normalizeOpenCodeLiveProviderAuth,
  normalizeOpenCodeLiveProviderResponse,
} from './OpenCodeLiveProviderNormalizer.js'
import {
  type OpenCodePhaseContext,
  throwOpenCodeAbortReason,
} from './OpenCodeRuntimeDeadline.js'

import type {
  OpenCodeAgentResponse,
  OpenCodeHostHandle,
  OpenCodeProvisioningSnapshot,
  OpenCodeToolApprovalMode,
} from './types.js'

type OpenCodeProvisioningProbeDeps = {
  inventoryService?: Pick<typeof openCodeInventoryService, 'probe'>
  hostManager?: Pick<
    typeof openCodeHostManager,
    'ensureHost' | 'releaseHost' | 'refreshResolvedConfigFingerprint'
  >
    & Partial<Pick<typeof openCodeHostManager, 'retainHostLease' | 'releaseHostLease'>>
  clientFactory?: Pick<typeof openCodeClientFactory, 'create'>
  mcpManager?: Pick<typeof openCodeMcpManager, 'ensureAppMcp'>
}

const OPEN_CODE_PROVISIONING_CACHE_TTL_MS = 10_000

type CacheEntry = {
  expiresAt: number
  snapshot: OpenCodeProvisioningSnapshot
}

type OpenCodeProvisioningProbeOptions = {
  disposeHostOnRelease?: boolean
  ensureAppMcp?: boolean
  bypassCache?: boolean
  toolApprovalMode?: OpenCodeToolApprovalMode
  phaseContext?: OpenCodePhaseContext
  inventoryMode?: OpenCodeInventoryProbeMode
}

type RetainedProvisioningProbe = {
  snapshot: OpenCodeProvisioningSnapshot
  release: () => Promise<void>
}

function cloneHost(handle: NonNullable<OpenCodeProvisioningSnapshot['host']>): NonNullable<OpenCodeProvisioningSnapshot['host']> {
  return {
    ...handle,
    profile: {
      ...handle.profile,
      behaviorSources: [...handle.profile.behaviorSources],
      managedConfig: JSON.parse(JSON.stringify(handle.profile.managedConfig)) as Record<string, unknown>,
      env: { ...handle.profile.env },
    },
    diagnostics: [...handle.diagnostics],
  }
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(values).filter(Boolean))).sort()
}

function hasPrimaryTeammateAgent(
  agents: OpenCodeAgentResponse[],
): boolean {
  return agents.some(agent => agent.name === 'teammate' && agent.mode === 'primary')
}

export class OpenCodeProvisioningProbe {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(private readonly deps: OpenCodeProvisioningProbeDeps = {}) {}

  async probe(
    projectPath?: string | null,
    options: OpenCodeProvisioningProbeOptions = {},
  ): Promise<OpenCodeProvisioningSnapshot> {
    const result = await this.probeWithHost(projectPath, {
      retainHost: false,
      useCache: options.bypassCache !== true,
      disposeHostOnRelease: options.disposeHostOnRelease,
      ensureAppMcp: options.ensureAppMcp !== false,
      toolApprovalMode: options.toolApprovalMode,
      phaseContext: options.phaseContext,
      inventoryMode: options.inventoryMode,
    })
    return result.snapshot
  }

  async probeRetainingHost(
    projectPath?: string | null,
    options: Pick<
      OpenCodeProvisioningProbeOptions,
      'toolApprovalMode' | 'phaseContext' | 'inventoryMode'
    > = {},
  ): Promise<RetainedProvisioningProbe> {
    return this.probeWithHost(projectPath, {
      retainHost: true,
      useCache: false,
      toolApprovalMode: options.toolApprovalMode,
      phaseContext: options.phaseContext,
      inventoryMode: options.inventoryMode,
    })
  }

  private async probeWithHost(
    projectPath: string | null | undefined,
    options: {
      retainHost: boolean
      useCache: boolean
      disposeHostOnRelease?: boolean
      ensureAppMcp?: boolean
      toolApprovalMode?: OpenCodeToolApprovalMode
      phaseContext?: OpenCodePhaseContext
      inventoryMode?: OpenCodeInventoryProbeMode
    },
  ): Promise<RetainedProvisioningProbe> {
    const inventoryService = this.deps.inventoryService ?? openCodeInventoryService
    const inventory = await inventoryService.probe(projectPath, {
      bypassCache: !options.useCache,
      includeAppMcp: options.ensureAppMcp !== false,
      toolApprovalMode: options.toolApprovalMode,
      abortSignal: options.phaseContext?.signal,
      mode: options.inventoryMode ?? 'full',
    })
    const cacheKey = [
      inventory.projectPath,
      inventory.profile?.projectBehaviorFingerprint ?? 'none',
      inventory.profile?.managedAuthFingerprint ?? 'none',
      inventory.profile?.managedConfigFingerprint ?? 'none',
      options.ensureAppMcp === false ? 'without-app-mcp' : 'with-app-mcp',
      options.toolApprovalMode ?? 'auto',
      options.inventoryMode ?? 'full',
    ].join('::')
    const cached = options.useCache ? this.cache.get(cacheKey) : undefined
    if (cached && cached.expiresAt > Date.now()) {
      return {
        snapshot: cached.snapshot,
        release: async () => {},
      }
    }

    if (!inventory.detected) {
      const snapshot: OpenCodeProvisioningSnapshot = {
        detected: false,
        hostHealthy: false,
        projectPath: inventory.projectPath,
        models: [...inventory.models],
        modelMetadata: [...(inventory.modelMetadata ?? [])],
        profile: inventory.profile,
        host: null,
        config: null,
        configProviders: null,
        providers: null,
        providerAuth: null,
        agents: [],
        mcp: null,
        appMcp: null,
        probeError: inventory.probeError,
        diagnostics: [...inventory.diagnostics],
      }
      this.cache.set(cacheKey, {
        expiresAt: Date.now() + OPEN_CODE_PROVISIONING_CACHE_TTL_MS,
        snapshot,
      })
      return {
        snapshot,
        release: async () => {},
      }
    }

    const hostManager = this.deps.hostManager ?? openCodeHostManager
    const clientFactory = this.deps.clientFactory ?? openCodeClientFactory
    const mcpManager = this.deps.mcpManager ?? openCodeMcpManager

    let host: OpenCodeHostHandle | undefined
    const preflightLease = createOpenCodePreflightHostLeaseInput('readiness')
    let released = false
    const release = async () => {
      if (released || !host) {
        return
      }
      released = true
      await hostManager.releaseHostLease?.(host.hostKey, preflightLease).catch(() => undefined)
      if (options.disposeHostOnRelease !== false) {
        await hostManager.releaseHost(host.hostKey)
      }
    }
    try {
      const ensurePromise = hostManager.ensureHost({
        projectPath: inventory.projectPath,
        preparedProfile: inventory.profile ?? undefined,
        ...(options.phaseContext
          ? { healthTimeoutMs: options.phaseContext.remainingMs() }
          : {}),
        ...(options.phaseContext ? { abortSignal: options.phaseContext.signal } : {}),
        hostLifetime: options.retainHost || options.disposeHostOnRelease === false
          ? 'persistent'
          : 'process',
        managedPluginStartupPolicy: options.inventoryMode === 'profile'
          ? 'serve-startup'
          : 'catalog-prewarm',
      })
      host = await ensurePromise
      if (options.phaseContext?.signal.aborted) {
        await hostManager.releaseHost(host.hostKey).catch(() => undefined)
        host = undefined
        throwOpenCodeAbortReason(options.phaseContext.signal)
      }
      await hostManager.retainHostLease?.(host.hostKey, preflightLease).catch(() => undefined)
    } catch (error) {
      if (options.phaseContext?.signal.aborted) {
        throwOpenCodeAbortReason(options.phaseContext.signal)
      }
      const probeFailure = error instanceof Error ? error.message : String(error)
      const diagnostics = [
        ...inventory.diagnostics,
        probeFailure,
      ]
      const snapshot: OpenCodeProvisioningSnapshot = {
        detected: true,
        hostHealthy: false,
        projectPath: inventory.projectPath,
        models: [...inventory.models],
        modelMetadata: [...(inventory.modelMetadata ?? [])],
        profile: inventory.profile,
        host: null,
        config: null,
        configProviders: null,
        providers: null,
        providerAuth: null,
        agents: [],
        mcp: null,
        appMcp: null,
        probeError: probeFailure || 'OpenCode host start failed',
        diagnostics,
      }
      this.cache.set(cacheKey, {
        expiresAt: Date.now() + OPEN_CODE_PROVISIONING_CACHE_TTL_MS,
        snapshot,
      })
      return {
        snapshot,
        release,
      }
    }

    const requestContext = options.phaseContext
      ? {
          signal: options.phaseContext.signal,
          remainingMs: options.phaseContext.remainingMs,
        }
      : undefined
    const client = clientFactory.create(host.baseUrl, requestContext)

    try {
      const [config, rawConfigProviders, rawProviders, rawProviderAuth, agents] = await Promise.all([
        client.getConfig(),
        client.getConfigProviders(),
        client.getProviders(),
        client.getProviderAuth(),
        client.listAgents(),
      ])
      const configProviders = normalizeOpenCodeLiveConfigProvidersResponse(rawConfigProviders)
      const providers = normalizeOpenCodeLiveProviderResponse(rawProviders)
      const providerAuth = normalizeOpenCodeLiveProviderAuth(rawProviderAuth)
      const appMcp = options.ensureAppMcp === false
        ? null
        : await mcpManager.ensureAppMcp({
          baseUrl: host.baseUrl,
          attachIfMissing: true,
          requestContext,
        })
      if (
        appMcp?.summary.status === 'attached'
        || appMcp?.summary.status === 'present'
      ) {
        host.resolvedConfigFingerprint =
          (await hostManager.refreshResolvedConfigFingerprint?.(host.hostKey))
          ?? host.resolvedConfigFingerprint
      }

      const diagnostics = [...inventory.diagnostics]
      const inventoryConnectedProviders = uniqueSorted(
        inventory.connectedProviders.map(provider => canonicalizeOpenCodeProviderId(provider.id)),
      )
      const hostConnectedProviders = uniqueSorted(
        (providers.connected ?? []).map(canonicalizeOpenCodeProviderId),
      )

      if (host.state !== 'healthy') {
        diagnostics.push(`OpenCode host state is ${host.state}`)
      }

      const missingInventoryProviders = inventoryConnectedProviders.filter(
        providerId => !hostConnectedProviders.includes(providerId),
      )

      if (missingInventoryProviders.length > 0) {
        diagnostics.push(
          `CLI-authenticated providers missing from live host (${missingInventoryProviders.join(', ')})`,
        )
      }

      if (config.default_agent !== 'teammate') {
        diagnostics.push(
          `Managed default agent mismatch (${config.default_agent ?? 'unset'} instead of teammate)`,
        )
      }

      if (!hasPrimaryTeammateAgent(agents)) {
        diagnostics.push('Managed teammate primary agent is missing from the live host')
      }

      if (config.share !== 'disabled') {
        diagnostics.push(`Managed share mode mismatch (${config.share ?? 'unset'} instead of disabled)`)
      }

      if (config.autoupdate !== false) {
        diagnostics.push(
          `Managed autoupdate mismatch (${String(config.autoupdate ?? 'unset')} instead of false)`,
        )
      }

      if (config.snapshot !== true) {
        diagnostics.push(
          `Managed snapshot mismatch (${String(config.snapshot ?? 'unset')} instead of true)`,
        )
      }
      if (appMcp?.summary.status === 'missing' || appMcp?.summary.status === 'attach_failed') {
        diagnostics.push(...appMcp.summary.diagnostics)
      }

      const modelMetadata = options.inventoryMode === 'profile'
        ? mergeOpenCodeModelMetadata(
            inventory.modelMetadata ?? [],
            normalizeOpenCodeLiveModelMetadata(providers),
          )
        : [...(inventory.modelMetadata ?? [])]
      const snapshot: OpenCodeProvisioningSnapshot = {
        detected: true,
        hostHealthy: host.state === 'healthy',
        projectPath: inventory.projectPath,
        models: [...inventory.models],
        modelMetadata,
        profileLiveModelVerification: options.inventoryMode === 'profile',
        profile: inventory.profile,
        host: cloneHost(host),
        config,
        configProviders,
        providers: {
          ...providers,
          connected: hostConnectedProviders,
        },
        providerAuth,
        agents,
        mcp: appMcp?.mcp ?? null,
        appMcp: appMcp?.summary ?? null,
        probeError: host.state === 'healthy' ? null : `OpenCode host state is ${host.state}`,
        diagnostics,
      }

      this.cache.set(cacheKey, {
        expiresAt: Date.now() + OPEN_CODE_PROVISIONING_CACHE_TTL_MS,
        snapshot,
      })
      return {
        snapshot,
        release,
      }
    } catch (error) {
      if (options.phaseContext?.signal.aborted) {
        throwOpenCodeAbortReason(options.phaseContext.signal)
      }
      const probeFailure = error instanceof Error ? error.message : String(error)
      const diagnostics = [
        ...inventory.diagnostics,
        probeFailure,
      ]

      const snapshot: OpenCodeProvisioningSnapshot = {
        detected: true,
        hostHealthy: false,
        projectPath: inventory.projectPath,
        models: [...inventory.models],
        modelMetadata: [...(inventory.modelMetadata ?? [])],
        profile: inventory.profile,
        host: cloneHost(host),
        config: null,
        configProviders: null,
        providers: null,
        providerAuth: null,
        agents: [],
        mcp: null,
        appMcp: null,
        probeError: probeFailure || 'OpenCode verification failed',
        diagnostics,
      }

      this.cache.set(cacheKey, {
        expiresAt: Date.now() + OPEN_CODE_PROVISIONING_CACHE_TTL_MS,
        snapshot,
      })
      return {
        snapshot,
        release,
      }
    } finally {
      if (!options.retainHost) {
        await release()
      }
    }
  }
}

export const openCodeProvisioningProbe = new OpenCodeProvisioningProbe()

export type OpenCodePurposeCompositionAdapterOptions = Readonly<{
  selected: Readonly<{
    projectPath: string
    provider: string
    model: string
  }>
  ports: Readonly<{
    /** S2 selected-provider catalog port. */
    cli(args: readonly string[]): Promise<void>
    /** S1 immutable managed-plugin/native-bridge materialization port. */
    plugin(provider: string): Promise<void>
    /** S3 ledger-first retained-host launch port. */
    host(operation: string): Promise<void>
  }>
}>

/**
 * Public purpose composition seam used by production fakes and app wiring.
 * It deliberately exposes only the three reviewed purpose boundaries: passive
 * S4 status, selected-provider S2 catalog, and S1/S3 launch materialization.
 */
export function createOpenCodePurposeCompositionAdapter(
  options: OpenCodePurposeCompositionAdapterOptions,
): {
  status(): Promise<Awaited<ReturnType<OpenCodePassiveStatusProductionReader['reader']['read']>>>
  catalog(): Promise<void>
  launch(): Promise<void>
} {
  const projectPath = options.selected.projectPath.trim()
  const providerId = canonicalizeOpenCodeProviderId(options.selected.provider)
  const model = parseOpenCodeExactProviderModelRef(options.selected.model)
  if (!projectPath || !model || model.providerId !== providerId) {
    throw new TypeError('OpenCode purpose composition requires one exact project/provider/model selection')
  }
  const ports = Object.freeze({
    cli: options.ports.cli.bind(options.ports),
    plugin: options.ports.plugin.bind(options.ports),
    host: options.ports.host.bind(options.ports),
  })

  return Object.freeze({
    status: () => new OpenCodePassiveStatusProductionReader().reader.read({
      projectPath,
      providerIds: Object.freeze([providerId]),
      timeoutMs: OPEN_CODE_PASSIVE_STATUS_DEFAULT_TIMEOUT_MS,
    }),
    catalog: () => ports.cli(Object.freeze(['models', '--provider', providerId])),
    launch: async () => {
      if (providerId === 'kiro' || providerId === 'cursor-acp') {
        await ports.plugin(providerId)
      }
      await ports.host(`launch:${providerId}:${model.raw}`)
    },
  })
}
