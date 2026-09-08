import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { lstatSync, type Stats } from 'node:fs'
import { constants, link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { connect, type Server, type Socket } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { HOSTED_CONTROL_SOCKET_BROKER_FLAG, encodeSocketBrokerBatch,
  type SocketBrokerIdentity, type SocketBrokerMapping } from './HostedControlSocketBroker.js'
import type { HostedControlOwnerBinding } from './protocol.js'
const HOSTED_CONTROL_READ_DEADLINE_MS = 5_000
const brokerClosures = new WeakMap<ChildProcess, Promise<void>>()

export type SocketBrokerLaunchForTest = {
  pressureNotificationPipe?: boolean
  afterSpawn?: (broker: ChildProcess) => void
  entrypoint?: string
}

export function isSocketIdentityCurrentSync(
  socketPath: string,
  ownerBinding: HostedControlOwnerBinding,
  parentIdentity: { device: number; inode: number },
): boolean {
  try {
    const socketStat = lstatSync(socketPath)
    const parentStat = lstatSync(dirname(socketPath))
    return socketStat.isSocket() && (socketStat.mode & 0o077) === 0 &&
      (process.getuid?.() === undefined || socketStat.uid === process.getuid?.()) &&
      parentStat.isDirectory() && !parentStat.isSymbolicLink() &&
      String(socketStat.dev) === ownerBinding.socketIdentity.device &&
      String(socketStat.ino) === ownerBinding.socketIdentity.inode &&
      socketStat.uid === ownerBinding.socketIdentity.uid &&
      socketStat.gid === ownerBinding.socketIdentity.gid &&
      (socketStat.mode & 0o777) === ownerBinding.socketIdentity.mode &&
      parentStat.dev === parentIdentity.device && parentStat.ino === parentIdentity.inode
  } catch {
    return false
  }
}

export type PublicationProbe = {
  nonce: Buffer
  resolve(): void
  reject(error: unknown): void
}

export function socketPublicationPath(socketPath: string): string {
  const parent = dirname(socketPath)
  const publishedName = basename(socketPath)
  const nameBytes = Buffer.byteLength(publishedName)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidateName = randomBytes(Math.max(1, Math.ceil(nameBytes * 3 / 4)))
      .toString('base64url').slice(0, nameBytes)
    if (candidateName !== publishedName) return join(parent, candidateName)
  }
  throw new Error('Hosted control publication socket name could not be allocated')
}

export async function listenLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      server.off('error', onError)
      server.off('listening', onListening)
      server.off('close', onClose)
      if (error) reject(error); else resolve()
    }
    const onError = (error: Error) => finish(error)
    const onListening = () => finish()
    const onClose = () => finish(new Error('Hosted control loopback target closed during preparation'))
    server.once('error', onError)
    server.once('listening', onListening)
    server.once('close', onClose)
    try { server.listen({ host: '127.0.0.1', port: 0, exclusive: true }) } catch (error) { finish(error as Error) }
  })
}

export type SocketBrokerBorrow = Readonly<{
  pid: number
  identity: SocketBrokerIdentity
  isCurrent(): boolean
  release(): Promise<void>
}>

export type SocketBrokerBatch = Readonly<{
  pid: number
  isCurrent(): boolean
  borrow(index: number, onLoss: () => void): SocketBrokerBorrow
  /** Drop the launch reference after attachment; borrowers retain the child. */
  release(): Promise<void>
}>

/** Current native singleton helper. Legacy composition must select startSocketBrokerLegacy explicitly. */
export async function startSocketBroker(listenPath: string, targetPort: number, token: Buffer): Promise<ChildProcess> {
  const parent = await lstat(dirname(listenPath))
  return (await launchSocketBrokerBatch([{ listenPath: resolve(listenPath), targetPort, token,
    parentIdentity: { device: parent.dev, inode: parent.ino } }])).broker
}

