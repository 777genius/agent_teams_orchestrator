import { createHash } from 'node:crypto'

import { normalizeOpenCodeFilePath } from './OpenCodeBridgePath.js'
import {
  DEFAULT_OPENCODE_SNAPSHOT_PROOF_UPGRADE_MODE,
  OPENCODE_SNAPSHOT_PROVIDER_UNAVAILABLE_DIAGNOSTIC,
  type OpenCodeEvidenceProof,
  type OpenCodeSnapshotProofUpgradeMode,
  type OpenCodeSnapshotEvidenceProvider,
  type OpenCodeSnapshotEvidenceResult,
} from './OpenCodeChangeEvidence.js'

import type { OpenCodeOfflineSessionReadResult } from './OpenCodeOfflineSessionReader.js'
import type { ReconstructedOpenCodeToolChange } from './OpenCodeToolpartChangeReconstructor.js'
import type { OpenCodeSessionRecord } from './types.js'

type EnrichmentParams = {
  workspaceRoot: string
  sessionRecord: OpenCodeSessionRecord
  changes: ReconstructedOpenCodeToolChange[]
  offline?: OpenCodeOfflineSessionReadResult | null
  snapshotProvider?: OpenCodeSnapshotEvidenceProvider
  evidenceMetadata?: {
    snapshotShapeFingerprint?: string
  }
  snapshotProofMode?: OpenCodeSnapshotProofUpgradeMode
  diagnostics: string[]
}

type SnapshotUpgradeDiagnosticCode =
  | 'snapshot-upgrade-skipped/feature-flag-off'
  | 'snapshot-upgrade-skipped/no-file-anchor'
  | 'snapshot-upgrade-skipped/postcondition-failed'
  | 'snapshot-upgrade-skipped/single-change-only'
  | 'snapshot-upgrade-skipped/path-chain-boundary-mismatch'
  | 'snapshot-upgrade-skipped/duplicate-file-anchor'

type SnapshotProofStats = {
  attemptedChanges: number
  wouldUpgradeChanges: number
  appliedUpgrades: number
  skippedChanges: number
  skippedByReason: Map<string, number>
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

function normalizeRelativePathKey(value: string): string | null {
  if (!value || value.includes('\0')) {
    return null
  }
  const normalized = value.replace(/\\/g, '/')
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes('//') ||
    normalized.endsWith('/')
  ) {
    return null
  }
  const segments = normalized.split('/')
  return segments.some(segment => segment === '' || segment === '.' || segment === '..')
    ? null
    : normalized
}

