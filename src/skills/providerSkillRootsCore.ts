import { join } from 'path'

export interface ProviderSkillOverlayRoots {
  userSkillsDirs: string[]
  projectSkillsDirs: string[]
  additionalSkillsDirs: string[]
}

export function isCodexEntryProvider(entryProvider = process.env.CLAUDE_CODE_ENTRY_PROVIDER): boolean {
  return entryProvider?.trim().toLowerCase() === 'codex'
}

export function buildProviderSkillOverlayRoots(options: {
  entryProvider?: string
  codexHomeDir: string
  projectSkillsDirs: string[]
  additionalDirs: readonly string[]
}): ProviderSkillOverlayRoots {
  const { entryProvider, codexHomeDir, projectSkillsDirs, additionalDirs } = options
  if (!isCodexEntryProvider(entryProvider)) {
    return {
      userSkillsDirs: [],
      projectSkillsDirs: [],
      additionalSkillsDirs: [],
    }
  }

  return {
    userSkillsDirs: [join(codexHomeDir, 'skills')],
    projectSkillsDirs,
    additionalSkillsDirs: additionalDirs.map(dir => join(dir, '.codex', 'skills')),
  }
}
