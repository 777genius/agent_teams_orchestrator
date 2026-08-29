import { describe, expect, test } from 'bun:test'

import { planOpenCodeProfilePolicy } from './OpenCodeProfilePolicy.js'

describe('OpenCode profile policy', () => {
  test('canonicalizes providers and includes only their app-managed plugin', () => {
    const plan = (providerId: string) => planOpenCodeProfilePolicy({
      purpose: 'catalog',
      providerId,
      configFingerprint: 'catalog-v1',
      scopeToken: 'resolver-token',
    })

    expect(plan('Amazon Q Developer / Kiro')).toMatchObject({
      scope: { providerId: 'kiro' },
      managedSubscriptionPlugins: ['opencode-kiro@0.4.0'],
      includeAppMcp: false,
      reconcileAuth: false,
    })
    expect(plan('cursor-acp').managedSubscriptionPlugins).toEqual([
      '@rama_nigg/open-cursor@2.5.2',
    ])
    expect(plan('deepinfra').managedSubscriptionPlugins).toEqual([])
    expect(plan('custom-provider').managedSubscriptionPlugins).toEqual([])
  })

  test('plans all purposes without wiring catalog policy to launch behavior', () => {
    expect(planOpenCodeProfilePolicy({
      purpose: 'execution_probe',
      providerId: 'kiro',
      configFingerprint: 'probe-v1',
      scopeToken: 'resolver-token',
    }).includeAppMcp).toBe(false)
    expect(planOpenCodeProfilePolicy({
      purpose: 'launch_runtime',
      providerId: 'kiro',
      configFingerprint: 'launch-v1',
      scopeToken: 'resolver-token',
    }).includeAppMcp).toBe(true)
  })
})
