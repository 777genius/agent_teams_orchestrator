import { describe, expect, test } from 'bun:test'

import {
  parseGitNameStatusZ,
  parseGitStatusPorcelainZ,
} from './GitChangePathProvider.js'

describe('GitChangePathProvider parsers', () => {
  test('parses porcelain modify/create/delete records', () => {
    const result = parseGitStatusPorcelainZ(' M src/a.ts\0A  src/b.ts\0 D src/c.ts\0')

    expect([...result.paths].sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
    expect(result.warnings).toEqual([])
  })

  test('parses porcelain rename and copy relation records', () => {
    const result = parseGitStatusPorcelainZ(
      'R  src/new.ts\0src/old.ts\0C  src/copy.ts\0src/base.ts\0',
    )

    expect(result.entries.get('src/new.ts')?.relation).toEqual({
      kind: 'rename',
      oldPath: 'src/old.ts',
      newPath: 'src/new.ts',
    })
    expect(result.entries.get('src/old.ts')?.relation).toEqual({
      kind: 'rename',
      oldPath: 'src/old.ts',
      newPath: 'src/new.ts',
    })
    expect(result.entries.get('src/copy.ts')?.relation).toEqual({
      kind: 'copy',
      oldPath: 'src/base.ts',
      newPath: 'src/copy.ts',
    })
  })

  test('preserves spaces, unicode, and newlines in NUL-delimited paths', () => {
    const result = parseGitStatusPorcelainZ(' M src/a file.ts\0 M src/юникод.ts\0 M src/a\nb.ts\0')

    expect(result.paths.has('src/a file.ts')).toBe(true)
    expect(result.paths.has('src/юникод.ts')).toBe(true)
    expect(result.paths.has('src/a\nb.ts')).toBe(true)
  })

  test('caps parsed paths without throwing', () => {
    const result = parseGitStatusPorcelainZ(' M a\0 M b\0 M c\0', {
      maxPaths: 2,
      label: 'status-test',
    })

    expect([...result.paths]).toEqual(['a', 'b'])
    expect(result.warnings.some(warning => warning.includes('path cap reached'))).toBe(true)
  })

  test('warns on malformed trailing record', () => {
    const result = parseGitStatusPorcelainZ(' M a\0 M partial', {
      label: 'status-test',
    })

    expect(result.paths.has('a')).toBe(true)
    expect(result.paths.has('partial')).toBe(false)
    expect(result.warnings.some(warning => warning.includes('partial record'))).toBe(true)
  })

  test('skips truncated name-status records', () => {
    const result = parseGitNameStatusZ('M\0src/changed.ts\0A\0src/partial', {
      label: 'diff-test',
    })

    expect(result.paths.has('src/changed.ts')).toBe(true)
    expect(result.paths.has('src/partial')).toBe(false)
    expect(result.warnings.some(warning => warning.includes('partial record'))).toBe(true)
  })

  test('parses name-status rename records in old-to-new order', () => {
    const result = parseGitNameStatusZ('R100\0src/old.ts\0src/new.ts\0M\0src/changed.ts\0')

    expect(result.entries.get('src/new.ts')?.relation).toEqual({
      kind: 'rename',
      oldPath: 'src/old.ts',
      newPath: 'src/new.ts',
    })
    expect(result.paths.has('src/changed.ts')).toBe(true)
  })
})
