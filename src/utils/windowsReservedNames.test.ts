import { describe, expect, test } from 'bun:test'

import {
  isWindowsReservedBasename,
  safeWindowsPathSegment,
} from './windowsReservedNames.js'

describe('windowsReservedNames', () => {
  test('detects reserved device basenames before extensions', () => {
    expect(isWindowsReservedBasename('con')).toBe(true)
    expect(isWindowsReservedBasename('NUL.txt')).toBe(true)
    expect(isWindowsReservedBasename('com1.json')).toBe(true)
    expect(isWindowsReservedBasename('lpt9.')).toBe(true)
    expect(isWindowsReservedBasename('project')).toBe(false)
  })

  test('prefixes reserved path segments when sanitizing fallback paths', () => {
    expect(safeWindowsPathSegment('con')).toBe('_con')
    expect(safeWindowsPathSegment('project')).toBe('project')
  })
})
