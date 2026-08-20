import type {
  OpenCodeScopedPreparedProfile,
  OpenCodeScopedProfilePlanContract,
} from './types.js'

export type OpenCodeProviderCatalogProductionPlan = {
  purpose: 'provider-catalog'
  providerId: string
  runtimeInstanceId: string
  projectPath?: string | null
  abortSignal?: AbortSignal
}

export type OpenCodeProviderCatalogProductionProfileManager = {
  planScopedProfile(input: OpenCodeProviderCatalogProductionPlan): OpenCodeScopedProfilePlanContract
  prepareScopedProfile(
    input: OpenCodeProviderCatalogProductionPlan,
    expectedPlan: OpenCodeScopedProfilePlanContract,
  ): Promise<OpenCodeScopedPreparedProfile>
}

/** Exact production catalog wiring: authorization plan and mutation share one contract snapshot. */
export function prepareOpenCodeProviderCatalogProductionProfile(
  manager: OpenCodeProviderCatalogProductionProfileManager,
  input: OpenCodeProviderCatalogProductionPlan,
): Promise<OpenCodeScopedPreparedProfile> {
  const expectedPlan = manager.planScopedProfile(input)
  return manager.prepareScopedProfile(input, expectedPlan)
}
