import { closeSync, lstatSync, writeSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { SocketBrokerWriteQueue } from './HostedControlSocketBrokerTransport.js'
import { pinSocketBrokerPath, requireSocketBrokerAssociation } from './HostedControlSocketBrokerAssociation.js'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { proveSocketBrokerSelfPeer, readSocketBrokerDescriptor } from './HostedControlSocketBrokerDescriptors.js'

export const HOSTED_CONTROL_SOCKET_BROKER_FLAG = '--hosted-control-socket-broker'
const BATCH_MAGIC = Buffer.from('HCB2')
const MAX_BATCH_BYTES = 4096

export type SocketBrokerIdentity = Readonly<{ device: number; inode: number }>
export type SocketBrokerMapping = Readonly<{
  listenPath: string
  targetPort: number
  token: Buffer
  parentIdentity: SocketBrokerIdentity
}>

/** Internal inherited-channel format only. No lifecycle or native protocol change. */
export function encodeSocketBrokerBatch(mappings: readonly SocketBrokerMapping[]): Buffer {
  validateMappings(mappings)
  const parts = [BATCH_MAGIC, Buffer.from([mappings.length])]
  for (const mapping of mappings) {
    const path = Buffer.from(mapping.listenPath)
    const header = Buffer.alloc(20)
    header.writeUInt16BE(path.length, 0)
    header.writeUInt16BE(mapping.targetPort, 2)
    header.writeDoubleBE(mapping.parentIdentity.device, 4)
    header.writeDoubleBE(mapping.parentIdentity.inode, 12)
    parts.push(header, path, mapping.token)
  }
  return Buffer.concat(parts)
}

function validateMappings(mappings: readonly SocketBrokerMapping[]): void {
  if (mappings.length !== 1 && mappings.length !== 2) throw new Error('Invalid hosted control broker batch count')
  for (const [index, mapping] of mappings.entries()) {
    if (!isAbsolute(mapping.listenPath) || resolve(mapping.listenPath) !== mapping.listenPath ||
      mapping.listenPath.includes('\0') || Buffer.byteLength(mapping.listenPath) > 1024 ||
      !Number.isInteger(mapping.targetPort) || mapping.targetPort < 1 || mapping.targetPort > 65535 ||
      !Buffer.isBuffer(mapping.token) || mapping.token.length !== 32 ||
      !Number.isSafeInteger(mapping.parentIdentity.device) || mapping.parentIdentity.device < 0 ||
      !Number.isSafeInteger(mapping.parentIdentity.inode) || mapping.parentIdentity.inode < 1) {
      throw new Error('Invalid hosted control broker mapping')
    }
    for (const previous of mappings.slice(0, index)) {
      if (mapping.listenPath === previous.listenPath ||
        (mapping.parentIdentity.device === previous.parentIdentity.device &&
          mapping.parentIdentity.inode === previous.parentIdentity.inode && basename(mapping.listenPath) === basename(previous.listenPath)) ||
        mapping.targetPort === previous.targetPort ||
        timingSafeEqual(mapping.token, previous.token)) {
        throw new Error('Duplicate hosted control broker mapping identity')
      }
    }
  }
}

async function readBatch(): Promise<SocketBrokerMapping[]> {
  const bytes = Buffer.alloc(MAX_BATCH_BYTES + 1)
  const mappings: SocketBrokerMapping[] = []
  try {
    const length = await readSocketBrokerDescriptor(3, bytes, performance.now() + 5_000)
    if (length > MAX_BATCH_BYTES || length < 5 || !bytes.subarray(0, 4).equals(BATCH_MAGIC) ||
      (bytes[4] !== 1 && bytes[4] !== 2)) throw new Error('Invalid batch')
    let offset = 5
    for (let index = 0; index < bytes[4]!; index += 1) {
      if (offset + 20 > length) throw new Error('Truncated batch')
      const pathLength = bytes.readUInt16BE(offset)
      const targetPort = bytes.readUInt16BE(offset + 2)
      const parentIdentity = { device: bytes.readDoubleBE(offset + 4), inode: bytes.readDoubleBE(offset + 12) }
      offset += 20
      if (offset + pathLength + 32 > length) throw new Error('Truncated mapping')
      const listenPath = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + pathLength))
      offset += pathLength
      const token = Buffer.from(bytes.subarray(offset, offset + 32))
      offset += 32
      mappings.push({ listenPath, targetPort, token, parentIdentity })
    }
    if (offset !== length) throw new Error('Trailing batch bytes')
    validateMappings(mappings)
    return mappings
  } catch {
    for (const mapping of mappings) mapping.token.fill(0)
    throw new Error('Hosted control socket broker private batch is invalid')
  } finally {
    bytes.fill(0)
  }
}

/** One supervised child, fixed one/two listeners. Never Server.close(): Bun
 * can unlink a replacement at a listener's remembered hidden pathname. */