function changeRelativePathKey(workspaceRoot: string, change: ReconstructedOpenCodeToolChange): string | null {
  return normalizeRelativePathKey(change.relativePath) ??
    buildRelativePathKey(workspaceRoot, change.filePath)
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

function pushSnapshotDiagnostic(
  diagnostics: string[],
  code: SnapshotUpgradeDiagnosticCode,
  detail: string,
): void {
  diagnostics.push(`${code}: ${detail}`)
}

function incrementSkipped(stats: SnapshotProofStats, reason: SnapshotUpgradeDiagnosticCode, count = 1): void {
  stats.skippedChanges += count
  stats.skippedByReason.set(reason, (stats.skippedByReason.get(reason) ?? 0) + count)
}

function createSnapshotProofStats(changes: ReconstructedOpenCodeToolChange[]): SnapshotProofStats {
  return {
    attemptedChanges: changes.length,
    wouldUpgradeChanges: 0,
    appliedUpgrades: 0,
    skippedChanges: 0,
    skippedByReason: new Map(),
  }
}

function pushShadowStats(diagnostics: string[], stats: SnapshotProofStats): void {
  const skippedByReason = [...stats.skippedByReason.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(',')
  diagnostics.push([
    'snapshot-proof-shadow:',
    `attempted=${stats.attemptedChanges}`,
    `wouldUpgrade=${stats.wouldUpgradeChanges}`,
    `applied=0`,
    `skipped=${stats.skippedChanges}`,
    skippedByReason ? `skippedByReason=${skippedByReason}` : undefined,
  ].filter(Boolean).join(' '))
}

function isResolvedByFullTextProof(warning: string): boolean {
  return (
    warning === 'OpenCode edit was captured without a proven full-text baseline; apply/reject is manual-only.' ||
    warning === 'OpenCode write overwrote an existing file before the bridge had a known baseline; reject is manual-only.' ||
    warning === 'OpenCode apply_patch was captured without full before/after text; review is manual-only.' ||
    warning === 'OpenCode toolpart content was unavailable or too large; review is manual-only.' ||
    warning === 'OpenCode snapshot patch was captured without a matching file toolpart; full review depends on snapshot evidence.'
  )
}

function stripResolvedWarnings(
  existing: string[] | undefined,
  snapshotWarnings: string[] | undefined,
): string[] {
  return [
    ...(existing ?? []).filter(warning => !isResolvedByFullTextProof(warning)),
    ...(snapshotWarnings ?? []),
  ].filter(Boolean)
}

function isProvenCreate(change: ReconstructedOpenCodeToolChange): boolean {
  return change.operation === 'create' &&
    change.beforeState?.exists === false &&
    change.afterContent !== null &&
    !change.afterState?.unavailableReason
}

function isProvenModify(change: ReconstructedOpenCodeToolChange): boolean {
  return change.operation === 'modify' &&
    change.beforeContent !== null &&
    change.afterContent !== null &&
    !change.beforeState?.unavailableReason &&
    !change.afterState?.unavailableReason
}

function isProvenDelete(change: ReconstructedOpenCodeToolChange): boolean {
  return change.operation === 'delete' &&
    change.beforeContent !== null &&
    change.afterState?.exists === false &&
    !change.beforeState?.unavailableReason
}

function isSnapshotReviewSafe(change: ReconstructedOpenCodeToolChange): boolean {
  return change.evidenceProof !== undefined &&
    change.evidenceProof !== 'metadata-only-fallback' &&
    (isProvenCreate(change) || isProvenModify(change) || isProvenDelete(change))
}

function contentStateMatches(content: string, state: ReconstructedOpenCodeToolChange['beforeState'] | ReconstructedOpenCodeToolChange['afterState']): boolean {
  const expected = contentStateForText(content)
  return state?.sha256 === expected.sha256 && state?.sizeBytes === expected.sizeBytes
}

function assertUpgradePostconditions(input: {
  original: ReconstructedOpenCodeToolChange
  upgraded: ReconstructedOpenCodeToolChange
}): boolean {
  const { original, upgraded } = input
  if (
    original.sourceImportKey !== upgraded.sourceImportKey ||
    original.taskId !== upgraded.taskId ||
    original.teamName !== upgraded.teamName ||
    original.memberName !== upgraded.memberName ||
    original.sessionId !== upgraded.sessionId ||
    original.sourcePartId !== upgraded.sourcePartId ||
    original.sourceMessageId !== upgraded.sourceMessageId ||
    original.relativePath !== upgraded.relativePath ||
    !isSnapshotReviewSafe(upgraded)
  ) {
    return false
  }
  if (upgraded.beforeContent !== null && !contentStateMatches(upgraded.beforeContent, upgraded.beforeState)) {
    return false
  }
  if (upgraded.afterContent !== null && !contentStateMatches(upgraded.afterContent, upgraded.afterState)) {
    return false
  }
  return true
}

function needsSnapshotProof(change: ReconstructedOpenCodeToolChange): boolean {
  if (change.evidenceProof === 'toolpart-chain') {
    return false
  }
  if (isSnapshotReviewSafe(change)) {
    return false
  }
  return (
    change.sourceTool === 'write' ||
    change.sourceTool === 'edit' ||
    change.sourceTool === 'apply_patch' ||
    change.sourceTool === 'snapshot_patch'
  )
}

function mayApplySnapshotProof(input: {
  mode: OpenCodeSnapshotProofUpgradeMode
  changeCountForPathWindow: number
}): boolean {
  if (input.mode === 'off' || input.mode === 'shadow') {
    return false
  }
  if (input.mode === 'single-change') {
    return input.changeCountForPathWindow === 1
  }
  return input.mode === 'full'
}

function snapshotFilesByRelativePath(
  result: OpenCodeSnapshotEvidenceResult | null,
  diagnostics: string[],
): Map<string, SnapshotFileAnchor> {
  const files = new Map<string, SnapshotFileAnchor>()
  const duplicatePaths = new Set<string>()
  if (!result?.supported) {
    return files
  }
  for (const file of result.files) {
    if (typeof file.afterContent === 'string' || typeof file.beforeContent === 'string' || file.operation) {
      if (duplicatePaths.has(file.relativePath)) {
        continue
      }
      if (files.has(file.relativePath)) {
        files.delete(file.relativePath)
        duplicatePaths.add(file.relativePath)
        pushSnapshotDiagnostic(diagnostics, 'snapshot-upgrade-skipped/duplicate-file-anchor', file.relativePath)
        continue
      }
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

function snapshotPatchReplacement(
  change: ReconstructedOpenCodeToolChange,
  snapshotAnchor: SnapshotFileAnchor | undefined,
): ReconstructedOpenCodeToolChange | null {
  if (change.sourceTool !== 'snapshot_patch' || !snapshotAnchor?.operation) {
    return null
  }
  const operation = snapshotAnchor.operation
  const beforeContent =
    typeof snapshotAnchor.beforeContent === 'string' ? snapshotAnchor.beforeContent : null
  const afterContent =
    typeof snapshotAnchor.afterContent === 'string' ? snapshotAnchor.afterContent : null
  const hasEnoughEvidence =
    operation === 'create'
      ? afterContent !== null
      : operation === 'delete'
        ? beforeContent !== null
        : beforeContent !== null && afterContent !== null
  if (!hasEnoughEvidence) {
    return null
  }

  return {
    ...change,
    operation,
    beforeContent,
    afterContent,
    beforeState:
      beforeContent !== null ? contentStateForText(beforeContent) : { exists: false, sizeBytes: 0 },
    afterState:
      afterContent !== null ? contentStateForText(afterContent) : { exists: false, sizeBytes: 0 },
    confidence: 'high',
    evidenceProof: 'opencode-snapshot',
    snapshotId: snapshotAnchor.snapshotId,
    snapshotSource: snapshotAnchor.snapshotId ? 'opencode' : undefined,
    warnings: stripResolvedWarnings(change.warnings, snapshotAnchor.warnings),
  }
}

function snapshotPatchChainReplacement(input: {
  change: ReconstructedOpenCodeToolChange
  snapshotAnchor: SnapshotFileAnchor
  afterContent: string
}): ReconstructedOpenCodeToolChange | null {
  if (input.change.sourceTool !== 'snapshot_patch') {
    return null
  }
  const beforeContent =
    typeof input.snapshotAnchor.beforeContent === 'string'
      ? input.snapshotAnchor.beforeContent
      : null
  if (beforeContent === null && input.snapshotAnchor.operation !== 'create') {
    return null
  }
  const operation = beforeContent !== null ? 'modify' : 'create'
  return {
    ...input.change,
    operation,
    beforeContent,
    afterContent: input.afterContent,
    beforeState:
      beforeContent !== null ? contentStateForText(beforeContent) : { exists: false, sizeBytes: 0 },
    afterState: contentStateForText(input.afterContent),
    confidence: 'high',
    evidenceProof: 'opencode-snapshot',
    snapshotId: input.snapshotAnchor.snapshotId,
    snapshotSource: input.snapshotAnchor.snapshotId ? 'opencode' : undefined,
    warnings: stripResolvedWarnings(input.change.warnings, input.snapshotAnchor.warnings),
  }
}

function recordReplacement(input: {
  original: ReconstructedOpenCodeToolChange
  replacement: ReconstructedOpenCodeToolChange | null
  replacements: Map<string, ReconstructedOpenCodeToolChange>
  diagnostics: string[]
  stats: SnapshotProofStats
  apply: boolean
}): boolean {
  if (!input.replacement) {
    return false
  }
  input.stats.wouldUpgradeChanges += 1
  if (!assertUpgradePostconditions({ original: input.original, upgraded: input.replacement })) {
    incrementSkipped(input.stats, 'snapshot-upgrade-skipped/postcondition-failed')
    pushSnapshotDiagnostic(
      input.diagnostics,
      'snapshot-upgrade-skipped/postcondition-failed',
      input.original.sourceImportKey,
    )
    return false
  }
  if (input.apply) {
    input.replacements.set(input.replacement.sourceImportKey, input.replacement)
    input.stats.appliedUpgrades += 1
  }
  return true
}

export class OpenCodeChangeEvidenceEnricher {
  async enrich(params: EnrichmentParams): Promise<ReconstructedOpenCodeToolChange[]> {
    const result = params.changes.map(change => applyProof(change, exactOrMetadataProof(change)))
    if (result.length === 0) {
      return result
    }
    const snapshotProofMode = params.snapshotProofMode ?? DEFAULT_OPENCODE_SNAPSHOT_PROOF_UPGRADE_MODE
    if (snapshotProofMode === 'off') {
      params.diagnostics.push('snapshot-upgrade-skipped/feature-flag-off: OpenCode snapshot proof upgrade is disabled.')
      return result
    }
    const proofCandidates = result.filter(needsSnapshotProof)
    if (proofCandidates.length === 0) {
      return result
    }
    const stats = createSnapshotProofStats(proofCandidates)
    let snapshotResult: OpenCodeSnapshotEvidenceResult | null = null
    if (!params.snapshotProvider) {
      params.diagnostics.push(OPENCODE_SNAPSHOT_PROVIDER_UNAVAILABLE_DIAGNOSTIC)
    } else if (!params.offline || params.offline.snapshotWindows.length === 0) {
      params.diagnostics.push('OpenCode snapshot evidence skipped because SQLite snapshot windows are unavailable.')
    } else {
      snapshotResult = await params.snapshotProvider.readSessionEvidence({
        workspaceRoot: params.workspaceRoot,
        sessionRecord: params.sessionRecord,
        offline: params.offline,
        changes: result,
        touchedRelativePaths: [...new Set(proofCandidates
          .map(change => changeRelativePathKey(params.workspaceRoot, change))
          .filter((relativePath): relativePath is string => !!relativePath))],
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

    const snapshotAfterByPath = snapshotFilesByRelativePath(snapshotResult, params.diagnostics)

    if (snapshotAfterByPath.size === 0) {
      if (snapshotProofMode === 'shadow') {
        pushShadowStats(params.diagnostics, stats)
      }
      return result
    }

    const candidateRelativePaths = new Set(proofCandidates
      .map(change => changeRelativePathKey(params.workspaceRoot, change))
      .filter((relativePath): relativePath is string => !!relativePath))
    const candidateCountByPath = new Map<string, number>()
    for (const change of proofCandidates) {
      const relativePath = changeRelativePathKey(params.workspaceRoot, change)
      if (!relativePath) {
        continue
      }
      candidateCountByPath.set(relativePath, (candidateCountByPath.get(relativePath) ?? 0) + 1)
    }
    const byPath = new Map<string, ReconstructedOpenCodeToolChange[]>()
    for (const change of result) {
      const relativePath = changeRelativePathKey(params.workspaceRoot, change)
      if (!relativePath) {
        continue
      }
      if (!candidateRelativePaths.has(relativePath)) {
        continue
      }
      const bucket = byPath.get(relativePath) ?? []
      bucket.push(change)
      byPath.set(relativePath, bucket)
    }

    const replacements = new Map<string, ReconstructedOpenCodeToolChange>()
    for (const [relativePath, changes] of byPath) {
      const snapshotAnchor = snapshotAfterByPath.get(relativePath)
      const pathCandidateCount = candidateCountByPath.get(relativePath) ?? changes.length
      if (!snapshotAnchor) {
        incrementSkipped(stats, 'snapshot-upgrade-skipped/no-file-anchor', pathCandidateCount)
        continue
      }
      const applyForPath = mayApplySnapshotProof({
        mode: snapshotProofMode,
        changeCountForPathWindow: changes.length,
      })
      if (snapshotProofMode === 'single-change' && changes.length !== 1) {
        incrementSkipped(stats, 'snapshot-upgrade-skipped/single-change-only', pathCandidateCount)
        pushSnapshotDiagnostic(params.diagnostics, 'snapshot-upgrade-skipped/single-change-only', relativePath)
        continue
      }
      if (changes.length === 1) {
        const change = changes[0]!
        const replacement = snapshotPatchReplacement(change, snapshotAnchor)
        if (recordReplacement({
          original: change,
          replacement,
          replacements,
          diagnostics: params.diagnostics,
          stats,
          apply: applyForPath,
        })) {
          continue
        }
      }
      let anchorAfter = snapshotAnchor?.afterContent
      if (typeof anchorAfter !== 'string') {
        const latestChange = changes[changes.length - 1]
        if (
          latestChange?.sourceTool === 'apply_patch' &&
          latestChange.operation === 'delete' &&
          typeof snapshotAnchor?.beforeContent === 'string' &&
          snapshotAnchor.operation === 'delete'
        ) {
          recordReplacement({
            original: latestChange,
            replacement: {
              ...latestChange,
              beforeContent: snapshotAnchor.beforeContent,
              afterContent: null,
              beforeState: contentStateForText(snapshotAnchor.beforeContent),
              afterState: { exists: false, sizeBytes: 0 },
              confidence: 'high',
              evidenceProof: 'opencode-snapshot',
              snapshotId: snapshotAnchor.snapshotId,
              snapshotSource: snapshotAnchor.snapshotId ? 'opencode' : undefined,
              warnings: stripResolvedWarnings(latestChange.warnings, snapshotAnchor.warnings),
            },
            replacements,
            diagnostics: params.diagnostics,
            stats,
            apply: applyForPath,
          })
        }
        continue
      }
      const localReplacements = new Map<string, ReconstructedOpenCodeToolChange>()
      if (
        changes.length === 1 &&
        changes[0]?.sourceTool === 'write' &&
        typeof snapshotAnchor.afterContent === 'string' &&
        (
          changes[0].afterContent === null ||
          changes[0].afterContent === snapshotAnchor.afterContent
        )
      ) {
        const change = changes[0]
        const beforeContent = typeof snapshotAnchor.beforeContent === 'string'
          ? snapshotAnchor.beforeContent
          : null
        const replacement =
          snapshotAnchor.operation === 'create'
            ? {
                ...change,
                operation: 'create' as const,
                beforeContent: null,
                afterContent: snapshotAnchor.afterContent,
                beforeState: { exists: false, sizeBytes: 0 },
                afterState: contentStateForText(snapshotAnchor.afterContent),
                confidence: 'high' as const,
                evidenceProof: 'opencode-snapshot' as const,
                snapshotId: snapshotAnchor.snapshotId,
                snapshotSource: snapshotAnchor.snapshotId ? 'opencode' as const : undefined,
                warnings: stripResolvedWarnings(change.warnings, snapshotAnchor.warnings),
              }
            : change.operation === snapshotAnchor.operation && beforeContent !== null
              ? {
                  ...change,
                  beforeContent,
                  afterContent: snapshotAnchor.afterContent,
                  beforeState: contentStateForText(beforeContent),
                  afterState: contentStateForText(snapshotAnchor.afterContent),
                  confidence: 'high' as const,
                  evidenceProof: 'opencode-snapshot' as const,
                  snapshotId: snapshotAnchor.snapshotId,
                  snapshotSource: snapshotAnchor.snapshotId ? 'opencode' as const : undefined,
                  warnings: stripResolvedWarnings(change.warnings, snapshotAnchor.warnings),
                }
              : null
        if (recordReplacement({
          original: change,
          replacement,
          replacements,
          diagnostics: params.diagnostics,
          stats,
          apply: applyForPath,
        })) {
          continue
        }
      }
      let verifiedFullPathChain = true
      for (let index = changes.length - 1; index >= 0; index -= 1) {
        const change = changes[index]
        if (!change) {
          continue
        }
        if (change.beforeContent !== null && change.afterContent !== null) {
          if (change.afterContent !== anchorAfter) {
            verifiedFullPathChain = false
            break
          }
          anchorAfter = change.beforeContent
          continue
        }
        if (change.sourceTool === 'apply_patch' && change.operation === 'modify') {
          const before = reverseApplyPatchUpdateFromAfter(change, anchorAfter)
          if (!before) {
            verifiedFullPathChain = false
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
            warnings: stripResolvedWarnings(change.warnings, snapshotAnchor.warnings),
          }
          localReplacements.set(change.sourceImportKey, upgraded)
          anchorAfter = before
          continue
        }
        const snapshotPatch = snapshotPatchChainReplacement({
          change,
          snapshotAnchor,
          afterContent: anchorAfter,
        })
        if (snapshotPatch) {
          localReplacements.set(change.sourceImportKey, snapshotPatch)
          anchorAfter = snapshotPatch.beforeContent ?? ''
          continue
        }
        if (change.sourceTool !== 'edit' || change.beforeContent !== null || change.afterContent !== null) {
          verifiedFullPathChain = false
          break
        }
        const reversed = reverseEditFromAfter({
          after: anchorAfter,
          oldString: change.oldString,
          newString: change.newString,
        })
        if (!reversed) {
          verifiedFullPathChain = false
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
          snapshotId: snapshotAnchor.snapshotId,
          snapshotSource: snapshotAnchor.snapshotId ? 'opencode' : undefined,
          warnings: stripResolvedWarnings(change.warnings, snapshotAnchor.warnings),
        }
        localReplacements.set(change.sourceImportKey, upgraded)
        anchorAfter = reversed.before
      }
      if (
        verifiedFullPathChain &&
        typeof snapshotAnchor.beforeContent === 'string' &&
        anchorAfter !== snapshotAnchor.beforeContent
      ) {
        verifiedFullPathChain = false
        incrementSkipped(stats, 'snapshot-upgrade-skipped/path-chain-boundary-mismatch', pathCandidateCount)
        pushSnapshotDiagnostic(params.diagnostics, 'snapshot-upgrade-skipped/path-chain-boundary-mismatch', relativePath)
      }
      if (!verifiedFullPathChain) {
        params.diagnostics.push(`snapshot-window-path-ambiguous: ${relativePath} had a same-window toolpart chain that could not be fully verified.`)
        continue
      }
      for (const [sourceImportKey, replacement] of localReplacements) {
        const original = changes.find(change => change.sourceImportKey === sourceImportKey)
        if (!original) {
          continue
        }
        recordReplacement({
          original,
          replacement,
          replacements,
          diagnostics: params.diagnostics,
          stats,
          apply: applyForPath,
        })
      }
    }

    if (snapshotProofMode === 'shadow') {
      pushShadowStats(params.diagnostics, stats)
      return result
    }
    if (replacements.size === 0) {
      return result
    }
    return result.map(change => replacements.get(change.sourceImportKey) ?? change)
  }
}
