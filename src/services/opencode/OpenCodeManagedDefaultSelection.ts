import { createHash } from 'node:crypto'
import path from 'node:path'
import { resolveClaudeMultimodelPaths } from './OpenCodeManagedPaths.js'
import { readOpenCodeGlobalManagedRuntimePreferences, readOpenCodeManagedRuntimePreferences } from './OpenCodeManagedPreferences.js'

/** The canonical project's existing preference location is shared by V1 and V2. */
export function openCodeProjectPreferencesRoot(projectPath: string, dataRoot = resolveClaudeMultimodelPaths().data): string {
  return path.join(dataRoot, 'opencode', 'profiles', createHash('sha256').update(projectPath).digest('hex').slice(0, 16))
}

export async function readOpenCodeManagedDefaultSelection(projectPath: string) {
  const dataRoot = resolveClaudeMultimodelPaths().data
  const profileRoot = openCodeProjectPreferencesRoot(projectPath, dataRoot)
  const [project, global] = await Promise.all([
    readOpenCodeManagedRuntimePreferences(profileRoot), readOpenCodeGlobalManagedRuntimePreferences(dataRoot),
  ])
  return { profileRoot, dataRoot, projectDefaultModel: project.defaultModelId,
    allProjectsDefaultModel: global.defaultModelId,
    defaultModel: project.defaultModelId ?? global.defaultModelId,
    defaultModelSource: project.defaultModelId ? 'project' as const : global.defaultModelId ? 'all_projects' as const : null }
}
