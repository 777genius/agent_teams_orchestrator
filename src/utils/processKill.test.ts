import { describe, expect, test } from 'bun:test'

import { buildWindowsTaskkillInvocation, isProcessAlive } from './processKill.js'

describe('processKill', () => {
  test('builds a Windows process-tree kill invocation', () => {
    const invocation = buildWindowsTaskkillInvocation(1234)

    expect(invocation.command.toLowerCase()).toContain('taskkill.exe')
    expect(invocation.args).toEqual(['/T', '/F', '/PID', '1234'])
  })

  test('treats invalid pids as not alive', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
  })
})
