import type {
  OpenCodeCurrentScopedProfilePlan,
  OpenCodeScopedPreparedProfile,
  OpenCodeScopedProfilePlan,
  OpenCodeScopedProfilePlanContract,
} from './types.js'

export type OpenCodeProviderCatalogProductionPlan = OpenCodeScopedProfilePlan & {
  purpose: 'provider-catalog'
}

export type OpenCodeProviderCatalogProductionProfileManager = {
  captureCurrentScopedProfilePlan(
    input: OpenCodeProviderCatalogProductionPlan,
  ): Promise<OpenCodeCurrentScopedProfilePlan>
  planScopedProfile(input: OpenCodeCurrentScopedProfilePlan): OpenCodeScopedProfilePlanContract
  prepareScopedProfile(
    input: OpenCodeCurrentScopedProfilePlan & { abortSignal?: AbortSignal },
    expectedPlan: OpenCodeScopedProfilePlanContract,
  ): Promise<OpenCodeScopedPreparedProfile>
}

/** Exact production catalog wiring: authorization plan and mutation share one contract snapshot. */
export async function prepareOpenCodeProviderCatalogProductionProfile(
  manager: OpenCodeProviderCatalogProductionProfileManager,
  input: OpenCodeProviderCatalogProductionPlan,
): Promise<OpenCodeScopedPreparedProfile> {
  const current = await manager.captureCurrentScopedProfilePlan(input)
  const expectedPlan = manager.planScopedProfile(current)
  return manager.prepareScopedProfile({ ...current, abortSignal: input.abortSignal }, expectedPlan)
}
