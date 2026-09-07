import { createHash } from 'node:crypto'
import { openCodeClientFactory } from './OpenCodeClientFactory.js'
import { OPEN_CODE_APP_MCP_SERVER_NAME, openCodeMcpManager } from './OpenCodeMcpManager.js'
import { parseOpenCodeProviderScopedModelRef } from './OpenCodeModelRef.js'
import { buildManagedConfigFingerprint, collectProjectBehaviorMetadata, resolveOpenCodeProfileScope } from './OpenCodeProfileManager.js'
import { buildOpenCodeExpectedBehaviorEvidence } from './OpenCodeExpectedBehaviorFingerprint.js'
import type { OpenCodePhaseContext } from './OpenCodeRuntimeDeadline.js'
import type { OpenCodeHostHandle } from './types.js'

type OpenCodeSelectedProfileAuthorityDeps = {
  clientFactory?: Pick<typeof openCodeClientFactory, 'create'>
  mcpManager?: Pick<typeof openCodeMcpManager, 'ensureAppMcp'>
}

export type OpenCodeAuthorityRejection =
  | { check: 'selected_model' | 'profile_scope' | 'mcp_name' | 'mcp_connected'
      | 'live_mcp_present' | 'mcp_config_match' | 'contract_config_match'
      | 'scope_token_match' | 'scope_config_match'
      | 'selected_auth_identity_match' | 'behavior_match' }
  | { check: 'selected_config_match'; fields: OpenCodeSelectedConfigField[] }
  | { check: 'exception'; phase: OpenCodeAuthorityRefreshPhase
      errorClass: 'TypeError' | 'RangeError' | 'SyntaxError' | 'Error' | 'non_error' }

type OpenCodeAuthorityRefreshPhase = 'initial' | 'live_config' | 'app_mcp'
  | 'project_behavior' | 'profile_scope' | 'authority_checks' | 'behavior_evidence'

const SELECTED_CONFIG_FIELDS = ['provider', 'model', 'small_model', 'plugin', 'agent',
  'default_agent', 'permission', 'command', 'share', 'snapshot', 'autoupdate', 'mcp'] as const
type OpenCodeSelectedConfigField = typeof SELECTED_CONFIG_FIELDS[number]

class OpenCodeAuthorityReadError {
  constructor(readonly phase: OpenCodeAuthorityRefreshPhase, readonly error: unknown) {}
}