export async function runHostedControlSocketBroker(args: string[], hooks: {
  afterBindForTest?: (index: number, listenPath: string) => Promise<void>
  afterFirstStatForTest?: (index: number, listenPath: string) => Promise<void>
  afterPeerAttemptForTest?: (index: number, listenPath: string, proved: boolean) => Promise<void>
} = {}): Promise<never> {
  if (args.length !== 0) throw new Error('Hosted control socket broker accepts only its private batch')
  const mappings = await readBatch()
  const peers = new Set<Bun.Socket>()
  const listeners: Bun.Listener[] = []
  const pairs = new Set<() => void>()
  const upstreamPeers = new Set<Bun.Socket>()
  let shuttingDown = false
  const terminate = () => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      for (const mapping of mappings) mapping.token.fill(0)
      for (const fail of pairs) fail()
      for (const peer of peers) peer.terminate()
      for (const peer of upstreamPeers) peer.terminate()
      // The supervision closure keeps the listeners strongly reachable.
      for (const listener of listeners) listener.ref()
    } finally { process.kill(process.pid, 'SIGKILL') }
  }
  process.stdin.resume()
  process.stdin.once('end', terminate)
  process.stdin.once('error', terminate)
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'] as const) process.once(signal, terminate)
  process.once('uncaughtException', terminate)
  process.once('unhandledRejection', terminate)
  process.umask(0o177)
  try {
    requireSocketBrokerAssociation()
    for (const [index, mapping] of mappings.entries()) {
      const parent = lstatSync(dirname(mapping.listenPath))
      if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700 ||
        (process.getuid?.() !== undefined && parent.uid !== process.getuid?.()) ||
        parent.dev !== mapping.parentIdentity.device || parent.ino !== mapping.parentIdentity.inode) {
        throw new Error('Hosted control socket broker parent changed')
      }
      // Never let runtime-specific stale-socket handling replace an existing name.
      try {
        lstatSync(mapping.listenPath)
        throw new Error('Hosted control socket broker path is occupied')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const nonce = randomBytes(32)
      const probePeers = new Map<Bun.Socket, { bytes: Buffer; length: number; terminal: boolean }>()
      const connections = new Map<Bun.Socket, {
        request: SocketBrokerWriteQueue; response: () => SocketBrokerWriteQueue | undefined
        fail: () => void; close: () => void
      }>()
      let acceptProof!: () => void
      let rejectProof!: (error: Error) => void
      const accepted = new Promise<void>((accept, reject) => { acceptProof = accept; rejectProof = reject })
      void accepted.catch(() => undefined)
      // Arm BEFORE listen and scheduling hooks. Candidates stay candidates even
      // if registration completes before their next callback.
      let proving = true
      const rejectCandidate = (socket: Bun.Socket) => {
        const candidate = probePeers.get(socket)
        if (!candidate || candidate.terminal) return
        candidate.terminal = true
        candidate.bytes.fill(0)
        socket.terminate()
      }
      const server = Bun.listen({
        unix: mapping.listenPath, allowHalfOpen: true,
        socket: {
          open(client) {
            client.pause() // no callback-followed-by-Node-resume; gate before yielding
            peers.add(client)
            if (shuttingDown) { client.terminate(); return }
            if (proving) {
              probePeers.set(client, { bytes: Buffer.alloc(nonce.length), length: 0, terminal: false })
              client.resume()
              return
            }
            let upstream: Bun.Socket | undefined
            let response: SocketBrokerWriteQueue | undefined
            let downstreamClosed = false, upstreamClosed = false
            let failed = false, finishing = false, terminal = false
            const fail = () => {
              if (failed || terminal) return
              failed = true // fence writes/resumes before close callbacks reenter
              request.stop()
              response?.stop()
              pairs.delete(fail)
              try { client.terminate() } finally { upstream?.terminate() }
            }
            const reconcile = () => {
              if (failed || terminal) return
              if (request.finSent && response?.finSent && !finishing) {
                finishing = true
                // Both input EOFs and both output cursors completed. end is
                // used only for terminal release, never for a request FIN.
                try {
                  if (!downstreamClosed) client.end()
                  if (!upstreamClosed) upstream?.end()
                } catch { fail(); return }
              }
              if (downstreamClosed && upstreamClosed) {
                terminal = true
                request.stop()
                response?.stop()
                pairs.delete(fail)
              }
            }
            const request = new SocketBrokerWriteQueue(client, fail, reconcile)
            connections.set(client, { request, response: () => response, fail, close() {
              downstreamClosed = true
              request.closeSource()
              if (!request.eof || !response?.finSent) fail()
              else reconcile()
            } })
            pairs.add(fail)
            // Install an owned token before any request callback can run.
            request.push(mapping.token)
            try {
              void Bun.connect({
                hostname: '127.0.0.1', port: mapping.targetPort, allowHalfOpen: true,
                socket: {
                  open(socket) {
                    socket.pause()
                    upstream = socket
                    upstreamPeers.add(socket)
                    if (failed || terminal || downstreamClosed || shuttingDown) { socket.terminate(); return }
                    response = new SocketBrokerWriteQueue(socket, fail, reconcile)
                    response.install(client)
                    request.install(socket)
                  },
                  data(_socket, bytes) { if (!failed && !terminal) response?.push(bytes) },
                  drain() { request.drain() },
                  end() { if (!failed && !terminal) response?.end() },
                  close(socket, ...closeArgs: unknown[]) {
                    upstreamPeers.delete(socket)
                    upstreamClosed = true
                    response?.closeSource()
                    if (failed || terminal) return
                    // CONDITIONAL: root must qualify the exact Bun 1.4.0
                    // 34cbb9a40 executable/source and raw passive FIN route.
                    // Its native read errors arrive here as Error, whereas
                    // local teardown also uses undefined: both need fences.
                    if (shuttingDown || socket !== upstream || closeArgs[0] !== undefined ||
                      !request.finSent || !response) { fail(); return }
                    if (!response.eof) {
                      if (finishing || downstreamClosed) { fail(); return }
                      // Close the source first; retain the response cursor.
                      // Only its eventual drain may send downstream SHUT_WR.
                      response.end()
                    }
                    reconcile()
                  },
                  error() { fail() },
                  connectError() { fail() },
                },
              }).catch(fail)
            } catch { fail() }
          },
          data(client, bytes) {
            const candidate = probePeers.get(client)
            if (candidate) {
              if (candidate.terminal) return
              if (candidate.length + bytes.length > candidate.bytes.length) { rejectCandidate(client); return }
              candidate.bytes.set(bytes, candidate.length)
              candidate.length += bytes.length
            } else connections.get(client)?.request.push(bytes)
          },
          drain(client) { connections.get(client)?.response()?.drain() },
          end(client) {
            const candidate = probePeers.get(client)
            if (candidate) {
              if (candidate.terminal) return
              if (candidate.length === nonce.length && timingSafeEqual(candidate.bytes, nonce)) acceptProof()
              rejectCandidate(client)
            } else connections.get(client)?.request.end()
          },
          close(client) {
            peers.delete(client)
            const candidate = probePeers.get(client)
            if (candidate) { candidate.bytes.fill(0); probePeers.delete(client) }
            const connection = connections.get(client)
            connection?.close()
            connections.delete(client)
          },
          error(client) {
            if (probePeers.has(client)) rejectCandidate(client)
            else connections.get(client)?.fail()
          },
        },
      })
      // Retain native listeners until process-owned termination. Never stop a
      // remembered UDS name that may now belong to a substituted listener.
      listeners.push(server)
      let timeout: ReturnType<typeof setTimeout> | undefined
      let custody: ReturnType<typeof pinSocketBrokerPath> | undefined
      try {
        await hooks.afterBindForTest?.(index, mapping.listenPath)
        const stat = lstatSync(mapping.listenPath)
        if (!stat.isSocket() || (stat.mode & 0o777) !== 0o600 ||
          (process.getuid?.() !== undefined && stat.uid !== process.getuid?.())) throw new Error('Unsafe broker socket')
        custody = pinSocketBrokerPath(mapping.listenPath, stat)
        await hooks.afterFirstStatForTest?.(index, mapping.listenPath)
        // The connected peer must be this process's kernel listener AND this
        // particular accept callback must receive the nonce. Forwarding from a
        // foreign same-UID listener cannot satisfy the kernel credential check.
        const deadline = performance.now() + 5_000
        timeout = setTimeout(() => rejectProof(new Error('Listener ownership proof timed out')), 5_000)
        let proved = false
        try {
          await proveSocketBrokerSelfPeer(custody.probePath, nonce, deadline, accepted)
          proved = true
        } finally {
          await hooks.afterPeerAttemptForTest?.(index, mapping.listenPath, proved)
        }
        const current = lstatSync(mapping.listenPath)
        if (!current.isSocket() || current.dev !== stat.dev || current.ino !== stat.ino ||
          current.mode !== stat.mode || current.uid !== stat.uid || current.gid !== stat.gid) {
          throw new Error('Listener path changed during ownership proof')
        }
        // The admitted inode is still held by O_PATH. The peer proof used its
        // kernel magic link, so matching observations of a foreign F cannot be
        // combined with a nonce route through a temporarily restored original A.
        writeSync(1, `${JSON.stringify({ schemaVersion: 2, kind: 'bound', index, device: stat.dev, inode: stat.ino })}\n`)
      } finally {
        proving = false
        if (custody) closeSync(custody.fd)
        clearTimeout(timeout)
        for (const socket of probePeers.keys()) rejectCandidate(socket)
        nonce.fill(0)
      }
    }
    writeSync(1, '{"schemaVersion":2,"kind":"ready"}\n')
  } catch {
    terminate()
  }
  return await new Promise<never>(() => undefined)
}
