import type { OpenCodeOAuthNativeProbeOwner } from './OpenCodeAuthStore.js'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { buildExpectedOpenCodeAgentPolicies, assertOpenCodeEffectiveAgentPolicies } from './OpenCodeEffectiveAgentPolicyContract.js'
import { buildOpenCodeLaunchProviderContract } from './OpenCodeLaunchProviderContract.js'
import { raceOpenCodeAbortSignal } from './OpenCodeRuntimeDeadline.js'
import { openCodeClientFactory } from './OpenCodeClientFactory.js'
import { OPEN_CODE_APP_MCP_SERVER_NAME, openCodeMcpManager } from './OpenCodeMcpManager.js'
import { parseOpenCodeProviderScopedModelRef } from './OpenCodeModelRef.js'
import { buildManagedConfigFingerprint, collectProjectBehaviorMetadata, resolveOpenCodeProfileScope, openCodeProfileManager, PROJECT_BEHAVIOR_FILES, PROJECT_BEHAVIOR_DIRS } from './OpenCodeProfileManager.js'
import {
  buildOpenCodeExpectedBehaviorEvidence,
  validateOpenCodeExpectedBehaviorEvidence,
} from './OpenCodeExpectedBehaviorFingerprint.js'

import type { OpenCodePhaseContext } from './OpenCodeRuntimeDeadline.js'
import type { OpenCodeExpectedBehaviorEvidence, OpenCodeHostHandle, OpenCodeSessionRecord } from './types.js'

type OpenCodeSelectedProfileAuthorityDeps = {
  clientFactory?: Pick<typeof openCodeClientFactory, 'create'>
  mcpManager?: Pick<typeof openCodeMcpManager, 'ensureAppMcp'>
  collectBehavior?: typeof collectProjectBehaviorMetadata
  resolveScope?: typeof resolveOpenCodeProfileScope
  buildEvidence?: typeof buildOpenCodeExpectedBehaviorEvidence
}

export type OpenCodeAuthorityRejection =
  | { check: 'selected_model' | 'profile_scope' | 'mcp_name' | 'mcp_connected'
      | 'live_mcp_present' | 'mcp_config_match' | 'contract_config_match'
      | 'scope_token_match' | 'scope_config_match'
      | 'selected_auth_identity_match' }
  | { check: 'behavior_match'; fields?: readonly OpenCodeBehaviorDifferenceField[]; comparison?: {
      initialEvidenceMatchesExpectation: boolean
      projectBehaviorChanged: boolean
      effectiveSelectedAuthChanged: boolean | null
      otherEvidenceChanged: boolean | null
      sourcesAvailable: boolean
      changedSourceCount: number
      sources: { label: string; initial: 'present' | 'missing'; refreshed: 'present' | 'missing' }[]
    } }

  | { check: 'selected_config_match'; fields: OpenCodeSelectedConfigField[] }
  | { check: 'exception'; phase: OpenCodeAuthorityRefreshPhase
      errorClass: 'TypeError' | 'RangeError' | 'SyntaxError' | 'Error' | 'non_error' }

type OpenCodeAuthorityRefreshPhase = 'initial' | 'live_config' | 'app_mcp'
  | 'project_behavior' | 'profile_scope' | 'effective_agents' | 'authority_checks' | 'behavior_evidence'

const SELECTED_CONFIG_FIELDS = ['provider', 'model', 'small_model', 'plugin', 'agent',
  'default_agent', 'permission', 'command', 'share', 'snapshot', 'autoupdate', 'mcp'] as const
type OpenCodeSelectedConfigField = typeof SELECTED_CONFIG_FIELDS[number]
const BEHAVIOR_DIFFERENCE_FIELDS = ['canonicalProjectPathFingerprint', 'modelProviderId', 'fullModelId',
  'projectBehaviorFingerprint', 'effectiveConfigFingerprint', 'effectiveSelectedAuthFingerprint'] as const
type OpenCodeBehaviorDifferenceField = typeof BEHAVIOR_DIFFERENCE_FIELDS[number]

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

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function rawEntries(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rawEntries)
  return object(value) ? Object.entries(value).map(([key, item]) => [key, rawEntries(item)]) : value
}

