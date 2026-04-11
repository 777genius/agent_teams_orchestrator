import { afterEach, describe, expect, it } from 'bun:test';
import { clearAgentTeamsStateForTesting, setAgentTeamsCapabilitiesForTesting } from '../../services/agentTeams/store.js';
import type { AgentTeamsCapabilitiesRecord } from '../../services/agentTeams/types.js';
import { getDefaultMainLoopModel, getMainLoopModel } from './model.js';

function createCodexCapabilities(
  tier: string,
  grantedModels: Record<string, boolean>,
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
      tier,
      features: {},
      providers: {
        codex: {
          granted: true,
          required_tier: 'guest',
          killswitched: false,
        },
      },
      models: Object.fromEntries(
        Object.entries(grantedModels).map(([model, granted]) => [
          `codex/${model}`,
          {
            granted,
            required_tier: granted ? 'guest' : 'pro',
            killswitched: false,
          },
        ]),
      ),
      killswitches: {},
    },
  };
}

afterEach(() => {
  clearAgentTeamsStateForTesting();
  delete process.env.CLAUDE_CODE_USE_OPENAI;
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST;
  delete process.env.CLAUDE_CODE_ENTRY_PROVIDER;
});

describe('model access fallback with agent_teams capabilities', () => {
  it('falls back to the first allowed codex default model', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1';
    setAgentTeamsCapabilitiesForTesting(
      createCodexCapabilities('guest', {
        'gpt-5.4': false,
        'gpt-5.4-mini': false,
        'gpt-5.3-codex': false,
        'gpt-5.3-codex-spark': false,
        'gpt-5.2-codex': false,
        'gpt-5.2': true,
        'gpt-5.1-codex-max': false,
        'gpt-5.1-codex-mini': false,
      }),
    );

    expect(getDefaultMainLoopModel()).toBe('gpt-5.2');
  });

  it('falls back when a user-selected codex model becomes disallowed', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1';
    process.env.ANTHROPIC_MODEL = 'gpt-5.4';
    setAgentTeamsCapabilitiesForTesting(
      createCodexCapabilities('guest', {
        'gpt-5.4': false,
        'gpt-5.4-mini': false,
        'gpt-5.3-codex': true,
        'gpt-5.3-codex-spark': false,
        'gpt-5.2-codex': false,
        'gpt-5.2': false,
        'gpt-5.1-codex-max': false,
        'gpt-5.1-codex-mini': false,
      }),
    );

    expect(getMainLoopModel()).toBe('gpt-5.3-codex');
  });
});
