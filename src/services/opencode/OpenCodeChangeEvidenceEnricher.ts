import { createHash } from 'node:crypto'

import { normalizeOpenCodeFilePath } from './OpenCodeBridgePath.js'
import {
  isCapturedSnapshotBoundary,
  OPENCODE_SNAPSHOT_PROVIDER_UNAVAILABLE_DIAGNOSTIC,
  type OpenCodeEvidenceProof,
  type OpenCodeEvidencePipelineMode,
  type OpenCodeSnapshotBoundary,
  type OpenCodeSnapshotEvidenceProvider,
  type OpenCodeSnapshotEvidenceResult,
} from './OpenCodeChangeEvidence.js'

import type { ReconstructedOpenCodeToolChange } from './OpenCodeToolpartChangeReconstructor.js'
import type { OpenCodeSessionRecord } from './types.js'

type EnrichmentParams = {
  workspaceRoot: string
  sessionRecord: OpenCodeSessionRecord
  changes: ReconstructedOpenCodeToolChange[]
  evidenceMode: OpenCodeEvidencePipelineMode
  snapshotBoundary?: OpenCodeSnapshotBoundary | null
  snapshotProvider?: OpenCodeSnapshotEvidenceProvider
  evidenceMetadata?: {
    snapshotShapeFingerprint?: string
  }
  diagnostics: string[]
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0
  }
  let count = 0
  let index = 0
  while (true) {
    const found = haystack.indexOf(needle, index)
    if (found < 0) {
      return count
    }
    count += 1
    index = found + needle.length
  }
}

function contentStateForText(content: string): { exists: true; sha256: string; sizeBytes: number } {
  return {
    exists: true,
    sha256: createHash('sha256').update(content).digest('hex'),
    sizeBytes: Buffer.byteLength(content, 'utf8'),
  }
}

function exactOrMetadataProof(change: ReconstructedOpenCodeToolChange): OpenCodeEvidenceProof {
  if (change.operation === 'create' && change.beforeState?.exists === false && change.afterContent !== null) {
    return 'toolpart-chain'
  }
  if (change.operation === 'delete' && change.beforeContent !== null && change.afterState?.exists === false) {
    return 'toolpart-chain'
  }
  if (change.operation === 'modify' && change.beforeContent !== null && change.afterContent !== null) {
    return 'toolpart-chain'
  }
  return 'metadata-only-fallback'
}

function applyProof(
  change: ReconstructedOpenCodeToolChange,
  evidenceProof: OpenCodeEvidenceProof,
  evidenceDiagnostics?: string[],
): ReconstructedOpenCodeToolChange {
  return {
    ...change,
    evidenceProof: change.evidenceProof ?? evidenceProof,
    ...(evidenceDiagnostics?.length
      ? { evidenceDiagnostics: [...(change.evidenceDiagnostics ?? []), ...evidenceDiagnostics] }
      : {}),
  }
}

function buildRelativePathKey(workspaceRoot: string, filePath: string): string | null {
  const normalized = normalizeOpenCodeFilePath({ projectPath: workspaceRoot, filePath })
  if ('skipped' in normalized) {
    return null
  }
  return normalized.relativePath
}

function reverseEditFromAfter(input: {
  after: string
  oldString: string | undefined
  newString: string | undefined
}): { before: string } | null {
  if (
    typeof input.oldString !== 'string' ||
    typeof input.newString !== 'string' ||
    input.oldString === input.newString ||
    countOccurrences(input.after, input.newString) !== 1
  ) {
    return null
  }
  const before = input.after.replace(input.newString, input.oldString)
  if (countOccurrences(before, input.oldString) !== 1) {
    return null
  }
  if (before.replace(input.oldString, input.newString) !== input.after) {
    return null
  }
  return { before }
}

function countSnippetOccurrences(haystack: string, needle: string): number {
  return countOccurrences(haystack, needle)
}

function replaceExactlyOnce(input: {
  text: string
  from: string
  to: string
}): string | null {
  if (input.from.length === 0 || countSnippetOccurrences(input.text, input.from) !== 1) {
    return null
  }
  return input.text.replace(input.from, input.to)
}

