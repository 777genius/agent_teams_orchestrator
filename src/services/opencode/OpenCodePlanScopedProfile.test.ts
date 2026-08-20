import { describe, expect, test } from 'bun:test'

import {
  authorizeOpenCodeLaunchScopedProfile,
  prepareAuthorizedOpenCodeLaunchScopedProfile,
  type OpenCodeExpectedScopedProfilePlan,
  type OpenCodePlanScopedProfileManagerPort,
} from './OpenCodePlanScopedProfile.js'
import type { OpenCodeScopedPreparedProfile, OpenCodeScopedProfilePlan } from './types.js'

const hex = (character: string) => character.repeat(64)
const key = (kind: string, character: string) =>
  `opencode-operation-policy-v2:${kind}:${hex(character)}`

const input: OpenCodeScopedProfilePlan = {
  purpose: 'launch', providerId: 'openrouter', modelId: 'openrouter/model',
  runtimeInstanceId: '018f47a2-4a13-7c2f-8d44-c0ffee123456', projectPath: '/fake/project',
}

function plan(overrides: Partial<OpenCodeExpectedScopedProfilePlan> = {}): OpenCodeExpectedScopedProfilePlan {
  return {
    scopeSchema: 'opencode-scoped-profile-plan-v1', purpose: 'launch', providerId: 'openrouter',
    modelId: 'openrouter/model', runtimeInstanceId: input.runtimeInstanceId,
    operationKey: key('operation', 'a'), profileKey: key('profile', 'b'),
    pluginKey: key('plugin', 'c'), cacheKey: key('cache', 'd'),
    profileScopeIdentity: hex('e'), selectedAuthBaselineFingerprint: hex('f'),
    binaryFingerprint: hex('1'), planDigest: hex('2'), ...overrides,
  }
}

function prepared(expected: OpenCodeExpectedScopedProfilePlan): OpenCodeScopedPreparedProfile {
  return {
    scopeSchema: 'opencode-scoped-profile-v1', purpose: expected.purpose,
    providerId: expected.providerId, modelId: expected.modelId,
    runtimeInstanceId: expected.runtimeInstanceId, operationKey: expected.operationKey,
    profileKey: expected.profileKey, pluginKey: expected.pluginKey, cacheKey: expected.cacheKey,
    profileScopeIdentity: expected.profileScopeIdentity,
    selectedAuthBaselineFingerprint: expected.selectedAuthBaselineFingerprint,
    binaryFingerprint: expected.binaryFingerprint,
  } as OpenCodeScopedPreparedProfile
}

describe('OpenCode PlanScopedProfile production contract', () => {
  test('missing planning or two-argument preparation capability fails before either call', async () => {
    let calls = 0
    const missingPlan: OpenCodePlanScopedProfileManagerPort = {
      prepareScopedProfile: async () => { calls += 1; throw new Error('must not run') },
    }
    await expect(authorizeOpenCodeLaunchScopedProfile(missingPlan, input))
      .rejects.toThrow('contract is unavailable')
    const missingPrepare: OpenCodePlanScopedProfileManagerPort = {
      planScopedProfile: async () => { calls += 1; return plan() },
    }
    await expect(authorizeOpenCodeLaunchScopedProfile(missingPrepare, input))
      .rejects.toThrow('contract is unavailable')
    expect(calls).toBe(0)
  })

  test('malformed or mismatched plan fails before preparation', async () => {
    let prepares = 0
    for (const returned of [{}, plan({ providerId: 'other' }), plan({ planDigest: 'not-a-digest' })]) {
      const manager: OpenCodePlanScopedProfileManagerPort = {
        planScopedProfile: async () => returned,
        prepareScopedProfile: async () => { prepares += 1; return prepared(plan()) },
      }
      await expect(authorizeOpenCodeLaunchScopedProfile(manager, input)).rejects.toThrow(/malformed|mismatched/)
    }
    expect(prepares).toBe(0)
  })

  test('valid plan is passed unchanged and prepared drift fails before downstream effects', async () => {
    const expected = plan()
    let received: OpenCodeExpectedScopedProfilePlan | undefined
    const manager: OpenCodePlanScopedProfileManagerPort = {
      planScopedProfile: async () => expected,
      prepareScopedProfile: async (_value, planned) => {
        received = planned
        return prepared({ ...planned, profileKey: key('profile', '9') })
      },
    }
    const authorization = await authorizeOpenCodeLaunchScopedProfile(manager, input)
    await expect(prepareAuthorizedOpenCodeLaunchScopedProfile(manager, authorization))
      .rejects.toThrow('drifted')
    expect(received).toEqual(expected)
  })

  test('valid plan flows and every returned identity contributes to the effective digest', async () => {
    const expected = plan()
    const manager: OpenCodePlanScopedProfileManagerPort = {
      planScopedProfile: async () => expected,
      prepareScopedProfile: async (_value, planned) => prepared(planned),
    }
    const authorization = await authorizeOpenCodeLaunchScopedProfile(manager, input)
    await expect(prepareAuthorizedOpenCodeLaunchScopedProfile(manager, authorization))
      .resolves.toEqual(prepared(expected))
    const changedManager: OpenCodePlanScopedProfileManagerPort = {
      ...manager, planScopedProfile: async () => plan({ planDigest: hex('3') }),
    }
    const changed = await authorizeOpenCodeLaunchScopedProfile(changedManager, input)
    expect(changed.effectivePlanDigest).not.toBe(authorization.effectivePlanDigest)
    expect(authorization.effectivePlanDigest).toMatch(/^[a-f0-9]{64}$/)
  })
})
