import { readFileSync, readlinkSync } from 'node:fs'
import { readFile, readlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

export const ACTUAL_OWNER_PROCESS_ANCHOR_PURPOSE =
  'agent-teams.hosted-actual-owner-e2e.process-anchor/v1'

export type ActualOwnerProcessAnchor = Readonly<{
  schemaVersion: 1
  purpose: typeof ACTUAL_OWNER_PROCESS_ANCHOR_PURPOSE
  platform: 'linux'
  pid: number
  startTimeTicks: string
  bootId: string
  pidNamespace: string
  executableSha256: `sha256:${string}`
}>

export type ActualOwnerProcessAnchorReader = Readonly<{
  platform: NodeJS.Platform
  pid: number
  readFile: (path: string) => Promise<string>
  readlink: (path: string) => Promise<string>
  readExecutable: (path: string) => Promise<Buffer>
}>

export type ActualOwnerProcessAnchorVerifier = Readonly<{
  platform: NodeJS.Platform
  readFile: (path: string) => string
  readlink: (path: string) => string
  readExecutable: (path: string) => Buffer
}>

export type ActualOwnerBootClockReader = Readonly<{
  readFile: (path: string) => string
  clockTicksPerSecond: () => string
}>

const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PID_NAMESPACE = /^pid:\[[1-9][0-9]*\]$/
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/
const BOOT_TIME = /^btime ([1-9][0-9]*)$/m
const GETCONF_PATHS = ['/usr/bin/getconf', '/bin/getconf'] as const

export function authoritativeClockTicksPerSecond(
  execute: (file: string, args: readonly string[]) => string = (file, args) =>
    execFileSync(file, args, { encoding: 'utf8' }),
): string {
  for (const path of GETCONF_PATHS) {
    try {
      return execute(path, ['CLK_TCK'])
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new Error('hosted_actual_owner_process_start_unavailable', { cause: error })
    }
  }
  throw new Error('hosted_actual_owner_process_start_unavailable')
}

function parseLinuxStat(value: string, expectedPid: number): string {
  const commandEnd = value.lastIndexOf(')')
  const pidEnd = value.indexOf(' ')
  if (commandEnd < pidEnd || pidEnd < 1 || value.slice(0, pidEnd) !== String(expectedPid)) {
    throw new Error('hosted_actual_owner_process_anchor_invalid')
  }
  const fields = value.slice(commandEnd + 2).trim().split(/\s+/)
  const startTimeTicks = fields[19]
  if (fields.length < 20 || fields[0] === 'Z' || fields[0] === 'X' || fields[0] === 'x' ||
    !startTimeTicks || !POSITIVE_DECIMAL.test(startTimeTicks)) {
    throw new Error('hosted_actual_owner_process_anchor_invalid')
  }
  return startTimeTicks
}

export async function captureActualOwnerProcessAnchor(
  reader: ActualOwnerProcessAnchorReader,
): Promise<ActualOwnerProcessAnchor> {
  if (reader.platform !== 'linux' || !Number.isSafeInteger(reader.pid) || reader.pid < 1) {
    throw new Error('hosted_actual_owner_process_anchor_unavailable')
  }
  const firstStat = await reader.readFile('/proc/self/stat')
  const [bootIdInput, pidNamespace, executable, secondStat] = await Promise.all([
    reader.readFile('/proc/sys/kernel/random/boot_id'),
    reader.readlink('/proc/self/ns/pid'),
    reader.readExecutable('/proc/self/exe'),
    reader.readFile('/proc/self/stat'),
  ])
  const firstStart = parseLinuxStat(firstStat, reader.pid)
  const secondStart = parseLinuxStat(secondStat, reader.pid)
  const bootId = bootIdInput.trim()
  if (firstStart !== secondStart || !BOOT_ID.test(bootId) || !PID_NAMESPACE.test(pidNamespace)) {
    throw new Error('hosted_actual_owner_process_anchor_invalid')
  }
  return Object.freeze({
    schemaVersion: 1,
    purpose: ACTUAL_OWNER_PROCESS_ANCHOR_PURPOSE,
    platform: 'linux',
    pid: reader.pid,
    startTimeTicks: firstStart,
    bootId,
    pidNamespace,
    executableSha256: `sha256:${createHash('sha256').update(executable).digest('hex')}`,
  })
}

export function validateActualOwnerProcessAnchor(value: unknown): ActualOwnerProcessAnchor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('hosted_actual_owner_process_anchor_invalid')
  }
  const keys = Object.keys(value).sort()
  const expected = [
    'bootId', 'executableSha256', 'pid', 'pidNamespace', 'platform', 'purpose',
    'schemaVersion', 'startTimeTicks',
  ].sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('hosted_actual_owner_process_anchor_invalid')
  }
  const schemaVersion = Reflect.get(value, 'schemaVersion')
  const purpose = Reflect.get(value, 'purpose')
  const platform = Reflect.get(value, 'platform')
  const pid = Reflect.get(value, 'pid')
  const startTimeTicks = Reflect.get(value, 'startTimeTicks')
  const bootId = Reflect.get(value, 'bootId')
  const pidNamespace = Reflect.get(value, 'pidNamespace')
  const executableSha256 = Reflect.get(value, 'executableSha256')
  if (schemaVersion !== 1 || purpose !== ACTUAL_OWNER_PROCESS_ANCHOR_PURPOSE ||
    platform !== 'linux' || !Number.isSafeInteger(pid) || pid < 1 ||
    typeof startTimeTicks !== 'string' || !POSITIVE_DECIMAL.test(startTimeTicks) ||
    typeof bootId !== 'string' || !BOOT_ID.test(bootId) ||
    typeof pidNamespace !== 'string' || !PID_NAMESPACE.test(pidNamespace) ||
    typeof executableSha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(executableSha256)) {
    throw new Error('hosted_actual_owner_process_anchor_invalid')
  }
  return Object.freeze({
    schemaVersion: 1,
    purpose: ACTUAL_OWNER_PROCESS_ANCHOR_PURPOSE,
    platform: 'linux',
    pid,
    startTimeTicks,
    bootId,
    pidNamespace,
    executableSha256,
  })
}

