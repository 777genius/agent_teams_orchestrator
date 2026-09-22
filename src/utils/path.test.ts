import { afterEach, describe, expect, test } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'

import { expandPath } from './path.js'
import { getPlatform } from './platform.js'

const originalPlatform = process.platform

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
  })
}

function clearPlatformCache(): void {
  const cached = getPlatform as typeof getPlatform & {
    cache?: { clear?: () => void }
  }
  cached.cache?.clear?.()
}

describe('expandPath', () => {
  afterEach(() => {
    setPlatform(originalPlatform)
    clearPlatformCache()
  })

  test('expands Windows backslash home paths', () => {
    setPlatform('win32')
    clearPlatformCache()

    expect(expandPath('~\\Documents')).toBe(
      join(homedir(), 'Documents').normalize('NFC'),
    )
  })
})
