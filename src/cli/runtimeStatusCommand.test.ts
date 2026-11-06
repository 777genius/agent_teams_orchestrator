import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'bun:test'

import { createRuntimeStatusCommand, normalizeRuntimeStatusProjectPath } from './runtimeStatusCommand.js'

describe('runtime status project path', () => {
  test('passes a project path with spaces as a single option', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'TEST-status-'))
    const selected = path.join(root, 'Library', 'CloudStorage', 'My Portfolio')
    try {
      await mkdir(selected, { recursive: true })
      let passed: string | undefined
      await createRuntimeStatusCommand(async opts => {
        passed = opts.projectPath
      }).parseAsync(['--provider', 'opencode', '--project-path', selected, '--json'], { from: 'user' })
      expect(await normalizeRuntimeStatusProjectPath(passed)).toBe(selected)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps legacy calls and rejects invalid, root, and missing project paths', async () => {
    expect(await normalizeRuntimeStatusProjectPath()).toBeUndefined()
    for (const value of ['', '.', 'relative/project', path.parse(process.cwd()).root]) {
      await expect(normalizeRuntimeStatusProjectPath(value)).rejects.toThrow('absolute, non-root')
    }
    const root = await mkdtemp(path.join(tmpdir(), 'TEST-status-missing-'))
    try {
      await expect(normalizeRuntimeStatusProjectPath(path.join(root, 'missing')))
        .rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