/** Explicit historical argv/raw32/schema1 transport. Never called by native batch. */
export async function startSocketBrokerLegacy(
  listenPath: string,
  targetPort: number,
  token: Buffer,
  forTest?: SocketBrokerLaunchForTest,
): Promise<ChildProcess> {
  const brokerArgs = [HOSTED_CONTROL_SOCKET_BROKER_FLAG, listenPath, String(targetPort)]
  const isCompiledBinary = Array.isArray(Bun.embeddedFiles) && Bun.embeddedFiles.length > 0
  if (!isCompiledBinary) {
    const entrypoint = process.argv[1]
    if (!entrypoint) throw new Error('Hosted control socket broker entrypoint is unavailable')
    if (entrypoint.endsWith('.test.ts')) {
      brokerArgs.splice(0, 1,
        new URL('./fixtures/hostedControlSocketBrokerLegacyChild.ts', import.meta.url).pathname)
    } else {
      brokerArgs.unshift(entrypoint)
    }
  }
  if (forTest?.entrypoint) brokerArgs.splice(0, brokerArgs.length, forTest.entrypoint, listenPath, String(targetPort))
  const broker = spawn(process.execPath, brokerArgs, {
    stdio: ['pipe', 'pipe', 'inherit', 'pipe'],
  })
  brokerClosures.set(broker, new Promise<void>(resolve => broker.once('close', () => resolve())))
  broker.on('error', () => undefined)
  broker.stdin?.on('error', () => { broker.kill('SIGKILL') })
  const tokenPipe = broker.stdio[3]
  if (!broker.stdin || !broker.stdout || !tokenPipe || !('write' in tokenPipe)) {
    await killSocketBroker(broker)
    throw new Error('Hosted control socket broker pipes are unavailable')
  }
  await new Promise<void>((resolve, reject) => {
    let bytes = Buffer.alloc(0)
    const timeout = setTimeout(() => finish(new Error('Hosted control socket broker startup timed out')),
      HOSTED_CONTROL_READ_DEADLINE_MS)
    const finish = (error?: Error) => {
      clearTimeout(timeout)
      broker.stdout?.off('data', onData)
      tokenPipe.off('error', onTokenError)
      broker.off('error', onError)
      broker.off('exit', onExit)
      if (error) reject(error); else resolve()
    }
    const onData = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk])
      if (bytes.byteLength > 256) { finish(new Error('Hosted control socket broker response was oversized')); return }
      const newline = bytes.indexOf(0x0a)
      if (newline < 0) return
      if (newline !== bytes.byteLength - 1 || bytes.toString('utf8', 0, newline) !==
        '{"schemaVersion":1,"kind":"ready"}') {
        finish(new Error('Hosted control socket broker response was invalid'))
        return
      }
      finish()
    }
    const onError = () => finish(new Error('Hosted control socket broker failed to start'))
    const onTokenError = () => finish(new Error('Hosted control socket broker credential write failed'))
    const onExit = () => finish(new Error('Hosted control socket broker exited before readiness'))
    broker.stdout.on('data', onData)
    tokenPipe.once('error', onTokenError)
    broker.once('error', onError)
    broker.once('exit', onExit)
    try {
      forTest?.afterSpawn?.(broker)
      tokenPipe.end(token)
    } catch (error) { finish(error as Error) }
  }).catch(async error => {
    await killSocketBroker(broker)
    throw error
  })
  return broker
}

/** A single explicit legacy child; the server owns publication and inode cleanup.
 * Schema1 has no native custody claim. Identity admission matches accepted 3bf. */
export async function startLegacySocketBroker(
  mapping: SocketBrokerMapping,
  onLoss: () => void,
  forTest?: Pick<SocketBrokerLaunchForTest, 'afterSpawn'>,
): Promise<SocketBrokerBorrow> {
  const broker = await startSocketBrokerLegacy(mapping.listenPath, mapping.targetPort, mapping.token, forTest)
  let lost = false
  let released: Promise<void> | null = null
  const current = () => !lost && !released && broker.exitCode === null && broker.signalCode === null
  const notify = () => {
    if (lost) return
    lost = true
    onLoss()
  }
  try {
    const stat = await lstat(mapping.listenPath)
    if (!stat.isSocket() || (stat.mode & 0o777) !== 0o600 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid?.())) {
      throw new Error('Hosted control publication socket is not privately owned')
    }
    if (!current()) throw new Error('Hosted control socket broker exited before attachment')
    broker.once('exit', notify)
    broker.once('error', notify)
    return Object.freeze({
      pid: broker.pid!,
      identity: Object.freeze({ device: stat.dev, inode: stat.ino }),
      isCurrent: current,
      release(): Promise<void> {
        if (released) return released
        lost = true
        broker.off('exit', notify)
        broker.off('error', notify)
        released = killSocketBroker(broker)
        return released
      },
    })
  } catch (error) {
    await killSocketBroker(broker)
    throw error
  }
}

/** Owns only this batch's child and hidden paths, never a caller's credentials,
 * server, canonical publication, bootstrap, guard, or capture descriptors. */
