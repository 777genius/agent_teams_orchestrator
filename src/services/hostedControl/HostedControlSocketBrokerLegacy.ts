import { fstatSync, readFileSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'

export const HOSTED_CONTROL_SOCKET_BROKER_FLAG = '--hosted-control-socket-broker'

/** The historical flag selects legacy only with the accepted two-argument shape.
 * This never inspects FD3 and never retries a failed native invocation. */
export function isHostedControlSocketBrokerLegacyArgs(args: readonly string[]): boolean {
  const [socketPath, targetPortRaw] = args
  const targetPort = Number(targetPortRaw)
  return args.length === 2 && !!socketPath && Number.isInteger(targetPort) &&
    targetPort >= 1 && targetPort <= 65535
}

/**
 * Runs the isolated process that owns the temporary UDS binding. The owner
 * removes that temporary pathname after publishing its inode at the canonical
 * path. This process must therefore die without invoking Server.close(): Bun
 * >=1.3.12 otherwise unlinks its remembered pathname even when another server
 * has rebound that name.
 */
export async function runHostedControlSocketBrokerLegacy(args: string[]): Promise<never> {
  const [socketPath, targetPortRaw] = args
  const targetPort = Number(targetPortRaw)
  if (args.length !== 2 || !socketPath || !Number.isInteger(targetPort) ||
    targetPort < 1 || targetPort > 65535) {
    throw new Error('Invalid hosted control socket broker arguments')
  }
  let expectedToken: Buffer
  try {
    if (!fstatSync(3).isSocket()) {
      throw new Error('Credential descriptor is not an inherited pipe')
    }
    expectedToken = readFileSync(3)
  } catch {
    throw new Error('Hosted control socket broker credential pipe is unavailable')
  }
  if (expectedToken.byteLength !== 32) {
    throw new Error('Hosted control socket broker credential is invalid')
  }

  const peers = new Set<Socket>()
  let shuttingDown = false
  const terminate = () => {
    if (shuttingDown) return
    shuttingDown = true
    for (const peer of peers) peer.destroy()
    process.kill(process.pid, 'SIGKILL')
  }
  process.stdin.resume()
  process.stdin.once('end', terminate)
  process.stdin.once('error', terminate)
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'] as const) {
    process.once(signal, terminate)
  }
  process.once('uncaughtException', terminate)
  process.once('unhandledRejection', terminate)

  process.umask(0o177)
  const server = createServer(client => {
    if (shuttingDown) { client.destroy(); return }
    const upstream = connect({ host: '127.0.0.1', port: targetPort })
    peers.add(client)
    peers.add(upstream)
    const cleanup = () => { peers.delete(client); peers.delete(upstream) }
    client.once('close', cleanup)
    upstream.once('close', cleanup)
    client.once('error', () => upstream.destroy())
    upstream.once('error', () => client.destroy())
    // Queue the credential before this paused socket can forward client bytes.
    // Waiting for connect loses an early FIN on Bun.
    upstream.write(expectedToken)
    client.pipe(upstream)
    upstream.pipe(client)
  })
  server.once('error', terminate)
  server.once('listening', () => {
    process.stdout.write('{"schemaVersion":1,"kind":"ready"}\n')
  })
  server.listen(socketPath)
  return await new Promise<never>(() => undefined)
}
