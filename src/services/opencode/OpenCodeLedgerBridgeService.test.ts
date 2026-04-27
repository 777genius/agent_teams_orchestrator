import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { OpenCodeLedgerBridgeService } from './OpenCodeLedgerBridgeService.js'
import { OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE } from './OpenCodeOfflineSessionReader.js'

import type {
  OpenCodeOfflineSessionReadResult,
  OpenCodeSqliteMessageRow,
  OpenCodeSqlitePartRow,
} from './OpenCodeOfflineSessionReader.js'
import type { OpenCodeSessionRecord } from './types.js'

let tempDir = ''
let projectDir = ''
let workspaceRoot = ''

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-ledger-bridge-'))
  projectDir = path.join(tempDir, 'claude-project')
  workspaceRoot = path.join(tempDir, 'repo')
  await mkdir(projectDir, { recursive: true })
  await mkdir(path.join(workspaceRoot, 'src'), { recursive: true })
})

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
  }
})

function sessionRecord(overrides: Partial<OpenCodeSessionRecord> = {}): OpenCodeSessionRecord {
  return {
    teamId: 'team-a',
    laneId: 'primary',
    memberName: 'bob',
    providerId: 'opencode',
    selectedModel: 'openai/gpt-5.4',
    projectPath: workspaceRoot,
    profileRootKey: 'profile-root',
    hostKey: 'host-key',
    resolvedBehaviorFingerprint: 'behavior-v1',
    opencodeSessionId: 'session-1',
    lastCanonicalCursor: null,
    lastKnownRawStatus: null,
    lastKnownDurableState: 'idle',
    sourceAuthFingerprint: null,
    managedAuthFingerprint: null,
    projectBehaviorFingerprint: 'behavior-v1',
    staleReason: null,
    createdAt: '2026-04-26T10:00:00.000Z',
    updatedAt: '2026-04-26T10:00:00.000Z',
    ...overrides,
  }
}

function messageRow(id: string, data: Record<string, unknown>, time = 1000): OpenCodeSqliteMessageRow {
  return {
    id,
    session_id: 'session-1',
    time_created: time,
    time_updated: null,
    dataLengthBytes: JSON.stringify(data).length,
    data: JSON.stringify(data),
  }
}

function partRow(
  id: string,
  messageId: string,
  data: Record<string, unknown>,
  time = 1000,
): OpenCodeSqlitePartRow {
  return {
    id,
    message_id: messageId,
    session_id: 'session-1',
    time_created: time,
    time_updated: null,
    dataLengthBytes: JSON.stringify(data).length,
    data: JSON.stringify(data),
  }
}

function structuredDeliveryPrompt(inboundMessageId: string): string {
  return [
    '<opencode_app_message_delivery>',
    `<opencode_delivery_context>${JSON.stringify({
      schemaVersion: 1,
      kind: 'opencode-delivery-context',
      teamName: 'team-a',
      memberName: 'bob',
      laneId: 'primary',
      inboundMessageId,
      taskRefs: [
        { taskId: 'task-1', displayId: 'abc12345', teamName: 'team-a' },
      ],
    })}</opencode_delivery_context>`,
    '</opencode_app_message_delivery>',
    '',
    '<opencode_inbound_app_message>',
    'Build it.',
    '</opencode_inbound_app_message>',
  ].join('\n')
}

function offlineFixture(): OpenCodeOfflineSessionReadResult {
  const toolData = {
    type: 'tool',
    tool: 'write',
    callID: 'call-write-1',
    state: {
      status: 'completed',
      input: {
        filePath: path.join(workspaceRoot, 'src/opencode.ts'),
        content: 'export const source = "opencode";\n',
      },
      metadata: { exists: false, truncated: false },
      time: { end: 1000 },
    },
  }
  return {
    source: 'opencode-sqlite',
    dbPath: path.join(tempDir, 'state.db'),
    dbFingerprint: { dbMtimeMs: 1, dbSizeBytes: 1 },
    rawMessages: [
      messageRow('user-1', { id: 'user-1' }, 900),
      messageRow('assistant-1', { id: 'assistant-1', parentID: 'user-1' }, 1000),
    ],
    rawParts: [
      partRow(
        'user-part-1',
        'user-1',
        {
          text: structuredDeliveryPrompt('user-1'),
        },
        900,
      ),
      partRow('tool-part-1', 'assistant-1', toolData, 1000),
    ],
    messages: [],
    diagnostics: [],
  }
}