export async function startSocketBrokerBatch(mappings: readonly SocketBrokerMapping[], forTest?: SocketBrokerLaunchForTest): Promise<SocketBrokerBatch> {
  if (mappings.length !== 1 && mappings.length !== 2) throw new Error('Invalid hosted control broker batch count')
  // Snapshot metadata before the first await; callers cannot retarget cleanup.
  const launch = mappings.map(mapping => ({ ...mapping, parentIdentity: { ...mapping.parentIdentity } }))
  const retained = launch.map(({ listenPath, parentIdentity }) => ({ listenPath, parentIdentity }))
  const { broker, identities } = await launchSocketBrokerBatch(launch, forTest)
  let references = 1
  let ownerReleased = false
  let lost = false
  let drain: Promise<void> | null = null
  const borrowed = new Set<number>()
  const lossListeners = new Map<number, () => void>()
  const current = () => !lost && references > 0 && broker.exitCode === null && broker.signalCode === null
  const onLoss = () => {
    if (lost) return
    lost = true
    for (const notify of lossListeners.values()) { try { notify() } catch {} }
  }
  broker.once('exit', onLoss)
  broker.once('error', onLoss)
  const releaseReference = (): Promise<void> => {
    references -= 1
    if (references !== 0) return Promise.resolve()
    drain = (async () => {
      await killSocketBroker(broker)
      await Promise.allSettled(retained.map((mapping, index) => removeOwnedSocketPathIfCurrent(
        mapping.listenPath, identities[index]!, mapping.parentIdentity,
      )))
      broker.off('exit', onLoss)
      broker.off('error', onLoss)
    })()
    return drain
  }
  const batch: SocketBrokerBatch = Object.freeze({
    pid: broker.pid!, isCurrent: current,
    borrow(index: number, notify: () => void): SocketBrokerBorrow {
      if (ownerReleased || !current() || !Number.isInteger(index) || index < 0 || index >= retained.length || borrowed.has(index)) {
        throw new Error('Hosted control socket broker borrow is unavailable')
      }
      borrowed.add(index)
      references += 1
      lossListeners.set(index, notify)
      let released: Promise<void> | null = null
      return Object.freeze({ pid: broker.pid!, identity: Object.freeze({ ...identities[index]! }),
        isCurrent: () => !released && current(),
        release(): Promise<void> {
          if (released) return released
          lossListeners.delete(index)
          released = releaseReference()
          return released
        },
      })
    },
    release(): Promise<void> {
      if (ownerReleased) return drain ?? Promise.resolve()
      ownerReleased = true
      return releaseReference()
    },
  })
  if (!current()) {
    await batch.release()
    throw new Error('Hosted control socket broker exited before attachment')
  }
  return batch
}

