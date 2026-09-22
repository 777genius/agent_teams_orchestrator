import { describe, expect, test } from 'bun:test'
import { assertNoContamination, checkProviders, fixtureConfig, managedAgentFixtures } from './opencode-authority-conformance.js'

describe('isolated conformance comparison', () => {
  const expected = fixtureConfig('http://127.0.0.1:12345')
  test('compares independent fixture and accepts only empty upstream defaults', () => {
    const live: ReturnType<typeof fixtureConfig> = { ...structuredClone(expected), command: {}, mode: {} }
    for (const agent of Object.values(live.agent) as Record<string, unknown>[]) agent.options = {}
    expect(() => assertNoContamination(expected, live)).not.toThrow()
    expect(() => checkProviders(expected, live)).not.toThrow()
  })
  test('rejects unknown effective configuration and modified auth/endpoint', () => {
    expect(() => assertNoContamination(expected, { ...expected, instructions: ['foreign.md'] })).toThrow()
    expect(() => assertNoContamination(expected, { ...expected, agent: { foreign: {} } })).toThrow()
    for (const provider of ['openrouter', 'authority-fixture']) {
      for (const field of ['apiKey', 'baseURL']) {
        const live = structuredClone(expected)
        live.provider[provider].options[field] = 'unexpected'
        expect(() => checkProviders(expected, live)).toThrow()
      }
    }
  })
})

// The production builder is only called with fixture values; no runtime/profile is created.
import { buildManagedConfig } from '../src/services/opencode/OpenCodeProfileManager.js'
for (const mode of ['auto', 'manual'] as const) {
  test(`independent ${mode} fixture matches emitted managed policies`, () => {
    const emitted = buildManagedConfig(null, { toolApprovalMode: mode, managedProviderId: 'authority-fixture' })
    expect(JSON.stringify(emitted.agent)).toBe(JSON.stringify(managedAgentFixtures(mode)))
    expect(emitted.default_agent).toBe('teammate')
  })
}

test('config transport key reordering is value-equivalent; expected root permission stays absent', () => {
  const expected = fixtureConfig('http://127.0.0.1:12345')
  expect(Object.hasOwn(expected, 'permission')).toBe(false)
  const live = structuredClone(expected)
  for (const agent of Object.values(live.agent) as Record<string, unknown>[]) agent.options = {}
  live.agent.teammate.permission = Object.fromEntries(Object.entries(live.agent.teammate.permission).reverse())
  expect(() => assertNoContamination(expected, live)).not.toThrow()
  expect(() => assertNoContamination(expected, { ...live, permission: { '*': 'deny' } })).toThrow()
})
