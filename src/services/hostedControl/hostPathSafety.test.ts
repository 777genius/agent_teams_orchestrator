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
    'workspace/private/secrets.json',
    'workspace\\private\\secrets.json',
    'cwd:/srv/private/project',
    'cwd:workspace/private/file.txt',
    'file:../private/file.txt',
    '\\Device\\HarddiskVolume1\\private\\key',
    '\\??\\C:\\private\\key',
    '%2e%2e%2fprivate%2fkey',
    '%252e%252e%255cprivate%255ckey',
    'prefix% %2e%2e%2fprivate%2fkey',
    '%25252e%25252e%25252fprivate%25252fkey',
    '%252525252525252e%252525252525252e%252525252525252fprivate',
    '%255c%255c%253f%255cC%253a%255cprivate%255ckey',
    'workspace%EF%BC%8Fprivate%EF%BC%8Fkey',
    'workspace\uff0fprivate\uff0fkey',
  ])('detects %s', value => expect(containsHostPath(value)).toBe(true))

  test.each([
    'Run bun test for the hosted control suite',
    'Allow network request to https://example.com/api',
    'Change package version 1.2.3',
  ])('allows non-path text %s', value => expect(containsHostPath(value)).toBe(false))

  test('fails closed under bounded repeated-decoding work', () => {
    expect(containsHostPath(`safe ${'%25'.repeat(100_000)}`)).toBe(true)
  })
})
