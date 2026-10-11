import { refreshSelectedProfileAuthority } from './OpenCodeSelectedProfileAuthority.js'
export type { OpenCodeAuthorityRejection } from './OpenCodeSelectedProfileAuthority.js'
import { formatOpenCodeLockFailure, safeOpenCodeLockFailure } from './OpenCodeLockFailure.js'
import { openCodeClientFactory } from './OpenCodeClientFactory.js'
import {
  createOpenCodePreflightHostLeaseInput,
  openCodeHostManager,
} from './OpenCodeHostManager.js'
import { openCodeInventoryService } from './OpenCodeInventoryService.js'
import {
  openCodeMcpManager,
} from './OpenCodeMcpManager.js'
import { parseOpenCodeProviderScopedModelRef } from './OpenCodeModelRef.js'
import { canonicalizeOpenCodeProviderId } from './OpenCodeProviderIdentity.js'
import {
  buildManagedConfigFingerprint,
  resolveOpenCodeProfileScope,
} from './OpenCodeProfileManager.js'
import {
  type OpenCodePhaseContext,
  throwOpenCodeAbortReason,
  isOpenCodeRuntimeDeadlineError,
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
    & Partial<Pick<typeof openCodeHostManager, 'withHostOperation' | 'retainHostLease' | 'releaseHostLease'>>
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

export type RetainedOpenCodeProvisioningProbe = {
  snapshot: OpenCodeProvisioningSnapshot
  host: OpenCodeHostHandle | null
  release: (keepAlive?: boolean) => Promise<void>
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

  async refreshSelectedProfileAuthority(
    input: Parameters<typeof refreshSelectedProfileAuthority>[0],
  ): Promise<OpenCodeHostHandle['profile'] | null> {
    return refreshSelectedProfileAuthority(input, this.deps)
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
    options: Pick<OpenCodeProvisioningProbeOptions, 'toolApprovalMode' | 'phaseContext'> & {
      selectedModel?: string
      leaseId?: string
      existingHostKey?: string
      expectedRuntimePid?: number
      attachAppMcp?: boolean
    } = {},
  ): Promise<RetainedOpenCodeProvisioningProbe> {
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
  ): Promise<RetainedOpenCodeProvisioningProbe> {
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
      ...(profileScope ? { mode: 'profile' as const } : {}),
      includeAppMcp: options.ensureAppMcp !== false,
      toolApprovalMode: options.toolApprovalMode,
      abortSignal: options.phaseContext?.signal,
      ...(profileScope ? { profileScope } : {}),
    })
    if (profileScope && inventory.detected) {
      const prepared = inventory.profile
      const preparedScope = prepared?.profileScope
      const authIdentity = prepared?.selectedSourceAuthIdentity
      // Naming the failing check turns an opaque launch refusal into something
      // a user or a bug report can act on. No identity value is disclosed.
      const evidenceFailures = !prepared || !preparedScope
        ? ['prepared_profile_missing']
        : Object.entries({
          project_path_mismatch: inventory.projectPath !== prepared.canonicalProjectPath,
          project_path_not_canonical: prepared.projectPath !== prepared.canonicalProjectPath,
          scope_token_mismatch: prepared.scopeToken !== profileScope.scopeToken
            || preparedScope.scopeToken !== profileScope.scopeToken,
          scope_purpose_mismatch: preparedScope.purpose !== 'launch_runtime',
          scope_provider_mismatch: preparedScope.providerId !== selectedModel!.providerId,
          config_fingerprint_mismatch:
            preparedScope.configFingerprint !== profileScope.configFingerprint,
          scope_auth_identity_mismatch:
            preparedScope.selectedAuthIdentity !== profileScope.selectedAuthIdentity,
          managed_config_missing: !prepared.managedConfig || Array.isArray(prepared.managedConfig),
          managed_config_fingerprint_mismatch: Boolean(prepared.managedConfig)
            && !Array.isArray(prepared.managedConfig)
            && buildManagedConfigFingerprint(prepared.managedConfig, prepared.env)
              !== prepared.managedConfigFingerprint,
          source_auth_identity_unavailable:
            authIdentity === undefined || authIdentity === 'error',
          managed_auth_identity_unavailable:
            prepared.selectedManagedAuthIdentity === undefined
            || prepared.selectedManagedAuthIdentity === 'error',
          auth_identity_mismatch: authIdentity !== prepared.selectedManagedAuthIdentity
            || authIdentity !== profileScope.selectedAuthIdentity,
          auth_state_not_ok: prepared.authState !== 'ok',
        }).filter(([, failed]) => failed).map(([name]) => name)
      if (evidenceFailures.length > 0) {
        throw new Error(
          `OpenCode strict launch profile scope evidence is invalid: ${evidenceFailures.join(', ')}`,
        )
      }
    }
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
        host: cached.snapshot.host,
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
    const preflightLease = createOpenCodePreflightHostLeaseInput(
      options.leaseId ? `strict-launch-${options.leaseId}` : 'readiness',
    )
    let released = false
    const release = async (keepAlive = false) => {
      if (released || !host) {
        return
      }
      released = true
      await hostManager.releaseHostLease?.(host.hostKey, preflightLease).catch(() => undefined)
      if (options.disposeHostOnRelease !== false) {
        await hostManager.releaseHost(host.hostKey, { keepPersistentAlive: keepAlive || Boolean(options.existingHostKey) })
      }
    }
    try {
      const ensurePromise = hostManager.ensureHost({
        projectPath: inventory.projectPath,
        ...(options.existingHostKey ? { hostKey: options.existingHostKey, existingOnly: true } : {}),
        preparedProfile: inventory.profile ?? undefined,
        ...(options.phaseContext
          ? { healthTimeoutMs: options.phaseContext.remainingMs() }
          : {}),
        ...(options.phaseContext ? { abortSignal: options.phaseContext.signal } : {}),
        hostLifetime: options.retainHost || options.disposeHostOnRelease === false
          ? 'persistent'
          : 'process',
        ...(profileScope ? {
          prewarmManagedSubscriptionPlugins: false,
          resolveConfigFingerprint: false,
        } : {}),
      })
      host = await ensurePromise
      if (options.expectedRuntimePid !== undefined && host.pid !== options.expectedRuntimePid) {
        const acquired = host
        host = undefined
        await hostManager.releaseHost(acquired.hostKey, { keepPersistentAlive: true })
        throw new Error(`OpenCode selected session runtime process changed (expected pid=${options.expectedRuntimePid}, actual pid=${acquired.pid}); relaunch the lane`)
      }
      if (options.phaseContext?.signal.aborted) {
        await hostManager.releaseHost(host.hostKey, { keepPersistentAlive: Boolean(options.existingHostKey) }).catch(() => undefined)
        host = undefined
        throwOpenCodeAbortReason(options.phaseContext.signal)
      }
      await hostManager.retainHostLease?.(host.hostKey, preflightLease)
    } catch (error) {
      // A failed durable admission must not leak the reference ensureHost acquired.
      if (host && !released) {
        const acquired = host
        host = undefined
        released = true
        await hostManager.releaseHost(acquired.hostKey, {
          keepPersistentAlive: Boolean(options.existingHostKey) || options.disposeHostOnRelease === false,
        }).catch(() => undefined)
      }
      if (options.phaseContext?.signal.aborted) {
        throwOpenCodeAbortReason(options.phaseContext.signal)
      }
      if (options.existingHostKey) throw error
      const lockFailure = isOpenCodeRuntimeDeadlineError(error) ? null : safeOpenCodeLockFailure(error)
      const probeFailure = lockFailure ? formatOpenCodeLockFailure(lockFailure)
        : error instanceof Error ? error.message : String(error)
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
        host: null,
        release,
      }
    }

    const acquiredHost = host
    const inspect = async (): Promise<RetainedOpenCodeProvisioningProbe> => {
      const host = acquiredHost
      const requestContext = options.phaseContext
        ? {
            signal: options.phaseContext.signal,
            remainingMs: options.phaseContext.remainingMs,
          }
        : undefined
      if (profileScope) {
        try {
          if (
            host.projectPath !== inventory.projectPath
            || host.profile.profileRootKey !== inventory.profile?.profileRootKey
            || host.profile.profileScope?.scopeToken !== profileScope.scopeToken
            || host.profile.profileScope?.purpose !== 'launch_runtime'
            || host.profile.profileScope?.providerId !== selectedModel!.providerId
            || host.profile.profileScope?.configFingerprint !== profileScope.configFingerprint
            || host.profile.selectedSourceAuthIdentity
              !== inventory.profile?.selectedSourceAuthIdentity
            || host.profile.selectedManagedAuthIdentity
              !== inventory.profile?.selectedManagedAuthIdentity
            || host.profile.authState !== 'ok'
            || host.profile.managedConfigFingerprint !== inventory.profile?.managedConfigFingerprint
            || buildManagedConfigFingerprint(host.profile.managedConfig, host.profile.env)
              !== host.profile.managedConfigFingerprint
            || host.resolvedConfigFingerprint !== inventory.profile?.managedConfigFingerprint
          ) {
            throw new Error('OpenCode strict launch retained host/profile fingerprint mismatch')
          }
          const appMcp = await mcpManager.ensureAppMcp({
            baseUrl: host.baseUrl,
            attachIfMissing: options.attachAppMcp !== false,
            requestContext,
          })
          const appMcpReady = appMcp.summary.status === 'attached'
            || appMcp.summary.status === 'present'
          return {
            snapshot: {
              detected: true,
              hostHealthy: host.state === 'healthy' && appMcpReady,
              projectPath: inventory.projectPath,
              models: [selectedModel!.raw],
              modelMetadata: [],
              profile: inventory.profile,
              host: cloneHost(host),
              config: null,
              configProviders: null,
              providers: null,
              providerAuth: null,
              agents: [],
              mcp: appMcp.mcp,
              appMcp: appMcp.summary,
              probeError: appMcpReady ? null : 'OpenCode App MCP is unavailable',
              diagnostics: [...inventory.diagnostics, ...appMcp.summary.diagnostics],
            },
            host,
            release,
          }
        } catch (error) {
          await release()
          throw error
        }
      }

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
          host,
          release,
        }
      } catch (error) {
        if (options.phaseContext?.signal.aborted) {
          throwOpenCodeAbortReason(options.phaseContext.signal)
        }
        const lockFailure = isOpenCodeRuntimeDeadlineError(error) ? null : safeOpenCodeLockFailure(error)
        const probeFailure = lockFailure ? formatOpenCodeLockFailure(lockFailure)
          : error instanceof Error ? error.message : String(error)
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
          host,
          release,
        }
      }
    }
    try {
      return await (hostManager.withHostOperation
        ? hostManager.withHostOperation(acquiredHost, preflightLease, inspect)
        : inspect())
    } catch (error) {
      // No retained result reached the caller, so nobody else owns its release.
      await release()
      throw error
    } finally {
      if (!options.retainHost) {
        await release()
      }
    }
  }
}

export const openCodeProvisioningProbe = new OpenCodeProvisioningProbe()
