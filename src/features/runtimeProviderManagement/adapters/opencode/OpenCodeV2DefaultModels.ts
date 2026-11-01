import { canonicalizeOpenCodeProjectPath } from '../../../../services/opencode/OpenCodeProfileManager.js'
import { readOpenCodeManagedDefaultSelection } from '../../../../services/opencode/OpenCodeManagedDefaultSelection.js'
import { clearOpenCodeManagedDefaultModel, setOpenCodeManagedDefaultModel, setOpenCodeManagedGlobalDefaultModel } from '../../../../services/opencode/OpenCodeManagedPreferences.js'
import { loadOpenCodeV2ProviderModels, testOpenCodeV2ProviderModel } from './OpenCodeV2ProviderManagement.js'
import type { ClearProjectDefaultModelInput, ProviderDirectoryEntry, ProviderManagementResult, ProviderManagementView, SetDefaultModelInput } from '../../domain/types.js'
import type { inspectOpenCodeReadSelection } from '../../../../services/opencode/compatibility/OpenCodeNativeIdentity.js'

/** A saved model is a preference only. It does not mint authentication or launch proof.
 * The passive inventory is credential-free, not a complete selected-account catalog.
 * Absence there must not replace a paid preference with a different model. */
export async function applyOpenCodeV2DefaultSelection(view: ProviderManagementView, nativeDefault: string | null = null): Promise<ProviderManagementView> {
  const project = await canonicalizeOpenCodeProjectPath(view.projectPath)
  const defaults = await readOpenCodeManagedDefaultSelection(project)
  const fallbackModel = nativeDefault ?? view.fallbackModel
  const defaultModel = defaults.defaultModel ?? fallbackModel
  return { ...view, projectPath: project, projectDefaultModel: defaults.projectDefaultModel,
    allProjectsDefaultModel: defaults.allProjectsDefaultModel,
    defaultModel, fallbackModel,
    // The isolated read host's native default is a fallback, not evidence that
    // the user explicitly configured this model in their external OpenCode.
    defaultModelSource: defaults.defaultModelSource ?? (fallbackModel ? 'fallback' : null),
    configuredModels: view.configuredModels.map(model => ({ ...model, default: model.modelId === (defaultModel ?? fallbackModel) })) }
}

/** Provider rows carry the saved preference, even when their scoped model count is
 * unknown. Runtime modelCatalog.defaultModelId instead marks a listed display row. */
export async function applyOpenCodeV2DirectoryDefaultSelection(entries: ProviderDirectoryEntry[], projectPath: string): Promise<ProviderDirectoryEntry[]> {
  const project = await canonicalizeOpenCodeProjectPath(projectPath)
  const { defaultModel } = await readOpenCodeManagedDefaultSelection(project)
  if (!defaultModel) return entries
  return entries.map(entry => ({ ...entry,
    defaultModelId: defaultModel.startsWith(`${entry.providerId}/`) ? defaultModel : null }))
}

const error = (code: 'model-missing' | 'model-test-failed' | 'runtime-unhealthy', message: string): ProviderManagementResult<ProviderManagementView> =>
  ({ ok: false, error: { code, message, recoverable: true } })
type ReadView = () => Promise<ProviderManagementResult<ProviderManagementView>>

export async function setOpenCodeV2DefaultModel(input: SetDefaultModelInput, readView: ReadView,
  selectedRead?: Awaited<ReturnType<typeof inspectOpenCodeReadSelection>>): Promise<ProviderManagementResult<ProviderManagementView>> {
  try {
    const projectPath = await canonicalizeOpenCodeProjectPath(input.projectPath)
    const catalog = await loadOpenCodeV2ProviderModels({ ...input, projectPath, limit: null }, selectedRead)
    if (!catalog.ok) return catalog
    const model = catalog.value.models.find(row => row.modelId === input.modelId)
    if (!model || model.catalogStatus === 'deprecated' || model.availability === 'unavailable') {
      return error('model-missing', 'Select an enabled model from the current OpenCode provider catalog.')
    }
    if (input.probe !== false) {
      const tested = await testOpenCodeV2ProviderModel({ ...input, projectPath })
      if (!tested.ok) return tested
      if (!tested.value.ok) return error('model-test-failed', tested.value.message)
    }
    // Capture a display view before committing, and distinguish any subsequent
    // refresh failure from failure to persist the preference itself.
    const view = await readView()
    if (!view.ok) return view
    const defaults = await readOpenCodeManagedDefaultSelection(projectPath)
    if (input.scope === 'all_projects') await setOpenCodeManagedGlobalDefaultModel(defaults.dataRoot, input.modelId)
    else await setOpenCodeManagedDefaultModel(defaults.profileRoot, input.modelId)
    try {
      // The pre-write view excludes paid catalog models that were not configured
      // yet. Reuse this request's validated row without another native read.
      const configuredModels = view.value.configuredModels.some(row => row.modelId === model.modelId)
        ? view.value.configuredModels : [...view.value.configuredModels, model]
      return { ok: true, value: await applyOpenCodeV2DefaultSelection({ ...view.value, configuredModels }, view.value.fallbackModel) }
    } catch {
      return error('runtime-unhealthy', 'The OpenCode default model was saved, but the provider view could not be refreshed. Refresh providers to see the current default.')
    }
  } catch {
    return error('runtime-unhealthy', 'The OpenCode default model could not be saved. Refresh providers and try again.')
  }
}

export async function clearOpenCodeV2ProjectDefaultModel(input: ClearProjectDefaultModelInput,
  readView: ReadView): Promise<ProviderManagementResult<ProviderManagementView>> {
  try {
    const projectPath = await canonicalizeOpenCodeProjectPath(input.projectPath)
    const view = await readView()
    if (!view.ok) return view
    const defaults = await readOpenCodeManagedDefaultSelection(projectPath)
    await clearOpenCodeManagedDefaultModel(defaults.profileRoot)
    try {
      return { ok: true, value: await applyOpenCodeV2DefaultSelection(view.value, view.value.fallbackModel) }
    } catch {
      return error('runtime-unhealthy', 'The project OpenCode default was cleared, but the provider view could not be refreshed. Refresh providers to see the current default.')
    }
  } catch {
    return error('runtime-unhealthy', 'The project OpenCode default could not be cleared. Refresh providers and try again.')
  }
}
