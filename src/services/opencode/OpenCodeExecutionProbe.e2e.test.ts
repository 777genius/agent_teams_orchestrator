import { describe, expect, test } from 'bun:test'

import { openCodeExecutionProbe } from './OpenCodeExecutionProbe.js'

const liveTest =
  process.env.OPENCODE_E2E === '1'
    ? test
    : test.skip

describe('OpenCodeExecutionProbe live e2e', () => {
  liveTest('verifies execution on a real OpenCode model', async () => {
    const result = await openCodeExecutionProbe.probeModel({
      selectedModel: 'opencode/big-pickle',
      projectPath: process.cwd(),
    })

    expect(result.outcome).toBe('available')
    expect(result.durableState).toBe('idle')
    expect(result.latestAssistantText?.toUpperCase()).toContain('PONG')
  }, 60_000)
})
