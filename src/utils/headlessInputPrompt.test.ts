import { describe, expect, test } from 'bun:test'

import { shouldBypassStdinForHeadlessTeammateTextInput } from './headlessInputPrompt.js'

describe('headless teammate input prompt handling', () => {
  test('bypasses stdin for explicit headless teammate text input', () => {
    expect(
      shouldBypassStdinForHeadlessTeammateTextInput({
        inputFormat: 'text',
        isHeadlessTeammateRuntime: true,
      }),
    ).toBe(true)
  })

  test('keeps env fallback for headless teammate text input', () => {
    expect(
      shouldBypassStdinForHeadlessTeammateTextInput({
        inputFormat: 'text',
        teammateRuntimeEnv: 'headless',
      }),
    ).toBe(true)
  })

  test('does not bypass stdin for non-headless text input', () => {
    expect(
      shouldBypassStdinForHeadlessTeammateTextInput({
        inputFormat: 'text',
      }),
    ).toBe(false)
  })

  test('does not bypass stdin for stream-json sessions', () => {
    expect(
      shouldBypassStdinForHeadlessTeammateTextInput({
        inputFormat: 'stream-json',
        isHeadlessTeammateRuntime: true,
        teammateRuntimeEnv: 'headless',
      }),
    ).toBe(false)
  })
})
