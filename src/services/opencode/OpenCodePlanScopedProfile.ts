import { createHash } from 'node:crypto'

import { canonicalSerializeOpenCodePolicyIdentity } from './OpenCodeOperationPolicy.js'
import type {
  OpenCodeCurrentScopedProfilePlan,
  OpenCodeScopedPreparedProfile,
  OpenCodeScopedProfilePlan,
  OpenCodeScopedProfilePlanContract,
} from './types.js'

/**
 * Cross-slice S1/S3 hand-off. S3 never derives these values: it accepts the
 * immutable plan authored by ProfileManager and binds the whole plan into its
 * durable command identity.
 */
export type OpenCodeExpectedScopedProfilePlan = OpenCodeScopedProfilePlanContract

export type OpenCodePlanScopedProfileManagerPort = {
  captureCurrentScopedProfilePlan?: (
    input: OpenCodeScopedProfilePlan,
  ) => Promise<OpenCodeCurrentScopedProfilePlan>
  planScopedProfile?: (input: OpenCodeCurrentScopedProfilePlan) => OpenCodeScopedProfilePlanContract
  prepareScopedProfile?: (
    input: OpenCodeCurrentScopedProfilePlan,
    expectedPlan: OpenCodeExpectedScopedProfilePlan,
  ) => Promise<OpenCodeScopedPreparedProfile>
}

export type OpenCodeAuthorizedScopedProfilePlan = {
  input: OpenCodeCurrentScopedProfilePlan
  expected: OpenCodeExpectedScopedProfilePlan
  effectivePlanDigest: string
}

export async function authorizeOpenCodeLaunchScopedProfile(
  manager: OpenCodePlanScopedProfileManagerPort,
  input: OpenCodeScopedProfilePlan,
): Promise<OpenCodeAuthorizedScopedProfilePlan> {
  // Check the complete capability before calling either method. In particular,
  // never fall through to the one-argument compatibility preparation API.
  if (typeof manager.captureCurrentScopedProfilePlan !== 'function'
    || typeof manager.planScopedProfile !== 'function'
    || typeof manager.prepareScopedProfile !== 'function') {
    throw new Error('OpenCode PlanScopedProfile contract is unavailable')
  }
  const current = await manager.captureCurrentScopedProfilePlan(input)
  if (current.purpose !== 'launch'
    || current.providerId !== input.providerId
    || current.modelId !== input.modelId
    || current.runtimeInstanceId !== input.runtimeInstanceId) {
    throw new Error('OpenCode current scoped planning evidence mismatched the launch attempt')
  }
  const expected = manager.planScopedProfile(current)
  const effectivePlanDigest = createHash('sha256')
    .update(canonicalSerializeOpenCodePolicyIdentity(expected)).digest('hex')
  return { input: current, expected, effectivePlanDigest }
}

export async function prepareAuthorizedOpenCodeLaunchScopedProfile(
  manager: OpenCodePlanScopedProfileManagerPort,
  authorization: OpenCodeAuthorizedScopedProfilePlan,
): Promise<OpenCodeScopedPreparedProfile> {
  if (typeof manager.prepareScopedProfile !== 'function') {
    throw new Error('OpenCode PlanScopedProfile preparation contract is unavailable')
  }
  const prepared = await manager.prepareScopedProfile(authorization.input, authorization.expected)
  const expected = authorization.expected
  if (prepared.scopeSchema !== 'opencode-scoped-profile-v1'
    || prepared.purpose !== expected.purpose
    || prepared.providerId !== expected.providerId
    || prepared.modelId !== expected.modelId
    || prepared.runtimeInstanceId !== authorization.input.runtimeInstanceId
    || prepared.scopedPlanDigest !== expected.digest
    || prepared.plannedHostKey !== expected.expectedHostKey
    || prepared.canonicalProjectPathFingerprint !== expected.canonicalProjectPathFingerprint
    || prepared.selectedAuthBaselineFingerprint !== expected.selectedAuthFingerprint
    || prepared.binaryFingerprint !== expected.binaryFingerprint) {
    throw new Error('OpenCode prepared scoped profile drifted from its authorized plan')
  }
  return prepared
}
