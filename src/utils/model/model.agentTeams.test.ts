import { afterEach, describe, expect, it } from 'bun:test';
import { clearAgentTeamsStateForTesting, setAgentTeamsCapabilitiesForTesting } from '../../services/agentTeams/store.js';
import type { AgentTeamsCapabilitiesRecord } from '../../services/agentTeams/types.js';
import {
  getFlagSettingsInline,
  getMainLoopModelOverride,
  setFlagSettingsInline,
  setMainLoopModelOverride,
} from '../../bootstrap/state.js';
import {
  getDefaultMainLoopModel,
  getDefaultOpusModel,
  getDefaultSonnetModel,
  getModelSelectionPolicyError,
  getMainLoopModel,
  getMarketingNameForModel,
  getPublicModelDisplayName,
  getRuntimeMainLoopModel,
  getUserSpecifiedModelSetting,
  normalizeModelStringForAPI,
  parseUserSpecifiedModel,
  resolveAllowedModelSetting,
  resolveSkillModelOverride,
} from './model.js';
import { getAPIProvider } from './providers.js';
import { getModelOptions } from './modelOptions.js';
import { getContextWindowForModel } from '../context.js';
import {
  modelSupportsAdaptiveThinking,
  modelSupportsThinking,
} from '../thinking.js';
import {
  getFastModeModel,
  getFastModeToggleDecision,
  isFastModeSupportedByModel,
} from '../fastMode.js';
import { AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV } from '../anthropicConnectionMode.js';
import { CODEX_MODELS, DEFAULT_CODEX_MODEL, isCodexModel } from './codex.js';

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
  delete process.env.USER_TYPE;
  setMainLoopModelOverride(undefined);
  clearAgentTeamsStateForTesting();
  setFlagSettingsInline(null);
  delete process.env.CLAUDE_CODE_USE_OPENAI;
  delete process.env.CLAUDE_CODE_USE_GEMINI;
  delete process.env.CLAUDE_CODE_USE_BEDROCK;
  delete process.env.CLAUDE_CODE_USE_VERTEX;
  delete process.env.CLAUDE_CODE_USE_FOUNDRY;
  delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
  delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  delete process.env.ANTHROPIC_MODEL;
  delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
  delete process.env.ANTHROPIC_AWS_WORKSPACE_ID;
  delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST;
  delete process.env.CLAUDE_CODE_ENTRY_PROVIDER;
  delete process.env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV];
});

