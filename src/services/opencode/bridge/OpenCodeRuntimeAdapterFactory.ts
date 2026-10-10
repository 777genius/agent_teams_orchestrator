import { inspectOpenCodeReadSelection } from '../compatibility/OpenCodeNativeIdentity.js'
import type { OpenCodeReadGeneration } from '../compatibility/OpenCodeGenerationPolicy.js'
import type { OpenCodeSessionBridge } from '../OpenCodeSessionBridge.js'

/** Indexed ports preserve the V1 semantic contract without exposing its native client. */
export type OpenCodeSessionSemanticPorts = {
  ensureSession: OpenCodeSessionBridge['ensureSession']
  materializeSessionOnHost: OpenCodeSessionBridge['materializeSessionOnHost']
  injectAppManagedBootstrapContext: OpenCodeSessionBridge['injectAppManagedBootstrapContext']
  ensureSessionAppMcpReady: OpenCodeSessionBridge['ensureSessionAppMcpReady']
  promptAsync: OpenCodeSessionBridge['promptAsync']
  promptAsyncUntilAccepted: OpenCodeSessionBridge['promptAsyncUntilAccepted']
  promptAsyncWithTurnSettled: OpenCodeSessionBridge['promptAsyncWithTurnSettled']
  reconcileSession: OpenCodeSessionBridge['reconcileSession']
  projectLogMessages: OpenCodeSessionBridge['projectLogMessages']
  abort: OpenCodeSessionBridge['abort']
  observeStopIdle: OpenCodeSessionBridge['observeStopIdle']
  releaseSession: OpenCodeSessionBridge['releaseSession']
  restoreSessionLease: OpenCodeSessionBridge['restoreSessionLease']
  refreshSessionEnvironment: OpenCodeSessionBridge['refreshSessionEnvironment']
  answerPermission: OpenCodeSessionBridge['answerPermission']
  getRawStatus: OpenCodeSessionBridge['getRawStatus']
  withOwnedOAuthSessionObservation: OpenCodeSessionBridge['withOwnedOAuthSessionObservation']
}

/** This selector never creates a V1 profile or client while admitting V2. */
export function selectOpenCodeRuntimeAdapter<TV1, TV2>(
  generation: OpenCodeReadGeneration,
  factories: { v1: () => TV1; v2: (pin: '2.0.0' | '2.0.21') => TV2 },
): { generation: 'v1'; adapter: TV1 } | { generation: 'v2'; adapter: TV2 } | { generation: 'unsupported'; version: string | null } {
  if (generation.generation === 'v1') return { generation: 'v1', adapter: factories.v1() }
  if (generation.generation === 'v2') return { generation: 'v2', adapter: factories.v2(generation.version) }
  return generation
}

export const inspectOpenCodeRuntimeAdapterSelection = inspectOpenCodeReadSelection

export type OpenCodeV2BridgeQualification = Readonly<{
  sourceLinux: boolean
  supportedPin: boolean
  ownerCallable: boolean
  selectedProfileVerified: boolean
  persistentBootstrapVerified: boolean
  controllerMcpSchemasVerified: boolean
}>

/** Necessary evidence predicate, not a capability switch. Runtime caps remain false. */
export function openCodeV2BridgeCompositionIsConcrete(evidence: OpenCodeV2BridgeQualification): boolean {
  return Object.values(evidence).every(value => value === true)
}
export const OPENCODE_V2_TEAM_BRIDGE_CAPABILITIES = Object.freeze({
  teamLaunch: false,
  memberSession: false,
  permission: false,
})
