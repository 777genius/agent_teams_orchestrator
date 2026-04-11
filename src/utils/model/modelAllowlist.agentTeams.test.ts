import { afterEach, describe, expect, it } from 'bun:test';
import { clearAgentTeamsStateForTesting, setAgentTeamsCapabilitiesForTesting } from '../../services/agentTeams/store.js';
import type { AgentTeamsCapabilitiesRecord } from '../../services/agentTeams/types.js';
import { isModelAllowed } from './modelAllowlist.js';

function createCapabilitiesRecord(
  models: AgentTeamsCapabilitiesRecord['claims']['models'],
): AgentTeamsCapabilitiesRecord {
  const now = Date.now();
  return {
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
      models,
      killswitches: {},
    },
  };
}

afterEach(() => {
  clearAgentTeamsStateForTesting();
});

describe('isModelAllowed with agent_teams capabilities', () => {
  it('blocks remotely disabled codex models even without local availableModels', () => {
    setAgentTeamsCapabilitiesForTesting(
      createCapabilitiesRecord({
        'codex/gpt-5.4': {
          granted: false,
          required_tier: 'pro',
          killswitched: false,
        },
        'codex/gpt-5.3-codex': {
          granted: true,
          required_tier: 'guest',
          killswitched: false,
        },
      }),
    );

    expect(isModelAllowed('gpt-5.4')).toBe(false);
    expect(isModelAllowed('gpt-5.3-codex')).toBe(true);
  });

  it('treats 1m anthropic variants as the same remote capability key', () => {
    const now = Date.now();
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
          anthropic: {
            granted: true,
            required_tier: 'guest',
            killswitched: false,
          },
        },
        models: {
          'anthropic/claude-sonnet-4-6': {
            granted: true,
            required_tier: 'guest',
            killswitched: false,
          },
        },
        killswitches: {},
      },
    });

    expect(isModelAllowed('claude-sonnet-4-6[1m]')).toBe(true);
  });
});
