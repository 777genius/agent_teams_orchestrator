import { describe, expect, test } from 'bun:test'

import { shouldUseOpenCodePassiveProviderDirectoryFastPath } from './runtimeProvidersPassiveFastPath.js'

describe('runtime provider-directory passive fast-path selection', () => {
  test('accepts only the default or explicit OpenCode runtime', () => {
    expect(shouldUseOpenCodePassiveProviderDirectoryFastPath({
      command: 'directory', summary: true, runtime: undefined,
    })).toBe(true)
    expect(shouldUseOpenCodePassiveProviderDirectoryFastPath({
      command: 'directory', summary: true, runtime: 'opencode',
    })).toBe(true)
    for (const runtime of ['codex', 'anthropic', 'gemini', 'unknown']) {
      expect(shouldUseOpenCodePassiveProviderDirectoryFastPath({
        command: 'directory', summary: true, runtime,
      })).toBe(false)
    }
  })
})
