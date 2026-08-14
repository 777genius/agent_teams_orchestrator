import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

import type { ActualOwnerRuntimeManifest } from './contracts.js'
import { assertAnchoredIdentity, readAnchoredFile, type SecureFileIdentity, type TrustedRoot } from './secure-files.js'

export const ACTUAL_OWNER_CONTRACT_PURPOSE = 'agent-teams.hosted-actual-owner-e2e.contract/v1' as const
export const ACTUAL_OWNER_CONTRACT_REPOSITORY_PATH =
  'scripts/e2e/hosted-actual-owner/actual-owner-contract.v1.json' as const
export const ACTUAL_OWNER_CONTRACT_ENTRY = 'scripts/e2e/hosted-actual-owner-owner.ts' as const
export const ACTUAL_OWNER_INHERITED_FDS = Object.freeze({
  launcherLeaseFd: 6, livenessFd: 7, bootstrapFd: 8,
} as const)

type JsonRecord = Record<string, unknown>

export type ActualOwnerProductContract = Readonly<{
  bytes: Buffer
  byteCount: number
  sha256: string
  identity: SecureFileIdentity
  eventFields: readonly string[]
  correlationFields: readonly string[]
  captureArtifactPathFields: readonly string[]
}>

const execFileAsync = promisify(execFile)

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`hosted_actual_owner_contract_${label}_invalid`)
  }
  return value as JsonRecord
}

function exact(value: JsonRecord, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(); const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`hosted_actual_owner_contract_${label}_invalid`)
  }
}

function stringArray(value: unknown, expected: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(value) || value.length !== expected.length ||
    value.some((entry, index) => entry !== expected[index])) {
    throw new Error(`hosted_actual_owner_contract_${label}_invalid`)
  }
  return Object.freeze([...expected])
}

export function parseProductContractBundle(bytes: Buffer): Omit<ActualOwnerProductContract, 'identity'> {
  let input: JsonRecord
  try { input = record(JSON.parse(bytes.toString('utf8')), 'bundle') } catch (error) {
    throw new Error('hosted_actual_owner_contract_bundle_invalid', { cause: error })
  }
  if (!bytes.equals(Buffer.from(`${JSON.stringify(input)}\n`, 'utf8'))) {
    throw new Error('hosted_actual_owner_contract_bundle_not_canonical')
  }
  exact(input, ['schemaVersion', 'purpose', 'authority', 'orchestratorEntry', 'descriptorTokens',
    'inheritedFds', 'runtimeManifest', 'timeline', 'correlationFields'], 'bundle')
  const tokens = record(input.descriptorTokens, 'descriptor_tokens')
  const fds = record(input.inheritedFds, 'inherited_fds')
  const manifest = record(input.runtimeManifest, 'runtime_manifest')
  const timeline = record(input.timeline, 'timeline')
  exact(tokens, ['sandboxRoot', 'productRoot', 'orchestratorRoot', 'openCodeExecutable'], 'descriptor_tokens')
  exact(fds, ['launcherLeaseFd', 'livenessFd', 'bootstrapFd'], 'inherited_fds')
  exact(manifest, ['ownerBindingFields', 'socketIdentityFields', 'httpCapabilityEndpointField',
    'ownerWalTimelineRawPathField', 'captureArtifactPathFields'], 'runtime_manifest')
  exact(timeline, ['mediaType', 'encoding', 'lineTerminator', 'timestamp', 'digest', 'byteCount',
    'fileIdentityFields', 'eventFields', 'approvalIdDiscriminant', 'nullableCorrelationFields'], 'timeline')
  const eventFields = stringArray(timeline.eventFields, ['schemaVersion', 'at', 'routeId', 'sessionId',
    'runId', 'generation', 'approvalId', 'requestId', 'effectId', 'event', 'sequence'], 'event_fields')
  const correlationFields = stringArray(input.correlationFields,
    ['routeId', 'sessionId', 'runId', 'generation', 'approvalId', 'requestId', 'effectId'], 'correlation_fields')
  const captureArtifactPathFields = stringArray(manifest.captureArtifactPathFields,
    ['browserResultsPath', 'conditionalPostLedgerPath', 'negativeResultsPath', 'openCodeTimelinePath',
      'ownerWalTimelinePath', 'productTimelinePath', 'protectedEffectLedgerPath'], 'capture_fields')
  if (input.schemaVersion !== 1 || input.purpose !== ACTUAL_OWNER_CONTRACT_PURPOSE ||
    input.authority !== 'product' || input.orchestratorEntry !== ACTUAL_OWNER_CONTRACT_ENTRY ||
    JSON.stringify(tokens) !== JSON.stringify({ sandboxRoot: '${SANDBOX_ROOT}', productRoot: '${PRODUCT_ROOT}',
      orchestratorRoot: '${ORCHESTRATOR_ROOT}', openCodeExecutable: '${OPENCODE_EXECUTABLE}' }) ||
    JSON.stringify(fds) !== JSON.stringify(ACTUAL_OWNER_INHERITED_FDS) ||
    stringArray(manifest.ownerBindingFields, ['ownerUid', 'ownerSessionId', 'ownerTokenSha256'],
      'owner_binding_fields').length !== 3 ||
    stringArray(manifest.socketIdentityFields, ['driverSocket', 'productSocket'],
      'socket_identity_fields').length !== 2 ||
    manifest.httpCapabilityEndpointField !== 'capabilityEndpoint' ||
    manifest.ownerWalTimelineRawPathField !== 'ownerWalTimelineRawPath' ||
    timeline.mediaType !== 'application/x-ndjson' || timeline.encoding !== 'utf-8' ||
    timeline.lineTerminator !== '\n' ||
    timeline.timestamp !== 'canonical UTC ISO-8601 with exactly milliseconds' ||
    timeline.digest !== 'sha256 of exact raw bytes' || timeline.byteCount !== 'exact raw byte count') {
    throw new Error('hosted_actual_owner_contract_bundle_semantics_invalid')
  }
  stringArray(timeline.fileIdentityFields, ['device', 'inode', 'size', 'mtimeNs', 'ctimeNs'],
    'file_identity_fields')
  stringArray(timeline.nullableCorrelationFields, ['approvalId', 'requestId', 'effectId'],
    'nullable_correlation_fields')
  if (timeline.approvalIdDiscriminant !==
    'approval events require approvalId; maintenance events require null') {
    throw new Error('hosted_actual_owner_contract_bundle_semantics_invalid')
  }
  return Object.freeze({
    bytes, byteCount: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'),
    eventFields, correlationFields, captureArtifactPathFields,
  })
}

