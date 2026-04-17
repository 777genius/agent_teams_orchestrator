import { homedir } from 'os'
import { join } from 'path'
import {
  buildProviderSkillOverlayRoots,
  type ProviderSkillOverlayRoots,
} from './providerSkillRootsCore.js'
import { getConfigDirsUpToHome } from '../utils/markdownConfigLoader.js'

export function getCodexConfigHomeDir(): string {
  return join(homedir(), '.codex').normalize('NFC')
}

export function getProviderSkillOverlayRoots(
  cwd: string,
  additionalDirs: readonly string[],
): ProviderSkillOverlayRoots {
  return buildProviderSkillOverlayRoots({
    entryProvider: process.env.CLAUDE_CODE_ENTRY_PROVIDER,
    codexHomeDir: getCodexConfigHomeDir(),
    projectSkillsDirs: getConfigDirsUpToHome('.codex', 'skills', cwd),
    additionalDirs,
  })
}
