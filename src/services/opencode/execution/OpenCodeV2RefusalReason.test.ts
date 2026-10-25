import { expect, test } from 'bun:test'
import { openCodeV2Refusal } from './OpenCodeV2RefusalReason.js'

test('known refusals name the cause; anything else stays generic', () => {
  expect(openCodeV2Refusal(new Error('opencode_v2_version_unqualified'), 'linux-x64')).toEqual({ settled: true,
    message: 'The selected OpenCode V2 version is not qualified on linux-x64. Select another OpenCode version.' })
  expect(openCodeV2Refusal(new Error('execution_containment_launcher_unsupported'), 'linux-x64')?.message).toContain('bubblewrap 0.12.0 or later')
  // A finite cleanup wrapper means physical state is unknown: that outranks the refusal it wraps.
  expect(openCodeV2Refusal(new Error('cleanup_unknown', { cause: new Error('execution_containment_launcher_unsafe') }), 'linux-x64')).toBeNull()
  for (const error of [new Error('provider_selected_model_missing'), new Error('execution_containment_launcher_denied: bwrap: secret path'),
    new Error('execution_containment_launcher_exited'), new Error('toString'), 'execution_containment_launcher_missing', null]) {
    expect(openCodeV2Refusal(error, 'linux-x64')).toBeNull()
  }
})

test('launcher refusals are Linux only; the AppArmor denial and an unread version keep a retry', () => {
  // The darwin and Windows adapters reuse execution_containment_launcher_denied for helper failures.
  for (const platform of ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64']) {
    for (const code of ['execution_containment_launcher_denied', 'execution_containment_launcher_missing',
      'execution_containment_launcher_unsupported', 'execution_containment_launcher_unsafe', 'execution_containment_launcher_authority']) {
      expect(openCodeV2Refusal(new Error(code), platform)).toBeNull()
    }
    expect(openCodeV2Refusal(new Error('opencode_v2_version_unqualified'), platform)?.settled).toBe(true)
  }
  expect(openCodeV2Refusal(new Error('execution_containment_launcher_denied'), 'linux-x64')).toMatchObject({ settled: false })
  expect(openCodeV2Refusal(new Error('execution_containment_launcher_version_unknown'), 'linux-arm64')).toMatchObject({ settled: false })
  for (const code of ['execution_containment_launcher_missing', 'execution_containment_launcher_unsupported',
    'execution_containment_launcher_unsafe', 'execution_containment_launcher_authority']) {
    expect(openCodeV2Refusal(new Error(code), 'linux-x64')?.settled).toBe(true)
  }
})

test('a named V2 read refusal is marked in the status; unnamed failures stay plainly transient', async () => {
  const { buildOpenCodeV2RuntimeStatus } = await import('../catalog/OpenCodeV2RuntimeStatus.js')
  const settledCause = openCodeV2Refusal(new Error('execution_containment_launcher_unsupported'), 'linux-x64')!.message
  const retryableCause = openCodeV2Refusal(new Error('execution_containment_launcher_denied'), 'linux-x64')!.message
  const failedRead = { catalog: 'unavailable', defaultModel: null, models: [] }
  const snapshot = { detected: true, binaryPath: '/TEST/opencode', models: [], readGeneration: 'v2' as const, readStatus: failedRead }
  const refused = buildOpenCodeV2RuntimeStatus({ ...snapshot, probeError: settledCause, probeRefusal: 'settled' } as never)
  expect(refused).toMatchObject({ supported: false, statusCheckOutcome: 'authoritative', statusCheckErrorCode: null, detailMessage: settledCause })
  // The desktop shows detailMessage as the cause only with this code; an admin can lift the denial, so it stays retryable.
  const denied = buildOpenCodeV2RuntimeStatus({ ...snapshot, probeError: retryableCause, probeRefusal: 'retryable' } as never)
  expect(denied).toMatchObject({ supported: true, statusCheckOutcome: 'transient_error', statusCheckErrorCode: 'execution_refused',
    detailMessage: retryableCause })
  const transient = buildOpenCodeV2RuntimeStatus({ ...snapshot, probeError: 'V2 owned server cleanup unknown.' } as never)
  expect(transient).toMatchObject({ supported: true, statusCheckOutcome: 'transient_error', statusCheckErrorCode: 'unavailable',
    detailMessage: 'V2 owned server cleanup unknown.' })
  // Without a full read (passive selection) nothing is marked and the detail stays the qualification note.
  const passive = buildOpenCodeV2RuntimeStatus({ detected: true, binaryPath: '/TEST/opencode', models: [], probeError: settledCause, probeRefusal: 'settled' } as never)
  expect(passive).toMatchObject({ supported: false, statusCheckOutcome: 'transient_error', statusCheckErrorCode: 'unavailable' })
  expect(passive.detailMessage).toContain('remain unqualified')
})
