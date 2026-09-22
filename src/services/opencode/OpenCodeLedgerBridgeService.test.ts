import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { OpenCodeChangeEvidenceEnricher } from './OpenCodeChangeEvidenceEnricher.js'
import { OpenCodeLedgerBridgeService } from './OpenCodeLedgerBridgeService.js'
import { OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE } from './OpenCodeOfflineSessionReader.js'
import { OpenCodeToolpartChangeReconstructor } from './OpenCodeToolpartChangeReconstructor.js'
import { importTaskChangeLedgerEvents } from '../taskChangeLedger/TaskChangeLedgerService.js'

import type { OpenCodeSnapshotBoundary, OpenCodeSnapshotEvidenceFile, OpenCodeSnapshotEvidenceProvider } from './OpenCodeChangeEvidence.js'
import type { ReconstructedOpenCodeToolChange } from './OpenCodeToolpartChangeReconstructor.js'
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
    sessionIdentity: null,
    snapshotStepParts: [],
    patchParts: [],
    snapshotWindows: [],
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
  snapshotBoundary: OpenCodeSnapshotBoundary | Record<string, unknown> | null
  taskRefs: Array<{ taskId: string; displayId: string; teamName: string }>
}> = {}): Promise<{ deliveryContextPath: string; deliveryContextHash: string }> {
  const hasRuntimeSessionIdOverride = Object.prototype.hasOwnProperty.call(overrides, 'runtimeSessionId')
  const rawContext = `${JSON.stringify({
    schemaVersion: 1,
    teamName: 'team-a',
    taskId: 'task-1',
    records: [
      {
        memberName: overrides.memberName ?? 'bob',
        laneId: overrides.laneId ?? 'primary',
        runtimeSessionId: hasRuntimeSessionIdOverride ? overrides.runtimeSessionId : 'session-1',
        inboxMessageId: overrides.inboxMessageId ?? 'user-1',
        deliveredUserMessageId: overrides.deliveredUserMessageId ?? null,
        observedAssistantMessageId: null,
        prePromptCursor: null,
        postPromptCursor: null,
        ...(overrides.snapshotBoundary !== undefined
          ? { snapshotBoundary: overrides.snapshotBoundary }
          : {}),
        taskRefs: overrides.taskRefs ?? [
          { taskId: 'task-1', displayId: 'abc12345', teamName: 'team-a' },
        ],
      },
    ],
  })}\n`
  return writeTrustedDeliveryContextRaw(rawContext)
}

async function writeTrustedDeliveryContextRaw(
  rawContext: string,
): Promise<{ deliveryContextPath: string; deliveryContextHash: string }> {
  const contextDir = await mkdtemp(path.join(tempDir, 'claude-team-opencode-ledger-context-'))
  await chmod(contextDir, 0o700).catch(() => undefined)
  const filePath = path.join(contextDir, 'delivery-context.json')
  await writeFile(
    filePath,
    rawContext,
    { encoding: 'utf8', mode: 0o600 },
  )
  return {
    deliveryContextPath: filePath,
    deliveryContextHash: createHash('sha256').update(rawContext).digest('hex'),
  }
}

function snapshotProvider(
  relativePathOrFile: string | OpenCodeSnapshotEvidenceFile,
  afterContent?: string,
): OpenCodeSnapshotEvidenceProvider {
  return {
    adapterVersion: 1,
    async probe() {
      return {
        supported: true,
        shapeFingerprint: 'shape-v1',
        adapterVersion: 1,
      }
    },
    async readSessionEvidence() {
      return {
        supported: true,
        shapeFingerprint: 'shape-v1',
        adapterVersion: 1,
        files: [
          typeof relativePathOrFile === 'string'
            ? { relativePath: relativePathOrFile, afterContent: afterContent ?? '' }
            : relativePathOrFile,
        ],
      }
    },
  }
}

function withSnapshotWindow(
  fixture: OpenCodeOfflineSessionReadResult,
): OpenCodeOfflineSessionReadResult {
  return {
    ...fixture,
    snapshotStepParts: [
      {
        partId: '000-step-start',
        messageId: 'assistant-1',
        sessionId: 'session-1',
        partOrder: 0,
        timeCreated: 999,
        kind: 'step-start',
        snapshot: '1'.repeat(40),
      },
      {
        partId: 'zzz-step-finish',
        messageId: 'assistant-1',
        sessionId: 'session-1',
        partOrder: 2,
        timeCreated: 1001,
        kind: 'step-finish',
        snapshot: '2'.repeat(40),
      },
    ],
    snapshotWindows: [
      {
        windowId: 'assistant-1:000-step-start->zzz-step-finish',
        messageId: 'assistant-1',
        sessionId: 'session-1',
        fromSnapshot: '1'.repeat(40),
        toSnapshot: '2'.repeat(40),
        startPartId: '000-step-start',
        finishPartId: 'zzz-step-finish',
        startPartOrder: 0,
        finishPartOrder: 2,
      },
    ],
    rawParts: [
      partRow('000-step-start', 'assistant-1', { type: 'step-start', snapshot: '1'.repeat(40) }, 999),
      ...fixture.rawParts,
      partRow('zzz-step-finish', 'assistant-1', { type: 'step-finish', snapshot: '2'.repeat(40) }, 1001),
    ].sort((left, right) =>
      left.message_id.localeCompare(right.message_id) ||
      left.id.localeCompare(right.id)
    ),
  }
}

function reconstructedChange(overrides: Partial<ReconstructedOpenCodeToolChange> = {}): ReconstructedOpenCodeToolChange {
  const relativePath = overrides.relativePath ?? 'src/opencode.ts'
  const filePath = overrides.filePath ?? path.join(workspaceRoot, relativePath)
  return {
    taskId: 'task-1',
    taskRef: 'task-1',
    taskRefKind: 'canonical',
    teamName: 'team-a',
    memberName: 'bob',
    sessionId: 'session-1',
    parentUserMessageId: 'user-1',
    assistantMessageId: 'assistant-1',
    toolUseId: 'tool-part-1',
    sourcePartId: 'tool-part-1',
    sourceMessageId: 'assistant-1',
    sourceTool: 'write',
    sourceImportKey: `opencode\0session-1\0tool-part-1\0${relativePath}`,
    filePath,
    relativePath,
    beforeContent: null,
    afterContent: 'export const value = 1;\n',
    beforeState: { exists: false, sizeBytes: 0 },
    afterState: { exists: true, sizeBytes: 24 },
    operation: 'create',
    confidence: 'exact',
    attributionMethod: 'delivery-ledger-taskrefs',
    timestamp: '2026-03-01T10:00:00.000Z',
    ...overrides,
  }
}

