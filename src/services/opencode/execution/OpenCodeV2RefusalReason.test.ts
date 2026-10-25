import { expect, test } from 'bun:test'
import { openCodeV2Refusal } from './OpenCodeV2RefusalReason.js'

test('known refusals name the cause; anything else stays generic', () => {
  expect(openCodeV2Refusal(new Error('opencode_v2_version_unqualified'), 'linux-x64')).toEqual({ settled: true,
    message: 'The selected OpenCode V2 version is not qualified on linux-x64. Select another OpenCode version.' })
  expect(openCodeV2Refusal(new Error('opencode_v2_version_out_of_range'), 'win32-x64')?.settled).toBe(true)
  // A finite cleanup wrapper means physical state is unknown: that outranks the refusal it wraps.
  expect(openCodeV2Refusal(new Error('cleanup_unknown', { cause: new Error('opencode_v2_version_unqualified') }), 'linux-x64')).toBeNull()
  for (const error of [new Error('provider_selected_model_missing'), new Error('opencode_v2_version_unqualified: secret path'),
    new Error('toString'), 'opencode_v2_version_unqualified', null]) {
    expect(openCodeV2Refusal(error, 'linux-x64')).toBeNull()
  }
})

test('a settled V2 read refusal is an unsupported status with its cause; other failures stay transient', async () => {
  const { buildOpenCodeV2RuntimeStatus } = await import('../catalog/OpenCodeV2RuntimeStatus.js')
  const cause = openCodeV2Refusal(new Error('opencode_v2_version_unqualified'), 'linux-x64')!.message
  const failedRead = { catalog: 'unavailable', defaultModel: null, models: [] }
  const snapshot = { detected: true, binaryPath: '/TEST/opencode', models: [], readGeneration: 'v2' as const, readStatus: failedRead }
  const refused = buildOpenCodeV2RuntimeStatus({ ...snapshot, probeError: cause, probeRefusal: true } as never)
  expect(refused).toMatchObject({ supported: false, statusCheckOutcome: 'authoritative', statusCheckErrorCode: null, detailMessage: cause })
  // A retryable refusal or an unnamed failure keeps the transient outcome and still shows its text.
  const transient = buildOpenCodeV2RuntimeStatus({ ...snapshot, probeError: 'V2 owned server cleanup unknown.' } as never)
  expect(transient).toMatchObject({ supported: true, statusCheckOutcome: 'transient_error', statusCheckErrorCode: 'unavailable',
    detailMessage: 'V2 owned server cleanup unknown.' })
  // Without a full read (passive selection) the detail stays the qualification note.
  const passive = buildOpenCodeV2RuntimeStatus({ detected: true, binaryPath: '/TEST/opencode', models: [], probeError: cause, probeRefusal: true } as never)
  expect(passive.detailMessage).toContain('remain unqualified')
  expect(passive.supported).toBe(false)
})
