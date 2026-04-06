import { describe, expect, test } from 'bun:test'

import { deriveBootstrapTerminalStatus } from './teamBootstrapRunner.js'

describe('team bootstrap partial-failure policy', () => {
  test('returns completed when no members failed', () => {
    expect(
      deriveBootstrapTerminalStatus({
        continueOnPartialFailure: false,
        failedMembersCount: 0,
      }),
    ).toBe('completed')
  })

  test('returns partial_success when partial failures are allowed', () => {
    expect(
      deriveBootstrapTerminalStatus({
        continueOnPartialFailure: true,
        failedMembersCount: 1,
      }),
    ).toBe('partial_success')
  })

  test('returns failed when partial failures are not allowed', () => {
    expect(
      deriveBootstrapTerminalStatus({
        continueOnPartialFailure: false,
        failedMembersCount: 2,
      }),
    ).toBe('failed')
  })
})
