import { describe, expect, test } from 'bun:test'

import { isOutputRelativePathInside } from './filePersistence.js'

describe('filePersistence output containment', () => {
  test('rejects Windows cross-drive relative paths', () => {
    if (process.platform !== 'win32') {
      expect(true).toBe(true)
      return
    }

    expect(isOutputRelativePathInside('D:\\other\\file.txt')).toBe(false)
  })

  test('keeps regular output-relative paths', () => {
    expect(isOutputRelativePathInside('images\\result.png')).toBe(true)
    expect(isOutputRelativePathInside('..\\outside.txt')).toBe(false)
  })
})
