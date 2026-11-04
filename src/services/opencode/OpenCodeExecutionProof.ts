import { createHash } from 'node:crypto'
import path from 'node:path'

import { readOpenCodeAuthCredential } from './OpenCodeAuthStore.js'
import { resolveOpenCodeBinaryPath } from './OpenCodeBinaryResolver.js'
import { resolveOpenCodeBinaryHostIdentity } from './OpenCodeHostManager.js'
import { normalizeOpenCodeProjectIdentity } from './OpenCodeProjectIdentity.js'
import {
  buildOpenCodeExpectedBehaviorEvidence,
  validateOpenCodeExpectedBehaviorEvidence,
} from './OpenCodeExpectedBehaviorFingerprint.js'

import type {
  OpenCodeExecutionProof,
  OpenCodeExecutionProofCredentialMode,
  OpenCodeProvisioningSnapshot,
} from './types.js'

export const OPEN_CODE_EXECUTION_PROOF_TTL_MS = 120_000
// An owned V2 team probe must cover the 300s launch budget and a 30s handoff.
export const OPEN_CODE_V2_TEAM_EXECUTION_PROOF_TTL_MS = 330_000

type OpenCodeExecutionProofDeps = {
  nowMs?: () => number
  platform?: NodeJS.Platform
  readCredential?: typeof readOpenCodeAuthCredential
  resolveBinaryPath?: () => string | null
  resolveBinaryIdentity?: (binaryPath: string) => Promise<string>
}

type BuildOpenCodeExecutionProofInput = {
  selectedModel: string
  snapshot: OpenCodeProvisioningSnapshot
  capabilitySnapshotId: string | null
  verifiedAt?: string
  /** Set only by the owned V2 team-probe producer, never a public proof DTO. */
  unattendedTeam?: boolean
}

type ValidateOpenCodeExecutionProofInput = {
  proof: OpenCodeExecutionProof
  selectedModel: string
  projectPath: string
  snapshot: OpenCodeProvisioningSnapshot
  capabilitySnapshotId: string | null
}

export type OpenCodeExecutionProofValidation = {
  valid: boolean
  reason: string | null
}

export function parseOpenCodeExecutionProof(value: unknown): OpenCodeExecutionProof | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const proof = value as Partial<OpenCodeExecutionProof>
  if (
    proof.schemaVersion !== 1
    || proof.providerId !== 'opencode'
    || typeof proof.modelId !== 'string'
    || typeof proof.projectPath !== 'string'
    || typeof proof.profileRootKey !== 'string'
    || typeof proof.projectBehaviorFingerprint !== 'string'
    || typeof proof.managedConfigFingerprint !== 'string'
    || !(proof.managedAuthFingerprint === null || typeof proof.managedAuthFingerprint === 'string')
    || typeof proof.binaryPath !== 'string'
    || typeof proof.binaryFingerprint !== 'string'
    || !(proof.opencodeVersion === null || typeof proof.opencodeVersion === 'string')
    || !(proof.capabilitySnapshotId === null || typeof proof.capabilitySnapshotId === 'string')
    || !['api', 'oauth', 'none', 'unknown'].includes(proof.credentialMode ?? '')
    || typeof proof.reusable !== 'boolean'
    || typeof proof.verifiedAt !== 'string'
    || typeof proof.expiresAt !== 'string'
    || !proof.expectedBehaviorEvidence
    || typeof proof.expectedBehaviorEvidence !== 'object'
    || Object.keys(proof.expectedBehaviorEvidence).length !== 7
    || !validateOpenCodeExpectedBehaviorEvidence(proof.expectedBehaviorEvidence)
    || typeof proof.proofHash !== 'string'
  ) {
    return null
  }
  return proof as OpenCodeExecutionProof
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function hashProof(value: Omit<OpenCodeExecutionProof, 'proofHash'>): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function parseProviderId(selectedModel: string): string | null {
  const separator = selectedModel.indexOf('/')
  return separator > 0 ? selectedModel.slice(0, separator) : null
}

function credentialMode(value: Record<string, unknown> | null): OpenCodeExecutionProofCredentialMode {
  if (!value) return 'none'
  if (value.type === 'oauth') return 'oauth'
  if (value.type === 'api') return 'api'
  return 'unknown'
}

function invalid(reason: string): OpenCodeExecutionProofValidation {
  return { valid: false, reason }
}

async function resolveRuntimeIdentity(deps: OpenCodeExecutionProofDeps): Promise<{
  binaryPath: string
  binaryFingerprint: string
}> {
  const binaryPath = (deps.resolveBinaryPath ?? resolveOpenCodeBinaryPath)()
  if (!binaryPath) {
    throw new Error('OpenCode binary identity is unavailable')
  }
  const normalizedPath = path.resolve(binaryPath)
  const binaryFingerprint = await (deps.resolveBinaryIdentity ?? resolveOpenCodeBinaryHostIdentity)(
    normalizedPath,
  )
  return { binaryPath: normalizedPath, binaryFingerprint }
}