async function launchSocketBrokerBatch(mappings: readonly SocketBrokerMapping[], forTest?: SocketBrokerLaunchForTest): Promise<{
  broker: ChildProcess; identities: SocketBrokerIdentity[]
}> {
  const payload = encodeSocketBrokerBatch(mappings)
  const brokerArgs = [HOSTED_CONTROL_SOCKET_BROKER_FLAG]
  const isCompiledBinary = Array.isArray(Bun.embeddedFiles) && Bun.embeddedFiles.length > 0
  if (!isCompiledBinary) {
    const entrypoint = process.argv[1]
    if (!entrypoint) { payload.fill(0); throw new Error('Hosted control socket broker entrypoint is unavailable') }
    if (entrypoint.endsWith('.test.ts')) {
      brokerArgs.splice(0, 1,
        new URL('./fixtures/hostedControlSocketBrokerChild.ts', import.meta.url).pathname)
    } else {
      brokerArgs.unshift(entrypoint)
    }
  }
  if (forTest?.entrypoint) brokerArgs.splice(0, brokerArgs.length, forTest.entrypoint)
  let broker: ChildProcess
  try {
    broker = spawn(process.execPath, brokerArgs, { stdio: forTest?.pressureNotificationPipe
      ? ['pipe', 'pipe', 'inherit', 'pipe', 'pipe']
      : ['pipe', 'pipe', 'inherit', 'pipe'] })
  } catch (error) { payload.fill(0); throw error }
  // On failure wait for close, not just exit, so every bound record is drained.
  const closed = new Promise<void>(resolve => broker.once('close', () => resolve()))
  brokerClosures.set(broker, closed)
  broker.on('error', () => undefined)
  const identities: SocketBrokerIdentity[] = []
  const tokenPipe = broker.stdio[3]
  if (!broker.stdin || !broker.stdout || !tokenPipe || !('write' in tokenPipe)) {
    payload.fill(0)
    await killSocketBroker(broker)
    await closed
    throw new Error('Hosted control socket broker pipes are unavailable')
  }
  // A broken liveness pipe must not become an unhandled parent-process error.
  broker.stdin.on('error', () => { broker.kill('SIGKILL') })
  const stdout = broker.stdout
  let bytes = Buffer.alloc(0)
  let totalBytes = 0
  let ready = false
  let finish!: (error?: Error) => void
  const onData = (chunk: Buffer) => {
    totalBytes += chunk.length
    if (totalBytes > 1024) { finish(new Error('Hosted control socket broker response was oversized')); return }
    bytes = Buffer.concat([bytes, chunk])
    let newline: number
    while ((newline = bytes.indexOf(0x0a)) >= 0) {
      const line = bytes.subarray(0, newline).toString('utf8')
      bytes = bytes.subarray(newline + 1)
      try {
        const message = JSON.parse(line)
        if (ready || message.schemaVersion !== 2) throw new Error()
        if (message.kind === 'bound' && message.index === identities.length && identities.length < mappings.length &&
          Object.keys(message).join(',') === 'schemaVersion,kind,index,device,inode' &&
          Number.isSafeInteger(message.device) && message.device >= 0 && Number.isSafeInteger(message.inode) && message.inode > 0 &&
          !identities.some(identity => identity.device === message.device && identity.inode === message.inode)) {
          identities.push({ device: message.device, inode: message.inode })
        } else if (line === '{"schemaVersion":2,"kind":"ready"}' && identities.length === mappings.length && bytes.length === 0) {
          ready = true
          finish()
        } else throw new Error()
      } catch { finish(new Error('Hosted control socket broker response was invalid')); return }
    }
  }
  const onError = () => finish(new Error('Hosted control socket broker failed to start'))
  const onTokenError = () => finish(new Error('Hosted control socket broker private batch write failed'))
  const onClose = () => finish(new Error('Hosted control socket broker exited before readiness'))
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      finish = (error?: Error) => {
        if (settled) return
        settled = true
        if (error) reject(error); else resolve()
      }
      timeout = setTimeout(() => finish(new Error('Hosted control socket broker startup timed out')), HOSTED_CONTROL_READ_DEADLINE_MS)
      stdout.on('data', onData)
      tokenPipe.on('error', onTokenError)
      broker.on('error', onError)
      broker.once('close', onClose)
      forTest?.afterSpawn?.(broker)
      tokenPipe.end(payload, () => payload.fill(0))
    })
    return { broker, identities }
  } catch (error) {
    await killSocketBroker(broker)
    await closed
    await Promise.allSettled(identities.map((identity, index) => removeOwnedSocketPathIfCurrent(
      mappings[index]!.listenPath, identity, mappings[index]!.parentIdentity,
    )))
    throw error
  } finally {
    clearTimeout(timeout)
    payload.fill(0)
    stdout.off('data', onData)
    // Retain a harmless error listener until the private pipe is fully closed.
    tokenPipe.off('error', onTokenError)
    tokenPipe.on('error', () => undefined)
    broker.off('error', onError)
    broker.off('close', onClose)
  }
}

export async function killSocketBroker(broker: ChildProcess): Promise<void> {
  let closed = brokerClosures.get(broker)
  if (!closed) {
    // Historical callers may supply their own ChildProcess. A terminal child
    // with every pipe closed has already delivered (or queued) final close.
    if ((broker.exitCode !== null || broker.signalCode !== null) &&
      broker.stdio.every(stream => !stream || ('closed' in stream && stream.closed))) return
    closed = new Promise<void>(resolve => broker.once('close', () => resolve()))
    brokerClosures.set(broker, closed)
  }
  if (broker.pid && broker.exitCode === null && broker.signalCode === null) broker.kill('SIGKILL')
  await closed
}

export async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
}

export async function proveSocketPathIsServerOwned(
  socketPath: string,
  arm: (probe: PublicationProbe) => void,
): Promise<void> {
  const nonce = randomBytes(32)
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const accepted = new Promise<void>((accept, decline) => { resolve = accept; reject = decline })
  arm({ nonce, resolve, reject })
  const client = connect(socketPath)
  const timeout = setTimeout(() => reject(
    new Error('Hosted control publication ownership proof timed out'),
  ), HOSTED_CONTROL_READ_DEADLINE_MS)
  client.once('error', reject)
  client.end(nonce)
  await accepted.finally(() => {
    clearTimeout(timeout)
    client.destroy()
  })
}

