export interface OpenCodeCuratedSubscriptionSetup {
  description: string
  secretLabel: string
  secretPlaceholder: string
}

export interface OpenCodeCuratedSubscriptionKeyPolicy {
  requiredPrefix: string
  wrongPrefix?: string
  wrongPrefixMessage?: string
  invalidPrefixMessage: string
}

export interface OpenCodeCuratedSubscriptionProviderDefinition {
  id: string
  displayName: string
  credentialKind: 'api-key' | 'plugin-oauth'
  setup: OpenCodeCuratedSubscriptionSetup
  fastSetup: boolean
  seedDirectory: boolean
  config: Record<string, unknown> | null
  modelProbePreferences: readonly string[]
  requireConnectExecutionProof: boolean
  keyPolicy: OpenCodeCuratedSubscriptionKeyPolicy | null
}

const XIAOMI_MIMO_TOKEN_PLAN_MODELS = {
  'mimo-v2.5-pro': {
    name: 'mimo-v2.5-pro',
    reasoning: true,
    tool_call: true,
    interleaved: {
      field: 'reasoning_content',
    },
    limit: {
      context: 1_048_576,
      output: 131_072,
    },
    modalities: {
      input: ['text'],
      output: ['text'],
    },
  },
  'mimo-v2.5': {
    name: 'mimo-v2.5',
    reasoning: true,
    tool_call: true,
    interleaved: {
      field: 'reasoning_content',
    },
    limit: {
      context: 1_048_576,
      output: 131_072,
    },
    modalities: {
      input: ['text', 'image'],
      output: ['text'],
    },
  },
} as const

const KIMI_CODE_MEMBERSHIP_MODELS = {
  'kimi-for-coding': {
    name: 'Kimi Code',
    reasoning: true,
    tool_call: true,
    interleaved: {
      field: 'reasoning_content',
    },
    limit: {
      context: 262_144,
      output: 32_768,
    },
    modalities: {
      input: ['text', 'image'],
      output: ['text'],
    },
  },
  'kimi-for-coding-highspeed': {
    name: 'Kimi Code HighSpeed',
    reasoning: true,
    tool_call: true,
    interleaved: {
      field: 'reasoning_content',
    },
    limit: {
      context: 262_144,
      output: 32_768,
    },
    modalities: {
      input: ['text', 'image'],
      output: ['text'],
    },
  },
} as const

const ZAI_CODING_PLAN_MODELS = {
  'glm-5.2': {
    name: 'GLM-5.2',
    reasoning: true,
    tool_call: true,
    structured_output: true,
    interleaved: {
      field: 'reasoning_content',
    },
    limit: {
      context: 1_000_000,
      output: 131_072,
    },
    modalities: {
      input: ['text'],
      output: ['text'],
    },
  },
  'glm-5.1': {
    name: 'GLM-5.1',
    reasoning: true,
    tool_call: true,
    structured_output: true,
    interleaved: {
      field: 'reasoning_content',
    },
    limit: {
      context: 200_000,
      output: 131_072,
    },
    modalities: {
      input: ['text'],
      output: ['text'],
    },
  },
  'glm-5': {
    name: 'GLM-5',
    reasoning: true,
    tool_call: true,
    structured_output: true,
    interleaved: {
      field: 'reasoning_content',
    },
    limit: {
      context: 200_000,
      output: 131_072,
    },
    modalities: {
      input: ['text'],
      output: ['text'],
    },
  },
  'glm-5-turbo': {
    name: 'GLM-5-Turbo',
    reasoning: true,
    tool_call: true,
    structured_output: true,
    interleaved: {
      field: 'reasoning_content',
    },
    limit: {
      context: 200_000,
      output: 131_072,
    },
    modalities: {
      input: ['text'],
      output: ['text'],
    },
  },
  'glm-4.7': {
    name: 'GLM-4.7',
    reasoning: true,
    tool_call: true,
    interleaved: {
      field: 'reasoning_content',
    },
    limit: {
      context: 204_800,
      output: 131_072,
    },
    modalities: {
      input: ['text'],
      output: ['text'],
    },
  },
  'glm-4.5-air': {
    name: 'GLM-4.5-Air',
    reasoning: true,
    tool_call: true,
    structured_output: true,
    interleaved: {
      field: 'reasoning_content',
    },
    limit: {
      context: 131_072,
      output: 98_304,
    },
    modalities: {
      input: ['text'],
      output: ['text'],
    },
  },
} as const

// Temporary prerelease build containing the MCP tool readiness fix from
// https://github.com/NachoFLizaur/kiro-acp-ai-provider/pull/4.
// Switch back to the registry package after upstream publishes the fix.
const KIRO_ACP_PROVIDER_PACKAGE =
  'kiro-acp-ai-provider@https://github.com/777genius/kiro-acp-ai-provider/releases/download/agent-teams-mcp-readiness-v1/kiro-acp-ai-provider-2.1.2.tgz'