function hasFileReference(value: unknown): boolean {
  return /\{file:[^}]*\}/.test(JSON.stringify(value))
}

export async function refreshSelectedProfileAuthority(input: {
    host: OpenCodeHostHandle
    selectedModel: string
    expectedBehaviorFingerprint: string
    initialExpectedBehaviorEvidence?: OpenCodeExpectedBehaviorEvidence
    contractConfigIdentity?: string | null
    // Only the successful post-execution readiness check may compare an owned
    // committed rotation. The retained profile is never resealed or reusable.
    completedOAuthProbe?: OpenCodeOAuthNativeProbeOwner
    // Existing-session admission additionally requires committed native lineage,
    // the captured session cohort and this exact live host. It issues no launch proof.
    ownedOAuthSession?: OpenCodeSessionRecord
    phaseContext?: OpenCodePhaseContext
    onRejection?: (diagnostic: OpenCodeAuthorityRejection) => void
  }, deps: OpenCodeSelectedProfileAuthorityDeps = {}): Promise<OpenCodeHostHandle['profile'] | null> {
    const reject = (diagnostic: OpenCodeAuthorityRejection): null => {
      // Observability must not change the fail-closed profile|null contract.
      try { input.onRejection?.(diagnostic) } catch {}
      return null
    }
    const selected = parseOpenCodeProviderScopedModelRef(input.selectedModel)
    const sourceProfile = input.host.profile
    let profile = sourceProfile
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
      const mcp = config.mcp as Record<string, unknown> | undefined
      return {
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
      try { return await raceOpenCodeAbortSignal(operation(), input.phaseContext?.signal) }
      catch (error) { throw new OpenCodeAuthorityReadError(readPhase, error) }
    }
    try {
      input.phaseContext?.throwIfExpired()
      profile = structuredClone(sourceProfile)
      const original = rawEntries(profile)
      const expectedFingerprint = input.expectedBehaviorFingerprint
      const initialEvidence = input.initialExpectedBehaviorEvidence ? structuredClone(input.initialExpectedBehaviorEvidence) : undefined
      const contractIdentity = input.contractConfigIdentity
      const completedProbe = input.completedOAuthProbe ? { ...input.completedOAuthProbe } : undefined
      const ownedSession = input.ownedOAuthSession ? structuredClone(input.ownedOAuthSession) : undefined
      const selectedModel = input.selectedModel
      const baseUrl = input.host.baseUrl
      const hostIdentity = () => [input.host.hostKey, input.host.profileRootKey,
        input.host.projectPath, input.host.pid, input.host.processStartedAtMs]
      const originalHostIdentity = hostIdentity()
      if (buildManagedConfigFingerprint(profile.managedConfig, profile.env) !== profile.managedConfigFingerprint) {
        return reject({ check: 'selected_config_match', fields: [] })
      }
      const expected = JSON.parse(JSON.stringify(profile.managedConfig)
        .replace(/\{env:([^}]+)\}/g, (_match, name: string) => profile.env[name] || '')) as Record<string, unknown>
      const expectedProvider = buildOpenCodeLaunchProviderContract(expected, selected.providerId)
      const expectedSelected = selectedConfig(expected)
      const expectedPolicies = buildExpectedOpenCodeAgentPolicies(expected, profile.env.XDG_DATA_HOME)
      if (hasFileReference(expectedProvider) || hasFileReference(expectedSelected)) {
        return reject({ check: 'selected_config_match', fields: ['provider'] })
      }
      const requestContext = input.phaseContext
        ? { signal: input.phaseContext.signal, remainingMs: input.phaseContext.remainingMs }
        : undefined
      const client = (deps.clientFactory ?? openCodeClientFactory).create(
        baseUrl,
        requestContext,
        input.host,
      )
      const [liveConfig, liveAgents, appMcp, behavior, scope] = await Promise.all([
        read('live_config', () => client.getConfig()),
        read('effective_agents', () => client.listAgents()),
        read('app_mcp', () => (deps.mcpManager ?? openCodeMcpManager).ensureAppMcp({
          baseUrl, requestOwner: input.host, attachIfMissing: false,
          requestContext,
        })),
        read('project_behavior', () => (deps.collectBehavior ?? collectProjectBehaviorMetadata)(profile.canonicalProjectPath, profile.env)),
        read('profile_scope', () => (deps.resolveScope ?? resolveOpenCodeProfileScope)({
          projectPath: profile.canonicalProjectPath, purpose: 'launch_runtime',
          selectedModel: selected.raw, env: profile.env, cacheSnapshot: false,
        })),
      ])
      phase = 'authority_checks'
      input.phaseContext?.throwIfExpired()
      if (!object(liveConfig)) throw new TypeError('Invalid live config')
      const live = liveConfig as Record<string, unknown>
      const liveMcp = (live.mcp as Record<string, unknown> | undefined)
        ?.[OPEN_CODE_APP_MCP_SERVER_NAME]
      const preparedMcp = (expected.mcp as Record<string, unknown> | undefined)
        ?.[OPEN_CODE_APP_MCP_SERVER_NAME]
      if (appMcp.summary.matchedServerName !== OPEN_CODE_APP_MCP_SERVER_NAME) return reject({ check: 'mcp_name' })
      if (appMcp.summary.connected !== true) return reject({ check: 'mcp_connected' })
      if (!liveMcp) return reject({ check: 'live_mcp_present' })
      if (identity(liveMcp) !== identity(preparedMcp)) return reject({ check: 'mcp_config_match' })
      if (contractIdentity && identity(liveMcp) !== contractIdentity) return reject({ check: 'contract_config_match' })
      const liveSelected = selectedConfig(live)
      const changed: OpenCodeSelectedConfigField[] = []
      try {
        if (!isDeepStrictEqual(expectedProvider, buildOpenCodeLaunchProviderContract(live, selected.providerId))) changed.push('provider')
      } catch { changed.push('provider') }
      for (const field of SELECTED_CONFIG_FIELDS) {
        if (field === 'provider') continue
        if (!isDeepStrictEqual(liveSelected[field], expectedSelected[field])
          || buildManagedConfigFingerprint({ [field]: liveSelected[field] }, profile.env)
            !== buildManagedConfigFingerprint({ [field]: expectedSelected[field] }, profile.env)) changed.push(field)
      }
      try { assertOpenCodeEffectiveAgentPolicies(expectedPolicies, liveAgents) }
      catch { if (!changed.includes('agent')) changed.push('agent') }
      if (changed.length) return reject({ check: 'selected_config_match', fields: changed })
      const readRotation = () => completedProbe
        ? read('profile_scope', () => openCodeProfileManager.readCompletedReadinessOAuthRotation(
          { ...input.host, profile }, selected.raw, scope, completedProbe))
        : ownedSession
          ? read('profile_scope', () => openCodeProfileManager.readCompletedSessionOAuthRotation(ownedSession!, profile.env))
          : Promise.resolve(null)
      const rotation = scope.scopeToken !== profile.profileScope.scopeToken && (completedProbe || ownedSession)
        && selected.providerId === 'xai' ? await readRotation() : null
      if (rotation && ownedSession && 'nativeSession' in rotation) {
        const native = rotation.nativeSession
        if (input.host.hostKey !== native.record.hostKey || input.host.baseUrl !== native.baseUrl
          || input.host.pid !== native.pid || input.host.processStartedAtMs !== native.processStartedAtMs
          || input.host.profileRootKey !== native.record.profileRootKey
          || ownedSession.expectedBehaviorFingerprint !== expectedFingerprint) {
          return reject({ check: 'scope_token_match' })
        }
      }
      if (scope.scopeToken !== profile.profileScope.scopeToken && !rotation) return reject({ check: 'scope_token_match' })
      if (scope.configFingerprint !== profile.profileScope.configFingerprint) return reject({ check: 'scope_config_match' })
      if (scope.selectedAuthIdentity !== profile.profileScope.selectedAuthIdentity && !rotation) return reject({ check: 'selected_auth_identity_match' })
      const refreshed = { ...profile, projectBehaviorFingerprint: behavior.projectBehaviorFingerprint,
        behaviorSourceFingerprints: behavior.behaviorSourceFingerprints }
      phase = 'behavior_evidence'
      const evidence = await raceOpenCodeAbortSignal((deps.buildEvidence ?? buildOpenCodeExpectedBehaviorEvidence)({
        profile: refreshed, fullModelId: selected.raw,
        effectiveConfigFingerprint: profile.managedConfigFingerprint,
        // Verify the original full behavior expectation using only the proven
        // predecessor. Execution proof construction still reads native C1 and
        // keeps OAuth proofs non-reusable; no host/scope identity is replaced.
        ...(rotation ? { readCredential: async () => rotation.predecessor } : {}),
      }), input.phaseContext?.signal)
      if (rotation && !isDeepStrictEqual(await readRotation(), rotation)) return reject({ check: 'selected_auth_identity_match' })
      input.phaseContext?.throwIfExpired()
      if (input.selectedModel !== selectedModel || input.host.baseUrl !== baseUrl
        || input.host.profile !== sourceProfile || !isDeepStrictEqual(rawEntries(sourceProfile), original)
        || !isDeepStrictEqual(hostIdentity(), originalHostIdentity)
        || !isDeepStrictEqual(input.ownedOAuthSession, ownedSession)
        || input.expectedBehaviorFingerprint !== expectedFingerprint || input.contractConfigIdentity !== contractIdentity) {
        return reject({ check: 'selected_config_match', fields: [] })
      }
      if (evidence.expectedBehaviorFingerprint === expectedFingerprint) return refreshed
      const initial = initialEvidence
      const usableInitial = initial && initial.expectedBehaviorFingerprint === expectedFingerprint
        && initial.modelProviderId === selected.providerId
        && initial.fullModelId === selected.raw
        && validateOpenCodeExpectedBehaviorEvidence(initial) ? initial : undefined
      const fields = usableInitial
        ? BEHAVIOR_DIFFERENCE_FIELDS.filter(field => usableInitial[field] !== evidence[field])
        : undefined
      // Only compare retained initial evidence with this refresh, never a third read.
      const before = profile.behaviorSourceFingerprints, after = behavior.behaviorSourceFingerprints
      const sourceNames = before && after ? [...new Set([...Object.keys(before), ...Object.keys(after)])].sort() : []
      const changedSources = sourceNames.filter(name => before?.[name] !== after?.[name])
      return reject({ check: 'behavior_match', ...(fields?.length ? { fields } : {}), comparison: {
        initialEvidenceMatchesExpectation: initialEvidence?.expectedBehaviorFingerprint === expectedFingerprint,
        projectBehaviorChanged: (initialEvidence?.projectBehaviorFingerprint ?? profile.projectBehaviorFingerprint) !== evidence.projectBehaviorFingerprint,
        effectiveSelectedAuthChanged: initialEvidence
          ? initialEvidence.effectiveSelectedAuthFingerprint !== evidence.effectiveSelectedAuthFingerprint : null,
        otherEvidenceChanged: initialEvidence ? (['canonicalProjectPathFingerprint', 'modelProviderId', 'fullModelId',
          'effectiveConfigFingerprint'] as const).some(key => initialEvidence[key] !== evidence[key]) : null,
        sourcesAvailable: Boolean(before && after), changedSourceCount: changedSources.length,
        sources: changedSources.slice(0, 20).map(name => {
          const normalized = name.replace(/\\/g, '/')
          const fixed = PROJECT_BEHAVIOR_FILES.some(file => file === normalized)
          return { label: fixed ? normalized : PROJECT_BEHAVIOR_DIRS.find(dir => normalized.startsWith(`${dir}/`)) ?? 'other',
            initial: before?.[name] === undefined ? 'missing' : 'present',
            refreshed: after?.[name] === undefined ? 'missing' : 'present' }
        }),
      } })

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
