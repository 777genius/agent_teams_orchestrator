import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { openCodeExecutionProbe } from './OpenCodeExecutionProbe.js'
import { openCodeHostManager } from './OpenCodeHostManager.js'

const liveTest =
  process.env.OPENCODE_E2E === '1'
    ? test
    : test.skip

describe('OpenCodeExecutionProbe live e2e', () => {
  liveTest('verifies execution on a real OpenCode model', async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), 'opencode-execution-probe-live-'))

    try {
      const result = await openCodeExecutionProbe.probeModel({
        selectedModel: 'opencode/big-pickle',
        projectPath,
      })

      expect(result.outcome).toBe('available')
      expect(result.durableState).toBe('idle')
      expect(result.latestAssistantText?.toUpperCase()).toContain('PONG')
    } finally {
      await openCodeHostManager.reconcilePersistentHosts({
        mode: 'force',
        reason: 'opencode_execution_probe_live_e2e_cleanup',
        projectPath,
        staleAgeMs: 0,
        leaseStaleAgeMs: 0,
        preflightLeaseStaleAgeMs: 0,
      }).catch(() => undefined)
      await rm(projectPath, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 60_000)
})
