import { describe, expect, test } from 'bun:test'
import path from 'node:path'

import { OpenCodeChangeEvidenceEnricher } from './OpenCodeChangeEvidenceEnricher.js'
import {
  normalizeOpenCodeSnapshotProofUpgradeMode,
  OPENCODE_SNAPSHOT_PROVIDER_UNAVAILABLE_DIAGNOSTIC,
} from './OpenCodeChangeEvidence.js'

import type { OpenCodeSnapshotEvidenceFile, OpenCodeSnapshotEvidenceProvider } from './OpenCodeChangeEvidence.js'
import type { OpenCodeOfflineSessionReadResult } from './OpenCodeOfflineSessionReader.js'
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
    async readSessionEvidence() {
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

function offlineFixture(overrides: Partial<OpenCodeOfflineSessionReadResult> = {}): OpenCodeOfflineSessionReadResult {
  return {
    source: 'opencode-sqlite',
    dbPath: '/tmp/opencode.db',
    dbFingerprint: { dbMtimeMs: 1, dbSizeBytes: 1 },
    historyShape: 'supported',
    sessionIdentity: null,
    snapshotStepParts: [],
    patchParts: [],
    snapshotWindows: [
      {
        windowId: 'assistant-1:start->finish',
        messageId: 'assistant-1',
        sessionId: 'session-1',
        fromSnapshot: '1'.repeat(40),
        toSnapshot: '2'.repeat(40),
        startPartId: 'start',
        finishPartId: 'finish',
        startPartOrder: 0,
        finishPartOrder: 2,
      },
    ],
    rawMessages: [],
    rawParts: [],
    messages: [],
    diagnostics: [],
    ...overrides,
  }
}

describe('OpenCodeChangeEvidenceEnricher', () => {
  test('normalizes snapshot proof upgrade mode env values conservatively', () => {
    expect(normalizeOpenCodeSnapshotProofUpgradeMode(' OFF ')).toBe('off')
    expect(normalizeOpenCodeSnapshotProofUpgradeMode('shadow')).toBe('shadow')
    expect(normalizeOpenCodeSnapshotProofUpgradeMode('SINGLE-CHANGE')).toBe('single-change')
    expect(normalizeOpenCodeSnapshotProofUpgradeMode('full')).toBe('full')
    expect(normalizeOpenCodeSnapshotProofUpgradeMode('')).toBe('full')
    expect(normalizeOpenCodeSnapshotProofUpgradeMode('unexpected')).toBe('off')
  })

  test('keeps metadata-only fallback when snapshot evidence is unavailable', async () => {
    const diagnostics: string[] = []
    const result = await new OpenCodeChangeEvidenceEnricher().enrich({
      workspaceRoot,
      sessionRecord: sessionRecord(),
      changes: [change()],
      diagnostics,
    })

    expect(diagnostics).toContain(OPENCODE_SNAPSHOT_PROVIDER_UNAVAILABLE_DIAGNOSTIC)
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
      diagnostics,
    })

    expect(result[0]).toMatchObject({
      evidenceProof: 'metadata-only-fallback',
    })
  })

  test('upgrades write overwrites when session snapshot proves full before and after text', async () => {
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
          warnings: [
            'OpenCode write overwrote an existing file before the bridge had a known baseline; reject is manual-only.',
          ],
        }),
      ],
      offline: offlineFixture(),
      snapshotProvider: snapshotProvider({
        relativePath: 'src/file.ts',
        operation: 'modify',
        beforeContent: 'export const value = 1;\n',
        afterContent: 'export const value = 2;\n',
        snapshotId: 'snapshot-proof',
      }),
      diagnostics,
    })

    expect(diagnostics).toEqual([])
    expect(result[0]).toMatchObject({
      beforeContent: 'export const value = 1;\n',
      afterContent: 'export const value = 2;\n',
      confidence: 'high',
      evidenceProof: 'opencode-snapshot',
      snapshotId: 'snapshot-proof',
      snapshotSource: 'opencode',
      warnings: [],
    })
  })

  test('upgrades snapshot patch placeholders when snapshot evidence proves before and after text', async () => {
    const diagnostics: string[] = []
    const result = await new OpenCodeChangeEvidenceEnricher().enrich({
      workspaceRoot,
      sessionRecord: sessionRecord(),
      changes: [
        change({
          sourceTool: 'snapshot_patch',
          sourcePartId: 'part-patch',
          sourceImportKey: 'opencode\0session-1\0part-patch\0/repo/src/file.ts',
          oldString: undefined,
          newString: undefined,
          warnings: [
            'OpenCode snapshot patch was captured without a matching file toolpart; full review depends on snapshot evidence.',
          ],
        }),
      ],
      offline: offlineFixture(),
      snapshotProvider: snapshotProvider({
        relativePath: 'src/file.ts',
        operation: 'modify',
        beforeContent: 'export const value = 1;\n',
        afterContent: 'export const value = 2;\n',
        snapshotId: 'snapshot-proof',
      }),
      diagnostics,
    })

    expect(diagnostics).toEqual([])
    expect(result[0]).toMatchObject({
      beforeContent: 'export const value = 1;\n',
      afterContent: 'export const value = 2;\n',
      operation: 'modify',
      confidence: 'high',
      evidenceProof: 'opencode-snapshot',
      snapshotId: 'snapshot-proof',
      snapshotSource: 'opencode',
      warnings: [],
    })
  })

  test('upgrades snapshot patch placeholders before later same-path edit toolparts', async () => {
    const diagnostics: string[] = []
    const result = await new OpenCodeChangeEvidenceEnricher().enrich({
      workspaceRoot,
      sessionRecord: sessionRecord(),
      changes: [
        change({
          sourceTool: 'snapshot_patch',
          sourcePartId: 'part-patch',
          sourceImportKey: 'opencode\0session-1\0part-patch\0/repo/src/file.ts',
          oldString: undefined,
          newString: undefined,
          warnings: [
            'OpenCode snapshot patch was captured without a matching file toolpart; full review depends on snapshot evidence.',
          ],
        }),
        change({
          sourcePartId: 'part-edit',
          sourceImportKey: 'opencode\0session-1\0part-edit\0/repo/src/file.ts',
          oldString: 'value = 2',
          newString: 'value = 3',
        }),
      ],
      offline: offlineFixture(),
      snapshotProvider: snapshotProvider({
        relativePath: 'src/file.ts',
        operation: 'modify',
        beforeContent: 'export const value = 1;\n',
        afterContent: 'export const value = 3;\n',
        snapshotId: 'snapshot-proof',
      }),
      diagnostics,
    })

    expect(diagnostics).toEqual([])
    expect(result[0]).toMatchObject({
      beforeContent: 'export const value = 1;\n',
      afterContent: 'export const value = 2;\n',
      operation: 'modify',
      confidence: 'high',
      evidenceProof: 'opencode-snapshot',
      warnings: [],
    })
    expect(result[1]).toMatchObject({
      beforeContent: 'export const value = 2;\n',
      afterContent: 'export const value = 3;\n',
      confidence: 'high',
      evidenceProof: 'inverse-edit-chain',
    })
  })

  test('does not use snapshot evidence without SQLite snapshot windows', async () => {
    const diagnostics: string[] = []
    const result = await new OpenCodeChangeEvidenceEnricher().enrich({
      workspaceRoot,
      sessionRecord: sessionRecord(),
      changes: [change()],
      offline: offlineFixture({ snapshotWindows: [] }),
      snapshotProvider: snapshotProvider('export const value = 2;\n'),
      diagnostics,
    })

    expect(result[0]?.beforeContent).toBeNull()
    expect(diagnostics).toContain(
      'OpenCode snapshot evidence skipped because SQLite snapshot windows are unavailable.',
    )
  })

  test('fails closed with an explicit diagnostic when snapshot-auto has no provider', async () => {
    const diagnostics: string[] = []
    const result = await new OpenCodeChangeEvidenceEnricher().enrich({
      workspaceRoot,
      sessionRecord: sessionRecord(),
      changes: [change()],
      offline: offlineFixture(),
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
      offline: offlineFixture(),
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
      offline: offlineFixture(),
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

  test('does not snapshot-upgrade a same-path chain unless every toolpart verifies', async () => {
    const diagnostics: string[] = []
    const first = change({
      sourcePartId: 'part-edit-1',
      sourceImportKey: 'opencode\0session-1\0part-edit-1\0/repo/src/file.ts',
      oldString: 'missing = 1',
      newString: 'missing = 2',
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
      offline: offlineFixture(),
      snapshotProvider: snapshotProvider('export const value = 3;\n'),
      diagnostics,
    })

    expect(result.map(item => item.evidenceProof)).toEqual([
      'metadata-only-fallback',
      'metadata-only-fallback',
    ])
    expect(result.every(item => item.beforeContent === null && item.afterContent === null)).toBe(true)
    expect(diagnostics).toContain(
      'snapshot-window-path-ambiguous: src/file.ts had a same-window toolpart chain that could not be fully verified.',
    )
  })

  test('keeps ambiguous inverse edit metadata-only', async () => {
    const diagnostics: string[] = []
    const result = await new OpenCodeChangeEvidenceEnricher().enrich({
      workspaceRoot,
      sessionRecord: sessionRecord(),
      changes: [change()],
      offline: offlineFixture(),
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
      offline: offlineFixture(),
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
      offline: offlineFixture(),
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

  test('off mode does not read snapshot evidence or upgrade metadata-only changes', async () => {
    const diagnostics: string[] = []
    const throwingProvider: OpenCodeSnapshotEvidenceProvider = {
      adapterVersion: 1,
      async probe() {
        throw new Error('unexpected probe')
      },
      async readSessionEvidence() {
        throw new Error('unexpected snapshot read')
      },
    }
    const result = await new OpenCodeChangeEvidenceEnricher().enrich({
      workspaceRoot,
      sessionRecord: sessionRecord(),
      changes: [change()],
      offline: offlineFixture(),
      snapshotProvider: throwingProvider,
      snapshotProofMode: 'off',
      diagnostics,
    })

    expect(result[0]).toMatchObject({
      beforeContent: null,
      afterContent: null,
      evidenceProof: 'metadata-only-fallback',
    })
    expect(diagnostics).toContain(
      'snapshot-upgrade-skipped/feature-flag-off: OpenCode snapshot proof upgrade is disabled.',
    )
  })

  test('shadow mode computes proof stats but returns original metadata-only changes', async () => {
    const diagnostics: string[] = []
    const result = await new OpenCodeChangeEvidenceEnricher().enrich({
      workspaceRoot,
      sessionRecord: sessionRecord(),
      changes: [change()],
      offline: offlineFixture(),
      snapshotProvider: snapshotProvider('export const value = 2;\n'),
      snapshotProofMode: 'shadow',
      diagnostics,
    })

    expect(result[0]).toMatchObject({
      beforeContent: null,
      afterContent: null,
      evidenceProof: 'metadata-only-fallback',
    })
    expect(diagnostics.some(diagnostic =>
      diagnostic.startsWith('snapshot-proof-shadow:') &&
      diagnostic.includes('wouldUpgrade=1') &&
      diagnostic.includes('applied=0')
    )).toBe(true)
  })

  test('single-change mode skips same-path chains without applying snapshot proof', async () => {
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
      offline: offlineFixture(),
      snapshotProvider: snapshotProvider('export const value = 3;\n'),
      snapshotProofMode: 'single-change',
      diagnostics,
    })

    expect(result.map(item => item.evidenceProof)).toEqual([
      'metadata-only-fallback',
      'metadata-only-fallback',
    ])
    expect(diagnostics).toContain('snapshot-upgrade-skipped/single-change-only: src/file.ts')
  })

  test('fails closed when snapshot before boundary contradicts the verified inverse edit', async () => {
    const diagnostics: string[] = []
    const result = await new OpenCodeChangeEvidenceEnricher().enrich({
      workspaceRoot,
      sessionRecord: sessionRecord(),
      changes: [change()],
      offline: offlineFixture(),
      snapshotProvider: snapshotProvider({
        relativePath: 'src/file.ts',
        operation: 'modify',
        beforeContent: 'export const value = 0;\n',
        afterContent: 'export const value = 2;\n',
      }),
      diagnostics,
    })

    expect(result[0]).toMatchObject({
      beforeContent: null,
      afterContent: null,
      evidenceProof: 'metadata-only-fallback',
    })
    expect(diagnostics).toContain('snapshot-upgrade-skipped/path-chain-boundary-mismatch: src/file.ts')
  })

  test('removes only known baseline warnings after proof and preserves unrelated manual-only warnings', async () => {
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
          warnings: [
            'OpenCode write overwrote an existing file before the bridge had a known baseline; reject is manual-only.',
            'Task boundary warning: review remains manual-only.',
          ],
        }),
      ],
      offline: offlineFixture(),
      snapshotProvider: snapshotProvider({
        relativePath: 'src/file.ts',
        operation: 'modify',
        beforeContent: 'export const value = 1;\n',
        afterContent: 'export const value = 2;\n',
      }),
      diagnostics,
    })

    expect(result[0]?.warnings).toEqual([
      'Task boundary warning: review remains manual-only.',
    ])
  })

  test('keeps duplicate snapshot file anchors metadata-only', async () => {
    const diagnostics: string[] = []
    const duplicateProvider: OpenCodeSnapshotEvidenceProvider = {
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
            {
              relativePath: 'src/file.ts',
              afterContent: 'export const value = 2;\n',
            },
            {
              relativePath: 'src/file.ts',
              afterContent: 'export const value = 3;\n',
            },
          ],
        }
      },
    }
    const result = await new OpenCodeChangeEvidenceEnricher().enrich({
      workspaceRoot,
      sessionRecord: sessionRecord(),
      changes: [change()],
      offline: offlineFixture(),
      snapshotProvider: duplicateProvider,
      diagnostics,
    })

    expect(result[0]).toMatchObject({
      beforeContent: null,
      afterContent: null,
      evidenceProof: 'metadata-only-fallback',
    })
    expect(diagnostics).toContain('snapshot-upgrade-skipped/duplicate-file-anchor: src/file.ts')
  })
})
