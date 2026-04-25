import { describe, expect, test } from 'bun:test'

import { resolveExportFilePath } from './exportPath.js'

describe('resolveExportFilePath', () => {
  test('keeps export filenames inside cwd', () => {
    expect(resolveExportFilePath('C:\\repo', 'conversation', 'win32')).toBe(
      'C:\\repo\\conversation.txt',
    )
  })

  test('rejects path traversal and absolute filenames', () => {
    expect(() =>
      resolveExportFilePath('C:\\repo', '..\\outside.txt', 'win32'),
    ).toThrow('file name, not a path')
    expect(() =>
      resolveExportFilePath('C:\\repo', 'D:\\outside.txt', 'win32'),
    ).toThrow('file name, not a path')
  })

  test('rejects Windows ADS and reserved names', () => {
    expect(() =>
      resolveExportFilePath('C:\\repo', 'report:secret.txt', 'win32'),
    ).toThrow('invalid Windows characters')
    expect(() =>
      resolveExportFilePath('C:\\repo', 'CON.txt', 'win32'),
    ).toThrow('reserved on Windows')
  })
})
