export type OpenCodeBridgeCommandPreconditions = {
  handshakeIdentityHash: string
  laneId: string | null
  expectedRunId: string | null
  expectedCapabilitySnapshotId: string | null
  expectedBehaviorFingerprint: string | null
  expectedManifestHighWatermark: number | null
  commandLeaseId: string | null
  idempotencyKey: string
}

export type OpenCodeBridgePreconditionRuntime = {
  capabilitySnapshotId: string | null
  runtimeStoreManifestHighWatermark: number | null
  activeRunId?: string | null
}

export type OpenCodeBridgeCommandEvidence = {
  idempotencyKey?: string
  manifestHighWatermark: number | null
  runtimeStoreManifestHighWatermark: number | null
  capabilitySnapshotRecovery?: {
    expectedCapabilitySnapshotId: string
    actualCapabilitySnapshotId: string | null
    recoveryAttemptId: string
  }
}

export function requireOpenCodeExpectedBehaviorFingerprint(
  preconditions: OpenCodeBridgeCommandPreconditions | null,
): string {
  const value = preconditions?.expectedBehaviorFingerprint
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(
      'OpenCode strict launch expectedBehaviorFingerprint must be lowercase SHA-256',
    )
  }
  return value
}

type ValidationInput = {
  body: Record<string, unknown>
  runtime: OpenCodeBridgePreconditionRuntime
  allowCapabilitySnapshotRecovery?: boolean
}

export function validateOpenCodeBridgeStateChangingPreconditions(
  input: ValidationInput,
): OpenCodeBridgeCommandEvidence {
  const preconditions = parseOpenCodeBridgePreconditions(input.body.preconditions)
  const bodyLaneId = asOptionalNullableString(input.body.laneId, 'laneId')
  const expectedLaneId = preconditions?.laneId ?? bodyLaneId ?? null
  if (preconditions?.laneId && bodyLaneId && preconditions.laneId !== bodyLaneId) {
    throw new Error('OpenCode bridge expected laneId precondition does not match command laneId')
  }
  const bodyRunId = asOptionalString(input.body.runId, 'runId')
  const expectedRunId = preconditions?.expectedRunId ?? bodyRunId ?? null
  if (preconditions?.expectedRunId && bodyRunId && preconditions.expectedRunId !== bodyRunId) {
    throw new Error('OpenCode bridge expectedRunId precondition does not match command runId')
  }

  if (
    expectedRunId &&
    input.runtime.activeRunId &&
    input.runtime.activeRunId !== expectedRunId
  ) {
    throw new Error('OpenCode bridge active run precondition is stale')
  }

  const bodyCapabilitySnapshotId = asOptionalNullableString(
    input.body.expectedCapabilitySnapshotId,
    'expectedCapabilitySnapshotId',
  )
  const expectedCapabilitySnapshotId =
    preconditions?.expectedCapabilitySnapshotId ?? bodyCapabilitySnapshotId ?? null
  const recoveryAttemptId = asOptionalString(
    input.body.capabilitySnapshotRecoveryAttemptId,
    'capabilitySnapshotRecoveryAttemptId',
  )
  let capabilitySnapshotRecovery: OpenCodeBridgeCommandEvidence['capabilitySnapshotRecovery']
  if (
    expectedCapabilitySnapshotId &&
    input.runtime.capabilitySnapshotId !== expectedCapabilitySnapshotId
  ) {
    if (input.allowCapabilitySnapshotRecovery === true && recoveryAttemptId) {
      capabilitySnapshotRecovery = {
        expectedCapabilitySnapshotId,
        actualCapabilitySnapshotId: input.runtime.capabilitySnapshotId,
        recoveryAttemptId,
      }
    } else {
      throw new Error(
        `OpenCode bridge capability snapshot precondition mismatch (expected ${expectedCapabilitySnapshotId}, actual ${input.runtime.capabilitySnapshotId ?? 'null'})`,
      )
    }
  }

  const bodyManifestHighWatermark = asOptionalNullableNumber(
    input.body.manifestHighWatermark,
    'manifestHighWatermark',
  )
  const expectedManifestHighWatermark =
    preconditions?.expectedManifestHighWatermark ?? bodyManifestHighWatermark ?? null
  if (
    expectedManifestHighWatermark !== null &&
    input.runtime.runtimeStoreManifestHighWatermark !== null &&
    input.runtime.runtimeStoreManifestHighWatermark < expectedManifestHighWatermark
  ) {
    throw new Error('OpenCode bridge runtime manifest high watermark precondition is stale')
  }

  return {
    ...(preconditions ? { idempotencyKey: preconditions.idempotencyKey } : {}),
    manifestHighWatermark: input.runtime.runtimeStoreManifestHighWatermark,
    runtimeStoreManifestHighWatermark: input.runtime.runtimeStoreManifestHighWatermark,
    ...(capabilitySnapshotRecovery ? { capabilitySnapshotRecovery } : {}),
  }
}

export function parseOpenCodeBridgePreconditions(
  value: unknown,
): OpenCodeBridgeCommandPreconditions | null {
  if (value === undefined || value === null) {
    return null
  }
  const record = asRecord(value)
  if (!record) {
    throw new Error('OpenCode bridge preconditions must be an object')
  }

  return {
    handshakeIdentityHash: requireString(record.handshakeIdentityHash, 'handshakeIdentityHash'),
    laneId: requireNullableString(record.laneId, 'laneId'),
    expectedRunId: requireNullableString(record.expectedRunId, 'expectedRunId'),
    expectedCapabilitySnapshotId: requireNullableString(
      record.expectedCapabilitySnapshotId,
      'expectedCapabilitySnapshotId',
    ),
    expectedBehaviorFingerprint: requireNullableExactString(
      record.expectedBehaviorFingerprint,
      'expectedBehaviorFingerprint',
    ),
    expectedManifestHighWatermark: requireNullableNumber(
      record.expectedManifestHighWatermark,
      'expectedManifestHighWatermark',
    ),
    commandLeaseId: requireNullableString(record.commandLeaseId, 'commandLeaseId'),
    idempotencyKey: requireString(record.idempotencyKey, 'idempotencyKey'),
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined
  }
  return requireString(value, field)
}

function asOptionalNullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) {
    return undefined
  }
  return requireNullableString(value, field)
}

function asOptionalNullableNumber(value: unknown, field: string): number | null | undefined {
  if (value === undefined) {
    return undefined
  }
  return requireNullableNumber(value, field)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`OpenCode bridge precondition ${field} must be a non-empty string`)
  }
  return value.trim()
}

function requireNullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null
  }
  return requireString(value, field)
}

function requireNullableExactString(value: unknown, field: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`OpenCode bridge precondition ${field} must be a non-empty string`)
  }
  return value
}

function requireNullableNumber(value: unknown, field: string): number | null {
  if (value === null) {
    return null
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`OpenCode bridge precondition ${field} must be a non-negative integer or null`)
  }
  return value
}