async function writeDeliveryContext(overrides: Partial<{
  runtimeSessionId: string | null
  laneId: string
  memberName: string
  inboxMessageId: string | null
  deliveredUserMessageId: string | null
}> = {}): Promise<string> {
  const filePath = path.join(tempDir, 'delivery-context.json')
  await writeFile(
    filePath,
    `${JSON.stringify({
      schemaVersion: 1,
      teamName: 'team-a',
      taskId: 'task-1',
      records: [
        {
          memberName: overrides.memberName ?? 'bob',
          laneId: overrides.laneId ?? 'primary',
          runtimeSessionId: overrides.runtimeSessionId ?? 'session-1',
          inboxMessageId: overrides.inboxMessageId ?? 'user-1',
          deliveredUserMessageId: overrides.deliveredUserMessageId ?? null,
          observedAssistantMessageId: null,
          prePromptCursor: null,
          postPromptCursor: null,
          taskRefs: [
            { taskId: 'task-1', displayId: 'abc12345', teamName: 'team-a' },
          ],
        },
      ],
    })}\n`,
    'utf8',
  )
  return filePath
}

describe('OpenCodeLedgerBridgeService', () => {
  test('imports reconstructed OpenCode write toolparts into task-change ledger artifacts', async () => {
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      { readSession: async () => offlineFixture() },
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      deliveryContextPath: await writeDeliveryContext(),
    })

    expect(result.outcome).toBe('imported')
    expect(result.importedEvents).toBe(1)
    const eventFile = path.join(projectDir, '.board-task-changes', 'events', 'task-1.jsonl')
    const event = JSON.parse((await readFile(eventFile, 'utf8')).trim())
    expect(event).toMatchObject({
      taskId: 'task-1',
      memberName: 'bob',
      source: 'opencode_toolpart_write',
      operation: 'create',
      confidence: 'exact',
      sourceRuntime: 'opencode',
      sourceProvider: 'opencode',
      sourceSessionId: 'session-1',
      sourcePartId: 'tool-part-1',
      parentUserMessageId: 'user-1',
      attributionMethod: 'delivery-ledger-taskrefs',
      relativePath: 'src/opencode.ts',
    })
  })

  test('imports edit-only OpenCode toolparts as manual-review metadata instead of dropping them', async () => {
    const editFixture = {
      ...offlineFixture(),
      rawParts: [
        partRow(
          'user-part-1',
          'user-1',
          {
            text: structuredDeliveryPrompt('user-1'),
          },
          900,
        ),
        partRow(
          'tool-part-edit-only',
          'assistant-1',
          {
            type: 'tool',
            tool: 'edit',
            callID: 'call-edit-only',
            state: {
              status: 'completed',
              input: {
                filePath: path.join(workspaceRoot, 'src/existing.ts'),
                oldString: 'value = 1',
                newString: 'value = 2',
              },
              metadata: { truncated: false },
              time: { end: 1000 },
            },
          },
          1000,
        ),
      ],
    }
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      { readSession: async () => editFixture },
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      deliveryContextPath: await writeDeliveryContext(),
    })

    expect(result.outcome).toBe('imported')
    expect(result.importedEvents).toBe(1)
    const eventFile = path.join(projectDir, '.board-task-changes', 'events', 'task-1.jsonl')
    const event = JSON.parse((await readFile(eventFile, 'utf8')).trim())
    expect(event).toMatchObject({
      taskId: 'task-1',
      source: 'opencode_toolpart_edit',
      operation: 'modify',
      confidence: 'high',
      sourcePartId: 'tool-part-edit-only',
      oldString: 'value = 1',
      newString: 'value = 2',
      before: null,
      after: null,
      beforeState: {
        exists: true,
        unavailableReason: 'opencode-edit-baseline-not-captured',
      },
      afterState: {
        exists: true,
        unavailableReason: 'opencode-edit-final-content-unavailable',
      },
      relativePath: 'src/existing.ts',
    })
    const bundleFile = path.join(projectDir, '.board-task-changes', 'bundles', 'task-1.json')
    const bundle = JSON.parse(await readFile(bundleFile, 'utf8')) as {
      totalFiles: number
      files: Array<{ relativePath: string; contentAvailability: string; reviewability: string }>
    }
    expect(bundle.totalFiles).toBe(1)
    expect(bundle.files[0]).toMatchObject({
      relativePath: 'src/existing.ts',
      contentAvailability: 'metadata-only',
      reviewability: 'metadata-only',
    })
  })

  test('fails closed when a stored OpenCode session belongs to a different workspace root', async () => {
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord({ projectPath: path.join(tempDir, 'other-repo') })] },
      { readSession: async () => offlineFixture() },
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      projectDir,
      workspaceRoot,
      deliveryContextPath: await writeDeliveryContext(),
    })

    expect(result.outcome).toBe('unsafe-input')
    expect(result.importedEvents).toBe(0)
    expect(result.diagnostics).toContain(
      'OpenCode ledger backfill skipped bob/session-1 because workspace identity was not trusted.',
    )
  })

  test('strict delivery backfill imports only with a matching delivery context', async () => {
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      { readSession: async () => offlineFixture() },
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      memberName: 'bob',
      projectDir,
      workspaceRoot,
      deliveryContextPath: await writeDeliveryContext(),
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('imported')
    expect(result.attributionMode).toBe('strict-delivery')
    expect(result.importedEvents).toBe(1)
    const eventFile = path.join(projectDir, '.board-task-changes', 'events', 'task-1.jsonl')
    const event = JSON.parse((await readFile(eventFile, 'utf8')).trim())
    expect(event).toMatchObject({
      attributionMethod: 'delivery-ledger-taskrefs',
      sourcePartId: 'tool-part-1',
    })
  })

  test('strict delivery backfill does not fall back to parent taskRefs without delivery context', async () => {
    let readCount = 0
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      {
        readSession: async () => {
          readCount += 1
          return offlineFixture()
        },
      },
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      memberName: 'bob',
      projectDir,
      workspaceRoot,
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('no-attribution')
    expect(result.importedEvents).toBe(0)
    expect(readCount).toBe(0)
    expect(result.diagnostics).toContain(
      'OpenCode strict delivery attribution requires delivery context.',
    )
  })

  test('strict delivery backfill fails closed on mismatched delivery session', async () => {
    let readCount = 0
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      {
        readSession: async () => {
          readCount += 1
          return offlineFixture()
        },
      },
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      memberName: 'bob',
      projectDir,
      workspaceRoot,
      deliveryContextPath: await writeDeliveryContext({ runtimeSessionId: 'other-session' }),
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('no-attribution')
    expect(result.importedEvents).toBe(0)
    expect(readCount).toBe(0)
    expect(result.diagnostics).toContain(
      'OpenCode strict delivery attribution found no stored OpenCode session matching the delivery context.',
    )
  })

  test('returns skipped-capability when OpenCode SQLite history shape is unsupported', async () => {
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      {
        readSession: async () => ({
          ...offlineFixture(),
          historyShape: 'unsupported' as const,
          rawMessages: [],
          rawParts: [],
          messages: [],
          diagnostics: [`${OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE}: missing part.data`],
        }),
      },
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      projectDir,
      workspaceRoot,
      deliveryContextPath: await writeDeliveryContext(),
    })

    expect(result.outcome).toBe('skipped-capability')
    expect(result.importedEvents).toBe(0)
    expect(result.diagnostics).toContain(`${OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE}: missing part.data`)
  })

  test('reports imported when at least one session imports even if another session is unsupported', async () => {
    const service = new OpenCodeLedgerBridgeService(
      {
        list: async () => [
          sessionRecord({ opencodeSessionId: 'unsupported-session', memberName: 'alice' }),
          sessionRecord(),
        ],
      },
      {
        readSession: async (record) => {
          if (record.opencodeSessionId === 'unsupported-session') {
            return {
              ...offlineFixture(),
              historyShape: 'unsupported' as const,
              rawMessages: [],
              rawParts: [],
              messages: [],
              diagnostics: [`${OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE}: missing part.data`],
            }
          }
          return offlineFixture()
        },
      },
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      projectDir,
      workspaceRoot,
      deliveryContextPath: await writeDeliveryContext(),
    })

    expect(result.outcome).toBe('imported')
    expect(result.importedEvents).toBe(1)
    expect(result.diagnostics).toContain(`${OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE}: missing part.data`)
  })
})
