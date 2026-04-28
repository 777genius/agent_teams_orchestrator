import type { OpenCodeOfflineSessionReadResult } from './OpenCodeOfflineSessionReader.js'
import type { ReconstructedOpenCodeToolChange } from './OpenCodeToolpartChangeReconstructor.js'
import type { OpenCodeSessionRecord } from './types.js'

export type OpenCodeEvidenceProof =
  | 'toolpart-chain'
  | 'opencode-snapshot'
  | 'inverse-edit-chain'
  | 'inverse-apply-patch-chain'
  | 'metadata-only-fallback'

export type OpenCodeEvidencePipelineMode =
  | 'off'
  | 'metadata-only'
  | 'chain-only'
  | 'snapshot-probe'
  | 'snapshot-auto'

export type OpenCodeSnapshotCaptureStatus =
  | 'captured'
  | 'pending'
  | 'snapshot-disabled'
  | 'unsupported-shape'
  | 'capture-failed'
  | 'not-terminal'
  | 'not-configured'

export type OpenCodeSnapshotBoundary = {
  schemaVersion: 1
  captureStatus: OpenCodeSnapshotCaptureStatus
  preDeliverySnapshotHash?: string
  postDeliverySnapshotHash?: string
  snapshotAdapterVersion?: number
  opencodeVersion?: string
  diagnostics?: string[]
}

export type OpenCodeSnapshotEvidenceFile = {
  relativePath: string
  afterContent?: string
  beforeContent?: string
  operation?: 'create' | 'modify' | 'delete'
  beforeState?: {
    exists: boolean
    sha256?: string
    sizeBytes?: number
    unavailableReason?: string
  }
  afterState?: {
    exists: boolean
    sha256?: string
    sizeBytes?: number
    unavailableReason?: string
  }
  snapshotId?: string
  warnings?: string[]
}

export type OpenCodeSnapshotProbeResult =
  | {
      supported: true
      shapeFingerprint: string
      opencodeVersion?: string
      adapterVersion: number
      diagnostics?: string[]
    }
  | {
      supported: false
      code: 'unsupported-opencode-snapshot-shape' | 'snapshot-provider-unavailable'
      diagnostics: string[]
    }

export type OpenCodeSnapshotEvidenceResult =
  | {
      supported: true
      shapeFingerprint: string
      opencodeVersion?: string
      adapterVersion: number
      files: OpenCodeSnapshotEvidenceFile[]
      diagnostics?: string[]
    }
  | {
      supported: false
      code: 'unsupported-opencode-snapshot-shape' | 'snapshot-boundary-unavailable' | 'snapshot-provider-unavailable'
      diagnostics: string[]
    }

export type SnapshotProbeInput = {
  workspaceRoot: string
  profileRootKey?: string
  opencodeVersion?: string
}

export type SnapshotBoundaryReadInput = {
  workspaceRoot: string
  sessionId: string
  boundary: OpenCodeSnapshotBoundary
  touchedRelativePaths: string[]
}

export type SnapshotSessionEvidenceInput = {
  workspaceRoot: string
  sessionRecord: OpenCodeSessionRecord
  offline: OpenCodeOfflineSessionReadResult
  changes: ReconstructedOpenCodeToolChange[]
  touchedRelativePaths: string[]
}

export interface OpenCodeSnapshotEvidenceProvider {
  readonly adapterVersion: number
  probe(input: SnapshotProbeInput): Promise<OpenCodeSnapshotProbeResult>
  readSessionEvidence(input: SnapshotSessionEvidenceInput): Promise<OpenCodeSnapshotEvidenceResult>
}

export const DEFAULT_OPENCODE_EVIDENCE_PIPELINE_MODE: OpenCodeEvidencePipelineMode = 'snapshot-auto'

export const OPENCODE_SNAPSHOT_PROVIDER_UNAVAILABLE_DIAGNOSTIC =
  'snapshot-provider-unavailable: OpenCode snapshot evidence provider is unavailable; using chain/metadata fallback.'

export function normalizeOpenCodeEvidencePipelineMode(value: unknown): OpenCodeEvidencePipelineMode {
  return value === 'off' ||
    value === 'metadata-only' ||
    value === 'chain-only' ||
    value === 'snapshot-probe' ||
    value === 'snapshot-auto'
    ? value
    : DEFAULT_OPENCODE_EVIDENCE_PIPELINE_MODE
}

export function isCapturedSnapshotBoundary(
  boundary: OpenCodeSnapshotBoundary | null | undefined,
): boundary is OpenCodeSnapshotBoundary & {
  captureStatus: 'captured'
  preDeliverySnapshotHash: string
  postDeliverySnapshotHash: string
} {
  return (
    boundary?.captureStatus === 'captured' &&
    typeof boundary.preDeliverySnapshotHash === 'string' &&
    boundary.preDeliverySnapshotHash.length > 0 &&
    typeof boundary.postDeliverySnapshotHash === 'string' &&
    boundary.postDeliverySnapshotHash.length > 0
  )
}
