import { spawnSync } from 'node:child_process'

const files = [
  'scripts/opencode-authority-conformance.test.ts',
  'src/services/opencode/OpenCodeLaunchProviderContract.test.ts',
  'src/services/opencode/OpenCodeEffectiveAgentPolicyContract.test.ts',
  'src/services/opencode/OpenCodeSelectedProfileAuthority.test.ts',
  'src/services/opencode/OpenCodeSelectedAuthorityAdoption.test.ts',
  'src/services/opencode/OpenCodeProvisioningProbe.test.ts',
  'src/services/opencode/OpenCodeSelectedSessionAuthority.test.ts',
  'src/services/opencode/OpenCodeBridgeCommandHandler.test.ts',
  'src/services/opencode/OpenCodeStopRecovery.test.ts',
  'src/services/opencode/OpenCodeStopRecoveryBridge.test.ts',
  'src/services/opencode/OpenCodeStrictLaunchCoordinator.test.ts',
  'src/services/opencode/OpenCodeHostManager.test.ts',
  'src/services/opencode/OpenCodeOwnedEndpointConcurrency.test.ts',
  'src/services/opencode/OpenCodeMcpManager.test.ts',
  'src/services/opencode/OpenCodeProcessAttributionStore.test.ts',
  'src/services/opencode/OpenCodeCursorAgentAtomicReap.test.ts',
  'src/services/opencode/OpenCodeCursorAgentTreeKill.test.ts',
  'src/services/opencode/compatibility/OpenCodeVersionProbe.helperBudget.test.ts',
  'src/services/opencode/compatibility/OpenCodeVersionProbe.foreignGeneration.test.ts',
  'src/utils/windowsNativeProcess.test.ts',
  'src/services/opencode/OpenCodeHostOperation.test.ts',
  'src/services/opencode/OpenCodeCursorResourceExhaustedPatch.test.ts',
  'src/services/opencode/OpenCodeRuntimeDeadline.test.ts',
  'src/services/opencode/OpenCodeProfileManager.test.ts',
  'src/services/opencode/OpenCodeOptionalCursorProfile.test.ts',
  'src/services/opencode/OpenCodeSessionBridge.test.ts',
  'src/services/opencode/OpenCodeExpectedBehaviorFingerprint.test.ts',
  'src/services/opencode/OpenCodeExecutionProof.test.ts',
  'src/services/opencode/OpenCodeCuratedSubscriptionCatalog.test.ts',
  'src/services/opencode/OpenCodeExecutionProbe.test.ts',
  'src/services/opencode/OpenCodeRetainedFingerprintDomain.test.ts',
  'src/services/opencode/OpenCodeNativeCliPublication.test.ts',
  'src/services/opencode/OpenCodeOAuthRefreshCoordinator.test.ts',
  'src/services/opencode/OpenCodeOwnedOAuthRefresh.test.ts',
  'src/services/opencode/OpenCodePendingOAuthSession.test.ts',
  'src/services/opencode/OpenCodeProfileScopeRace.test.ts',
  'src/services/opencode/OpenCodeScopedOAuthDurability.test.ts',
  'src/services/opencode/OpenCodeOAuthPublicationFailure.test.ts',
  'src/services/opencode/OpenCodeOAuthRestartRecovery.test.ts',
  'src/services/opencode/recovery-contract',
  'src/services/opencode/OpenCodeCheckpointCritique.test.ts',
  'src/services/opencode/OpenCodeCheckpointLifetime.test.ts',
  'src/services/opencode/OpenCodeSessionStore.test.ts',
  'src/services/opencode/OpenCodeAuthorityStoreRead.test.ts',
  'src/services/opencode/OpenCodeAuthorityStorePreservation.test.ts',
  'src/services/opencode/OpenCodeAuthorityStoreBridge.test.ts',
  'src/services/opencode/host/OpenCodeV2LinuxLauncherQualification.test.ts',
  'src/services/opencode/execution/OpenCodeV2RefusalReason.test.ts',
]

const isRecovery = (file: string) => file.endsWith('/OpenCodeOAuthRestartRecovery.test.ts')
const groups = [files.filter(file => !isRecovery(file)), files.filter(isRecovery)]

export function runOpenCodeAuthorityTests(
  args: string[],
  spawn: typeof spawnSync = spawnSync,
): number {
  for (const group of groups) {
    const result = spawn(process.execPath, ['test', ...group, ...args], { stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.signal || result.status === null) return 1
    if (result.status !== 0) return result.status
  }
  return 0
}

if (import.meta.main) process.exitCode = runOpenCodeAuthorityTests(process.argv.slice(2))
