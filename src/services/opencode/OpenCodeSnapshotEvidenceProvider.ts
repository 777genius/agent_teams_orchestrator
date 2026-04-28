import { createHash } from 'node:crypto'
import path from 'node:path'

import {
  type OpenCodeSnapshotEvidenceFile,
  type OpenCodeSnapshotEvidenceProvider,
  type OpenCodeSnapshotEvidenceResult,
  type OpenCodeSnapshotProbeResult,
  type SnapshotProbeInput,
  type SnapshotSessionEvidenceInput,
} from './OpenCodeChangeEvidence.js'
import { normalizeOpenCodeSnapshotRelativePath, OpenCodeSnapshotGitStoreReader } from './OpenCodeSnapshotGitStoreReader.js'

import type { ReconstructedOpenCodeToolChange } from './OpenCodeToolpartChangeReconstructor.js'

const ADAPTER_VERSION = 2
const SNAPSHOT_SHAPE_FINGERPRINT = `opencode-snapshot-git-store-v${ADAPTER_VERSION}`

function sameResolvedPath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right)
}

function fingerprintWindow(windowId: string, fromSnapshot: string, toSnapshot: string): string {
  return createHash('sha256')
    .update(`${windowId}\0${fromSnapshot}\0${toSnapshot}`)
    .digest('hex')
    .slice(0, 24)
}

function partOrderById(parts: SnapshotSessionEvidenceInput['offline']['rawParts']): Map<string, number> {
  const byMessage = new Map<string, typeof parts>()
  for (const part of parts) {
    const bucket = byMessage.get(part.message_id) ?? []
    bucket.push(part)
    byMessage.set(part.message_id, bucket)
  }
  const result = new Map<string, number>()
  for (const rows of byMessage.values()) {
    rows.sort((left, right) => left.id.localeCompare(right.id))
    rows.forEach((row, index) => result.set(row.id, index))
  }
  return result
}

function groupChangesByWindow(input: SnapshotSessionEvidenceInput, diagnostics: string[]): Map<string, {
  window: SnapshotSessionEvidenceInput['offline']['snapshotWindows'][number]
  changes: ReconstructedOpenCodeToolChange[]
}> {
  const orderByPart = partOrderById(input.offline.rawParts)
  const windowsByMessage = new Map<string, SnapshotSessionEvidenceInput['offline']['snapshotWindows']>()
  for (const window of input.offline.snapshotWindows) {
    const bucket = windowsByMessage.get(window.messageId) ?? []
    bucket.push(window)
    windowsByMessage.set(window.messageId, bucket)
  }

  const result = new Map<string, {
    window: SnapshotSessionEvidenceInput['offline']['snapshotWindows'][number]
    changes: ReconstructedOpenCodeToolChange[]
  }>()
  for (const change of input.changes) {
    const windows = windowsByMessage.get(change.sourceMessageId) ?? []
    if (windows.length === 0) {
      diagnostics.push(`snapshot-window-missing: no OpenCode snapshot window for message ${change.sourceMessageId}.`)
      continue
    }
    const order = orderByPart.get(change.sourcePartId)
    if (order === undefined) {
      diagnostics.push(`snapshot-window-missing: no part order for toolpart ${change.sourcePartId}.`)
      continue
    }
    const matching = windows.filter(window =>
      order >= window.startPartOrder &&
      order <= window.finishPartOrder
    )
    if (matching.length === 0) {
      diagnostics.push(`snapshot-window-missing: toolpart ${change.sourcePartId} is outside OpenCode snapshot windows for message ${change.sourceMessageId}.`)
      continue
    }
    if (matching.length > 1) {
      diagnostics.push(`snapshot-window-path-ambiguous: toolpart ${change.sourcePartId} matched multiple OpenCode snapshot windows.`)
      continue
    }
    const window = matching[0]
    const bucket = result.get(window.windowId) ?? { window, changes: [] }
    bucket.changes.push(change)
    result.set(window.windowId, bucket)
  }
  return result
}

export class OpenCodeSnapshotEvidenceProviderService implements OpenCodeSnapshotEvidenceProvider {
  readonly adapterVersion = ADAPTER_VERSION

