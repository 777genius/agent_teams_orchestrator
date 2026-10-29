import { canonicalizeOpenCodeProjectPath } from '../../../../services/opencode/OpenCodeProfileManager.js'
import { readOpenCodeManagedDefaultSelection } from '../../../../services/opencode/OpenCodeManagedDefaultSelection.js'
import { clearOpenCodeManagedDefaultModel, setOpenCodeManagedDefaultModel, setOpenCodeManagedGlobalDefaultModel } from '../../../../services/opencode/OpenCodeManagedPreferences.js'
import { loadOpenCodeV2ProviderModels, testOpenCodeV2ProviderModel } from './OpenCodeV2ProviderManagement.js'
import type { ClearProjectDefaultModelInput, ProviderManagementResult, ProviderManagementView, SetDefaultModelInput } from '../../domain/types.js'
import type { inspectOpenCodeReadSelection } from '../../../../services/opencode/compatibility/OpenCodeNativeIdentity.js'

/** A saved model is a preference only. It does not mint authentication or launch proof. */
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
    // Capture a display view before committing; a subsequent catalog outage must
    // not turn a successfully saved preference into an apparent failed mutation.
    const view = await readView()
    if (!view.ok) return view
    const defaults = await readOpenCodeManagedDefaultSelection(projectPath)
    if (input.scope === 'all_projects') await setOpenCodeManagedGlobalDefaultModel(defaults.dataRoot, input.modelId)
    else await setOpenCodeManagedDefaultModel(defaults.profileRoot, input.modelId)
    return { ok: true, value: await applyOpenCodeV2DefaultSelection(view.value, view.value.fallbackModel) }
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
    return { ok: true, value: await applyOpenCodeV2DefaultSelection(view.value, view.value.fallbackModel) }
  } catch {
    return error('runtime-unhealthy', 'The project OpenCode default could not be cleared. Refresh providers and try again.')
  }
}
