import { openCodeClientFactory } from './OpenCodeClientFactory.js'
import {
  createOpenCodePreflightHostLeaseInput,
  openCodeHostManager,
} from './OpenCodeHostManager.js'
import { openCodeInventoryService } from './OpenCodeInventoryService.js'
import { openCodeMcpManager } from './OpenCodeMcpManager.js'

import type {
  OpenCodeAgentResponse,
  OpenCodeProvisioningSnapshot,
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

  async probe(projectPath?: string | null): Promise<OpenCodeProvisioningSnapshot> {
    const result = await this.probeWithHost(projectPath, {
      retainHost: false,
      useCache: true,
    })
    return result.snapshot
  }

  async probeRetainingHost(projectPath?: string | null): Promise<RetainedProvisioningProbe> {
    return this.probeWithHost(projectPath, {
      retainHost: true,
      useCache: false,
    })
  }

  private async probeWithHost(
    projectPath: string | null | undefined,
    options: { retainHost: boolean; useCache: boolean },
  ): Promise<RetainedProvisioningProbe> {
    const inventoryService = this.deps.inventoryService ?? openCodeInventoryService
    const inventory = await inventoryService.probe(projectPath)
    const cacheKey = [
      inventory.projectPath,
      inventory.profile?.projectBehaviorFingerprint ?? 'none',
      inventory.profile?.managedAuthFingerprint ?? 'none',
      inventory.profile?.managedConfigFingerprint ?? 'none',
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

    let host
    const preflightLease = createOpenCodePreflightHostLeaseInput('readiness')
    let released = false
    const release = async () => {
      if (released || !host) {
        return
      }
      released = true
      await hostManager.releaseHostLease?.(host.hostKey, preflightLease).catch(() => undefined)
      await hostManager.releaseHost(host.hostKey)
    }
    try {
      host = await hostManager.ensureHost({
        projectPath: inventory.projectPath,
        preparedProfile: inventory.profile ?? undefined,
      })
      await hostManager.retainHostLease?.(host.hostKey, preflightLease).catch(() => undefined)
    } catch (error) {
      const diagnostics = [
        ...inventory.diagnostics,
        error instanceof Error ? error.message : String(error),
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
        probeError: diagnostics[0] ?? 'OpenCode host start failed',
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

    const client = clientFactory.create(host.baseUrl)

    try {
      const [config, configProviders, providers, providerAuth, agents] = await Promise.all([
        client.getConfig(),
        client.getConfigProviders(),
        client.getProviders(),
        client.getProviderAuth(),
        client.listAgents(),
      ])
      const appMcp = await mcpManager.ensureAppMcp({
        baseUrl: host.baseUrl,
        attachIfMissing: true,
      })
      if (appMcp.summary.status === 'attached') {
        host.resolvedConfigFingerprint =
          (await hostManager.refreshResolvedConfigFingerprint?.(host.hostKey))
          ?? host.resolvedConfigFingerprint
      }

      const diagnostics = [...inventory.diagnostics]
      const inventoryConnectedProviders = uniqueSorted(
        inventory.connectedProviders.map(provider => provider.id),
      )
      const hostConnectedProviders = uniqueSorted(providers.connected ?? [])
      const connectedProviders = uniqueSorted([
        ...hostConnectedProviders,
        ...inventoryConnectedProviders,
      ])

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
      if (appMcp.summary.status === 'missing' || appMcp.summary.status === 'attach_failed') {
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
          connected: connectedProviders,
        },
        providerAuth,
        agents,
        mcp: appMcp.mcp,
        appMcp: appMcp.summary,
        probeError: diagnostics[0] ?? null,
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
      const diagnostics = [
        ...inventory.diagnostics,
        error instanceof Error ? error.message : String(error),
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
        probeError: diagnostics[0] ?? 'OpenCode verification failed',
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
