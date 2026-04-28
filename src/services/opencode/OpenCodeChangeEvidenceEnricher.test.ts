import { describe, expect, test } from 'bun:test'
import path from 'node:path'

import { OpenCodeChangeEvidenceEnricher } from './OpenCodeChangeEvidenceEnricher.js'
import { OPENCODE_SNAPSHOT_PROVIDER_UNAVAILABLE_DIAGNOSTIC } from './OpenCodeChangeEvidence.js'

import type { OpenCodeSnapshotEvidenceFile, OpenCodeSnapshotEvidenceProvider } from './OpenCodeChangeEvidence.js'
import type { ReconstructedOpenCodeToolChange } from './OpenCodeToolpartChangeReconstructor.js'
import type { OpenCodeSessionRecord } from './types.js'

const workspaceRoot = '/repo'

function sessionRecord(): OpenCodeSessionRecord {
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
  }
}

function change(overrides: Partial<ReconstructedOpenCodeToolChange> = {}): ReconstructedOpenCodeToolChange {
  return {
    taskId: 'task-1',
    taskRef: 'task-1',
    taskRefKind: 'canonical',
    teamName: 'team-a',
    memberName: 'bob',
    sessionId: 'session-1',
    parentUserMessageId: 'user-1',
    assistantMessageId: 'assistant-1',
    toolUseId: 'call-edit',
    sourcePartId: 'part-edit',
    sourceMessageId: 'assistant-1',
    sourceTool: 'edit',
    sourceImportKey: 'opencode\0session-1\0part-edit\0/repo/src/file.ts',
    filePath: path.join(workspaceRoot, 'src/file.ts'),
    relativePath: 'src/file.ts',
    beforeContent: null,
    afterContent: null,
    beforeState: {
      exists: true,
      unavailableReason: 'opencode-edit-baseline-not-captured',
    },
    afterState: {
      exists: true,
      unavailableReason: 'opencode-edit-final-content-unavailable',
    },
    operation: 'modify',
    confidence: 'medium',
    attributionMethod: 'delivery-ledger-taskrefs',
    oldString: 'value = 1',
    newString: 'value = 2',
    warnings: ['OpenCode edit was captured without a proven full-text baseline; apply/reject is manual-only.'],
    timestamp: '2026-04-26T10:00:00.000Z',
    ...overrides,
  }
}

function snapshotProvider(file: string | OpenCodeSnapshotEvidenceFile): OpenCodeSnapshotEvidenceProvider {
  return {
    adapterVersion: 1,
    async probe() {
      return {
        supported: true,
        shapeFingerprint: 'shape-v1',
        adapterVersion: 1,
      }
    },
    async readBoundaryEvidence() {
      return {
        supported: true,
        shapeFingerprint: 'shape-v1',
        adapterVersion: 1,
        files: [
          typeof file === 'string'
            ? {
                relativePath: 'src/file.ts',
                afterContent: file,
              }
            : file,
        ],
      }
    },
  }
}

