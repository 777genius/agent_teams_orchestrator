import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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

const deepLiveTest =
  process.env.OPENCODE_E2E === '1' &&
    process.env.OPENCODE_TURN_SETTLED_LIVE === '1' &&
    process.env.OPENCODE_TURN_SETTLED_LIVE_DEEP === '1'
    ? test
    : test.skip

const PREFERRED_LIVE_MODELS = [
  process.env.OPENCODE_TURN_SETTLED_LIVE_MODEL,
  'opencode/big-pickle',
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

async function getToolLiveModel(): Promise<string | null> {
  const inventory = await openCodeInventoryService.probe()
  if (!inventory.detected) {
    throw new Error('OpenCode CLI is not available for live turn-settled e2e')
  }
  return inventory.models.includes('opencode/big-pickle') ? 'opencode/big-pickle' : null
}

async function readSingleSpoolEvent(spoolRoot: string): Promise<Record<string, unknown>> {
  const files = await readdir(path.join(spoolRoot, 'incoming'))
  expect(files).toHaveLength(1)
  expect(files[0]?.endsWith('.opencode.json')).toBe(true)
  return JSON.parse(await readFile(path.join(spoolRoot, 'incoming', files[0] ?? ''), 'utf8'))
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
          timeoutMs: 45_000,
          idleTimeoutMs: 2_500,
        }),
        65_000,
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
      await openCodeSessionStore.delete(
        identity.teamId,
        identity.laneId,
        identity.memberName,
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

  deepLiveTest('keeps sequential prompt_async turns in one real session isolated', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-turn-settled-sequential-live-'))
    const selectedModel = await getLiveModel()
    const identity = buildUniqueIdentity('opencode-turn-settled-sequential-live')
    const record = await withTimeout(
      openCodeSessionBridge.ensureSession({
        ...identity,
        selectedModel,
        projectPath: tempDir,
      }),
      30_000,
      'ensureSession(sequential)',
    )

    try {
      for (const label of ['first', 'second']) {
        const prompted = await withTimeout(
          openCodeSessionBridge.promptAsyncWithTurnSettled(record, {
            text: `Reply with exactly ${label.toUpperCase()}_TURN.`,
            agent: 'teammate',
            timeoutMs: 35_000,
            idleTimeoutMs: 2_500,
          }),
          50_000,
          `promptAsyncWithTurnSettled(${label})`,
        )
        expect(prompted.turnSettled.streamConnected).toBe(true)
        expect(prompted.turnSettled.promptPersisted).toBe(true)

        const reconciled = await withTimeout(
          openCodeSessionBridge.reconcileSession(record, { limit: 100 }),
          20_000,
          `reconcileSession(${label})`,
        )
        expect(reconciled.summary.latestUserMessageId).toBe(prompted.runtimePromptMessageId)
        expect(reconciled.summary.errorCount).toBe(0)

        const spoolRoot = path.join(tempDir, 'runtime-turn-settled', label)
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

        const event = await readSingleSpoolEvent(spoolRoot)
        expect(event).toMatchObject({
          provider: 'opencode',
          source: 'agent-teams-orchestrator-opencode',
          eventName: 'runtime_turn_settled',
          hookEventName: 'Stop',
          sessionId: record.opencodeSessionId,
          runtimePromptMessageId: prompted.runtimePromptMessageId,
        })
        if (prompted.turnSettled.assistantActivityCount > 0) {
          expect(event.outcome).toBe('success')
        } else {
          expect(event.outcome).toBe(prompted.turnSettled.outcome)
        }
      }
    } finally {
      await openCodeSessionBridge.releaseSession(record)
      await openCodeSessionStore.delete(
        identity.teamId,
        identity.laneId,
        identity.memberName,
      )
      await openCodeHostManager.reconcilePersistentHosts({
        mode: 'stale',
        reason: 'turn_settled_sequential_live_e2e_cleanup',
        projectPath: tempDir,
        staleAgeMs: 0,
        leaseStaleAgeMs: 0,
        preflightLeaseStaleAgeMs: 0,
      })
    }
  }, 180_000)

  deepLiveTest('settles a real native bash tool turn', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-turn-settled-tool-live-'))
    await writeFile(path.join(tempDir, 'README.md'), '# OpenCode tool turn live test\n', 'utf8')
    const selectedModel = await getToolLiveModel()
    if (!selectedModel) {
      return
    }
    const identity = buildUniqueIdentity('opencode-turn-settled-tool-live')
    const record = await withTimeout(
      openCodeSessionBridge.ensureSession({
        ...identity,
        selectedModel,
        projectPath: tempDir,
      }),
      30_000,
      'ensureSession(tool)',
    )

    try {
      let prompted: Awaited<ReturnType<typeof openCodeSessionBridge.promptAsyncWithTurnSettled>> | null = null
      let reconciled: Awaited<ReturnType<typeof openCodeSessionBridge.reconcileSession>> | null = null
      let previousToolCallCount = 0
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        prompted = await withTimeout(
          openCodeSessionBridge.promptAsyncWithTurnSettled(record, {
            text: attempt === 1
              ? 'Run pwd and then answer with the working directory only.'
              : 'You answered without a bash tool call. Now run pwd with the bash tool, then answer with the working directory only.',
            agent: 'teammate',
            timeoutMs: 90_000,
            idleTimeoutMs: 5_000,
          }),
          110_000,
          `promptAsyncWithTurnSettled(tool:${attempt})`,
        )
        expect(prompted.turnSettled.outcome).toBe('success')
        expect(prompted.turnSettled.streamConnected).toBe(true)
        expect(prompted.turnSettled.assistantActivityCount).toBeGreaterThan(0)

        reconciled = await withTimeout(
          openCodeSessionBridge.reconcileSession(record, { limit: 120 }),
          20_000,
          `reconcileSession(tool:${attempt})`,
        )
        expect(reconciled.summary.latestUserMessageId).toBe(prompted.runtimePromptMessageId)
        expect(reconciled.summary.errorCount).toBe(0)
        if (reconciled.summary.toolCallCount > previousToolCallCount) {
          break
        }
        previousToolCallCount = reconciled.summary.toolCallCount
      }
      if (!prompted || !reconciled) {
        throw new Error('OpenCode tool turn live test did not run')
      }
      expect(reconciled.summary.toolCallCount).toBeGreaterThan(0)

      const spoolRoot = path.join(tempDir, 'runtime-turn-settled-tool')
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
      expect(await readSingleSpoolEvent(spoolRoot)).toMatchObject({
        outcome: 'success',
        runtimePromptMessageId: prompted.runtimePromptMessageId,
      })
    } finally {
      await openCodeSessionBridge.releaseSession(record)
      await openCodeSessionStore.delete(
        identity.teamId,
        identity.laneId,
        identity.memberName,
      )
      await openCodeHostManager.reconcilePersistentHosts({
        mode: 'stale',
        reason: 'turn_settled_tool_live_e2e_cleanup',
        projectPath: tempDir,
        staleAgeMs: 0,
        leaseStaleAgeMs: 0,
        preflightLeaseStaleAgeMs: 0,
      })
    }
  }, 180_000)
})
