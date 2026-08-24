import { createHash } from 'node:crypto'

import { describe, expect, test } from 'bun:test'

import {
  captureHostedControlProcessIdentity,
  isHostedControlProcessIdentityCurrent,
} from './HostedControlProcessIdentity.js'

describe('HostedControlProcessIdentity', () => {
  test('derives Linux field 22 after the final command delimiter', async () => {
    const stat = '42 (worker ) name) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20'
    const expected = createHash('sha256').update('42\0proc:987654').digest('hex')
    await expect(captureHostedControlProcessIdentity(42, {
      platform: 'linux', readLinuxStat: async () => stat,
    })).resolves.toEqual({ pid: 42, startIdentity: `start_${expected}` })
  })

  test('derives the trimmed Darwin lstart identity', async () => {
    const expected = createHash('sha256')
      .update('7\0ps:Sat Aug 15 00:00:00 2026').digest('hex')
    await expect(captureHostedControlProcessIdentity(7, {
      platform: 'darwin', readDarwinStart: async () => ' Sat Aug 15 00:00:00 2026 \n',
    })).resolves.toEqual({ pid: 7, startIdentity: `start_${expected}` })
  })

  test('fails closed for malformed, unavailable, and unsupported identities', async () => {
    await expect(captureHostedControlProcessIdentity(1, {
      platform: 'linux', readLinuxStat: async () => '1 (x) S 1',
    })).rejects.toThrow('start tick')
    await expect(captureHostedControlProcessIdentity(1, { platform: 'win32' }))
      .rejects.toThrow('unsupported')
    await expect(isHostedControlProcessIdentityCurrent({
      pid: 1, startIdentity: `start_${'a'.repeat(64)}`,
    }, { platform: 'linux', readLinuxStat: async () => { throw new Error('gone') } }))
      .resolves.toBe(false)
  })
})
