import { expect, test } from 'bun:test'
import { openCodeV2RefusalReason } from './OpenCodeV2RefusalReason.js'

test('known refusals name the cause; anything else stays generic', () => {
  expect(openCodeV2RefusalReason(new Error('opencode_v2_version_unqualified'), 'linux-x64')).toBe(
    'The selected OpenCode V2 version is not qualified on linux-x64. Select another OpenCode version.')
  expect(openCodeV2RefusalReason(new Error('execution_containment_launcher_unsupported'))).toContain('bubblewrap 0.12.0 or later')
  // A finite cleanup wrapper keeps the original refusal as its cause.
  expect(openCodeV2RefusalReason(new Error('cleanup_unknown', { cause: new Error('execution_containment_launcher_denied') })))
    .toContain('could not create the OpenCode V2 sandbox')
  for (const error of [new Error('provider_selected_model_missing'), new Error('execution_containment_launcher_denied: bwrap: secret path'),
    new Error('toString'), 'execution_containment_launcher_missing', null]) {
    expect(openCodeV2RefusalReason(error)).toBeNull()
  }
})

test('a named V2 read refusal is a settled unsupported status with its cause; other failures stay transient', async () => {
  const { buildOpenCodeV2RuntimeStatus } = await import('../catalog/OpenCodeV2RuntimeStatus.js')
  const cause = openCodeV2RefusalReason(new Error('execution_containment_launcher_unsupported'))!
  const failedRead = { catalog: 'unavailable', defaultModel: null, models: [] }
  const snapshot = { detected: true, binaryPath: '/TEST/opencode', models: [], readGeneration: 'v2' as const, readStatus: failedRead }
  const refused = buildOpenCodeV2RuntimeStatus({ ...snapshot, probeError: cause, probeRefusal: true } as never)
  expect(refused).toMatchObject({ supported: false, statusCheckOutcome: 'authoritative', statusCheckErrorCode: null, detailMessage: cause })
  // An unnamed failure (or cleanup unknown) keeps the retryable transient outcome.
  const transient = buildOpenCodeV2RuntimeStatus({ ...snapshot, probeError: 'V2 owned server cleanup unknown.' } as never)
  expect(transient).toMatchObject({ supported: true, statusCheckOutcome: 'transient_error', statusCheckErrorCode: 'unavailable',
    detailMessage: 'V2 owned server cleanup unknown.' })
  // Without a full read (passive selection) the detail stays the qualification note.
  const passive = buildOpenCodeV2RuntimeStatus({ detected: true, binaryPath: '/TEST/opencode', models: [], probeError: cause, probeRefusal: true } as never)
  expect(passive.detailMessage).toContain('remain unqualified')
  expect(passive.supported).toBe(false)
})