export async function buildOpenCodeExecutionProof(
  input: BuildOpenCodeExecutionProofInput,
  deps: OpenCodeExecutionProofDeps = {},
): Promise<OpenCodeExecutionProof> {
  const profile = input.snapshot.profile
  if (!profile || !input.snapshot.hostHealthy) {
    throw new Error('OpenCode execution proof requires a healthy prepared profile')
  }
  const providerId = parseProviderId(input.selectedModel)
  if (!providerId) {
    throw new Error('OpenCode execution proof requires a provider-scoped model')
  }

  const [runtimeIdentity, credential] = await Promise.all([
    resolveRuntimeIdentity(deps),
    (deps.readCredential ?? readOpenCodeAuthCredential)({
      authPath: profile.managedAuthPath,
      providerId,
    }),
  ])
  const mode = credentialMode(credential)
  const now = deps.nowMs?.() ?? Date.now()
  const verifiedAtMs = input.verifiedAt
    ? Date.parse(input.verifiedAt)
    : now
  const issuedAtMs = Number.isFinite(verifiedAtMs) ? verifiedAtMs : now
  const unsigned: Omit<OpenCodeExecutionProof, 'proofHash'> = {
    schemaVersion: 1,
    providerId: 'opencode',
    modelId: input.selectedModel,
    projectPath: normalizeOpenCodeProjectIdentity(input.snapshot.projectPath, deps.platform),
    profileRootKey: profile.profileRootKey,
    projectBehaviorFingerprint: profile.projectBehaviorFingerprint,
    managedConfigFingerprint: profile.managedConfigFingerprint,
    managedAuthFingerprint: profile.managedAuthFingerprint,
    binaryPath: runtimeIdentity.binaryPath,
    binaryFingerprint: runtimeIdentity.binaryFingerprint,
    opencodeVersion: input.snapshot.host?.version ?? null,
    capabilitySnapshotId: input.capabilitySnapshotId,
    credentialMode: mode,
    reusable:
      (mode === 'api' || mode === 'none')
      && typeof input.snapshot.host?.version === 'string'
      && input.snapshot.host.version.trim().length > 0,
    expectedBehaviorEvidence: await buildOpenCodeExpectedBehaviorEvidence({
      profile,
      fullModelId: input.selectedModel,
      effectiveConfigFingerprint: input.snapshot.host?.resolvedConfigFingerprint ?? null,
      platform: deps.platform,
      readCredential: async () => credential,
    }),
    verifiedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(issuedAtMs + (input.unattendedTeam === true
      ? OPEN_CODE_V2_TEAM_EXECUTION_PROOF_TTL_MS : OPEN_CODE_EXECUTION_PROOF_TTL_MS)).toISOString(),
  }
  return { ...unsigned, proofHash: hashProof(unsigned) }
}

export async function validateOpenCodeExecutionProof(
  input: ValidateOpenCodeExecutionProofInput,
  deps: OpenCodeExecutionProofDeps = {},
): Promise<OpenCodeExecutionProofValidation> {
  const proof = input.proof
  if (proof.schemaVersion !== 1 || proof.providerId !== 'opencode') {
    return invalid('unsupported execution proof schema')
  }
  const { proofHash, ...unsigned } = proof
  if (proofHash !== hashProof(unsigned)
    || !validateOpenCodeExpectedBehaviorEvidence(proof.expectedBehaviorEvidence)) {
    return invalid('execution proof integrity mismatch')
  }
  if (!proof.reusable || proof.credentialMode === 'oauth' || proof.credentialMode === 'unknown') {
    return invalid(`execution proof is not reusable for ${proof.credentialMode} credentials`)
  }
  const now = deps.nowMs?.() ?? Date.now()
  const expiresAt = Date.parse(proof.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return invalid('execution proof expired')
  }
  if (proof.modelId !== input.selectedModel) {
    return invalid('execution proof model changed')
  }
  if (proof.projectPath !== normalizeOpenCodeProjectIdentity(input.projectPath, deps.platform)) {
    return invalid('execution proof project changed')
  }
  const profile = input.snapshot.profile
  if (!profile || !input.snapshot.hostHealthy) {
    return invalid('OpenCode runtime is not currently healthy')
  }
  if (
    proof.profileRootKey !== profile.profileRootKey
    || proof.projectBehaviorFingerprint !== profile.projectBehaviorFingerprint
    || proof.managedConfigFingerprint !== profile.managedConfigFingerprint
    || proof.managedAuthFingerprint !== profile.managedAuthFingerprint
  ) {
    return invalid('execution proof profile or authentication changed')
  }
  const currentEvidence = await buildOpenCodeExpectedBehaviorEvidence({
    profile,
    fullModelId: input.selectedModel,
    effectiveConfigFingerprint: input.snapshot.host?.resolvedConfigFingerprint ?? null,
    platform: deps.platform,
    readCredential: deps.readCredential,
  }).catch(() => null)
  if (!currentEvidence
    || currentEvidence.expectedBehaviorFingerprint
      !== proof.expectedBehaviorEvidence.expectedBehaviorFingerprint) {
    return invalid('execution proof expected behavior changed')
  }
  if (
    !proof.opencodeVersion
    || proof.opencodeVersion !== (input.snapshot.host?.version ?? null)
    || proof.capabilitySnapshotId !== input.capabilitySnapshotId
  ) {
    return invalid('execution proof runtime capability changed')
  }
  const runtimeIdentity = await resolveRuntimeIdentity(deps).catch(() => null)
  if (
    !runtimeIdentity
    || runtimeIdentity.binaryPath !== proof.binaryPath
    || runtimeIdentity.binaryFingerprint !== proof.binaryFingerprint
  ) {
    return invalid('execution proof binary changed')
  }
  return { valid: true, reason: null }
}
