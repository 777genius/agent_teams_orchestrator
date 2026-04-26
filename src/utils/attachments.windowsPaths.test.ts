import { describe, expect, test } from 'bun:test'

import { getDirectoriesToProcess } from './attachments.js'

describe('getDirectoriesToProcess Windows containment', () => {
  test('does not treat prefix sibling paths as nested under cwd', () => {
    if (process.platform !== 'win32') {
      expect(true).toBe(true)
      return
    }

    const result = getDirectoriesToProcess(
      'C:\\repo2\\sub\\file.ts',
      'C:\\repo',
    )

    expect(result.nestedDirs).toEqual([])
  })

  test('keeps normal nested Windows paths and ignores drive-letter case', () => {
    if (process.platform !== 'win32') {
      expect(true).toBe(true)
      return
    }

    const result = getDirectoriesToProcess(
      'c:\\repo\\sub\\file.ts',
      'C:\\Repo',
    )

    expect(result.nestedDirs).toEqual(['c:\\repo\\sub'])
  })
})
