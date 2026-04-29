import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { openCodeHostManager } from './OpenCodeHostManager.js'
import { openCodeInventoryService } from './OpenCodeInventoryService.js'
import {
  FileOpenCodeRuntimeTurnSettledEmitter,
  RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV,
} from './OpenCodeRuntimeTurnSettledEmitter.js'
import { openCodeSessionBridge } from './OpenCodeSessionBridge.js'
import { openCodeSessionStore } from './OpenCodeSessionStore.js'
import { OpenCodeTurnSettledEmissionCoordinator } from './OpenCodeTurnSettledEmissionCoordinator.js'

const liveTest =
  process.env.OPENCODE_E2E === '1' && process.env.OPENCODE_TURN_SETTLED_LIVE === '1'
    ? test
    : test.skip

const PREFERRED_LIVE_MODELS = [
  process.env.OPENCODE_TURN_SETTLED_LIVE_MODEL,
  'opencode/gpt-5-nano',
  'opencode/minimax-m2.5-free',
].filter((model): model is string => Boolean(model?.trim()))

let tempDir = ''

function buildUniqueIdentity(prefix: string): {
  teamId: string
  laneId: string
  memberName: string
} {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const memberName = `alice-${nonce}`
  return {
    teamId: `${prefix}-${nonce}`,
    laneId: `secondary:opencode:${memberName}`,
    memberName,
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
    }
  }
}

async function getLiveModel(): Promise<string> {
  const inventory = await openCodeInventoryService.probe()
  if (!inventory.detected) {
    throw new Error('OpenCode CLI is not available for live turn-settled e2e')
  }

  const preferred = PREFERRED_LIVE_MODELS.find(model => inventory.models.includes(model))
    ?? inventory.models.find(model => model.startsWith('opencode/'))
    ?? inventory.models[0]
  if (!preferred) {
    throw new Error('No OpenCode model is available for live turn-settled e2e')
  }
  return preferred
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = ''
  }
})

describe('OpenCode turn-settled observer live e2e', () => {
  liveTest('observes a real prompt_async turn and writes one durable spool event', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-turn-settled-live-'))
    const spoolRoot = path.join(tempDir, 'runtime-turn-settled')
    const selectedModel = await getLiveModel()
    const identity = buildUniqueIdentity('opencode-turn-settled-live')
    const record = await withTimeout(
        openCodeSessionBridge.ensureSession({
          ...identity,
          selectedModel,
          projectPath: tempDir,
        }),
      30_000,
      'ensureSession',
    )

    try {
      const prompted = await withTimeout(
        openCodeSessionBridge.promptAsyncWithTurnSettled(record, {
          text: 'Reply with exactly OK.',
          agent: 'teammate',
          timeoutMs: 20_000,
          idleTimeoutMs: 2_500,
        }),
        35_000,
        'promptAsyncWithTurnSettled',
      )
      expect(['success', 'error']).toContain(prompted.turnSettled.outcome)
      expect(prompted.runtimePromptMessageId.startsWith('msg_')).toBe(true)

      const reconciled = await withTimeout(
        openCodeSessionBridge.reconcileSession(record, { limit: 50 }),
        20_000,
        'reconcileSession',
      )
      const coordinator = new OpenCodeTurnSettledEmissionCoordinator({
        now: () => new Date('2026-04-29T12:00:00.000Z'),
        emitter: new FileOpenCodeRuntimeTurnSettledEmitter({
          [RUNTIME_TURN_SETTLED_SPOOL_ROOT_ENV]: spoolRoot,
        } as NodeJS.ProcessEnv),
      })

      await coordinator.emitDelivery({
        record: reconciled.record,
        runtimePromptMessageId: prompted.runtimePromptMessageId,
        turnSettled: prompted.turnSettled,
        reconcileSummary: reconciled.summary,
      })

      const files = await readdir(path.join(spoolRoot, 'incoming'))
      expect(files).toHaveLength(1)
      expect(files[0]?.endsWith('.opencode.json')).toBe(true)

      const event = JSON.parse(await readFile(path.join(spoolRoot, 'incoming', files[0] ?? ''), 'utf8'))
      expect(event).toMatchObject({
        provider: 'opencode',
        source: 'agent-teams-orchestrator-opencode',
        eventName: 'runtime_turn_settled',
        hookEventName: 'Stop',
        sessionId: record.opencodeSessionId,
        teamName: identity.teamId,
        memberName: identity.memberName,
        runtimePromptMessageId: prompted.runtimePromptMessageId,
      })
      expect(['success', 'error']).toContain(event.outcome)
    } finally {
      await openCodeSessionBridge.releaseSession(record)
      await openCodeSessionStore.markStale(
        identity.teamId,
        identity.laneId,
        identity.memberName,
        'turn_settled_live_e2e_cleanup',
      )
      await openCodeHostManager.reconcilePersistentHosts({
        mode: 'stale',
        reason: 'turn_settled_live_e2e_cleanup',
        projectPath: tempDir,
        staleAgeMs: 0,
        leaseStaleAgeMs: 0,
        preflightLeaseStaleAgeMs: 0,
      })
    }
  }, 120_000)
})
