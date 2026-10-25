import { expect, test } from 'bun:test'
import { assertExecutionAuthority, type ExecutionAuthority, type ExecutionBirth } from './OpenCodeV2ExecutionContracts.js'

function authority(birth: ExecutionBirth): ExecutionAuthority {
  return { generation: 'v2', pin: '2.0.32', dialect: 'v2-2.0.32', graphSha256: 'a'.repeat(64),
    selectedCli: { path: '/TEST/opencode', sha256: 'b'.repeat(64), version: '2.0.32' },
    child: { pid: 73, birth, executablePath: '/TEST/bun', sha256: 'c'.repeat(64) },
    hostInstanceId: 'TEST-host', profileEpoch: 'TEST-profile', profileRoot: '/TEST/profile',
    directory: '/TEST/project', leaseOwnerId: 'TEST-lease' }
}

test('Windows authority accepts only the native positive uint64 FILETIME birth domain', () => {
  for (const value of ['1', '42', '18446744073709551615'])
    expect(() => assertExecutionAuthority(authority({ format: 'windows-filetime', value, bootId: null }))).not.toThrow()
  for (const value of ['0', '01', '-1', '1e3', 'NaN', '18446744073709551616', '999999999999999999999'])
    expect(() => assertExecutionAuthority(authority({ format: 'windows-filetime', value, bootId: null }))).toThrow('execution_contract_invalid')
  expect(() => assertExecutionAuthority(authority({ format: 'windows-filetime', value: '42', bootId: 'TEST-foreign' }))).toThrow('execution_contract_invalid')
})

test('existing birth domains remain distinct from Windows FILETIME', () => {
  for (const birth of [
    { format: 'linux-start-ticks', value: '42', bootId: 'TEST-boot' },
    { format: 'darwin-pidversion', value: '42:7', bootId: '8dcf19b2-d295-4bc0-a4e2-80c15b99cbd8' },
    { format: 'utc-ms', value: '42', bootId: null },
  ] satisfies ExecutionBirth[]) expect(() => assertExecutionAuthority(authority(birth))).not.toThrow()
  expect(() => assertExecutionAuthority(authority({ format: 'win32-filetime' as ExecutionBirth['format'], value: '42', bootId: null }))).toThrow('execution_contract_invalid')
})

test('delivery identity accepts the app’s long work-sync nudge IDs and still bounds record size', async () => {
  const { assertIntentIdentity, INTENT_IDENTITY_MAX_LENGTH } = await import('./OpenCodeV2ExecutionContracts.js')
  // A still-stuck work-sync nudge: two SHA-256 agendas and a timestamp, over the former 200 bound.
  const nudge = `member-work-sync:TEST-team:alice:agenda-sync-still-stuck:agenda:v1:${'e'.repeat(64)}:${'9'.repeat(64)}:2026-10-25T15:30:00.000Z`
  expect(nudge.length).toBeGreaterThan(200)
  const identity = { requestId: nudge, deliveryAttemptId: nudge, localMessageId: nudge, nativeInputID: 'msg_TEST0123' }
  expect(() => assertIntentIdentity(identity)).not.toThrow()
  const tooLong = 'x'.repeat(INTENT_IDENTITY_MAX_LENGTH + 1)
  for (const key of ['requestId', 'deliveryAttemptId', 'localMessageId'] as const) {
    expect(() => assertIntentIdentity({ ...identity, [key]: tooLong })).toThrow('intent_identity_invalid')
    expect(() => assertIntentIdentity({ ...identity, [key]: '' })).toThrow('intent_identity_invalid')
  }
})


test('authority binds recognized CLI identity independently of the exact persisted engine', () => {
  const original = authority({ format: 'utc-ms', value: '42', bootId: null })
  const independent = { ...original, selectedCli: { ...original.selectedCli, version: '2.99.0' as const } }
  expect(() => assertExecutionAuthority(independent)).not.toThrow()
  expect(() => assertExecutionAuthority(original)).not.toThrow()
  expect(() => assertExecutionAuthority({ ...independent, dialect: 'v2-2.99.0' })).toThrow()
  expect(() => assertExecutionAuthority({ ...independent, selectedCli: { ...independent.selectedCli, version: '3.0.0' as never } })).toThrow()
  expect(() => assertExecutionAuthority({ ...independent, selectedCli: { ...independent.selectedCli, sha256: 'tampered' } })).toThrow()
  expect(() => assertExecutionAuthority({ ...independent, graphSha256: 'tampered' })).toThrow()
})