export function consumePublicationProbe(socket: Socket, probe: PublicationProbe, initialData = Buffer.alloc(0)): void {
  let bytes = Buffer.from(initialData)
  socket.setTimeout(HOSTED_CONTROL_READ_DEADLINE_MS, () => {
    socket.destroy()
    probe.reject(new Error('Hosted control publication ownership proof timed out'))
  })
  socket.on('data', chunk => {
    bytes = Buffer.concat([bytes, chunk])
    if (bytes.byteLength > probe.nonce.byteLength) {
      socket.destroy()
      probe.reject(new Error('Hosted control publication ownership proof was invalid'))
    }
  })
  socket.once('end', () => {
    socket.destroy()
    if (bytes.byteLength === probe.nonce.byteLength && timingSafeEqual(bytes, probe.nonce)) probe.resolve()
    else probe.reject(new Error('Hosted control publication ownership proof was invalid'))
  })
  socket.once('error', probe.reject)
}

export function sameSocketIdentity(
  stat: Stats,
  expected: { device: number; inode: number },
): boolean {
  return stat.isSocket() && stat.dev === expected.device && stat.ino === expected.inode
}

export async function prepareSocketPath(socketPath: string): Promise<{ device: number; inode: number }> {
  const parent = dirname(socketPath)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const handle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0))
  let stat: Stats
  try {
    stat = await handle.stat()
    if (!stat.isDirectory() || (process.getuid?.() !== undefined && stat.uid !== process.getuid?.())) {
      throw new Error('Hosted control socket parent is not privately owned')
    }
    await handle.chmod(0o700)
    const current = await lstat(parent)
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) {
      throw new Error('Hosted control socket parent was substituted')
    }
  } finally { await handle.close() }
  const parentIdentity = { device: stat.dev, inode: stat.ino }
  let existing
  try { existing = await lstat(socketPath) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return parentIdentity
    throw error
  }
  if (!existing.isSocket() || (existing.mode & 0o077) !== 0 ||
    (process.getuid?.() !== undefined && existing.uid !== process.getuid?.())) {
    throw new Error('Refusing to replace an unsafe hosted control socket path')
  }
  if (await socketAcceptsConnections(socketPath)) {
    throw new Error('Refusing to replace an active hosted control socket')
  }
  await removeSocketIfIdentityMatches(socketPath, {
    device: existing.dev, inode: existing.ino,
  }, parentIdentity)
  return parentIdentity
}

async function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(socketPath)
    let settled = false
    const finish = (active: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(active)
    }
    socket.setTimeout(250, () => finish(true))
    socket.once('connect', () => finish(true))
    socket.once('error', error => {
      const code = (error as NodeJS.ErrnoException).code
      finish(code !== 'ECONNREFUSED' && code !== 'ENOENT')
    })
  })
}

export async function removeOwnedSocketPathIfCurrent(
  socketPath: string,
  expected: { device: number; inode: number },
  parentExpected: { device: number; inode: number },
): Promise<void> {
  const [socketStat, parentStat] = await Promise.all([
    lstat(socketPath).catch(() => null),
    lstat(dirname(socketPath)).catch(() => null),
  ])
  if (!socketStat || !parentStat?.isDirectory() || parentStat.isSymbolicLink() ||
    parentStat.dev !== parentExpected.device || parentStat.ino !== parentExpected.inode ||
    !sameSocketIdentity(socketStat, expected)) return
  await removeSocketIfIdentityMatches(socketPath, expected, parentExpected)
}

/** Atomically quarantines the path, then deletes only the admitted inode. */
export async function removeSocketIfIdentityMatches(
  socketPath: string,
  expected: { device: number; inode: number },
  parentExpected: { device: number; inode: number },
): Promise<void> {
  const parent = dirname(socketPath)
  const quarantine = join(parent, `.${basename(socketPath)}.reclaim-${process.pid}-${randomBytes(16).toString('hex')}`)
  const parentBefore = await lstat(parent)
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink() ||
    parentBefore.dev !== parentExpected.device || parentBefore.ino !== parentExpected.inode) {
    throw new Error('Hosted control socket parent was substituted')
  }
  try { await rename(socketPath, quarantine) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const moved = await lstat(quarantine).catch(() => null)
  const parentAfter = await lstat(parent).catch(() => null)
  const movedMatches = !!moved?.isSocket() && moved.dev === expected.device && moved.ino === expected.inode
  const parentMatches = !!parentAfter?.isDirectory() && !parentAfter.isSymbolicLink() &&
    parentAfter.dev === parentExpected.device && parentAfter.ino === parentExpected.inode
  if (!movedMatches || !parentMatches) {
    // Never let restoration overwrite a replacement that appeared after the
    // quarantine rename. A hard link is an atomic no-replace restoration of
    // the exact inode; if the original name is occupied, preserve both names.
    if (parentMatches) {
      await link(quarantine, socketPath).then(
        () => unlink(quarantine),
        () => undefined,
      ).catch(() => undefined)
    }
    throw new Error('Hosted control socket changed during inode-safe removal')
  }
  await unlink(quarantine)
}
