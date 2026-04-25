import { describe, expect, test } from 'bun:test'

import { cmdQuote } from './terminalLauncher.js'

describe('cmdQuote', () => {
  test('keeps percent signs literal in cmd.exe command strings', () => {
    const quoted = cmdQuote('C:\\Users\\Alice\\a%PATH%b.txt')

    expect(quoted).toContain('"C:\\Users\\Alice\\a"^%"PATH"^%"b.txt"')
    expect(quoted).not.toContain('%PATH%')
    expect(quoted).not.toContain('%%PATH%%')
  })
})