function xiaomiTokenPlanDefinition(input: {
  id: string
  displayName: string
  baseURL: string
}): OpenCodeCuratedSubscriptionProviderDefinition {
  return {
    id: input.id,
    displayName: input.displayName,
    credentialKind: 'api-key',
    setup: {
      description:
        `Open Token Plan management and copy the tp-... value under Dedicated API Key. Use this provider only when Dedicated Base URL shows ${input.baseURL}. The key is shown once when created; reset it there if it was lost or exposed.`,
      secretLabel: 'Token Plan API Key (tp-...)',
      secretPlaceholder: 'tp-xxxxx',
    },
    fastSetup: false,
    seedDirectory: true,
    config: {
      npm: '@ai-sdk/openai-compatible',
      name: input.displayName,
      options: {
        baseURL: input.baseURL,
      },
      models: XIAOMI_MIMO_TOKEN_PLAN_MODELS,
    },
    modelProbePreferences: [
      `${input.id}/mimo-v2.5-pro`,
      `${input.id}/mimo-v2.5`,
    ],
    requireConnectExecutionProof: true,
    keyPolicy: {
      requiredPrefix: 'tp-',
      wrongPrefix: 'sk-',
      wrongPrefixMessage:
        'Xiaomi Token Plan providers require a tp-... API key. Pay-as-you-go sk-... keys cannot be used with Token Plan Base URLs.',
      invalidPrefixMessage:
        'Xiaomi Token Plan API key must start with tp-. Copy the key from the Token Plan page.',
    },
  }
}

export const OPEN_CODE_CURATED_SUBSCRIPTION_PROVIDERS = [
  xiaomiTokenPlanDefinition({
    id: 'xiaomi-token-plan-ams',
    displayName: 'Xiaomi MiMo Token Plan - Europe',
    baseURL: 'https://token-plan-ams.xiaomimimo.com/v1',
  }),
  xiaomiTokenPlanDefinition({
    id: 'xiaomi-token-plan-sgp',
    displayName: 'Xiaomi MiMo Token Plan - Singapore',
    baseURL: 'https://token-plan-sgp.xiaomimimo.com/v1',
  }),
  xiaomiTokenPlanDefinition({
    id: 'xiaomi-token-plan-cn',
    displayName: 'Xiaomi MiMo Token Plan - China',
    baseURL: 'https://token-plan-cn.xiaomimimo.com/v1',
  }),
  {
    id: 'minimax-coding-plan',
    displayName: 'MiniMax Token Plan',
    credentialKind: 'api-key',
    setup: {
      description:
        'Use the sk-cp-... subscription key from your MiniMax Token Plan page. This provider uses the Token Plan endpoint and quota, not pay-as-you-go API balance.',
      secretLabel: 'Token Plan subscription key',
      secretPlaceholder: 'sk-cp-...',
    },
    fastSetup: true,
    seedDirectory: false,
    config: null,
    modelProbePreferences: [
      'minimax-coding-plan/MiniMax-M3',
      'minimax-coding-plan/MiniMax-M2.7-highspeed',
      'minimax-coding-plan/MiniMax-M2.7',
    ],
    requireConnectExecutionProof: true,
    keyPolicy: {
      requiredPrefix: 'sk-cp-',
      wrongPrefix: 'sk-',
      wrongPrefixMessage:
        'MiniMax Token Plan requires an sk-cp-... subscription key. Regular pay-as-you-go sk-... keys cannot use the Token Plan route.',
      invalidPrefixMessage:
        'MiniMax Token Plan subscription key must start with sk-cp-. Copy it from the Token Plan page.',
    },
  },
  {
    id: 'zai-coding-plan',
    displayName: 'Z.AI Coding Plan',
    credentialKind: 'api-key',
    setup: {
      description:
        'Use the API key from your GLM Coding Plan page. This provider uses the dedicated Z.AI coding endpoint and Coding Plan quota.',
      secretLabel: 'GLM Coding Plan API key',
      secretPlaceholder: 'Paste Coding Plan key',
    },
    fastSetup: true,
    seedDirectory: true,
    // Keep a managed fallback so the Coding Plan remains connectable if the
    // remote models.dev catalog is temporarily unavailable or behind Z.AI.
    // The provider id, endpoint and model ids match the official OpenCode and
    // Z.AI Coding Plan contracts.
    config: {
      npm: '@ai-sdk/openai-compatible',
      name: 'Z.AI Coding Plan',
      options: {
        baseURL: 'https://api.z.ai/api/coding/paas/v4',
      },
      models: ZAI_CODING_PLAN_MODELS,
    },
    modelProbePreferences: [
      'zai-coding-plan/glm-5.2',
      'zai-coding-plan/glm-5.1',
      'zai-coding-plan/glm-5',
      'zai-coding-plan/glm-5-turbo',
      'zai-coding-plan/glm-4.7',
      'zai-coding-plan/glm-4.5-air',
    ],
    requireConnectExecutionProof: true,
    keyPolicy: null,
  },
  {
    id: 'kimi-for-coding',
    displayName: 'Kimi Code Membership',
    credentialKind: 'api-key',
    setup: {
      description:
        'Use an API key from Kimi Code Console. This route uses Kimi membership quota through the official Kimi Code endpoint, not Moonshot pay-as-you-go balance.',
      secretLabel: 'Kimi Code membership key',
      secretPlaceholder: 'Paste Kimi Code membership key',
    },
    fastSetup: true,
    seedDirectory: true,
    config: {
      npm: '@ai-sdk/openai-compatible',
      name: 'Kimi Code Membership',
      options: {
        baseURL: 'https://api.kimi.com/coding/v1',
      },
      models: KIMI_CODE_MEMBERSHIP_MODELS,
    },
    modelProbePreferences: ['kimi-for-coding/kimi-for-coding'],
    requireConnectExecutionProof: true,
    keyPolicy: null,
  },
  {
    id: 'kiro',
    displayName: 'Amazon Q Developer / Kiro',
    credentialKind: 'plugin-oauth',
    setup: {
      description:
        'Connect your Kiro subscription through the managed OpenCode Kiro plugin. Authentication is completed by the official Kiro CLI.',
      secretLabel: 'Kiro account',
      secretPlaceholder: 'No API key required',
    },
    fastSetup: false,
    seedDirectory: true,
    // opencode-kiro expects OpenCode's models.dev snapshot to expose the provider.
    // Keep a minimal managed fallback because the public catalog can lag behind
    // the plugin release and otherwise leaves the auth flow unreachable.
    config: {
      name: 'Amazon Q Developer / Kiro',
      npm: KIRO_ACP_PROVIDER_PACKAGE,
      models: {
        auto: {
          name: 'Auto',
          tool_call: true,
          limit: {
            context: 262_144,
            output: 32_768,
          },
        },
      },
    },
    modelProbePreferences: ['kiro/auto'],
    requireConnectExecutionProof: false,
    keyPolicy: null,
  },
  {
    id: 'cursor-acp',
    displayName: 'Cursor',
    credentialKind: 'plugin-oauth',
    setup: {
      description:
        'Connect your Cursor subscription through the managed OpenCode Cursor provider plugin.',
      secretLabel: 'Cursor account',
      secretPlaceholder: 'No API key required',
    },
    fastSetup: false,
    seedDirectory: true,
    config: {
      name: 'Cursor ACP',
      npm: '@ai-sdk/openai-compatible',
      options: {
        baseURL: 'http://127.0.0.1:32124/v1',
      },
      models: {
        auto: {
          name: 'Auto',
          tool_call: true,
          limit: {
            context: 262_144,
            output: 32_768,
          },
        },
      },
    },
    modelProbePreferences: ['cursor-acp/auto'],
    requireConnectExecutionProof: false,
    keyPolicy: null,
  },
] as const satisfies readonly OpenCodeCuratedSubscriptionProviderDefinition[]

