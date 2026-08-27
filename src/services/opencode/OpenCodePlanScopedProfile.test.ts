import { describe, expect, test } from 'bun:test'

import {
  authorizeOpenCodeLaunchScopedProfile,
  prepareAuthorizedOpenCodeLaunchScopedProfile,
  type OpenCodeExpectedScopedProfilePlan,
  type OpenCodePlanScopedProfileManagerPort,
} from './OpenCodePlanScopedProfile.js'
import { planScopedProfile } from './OpenCodeOperationPolicy.js'
import type {
  OpenCodeCurrentScopedProfilePlan,
  OpenCodeScopedPreparedProfile,
  OpenCodeScopedProfilePlan,
  OpenCodeScopedProfilePlanContract,
} from './types.js'

const hex = (character: string) => character.repeat(64)

const input: OpenCodeScopedProfilePlan = {
  purpose: 'launch', providerId: 'openrouter', modelId: 'openrouter/model',
  runtimeInstanceId: '018f47a2-4a13-7c2f-8d44-c0ffee123456', projectPath: '/fake/project',
}

function current(overrides: Partial<OpenCodeCurrentScopedProfilePlan['evidence']> = {}): OpenCodeCurrentScopedProfilePlan {
  return { ...input, providerId: input.providerId!, modelId: input.modelId!,
    projectPath: input.projectPath!, evidence: {
    canonicalProjectPathFingerprint: hex('1'), projectBehaviorFingerprint: hex('2'),
    providerEnvironmentFingerprint: hex('3'), selectedAuthFingerprint: hex('4'),
    binaryFingerprint: hex('5'), configFingerprint: hex('6'),
    nativeAccountIdentityFingerprint: hex('7'), nativeAccountIdentitySource: 'managed-auth',
    nativeTargetExecutableFingerprint: hex('8'), profileLayoutFingerprint: hex('9'),
    automaticUserPluginFingerprint: hex('a'), plugins: [], ...overrides,
  } }
}

function plan(overrides: Partial<OpenCodeScopedProfilePlanContract> = {}): OpenCodeExpectedScopedProfilePlan {
  return { ...planScopedProfile(current()), ...overrides }
}

function prepared(expected: OpenCodeExpectedScopedProfilePlan): OpenCodeScopedPreparedProfile {
  return {
    scopeSchema: 'opencode-scoped-profile-v1', purpose: expected.purpose,
    providerId: expected.providerId, modelId: expected.modelId,
    runtimeInstanceId: input.runtimeInstanceId, scopedPlanDigest: expected.digest,
    plannedHostKey: expected.expectedHostKey,
    canonicalProjectPathFingerprint: expected.canonicalProjectPathFingerprint,
    selectedAuthBaselineFingerprint: expected.selectedAuthFingerprint,
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
      captureCurrentScopedProfilePlan: async () => { calls += 1; return current() },
      planScopedProfile: () => { calls += 1; return plan() },
    }
    await expect(authorizeOpenCodeLaunchScopedProfile(missingPrepare, input))
      .rejects.toThrow('contract is unavailable')
    expect(calls).toBe(0)
  })

  test('mismatched current attempt evidence fails before planning or preparation', async () => {
    let prepares = 0
    const manager: OpenCodePlanScopedProfileManagerPort = {
      captureCurrentScopedProfilePlan: async () => ({ ...current(), runtimeInstanceId: 'other-attempt' }),
      planScopedProfile: () => { throw new Error('must not plan') },
      prepareScopedProfile: async () => { prepares += 1; return prepared(plan()) },
    }
    await expect(authorizeOpenCodeLaunchScopedProfile(manager, input)).rejects.toThrow('mismatched')
    expect(prepares).toBe(0)
  })

  test('valid plan is passed unchanged and prepared drift fails before downstream effects', async () => {
    const expected = plan()
    let received: OpenCodeExpectedScopedProfilePlan | undefined
    const manager: OpenCodePlanScopedProfileManagerPort = {
      captureCurrentScopedProfilePlan: async () => current(),
      planScopedProfile: () => expected,
      prepareScopedProfile: async (_value, planned) => {
        received = planned
        return { ...prepared(planned), binaryFingerprint: hex('b') }
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
      captureCurrentScopedProfilePlan: async () => current(),
      planScopedProfile: () => expected,
      prepareScopedProfile: async (_value, planned) => prepared(planned),
    }
    const authorization = await authorizeOpenCodeLaunchScopedProfile(manager, input)
    await expect(prepareAuthorizedOpenCodeLaunchScopedProfile(manager, authorization))
      .resolves.toEqual(prepared(expected))
    const changedManager: OpenCodePlanScopedProfileManagerPort = {
      ...manager, planScopedProfile: () => plan({ digest: hex('3') }),
    }
    const changed = await authorizeOpenCodeLaunchScopedProfile(changedManager, input)
    expect(changed.effectivePlanDigest).not.toBe(authorization.effectivePlanDigest)
    expect(authorization.effectivePlanDigest).toMatch(/^[a-f0-9]{64}$/)
  })
})
