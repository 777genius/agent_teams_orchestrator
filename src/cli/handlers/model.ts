/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import { DEFAULT_CODEX_MODEL } from '../../utils/model/codex.js'
import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_MODELS,
} from '../../utils/model/gemini.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { openCodeInventoryService } from '../../services/opencode/OpenCodeInventoryService.js'
import { readOpenCodeManagedDefaultSelection } from '../../services/opencode/OpenCodeManagedDefaultSelection.js'
import {
  filterOpenCodeAgentModels,
  selectOpenCodeDefaultAgentModel,
} from '../../services/opencode/OpenCodeAgentModelCompatibility.js'
import { getAnthropicRuntimeModelCatalog } from '../../services/runtimeBackends/anthropicCatalog.js'
import { getAnthropicDefaultLaunchModel } from '../../services/runtimeBackends/effectiveDefaultModel.js'
import { getCodexRuntimeModelCatalog } from '../../services/runtimeBackends/codexModelCatalog.js'
import { jsonStringify } from '../../utils/slowOperations.js'

import type { OpenCodeInventorySnapshot } from '../../services/opencode/types.js'

const STDOUT_DRAIN_FALLBACK_TIMEOUT_MS = 2_000

type ModelProviderTarget = 'anthropic' | 'codex' | 'gemini' | 'opencode' | 'all'
export type InternalModelProvider = Exclude<ModelProviderTarget, 'all'>

type ModelSummary = {
  id: string
  label: string
  description: string
}

type ModelListDeps = {
  getCodexModelCatalog?: typeof getCodexRuntimeModelCatalog
  getOpenCodeInventorySnapshot?: () => Promise<OpenCodeInventorySnapshot>
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

export async function getProviderModels(
  provider: InternalModelProvider,
  deps: ModelListDeps = {},
): Promise<{
  defaultModel: string
  displayName: string
  models: ModelSummary[]
}> {
  switch (provider) {
    case 'codex': {
      const catalog = await (deps.getCodexModelCatalog ?? getCodexRuntimeModelCatalog)()
      const models = catalog.models
        .filter(model => !model.hidden)
        .map(model => ({
          id: model.launchModel,
          label: model.displayName,
          description:
            model.statusMessage ??
            (catalog.source === 'app-server'
              ? 'Discovered from the Codex app-server model catalog.'
              : 'Static fallback Codex launch value.'),
        }))
      return {
        defaultModel: catalog.defaultLaunchModel ?? DEFAULT_CODEX_MODEL,
        displayName: 'Codex',
        models,
      }
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
      const snapshot = await (
        deps.getOpenCodeInventorySnapshot ?? (() => openCodeInventoryService.probe())
      )()
      const models = filterOpenCodeAgentModels(snapshot.models, snapshot.modelMetadata)
      const managedDefault = snapshot.readGeneration === 'v2' && snapshot.readStatus?.catalog === 'ready'
        ? (await readOpenCodeManagedDefaultSelection(snapshot.projectPath)).defaultModel : null
      const nativeDefault = snapshot.readStatus?.defaultModel
      return {
        defaultModel: managedDefault ?? (nativeDefault ? `${nativeDefault.providerId}/${nativeDefault.catalogId}` : null)
          ?? selectOpenCodeDefaultAgentModel(models) ?? '',
        displayName: 'OpenCode',
        models: models.map(model => ({
          id: model,
          label: model,
          description: 'Discovered from the managed OpenCode inventory probe.',
        })),
      }
    }
    case 'anthropic':
    default:
      {
        const catalog = await getAnthropicRuntimeModelCatalog()
        return {
          defaultModel: getAnthropicDefaultLaunchModel(catalog) ?? catalog.defaultLaunchModel ?? 'opus[1m]',
          displayName: 'Anthropic',
          models: catalog.models.map((model) => ({
            id: model.launchModel,
            label: model.displayName,
            description:
              model.statusMessage
              ?? (model.hidden
                ? 'Anthropic compatibility launch value preserved for persisted team selections.'
                : 'Anthropic launch value normalized from the runtime-backed model catalog.'),
          })),
        }
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
    let textOutput = ''
    for (const [, details] of providerEntries) {
      textOutput += `${details.displayName}:\n`
      textOutput += `  default: ${details.defaultModel}\n`
      for (const model of details.models) {
        textOutput += `  - ${model.id} (${model.label})\n`
      }
    }
    await writeStdoutAndDrain(textOutput)
  } else {
    await writeStdoutAndDrain(jsonStringify(output, null, 2) + '\n')
  }

  process.exit(0)
}

function writeStdoutAndDrain(payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let onDrain: (() => void) | null = null
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (onDrain) {
        process.stdout.off('drain', onDrain)
        onDrain = null
      }
    }
    const finish = (error?: Error | null) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (error) {
        reject(error)
        return
      }
      resolve()
    }
    onDrain = () => finish()
    timer = setTimeout(() => finish(), STDOUT_DRAIN_FALLBACK_TIMEOUT_MS)
    timer.unref?.()
    process.stdout.once('drain', onDrain)
    process.stdout.write(payload, error => {
      finish(error)
    })
  })
}
