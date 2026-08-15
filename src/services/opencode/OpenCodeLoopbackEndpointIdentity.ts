import { readFile, readdir, readlink } from 'node:fs/promises'

import {
  captureHostedControlProcessIdentity,
  type HostedControlProcessIdentity,
} from '../hostedControl/HostedControlProcessIdentity.js'

export type OpenCodeLoopbackEndpointIdentity = {
  address: '127.0.0.1'
  port: number
  pid: number
  startIdentity: `start_${string}`
}

/**
 * Linux-only, fail-closed proof that the exact PID owns the exact loopback
 * listener. It inspects only the expected process' descriptors; it never
 * searches other processes or accepts a listener discovered by port alone.
 */
export async function captureOpenCodeLoopbackEndpointIdentity(
  pid: number,
  port: number,
  captureProcessIdentity: (pid: number) => Promise<HostedControlProcessIdentity> =
    captureHostedControlProcessIdentity,
  io: {
    readTcpTable(pid: number): Promise<string>
    readProcessDescriptors(pid: number): Promise<string[]>
    readDescriptorLink(pid: number, descriptor: string): Promise<string | null>
  } = procIo,
): Promise<OpenCodeLoopbackEndpointIdentity | null> {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0 ||
    !Number.isSafeInteger(port) || port <= 0 || port > 65535) return null
  try {
    const before = await captureProcessIdentity(pid)
    const inode = listenerInode(await io.readTcpTable(pid), port)
    if (!inode) return null
    const descriptors = await io.readProcessDescriptors(pid)
    let owned = false
    for (const descriptor of descriptors) {
      const target = await io.readDescriptorLink(pid, descriptor)
      if (target === `socket:[${inode}]`) { owned = true; break }
    }
    if (!owned) return null
    const after = await captureProcessIdentity(pid)
    if (before.pid !== after.pid || before.startIdentity !== after.startIdentity) return null
    return { address: '127.0.0.1', port, pid, startIdentity: after.startIdentity }
  } catch {
    return null
  }
}

export function listenerInode(table: string, port: number): string | null {
  const expected = `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`
  const matches = table.split('\n').slice(1).map(line => line.trim().split(/\s+/)).filter(fields =>
    fields.length >= 10 && fields[1] === expected && fields[3] === '0A',
  )
  return matches.length === 1 && /^(?:0|[1-9][0-9]*)$/.test(matches[0]![9]!)
    ? matches[0]![9]!
    : null
}

const procIo = {
  readTcpTable: async (pid: number) => await readFile(`/proc/${pid}/net/tcp`, 'utf8'),
  readProcessDescriptors: async (pid: number) => await readdir(`/proc/${pid}/fd`),
  readDescriptorLink: async (pid: number, descriptor: string) =>
    await readlink(`/proc/${pid}/fd/${descriptor}`).catch(() => null),
}