function normalizeSelectedAgentDefaults(agents: unknown): unknown {
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return agents
  // OpenCode 1.18.4 ConfigV1 agent.normalize adds empty options. Preserve all
  // actual options, permissions and unknown fields when comparing authority.
  return Object.fromEntries(Object.entries(agents).map(([name, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [name, value]
    const agent = value as Record<string, unknown>
    return [name, agent.options === undefined ? { ...agent, options: {} } : agent]
  }))
}

// OpenCode's config schema silently drops model fields it does not know when it
// serves GET /config (verified on 1.18.4 and 1.18.29), so managed catalog
// metadata carrying them can never match the live config. Strip the same fields
// from both sides; every field OpenCode actually keeps still fails closed.
const CONFIG_DROPPED_MODEL_FIELDS = ['structured_output'] as const

function normalizeSelectedProviderModels(provider: unknown): unknown {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return provider
  const models = (provider as Record<string, unknown>).models
  if (!models || typeof models !== 'object' || Array.isArray(models)) return provider
  return {
    ...(provider as Record<string, unknown>),
    models: Object.fromEntries(Object.entries(models).map(([modelId, model]) => {
      if (!model || typeof model !== 'object' || Array.isArray(model)) return [modelId, model]
      const normalized = { ...(model as Record<string, unknown>) }
      for (const field of CONFIG_DROPPED_MODEL_FIELDS) delete normalized[field]
      return [modelId, normalized]
    })),
  }
}

export async function refreshSelectedProfileAuthority(input: {
    host: OpenCodeHostHandle
    selectedModel: string
    expectedBehaviorFingerprint: string
    contractConfigIdentity?: string | null
    phaseContext?: OpenCodePhaseContext
    onRejection?: (diagnostic: OpenCodeAuthorityRejection) => void
  }, deps: OpenCodeSelectedProfileAuthorityDeps = {}): Promise<OpenCodeHostHandle['profile'] | null> {
    const reject = (diagnostic: OpenCodeAuthorityRejection): null => {
      // Observability must not change the fail-closed profile|null contract.
      try { input.onRejection?.(diagnostic) } catch {}
      return null
    }
    const selected = parseOpenCodeProviderScopedModelRef(input.selectedModel)
    const profile = input.host.profile
    if (!selected) return reject({ check: 'selected_model' })
    if (profile.profileScope?.purpose !== 'launch_runtime') return reject({ check: 'profile_scope' })
    const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
            .map(key => [key, stable((value as Record<string, unknown>)[key])]))
        : value
    const identity = (value: unknown) => createHash('sha256')
      .update(JSON.stringify(stable(value))).digest('hex')
    const selectedConfig = (config: Record<string, unknown>) => {
      const provider = config.provider as Record<string, unknown> | undefined
      const mcp = config.mcp as Record<string, unknown> | undefined
      return {
        provider: { [selected.providerId]:
          normalizeSelectedProviderModels(provider?.[selected.providerId] ?? null) },
        model: config.model ?? null,
        small_model: config.small_model ?? null,
        plugin: config.plugin ?? null,
        agent: normalizeSelectedAgentDefaults(config.agent ?? null),
        default_agent: config.default_agent ?? null,
        permission: config.permission ?? null,
        // Config.load initializes absent commands to an empty map.
        command: config.command === undefined ? {} : config.command,
        share: config.share ?? null,
        snapshot: config.snapshot ?? null,
        autoupdate: config.autoupdate ?? null,
        mcp: { [OPEN_CODE_APP_MCP_SERVER_NAME]: mcp?.[OPEN_CODE_APP_MCP_SERVER_NAME] ?? null },
      }
    }
    let phase: OpenCodeAuthorityRefreshPhase = 'initial'
    const read = async <T>(readPhase: OpenCodeAuthorityRefreshPhase, operation: () => Promise<T>) => {
      try { return await operation() }
      catch (error) { throw new OpenCodeAuthorityReadError(readPhase, error) }
    }
    try {
      input.phaseContext?.throwIfExpired()
      const requestContext = input.phaseContext
        ? { signal: input.phaseContext.signal, remainingMs: input.phaseContext.remainingMs }
        : undefined
      const client = (deps.clientFactory ?? openCodeClientFactory).create(
        input.host.baseUrl,
        requestContext,
      )
      const [liveConfig, appMcp, behavior, scope] = await Promise.all([
        read('live_config', () => client.getConfig()),
        read('app_mcp', () => (deps.mcpManager ?? openCodeMcpManager).ensureAppMcp({
          baseUrl: input.host.baseUrl, attachIfMissing: false,
          requestContext,
        })),
        read('project_behavior', () => collectProjectBehaviorMetadata(profile.canonicalProjectPath, profile.env)),
        read('profile_scope', () => resolveOpenCodeProfileScope({
          projectPath: profile.canonicalProjectPath, purpose: 'launch_runtime',
          selectedModel: selected.raw, env: profile.env,
        })),
      ])
      phase = 'authority_checks'
      input.phaseContext?.throwIfExpired()
      const live = liveConfig as Record<string, unknown>
      const liveMcp = (live.mcp as Record<string, unknown> | undefined)
        ?.[OPEN_CODE_APP_MCP_SERVER_NAME]
      const preparedMcp = (profile.managedConfig.mcp as Record<string, unknown> | undefined)
        ?.[OPEN_CODE_APP_MCP_SERVER_NAME]
      if (appMcp.summary.matchedServerName !== OPEN_CODE_APP_MCP_SERVER_NAME) return reject({ check: 'mcp_name' })
      if (appMcp.summary.connected !== true) return reject({ check: 'mcp_connected' })
      if (!liveMcp) return reject({ check: 'live_mcp_present' })
      if (identity(liveMcp) !== identity(preparedMcp)) return reject({ check: 'mcp_config_match' })
      if (input.contractConfigIdentity && identity(liveMcp) !== input.contractConfigIdentity) return reject({ check: 'contract_config_match' })
      const liveSelected = selectedConfig(live)
      const preparedSelected = selectedConfig(profile.managedConfig)
      if (buildManagedConfigFingerprint(liveSelected, profile.env)
        !== buildManagedConfigFingerprint(preparedSelected, profile.env)) {
        return reject({
          check: 'selected_config_match',
          fields: SELECTED_CONFIG_FIELDS.filter(field =>
            buildManagedConfigFingerprint({ [field]: liveSelected[field] }, profile.env)
              !== buildManagedConfigFingerprint({ [field]: preparedSelected[field] }, profile.env)),
        })
      }
      if (scope.scopeToken !== profile.profileScope.scopeToken) return reject({ check: 'scope_token_match' })
      if (scope.configFingerprint !== profile.profileScope.configFingerprint) return reject({ check: 'scope_config_match' })
      if (scope.selectedAuthIdentity !== profile.profileScope.selectedAuthIdentity) return reject({ check: 'selected_auth_identity_match' })
      const refreshed = { ...profile, projectBehaviorFingerprint: behavior.projectBehaviorFingerprint }
      phase = 'behavior_evidence'
      const evidence = await buildOpenCodeExpectedBehaviorEvidence({
        profile: refreshed, fullModelId: selected.raw,
        effectiveConfigFingerprint: profile.managedConfigFingerprint,
      })
      return evidence.expectedBehaviorFingerprint === input.expectedBehaviorFingerprint
        ? refreshed : reject({ check: 'behavior_match' })
    } catch (caught) {
      const error = caught instanceof OpenCodeAuthorityReadError ? caught.error : caught
      return reject({
        check: 'exception',
        phase: caught instanceof OpenCodeAuthorityReadError ? caught.phase : phase,
        // Never expose error messages/names: provider errors can include credentials or config.
        errorClass: error instanceof TypeError ? 'TypeError'
          : error instanceof RangeError ? 'RangeError'
          : error instanceof SyntaxError ? 'SyntaxError'
          : error instanceof Error ? 'Error' : 'non_error',
      })
    }
  }