  constructor(private readonly gitStoreReader = new OpenCodeSnapshotGitStoreReader()) {}

  async probe(_input: SnapshotProbeInput): Promise<OpenCodeSnapshotProbeResult> {
    return {
      supported: true,
      shapeFingerprint: SNAPSHOT_SHAPE_FINGERPRINT,
      adapterVersion: this.adapterVersion,
    }
  }

  async readSessionEvidence(input: SnapshotSessionEvidenceInput): Promise<OpenCodeSnapshotEvidenceResult> {
    const diagnostics: string[] = []
    const identity = input.offline.sessionIdentity
    if (!identity || !identity.snapshotEvidenceSupported || !identity.projectId || !identity.directory || !identity.project?.worktree) {
      return {
        supported: false,
        code: 'snapshot-boundary-unavailable',
        diagnostics: [
          ...diagnostics,
          ...(identity?.unsupportedReasons ?? ['snapshot-project-identity-missing']).map(reason =>
            `${reason}: OpenCode snapshot session identity is not usable for full-text evidence.`
          ),
        ],
      }
    }
    if (!sameResolvedPath(input.workspaceRoot, identity.project.worktree)) {
      return {
        supported: false,
        code: 'snapshot-boundary-unavailable',
        diagnostics: ['snapshot-project-worktree-mismatch: workspace root does not match OpenCode project worktree.'],
      }
    }
    if (input.offline.snapshotWindows.length === 0) {
      return {
        supported: false,
        code: 'snapshot-boundary-unavailable',
        diagnostics: ['snapshot-window-missing: OpenCode SQLite history has no paired snapshot windows.'],
      }
    }

    const grouped = groupChangesByWindow(input, diagnostics)
    if (grouped.size === 0) {
      return {
        supported: true,
        shapeFingerprint: SNAPSHOT_SHAPE_FINGERPRINT,
        adapterVersion: this.adapterVersion,
        files: [],
        diagnostics,
      }
    }

    const files: OpenCodeSnapshotEvidenceFile[] = []
    for (const { window, changes } of grouped.values()) {
      const touchedRelativePaths = [...new Set(changes
        .map(change => normalizeOpenCodeSnapshotRelativePath(change.relativePath))
        .filter((relativePath): relativePath is string => !!relativePath))]
      const read = await this.gitStoreReader.read({
        profileRootKey: input.sessionRecord.profileRootKey,
        projectId: identity.projectId,
        worktree: identity.project.worktree,
        directory: identity.directory,
        fromSnapshot: window.fromSnapshot,
        toSnapshot: window.toSnapshot,
        touchedRelativePaths,
        limits: {
          maxFiles: 100,
          maxBytesPerTextFile: 1024 * 1024,
          maxTotalBytes: 4 * 1024 * 1024,
          timeoutMs: 3000,
        },
      })
      if (!read.supported) {
        diagnostics.push(...read.diagnostics)
        continue
      }
      diagnostics.push(...read.diagnostics)
      const snapshotId = fingerprintWindow(window.windowId, window.fromSnapshot, window.toSnapshot)
      for (const file of read.files) {
        files.push({
          relativePath: file.relativePath,
          ...(typeof file.beforeContent === 'string' ? { beforeContent: file.beforeContent } : {}),
          ...(typeof file.afterContent === 'string' ? { afterContent: file.afterContent } : {}),
          operation: file.operation,
          beforeState: file.beforeState,
          afterState: file.afterState,
          snapshotId,
          warnings: [
            ...(file.warnings ?? []),
            ...(file.beforeState.unavailableReason
              ? [`Before snapshot content unavailable for ${file.relativePath}: ${file.beforeState.unavailableReason}.`]
              : []),
            ...(file.afterState.unavailableReason
              ? [`After snapshot content unavailable for ${file.relativePath}: ${file.afterState.unavailableReason}.`]
              : []),
          ],
        })
      }
    }

    return {
      supported: true,
      shapeFingerprint: SNAPSHOT_SHAPE_FINGERPRINT,
      adapterVersion: this.adapterVersion,
      files,
      diagnostics,
    }
  }
}
