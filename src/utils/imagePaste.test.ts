import { describe, expect, test } from 'bun:test'

import { quotePowerShellSingleQuotedString } from './imagePaste.js'

describe('quotePowerShellSingleQuotedString', () => {
  test('escapes single quotes for PowerShell single-quoted strings', () => {
    expect(quotePowerShellSingleQuotedString("C:\\Temp\\user's\\shot.png")).toBe(
      "'C:\\Temp\\user''s\\shot.png'",
    )
  })
})
