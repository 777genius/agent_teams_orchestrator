import { afterEach, describe, expect, test } from 'bun:test'

import {
  clearAgentTeamsStateForTesting,
  setAgentTeamsCapabilitiesForTesting,
} from '../agentTeams/store.js'
import { getUnifiedRuntimeStatusPayload } from './registry.js'

function setGuestCodexCapabilities(): void {
  const now = Date.now()
  setAgentTeamsCapabilitiesForTesting({
    token: 'test-token',
    tokenType: 'JWT',
    expiresAt: now + 60_000,
    fetchedAt: now,
    integrity: 'transport',
    claims: {
      iss: 'voicetext-agent-teams-capabilities',
      aud: 'voicetext-agent-teams',
      sub: 'subject-1',
      exp: Math.floor((now + 60_000) / 1000),
      iat: Math.floor(now / 1000),
      jti: 'jti-1',
      tier: 'guest',
      features: {},
      providers: {
        codex: {
          granted: true,
          required_tier: 'guest',
          killswitched: false,
        },
      },
      models: {
        'codex/gpt-5.4': {
          granted: false,
          required_tier: 'pro',
          killswitched: false,
        },
        'codex/gpt-5.4-mini': {
          granted: false,
          required_tier: 'pro',
          killswitched: false,
        },
        'codex/gpt-5.3-codex': {
          granted: true,
          required_tier: 'guest',
          killswitched: false,
        },
      },
      killswitches: {},
    },
  })
}

afterEach(() => {
  clearAgentTeamsStateForTesting()
})

describe('runtime backend registry with agent_teams capabilities', () => {
  test('codex runtime status hides remotely blocked models', async () => {
    setGuestCodexCapabilities()

    const payload = await getUnifiedRuntimeStatusPayload('codex')
    const codex = payload.providers.codex

    expect(codex?.models).toContain('gpt-5.3-codex')
    expect(codex?.models).not.toContain('gpt-5.4')
    expect(codex?.models).not.toContain('gpt-5.4-mini')
  })
})
