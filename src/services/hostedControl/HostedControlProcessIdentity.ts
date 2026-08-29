import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

export type HostedControlProcessIdentity = {
  pid: number
  startIdentity: `start_${string}`
}

type HostedControlProcessIdentityDeps = {
  platform?: NodeJS.Platform
  readLinuxStat?: (pid: number) => Promise<string>
  readDarwinStart?: (pid: number) => Promise<string>
}

const execFileAsync = promisify(execFile)

/**
 * Derives the frozen transition-contract process incarnation. It deliberately
 * has no uptime, wall-clock, or process-existence fallback: an unreadable
 * kernel start identity is not authority.
 */
export async function captureHostedControlProcessIdentity(
  pid: number,
  deps: HostedControlProcessIdentityDeps = {},
): Promise<HostedControlProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new TypeError('Hosted control process pid is invalid')
  }

  const platform = deps.platform ?? process.platform
  let source: string
  if (platform === 'linux') {
    const stat = await (deps.readLinuxStat ?? readLinuxStat)(pid)
    source = `proc:${parseLinuxStartTicks(stat)}`
  } else if (platform === 'darwin') {
    const started = (await (deps.readDarwinStart ?? readDarwinStart)(pid)).trim()
    if (!started || /[\r\n\0]/.test(started)) {
      throw new Error('Hosted control Darwin process start identity is invalid')
    }
    source = `ps:${started}`
  } else {
    throw new Error(`Hosted control process identity is unsupported on ${platform}`)
  }

  const digest = createHash('sha256')
    .update(String(pid), 'utf8')
    .update(Buffer.from([0]))
    .update(source, 'utf8')
    .digest('hex')
  return { pid, startIdentity: `start_${digest}` }
}

export async function isHostedControlProcessIdentityCurrent(
  expected: HostedControlProcessIdentity,
  deps: HostedControlProcessIdentityDeps = {},
): Promise<boolean> {
  try {
    const current = await captureHostedControlProcessIdentity(expected.pid, deps)
    return current.startIdentity === expected.startIdentity
  } catch {
    return false
  }
}

function parseLinuxStartTicks(stat: string): string {
  const delimiter = stat.lastIndexOf(')')
  if (delimiter < 2 || stat[delimiter + 1] !== ' ') {
    throw new Error('Hosted control Linux process stat is malformed')
  }
  // Fields following comm begin with field 3 (state); array offset 19 is
  // therefore field 22 (starttime).
  const fields = stat.slice(delimiter + 2).trim().split(/\s+/)
  const ticks = fields[19]
  if (!ticks || !/^(?:0|[1-9][0-9]*)$/.test(ticks)) {
    throw new Error('Hosted control Linux process start tick is invalid')
  }
  return ticks
}

async function readLinuxStat(pid: number): Promise<string> {
  return await readFile(`/proc/${pid}/stat`, 'utf8')
}

async function readDarwinStart(pid: number): Promise<string> {
  const result = await execFileAsync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    maxBuffer: 4096,
  })
  return result.stdout
}
