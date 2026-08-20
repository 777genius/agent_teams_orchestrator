import {
  OpenCodePassiveStatusProductionReader,
  OPEN_CODE_PASSIVE_STATUS_DEFAULT_TIMEOUT_MS,
} from '../opencode/OpenCodePassiveStatusProductionReader.js'
import type { RuntimeExtensionCapabilities, RuntimeProviderStatus } from './types.js'
import { OPEN_CODE_PASSIVE_DIRECTORY_PROVIDER_IDS } from '../opencode/OpenCodePassiveProviderDirectory.js'
import {
  readOpenCodePassiveStatusWithinRouteDeadline,
  type OpenCodePassiveRouteDeadlineDeps,
  type OpenCodePassiveRouteRead,
} from '../opencode/OpenCodePassiveRouteDeadline.js'

export type OpenCodePassiveRuntimeStatusDeps = OpenCodePassiveRouteDeadlineDeps & {
  getOpenCodePassiveStatus?: OpenCodePassiveRouteRead
  openCodePassiveStatusTimeoutMs?: number
  openCodeProjectPath?: string
}

export const OPEN_CODE_PASSIVE_SUMMARY_PROVIDER_IDS = OPEN_CODE_PASSIVE_DIRECTORY_PROVIDER_IDS

/** Registry dispatcher seam: summary status cannot reach active inventory composition. */
export async function dispatchOpenCodeRuntimeStatus<T>(
  detailLevel: 'summary' | 'full' | undefined,
  deps: { readPassive(): Promise<T>; readActive(): Promise<T> },
): Promise<T> {
  return detailLevel === 'summary' ? deps.readPassive() : deps.readActive()
}

let defaultReader: OpenCodePassiveStatusProductionReader | null = null

export async function buildOpenCodePassiveRuntimeStatus(
  deps: OpenCodePassiveRuntimeStatusDeps = {},
): Promise<RuntimeProviderStatus> {
  const read = deps.getOpenCodePassiveStatus ?? (input => {
    defaultReader ??= new OpenCodePassiveStatusProductionReader()
    return defaultReader.reader.read(input)
  })
  const passive = await readOpenCodePassiveStatusWithinRouteDeadline(read, {
    projectPath: deps.openCodeProjectPath ?? process.cwd(),
    providerIds: OPEN_CODE_PASSIVE_SUMMARY_PROVIDER_IDS,
    timeoutMs: deps.openCodePassiveStatusTimeoutMs ?? OPEN_CODE_PASSIVE_STATUS_DEFAULT_TIMEOUT_MS,
  }, deps)
  const binaryPresent = passive.binary.value.presence === 'present'
  const binaryAbsent = passive.binary.value.presence === 'absent'
  const degraded = passive.binary.condition === 'degraded'
    || passive.providers.some(provider => [
      provider.configured,
      provider.lastConnected,
      provider.catalogAvailable,
      provider.executionVerified,
    ].some(observation => observation.condition === 'degraded'))
  const lastConnected = passive.providers.filter(provider => provider.lastConnected.value.state === 'connected').length
  const configured = passive.providers.filter(provider => provider.configured.value === 'configured').length
  const catalogAvailable = passive.providers.filter(provider => provider.catalogAvailable.value === 'available').length
  const executionVerified = passive.providers.filter(provider => provider.executionVerified.value === 'verified').length
  const statusMessage = binaryPresent
    ? degraded ? 'OpenCode passive status is degraded' : 'OpenCode detected (passive)'
    : binaryAbsent
      ? 'OpenCode CLI not found (passive)'
      : 'OpenCode passive status unavailable'

  return {
    providerId: 'opencode',
    displayName: 'OpenCode (75+ LLM providers)',
    supported: binaryPresent,
    authenticated: false,
    authMethod: null,
    verificationState: binaryAbsent ? 'offline' : 'unknown',
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: false,
      oneShot: false,
      extensions: passiveExtensions(),
    },
    statusMessage,
    detailMessage: [
      `configured=${configured}`,
      `last_connected=${lastConnected}`,
      `catalog_available=${catalogAvailable}`,
      `execution_verified=${executionVerified}`,
      `authorization=${passive.authorization}`,
      `launch_readiness=${passive.launchReadiness}`,
    ].join('; '),
    selectedBackendId: null,
    resolvedBackendId: null,
    availableBackends: [],
    externalRuntimeDiagnostics: [{
      id: 'cli-bin', label: 'OpenCode CLI', detected: binaryPresent,
      statusMessage, detailMessage: passive.binary.value.version,
    }],
    models: [],
    runtimeCapabilities: { modelCatalog: { dynamic: true, source: 'app-server' } },
    backend: binaryPresent ? { kind: 'opencode-cli', label: 'OpenCode CLI', authMethodDetail: null } : null,
    passiveStatus: passive,
  }
}

function passiveExtensions(): RuntimeExtensionCapabilities {
  return {
    plugins: { status: 'read-only', ownership: 'provider-scoped', reason: 'Passive status does not enumerate or manage OpenCode plugins.' },
    mcp: { status: 'read-only', ownership: 'provider-scoped', reason: 'Passive status does not inspect or start OpenCode MCP services.' },
    skills: { status: 'read-only', ownership: 'provider-scoped', reason: 'Passive status does not enumerate OpenCode skills.' },
    apiKeys: { status: 'read-only', ownership: 'provider-scoped', reason: 'Passive status reads redacted auth metadata only.' },
  }
}