export async function loadProductContract(input: {
  args: readonly string[]
  runtime: ActualOwnerRuntimeManifest
  productRoot: string
  anchor: TrustedRoot
}): Promise<ActualOwnerProductContract> {
  if (input.args.length !== 6 || input.args[0] !== '--actual-owner-contract' ||
    input.args[2] !== '--actual-owner-contract-sha256' ||
    input.args[4] !== '--actual-owner-contract-byte-count') {
    throw new Error('hosted_actual_owner_contract_arguments_invalid')
  }
  const declared = input.runtime.contract
  const byteCount = Number(input.args[5])
  if (input.args[1] !== declared.path || input.args[3] !== declared.sha256 ||
    !Number.isSafeInteger(byteCount) || byteCount !== declared.byteCount ||
    declared.repositoryPath !== ACTUAL_OWNER_CONTRACT_REPOSITORY_PATH ||
    declared.sourceCommit !== input.runtime.refs.product) {
    throw new Error('hosted_actual_owner_contract_cli_binding_invalid')
  }
  const file = await readAnchoredFile(declared.path, input.anchor, {
    minimumBytes: 2, maximumBytes: 1024 * 1024, mode: Number(declared.mode),
  })
  if (file.identity.device !== declared.device || file.identity.inode !== declared.inode ||
    file.identity.size !== String(declared.byteCount) || file.identity.mode !== declared.mode ||
    file.identity.nlink !== '1') throw new Error('hosted_actual_owner_contract_identity_mismatch')
  const parsed = parseProductContractBundle(file.bytes)
  if (parsed.sha256 !== declared.sha256 || parsed.byteCount !== declared.byteCount) {
    throw new Error('hosted_actual_owner_contract_digest_mismatch')
  }
  const blob = await execFileAsync('/usr/bin/git', ['-C', input.productRoot, 'show',
    `${input.runtime.refs.product}:${declared.repositoryPath}`], {
    encoding: null, maxBuffer: 1024 * 1024,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
  })
  if (!Buffer.from(blob.stdout).equals(file.bytes)) {
    throw new Error('hosted_actual_owner_contract_git_blob_mismatch')
  }
  return Object.freeze({ ...parsed, identity: file.identity })
}

export async function assertProductContractCurrent(input: {
  contract: ActualOwnerProductContract
  runtime: ActualOwnerRuntimeManifest
  anchor: TrustedRoot
}): Promise<void> {
  const bytes = await assertAnchoredIdentity(input.runtime.contract.path, input.anchor,
    input.contract.identity, { minimumBytes: 2, maximumBytes: 1024 * 1024,
      mode: Number(input.runtime.contract.mode) })
  const parsed = parseProductContractBundle(bytes)
  if (parsed.sha256 !== input.contract.sha256 || parsed.byteCount !== input.contract.byteCount) {
    throw new Error('hosted_actual_owner_contract_rotated')
  }
}
