import { isOpenCodeMcpManagerBoundToCustody } from './OpenCodeMcpManager.js'
import { assertTrustedOpenCodeCustody, type OpenCodeHostAcquisitionPolicy } from './OpenCodeSupervisedHostCustody.js'
import { createOpenCodeSupervisedInventory } from './OpenCodeSupervisedInventory.js'
import { OpenCodeClientFactory, isOpenCodeClientFactoryBoundToCustody } from './OpenCodeClientFactory.js'
import { isOpenCodeHostManagerBoundToCustody } from './OpenCodeHostManager.js'
import { openCodeClientFactory } from './OpenCodeClientFactory.js'
import {
  createOpenCodePreflightHostLeaseInput,
  openCodeHostManager,
} from './OpenCodeHostManager.js'
import { openCodeInventoryService } from './OpenCodeInventoryService.js'
import { openCodeMcpManager } from './OpenCodeMcpManager.js'
import { canonicalizeOpenCodeProviderId } from './OpenCodeProviderIdentity.js'
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
  acquisitionPolicy?: OpenCodeHostAcquisitionPolicy
  inventoryService?: Pick<typeof openCodeInventoryService, 'probe'>
  hostManager?: Pick<
    typeof openCodeHostManager,
    'ensureHost' | 'releaseHost' | 'refreshResolvedConfigFingerprint' | 'releaseHostLease'
  >
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

  private readonly deps: OpenCodeProvisioningProbeDeps
  constructor(deps: OpenCodeProvisioningProbeDeps = {}) {
    const policy = deps.acquisitionPolicy
    if (policy?.mode === 'supervisor-adopt-only') {
      const custody = policy.custody
      assertTrustedOpenCodeCustody(custody)
      if (new.target !== OpenCodeProvisioningProbe) throw new Error('OpenCode supervised probe implementation substituted')
      if (!deps.hostManager || !isOpenCodeHostManagerBoundToCustody(deps.hostManager, custody) ||
        !(deps.clientFactory instanceof OpenCodeClientFactory) ||
        !isOpenCodeClientFactoryBoundToCustody(deps.clientFactory, custody) || !deps.mcpManager ||
        !isOpenCodeMcpManagerBoundToCustody(deps.mcpManager, custody) || deps.inventoryService) {
        throw new Error('OpenCode supervised provisioning requires custody-bound consumers')
      }
      const hosts = deps.hostManager, mcp = deps.mcpManager
      this.deps = Object.freeze({ acquisitionPolicy: Object.freeze({ mode: 'supervisor-adopt-only', custody }),
        inventoryService: createOpenCodeSupervisedInventory(custody, deps.clientFactory),
        clientFactory: Object.freeze({ create: deps.clientFactory.create.bind(deps.clientFactory) }),
        hostManager: Object.freeze({ ensureHost: hosts.ensureHost.bind(hosts), releaseHost: hosts.releaseHost.bind(hosts),
          releaseHostLease: hosts.releaseHostLease.bind(hosts),
          refreshResolvedConfigFingerprint: hosts.refreshResolvedConfigFingerprint.bind(hosts) }),
        mcpManager: Object.freeze({ ensureAppMcp: mcp.ensureAppMcp.bind(mcp) }),
      })
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(OpenCodeProvisioningProbe.prototype))) {
        if (name === 'constructor') continue
        if (typeof descriptor.value === 'function') {
          Object.defineProperty(this, name, { value: descriptor.value.bind(this) })
        } else if (descriptor.get) {
          Object.defineProperty(this, name, { get: descriptor.get.bind(this) })
        }
      }
      Object.freeze(this)
    } else this.deps = deps
  }

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
    })
    return result.snapshot
  }

  async probeRetainingHost(
    projectPath?: string | null,
    options: Pick<OpenCodeProvisioningProbeOptions, 'toolApprovalMode' | 'phaseContext'> = {},
  ): Promise<RetainedProvisioningProbe> {
    return this.probeWithHost(projectPath, {
      retainHost: true,
      useCache: false,
      toolApprovalMode: options.toolApprovalMode,
      phaseContext: options.phaseContext,
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
    },
  ): Promise<RetainedProvisioningProbe> {
    const inventoryService = this.deps.inventoryService ?? openCodeInventoryService
    const inventory = await inventoryService.probe(projectPath, {
      bypassCache: !options.useCache,
      includeAppMcp: options.ensureAppMcp !== false,
      toolApprovalMode: options.toolApprovalMode,
      abortSignal: options.phaseContext?.signal,
    })
    const cacheKey = [
      inventory.projectPath,
      inventory.profile?.projectBehaviorFingerprint ?? 'none',
      inventory.profile?.managedAuthFingerprint ?? 'none',
      inventory.profile?.managedConfigFingerprint ?? 'none',
      options.ensureAppMcp === false ? 'without-app-mcp' : 'with-app-mcp',
      options.toolApprovalMode ?? 'auto',
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
        lease: preflightLease,
      })
      host = await ensurePromise
      if (options.phaseContext?.signal.aborted) {
        await hostManager.releaseHost(host.hostKey).catch(() => undefined)
        host = undefined
        throwOpenCodeAbortReason(options.phaseContext.signal)
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
      const [config, configProviders, providers, providerAuth, agents] = await Promise.all([
        client.getConfig(),
        client.getConfigProviders(),
        client.getProviders(),
        client.getProviderAuth(),
        client.listAgents(),
      ])
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
        const refreshed = await hostManager.refreshResolvedConfigFingerprint?.(host.hostKey)
        if (this.deps.acquisitionPolicy?.mode !== 'supervisor-adopt-only') {
          host.resolvedConfigFingerprint = refreshed ?? host.resolvedConfigFingerprint
        }
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

      const snapshot: OpenCodeProvisioningSnapshot = {
        detected: true,
        hostHealthy: host.state === 'healthy',
        projectPath: inventory.projectPath,
        models: [...inventory.models],
        modelMetadata: [...(inventory.modelMetadata ?? [])],
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
