import { describe, expect, test } from 'bun:test'

import {
  parseOpenCodeBridgePreconditions,
  parseOptionalOpenCodeManifestHighWatermark,
  requireOpenCodeExpectedBehaviorFingerprint,
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
      manifestHighWatermark: 3,
      runtimeStoreManifestHighWatermark: 3,
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

  test('allows a fresh capability snapshot when launch is an explicit recovery attempt', () => {
    const result = validateOpenCodeBridgeStateChangingPreconditions({
      body: {
        runId: 'run-1',
        expectedCapabilitySnapshotId: 'cap-old',
        capabilitySnapshotRecoveryAttemptId: 'recovery-1',
      },
      runtime: {
        capabilitySnapshotId: 'cap-new',
        runtimeStoreManifestHighWatermark: 0,
      },
      allowCapabilitySnapshotRecovery: true,
    })

    expect(result).toEqual({
      manifestHighWatermark: 0,
      runtimeStoreManifestHighWatermark: 0,
      capabilitySnapshotRecovery: {
        expectedCapabilitySnapshotId: 'cap-old',
        actualCapabilitySnapshotId: 'cap-new',
        recoveryAttemptId: 'recovery-1',
      },
    })
  })

  test('accepts matching laneId preconditions for state-changing commands', () => {
    expect(() =>
      validateOpenCodeBridgeStateChangingPreconditions({
        body: {
          laneId: 'secondary:opencode:alice',
          preconditions: preconditions({
            laneId: 'secondary:opencode:alice',
          }),
        },
        runtime: {
          capabilitySnapshotId: 'cap-1',
          runtimeStoreManifestHighWatermark: 0,
        },
      }),
    ).not.toThrow()
  })

  test('rejects mismatched laneId preconditions for state-changing commands', () => {
    expect(() =>
      validateOpenCodeBridgeStateChangingPreconditions({
        body: {
          laneId: 'secondary:opencode:alice',
          preconditions: preconditions({
            laneId: 'secondary:opencode:bob',
          }),
        },
        runtime: {
          capabilitySnapshotId: 'cap-1',
          runtimeStoreManifestHighWatermark: 0,
        },
      }),
    ).toThrow('expected laneId precondition does not match command laneId')
  })

  test('echoes the app-owned manifest high watermark instead of comparing it', () => {
    const result = validateOpenCodeBridgeStateChangingPreconditions({
      body: {
        runId: 'run-1',
        preconditions: preconditions({
          expectedManifestHighWatermark: 10,
          idempotencyKey: 'idem-echo',
        }),
      },
      runtime: {
        capabilitySnapshotId: 'cap-1',
        runtimeStoreManifestHighWatermark: 0,
      },
    })

    expect(result).toEqual({
      idempotencyKey: 'idem-echo',
      manifestHighWatermark: 10,
      runtimeStoreManifestHighWatermark: 10,
    })
  })

  test('echoes a supplied watermark verbatim and falls back to the runtime value', () => {
    // A lower watermark than the one the app holds must survive the round trip
    // unchanged as correlation evidence; the echo does not prevent effects.
    expect(
      validateOpenCodeBridgeStateChangingPreconditions({
        body: {
          runId: 'run-1',
          preconditions: preconditions({ expectedManifestHighWatermark: 1 }),
        },
        runtime: {
          capabilitySnapshotId: 'cap-1',
          runtimeStoreManifestHighWatermark: 9,
        },
      }),
    ).toMatchObject({ manifestHighWatermark: 1, runtimeStoreManifestHighWatermark: 1 })

    expect(
      validateOpenCodeBridgeStateChangingPreconditions({
        body: {
          runId: 'run-1',
          manifestHighWatermark: 7,
        },
        runtime: {
          capabilitySnapshotId: 'cap-1',
          runtimeStoreManifestHighWatermark: 0,
        },
      }),
    ).toEqual({ manifestHighWatermark: 7, runtimeStoreManifestHighWatermark: 7 })

    expect(
      validateOpenCodeBridgeStateChangingPreconditions({
        body: {
          runId: 'run-1',
          preconditions: preconditions({ expectedManifestHighWatermark: null }),
        },
        runtime: {
          capabilitySnapshotId: 'cap-1',
          runtimeStoreManifestHighWatermark: 4,
        },
      }),
    ).toMatchObject({ manifestHighWatermark: 4, runtimeStoreManifestHighWatermark: 4 })
  })

  test('rejects a manifest high watermark outside the safe integer range', () => {
    // The supplied value is echoed into durable Stop data, whose own validator
    // requires a safe integer, so the bridge must reject it before the stop runs.
    expect(() =>
      parseOpenCodeBridgePreconditions(preconditions({ expectedManifestHighWatermark: 2 ** 53 })),
    ).toThrow('expectedManifestHighWatermark must be a non-negative safe integer or null')

    expect(
      parseOpenCodeBridgePreconditions(
        preconditions({ expectedManifestHighWatermark: 2 ** 53 - 1 }),
      )?.expectedManifestHighWatermark,
    ).toBe(2 ** 53 - 1)

    expect(() =>
      validateOpenCodeBridgeStateChangingPreconditions({
        body: { runId: 'run-1', manifestHighWatermark: 2 ** 53 },
        runtime: { capabilitySnapshotId: 'cap-1', runtimeStoreManifestHighWatermark: 0 },
      }),
    ).toThrow('manifestHighWatermark must be a non-negative safe integer or null')

    expect(
      validateOpenCodeBridgeStateChangingPreconditions({
        body: { runId: 'run-1', manifestHighWatermark: 2 ** 53 - 1 },
        runtime: { capabilitySnapshotId: 'cap-1', runtimeStoreManifestHighWatermark: 0 },
      }),
    ).toEqual({
      manifestHighWatermark: 2 ** 53 - 1,
      runtimeStoreManifestHighWatermark: 2 ** 53 - 1,
    })

    // Negative controls: the existing non-negative and integer rules still hold.
    for (const value of [-1, 1.5, Number.MAX_VALUE, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() =>
        parseOpenCodeBridgePreconditions(preconditions({ expectedManifestHighWatermark: value })),
      ).toThrow('expectedManifestHighWatermark must be a non-negative safe integer or null')
    }
  })

  test('uses strict watermark parsing for optional, nested and legacy fields', () => {
    for (const value of ['0', -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity]) {
      expect(() => parseOptionalOpenCodeManifestHighWatermark(value, 'expectedManifestHighWatermark')).toThrow()
      expect(() => parseOpenCodeBridgePreconditions(preconditions({ expectedManifestHighWatermark: value }))).toThrow()
      expect(() => validateOpenCodeBridgeStateChangingPreconditions({
        body: { manifestHighWatermark: value },
        runtime: { capabilitySnapshotId: null, runtimeStoreManifestHighWatermark: 0 },
      })).toThrow()
    }
    for (const value of [undefined, null, 0, Number.MAX_SAFE_INTEGER]) {
      expect(parseOptionalOpenCodeManifestHighWatermark(value, 'expectedManifestHighWatermark')).toBe(value)
    }
  })

  test('rejects malformed precondition payloads', () => {
    expect(() => parseOpenCodeBridgePreconditions({ idempotencyKey: 'idem-1' })).toThrow(
      'handshakeIdentityHash',
    )
  })

  test('requires an exact lowercase SHA-256 behavior fingerprint', () => {
    const valid = 'a'.repeat(64)
    expect(requireOpenCodeExpectedBehaviorFingerprint(
      parseOpenCodeBridgePreconditions(preconditions({ expectedBehaviorFingerprint: valid })),
    )).toBe(valid)
    for (const value of [null, '', ' ', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)} `]) {
      expect(() => requireOpenCodeExpectedBehaviorFingerprint(
        parseOpenCodeBridgePreconditions(preconditions({ expectedBehaviorFingerprint: value })),
      )).toThrow()
    }
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
