import { describe, expect, test } from 'bun:test'

import {
  resolveTeamBootstrapSpecPath,
  validateTeamBootstrapStartupOptions,
} from './teamBootstrapStartupGuards.js'

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

  test('resolves the bootstrap spec from argv when commander omitted it', () => {
    expect(
      resolveTeamBootstrapSpecPath(undefined, [
        'bun',
        'cli.tsx',
        '--print',
        '--team-bootstrap-spec',
        '/tmp/spec.json',
      ]),
    ).toBe('/tmp/spec.json')
    expect(
      resolveTeamBootstrapSpecPath('  /tmp/from-options.json  ', [
        'bun',
        'cli.tsx',
        '--team-bootstrap-spec',
        '/tmp/spec.json',
      ]),
    ).toBe('/tmp/from-options.json')
  })

  test('allows stream input objects when bootstrap spec is present', () => {
    async function* streamInput(): AsyncIterable<string> {
      yield '{"type":"user"}'
    }

    expect(
      validateTeamBootstrapStartupOptions({
        options: {
          teamBootstrapSpecPath: '/tmp/spec.json',
        },
        inputPrompt: streamInput(),
      }),
    ).toBeNull()
  })
})
