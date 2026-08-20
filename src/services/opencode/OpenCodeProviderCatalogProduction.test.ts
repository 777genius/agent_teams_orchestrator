import { describe, expect, test } from 'bun:test'

import { prepareOpenCodeProviderCatalogProductionProfile } from './OpenCodeProviderCatalogProduction.js'

import type {
  OpenCodeCurrentScopedProfilePlan,
  OpenCodeScopedPreparedProfile,
  OpenCodeScopedProfilePlanContract,
} from './types.js'

describe('OpenCode provider catalog production composition', () => {
  test('passes the exact deadline signal through capture and preparation and observes abort', async () => {
    const controller = new AbortController()
    let capturedSignal: AbortSignal | undefined
    let preparedSignal: AbortSignal | undefined
    let preparationStarted!: () => void
    const started = new Promise<void>(resolve => { preparationStarted = resolve })
    const current = {
      purpose: 'provider-catalog', providerId: 'deepinfra', modelId: null,
      runtimeInstanceId: 'catalog-attempt', projectPath: '/canonical/project', evidence: {},
    } as unknown as OpenCodeCurrentScopedProfilePlan
    const expected = { schema: 'opencode-scoped-profile-plan-v1' } as OpenCodeScopedProfilePlanContract
    const manager = {
      captureCurrentScopedProfilePlan: async (input: { abortSignal?: AbortSignal }) => {
        capturedSignal = input.abortSignal
        return current
      },
      planScopedProfile: () => expected,
      prepareScopedProfile: async (input: OpenCodeCurrentScopedProfilePlan & { abortSignal?: AbortSignal }) => {
        preparedSignal = input.abortSignal
        preparationStarted()
        await new Promise<void>((_resolve, reject) => input.abortSignal!.addEventListener(
          'abort', () => reject(new Error('observed production abort')), { once: true },
        ))
        throw new Error('unreachable')
      },
    }
    const pending = prepareOpenCodeProviderCatalogProductionProfile(manager, {
      purpose: 'provider-catalog', providerId: 'deepinfra', runtimeInstanceId: 'catalog-attempt',
      projectPath: '/canonical/project', abortSignal: controller.signal,
    }) as Promise<OpenCodeScopedPreparedProfile>
    await started
    expect(capturedSignal).toBe(controller.signal)
    expect(preparedSignal).toBe(controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow('observed production abort')
  })
})
