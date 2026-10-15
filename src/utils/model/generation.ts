import { getUserSpecifiedModelSetting, parseUserSpecifiedModel } from './model.js'
import type { ModelSetting } from './model.js'

/** Bind conditional alias policy to the selection that produced this model. */
export function resolveGenerationModelSetting(
  generationModel: string,
  configuredModel: ModelSetting | undefined = getUserSpecifiedModelSetting(),
  isSubagent = false,
): ModelSetting {
  return !isSubagent && configuredModel != null &&
    parseUserSpecifiedModel(configuredModel) === generationModel
    ? configuredModel
    : generationModel
}
