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

export type OpenCodeConnectedSocketIdentity = {
  localAddress: string
  localPort: number
  remoteAddress: string
  remotePort: number
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

/**
 * Linux-only proof that the server half of one established TCP connection is
 * an open descriptor of the expected process. The client tuple is supplied by
 * the connected socket itself; a current listener is deliberately irrelevant.
 */
export async function captureOpenCodeEstablishedPeerIdentity(
  pid: number,
  expectedStartIdentity: string,
  connection: OpenCodeConnectedSocketIdentity,
  captureProcessIdentity: (pid: number) => Promise<HostedControlProcessIdentity> =
    captureHostedControlProcessIdentity,
  io: {
    platform?: string
    readTcpTables(): Promise<string[]>
    readProcessDescriptors(pid: number): Promise<string[]>
    readDescriptorLink(pid: number, descriptor: string): Promise<string | null>
  } = establishedPeerProcIo,
): Promise<OpenCodeLoopbackEndpointIdentity | null> {
  if ((io.platform ?? process.platform) !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0 ||
    !/^start_[0-9a-f]{64}$/.test(expectedStartIdentity) ||
    connection.localAddress !== '127.0.0.1' || connection.remoteAddress !== '127.0.0.1' ||
    !validPort(connection.localPort) || !validPort(connection.remotePort)) return null
  try {
    const before = await captureProcessIdentity(pid)
    if (before.pid !== pid || before.startIdentity !== expectedStartIdentity) return null
    const tables = await io.readTcpTables()
    const inode = establishedPeerInode(tables, connection)
    if (!inode) return null
    const descriptors = await io.readProcessDescriptors(pid)
    let owned = false
    for (const descriptor of descriptors) {
      if (await io.readDescriptorLink(pid, descriptor) === `socket:[${inode}]`) {
        owned = true
        break
      }
    }
    if (!owned) return null
    const after = await captureProcessIdentity(pid)
    if (after.pid !== pid || after.startIdentity !== expectedStartIdentity ||
      before.startIdentity !== after.startIdentity) return null
    return {
      address: '127.0.0.1', port: connection.remotePort, pid,
      startIdentity: after.startIdentity,
    }
  } catch {
    return null
  }
}

export function establishedPeerInode(
  tables: readonly string[],
  connection: OpenCodeConnectedSocketIdentity,
): string | null {
  if (connection.localAddress !== '127.0.0.1' || connection.remoteAddress !== '127.0.0.1' ||
    !validPort(connection.localPort) || !validPort(connection.remotePort)) return null
  const loopback = '0100007F'
  const serverLocal = `${loopback}:${portHex(connection.remotePort)}`
  const serverRemote = `${loopback}:${portHex(connection.localPort)}`
  const matches = tables.flatMap(table => table.split('\n').slice(1)
    .map(line => line.trim().split(/\s+/))
    .filter(fields => fields.length >= 10 && fields[1] === serverLocal &&
      fields[2] === serverRemote && fields[3] === '01'))
  return matches.length === 1 && /^(?:0|[1-9][0-9]*)$/.test(matches[0]![9]!)
    ? matches[0]![9]!
    : null
}

const validPort = (port: number): boolean => Number.isSafeInteger(port) && port >= 1 && port <= 65535
const portHex = (port: number): string => port.toString(16).toUpperCase().padStart(4, '0')

const procIo = {
  readTcpTable: async (pid: number) => await readFile(`/proc/${pid}/net/tcp`, 'utf8'),
  readProcessDescriptors: async (pid: number) => await readdir(`/proc/${pid}/fd`),
  readDescriptorLink: async (pid: number, descriptor: string) =>
    await readlink(`/proc/${pid}/fd/${descriptor}`).catch(() => null),
}

const establishedPeerProcIo = {
  readTcpTables: async () => await Promise.all([
    readFile('/proc/net/tcp', 'utf8'),
    readFile('/proc/net/tcp6', 'utf8'),
  ]),
  readProcessDescriptors: procIo.readProcessDescriptors,
  readDescriptorLink: procIo.readDescriptorLink,
}