describe('OpenCodeChangeEvidenceEnricher', () => {
  test('passes metadata-only changes through in chain-only mode', async () => {
    const diagnostics: string[] = []
    const result = await new OpenCodeChangeEvidenceEnricher().enrich({
      workspaceRoot,
      sessionRecord: sessionRecord(),
      changes: [change()],
      evidenceMode: 'chain-only',
      diagnostics,
    })

    expect(diagnostics).toEqual([])
    expect(result[0]).toMatchObject({
      beforeContent: null,
      afterContent: null,
      evidenceProof: 'metadata-only-fallback',
    })
  })

  test('does not label partial write overwrite evidence as a full toolpart-chain proof', async () => {
    const diagnostics: string[] = []
    const result = await new OpenCodeChangeEvidenceEnricher().enrich({
      workspaceRoot,
      sessionRecord: sessionRecord(),
      changes: [
        change({
          sourceTool: 'write',
          beforeContent: null,
          afterContent: 'export const value = 2;\n',
          beforeState: {
            exists: true,
            unavailableReason: 'opencode-before-content-unavailable',
          },
          afterState: {
            exists: true,
            sha256: 'after-hash',
            sizeBytes: 24,
          },
          operation: 'modify',
        }),
      ],
      evidenceMode: 'chain-only',
      diagnostics,
    })

    expect(result[0]).toMatchObject({
      evidenceProof: 'metadata-only-fallback',
    })
  })

  test('does not use snapshot evidence without a captured boundary', async () => {
    const diagnostics: string[] = []
    const result = await new OpenCodeChangeEvidenceEnricher().enrich({
      workspaceRoot,
      sessionRecord: sessionRecord(),
      changes: [change()],
      evidenceMode: 'snapshot-auto',
      snapshotBoundary: { schemaVersion: 1, captureStatus: 'not-terminal' },
      snapshotProvider: snapshotProvider('export const value = 2;\n'),
      diagnostics,
    })

    expect(result[0]?.beforeContent).toBeNull()
    expect(diagnostics).toContain(
      'OpenCode snapshot evidence skipped because delivery snapshot boundary is unavailable or not terminal.',
    )
  })

  test('fails closed with an explicit diagnostic when snapshot-auto has no provider', async () => {
    const diagnostics: string[] = []
    const result = await new OpenCodeChangeEvidenceEnricher().enrich({
      workspaceRoot,
      sessionRecord: sessionRecord(),
      changes: [change()],
      evidenceMode: 'snapshot-auto',
      snapshotBoundary: {
        schemaVersion: 1,
        captureStatus: 'captured',
        preDeliverySnapshotHash: 'pre',
        postDeliverySnapshotHash: 'post',
      },
      diagnostics,
    })

    expect(result[0]).toMatchObject({
      beforeContent: null,
      afterContent: null,
      evidenceProof: 'metadata-only-fallback',
    })
    expect(diagnostics).toContain(OPENCODE_SNAPSHOT_PROVIDER_UNAVAILABLE_DIAGNOSTIC)
  })

  test('upgrades edit-only suffix using a captured snapshot after anchor', async () => {
    const diagnostics: string[] = []
    const result = await new OpenCodeChangeEvidenceEnricher().enrich({
      workspaceRoot,
      sessionRecord: sessionRecord(),
      changes: [change()],
      evidenceMode: 'snapshot-auto',
      snapshotBoundary: {
        schemaVersion: 1,
        captureStatus: 'captured',
        preDeliverySnapshotHash: 'pre',
        postDeliverySnapshotHash: 'post',
      },
      snapshotProvider: snapshotProvider('export const value = 2;\n'),
      diagnostics,
    })

    expect(diagnostics).toEqual([])
    expect(result[0]).toMatchObject({
      beforeContent: 'export const value = 1;\n',
      afterContent: 'export const value = 2;\n',
      confidence: 'high',
      evidenceProof: 'inverse-edit-chain',
    })
  })

  test('upgrades a contiguous edit chain from a captured snapshot after anchor', async () => {
    const diagnostics: string[] = []
    const first = change({
      sourcePartId: 'part-edit-1',
      sourceImportKey: 'opencode\0session-1\0part-edit-1\0/repo/src/file.ts',
      oldString: 'value = 1',
      newString: 'value = 2',
    })
    const second = change({
      sourcePartId: 'part-edit-2',
      sourceImportKey: 'opencode\0session-1\0part-edit-2\0/repo/src/file.ts',
      oldString: 'value = 2',
      newString: 'value = 3',
    })
    const result = await new OpenCodeChangeEvidenceEnricher().enrich({
      workspaceRoot,
      sessionRecord: sessionRecord(),
      changes: [first, second],
      evidenceMode: 'snapshot-auto',
      snapshotBoundary: {
        schemaVersion: 1,
        captureStatus: 'captured',
        preDeliverySnapshotHash: 'pre',
        postDeliverySnapshotHash: 'post',
      },
      snapshotProvider: snapshotProvider('export const value = 3;\n'),
      diagnostics,
    })

    expect(result.map(item => ({
      beforeContent: item.beforeContent,
      afterContent: item.afterContent,
      evidenceProof: item.evidenceProof,
    }))).toEqual([
      {
        beforeContent: 'export const value = 1;\n',
        afterContent: 'export const value = 2;\n',
        evidenceProof: 'inverse-edit-chain',
      },
      {
        beforeContent: 'export const value = 2;\n',
        afterContent: 'export const value = 3;\n',
        evidenceProof: 'inverse-edit-chain',
      },
    ])
  })

  test('keeps ambiguous inverse edit metadata-only', async () => {
    const diagnostics: string[] = []
    const result = await new OpenCodeChangeEvidenceEnricher().enrich({
      workspaceRoot,
      sessionRecord: sessionRecord(),
      changes: [change()],
      evidenceMode: 'snapshot-auto',
      snapshotBoundary: {
        schemaVersion: 1,
        captureStatus: 'captured',
        preDeliverySnapshotHash: 'pre',
        postDeliverySnapshotHash: 'post',
      },
      snapshotProvider: snapshotProvider('value = 2; value = 2;\n'),
      diagnostics,
    })

    expect(result[0]).toMatchObject({
      beforeContent: null,
      afterContent: null,
      evidenceProof: 'metadata-only-fallback',
    })
  })

  test('upgrades apply_patch update only when a captured snapshot after anchor verifies the hunk', async () => {
    const diagnostics: string[] = []
    const result = await new OpenCodeChangeEvidenceEnricher().enrich({
      workspaceRoot,
      sessionRecord: sessionRecord(),
      changes: [
        change({
          sourceTool: 'apply_patch',
          oldString: undefined,
          newString: undefined,
          patchUpdateHunks: [
            {
              beforeSnippet: 'export const value = 1;\n',
              afterSnippet: 'export const value = 2;\n',
            },
          ],
        }),
      ],
      evidenceMode: 'snapshot-auto',
      snapshotBoundary: {
        schemaVersion: 1,
        captureStatus: 'captured',
        preDeliverySnapshotHash: 'pre',
        postDeliverySnapshotHash: 'post',
      },
      snapshotProvider: snapshotProvider('export const value = 2;\n'),
      diagnostics,
    })

    expect(result[0]).toMatchObject({
      beforeContent: 'export const value = 1;\n',
      afterContent: 'export const value = 2;\n',
      confidence: 'high',
      evidenceProof: 'inverse-apply-patch-chain',
    })
  })

  test('upgrades apply_patch delete only when snapshot proves deleted before content', async () => {
    const diagnostics: string[] = []
    const result = await new OpenCodeChangeEvidenceEnricher().enrich({
      workspaceRoot,
      sessionRecord: sessionRecord(),
      changes: [
        change({
          sourceTool: 'apply_patch',
          operation: 'delete',
          oldString: undefined,
          newString: undefined,
        }),
      ],
      evidenceMode: 'snapshot-auto',
      snapshotBoundary: {
        schemaVersion: 1,
        captureStatus: 'captured',
        preDeliverySnapshotHash: 'pre',
        postDeliverySnapshotHash: 'post',
      },
      snapshotProvider: snapshotProvider({
        relativePath: 'src/file.ts',
        beforeContent: 'export const value = 1;\n',
        operation: 'delete',
      }),
      diagnostics,
    })

    expect(result[0]).toMatchObject({
      beforeContent: 'export const value = 1;\n',
      afterContent: null,
      afterState: { exists: false, sizeBytes: 0 },
      confidence: 'high',
      evidenceProof: 'opencode-snapshot',
    })
  })
})
