import { openCodeClientFactory } from './OpenCodeClientFactory.js'
import {
  createOpenCodePreflightHostLeaseInput,
  openCodeHostManager,
} from './OpenCodeHostManager.js'
import { openCodeInventoryService } from './OpenCodeInventoryService.js'
import { openCodeMcpManager } from './OpenCodeMcpManager.js'
import { canonicalizeOpenCodeProviderId } from './OpenCodeProviderIdentity.js'
import { parseOpenCodeProviderScopedModelRef } from './OpenCodeModelRef.js'
import { buildManagedConfigFingerprint, resolveOpenCodeProfileScope } from './OpenCodeProfileManager.js'
import { refreshSelectedProfileAuthority } from './OpenCodeSelectedProfileAuthority.js'
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
export type RetainedOpenCodeProvisioningProbe = { snapshot: OpenCodeProvisioningSnapshot; host: OpenCodeHostHandle | null; release: (keepAlive?: boolean) => Promise<void> }
export type { OpenCodeAuthorityRejection } from './OpenCodeSelectedProfileAuthority.js'

type OpenCodeProvisioningProbeDeps = {
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
  selectedModel?: string
  leaseId?: string
  existingHostKey?: string
  expectedRuntimePid?: number
  attachAppMcp?: boolean
}

type RetainedProvisioningProbe = {
  snapshot: OpenCodeProvisioningSnapshot
  /** The caller-retained handle; snapshot.host is a defensive diagnostic clone. */
  host: OpenCodeHostHandle | null
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

  /** Refresh the selected authority on the same retained launch host. */
  async refreshSelectedProfileAuthority(
    input: Parameters<typeof refreshSelectedProfileAuthority>[0],
  ): Promise<OpenCodeHostHandle['profile'] | null> {
    return refreshSelectedProfileAuthority(input)
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
      selectedModel: options.selectedModel,
      leaseId: options.leaseId,
      existingHostKey: options.existingHostKey,
      expectedRuntimePid: options.expectedRuntimePid,
      attachAppMcp: options.attachAppMcp,
    })
    return result.snapshot
  }

  async probeRetainingHost(
    projectPath?: string | null,
    options: Pick<OpenCodeProvisioningProbeOptions, 'toolApprovalMode' | 'phaseContext' | 'selectedModel' | 'leaseId' | 'existingHostKey' | 'expectedRuntimePid' | 'attachAppMcp'> = {},
  ): Promise<RetainedProvisioningProbe> {
    return this.probeWithHost(projectPath, {
      retainHost: true,
      useCache: false,
      toolApprovalMode: options.toolApprovalMode,
      phaseContext: options.phaseContext,
      selectedModel: options.selectedModel,
      leaseId: options.leaseId,
      existingHostKey: options.existingHostKey,
      expectedRuntimePid: options.expectedRuntimePid,
      attachAppMcp: options.attachAppMcp,
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
      selectedModel?: string
      leaseId?: string
      existingHostKey?: string
      expectedRuntimePid?: number
      attachAppMcp?: boolean
    },
  ): Promise<RetainedProvisioningProbe> {
    const inventoryService = this.deps.inventoryService ?? openCodeInventoryService
    const selectedModel = options.selectedModel
      ? parseOpenCodeProviderScopedModelRef(options.selectedModel)
      : null
    if (options.selectedModel && !selectedModel) {
      throw new Error('OpenCode strict launch requires a provider-qualified selected model')
    }
    const profileScope = selectedModel
      ? await resolveOpenCodeProfileScope({
          projectPath,
          purpose: 'launch_runtime',
          selectedModel: selectedModel.raw,
        })
      : undefined
    const inventory = await inventoryService.probe(projectPath, {
      bypassCache: !options.useCache,
      ...(profileScope ? { mode: 'profile' as const, profileScope } : {}),
      includeAppMcp: options.ensureAppMcp !== false,
      toolApprovalMode: options.toolApprovalMode,
      abortSignal: options.phaseContext?.signal,
    })
    if (profileScope && inventory.detected) {
      const prepared = inventory.profile
      const preparedScope = prepared?.profileScope
      const invalid = !prepared || !preparedScope
        || inventory.projectPath !== prepared.canonicalProjectPath
        || prepared.projectPath !== prepared.canonicalProjectPath
        || prepared.scopeToken !== profileScope.scopeToken
        || preparedScope.scopeToken !== profileScope.scopeToken
        || preparedScope.purpose !== 'launch_runtime'
        || preparedScope.providerId !== selectedModel!.providerId
        || preparedScope.configFingerprint !== profileScope.configFingerprint
        || preparedScope.selectedAuthIdentity !== profileScope.selectedAuthIdentity
        || prepared.selectedSourceAuthIdentity === undefined
        || prepared.selectedSourceAuthIdentity === 'error'
        || prepared.selectedManagedAuthIdentity === undefined
        || prepared.selectedManagedAuthIdentity === 'error'
        || prepared.selectedSourceAuthIdentity !== prepared.selectedManagedAuthIdentity
        || prepared.selectedSourceAuthIdentity !== profileScope.selectedAuthIdentity
        || prepared.authState !== 'ok'
        || buildManagedConfigFingerprint(prepared.managedConfig, prepared.env)
          !== prepared.managedConfigFingerprint
      if (invalid) throw new Error('OpenCode strict launch profile scope evidence is invalid')
    }
    const cacheKey = [
      inventory.projectPath,
      inventory.profile?.projectBehaviorFingerprint ?? 'none',
      inventory.profile?.managedAuthFingerprint ?? 'none',
      inventory.profile?.managedConfigFingerprint ?? 'none',
      options.ensureAppMcp === false ? 'without-app-mcp' : 'with-app-mcp',
      options.toolApprovalMode ?? 'auto',
      profileScope?.scopeToken ?? 'unscoped',
    ].join('::')
    const cached = options.useCache ? this.cache.get(cacheKey) : undefined
    if (cached && cached.expiresAt > Date.now()) {
      return {
        snapshot: cached.snapshot,
        host: null,
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
        host: null,
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
      if (profileScope && (
        host.profile.profileScope?.scopeToken !== profileScope.scopeToken
        || host.profile.profileScope?.providerId !== selectedModel!.providerId
        || host.profile.selectedSourceAuthIdentity !== profileScope.selectedAuthIdentity
        || host.profile.selectedManagedAuthIdentity !== profileScope.selectedAuthIdentity
        || host.profile.authState !== 'ok'
      )) throw new Error('OpenCode strict launch retained host/profile fingerprint mismatch')
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
        host: host ?? null,
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
        host: host ?? null,
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
        host: host ?? null,
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
