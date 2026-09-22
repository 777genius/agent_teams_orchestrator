import { describe, expect, test } from 'bun:test'

import {
  assertStableTeamBootstrapRuntimeIdentity,
  getCurrentTeamBootstrapRuntimeIdentity,
} from './teamBootstrapRuntimeIdentity.js'

describe('team bootstrap runtime identity', () => {
  test('accepts unchanged runtime identity', () => {
    const identity = getCurrentTeamBootstrapRuntimeIdentity()
    expect(() =>
      assertStableTeamBootstrapRuntimeIdentity({
        teamName: 'atlas-hq',
        expected: identity,
        current: { ...identity },
      }),
    ).not.toThrow()
  })

  test('rejects teammate command drift', () => {
    const identity = getCurrentTeamBootstrapRuntimeIdentity()
    expect(() =>
      assertStableTeamBootstrapRuntimeIdentity({
        teamName: 'atlas-hq',
        expected: identity,
        current: {
          ...identity,
          teammateCommand: `${identity.teammateCommand} --different`,
        },
      }),
    ).toThrow(
      'Deterministic bootstrap cannot continue team "atlas-hq" because the runtime executable identity changed during launch.',
    )
  })
})
