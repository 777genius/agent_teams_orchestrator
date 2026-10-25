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

test('a failed full V2 read shows the named cause in the provider status detail', async () => {
  const { buildOpenCodeV2RuntimeStatus } = await import('../catalog/OpenCodeV2RuntimeStatus.js')
  const cause = openCodeV2RefusalReason(new Error('execution_containment_launcher_unsupported'))!
  const snapshot = { detected: true, binaryPath: '/TEST/opencode', models: [], probeError: cause, readGeneration: 'v2' as const }
  const failed = buildOpenCodeV2RuntimeStatus({ ...snapshot, readStatus: { catalog: 'unavailable', defaultModel: null, models: [] } } as never)
  expect(failed.detailMessage).toBe(cause)
  expect(failed.statusCheckOutcome).toBe('transient_error')
  // Without a full read (passive selection) the detail stays the qualification note.
  expect(buildOpenCodeV2RuntimeStatus(snapshot as never).detailMessage).toContain('remain unqualified')
})
