import { createHash } from 'node:crypto'

import type { OpenCodeScopedPreparedProfile, OpenCodeScopedProfilePlan } from './types.js'

const SHA256 = /^(?:sha256:)?[a-f0-9]{64}$/
const KEY = /^opencode-[a-z0-9-]+:[a-z-]+:[a-f0-9]{64}$/

/**
 * Cross-slice S1/S3 hand-off. S3 never derives these values: it accepts the
 * immutable plan authored by ProfileManager and binds the whole plan into its
 * durable command identity.
 */
export type OpenCodeExpectedScopedProfilePlan = {
  scopeSchema: 'opencode-scoped-profile-plan-v1'
  purpose: 'launch'
  providerId: string
  modelId: string
  runtimeInstanceId: string
  operationKey: string
  profileKey: string
  pluginKey: string
  cacheKey: string
  profileScopeIdentity: string
  selectedAuthBaselineFingerprint: string
  binaryFingerprint: string
  planDigest: string
}

export type OpenCodePlanScopedProfileManagerPort = {
  planScopedProfile?: (input: OpenCodeScopedProfilePlan) => Promise<unknown>
  prepareScopedProfile?: (
    input: OpenCodeScopedProfilePlan,
    expectedPlan: OpenCodeExpectedScopedProfilePlan,
  ) => Promise<OpenCodeScopedPreparedProfile>
}

export type OpenCodeAuthorizedScopedProfilePlan = {
  input: OpenCodeScopedProfilePlan
  expected: OpenCodeExpectedScopedProfilePlan
  effectivePlanDigest: string
}

function stringField(value: Record<string, unknown>, field: string): string {
  const found = value[field]
  if (typeof found !== 'string' || !found) {
    throw new Error(`OpenCode planScopedProfile returned malformed ${field}`)
  }
  return found
}

function decodePlan(value: unknown, input: OpenCodeScopedProfilePlan): OpenCodeExpectedScopedProfilePlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OpenCode planScopedProfile returned a malformed plan')
  }
  const source = value as Record<string, unknown>
  const expected: OpenCodeExpectedScopedProfilePlan = {
    scopeSchema: stringField(source, 'scopeSchema') as OpenCodeExpectedScopedProfilePlan['scopeSchema'],
    purpose: stringField(source, 'purpose') as 'launch',
    providerId: stringField(source, 'providerId'),
    modelId: stringField(source, 'modelId'),
    runtimeInstanceId: stringField(source, 'runtimeInstanceId'),
    operationKey: stringField(source, 'operationKey'),
    profileKey: stringField(source, 'profileKey'),
    pluginKey: stringField(source, 'pluginKey'),
    cacheKey: stringField(source, 'cacheKey'),
    profileScopeIdentity: stringField(source, 'profileScopeIdentity'),
    selectedAuthBaselineFingerprint: stringField(source, 'selectedAuthBaselineFingerprint'),
    binaryFingerprint: stringField(source, 'binaryFingerprint'),
    planDigest: stringField(source, 'planDigest'),
  }
  if (expected.scopeSchema !== 'opencode-scoped-profile-plan-v1'
    || expected.purpose !== 'launch'
    || expected.providerId !== input.providerId
    || expected.modelId !== input.modelId
    || expected.runtimeInstanceId !== input.runtimeInstanceId
    || ![expected.operationKey, expected.profileKey, expected.pluginKey, expected.cacheKey]
      .every(key => KEY.test(key))
    || !SHA256.test(expected.profileScopeIdentity)
    || !SHA256.test(expected.selectedAuthBaselineFingerprint)
    || !SHA256.test(expected.binaryFingerprint)
    || !SHA256.test(expected.planDigest)) {
    throw new Error('OpenCode planScopedProfile returned a mismatched or malformed launch plan')
  }
  return expected
}

export async function authorizeOpenCodeLaunchScopedProfile(
  manager: OpenCodePlanScopedProfileManagerPort,
  input: OpenCodeScopedProfilePlan,
): Promise<OpenCodeAuthorizedScopedProfilePlan> {
  // Check the complete capability before calling either method. In particular,
  // never fall through to the one-argument compatibility preparation API.
  if (typeof manager.planScopedProfile !== 'function'
    || typeof manager.prepareScopedProfile !== 'function') {
    throw new Error('OpenCode PlanScopedProfile contract is unavailable')
  }
  const expected = decodePlan(await manager.planScopedProfile(input), input)
  const effectivePlanDigest = createHash('sha256').update(JSON.stringify({
    scopeSchema: expected.scopeSchema,
    purpose: expected.purpose,
    providerId: expected.providerId,
    modelId: expected.modelId,
    runtimeInstanceId: expected.runtimeInstanceId,
    operationKey: expected.operationKey,
    profileKey: expected.profileKey,
    pluginKey: expected.pluginKey,
    cacheKey: expected.cacheKey,
    profileScopeIdentity: expected.profileScopeIdentity,
    selectedAuthBaselineFingerprint: expected.selectedAuthBaselineFingerprint,
    binaryFingerprint: expected.binaryFingerprint,
    planDigest: expected.planDigest,
  })).digest('hex')
  return { input, expected, effectivePlanDigest }
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
    || prepared.runtimeInstanceId !== expected.runtimeInstanceId
    || prepared.operationKey !== expected.operationKey
    || prepared.profileKey !== expected.profileKey
    || prepared.pluginKey !== expected.pluginKey
    || prepared.cacheKey !== expected.cacheKey
    || prepared.profileScopeIdentity !== expected.profileScopeIdentity
    || prepared.selectedAuthBaselineFingerprint !== expected.selectedAuthBaselineFingerprint
    || prepared.binaryFingerprint !== expected.binaryFingerprint) {
    throw new Error('OpenCode prepared scoped profile drifted from its authorized plan')
  }
  return prepared
}
