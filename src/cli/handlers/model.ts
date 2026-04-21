/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import {
  CLAUDE_HAIKU_4_5_CONFIG,
  CLAUDE_OPUS_4_6_CONFIG,
  CLAUDE_SONNET_4_6_CONFIG,
} from '../../utils/model/configs.js'
import {
  CODEX_MODELS,
  DEFAULT_CODEX_MODEL,
} from '../../utils/model/codex.js'
import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_MODELS,
} from '../../utils/model/gemini.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { openCodeInventoryService } from '../../services/opencode/OpenCodeInventoryService.js'
import { jsonStringify } from '../../utils/slowOperations.js'

type ModelProviderTarget = 'anthropic' | 'codex' | 'gemini' | 'opencode' | 'all'
export type InternalModelProvider = Exclude<ModelProviderTarget, 'all'>

type ModelSummary = {
  id: string
  label: string
  description: string
}

function getDefaultProvider(): InternalModelProvider {
  const apiProvider = getAPIProvider()
  if (apiProvider === 'openai') {
    return 'codex'
  }
  if (apiProvider === 'gemini') {
    return 'gemini'
  }
  return 'anthropic'
}

export async function getProviderModels(provider: InternalModelProvider): Promise<{
  defaultModel: string
  displayName: string
  models: ModelSummary[]
}> {
  switch (provider) {
    case 'codex':
      return {
        defaultModel: DEFAULT_CODEX_MODEL,
        displayName: 'Codex',
        models: CODEX_MODELS.map(model => ({
          id: model.id,
          label: model.label,
          description: model.description,
        })),
      }
    case 'gemini':
      return {
        defaultModel: DEFAULT_GEMINI_MODEL,
        displayName: 'Gemini',
        models: GEMINI_MODELS.map(model => ({
          id: model.id,
          label: model.label,
          description: model.description,
        })),
      }
    case 'opencode': {
      const snapshot = await openCodeInventoryService.probe()
      return {
        defaultModel: snapshot.models[0] ?? '',
        displayName: 'OpenCode',
        models: snapshot.models.map(model => ({
          id: model,
          label: model,
          description: 'Discovered from the managed OpenCode inventory probe.',
        })),
      }
    }
    case 'anthropic':
    default:
      return {
        defaultModel: CLAUDE_SONNET_4_6_CONFIG.firstParty,
        displayName: 'Anthropic',
        models: [
          {
            id: CLAUDE_SONNET_4_6_CONFIG.firstParty,
            label: 'Sonnet 4.6',
            description: 'Best for everyday coding tasks',
          },
          {
            id: `${CLAUDE_SONNET_4_6_CONFIG.firstParty}[1m]`,
            label: 'Sonnet 4.6 (1M context)',
            description: 'Long-context Sonnet for large codebases',
          },
          {
            id: CLAUDE_OPUS_4_6_CONFIG.firstParty,
            label: 'Opus 4.6',
            description: 'Most capable for complex work',
          },
          {
            id: `${CLAUDE_OPUS_4_6_CONFIG.firstParty}[1m]`,
            label: 'Opus 4.6 (1M context)',
            description: 'Long-context Opus for complex work',
          },
          {
            id: CLAUDE_HAIKU_4_5_CONFIG.firstParty,
            label: 'Haiku 4.5',
            description: 'Fastest for quick answers',
          },
        ],
      }
  }
}

export async function modelList(opts: {
  json?: boolean
  text?: boolean
  provider?: ModelProviderTarget
}): Promise<void> {
  const providers: InternalModelProvider[] = (() => {
    if (opts.provider === 'all') {
      const allProviders: InternalModelProvider[] = ['anthropic', 'codex', 'opencode']
      if (getAPIProvider() === 'gemini') {
        allProviders.push('gemini')
      }
      return allProviders
    }
    if (opts.provider) {
      return [opts.provider]
    }
    return [getDefaultProvider()]
  })()

  const providerEntries = await Promise.all(
    providers.map(async provider => [provider, await getProviderModels(provider)] as const),
  )

  const output = {
    schemaVersion: 1,
    providers: Object.fromEntries(providerEntries),
  }

  if (opts.text) {
    for (const provider of providers) {
      const details = await getProviderModels(provider)
      process.stdout.write(`${details.displayName}:\n`)
      process.stdout.write(`  default: ${details.defaultModel}\n`)
      for (const model of details.models) {
        process.stdout.write(`  - ${model.id} (${model.label})\n`)
      }
    }
  } else {
    process.stdout.write(jsonStringify(output, null, 2) + '\n')
  }

  process.exit(0)
}
