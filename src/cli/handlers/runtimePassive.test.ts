import { describe, expect, test } from 'bun:test'

import type { OpenCodePassiveStatusV1 } from '../../services/opencode/OpenCodePassiveStatusContract.js'
import {
  runtimeOpenCodePassiveProviderDirectory,
  runtimeOpenCodePassiveStatus,
} from './runtimePassive.js'

function status(providerIds: readonly string[]): OpenCodePassiveStatusV1 {
  const unknown = <T>(value: T) => ({
    value, authority: 'none' as const, freshness: 'unknown' as const,
    condition: 'degraded' as const, observedAt: null, validUntil: null,
    issueCode: 'read_timeout' as const,
  })
  return {
    contractVersion: 1,
    projectScope: `sha256:${'a'.repeat(64)}`,
    binary: unknown({ presence: 'unknown', version: null }),
    providers: providerIds.map(providerId => ({
      providerId,
      configured: unknown('unknown'),
      lastConnected: unknown({ state: 'unknown' }),
      catalogAvailable: unknown('unknown'),
      executionVerified: unknown('unknown'),
    })),
    authorization: 'unknown',
    launchReadiness: 'not_authorized',
    completedAt: 1_000,
  }
}

describe('passive-only OpenCode CLI summary routes', () => {
  test('runtime status summary uses only the passive seam', async () => {
    let calls = 0
    let output = ''
    await runtimeOpenCodePassiveStatus({
      projectPath: '/fake-project',
      getOpenCodePassiveStatus: async input => {
        calls += 1
        expect(input.projectPath).toBe('/fake-project')
        return status(input.providerIds)
      },
      stdoutWrite: text => { output += text },
    })
    const payload = JSON.parse(output)
    expect(calls).toBe(1)
    expect(payload.providers.opencode).toMatchObject({
      authenticated: false,
      verificationState: 'unknown',
      capabilities: { teamLaunch: false },
      models: [],
    })
    expect(output).not.toContain('/fake-project')
  })

  test('provider directory summary uses only the passive seam', async () => {
    let calls = 0
    let output = ''
    await runtimeOpenCodePassiveProviderDirectory({
      projectPath: '/fake-project',
      query: 'deepinfra',
      getOpenCodePassiveStatus: async input => {
        calls += 1
        return status(input.providerIds)
      },
      stdoutWrite: text => { output += text },
    })
    const payload = JSON.parse(output)
    expect(calls).toBe(1)
    expect(payload.directory.entries.map((entry: { providerId: string }) => entry.providerId)).toEqual(['deepinfra'])
    expect(payload.directory.entries[0].actions.every((action: { enabled: boolean }) => !action.enabled)).toBe(true)
    expect(output).not.toContain('/fake-project')
  })
})
