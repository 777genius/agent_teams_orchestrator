import { createHash } from 'node:crypto'

import { openCodeClientFactory } from './OpenCodeClientFactory.js'
import {
  createOpenCodePreflightHostLeaseInput,
  openCodeHostManager,
} from './OpenCodeHostManager.js'
import { openCodeInventoryService } from './OpenCodeInventoryService.js'
import {
  OPEN_CODE_APP_MCP_SERVER_NAME,
  openCodeMcpManager,
} from './OpenCodeMcpManager.js'
import { parseOpenCodeProviderScopedModelRef } from './OpenCodeModelRef.js'
import { canonicalizeOpenCodeProviderId } from './OpenCodeProviderIdentity.js'
import {
  buildManagedConfigFingerprint,
  collectProjectBehaviorMetadata,
  resolveOpenCodeProfileScope,
} from './OpenCodeProfileManager.js'
import { buildOpenCodeExpectedBehaviorEvidence } from './OpenCodeExpectedBehaviorFingerprint.js'
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

  async refreshSelectedProfileAuthority(input: {
    host: OpenCodeHostHandle
    selectedModel: string
    expectedBehaviorFingerprint: string
    contractConfigIdentity?: string | null
    phaseContext?: OpenCodePhaseContext
  }): Promise<OpenCodeHostHandle['profile'] | null> {
    const selected = parseOpenCodeProviderScopedModelRef(input.selectedModel)
    const profile = input.host.profile
    if (!selected || profile.profileScope?.purpose !== 'launch_runtime') return null
    const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
            .map(key => [key, stable((value as Record<string, unknown>)[key])]))
        : value
    const identity = (value: unknown) => createHash('sha256')
      .update(JSON.stringify(stable(value))).digest('hex')
    const selectedConfigIdentity = (config: Record<string, unknown>) => {
      const provider = config.provider as Record<string, unknown> | undefined
      const mcp = config.mcp as Record<string, unknown> | undefined
      return buildManagedConfigFingerprint({
        provider: { [selected.providerId]: provider?.[selected.providerId] ?? null },
        model: config.model ?? null,
        small_model: config.small_model ?? null,
        plugin: config.plugin ?? null,
        agent: config.agent ?? null,
        default_agent: config.default_agent ?? null,
        permission: config.permission ?? null,
        command: config.command ?? null,
        share: config.share ?? null,
        snapshot: config.snapshot ?? null,
        autoupdate: config.autoupdate ?? null,
        mcp: { [OPEN_CODE_APP_MCP_SERVER_NAME]: mcp?.[OPEN_CODE_APP_MCP_SERVER_NAME] ?? null },
      }, profile.env)
    }
    try {
      input.phaseContext?.throwIfExpired()
      const requestContext = input.phaseContext
        ? { signal: input.phaseContext.signal, remainingMs: input.phaseContext.remainingMs }
        : undefined
      const client = (this.deps.clientFactory ?? openCodeClientFactory).create(
        input.host.baseUrl,
        requestContext,
      )
      const [liveConfig, appMcp, behavior, scope] = await Promise.all([
        client.getConfig(),
        (this.deps.mcpManager ?? openCodeMcpManager).ensureAppMcp({
          baseUrl: input.host.baseUrl, attachIfMissing: false,
          requestContext,
        }),
        collectProjectBehaviorMetadata(profile.canonicalProjectPath, profile.env),
        resolveOpenCodeProfileScope({
          projectPath: profile.canonicalProjectPath, purpose: 'launch_runtime',
          selectedModel: selected.raw, env: profile.env,
        }),
      ])
      input.phaseContext?.throwIfExpired()
      const live = liveConfig as Record<string, unknown>
      const liveMcp = (live.mcp as Record<string, unknown> | undefined)
        ?.[OPEN_CODE_APP_MCP_SERVER_NAME]
      const preparedMcp = (profile.managedConfig.mcp as Record<string, unknown> | undefined)
        ?.[OPEN_CODE_APP_MCP_SERVER_NAME]
      if (appMcp.summary.matchedServerName !== OPEN_CODE_APP_MCP_SERVER_NAME
        || appMcp.summary.connected !== true || !liveMcp
        || identity(liveMcp) !== identity(preparedMcp)
        || (input.contractConfigIdentity && identity(liveMcp) !== input.contractConfigIdentity)
        || selectedConfigIdentity(live) !== selectedConfigIdentity(profile.managedConfig)
        || scope.scopeToken !== profile.profileScope.scopeToken
        || scope.configFingerprint !== profile.profileScope.configFingerprint
        || scope.selectedAuthIdentity !== profile.profileScope.selectedAuthIdentity) return null
      const refreshed = { ...profile, projectBehaviorFingerprint: behavior.projectBehaviorFingerprint }
      const evidence = await buildOpenCodeExpectedBehaviorEvidence({
        profile: refreshed, fullModelId: selected.raw,
        effectiveConfigFingerprint: profile.managedConfigFingerprint,
      })
      return evidence.expectedBehaviorFingerprint === input.expectedBehaviorFingerprint
        ? refreshed : null
    } catch {
      return null
    }
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
    } = {},
  ): Promise<RetainedOpenCodeProvisioningProbe> {
    return this.probeWithHost(projectPath, {
      retainHost: true,
      useCache: false,
      toolApprovalMode: options.toolApprovalMode,
      phaseContext: options.phaseContext,
      selectedModel: options.selectedModel,
      leaseId: options.leaseId,
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
      if (
        !prepared
        || !preparedScope
        || inventory.projectPath !== prepared.canonicalProjectPath
        || prepared.projectPath !== prepared.canonicalProjectPath
        || prepared.scopeToken !== profileScope.scopeToken
        || preparedScope.scopeToken !== profileScope.scopeToken
        || preparedScope.purpose !== 'launch_runtime'
        || preparedScope.providerId !== selectedModel!.providerId
        || preparedScope.configFingerprint !== profileScope.configFingerprint
        || preparedScope.selectedAuthIdentity !== profileScope.selectedAuthIdentity
        || !prepared.managedConfig
        || Array.isArray(prepared.managedConfig)
        || buildManagedConfigFingerprint(prepared.managedConfig, prepared.env)
          !== prepared.managedConfigFingerprint
        || authIdentity === undefined
        || authIdentity === 'error'
        || prepared.selectedManagedAuthIdentity === undefined
        || prepared.selectedManagedAuthIdentity === 'error'
        || authIdentity !== prepared.selectedManagedAuthIdentity
        || authIdentity !== profileScope.selectedAuthIdentity
        || prepared.authState !== 'ok'
      ) {
        throw new Error('OpenCode strict launch profile scope evidence is invalid')
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
        await hostManager.releaseHost(host.hostKey, { keepPersistentAlive: keepAlive })
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
        ...(profileScope ? {
          prewarmManagedSubscriptionPlugins: false,
          resolveConfigFingerprint: false,
        } : {}),
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
        host: null,
        release,
      }
    }

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
          attachIfMissing: true,
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
        host,
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
