import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import {
  actualOwnerProcessStartedAtUnixNs,
  assertActualOwnerProcessAnchorCurrent,
  authoritativeClockTicksPerSecond,
  captureActualOwnerProcessAnchor,
  captureCurrentActualOwnerProcessAnchor,
  validateActualOwnerProcessAnchor,
  type ActualOwnerProcessAnchorReader,
  type ActualOwnerProcessAnchorVerifier,
} from './process-anchor.js'

const bootId = '12345678-1234-1234-1234-123456789abc'
const pidNamespace = 'pid:[4026531836]'
const executable = Buffer.from('sealed-owner-executable')
const executableSha256 = `sha256:${createHash('sha256').update(executable).digest('hex')}` as const

function stat(pid: number, startTimeTicks: string): string {
  const fields = ['S', ...Array.from({ length: 18 }, () => '0'), startTimeTicks]
  return `${pid} (actual owner) ${fields.join(' ')}\n`
}

function reader(
  overrides: Readonly<{ first?: string; second?: string }> = {},
): ActualOwnerProcessAnchorReader {
  let statRead = 0
  return {
    platform: 'linux',
    pid: 42,
    readFile: async (path: string) => {
      if (path === '/proc/sys/kernel/random/boot_id') return `${bootId}\n`
      statRead += 1
      return statRead === 1
        ? overrides.first ?? stat(42, '123456')
        : overrides.second ?? stat(42, '123456')
    },
    readlink: async () => pidNamespace,
    readExecutable: async () => executable,
  }
}

describe('hosted actual-owner process anchor', () => {
  test('captures a non-PID-only Linux process incarnation', async () => {
    const anchor = await captureActualOwnerProcessAnchor(reader())
    expect(anchor).toEqual({
      schemaVersion: 1,
      purpose: 'agent-teams.hosted-actual-owner-e2e.process-anchor/v1',
      platform: 'linux',
      pid: 42,
      startTimeTicks: '123456',
      bootId,
      pidNamespace,
      executableSha256,
    })
    expect(validateActualOwnerProcessAnchor(anchor)).toEqual(anchor)
  })

  test('fails closed on unsupported hosts, identity drift, and PID-only input', async () => {
    await expect(captureActualOwnerProcessAnchor({ ...reader(), platform: 'darwin' }))
      .rejects.toThrow(/process_anchor_unavailable/)
    await expect(captureActualOwnerProcessAnchor(reader({ second: stat(42, '123457') })))
      .rejects.toThrow(/process_anchor_invalid/)
    await expect(captureActualOwnerProcessAnchor(reader({ first: stat(42, '0') })))
      .rejects.toThrow(/process_anchor_invalid/)
    expect(() => validateActualOwnerProcessAnchor({ pid: 42 }))
      .toThrow(/process_anchor_invalid/)
  })

  test('proves the captured PID incarnation is still current at validation time', () => {
    const verifier = (overrides: { second?: string; bootId?: string } = {}):
    ActualOwnerProcessAnchorVerifier => {
      let reads = 0
      return {
        platform: 'linux',
        readFile: path => {
          if (path === '/proc/sys/kernel/random/boot_id') return overrides.bootId ?? bootId
          reads += 1
          return reads === 1 ? stat(42, '123456') : overrides.second ?? stat(42, '123456')
        },
        readlink: () => pidNamespace,
        readExecutable: () => executable,
      }
    }
    const anchor = {
      schemaVersion: 1,
      purpose: 'agent-teams.hosted-actual-owner-e2e.process-anchor/v1',
      platform: 'linux', pid: 42, startTimeTicks: '123456', bootId, pidNamespace,
      executableSha256,
    } as const
    expect(assertActualOwnerProcessAnchorCurrent(anchor, verifier())).toEqual(anchor)
    expect(() => assertActualOwnerProcessAnchorCurrent(
      anchor, verifier({ second: stat(42, '123457') }),
    )).toThrow(/process_anchor_stale/)
    expect(() => assertActualOwnerProcessAnchorCurrent(
      anchor, verifier({ bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
    )).toThrow(/process_anchor_stale/)
  })

  test('validates the current process through the default procfs boundary', async () => {
    const anchor = await captureCurrentActualOwnerProcessAnchor()
    expect(assertActualOwnerProcessAnchorCurrent(anchor)).toEqual(anchor)
  })

  test('derives process freshness from boot time and start-time clock ticks', () => {
    const anchor = {
      schemaVersion: 1,
      purpose: 'agent-teams.hosted-actual-owner-e2e.process-anchor/v1',
      platform: 'linux', pid: 42, startTimeTicks: '250', bootId, pidNamespace,
      executableSha256,
    } as const
    expect(actualOwnerProcessStartedAtUnixNs(anchor, {
      readFile: path => path.endsWith('boot_id') ? `${bootId}\n` : 'cpu 1 2 3\nbtime 1700000000\n',
      clockTicksPerSecond: () => '100\n',
    })).toBe(1_700_000_002_500_000_000n)
    expect(() => actualOwnerProcessStartedAtUnixNs(anchor, {
      readFile: path => path.endsWith('boot_id') ? `${bootId}\n` : 'cpu 1 2 3\n',
      clockTicksPerSecond: () => '100\n',
    })).toThrow(/process_start_unavailable/)
  })

  test('uses an authoritative absolute getconf path with an unusable ambient PATH', async () => {
    const modulePath = resolve(import.meta.dir, 'process-anchor.ts')
    const child = spawnSync(process.execPath, ['-e', [
      `import { actualOwnerProcessStartedAtUnixNs, captureCurrentActualOwnerProcessAnchor } from ${JSON.stringify(modulePath)}`,
      'const anchor = await captureCurrentActualOwnerProcessAnchor()',
      'process.stdout.write(String(actualOwnerProcessStartedAtUnixNs(anchor)))',
    ].join(';')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '/definitely/not/an/authoritative/tool-directory' },
    })
    expect(child.status).toBe(0)
    expect(child.stderr).toBe('')
    expect(child.stdout).toMatch(/^[1-9][0-9]*$/)
  })

  test('falls back to /bin/getconf only when /usr/bin/getconf is absent', () => {
    const attempted: string[] = []
    expect(authoritativeClockTicksPerSecond((path, args) => {
      attempted.push(`${path} ${args.join(' ')}`)
      if (path === '/usr/bin/getconf') {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }
      return '100\n'
    })).toBe('100\n')
    expect(attempted).toEqual(['/usr/bin/getconf CLK_TCK', '/bin/getconf CLK_TCK'])
  })

  test('does not mask a non-ENOENT getconf failure with the fallback', () => {
    const attempted: string[] = []
    expect(() => authoritativeClockTicksPerSecond((path) => {
      attempted.push(path)
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })).toThrow(/process_start_unavailable/)
    expect(attempted).toEqual(['/usr/bin/getconf'])
  })
})
