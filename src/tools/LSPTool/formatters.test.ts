import { describe, expect, test } from 'bun:test'

import { formatUri } from './formatters.js'

describe('formatUri', () => {
  test('converts Windows file URLs through URL APIs', () => {
    const formatted = formatUri('file:///C:/Repo/My%20File.ts')

    if (process.platform === 'win32') {
      expect(formatted).toBe('C:/Repo/My File.ts')
    } else {
      expect(formatted).toBe('/C:/Repo/My File.ts')
    }
  })

  test('preserves UNC file URLs on Windows', () => {
    const formatted = formatUri('file://server/share/My%20File.ts')

    if (process.platform === 'win32') {
      expect(formatted).toBe('//server/share/My File.ts')
    } else {
      expect(formatted).toBe('server/share/My%20File.ts')
    }
  })
})
