import { describe, expect, it } from 'bun:test'
import { join } from 'path'
import {
  buildProviderSkillOverlayRoots,
  isCodexEntryProvider,
} from './providerSkillRootsCore.js'

describe('providerSkillRootsCore', () => {
  it('disables provider overlays outside codex entry sessions', () => {
    expect(isCodexEntryProvider('anthropic')).toBe(false)
    expect(
      buildProviderSkillOverlayRoots({
        entryProvider: 'anthropic',
        codexHomeDir: '/Users/me/.codex',
        projectSkillsDirs: ['/tmp/project/.codex/skills'],
        additionalDirs: ['/tmp/add-dir'],
      }),
    ).toEqual({
      userSkillsDirs: [],
      projectSkillsDirs: [],
      additionalSkillsDirs: [],
    })
  })

  it('returns codex overlay roots for user, project, and add-dir locations', () => {
    expect(
      buildProviderSkillOverlayRoots({
        entryProvider: 'codex',
        codexHomeDir: '/Users/me/.codex',
        projectSkillsDirs: ['/tmp/repo/.codex/skills'],
        additionalDirs: ['/tmp/add-dir'],
      }),
    ).toEqual({
      userSkillsDirs: [join('/Users/me/.codex', 'skills')],
      projectSkillsDirs: ['/tmp/repo/.codex/skills'],
      additionalSkillsDirs: [join('/tmp/add-dir', '.codex', 'skills')],
    })
  })
})
