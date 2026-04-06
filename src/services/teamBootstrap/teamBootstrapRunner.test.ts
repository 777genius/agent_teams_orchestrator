import { describe, expect, test } from 'bun:test'

import {
  deriveBootstrapTerminalStatus,
  shouldCreateTeamForBootstrap,
} from './teamBootstrapRunner.js'

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

describe('team bootstrap create-vs-launch policy', () => {
  test('creates missing team during create mode', () => {
    expect(
      shouldCreateTeamForBootstrap({
        mode: 'create',
        attachState: 'missing',
        teamName: 'atlas-hq',
      }),
    ).toBe(true)
  })

  test('does not create team when already attached', () => {
    expect(
      shouldCreateTeamForBootstrap({
        mode: 'launch',
        attachState: 'attached_existing',
        teamName: 'atlas-hq',
      }),
    ).toBe(false)
  })

  test('throws when launch mode cannot find team config', () => {
    expect(() =>
      shouldCreateTeamForBootstrap({
        mode: 'launch',
        attachState: 'missing',
        teamName: 'atlas-hq',
      }),
    ).toThrow(
      'Deterministic bootstrap cannot launch team "atlas-hq" because the team config does not exist.',
    )
  })
})
