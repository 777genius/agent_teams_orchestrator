import { describe, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { openCodeHostManager } from './OpenCodeHostManager.js'
import { openCodeInventoryService } from './OpenCodeInventoryService.js'
import { executeOpenCodeBridgeCommandEnvelope } from './OpenCodeBridgeCommandHandler.js'
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
  return realpath(await mkdtemp(path.join(os.tmpdir(), `${prefix}-`)))
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
  await removeTempDirWithRetries(input.projectPath).catch(() => undefined)
}

const liveTest =
  process.env.OPENCODE_E2E === '1'
    ? test
    : test.skip
const permissionLiveTest =
  process.env.OPENCODE_E2E === '1' &&
  process.env.OPENCODE_PERMISSION_LIVE_E2E === '1'
    ? test
    : test.skip

async function delayMs(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

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
        90_000,
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
      expect(assistant?.contentBlocks.some(block => block.type === 'text')).toBe(true)
    } finally {
      await cleanupLiveSession({
        projectPath,
        record,
        identity,
        reason: 'opencode_session_bridge_live_text_e2e_cleanup',
      })
    }
  }, 150_000)

  liveTest('projects a real OpenCode bash tool call into canonical transcript blocks', async () => {
    const selectedModel = await getLiveModel()
    const identity = buildUniqueIdentity('opencode-live-tool')
    const projectPath = await createTempProject('opencode-session-bridge-live-tool')
    const expectedPathToken = process.platform === 'win32'
      ? path.basename(projectPath)
      : projectPath
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
      expect(bashCall?.outputText).toContain(expectedPathToken)
      expect(reconciled.summary.latestAssistantText).toContain(expectedPathToken)
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

  permissionLiveTest('surfaces and answers a real manual permission request', async () => {
    const selectedModel = await getLiveModel()
    const identity = buildUniqueIdentity('opencode-live-permission')
    const projectPath = await createTempProject('opencode-session-bridge-live-permission')
    let record: Awaited<ReturnType<typeof openCodeSessionBridge.ensureSession>> | undefined

    try {
      record = await withTimeout(
        openCodeSessionBridge.ensureSession({
          ...identity,
          selectedModel,
          projectPath,
          toolApprovalMode: 'manual',
          fresh: true,
        }),
        30_000,
        'ensureSession(permission)',
      )

      await withTimeout(
        openCodeSessionBridge.promptAsync(record, {
          text: [
            'Run exactly this shell command and then reply with the output:',
            'printf opencode-approval-smoke',
          ].join('\n'),
        }),
        20_000,
        'promptAsync(permission)',
      )

      const blocked = await withTimeout(
        (async () => {
          for (let attempt = 0; attempt < 60; attempt += 1) {
            const reconciled = await openCodeSessionBridge.reconcileSession(record!)
            const requestId = reconciled.summary.pendingPermissionRequestIds[0]
            if (requestId) {
              return { reconciled, requestId }
            }
            await delayMs(1_000)
          }
          throw new Error('OpenCode manual permission did not surface')
        })(),
        75_000,
        'waitForPermission',
      )

      expect(blocked.reconciled.summary.durableState).toBe('blocked')
      expect(blocked.reconciled.summary.pendingPermissions?.[0]).toMatchObject({
        sessionId: record.opencodeSessionId,
      })
      const listedPermissions = await withTimeout(
        executeOpenCodeBridgeCommandEnvelope({
          schemaVersion: 1,
          requestId: `list-permissions-${identity.teamId}`,
          command: 'opencode.listRuntimePermissions',
          cwd: projectPath,
          startedAt: new Date().toISOString(),
          timeoutMs: 30_000,
          body: {
            teamId: identity.teamId,
            teamName: identity.teamId,
            laneId: record.laneId ?? 'primary',
            memberName: identity.memberName,
            sessionId: record.opencodeSessionId,
            projectPath,
          },
        }),
        30_000,
        'listRuntimePermissions(permission)',
      )
      expect(listedPermissions.ok).toBe(true)
      if (listedPermissions.ok) {
        expect(listedPermissions.data.permissions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              requestId: blocked.requestId,
              sessionId: record.opencodeSessionId,
            }),
          ]),
        )
      }

      await withTimeout(
        openCodeSessionBridge.answerPermission(record, {
          requestId: blocked.requestId,
          decision: 'allow',
        }),
        20_000,
        'answerPermission',
      )

      const completed = await withTimeout(
        (async () => {
          for (let attempt = 0; attempt < 90; attempt += 1) {
            const reconciled = await openCodeSessionBridge.reconcileSession(record!)
            const output = JSON.stringify(reconciled.summary)
            if (
              reconciled.summary.pendingPermissionRequestIds.length === 0 &&
              output.includes('opencode-approval-smoke')
            ) {
              return reconciled
            }
            await delayMs(1_000)
          }
          throw new Error('OpenCode did not resume after manual permission allow')
        })(),
        110_000,
        'waitForPermissionResume',
      )

      expect(completed.summary.pendingPermissionRequestIds).toEqual([])
      expect(JSON.stringify(completed.summary)).toContain('opencode-approval-smoke')
    } finally {
      await cleanupLiveSession({
        projectPath,
        record,
        identity,
        reason: 'opencode-permission-live-e2e-cleanup',
      })
    }
  }, 180_000)
})

async function removeTempDirWithRetries(dirPath: string): Promise<void> {
  const attempts = process.platform === 'win32' ? 20 : 1
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(dirPath, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if ((code !== 'EBUSY' && code !== 'EPERM') || attempt === attempts) {
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
}
