import { expect, test } from 'bun:test'
import { openCodeV2ActivationDeadline, openCodeV2RunInitializationMs } from './OpenCodeV2ExecutionContracts.js'

test('a caller deadline past the platform ceiling is clipped before it reaches the child', () => {
  const started = 1_000_000, catalogLease = started + 240_000
  // Linux allows 90s: the 240s catalog lease used to reach the child unclipped and was refused.
  expect(openCodeV2ActivationDeadline(catalogLease, started, 'linux')).toBe(started + openCodeV2RunInitializationMs('linux'))
  // Darwin and Windows allow 300s, so the same caller deadline stays as it was.
  expect(openCodeV2ActivationDeadline(catalogLease, started, 'darwin')).toBe(catalogLease)
  expect(openCodeV2ActivationDeadline(catalogLease, started, 'win32')).toBe(catalogLease)
  // An earlier caller deadline always wins.
  expect(openCodeV2ActivationDeadline(started + 30_000, started, 'linux')).toBe(started + 30_000)
})