export const OPEN_CODE_MANAGED_SUBSCRIPTION_PLUGIN_PACKAGES = [
  'opencode-kiro@0.3.6',
  '@rama_nigg/open-cursor@2.5.2',
] as const

const DEFINITIONS_BY_ID = new Map(
  OPEN_CODE_CURATED_SUBSCRIPTION_PROVIDERS.map(definition => [definition.id, definition]),
)

export function getOpenCodeCuratedSubscriptionProvider(
  providerId: string,
): OpenCodeCuratedSubscriptionProviderDefinition | null {
  return DEFINITIONS_BY_ID.get(providerId) ?? null
}

export function isOpenCodeCuratedSubscriptionProviderId(providerId: string): boolean {
  return DEFINITIONS_BY_ID.has(providerId.trim())
}

export function getOpenCodeCuratedSubscriptionProviderIds(): string[] {
  return OPEN_CODE_CURATED_SUBSCRIPTION_PROVIDERS.map(definition => definition.id)
}

export function getOpenCodeFastCuratedSubscriptionProviderIds(): string[] {
  return OPEN_CODE_CURATED_SUBSCRIPTION_PROVIDERS
    .filter(definition => definition.fastSetup)
    .map(definition => definition.id)
}

export function getOpenCodeSeededSubscriptionProviderIds(): string[] {
  return OPEN_CODE_CURATED_SUBSCRIPTION_PROVIDERS
    .filter(definition => definition.seedDirectory)
    .map(definition => definition.id)
}

export function getOpenCodeCuratedSubscriptionProviderConfigs(): Record<string, unknown> {
  return Object.fromEntries(
    OPEN_CODE_CURATED_SUBSCRIPTION_PROVIDERS.flatMap(definition =>
      definition.config ? [[definition.id, definition.config] as const] : [],
    ),
  )
}

export function getOpenCodeManagedSubscriptionPluginPackages(): string[] {
  return [...OPEN_CODE_MANAGED_SUBSCRIPTION_PLUGIN_PACKAGES]
}

export function validateOpenCodeCuratedSubscriptionKey(
  providerId: string,
  apiKey: string,
): string | null {
  const policy = getOpenCodeCuratedSubscriptionProvider(providerId)?.keyPolicy ?? null
  if (!policy) {
    return null
  }
  if (apiKey.startsWith(policy.requiredPrefix)) {
    return null
  }
  if (policy.wrongPrefix && apiKey.startsWith(policy.wrongPrefix)) {
    return policy.wrongPrefixMessage ?? policy.invalidPrefixMessage
  }
  return policy.invalidPrefixMessage
}
