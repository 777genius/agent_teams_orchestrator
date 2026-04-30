import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { openCodeHostManager } from './OpenCodeHostManager.js'
import { openCodeInventoryService } from './OpenCodeInventoryService.js'
import { openCodeSessionBridge } from './OpenCodeSessionBridge.js'
import { openCodeSessionStore } from './OpenCodeSessionStore.js'

function buildUniqueIdentity(prefix: string): {
  teamId: string
  memberName: string
} {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return {
    teamId: `${prefix}-${nonce}`,
    memberName: `alice-${nonce}`,
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
    throw new Error('OpenCode CLI is not available for live e2e tests')
  }
  const preferred =
    inventory.models.find(model => model === 'opencode/big-pickle')
    ?? inventory.models.find(model => model.startsWith('opencode/'))
    ?? inventory.models[0]

  if (!preferred) {
    throw new Error('No OpenCode model is available for live e2e tests')
  }

  return preferred
}

async function createTempProject(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `${prefix}-`))
}

async function cleanupLiveSession(input: {
  projectPath: string
  record?: Awaited<ReturnType<typeof openCodeSessionBridge.ensureSession>>
  identity: ReturnType<typeof buildUniqueIdentity>
  reason: string
}): Promise<void> {
  await openCodeHostManager.reconcilePersistentHosts({
    mode: 'force',
    reason: input.reason,
    projectPath: input.projectPath,
    staleAgeMs: 0,
    leaseStaleAgeMs: 0,
    preflightLeaseStaleAgeMs: 0,
  }).catch(() => undefined)
  if (input.record) {
    await openCodeSessionBridge.releaseSession(input.record).catch(() => undefined)
  }
  await openCodeSessionStore.delete(input.identity.teamId, input.identity.memberName)
    .catch(() => undefined)
  await rm(input.projectPath, { recursive: true, force: true }).catch(() => undefined)
}

const liveTest =
  process.env.OPENCODE_E2E === '1'
    ? test
    : test.skip

describe('OpenCodeSessionBridge live e2e', () => {
  liveTest('reconciles a simple assistant reply against a real OpenCode host', async () => {
    const selectedModel = await getLiveModel()
    const identity = buildUniqueIdentity('opencode-live-text')
    const projectPath = await createTempProject('opencode-session-bridge-live-text')
    let record: Awaited<ReturnType<typeof openCodeSessionBridge.ensureSession>> | undefined

    try {
      record = await withTimeout(
        openCodeSessionBridge.ensureSession({
          ...identity,
          selectedModel,
          projectPath,
        }),
        20_000,
        'ensureSession(text)',
      )

      await withTimeout(
        openCodeSessionBridge.sendMessage(record, {
          text: 'Reply with exactly: pong',
        }),
        20_000,
        'sendMessage(text)',
      )

      const reconciled = await withTimeout(
        openCodeSessionBridge.reconcileSession(record),
        20_000,
        'reconcileSession(text)',
      )

      expect(reconciled.summary.durableState).toBe('idle')
      expect(reconciled.summary.latestAssistantText).toBe('pong')
      expect(reconciled.summary.toolCallCount).toBe(0)
      const assistant = reconciled.summary.messages.find(message => message.role === 'assistant')
      expect(assistant).toBeDefined()
      expect(assistant?.contentBlocks.some(block => block.type === 'reasoning')).toBe(true)
      expect(assistant?.contentBlocks.some(block => block.type === 'text')).toBe(true)
    } finally {
      await cleanupLiveSession({
        projectPath,
        record,
        identity,
        reason: 'opencode_session_bridge_live_text_e2e_cleanup',
      })
    }
  }, 90_000)

  liveTest('projects a real OpenCode bash tool call into canonical transcript blocks', async () => {
    const selectedModel = await getLiveModel()
    const identity = buildUniqueIdentity('opencode-live-tool')
    const projectPath = await createTempProject('opencode-session-bridge-live-tool')
    let record: Awaited<ReturnType<typeof openCodeSessionBridge.ensureSession>> | undefined

    try {
      record = await withTimeout(
        openCodeSessionBridge.ensureSession({
          ...identity,
          selectedModel,
          projectPath,
        }),
        20_000,
        'ensureSession(tool)',
      )

      await withTimeout(
        openCodeSessionBridge.sendMessage(record, {
          text: 'Run pwd and then answer with the working directory only.',
        }),
        90_000,
        'sendMessage(tool)',
      )

      const reconciled = await withTimeout(
        openCodeSessionBridge.reconcileSession(record),
        20_000,
        'reconcileSession(tool)',
      )
      const projectedLogs = await withTimeout(
        openCodeSessionBridge.projectLogMessages(record),
        20_000,
        'projectLogMessages(tool)',
      )

      expect(reconciled.summary.durableState).toBe('idle')
      expect(reconciled.summary.toolCallCount).toBeGreaterThanOrEqual(1)

      const toolMessage = reconciled.summary.messages.find(message =>
        message.toolCalls.some(tool => tool.toolName === 'bash'),
      )
      expect(toolMessage).toBeDefined()
      expect(toolMessage?.contentBlocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool_use',
            name: 'bash',
          }),
          expect.objectContaining({
            type: 'tool_result',
            toolName: 'bash',
          }),
        ]),
      )

      const bashCall = toolMessage?.toolCalls.find(tool => tool.toolName === 'bash')
      expect(bashCall?.status).toBe('completed')
      expect(bashCall?.outputText).toContain(projectPath)
      expect(reconciled.summary.latestAssistantText).toContain(projectPath)
      expect(projectedLogs.logProjection.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'assistant',
            toolCalls: expect.arrayContaining([
              expect.objectContaining({
                name: 'bash',
              }),
            ]),
          }),
          expect.objectContaining({
            type: 'user',
            isMeta: true,
            toolResults: expect.arrayContaining([
              expect.objectContaining({
                toolUseId: bashCall?.callId,
              }),
            ]),
          }),
        ]),
      )
      const projectedAssistant = projectedLogs.logProjection.messages.find(message =>
        message.type === 'assistant' && message.toolCalls.some(tool => tool.name === 'bash')
      )
      const projectedBashTool = projectedAssistant?.toolCalls.find(tool => tool.name === 'bash')
      const projectedToolResult = projectedLogs.logProjection.messages.find(message =>
        message.type === 'user'
        && message.isMeta
        && message.toolResults.some(result => result.toolUseId === projectedBashTool?.id)
      )
      expect(projectedBashTool?.id).toBeTruthy()
      expect(projectedToolResult).toBeDefined()
    } finally {
      await cleanupLiveSession({
        projectPath,
        record,
        identity,
        reason: 'opencode_session_bridge_live_tool_e2e_cleanup',
      })
    }
  }, 120_000)
})
