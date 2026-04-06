import { describe, expect, test } from 'bun:test'

import { validateTeamBootstrapStartupOptions } from './teamBootstrapStartupGuards.js'

describe('team bootstrap startup guards', () => {
  test('allows normal headless startup when no bootstrap spec is present', () => {
    expect(
      validateTeamBootstrapStartupOptions({
        options: {},
        inputPrompt: 'hello',
      }),
    ).toBeNull()
  })

  test('rejects resume/continue/forkSession combinations', () => {
    expect(
      validateTeamBootstrapStartupOptions({
        options: {
          teamBootstrapSpecPath: '/tmp/spec.json',
          continue: true,
        },
      }),
    ).toContain('--continue')

    expect(
      validateTeamBootstrapStartupOptions({
        options: {
          teamBootstrapSpecPath: '/tmp/spec.json',
          resume: 'session-id',
        },
      }),
    ).toContain('--resume')

    expect(
      validateTeamBootstrapStartupOptions({
        options: {
          teamBootstrapSpecPath: '/tmp/spec.json',
          forkSession: true,
        },
      }),
    ).toContain('--fork-session')
  })

  test('rejects rewind and inline prompt combinations', () => {
    expect(
      validateTeamBootstrapStartupOptions({
        options: {
          teamBootstrapSpecPath: '/tmp/spec.json',
          rewindFiles: 'message-uuid',
        },
      }),
    ).toContain('--rewind-files')

    expect(
      validateTeamBootstrapStartupOptions({
        options: {
          teamBootstrapSpecPath: '/tmp/spec.json',
        },
        inputPrompt: 'do the work',
      }),
    ).toContain('inline prompt')
  })
})
