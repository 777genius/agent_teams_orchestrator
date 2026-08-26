import { describe, expect, test } from 'bun:test'
import { containsHostPath } from './hostPathSafety.js'

describe('host path redaction boundary', () => {
  test.each([
    '/root/.ssh/id_ed25519',
    'open file:///etc/passwd',
    'read /srv/app/.env now',
    'secret at /run/secrets/token',
    'C:\\Users\\operator\\key.txt',
    '\\\\server\\share\\private.txt',
    '\\\\?\\C:\\device\\path',
    '\\\\.\\PhysicalDrive0',
    '~/private/config',
    '~operator/.ssh/config',
    '../outside/.env',
    'safe/../../outside',
  ])('detects %s', value => expect(containsHostPath(value)).toBe(true))

  test.each([
    'Run bun test for the hosted control suite',
    'Allow network request to https://example.com/api',
    'Change package version 1.2.3',
  ])('allows non-path text %s', value => expect(containsHostPath(value)).toBe(false))
})
