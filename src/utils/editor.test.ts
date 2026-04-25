import { describe, expect, test } from 'bun:test'

import { buildWindowsEditorCommand, classifyGuiEditor } from './editor.js'

describe('classifyGuiEditor', () => {
  test('handles quoted Windows editor paths with spaces', () => {
    expect(
      classifyGuiEditor(
        '"C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd" --wait',
      ),
    ).toBe('code')
  })
})

describe('buildWindowsEditorCommand', () => {
  test('keeps percent signs literal in cmd.exe command strings', () => {
    const command = buildWindowsEditorCommand(
      ['start', '/wait', 'notepad'],
      ['C:\\Users\\Alice\\a%PATH%b.txt'],
    )

    expect(command).toContain('"C:\\Users\\Alice\\a"^%"PATH"^%"b.txt"')
    expect(command).not.toContain('%PATH%')
    expect(command).not.toContain('%%PATH%%')
  })
})
