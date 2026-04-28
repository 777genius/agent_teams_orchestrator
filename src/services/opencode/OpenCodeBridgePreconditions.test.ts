import { describe, expect, test } from 'bun:test'

import {
  parseOpenCodeBridgePreconditions,
  validateOpenCodeBridgeStateChangingPreconditions,
} from './OpenCodeBridgePreconditions.js'

describe('OpenCodeBridgePreconditions', () => {
  test('accepts full state-changing preconditions and returns commit evidence', () => {
    const result = validateOpenCodeBridgeStateChangingPreconditions({
      body: {
        runId: 'run-1',
        preconditions: preconditions({
          expectedRunId: 'run-1',
          expectedCapabilitySnapshotId: 'cap-1',
          expectedManifestHighWatermark: 3,
          idempotencyKey: 'idem-1',
        }),
      },
      runtime: {
        capabilitySnapshotId: 'cap-1',
        runtimeStoreManifestHighWatermark: 4,
        activeRunId: 'run-1',
      },
    })

    expect(result).toEqual({
      idempotencyKey: 'idem-1',
      manifestHighWatermark: 4,
      runtimeStoreManifestHighWatermark: 4,
    })
  })

  test('validates legacy launch capability fields even before full preconditions are attached', () => {
    expect(() =>
      validateOpenCodeBridgeStateChangingPreconditions({
        body: {
          runId: 'run-1',
          expectedCapabilitySnapshotId: 'cap-old',
        },
        runtime: {
          capabilitySnapshotId: 'cap-new',
          runtimeStoreManifestHighWatermark: 0,
        },
      }),
    ).toThrow('capability snapshot precondition mismatch')
  })

  test('rejects stale runtime manifest high watermarks', () => {
    expect(() =>
      validateOpenCodeBridgeStateChangingPreconditions({
        body: {
          runId: 'run-1',
          preconditions: preconditions({
            expectedManifestHighWatermark: 10,
          }),
        },
        runtime: {
          capabilitySnapshotId: 'cap-1',
          runtimeStoreManifestHighWatermark: 9,
        },
      }),
    ).toThrow('runtime manifest high watermark precondition is stale')
  })

  test('rejects malformed precondition payloads', () => {
    expect(() => parseOpenCodeBridgePreconditions({ idempotencyKey: 'idem-1' })).toThrow(
      'handshakeIdentityHash',
    )
  })
})

function preconditions(overrides: Record<string, unknown> = {}) {
  return {
    handshakeIdentityHash: 'handshake-1',
    laneId: null,
    expectedRunId: null,
    expectedCapabilitySnapshotId: null,
    expectedBehaviorFingerprint: null,
    expectedManifestHighWatermark: null,
    commandLeaseId: 'lease-1',
    idempotencyKey: 'idem-default',
    ...overrides,
  }
}
