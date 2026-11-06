import { describe, expect, test } from 'bun:test'

import { createRuntimeStatusCommand, normalizeRuntimeStatusProjectPath } from './runtimeStatusCommand.js'

describe('runtime status project path', () => {
  test('passes a project path with spaces as a single option', async () => {
    let selected: string | undefined
    await createRuntimeStatusCommand(async opts => {
      selected = opts.projectPath
    }).parseAsync([
      '--provider', 'opencode',
      '--project-path', '/Users/TEST/Library/CloudStorage/GoogleDrive/My Portfolio',
      '--json',
    ], { from: 'user' })

    expect(normalizeRuntimeStatusProjectPath(selected)).toBe(
      '/Users/TEST/Library/CloudStorage/GoogleDrive/My Portfolio',
    )
  })

  test('legacy calls retain process cwd selection and invalid paths fail closed', () => {
    expect(normalizeRuntimeStatusProjectPath()).toBeUndefined()
    for (const value of ['', '.', 'relative/project', '/', ' /tmp/.. ']) {
      expect(() => normalizeRuntimeStatusProjectPath(value)).toThrow('absolute, non-root')
    }
  })
})