describe('OpenCodeLedgerBridgeService', () => {
  test('defaults snapshot proof mode to single-change at bridge backfill boundary', async () => {
    const previousSnapshotProofMode = process.env.OPENCODE_SNAPSHOT_PROOF_UPGRADE
    delete process.env.OPENCODE_SNAPSHOT_PROOF_UPGRADE
    try {
      const service = new OpenCodeLedgerBridgeService(
        { list: async () => [] },
      )

      const result = await service.backfill({
        teamName: 'team-a',
        projectDir,
        workspaceRoot,
      })

      expect(result.outcome).toBe('no-history')
      expect(result.snapshotProofMode).toBe('single-change')
    } finally {
      if (previousSnapshotProofMode === undefined) {
        delete process.env.OPENCODE_SNAPSHOT_PROOF_UPGRADE
      } else {
        process.env.OPENCODE_SNAPSHOT_PROOF_UPGRADE = previousSnapshotProofMode
      }
    }
  })

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
      ...(await writeDeliveryContext()),
    })

    expect(result.outcome).toBe('imported')
    expect(result.importedEvents).toBe(1)
    expect(result.deliveryLedgerFingerprint).toEqual(expect.any(String))
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

  test('counts duplicate OpenCode imports once without appending a second event', async () => {
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      { readSession: async () => offlineFixture() },
    )
    const request = {
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...(await writeDeliveryContext()),
    }

    const first = await service.backfill(request)
    const second = await service.backfill(request)

    expect(first.importedEvents).toBe(1)
    expect(second.outcome).toBe('duplicates-only')
    expect(second.importedEvents).toBe(0)
    expect(second.skippedEvents).toBe(1)
    const eventFile = path.join(projectDir, '.board-task-changes', 'events', 'task-1.jsonl')
    expect((await readFile(eventFile, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  test('imports edit-only OpenCode toolparts as manual-review metadata instead of dropping them', async () => {
    await writeFile(
      path.join(workspaceRoot, 'src/existing.ts'),
      'export const value = 2;\n',
      'utf8',
    )
    const editFixture = withSnapshotWindow({
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
    })
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
      ...(await writeDeliveryContext()),
    })

    expect(result.outcome).toBe('imported')
    expect(result.importedEvents).toBe(1)
    expect(result.deliveryLedgerFingerprint).toEqual(expect.any(String))
    const eventFile = path.join(projectDir, '.board-task-changes', 'events', 'task-1.jsonl')
    const event = JSON.parse((await readFile(eventFile, 'utf8')).trim())
    expect(event).toMatchObject({
      taskId: 'task-1',
      source: 'opencode_toolpart_edit',
      operation: 'modify',
      confidence: 'medium',
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
        sizeBytes: 24,
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
      contentAvailability: 'hash-only',
      reviewability: 'metadata-only',
    })
  })

  test('ignores status-only snapshot boundary when SQLite snapshot windows are missing', async () => {
    const afterPath = path.join(workspaceRoot, 'src/existing.ts')
    await writeFile(afterPath, 'export const value = 2;\n', 'utf8')
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
          'tool-part-edit-existing',
          'assistant-1',
          {
            type: 'tool',
            tool: 'edit',
            callID: 'call-edit-existing',
            state: {
              status: 'completed',
              input: {
                filePath: afterPath,
                oldString: 'value = 1',
                newString: 'value = 2',
              },
              metadata: { exists: true, truncated: false },
              time: { end: 1000 },
            },
          },
          1000,
        ),
      ],
    }
    let snapshotProviderCalled = false
    const provider: OpenCodeSnapshotEvidenceProvider = {
      adapterVersion: 1,
      async probe() {
        return { supported: true, shapeFingerprint: 'shape-v1', adapterVersion: 1 }
      },
      async readSessionEvidence() {
        snapshotProviderCalled = true
        return {
          supported: true,
          shapeFingerprint: 'shape-v1',
          adapterVersion: 1,
          files: [{ relativePath: 'src/existing.ts', afterContent: 'export const value = 2;\n' }],
        }
      },
    }
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      { readSession: async () => editFixture },
      new OpenCodeToolpartChangeReconstructor(),
      new OpenCodeChangeEvidenceEnricher(),
      provider,
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...(await writeDeliveryContext({
        snapshotBoundary: {
          schemaVersion: 1,
          captureStatus: 'captured',
          preDeliverySnapshotHash: 'pre',
          postDeliverySnapshotHash: 'post',
        },
      })),
      attributionMode: 'strict-delivery',
    })

    expect(snapshotProviderCalled).toBe(false)
    expect(result.outcome).toBe('imported')
    expect(result.importedEvents).toBe(1)
    expect(result.snapshotShapeFingerprint).toBeUndefined()
    expect(result.diagnostics).toContain('OpenCode snapshot evidence skipped because SQLite snapshot windows are unavailable.')
    const eventFile = path.join(projectDir, '.board-task-changes', 'events', 'task-1.jsonl')
    const event = JSON.parse((await readFile(eventFile, 'utf8')).trim())
    expect(event).toMatchObject({
      source: 'opencode_toolpart_edit',
      confidence: 'medium',
      evidenceProof: 'metadata-only-fallback',
      before: null,
      after: null,
    })
  })

  test('uses SQLite snapshot windows to upgrade strict edit evidence through provider abstraction', async () => {
    const afterPath = path.join(workspaceRoot, 'src/existing.ts')
    await writeFile(afterPath, 'export const value = 2;\n', 'utf8')
    const editFixture = withSnapshotWindow({
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
          'tool-part-edit-existing',
          'assistant-1',
          {
            type: 'tool',
            tool: 'edit',
            callID: 'call-edit-existing',
            state: {
              status: 'completed',
              input: {
                filePath: afterPath,
                oldString: 'value = 1',
                newString: 'value = 2',
              },
              metadata: { exists: true, truncated: false },
              time: { end: 1000 },
            },
          },
          1000,
        ),
      ],
    })
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      { readSession: async () => editFixture },
      new OpenCodeToolpartChangeReconstructor(),
      new OpenCodeChangeEvidenceEnricher(),
      snapshotProvider({
        relativePath: 'src/existing.ts',
        beforeContent: 'export const value = 1;\n',
        afterContent: 'export const value = 2;\n',
        operation: 'modify',
      }),
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...(await writeDeliveryContext()),
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('imported')
    expect(result.importedEvents).toBe(1)
    expect(result.snapshotShapeFingerprint).toBe('shape-v1')
    expect(result.deliveryLedgerFingerprint).toEqual(expect.any(String))
    const eventFile = path.join(projectDir, '.board-task-changes', 'events', 'task-1.jsonl')
    const event = JSON.parse((await readFile(eventFile, 'utf8')).trim())
    expect(event).toMatchObject({
      source: 'opencode_toolpart_edit',
      confidence: 'high',
      evidenceProof: 'inverse-edit-chain',
      beforeState: { exists: true },
      afterState: { exists: true },
    })
    expect(event.before).toMatchObject({ sizeBytes: 24 })
    expect(event.after).toMatchObject({ sizeBytes: 24 })
  })

  test('does not spend snapshot proof work outside strict delivery attribution', async () => {
    const afterPath = path.join(workspaceRoot, 'src/existing.ts')
    await writeFile(afterPath, 'export const value = 2;\n', 'utf8')
    const editFixture = withSnapshotWindow({
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
          'tool-part-edit-existing',
          'assistant-1',
          {
            type: 'tool',
            tool: 'edit',
            callID: 'call-edit-existing',
            state: {
              status: 'completed',
              input: {
                filePath: afterPath,
                oldString: 'value = 1',
                newString: 'value = 2',
              },
              metadata: { exists: true, truncated: false },
              time: { end: 1000 },
            },
          },
          1000,
        ),
      ],
    })
    let providerCalled = false
    const throwingProvider: OpenCodeSnapshotEvidenceProvider = {
      adapterVersion: 1,
      async probe() {
        throw new Error('unexpected probe')
      },
      async readSessionEvidence() {
        providerCalled = true
        throw new Error('unexpected snapshot read')
      },
    }
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      { readSession: async () => editFixture },
      new OpenCodeToolpartChangeReconstructor(),
      new OpenCodeChangeEvidenceEnricher(),
      throwingProvider,
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...(await writeDeliveryContext()),
    })

    expect(providerCalled).toBe(false)
    expect(result.outcome).toBe('imported')
    expect(result.importedEvents).toBe(1)
    expect(result.snapshotShapeFingerprint).toBeUndefined()
    expect(result.diagnostics).toContain(
      'snapshot-upgrade-skipped/strict-delivery-required: OpenCode snapshot proof requires strict delivery attribution.',
    )
    const eventFile = path.join(projectDir, '.board-task-changes', 'events', 'task-1.jsonl')
    const event = JSON.parse((await readFile(eventFile, 'utf8')).trim())
    expect(event).toMatchObject({
      source: 'opencode_toolpart_edit',
      operation: 'modify',
      confidence: 'medium',
      evidenceProof: 'metadata-only-fallback',
      before: null,
      after: null,
    })
  })

  test('honors shadow snapshot proof mode at bridge backfill boundary', async () => {
    const previousSnapshotProofMode = process.env.OPENCODE_SNAPSHOT_PROOF_UPGRADE
    process.env.OPENCODE_SNAPSHOT_PROOF_UPGRADE = 'shadow'
    try {
      const afterPath = path.join(workspaceRoot, 'src/existing.ts')
      await writeFile(afterPath, 'export const value = 2;\n', 'utf8')
      const editFixture = withSnapshotWindow({
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
            'tool-part-edit-existing',
            'assistant-1',
            {
              type: 'tool',
              tool: 'edit',
              callID: 'call-edit-existing',
              state: {
                status: 'completed',
                input: {
                  filePath: afterPath,
                  oldString: 'value = 1',
                  newString: 'value = 2',
                },
                metadata: { exists: true, truncated: false },
                time: { end: 1000 },
              },
            },
            1000,
          ),
        ],
      })
      const service = new OpenCodeLedgerBridgeService(
        { list: async () => [sessionRecord()] },
        { readSession: async () => editFixture },
        new OpenCodeToolpartChangeReconstructor(),
        new OpenCodeChangeEvidenceEnricher(),
        snapshotProvider({
          relativePath: 'src/existing.ts',
          beforeContent: 'export const value = 1;\n',
          afterContent: 'export const value = 2;\n',
          operation: 'modify',
        }),
      )

      const result = await service.backfill({
        teamName: 'team-a',
        taskId: 'task-1',
        taskDisplayId: 'abc12345',
        projectDir,
        workspaceRoot,
        ...(await writeDeliveryContext()),
        attributionMode: 'strict-delivery',
      })

      expect(result.outcome).toBe('imported')
      expect(result.snapshotProofMode).toBe('shadow')
      expect(result.snapshotShapeFingerprint).toBe('shape-v1')
      expect(result.diagnostics.some(diagnostic =>
        diagnostic.startsWith('snapshot-proof-shadow:') &&
        diagnostic.includes('wouldUpgrade=1') &&
        diagnostic.includes('applied=0')
      )).toBe(true)
      const eventFile = path.join(projectDir, '.board-task-changes', 'events', 'task-1.jsonl')
      const event = JSON.parse((await readFile(eventFile, 'utf8')).trim())
      expect(event).toMatchObject({
        source: 'opencode_toolpart_edit',
        confidence: 'medium',
        evidenceProof: 'metadata-only-fallback',
        before: null,
        after: null,
      })
    } finally {
      if (previousSnapshotProofMode === undefined) {
        delete process.env.OPENCODE_SNAPSHOT_PROOF_UPGRADE
      } else {
        process.env.OPENCODE_SNAPSHOT_PROOF_UPGRADE = previousSnapshotProofMode
      }
    }
  })

  test('falls back to metadata-only when session snapshot evidence is unavailable', async () => {
    const afterPath = path.join(workspaceRoot, 'src/existing.ts')
    await writeFile(afterPath, 'export const value = 2;\n', 'utf8')
    const editFixture = withSnapshotWindow({
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
          'tool-part-edit-existing',
          'assistant-1',
          {
            type: 'tool',
            tool: 'edit',
            callID: 'call-edit-existing',
            state: {
              status: 'completed',
              input: {
                filePath: afterPath,
                oldString: 'value = 1',
                newString: 'value = 2',
              },
              metadata: { exists: true, truncated: false },
              time: { end: 1000 },
            },
          },
          1000,
        ),
      ],
    })
    let providerCalled = false
    const missingSnapshotProvider: OpenCodeSnapshotEvidenceProvider = {
      adapterVersion: 1,
      async probe() {
        return { supported: true, shapeFingerprint: 'shape-v1', adapterVersion: 1 }
      },
      async readSessionEvidence() {
        providerCalled = true
        return {
          supported: false,
          code: 'snapshot-session-unavailable',
          diagnostics: ['snapshot-gitdir-missing: fixture snapshot gitdir does not exist.'],
        }
      },
    }
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      { readSession: async () => editFixture },
      new OpenCodeToolpartChangeReconstructor(),
      new OpenCodeChangeEvidenceEnricher(),
      missingSnapshotProvider,
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...(await writeDeliveryContext()),
      attributionMode: 'strict-delivery',
    })

    expect(providerCalled).toBe(true)
    expect(result.outcome).toBe('imported')
    expect(result.importedEvents).toBe(1)
    expect(result.snapshotShapeFingerprint).toBeUndefined()
    expect(result.diagnostics).toContain('snapshot-gitdir-missing: fixture snapshot gitdir does not exist.')
    const eventFile = path.join(projectDir, '.board-task-changes', 'events', 'task-1.jsonl')
    const event = JSON.parse((await readFile(eventFile, 'utf8')).trim())
    expect(event).toMatchObject({
      source: 'opencode_toolpart_edit',
      operation: 'modify',
      confidence: 'medium',
      evidenceProof: 'metadata-only-fallback',
      before: null,
      after: null,
      beforeState: {
        exists: true,
        unavailableReason: 'opencode-edit-baseline-not-captured',
      },
      afterState: {
        exists: true,
        sizeBytes: 24,
      },
    })
  })

  test('uses SQLite snapshot windows to upgrade apply_patch update evidence through verified hunks', async () => {
    const afterPath = path.join(workspaceRoot, 'src/existing.ts')
    await writeFile(afterPath, 'export const value = 2;\n', 'utf8')
    const patchFixture = withSnapshotWindow({
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
          'tool-part-apply-patch-update',
          'assistant-1',
          {
            type: 'tool',
            tool: 'apply_patch',
            callID: 'call-apply-patch-update',
            state: {
              status: 'completed',
              input: {
                patch: [
                  '*** Begin Patch',
                  '*** Update File: src/existing.ts',
                  '@@',
                  '-export const value = 1;',
                  '+export const value = 2;',
                  '*** End Patch',
                ].join('\n'),
              },
              time: { end: 1000 },
            },
          },
          1000,
        ),
      ],
    })
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      { readSession: async () => patchFixture },
      new OpenCodeToolpartChangeReconstructor(),
      new OpenCodeChangeEvidenceEnricher(),
      snapshotProvider({
        relativePath: 'src/existing.ts',
        beforeContent: 'export const value = 1;\n',
        afterContent: 'export const value = 2;\n',
        operation: 'modify',
      }),
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...(await writeDeliveryContext()),
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('imported')
    const eventFile = path.join(projectDir, '.board-task-changes', 'events', 'task-1.jsonl')
    const event = JSON.parse((await readFile(eventFile, 'utf8')).trim())
    expect(event).toMatchObject({
      source: 'opencode_toolpart_apply_patch',
      confidence: 'high',
      evidenceProof: 'inverse-apply-patch-chain',
      beforeState: { exists: true },
      afterState: { exists: true },
    })
    expect(event.before).toMatchObject({ sizeBytes: 24 })
    expect(event.after).toMatchObject({ sizeBytes: 24 })
  })

  test('imports OpenCode apply_patch Add File as exact create and keeps update/delete manual-only', async () => {
    await writeFile(
      path.join(workspaceRoot, 'src/new.ts'),
      'export const created = true;\n',
      'utf8',
    )
    await writeFile(
      path.join(workspaceRoot, 'src/existing.ts'),
      'export const value = 2;\n',
      'utf8',
    )
    const patchFixture = {
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
          'tool-part-apply-patch',
          'assistant-1',
          {
            type: 'tool',
            tool: 'apply_patch',
            callID: 'call-apply-patch',
            state: {
              status: 'completed',
              input: {
                patch: [
                  '*** Begin Patch',
                  '*** Add File: src/new.ts',
                  '+export const created = true;',
                  '*** Update File: src/existing.ts',
                  '@@',
                  '-export const value = 1;',
                  '+export const value = 2;',
                  '*** Delete File: src/old.ts',
                  '*** End Patch',
                ].join('\n'),
              },
              time: { end: 1000 },
            },
          },
          1000,
        ),
      ],
    }
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      { readSession: async () => patchFixture },
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...(await writeDeliveryContext()),
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('imported')
    expect(result.importedEvents).toBe(3)
    const eventFile = path.join(projectDir, '.board-task-changes', 'events', 'task-1.jsonl')
    const events = (await readFile(eventFile, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, any>)
    expect(events.map(event => [event.source, event.operation, event.relativePath])).toEqual([
      ['opencode_toolpart_apply_patch', 'create', 'src/new.ts'],
      ['opencode_toolpart_apply_patch', 'modify', 'src/existing.ts'],
      ['opencode_toolpart_apply_patch', 'delete', 'src/old.ts'],
    ])
    expect(events[0]?.beforeState).toMatchObject({
      exists: false,
      sizeBytes: 0,
    })
    expect(events[0]?.after).toMatchObject({
      sizeBytes: 29,
    })
    expect(events[0]?.afterState).toMatchObject({
      exists: true,
      sizeBytes: 29,
    })
    expect(events[0]?.confidence).toBe('exact')
    expect(events[2]?.afterState).toMatchObject({ exists: false })
    expect(events[1]?.warnings).toContain(
      'OpenCode apply_patch was captured without a git/snapshot baseline; apply/reject is manual-only.',
    )
  })

  test('keeps OpenCode backfill diagnostics free of prompt and raw patch content', async () => {
    const promptSecret = 'PROMPT_SECRET_SHOULD_NOT_LEAK'
    const patchSecret = 'PATCH_SECRET_SHOULD_NOT_LEAK'
    const patchFixture = {
      ...offlineFixture(),
      rawParts: [
        partRow(
          'user-part-1',
          'user-1',
          {
            text: promptSecret,
          },
          900,
        ),
        partRow(
          'tool-part-apply-patch-secret',
          'assistant-1',
          {
            type: 'tool',
            tool: 'apply_patch',
            callID: 'call-apply-patch-secret',
            state: {
              status: 'completed',
              input: {
                patch: [
                  '*** Begin Patch',
                  '*** Update File: src/secret.ts',
                  '@@',
                  patchSecret,
                  '*** End Patch',
                ].join('\n'),
              },
              time: { end: 1000 },
            },
          },
          1000,
        ),
      ],
    }
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      { readSession: async () => patchFixture },
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...(await writeDeliveryContext()),
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('no-attribution')
    expect(result.diagnostics.some(item => item.includes('unsupported hunk lines'))).toBe(true)
    const serializedDiagnostics = JSON.stringify(result.diagnostics)
    expect(serializedDiagnostics).not.toContain(promptSecret)
    expect(serializedDiagnostics).not.toContain(patchSecret)
  })

  test('materializes apply_patch binary and large final states as manual-only metadata', async () => {
    await writeFile(path.join(workspaceRoot, 'src/blob.bin'), Buffer.from([0, 1, 2, 3]))
    await writeFile(path.join(workspaceRoot, 'src/large.txt'), 'x'.repeat(1024 * 1024 + 1), 'utf8')
    const patchFixture = {
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
          'tool-part-apply-patch-binary-large',
          'assistant-1',
          {
            type: 'tool',
            tool: 'apply_patch',
            callID: 'call-apply-patch-binary-large',
            state: {
              status: 'completed',
              input: {
                patch: [
                  '*** Begin Patch',
                  '*** Update File: src/blob.bin',
                  '*** Update File: src/large.txt',
                  '*** End Patch',
                ].join('\n'),
              },
              time: { end: 1000 },
            },
          },
          1000,
        ),
      ],
    }
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      { readSession: async () => patchFixture },
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...(await writeDeliveryContext()),
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('imported')
    const eventFile = path.join(projectDir, '.board-task-changes', 'events', 'task-1.jsonl')
    const events = (await readFile(eventFile, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, any>)
    const binaryEvent = events.find(event => event.relativePath === 'src/blob.bin')
    const largeEvent = events.find(event => event.relativePath === 'src/large.txt')
    expect(binaryEvent?.afterState).toMatchObject({
      exists: true,
      sizeBytes: 4,
      unavailableReason: 'opencode-after-content-binary',
    })
    expect(typeof binaryEvent?.afterState?.sha256).toBe('string')
    expect(binaryEvent?.warnings).toContain(
      'OpenCode metadata-only capture found binary final content; review is manual-only.',
    )
    expect(largeEvent?.afterState).toMatchObject({
      exists: true,
      sizeBytes: 1024 * 1024 + 1,
      unavailableReason: 'opencode-after-content-too-large',
    })
    expect(largeEvent?.warnings).toContain(
      'OpenCode metadata-only capture skipped large final content; review is manual-only.',
    )
  })

  const symlinkTest = process.platform === 'win32' ? test.skip : test

  symlinkTest('does not read metadata-only final state through symlink paths', async () => {
    await writeFile(path.join(workspaceRoot, 'src/target.ts'), 'export const target = true;\n', 'utf8')
    await symlink('target.ts', path.join(workspaceRoot, 'src/link.ts'))
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
          'tool-part-edit-symlink',
          'assistant-1',
          {
            type: 'tool',
            tool: 'edit',
            callID: 'call-edit-symlink',
            state: {
              status: 'completed',
              input: {
                filePath: path.join(workspaceRoot, 'src/link.ts'),
                oldString: 'target = false',
                newString: 'target = true',
              },
              metadata: { exists: true, truncated: false },
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
      ...(await writeDeliveryContext()),
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('imported')
    const eventFile = path.join(projectDir, '.board-task-changes', 'events', 'task-1.jsonl')
    const event = JSON.parse((await readFile(eventFile, 'utf8')).trim())
    expect(event.afterState).toMatchObject({
      exists: true,
      unavailableReason: 'opencode-path-symlink-unresolved',
    })
    expect(event.warnings).toContain('OpenCode metadata-only capture found a symlink path; review is manual-only.')
  })

  test('fails closed on case-colliding paths in one OpenCode batch', async () => {
    const patchFixture = {
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
          'tool-part-apply-patch-case',
          'assistant-1',
          {
            type: 'tool',
            tool: 'apply_patch',
            callID: 'call-apply-patch-case',
            state: {
              status: 'completed',
              input: {
                patch: [
                  '*** Begin Patch',
                  '*** Add File: src/Foo.ts',
                  '+export const upper = true;',
                  '*** Add File: src/foo.ts',
                  '+export const lower = true;',
                  '*** End Patch',
                ].join('\n'),
              },
              time: { end: 1000 },
            },
          },
          1000,
        ),
      ],
    }
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      { readSession: async () => patchFixture },
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...(await writeDeliveryContext()),
      attributionMode: 'strict-delivery',
    })

    expect(result.importedEvents).toBe(0)
    expect(result.skippedEvents).toBe(2)
    expect(result.diagnostics).toContain('OpenCode evidence skipped 1 case-colliding path group(s).')
  })

  test('fails closed on sourceImportKey collisions with different file identity', async () => {
    const sourceImportKey = 'opencode\0session-1\0tool-part-1\0src/opencode.ts'
    const changes = [
      reconstructedChange({ sourceImportKey }),
      reconstructedChange({
        sourceImportKey,
        filePath: path.join(workspaceRoot, 'src/other.ts'),
        relativePath: 'src/other.ts',
        afterContent: 'export const other = 1;\n',
        afterState: { exists: true, sizeBytes: 24 },
      }),
    ]
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      { readSession: async () => offlineFixture() },
      {
        reconstruct: () => ({
          changes,
          notices: [],
          diagnostics: [],
        }),
      } as unknown as OpenCodeToolpartChangeReconstructor,
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...(await writeDeliveryContext()),
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('unsafe-input')
    expect(result.candidateEvents).toBe(2)
    expect(result.importedEvents).toBe(0)
    expect(result.skippedEvents).toBe(2)
    expect(result.diagnostics).toContain('OpenCode evidence skipped 1 sourceImportKey collision(s).')
  })

  test('skips snapshot-only reconstructed changes before importing ledger events', async () => {
    const changes = [
      reconstructedChange({
        toolUseId: 'part-snapshot-patch-1',
        sourcePartId: 'part-snapshot-patch-1',
        sourceTool: 'snapshot_patch',
        sourceImportKey: 'opencode\0session-1\0part-snapshot-patch-1\0src/ambient.ts',
        filePath: path.join(workspaceRoot, 'src/ambient.ts'),
        relativePath: 'src/ambient.ts',
        beforeContent: null,
        afterContent: 'export const ambient = 1;\n',
        beforeState: { exists: false, sizeBytes: 0 },
        afterState: { exists: true, sizeBytes: 26 },
        operation: 'create',
        confidence: 'high',
        evidenceProof: 'opencode-snapshot',
      }),
    ]
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      { readSession: async () => offlineFixture() },
      {
        reconstruct: () => ({
          changes,
          notices: [],
          diagnostics: [],
        }),
      } as unknown as OpenCodeToolpartChangeReconstructor,
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...(await writeDeliveryContext()),
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('no-attribution')
    expect(result.candidateEvents).toBe(0)
    expect(result.importedEvents).toBe(0)
    expect(result.skippedEvents).toBe(1)
    expect(result.diagnostics).toContain(
      'OpenCode ledger backfill skipped 1 snapshot-only change(s) because snapshot proof does not prove file authorship in shared workspaces.',
    )
  })

  test('suppresses stale imported snapshot-only ledger events from earlier bridge versions', async () => {
    const sourceImportKey = [
      'opencode',
      'session-1',
      'part-snapshot-patch-1',
      path.join(workspaceRoot, 'src/ambient.ts'),
    ].join('\0')
    const staleImport = await importTaskChangeLedgerEvents({
      projectDir,
      scope: {
        taskId: 'task-1',
        task: { ref: 'task-1', refKind: 'canonical' },
        phase: 'work',
        executionSeq: 0,
      },
      sessionId: 'session-1',
      memberName: 'bob',
      workspaceRoot,
      toolStatus: 'succeeded',
      changes: [
        {
          filePath: path.join(workspaceRoot, 'src/ambient.ts'),
          beforeContent: null,
          afterContent: 'export const ambient = 1;\n',
          source: 'opencode_toolpart_apply_patch',
          confidence: 'high',
          operation: 'create',
          beforeState: { exists: false, sizeBytes: 0 },
          afterState: { exists: true, sizeBytes: 26 },
          toolUseId: 'part-snapshot-patch-1',
          timestamp: '2026-03-01T10:00:00.000Z',
          sourceImportKey,
          sourceRuntime: 'opencode',
          sourceSessionId: 'session-1',
          sourcePartId: 'part-snapshot-patch-1',
          sourceMessageId: 'assistant-1',
          parentUserMessageId: 'user-1',
          attributionMethod: 'delivery-ledger-taskrefs',
          evidenceProof: 'opencode-snapshot',
        },
      ],
    })
    expect(staleImport.importedEventCount).toBe(1)
    const bundlePath = path.join(projectDir, '.board-task-changes', 'bundles', 'task-1.json')
    const beforeBundle = JSON.parse(await readFile(bundlePath, 'utf8')) as {
      totalFiles: number
      files: Array<{ relativePath: string }>
    }
    expect(beforeBundle.totalFiles).toBe(1)
    expect(beforeBundle.files.map(file => file.relativePath)).toEqual(['src/ambient.ts'])

    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      { readSession: async () => offlineFixture() },
      {
        reconstruct: () => ({
          changes: [],
          skippedSnapshotOnlyChanges: [
            {
              taskId: 'task-1',
              sourceImportKey,
              relativePath: 'src/ambient.ts',
              sourcePartId: 'part-snapshot-patch-1',
              sourceMessageId: 'assistant-1',
            },
          ],
          notices: [],
          diagnostics: [],
        }),
      } as unknown as OpenCodeToolpartChangeReconstructor,
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...(await writeDeliveryContext()),
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('no-attribution')
    expect(result.candidateEvents).toBe(0)
    expect(result.importedEvents).toBe(0)
    expect(result.skippedEvents).toBe(1)
    expect(result.diagnostics).toContain(
      'OpenCode ledger suppressed 1 stale snapshot-only imported change(s).',
    )
    const afterBundle = JSON.parse(await readFile(bundlePath, 'utf8')) as {
      totalFiles: number
      files: Array<{ relativePath: string }>
    }
    expect(afterBundle.totalFiles).toBe(0)
    expect(afterBundle.files).toEqual([])
    const eventFile = path.join(projectDir, '.board-task-changes', 'events', 'task-1.jsonl')
    const events = (await readFile(eventFile, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { eventId: string; suppressed?: true; supersedesEventId?: string })
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      suppressed: true,
      supersedesEventId: events[0]?.eventId,
    })

    const secondResult = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...(await writeDeliveryContext()),
      attributionMode: 'strict-delivery',
    })
    expect(secondResult.outcome).toBe('no-attribution')
    expect(secondResult.skippedEvents).toBe(0)
    const eventsAfterSecondRun = (await readFile(eventFile, 'utf8')).trim().split('\n')
    expect(eventsAfterSecondRun).toHaveLength(2)
  })

  test('does not reintroduce snapshot-only changes when evidence enrichment falls back', async () => {
    const changes = [
      reconstructedChange(),
      reconstructedChange({
        toolUseId: 'part-snapshot-patch-1',
        sourcePartId: 'part-snapshot-patch-1',
        sourceTool: 'snapshot_patch',
        sourceImportKey: 'opencode\0session-1\0part-snapshot-patch-1\0src/ambient.ts',
        filePath: path.join(workspaceRoot, 'src/ambient.ts'),
        relativePath: 'src/ambient.ts',
        beforeContent: null,
        afterContent: null,
        beforeState: {
          exists: true,
          unavailableReason: 'opencode-snapshot-patch-before-content-unavailable',
        },
        afterState: {
          exists: true,
          unavailableReason: 'opencode-snapshot-patch-after-content-unavailable',
        },
        operation: 'modify',
        confidence: 'medium',
        evidenceProof: 'metadata-only-fallback',
      }),
    ]
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      { readSession: async () => offlineFixture() },
      {
        reconstruct: () => ({
          changes,
          notices: [],
          diagnostics: [],
        }),
      } as unknown as OpenCodeToolpartChangeReconstructor,
      {
        enrich: async () => {
          throw new Error('snapshot probe boom')
        },
      } as unknown as OpenCodeChangeEvidenceEnricher,
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...(await writeDeliveryContext()),
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('imported')
    expect(result.candidateEvents).toBe(1)
    expect(result.importedEvents).toBe(1)
    expect(result.skippedEvents).toBe(1)
    expect(result.diagnostics).toContain(
      'OpenCode evidence enrichment failed; using metadata-only fallback - snapshot probe boom',
    )
    expect(result.diagnostics.join('\n')).not.toContain(
      'OpenCode metadata-only final disk state materialized for src/ambient.ts.',
    )
    const bundle = JSON.parse(
      await readFile(path.join(projectDir, '.board-task-changes', 'bundles', 'task-1.json'), 'utf8'),
    ) as { totalFiles: number; files: Array<{ relativePath: string }> }
    expect(bundle.totalFiles).toBe(1)
    expect(bundle.files.map(file => file.relativePath)).toEqual(['src/opencode.ts'])
  })

  test('downgrades apply_patch delete evidence when final disk state still exists', async () => {
    await writeFile(
      path.join(workspaceRoot, 'src/still-here.ts'),
      'export const stillHere = true;\n',
      'utf8',
    )
    const patchFixture = {
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
          'tool-part-delete',
          'assistant-1',
          {
            type: 'tool',
            tool: 'apply_patch',
            callID: 'call-delete',
            state: {
              status: 'completed',
              input: {
                patch: [
                  '*** Begin Patch',
                  '*** Delete File: src/still-here.ts',
                  '*** End Patch',
                ].join('\n'),
              },
              time: { end: 1000 },
            },
          },
          1000,
        ),
      ],
    }
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      { readSession: async () => patchFixture },
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      projectDir,
      workspaceRoot,
      ...(await writeDeliveryContext()),
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('imported')
    const eventFile = path.join(projectDir, '.board-task-changes', 'events', 'task-1.jsonl')
    const event = JSON.parse((await readFile(eventFile, 'utf8')).trim())
    expect(event).toMatchObject({
      source: 'opencode_toolpart_apply_patch',
      operation: 'modify',
      relativePath: 'src/still-here.ts',
      afterState: {
        exists: true,
      },
    })
    expect(event.warnings).toContain(
      'OpenCode apply_patch requested a delete, but the final disk state still exists; ledger records this as manual-only modify evidence.',
    )
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
      ...(await writeDeliveryContext()),
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
      ...(await writeDeliveryContext()),
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

  test('strict delivery backfill rejects tampered delivery context hashes', async () => {
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
    const context = await writeDeliveryContext()

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      memberName: 'bob',
      projectDir,
      workspaceRoot,
      deliveryContextPath: context.deliveryContextPath,
      deliveryContextHash: '0'.repeat(64),
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('no-attribution')
    expect(result.importedEvents).toBe(0)
    expect(readCount).toBe(0)
    expect(result.diagnostics).toContain('OpenCode delivery context hash mismatch.')
  })

  test('strict delivery backfill rejects untrusted delivery context paths', async () => {
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
    const rawContext = `${JSON.stringify({
      schemaVersion: 1,
      teamName: 'team-a',
      taskId: 'task-1',
      records: [
        {
          memberName: 'bob',
          laneId: 'primary',
          runtimeSessionId: 'session-1',
          inboxMessageId: 'user-1',
          deliveredUserMessageId: null,
          taskRefs: [{ taskId: 'task-1', displayId: 'abc12345', teamName: 'team-a' }],
        },
      ],
    })}\n`
    const deliveryContextPath = path.join(tempDir, 'delivery-context.json')
    await writeFile(deliveryContextPath, rawContext, 'utf8')

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      memberName: 'bob',
      projectDir,
      workspaceRoot,
      deliveryContextPath,
      deliveryContextHash: createHash('sha256').update(rawContext).digest('hex'),
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('no-attribution')
    expect(result.importedEvents).toBe(0)
    expect(readCount).toBe(0)
    expect(result.diagnostics).toContain(
      'OpenCode delivery context path rejected because it is outside the trusted app temp directory.',
    )
  })

  test('strict delivery backfill rejects relative delivery context paths', async () => {
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
    const context = await writeDeliveryContext()

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      memberName: 'bob',
      projectDir,
      workspaceRoot,
      deliveryContextPath: path.relative(process.cwd(), context.deliveryContextPath),
      deliveryContextHash: context.deliveryContextHash,
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('no-attribution')
    expect(result.importedEvents).toBe(0)
    expect(readCount).toBe(0)
    expect(result.diagnostics).toContain(
      'OpenCode delivery context path rejected because it is not absolute.',
    )
  })

  const deliveryContextSymlinkTest = process.platform === 'win32' ? test.skip : test

  deliveryContextSymlinkTest('strict delivery backfill rejects delivery context symlink escapes', async () => {
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
    const rawContext = `${JSON.stringify({
      schemaVersion: 1,
      teamName: 'team-a',
      taskId: 'task-1',
      records: [
        {
          memberName: 'bob',
          laneId: 'primary',
          runtimeSessionId: 'session-1',
          inboxMessageId: 'user-1',
          deliveredUserMessageId: null,
          taskRefs: [{ taskId: 'task-1', displayId: 'abc12345', teamName: 'team-a' }],
        },
      ],
    })}\n`
    const targetPath = path.join(tempDir, 'outside-delivery-context.json')
    await writeFile(targetPath, rawContext, 'utf8')
    const contextDir = await mkdtemp(path.join(tempDir, 'claude-team-opencode-ledger-context-'))
    await chmod(contextDir, 0o700).catch(() => undefined)
    const deliveryContextPath = path.join(contextDir, 'delivery-context.json')
    await symlink(targetPath, deliveryContextPath)

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      memberName: 'bob',
      projectDir,
      workspaceRoot,
      deliveryContextPath,
      deliveryContextHash: createHash('sha256').update(rawContext).digest('hex'),
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('no-attribution')
    expect(result.importedEvents).toBe(0)
    expect(readCount).toBe(0)
    expect(result.diagnostics).toContain(
      'OpenCode delivery context path rejected because the file resolves outside its trusted temp directory.',
    )
  })

  test('strict delivery backfill reports unsupported delivery context schema', async () => {
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
    const context = await writeTrustedDeliveryContextRaw(
      `${JSON.stringify({
        schemaVersion: 2,
        teamName: 'team-a',
        taskId: 'task-1',
        records: [],
      })}\n`,
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      memberName: 'bob',
      projectDir,
      workspaceRoot,
      ...context,
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('no-attribution')
    expect(result.importedEvents).toBe(0)
    expect(readCount).toBe(0)
    expect(result.diagnostics).toContain(
      'unsupported-delivery-context-schema: OpenCode delivery context failed schema validation.',
    )
  })

  test('strict delivery backfill ignores assistant comment text without toolparts', async () => {
    const commentOnlyFixture = {
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
          'assistant-text-1',
          'assistant-1',
          {
            type: 'text',
            text: 'Done, I changed src/opencode.ts and updated the implementation.',
          },
          1000,
        ),
      ],
    }
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      { readSession: async () => commentOnlyFixture },
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      taskDisplayId: 'abc12345',
      memberName: 'bob',
      projectDir,
      workspaceRoot,
      ...(await writeDeliveryContext()),
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('no-attribution')
    expect(result.scannedSessions).toBe(1)
    expect(result.scannedToolparts).toBe(2)
    expect(result.candidateEvents).toBe(0)
    expect(result.importedEvents).toBe(0)
    const eventFile = path.join(projectDir, '.board-task-changes', 'events', 'task-1.jsonl')
    const eventFileExists = await readFile(eventFile, 'utf8').then(
      () => true,
      () => false,
    )
    expect(eventFileExists).toBe(false)
  })

  test('strict delivery backfill rejects delivery records that only match display id', async () => {
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
      ...(await writeDeliveryContext({
        taskRefs: [{ taskId: 'old-task', displayId: 'abc12345', teamName: 'team-a' }],
      })),
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('no-attribution')
    expect(result.importedEvents).toBe(0)
    expect(readCount).toBe(0)
    expect(result.diagnostics).toContain(
      'OpenCode strict delivery attribution found no usable delivery records for this task.',
    )
  })

  test('strict delivery backfill rejects records that include related task refs', async () => {
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
      ...(await writeDeliveryContext({
        taskRefs: [
          { taskId: 'task-1', displayId: 'abc12345', teamName: 'team-a' },
          { taskId: 'related-task', displayId: 'def67890', teamName: 'team-a' },
        ],
      })),
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('no-attribution')
    expect(result.importedEvents).toBe(0)
    expect(readCount).toBe(0)
    expect(result.diagnostics).toContain(
      'OpenCode strict delivery attribution found no usable delivery records for this task.',
    )
  })

  test('strict delivery backfill imports with missing runtime session id when parent message id matches', async () => {
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
      ...(await writeDeliveryContext({ runtimeSessionId: null })),
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('imported')
    expect(result.importedEvents).toBe(1)
    const eventFile = path.join(projectDir, '.board-task-changes', 'events', 'task-1.jsonl')
    const event = JSON.parse((await readFile(eventFile, 'utf8')).trim())
    expect(event).toMatchObject({
      sourceSessionId: 'session-1',
      parentUserMessageId: 'user-1',
      attributionMethod: 'delivery-ledger-taskrefs',
      sourcePartId: 'tool-part-1',
    })
  })

  test('strict delivery backfill skips missing runtime session id when member lane has multiple sessions', async () => {
    let readCount = 0
    const service = new OpenCodeLedgerBridgeService(
      {
        list: async () => [
          sessionRecord(),
          sessionRecord({ opencodeSessionId: 'session-2' }),
        ],
      },
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
      ...(await writeDeliveryContext({ runtimeSessionId: null })),
      attributionMode: 'strict-delivery',
    })

    expect(result.outcome).toBe('no-attribution')
    expect(result.importedEvents).toBe(0)
    expect(readCount).toBe(0)
    expect(result.diagnostics).toContain(
      'OpenCode strict delivery attribution found no stored OpenCode session matching the delivery context.',
    )
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
      ...(await writeDeliveryContext({ runtimeSessionId: 'other-session' })),
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
      ...(await writeDeliveryContext()),
    })

    expect(result.outcome).toBe('skipped-capability')
    expect(result.importedEvents).toBe(0)
    expect(result.diagnostics).toContain(`${OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE}: missing part.data`)
  })

  test('returns skipped-capability when every OpenCode file toolpart has unsupported shape', async () => {
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      {
        readSession: async () => ({
          ...offlineFixture(),
          rawParts: [
            partRow('tool-part-bad-write', 'assistant-1', {
              type: 'tool',
              tool: 'write',
              state: {
                status: 'completed',
                input: {
                  content: 'missing path',
                },
              },
            }),
          ],
          diagnostics: [
            'OpenCode SQLite write toolpart tool-part-bad-write has unsupported state/input/filePath shape; it will be skipped.',
          ],
        }),
      },
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      projectDir,
      workspaceRoot,
      ...(await writeDeliveryContext()),
    })

    expect(result.outcome).toBe('skipped-capability')
    expect(result.candidateEvents).toBe(0)
    expect(result.importedEvents).toBe(0)
    expect(result.diagnostics).toContain(
      'OpenCode SQLite write toolpart tool-part-bad-write has unsupported state/input/filePath shape; it will be skipped.',
    )
    expect(result.diagnostics).toContain(
      'OpenCode write toolpart tool-part-bad-write missing state/input/filePath.',
    )
  })

  test('treats partial SQLite history caps as retryable without importing unproven files', async () => {
    const service = new OpenCodeLedgerBridgeService(
      { list: async () => [sessionRecord()] },
      {
        readSession: async () => ({
          ...offlineFixture(),
          rawMessages: [],
          rawParts: [],
          messages: [],
          diagnostics: ['OpenCode SQLite part cap exceeded for session-1.'],
        }),
      },
    )

    const result = await service.backfill({
      teamName: 'team-a',
      taskId: 'task-1',
      projectDir,
      workspaceRoot,
      ...(await writeDeliveryContext()),
    })

    expect(result.outcome).toBe('transient-error')
    expect(result.retryAfterReason).toBe('sqlite-history-cap-exceeded')
    expect(result.scannedSessions).toBe(1)
    expect(result.scannedToolparts).toBe(0)
    expect(result.candidateEvents).toBe(0)
    expect(result.importedEvents).toBe(0)
    expect(result.diagnostics).toContain('OpenCode SQLite part cap exceeded for session-1.')
  })

  test('treats SQLite WAL races and busy reads as retryable when no candidates were proven', async () => {
    const runWithDiagnostic = async (diagnostic: string) => {
      const service = new OpenCodeLedgerBridgeService(
        { list: async () => [sessionRecord()] },
        {
          readSession: async () => ({
            ...offlineFixture(),
            rawMessages: [],
            rawParts: [],
            messages: [],
            diagnostics: [diagnostic],
          }),
        },
      )

      return await service.backfill({
        teamName: 'team-a',
        taskId: 'task-1',
        projectDir,
        workspaceRoot,
        ...(await writeDeliveryContext()),
      })
    }

    const changed = await runWithDiagnostic(
      'OpenCode SQLite file changed while snapshot was read; using transaction snapshot.',
    )
    expect(changed.outcome).toBe('transient-error')
    expect(changed.retryAfterReason).toBe('sqlite-changed-during-read')
    expect(changed.importedEvents).toBe(0)

    const busy = await runWithDiagnostic('sqlite-busy: OpenCode SQLite read was busy; retry later.')
    expect(busy.outcome).toBe('transient-error')
    expect(busy.retryAfterReason).toBe('sqlite-busy')
    expect(busy.importedEvents).toBe(0)
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
      ...(await writeDeliveryContext()),
    })

    expect(result.outcome).toBe('imported')
    expect(result.importedEvents).toBe(1)
    expect(result.diagnostics).toContain(`${OPENCODE_UNSUPPORTED_HISTORY_SHAPE_CODE}: missing part.data`)
  })
})