function reverseApplyPatchUpdateFromAfter(change: ReconstructedOpenCodeToolChange, after: string): string | null {
  if (!change.patchUpdateHunks?.length) {
    return null
  }
  let cursor = after
  for (const hunk of [...change.patchUpdateHunks].reverse()) {
    const before = replaceExactlyOnce({
      text: cursor,
      from: hunk.afterSnippet,
      to: hunk.beforeSnippet,
    })
    if (before === null) {
      return null
    }
    cursor = before
  }
  let verified = cursor
  for (const hunk of change.patchUpdateHunks) {
    const next = replaceExactlyOnce({
      text: verified,
      from: hunk.beforeSnippet,
      to: hunk.afterSnippet,
    })
    if (next === null) {
      return null
    }
    verified = next
  }
  return verified === after ? cursor : null
}

type SnapshotFileAnchor = {
  beforeContent?: string
  afterContent?: string
  operation?: 'create' | 'modify' | 'delete'
  snapshotId?: string
  warnings?: string[]
}

function snapshotFilesByRelativePath(result: OpenCodeSnapshotEvidenceResult | null): Map<string, SnapshotFileAnchor> {
  const files = new Map<string, SnapshotFileAnchor>()
  if (!result?.supported) {
    return files
  }
  for (const file of result.files) {
    if (typeof file.afterContent === 'string' || typeof file.beforeContent === 'string' || file.operation) {
      files.set(file.relativePath, {
        ...(typeof file.beforeContent === 'string' ? { beforeContent: file.beforeContent } : {}),
        ...(typeof file.afterContent === 'string' ? { afterContent: file.afterContent } : {}),
        ...(file.operation ? { operation: file.operation } : {}),
        ...(file.snapshotId ? { snapshotId: file.snapshotId } : {}),
        ...(file.warnings?.length ? { warnings: file.warnings } : {}),
      })
    }
  }
  return files
}

