import { describe, expect, test } from 'bun:test'

import { getHeadlessTeammateRenderOptions } from './renderOptions.js'

describe('headless teammate render options', () => {
  test('routes Ink output to a non-TTY discard stream', () => {
    const onFrame = (): void => {}
    const options = getHeadlessTeammateRenderOptions({
      exitOnCtrlC: false,
      stderr: process.stderr,
      onFrame,
    })

    expect(options.stdout).toBeDefined()
    expect(options.stdout).not.toBe(process.stdout)
    expect((options.stdout as { isTTY?: boolean }).isTTY).toBe(false)
    expect((options.stdout as { columns?: number }).columns).toBeGreaterThan(0)
    expect((options.stdout as { rows?: number }).rows).toBeGreaterThan(0)
    expect(options.patchConsole).toBe(false)
    expect(options.stderr).toBe(process.stderr)
    expect(options.onFrame).toBe(onFrame)
  })
})
