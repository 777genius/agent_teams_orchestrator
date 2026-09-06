import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { lstatSync, type Stats } from 'node:fs'
import { constants, chmod, link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { connect, type Server, type Socket } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { HOSTED_CONTROL_SOCKET_BROKER_FLAG } from './HostedControlSocketBroker.js'
import type { HostedControlOwnerBinding } from './protocol.js'
const HOSTED_CONTROL_READ_DEADLINE_MS = 5_000

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
  server.listen({ host: '127.0.0.1', port: 0, exclusive: true })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error) }
    const onListening = () => { server.off('error', onError); resolve() }
    server.once('error', onError)
    server.once('listening', onListening)
  })
}

export async function startSocketBroker(
  listenPath: string,
  targetPort: number,
  token: Buffer,
): Promise<ChildProcess> {
  const brokerArgs = [HOSTED_CONTROL_SOCKET_BROKER_FLAG, listenPath, String(targetPort)]
  const isCompiledBinary = Array.isArray(Bun.embeddedFiles) && Bun.embeddedFiles.length > 0
  if (!isCompiledBinary) {
    const entrypoint = process.argv[1]
    if (!entrypoint) throw new Error('Hosted control socket broker entrypoint is unavailable')
    if (entrypoint.endsWith('.test.ts')) {
      brokerArgs.splice(0, 1,
        new URL('./fixtures/hostedControlSocketBrokerChild.ts', import.meta.url).pathname)
    } else {
      brokerArgs.unshift(entrypoint)
    }
  }
  const broker = spawn(process.execPath, brokerArgs, {
    stdio: ['pipe', 'pipe', 'inherit', 'pipe'],
  })
  const tokenPipe = broker.stdio[3]
  if (!broker.stdin || !broker.stdout || !tokenPipe || !('write' in tokenPipe)) {
    broker.kill('SIGKILL')
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
    tokenPipe.end(token)
  }).catch(async error => {
    await killSocketBroker(broker)
    throw error
  })
  return broker
}

export async function killSocketBroker(broker: ChildProcess): Promise<void> {
  if (broker.exitCode !== null || broker.signalCode !== null) return
  const exited = new Promise<void>(resolve => broker.once('exit', () => resolve()))
  broker.kill('SIGKILL')
  await exited
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
  await chmod(parent, 0o700)
  const handle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)); const stat = await handle.stat(); await handle.close()
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