export class OpenCodeChangeEvidenceEnricher {
  async enrich(params: EnrichmentParams): Promise<ReconstructedOpenCodeToolChange[]> {
    if (params.evidenceMode === 'off') {
      return params.changes
    }

    let snapshotResult: OpenCodeSnapshotEvidenceResult | null = null
    if (params.evidenceMode === 'snapshot-auto') {
      if (!params.snapshotProvider) {
        params.diagnostics.push(OPENCODE_SNAPSHOT_PROVIDER_UNAVAILABLE_DIAGNOSTIC)
      } else if (!isCapturedSnapshotBoundary(params.snapshotBoundary)) {
        params.diagnostics.push('OpenCode snapshot evidence skipped because delivery snapshot boundary is unavailable or not terminal.')
      } else {
        snapshotResult = await params.snapshotProvider.readBoundaryEvidence({
          workspaceRoot: params.workspaceRoot,
          sessionId: params.sessionRecord.opencodeSessionId,
          boundary: params.snapshotBoundary,
          touchedRelativePaths: params.changes.map(change => change.relativePath),
        }).catch(error => {
          params.diagnostics.push(`OpenCode snapshot evidence read failed - ${error instanceof Error ? error.message : String(error)}`)
          return null
        })
        if (snapshotResult && !snapshotResult.supported) {
          params.diagnostics.push(...snapshotResult.diagnostics)
        } else if (snapshotResult?.diagnostics?.length) {
          params.diagnostics.push(...snapshotResult.diagnostics)
        }
        if (snapshotResult?.supported) {
          params.evidenceMetadata ??= {}
          params.evidenceMetadata.snapshotShapeFingerprint = snapshotResult.shapeFingerprint
        }
      }
    } else if (params.evidenceMode === 'snapshot-probe') {
      params.diagnostics.push('OpenCode snapshot evidence is probe-only; normal backfill uses chain/metadata fallback.')
    }

    const snapshotAfterByPath = snapshotFilesByRelativePath(snapshotResult)
    const result = params.changes.map(change => applyProof(change, exactOrMetadataProof(change)))

    if (snapshotAfterByPath.size === 0) {
      return result
    }

    const byPath = new Map<string, ReconstructedOpenCodeToolChange[]>()
    for (const change of result) {
      const relativePath = buildRelativePathKey(params.workspaceRoot, change.filePath)
      if (!relativePath) {
        continue
      }
      const bucket = byPath.get(relativePath) ?? []
      bucket.push(change)
      byPath.set(relativePath, bucket)
    }

    const replacements = new Map<string, ReconstructedOpenCodeToolChange>()
    for (const [relativePath, changes] of byPath) {
      const snapshotAnchor = snapshotAfterByPath.get(relativePath)
      let anchorAfter = snapshotAnchor?.afterContent
      if (typeof anchorAfter !== 'string') {
        const latestChange = changes[changes.length - 1]
        if (
          latestChange?.sourceTool === 'apply_patch' &&
          latestChange.operation === 'delete' &&
          typeof snapshotAnchor?.beforeContent === 'string' &&
          snapshotAnchor.operation === 'delete'
        ) {
          replacements.set(latestChange.sourceImportKey, {
            ...latestChange,
            beforeContent: snapshotAnchor.beforeContent,
            afterContent: null,
            beforeState: contentStateForText(snapshotAnchor.beforeContent),
            afterState: { exists: false, sizeBytes: 0 },
            confidence: 'high',
            evidenceProof: 'opencode-snapshot',
            snapshotId: snapshotAnchor.snapshotId,
            snapshotSource: snapshotAnchor.snapshotId ? 'opencode' : undefined,
            warnings: [
              ...(latestChange.warnings ?? []).filter(warning => !warning.includes('manual-only')),
              ...(snapshotAnchor.warnings ?? []),
            ],
          })
        }
        continue
      }
      for (let index = changes.length - 1; index >= 0; index -= 1) {
        const change = changes[index]
        if (!change) {
          continue
        }
        if (change.beforeContent !== null && change.afterContent !== null) {
          if (change.afterContent !== anchorAfter) {
            break
          }
          anchorAfter = change.beforeContent
          continue
        }
        if (change.sourceTool === 'apply_patch' && change.operation === 'modify') {
          const before = reverseApplyPatchUpdateFromAfter(change, anchorAfter)
          if (!before) {
            break
          }
          const upgraded: ReconstructedOpenCodeToolChange = {
            ...change,
            beforeContent: before,
            afterContent: anchorAfter,
            beforeState: contentStateForText(before),
            afterState: contentStateForText(anchorAfter),
            confidence: 'high',
            evidenceProof: 'inverse-apply-patch-chain',
            snapshotId: snapshotAnchor.snapshotId,
            snapshotSource: snapshotAnchor.snapshotId ? 'opencode' : undefined,
            warnings: [
              ...(change.warnings ?? []).filter(warning => !warning.includes('manual-only')),
              ...(snapshotAnchor.warnings ?? []),
            ],
          }
          replacements.set(change.sourceImportKey, upgraded)
          anchorAfter = before
          continue
        }
        if (change.sourceTool !== 'edit' || change.beforeContent !== null || change.afterContent !== null) {
          break
        }
        const reversed = reverseEditFromAfter({
          after: anchorAfter,
          oldString: change.oldString,
          newString: change.newString,
        })
        if (!reversed) {
          break
        }
        const upgraded: ReconstructedOpenCodeToolChange = {
          ...change,
          beforeContent: reversed.before,
          afterContent: anchorAfter,
          beforeState: contentStateForText(reversed.before),
          afterState: contentStateForText(anchorAfter),
          confidence: 'high',
          evidenceProof: 'inverse-edit-chain',
          warnings: (change.warnings ?? []).filter(warning => !warning.includes('manual-only')),
        }
        replacements.set(change.sourceImportKey, upgraded)
        anchorAfter = reversed.before
      }
    }

    if (replacements.size === 0) {
      return result
    }
    return result.map(change => replacements.get(change.sourceImportKey) ?? change)
  }
}