describe('model access fallback with agent_teams capabilities', () => {
  it('keeps Anthropic host-managed selection compatible with Bedrock settings', () => {
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic';
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';

    expect(getAPIProvider()).toBe('bedrock');
    expect(getDefaultOpusModel()).toContain('opus-4-7');
  });

  it.each(['api_key', 'subscription', 'compatible'] as const)(
    'keeps explicit Anthropic %s mode on first-party provider despite Bedrock flags',
    (connectionMode) => {
      process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
      process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic';
      process.env[AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV] = connectionMode;
      process.env.CLAUDE_CODE_USE_BEDROCK = '1';

      expect(getAPIProvider()).toBe('firstParty');
    },
  );

  it('keeps Claude Platform on AWS as launch metadata without adding a new API provider', () => {
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'claude-platform-aws';
    process.env.ANTHROPIC_AWS_WORKSPACE_ID = 'wrkspc_123';

    expect(getAPIProvider()).toBe('firstParty');
  });

  it('keeps Bedrock ahead of Claude Platform on AWS for backend selection', () => {
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'anthropic';
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    process.env.ANTHROPIC_AWS_WORKSPACE_ID = 'wrkspc_123';

    expect(getAPIProvider()).toBe('bedrock');
  });

  it('does not let Claude Platform on AWS env override explicit Codex routing', () => {
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'codex';
    process.env.ANTHROPIC_AWS_WORKSPACE_ID = 'wrkspc_123';

    expect(getAPIProvider()).toBe('openai');
  });

  it('falls back to the first allowed codex default model', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1';
    setAgentTeamsCapabilitiesForTesting(
      createCodexCapabilities('guest', {
        'gpt-5.6-sol': false,
        'gpt-5.6-terra': false,
        'gpt-5.6-luna': false,
        'gpt-5.4': false,
        'gpt-5.5': false,
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

  it('retains and rejects a user-selected codex model when it becomes disallowed', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1';
    process.env.ANTHROPIC_MODEL = 'gpt-5.4';
    setAgentTeamsCapabilitiesForTesting(
      createCodexCapabilities('guest', {
        'gpt-5.4': false,
        'gpt-5.5': false,
        'gpt-5.4-mini': false,
        'gpt-5.3-codex': true,
        'gpt-5.3-codex-spark': false,
        'gpt-5.2-codex': false,
        'gpt-5.2': false,
        'gpt-5.1-codex-max': false,
        'gpt-5.1-codex-mini': false,
      }),
    );

    expect(getUserSpecifiedModelSetting()).toBe('gpt-5.4');
    expect(getMainLoopModel()).toBe('gpt-5.4');
    expect(getModelSelectionPolicyError('gpt-5.4')).toContain(
      'not allowed by the availableModels policy',
    );
    expect(
      getModelOptions().some(option => option.value === 'gpt-5.4'),
    ).toBe(true);
  });

  it('retains and rejects a concrete model when Codex runtime support is forbidden', () => {
    process.env.CLAUDE_CODE_ENTRY_PROVIDER = 'codex';
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
    process.env.ANTHROPIC_MODEL = 'gpt-5.1-codex-max';
    const previousSettings = getFlagSettingsInline();
    setFlagSettingsInline({
      codex: {
        forced_login_method: 'chatgpt',
      },
    });

    expect(getMainLoopModel()).toBe('gpt-5.1-codex-max');
    expect(getModelSelectionPolicyError('gpt-5.1-codex-max')).toContain(
      'unavailable for the current Codex runtime',
    );
    setFlagSettingsInline(previousSettings);
  });
});

describe('Opus 4.8 defaults', () => {
  it('recognizes current and future GPT models with GPT-5.6 Sol as the default', () => {
    expect(isCodexModel('gpt-5.5')).toBe(true);
    expect(isCodexModel('gpt-5.6-sol')).toBe(true);
    expect(isCodexModel('gpt-5.7-future')).toBe(true);
    expect(CODEX_MODELS.map((model) => model.id)).toContain('gpt-5.5');
    expect(DEFAULT_CODEX_MODEL).toBe('gpt-5.6-sol');
    expect(getPublicModelDisplayName('gpt-5.6-sol')).toBe('GPT-5.6 Sol');
    expect(getMarketingNameForModel('gpt-5.6-sol')).toBe('GPT-5.6 Sol');
    expect(getPublicModelDisplayName('gpt-5.5')).toBe('GPT-5.5');
    expect(getMarketingNameForModel('gpt-5.5')).toBe('GPT-5.5');
  });

  it('resolves the first-party Opus alias to Opus 4.8', () => {
    expect(getDefaultOpusModel()).toBe('claude-opus-4-8');
    expect(parseUserSpecifiedModel('opus')).toBe('claude-opus-4-8');
    expect(parseUserSpecifiedModel('opus[1m]')).toBe('claude-opus-4-8[1m]');
  });

  it('keeps third-party Opus defaults pinned to 4.7', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';

    expect(getDefaultOpusModel()).toContain('opus-4-7');
  });

  it('treats Opus 4.8 as the public first-party Opus model for labels and core capabilities', () => {
    expect(getPublicModelDisplayName('claude-opus-4-8')).toBe('Opus 4.8');
    expect(getPublicModelDisplayName('claude-opus-4-8[1m]')).toBe('Opus 4.8 (1M context)');
    expect(getMarketingNameForModel('claude-opus-4-8[1m]')).toBe(
      'Opus 4.8 (with 1M context)'
    );
  });

  it('does not crash on empty model ids when rendering marketing names', () => {
    expect(getMarketingNameForModel(null)).toBeUndefined();
    expect(getMarketingNameForModel(undefined)).toBeUndefined();
    expect(getMarketingNameForModel('')).toBeUndefined();
  });

  it('does not crash on empty model ids when resolving user-specified models', () => {
    expect(typeof parseUserSpecifiedModel(null)).toBe('string');
    expect(typeof parseUserSpecifiedModel(undefined)).toBe('string');
    expect(typeof parseUserSpecifiedModel('')).toBe('string');
  });

  it('pins fast mode to explicit Opus 4.8 while opus resolves to 4.8', () => {
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1';

    expect(getFastModeModel()).toBe('claude-opus-4-8');
    expect(isFastModeSupportedByModel('opus')).toBe(true);
    expect(isFastModeSupportedByModel('claude-opus-4-8')).toBe(true);
    expect(isFastModeSupportedByModel('claude-opus-4-6')).toBe(false);
  });
});

describe('explicit model identity preservation', () => {
  const EXACT_MODELS = [
    'claude-opus-5',
    'claude-opus-5-5',
    'claude-opus-6-future',
    'claude-sonnet-5',
    'claude-haiku-5',
    'custom-provider/model',
    'mimo-v2.6-pro',
    'claude-opus-4-1',
    'claude-opus-5[1m]',
  ] as const;

  it.each(EXACT_MODELS)(
    'keeps %s through startup, parse, plan, and context-cap paths',
    model => {
      setMainLoopModelOverride(model);

      expect(getUserSpecifiedModelSetting()).toBe(model);
      expect(getMainLoopModel()).toBe(
        model.endsWith('[1m]')
          ? `${model.slice(0, -'[1m]'.length)}[1m]`
          : model,
      );
      expect(resolveAllowedModelSetting(model)).toBe(
        model.endsWith('[1m]')
          ? `${model.slice(0, -'[1m]'.length)}[1m]`
          : model,
      );
      expect(
        getRuntimeMainLoopModel({
          permissionMode: 'plan',
          mainLoopModel: model,
          exceeds200kTokens: true,
        }),
      ).toBe(model);
    },
  );

  it('normalizes only the context suffix at the API boundary', () => {
    expect(normalizeModelStringForAPI('claude-opus-5-5[1m]')).toBe(
      'claude-opus-5-5',
    );
    expect(resolveSkillModelOverride(
      'claude-opus-5-5',
      'claude-opus-5-5[1m]',
    )).toBe('claude-opus-5-5[1m]');
  });

  it('applies context caps and future-model thinking metadata without changing model identity', () => {
    const model = 'claude-opus-6-future[1m]'
    process.env.USER_TYPE = 'ant'
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '123456'

    expect(getContextWindowForModel(model, [])).toBe(123456)
    expect(normalizeModelStringForAPI(model)).toBe('claude-opus-6-future')
    expect(modelSupportsThinking(model)).toBe(true)
    expect(modelSupportsAdaptiveThinking(model)).toBe(true)
  });

  it('keeps intentional conditional alias transitions distinct from concrete IDs', () => {
    process.env.ANTHROPIC_MODEL = 'opusplan';
    expect(
      getRuntimeMainLoopModel({
        permissionMode: 'plan',
        mainLoopModel: 'claude-sonnet-5',
        exceeds200kTokens: false,
      }),
    ).toBe(getDefaultOpusModel());

    process.env.ANTHROPIC_MODEL = 'haiku';
    expect(
      getRuntimeMainLoopModel({
        permissionMode: 'plan',
        mainLoopModel: 'claude-haiku-5',
        exceeds200kTokens: false,
      }),
    ).toBe(getDefaultSonnetModel());
  });

  it('applies conditional alias semantics to explicit fallback models without changing concrete fallback IDs', () => {
    expect(
      getRuntimeMainLoopModel({
        permissionMode: 'plan',
        modelSetting: 'opusplan',
        mainLoopModel: parseUserSpecifiedModel('opusplan'),
        exceeds200kTokens: false,
      }),
    ).toBe(getDefaultOpusModel());

    for (const fallbackModel of [
      'claude-opus-5',
      'claude-opus-5-5',
      'custom-provider/model',
    ]) {
      expect(
        getRuntimeMainLoopModel({
          permissionMode: 'plan',
          modelSetting: fallbackModel,
          mainLoopModel: parseUserSpecifiedModel(fallbackModel),
          exceeds200kTokens: true,
        }),
      ).toBe(fallbackModel);
    }
  });

  it('rejects unsupported fast mode without changing the selected model', () => {
    const model = 'claude-opus-5-5';
    const decision = getFastModeToggleDecision(model, true);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.message).toContain(model);
      expect(decision.message).toContain('unchanged');
    }
    expect(getFastModeToggleDecision(model, false)).toEqual({ ok: true });
    expect(model).toBe('claude-opus-5-5');
  });
});