export function assertActualOwnerProcessAnchorCurrent(
  value: unknown,
  verifier: ActualOwnerProcessAnchorVerifier = {
    platform: process.platform,
    readFile: path => readFileSync(path, 'utf8'),
    readlink: readlinkSync,
    readExecutable: path => readFileSync(path),
  },
): ActualOwnerProcessAnchor {
  const anchor = validateActualOwnerProcessAnchor(value)
  if (verifier.platform !== 'linux') {
    throw new Error('hosted_actual_owner_process_anchor_current_unavailable')
  }
  try {
    const statPath = `/proc/${anchor.pid}/stat`
    const firstStat = verifier.readFile(statPath)
    const bootId = verifier.readFile('/proc/sys/kernel/random/boot_id').trim()
    const pidNamespace = verifier.readlink(`/proc/${anchor.pid}/ns/pid`)
    const executableSha256 = `sha256:${createHash('sha256')
      .update(verifier.readExecutable(`/proc/${anchor.pid}/exe`))
      .digest('hex')}`
    const secondStat = verifier.readFile(statPath)
    if (parseLinuxStat(firstStat, anchor.pid) !== anchor.startTimeTicks ||
      parseLinuxStat(secondStat, anchor.pid) !== anchor.startTimeTicks ||
      bootId !== anchor.bootId || pidNamespace !== anchor.pidNamespace ||
      executableSha256 !== anchor.executableSha256) {
      throw new Error('hosted_actual_owner_process_anchor_stale')
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'hosted_actual_owner_process_anchor_stale') {
      throw error
    }
    throw new Error('hosted_actual_owner_process_anchor_stale')
  }
  return anchor
}

export function actualOwnerProcessStartedAtUnixNs(
  anchorValue: unknown,
  reader: ActualOwnerBootClockReader = {
    readFile: path => readFileSync(path, 'utf8'),
    clockTicksPerSecond: authoritativeClockTicksPerSecond,
  },
): bigint {
  const anchor = validateActualOwnerProcessAnchor(anchorValue)
  const bootId = reader.readFile('/proc/sys/kernel/random/boot_id').trim()
  const bootTimeMatch = BOOT_TIME.exec(reader.readFile('/proc/stat'))
  const ticksPerSecondInput = reader.clockTicksPerSecond().trim()
  if (bootId !== anchor.bootId || !bootTimeMatch || !POSITIVE_DECIMAL.test(ticksPerSecondInput)) {
    throw new Error('hosted_actual_owner_process_start_unavailable')
  }
  const ticksPerSecond = BigInt(ticksPerSecondInput)
  const startTimeTicks = BigInt(anchor.startTimeTicks)
  const bootTimeNs = BigInt(bootTimeMatch[1]!) * 1_000_000_000n
  return bootTimeNs + startTimeTicks * 1_000_000_000n / ticksPerSecond
}

export function captureCurrentActualOwnerProcessAnchor(): Promise<ActualOwnerProcessAnchor> {
  return captureActualOwnerProcessAnchor({
    platform: process.platform,
    pid: process.pid,
    readFile: path => readFile(path, 'utf8'),
    readlink,
    readExecutable: path => readFile(path),
  })
}
