import { afterEach, describe, expect, it } from 'bun:test';
import { clearAgentTeamsStateForTesting, setAgentTeamsCapabilitiesForTesting } from '../../services/agentTeams/store.js';
import type { AgentTeamsCapabilitiesRecord } from '../../services/agentTeams/types.js';
import {
  getDefaultMainLoopModel,
  getDefaultOpusModel,
  getMainLoopModel,
  getMarketingNameForModel,
  getPublicModelDisplayName,
  parseUserSpecifiedModel,
} from './model.js';
import { getFastModeModel, isFastModeSupportedByModel } from '../fastMode.js';

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
  delete process.env.CLAUDE_CODE_USE_BEDROCK;
  delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
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

describe('Opus 4.7 defaults', () => {
  it('resolves the first-party Opus alias to Opus 4.7', () => {
    expect(getDefaultOpusModel()).toBe('claude-opus-4-7');
    expect(parseUserSpecifiedModel('opus')).toBe('claude-opus-4-7');
    expect(parseUserSpecifiedModel('opus[1m]')).toBe('claude-opus-4-7[1m]');
  });

  it('keeps third-party Opus defaults pinned to 4.6', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';

    expect(getDefaultOpusModel()).toContain('opus-4-6');
  });

  it('treats Opus 4.7 as the public first-party Opus model for labels and core capabilities', () => {
    expect(getPublicModelDisplayName('claude-opus-4-7')).toBe('Opus 4.7');
    expect(getPublicModelDisplayName('claude-opus-4-7[1m]')).toBe('Opus 4.7 (1M context)');
    expect(getMarketingNameForModel('claude-opus-4-7[1m]')).toBe(
      'Opus 4.7 (with 1M context)'
    );
  });

  it('keeps fast mode pinned to explicit Opus 4.6 while opus resolves to 4.7', () => {
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1';

    expect(getFastModeModel()).toBe('claude-opus-4-6');
    expect(isFastModeSupportedByModel('opus')).toBe(false);
    expect(isFastModeSupportedByModel('claude-opus-4-6')).toBe(true);
  });
});
