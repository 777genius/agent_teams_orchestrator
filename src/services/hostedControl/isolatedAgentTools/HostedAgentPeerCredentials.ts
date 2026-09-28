import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { Socket } from 'node:net'

export type HostedAgentExpectedRootConnector = Readonly<{ pid: number; uid: number; startTicks: string }>
export type HostedAgentPeerCredentials = Readonly<{ pid: number; uid: number; gid: number }>

const CHILD_SOURCE = `
import { dlopen, FFIType, ptr } from 'bun:ffi'
const libc = dlopen('libc.so.6', { getsockopt: {
  args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32,
} })
const cred = new Int32Array(3)
const length = new Uint32Array([cred.byteLength])
if (libc.symbols.getsockopt(3, 1, 17, ptr(cred), ptr(length)) !== 0 || length[0] !== cred.byteLength) process.exit(1)
process.stdout.write(JSON.stringify({ pid: cred[0], uid: cred[1], gid: cred[2] }))
`

/** Reads Linux SO_PEERCRED from the accepted AF_UNIX socket without private Node handle access. */
export async function readLinuxHostedAgentPeerCredentials(socket: Socket): Promise<HostedAgentPeerCredentials> {
  if (process.platform !== 'linux') throw new Error('Linux peer credentials unavailable')
  const child = spawn(process.execPath, ['-e', CHILD_SOURCE], {
    stdio: ['ignore', 'pipe', 'ignore', socket],
    env: { PATH: '/usr/bin:/bin' },
    windowsHide: true,
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    output += String(chunk)
    if (output.length > 256) child.kill('SIGKILL')
  })
  const exitCode = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Peer credential timeout')) }, 2_000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', code => { clearTimeout(timeout); resolve(code ?? -1) })
  })
  if (exitCode !== 0 || output.length > 256) throw new Error('Peer credential read failed')
  const value: unknown = JSON.parse(output)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid peer credentials')
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(',') !== 'gid,pid,uid' ||
    !Number.isSafeInteger(row.pid) || !Number.isSafeInteger(row.uid) || !Number.isSafeInteger(row.gid) ||
    (row.pid as number) <= 0 || (row.uid as number) < 0 || (row.gid as number) < 0) {
    throw new Error('Invalid peer credentials')
  }
  return row as HostedAgentPeerCredentials
}

export async function matchesHostedAgentRootConnector(
  actual: HostedAgentPeerCredentials, expected: HostedAgentExpectedRootConnector,
): Promise<boolean> {
  if (process.platform !== 'linux' || actual.pid !== expected.pid || actual.uid !== expected.uid ||
    expected.uid !== 0 || !/^[1-9][0-9]*$/.test(expected.startTicks)) return false
  try {
    const stat = await readFile(`/proc/${actual.pid}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    if (close < 0) return false
    // Field 22 (starttime) is offset 19 from the first field after comm.
    const fields = stat.slice(close + 2).trim().split(/\s+/)
    return fields[19] === expected.startTicks
  } catch { return false }
}
