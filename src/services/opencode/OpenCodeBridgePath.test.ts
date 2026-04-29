import { describe, expect, test } from 'bun:test'

import {
  areSameOpenCodeWorkspace,
  isOpenCodeWorkspaceSameOrDescendant,
  normalizeOpenCodeFilePath,
} from './OpenCodeBridgePath.js'

describe('OpenCodeBridgePath', () => {
  test('normalizes POSIX project-relative paths without escaping workspace root', () => {
    expect(
      normalizeOpenCodeFilePath({
        projectPath: '/repo',
        filePath: 'src/index.ts',
      }),
    ).toMatchObject({
      absolutePath: '/repo/src/index.ts',
      comparisonKey: '/repo/src/index.ts',
      relativePath: 'src/index.ts',
      style: 'posix',
    })

    expect(
      normalizeOpenCodeFilePath({
        projectPath: '/repo',
        filePath: '../outside.ts',
      }),
    ).toMatchObject({
      skipped: true,
      diagnostic: 'OpenCode filePath is outside projectPath.',
    })
  })

  test('normalizes Windows drive paths case-insensitively', () => {
    expect(
      normalizeOpenCodeFilePath({
        projectPath: 'C:\\Repo',
        filePath: 'C:\\Repo\\Src\\Index.ts',
      }),
    ).toMatchObject({
      absolutePath: 'C:\\Repo\\Src\\Index.ts',
      comparisonKey: 'c:/repo/src/index.ts',
      relativePath: 'Src/Index.ts',
      style: 'win32',
    })

    expect(
      areSameOpenCodeWorkspace({
        expectedWorkspaceRoot: 'C:\\Repo',
        recordProjectPath: 'c:/repo/',
      }),
    ).toBe(true)

    expect(
      isOpenCodeWorkspaceSameOrDescendant({
        parentWorkspaceRoot: 'C:\\Repo',
        childPath: 'c:/repo/src',
      }),
    ).toBe(true)

    expect(
      isOpenCodeWorkspaceSameOrDescendant({
        parentWorkspaceRoot: 'C:\\Repo',
        childPath: 'D:/repo/src',
      }),
    ).toBe(false)
  })

  test('rejects device paths and mixed absolute path styles', () => {
    expect(
      normalizeOpenCodeFilePath({
        projectPath: '\\\\?\\C:\\Repo',
        filePath: 'src/index.ts',
      }),
    ).toMatchObject({
      skipped: true,
      diagnostic: 'OpenCode device paths are not supported by ledger backfill.',
    })

    expect(
      normalizeOpenCodeFilePath({
        projectPath: '/repo',
        filePath: 'C:\\Repo\\src\\index.ts',
      }),
    ).toMatchObject({
      skipped: true,
      diagnostic: 'OpenCode filePath style does not match projectPath style.',
    })
  })
})
