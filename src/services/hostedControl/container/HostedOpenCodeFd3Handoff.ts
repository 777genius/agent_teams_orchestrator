import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import path from 'node:path'

const SHA = /^[0-9a-f]{64}$/
const CHALLENGE = /^[0-9a-f]{64}$/
const SOCKET_NAME = /^[a-z0-9][a-z0-9_-]{7,95}\.sock$/
const ACCEPTED = '{"version":1,"kind":"accepted"}\n'
const DEADLINE_MS = 5_000

export type PendingOwnerChannel = Readonly<{ socketPath: string; challenge: string }>
export type HostedFd3HandoffInput = Readonly<{
  operationId: string
  containerId: string
  handle: string
  generation: string
  networkId: string
  pid: number
  startTicks: string
  netns: string
  ownerChannel: PendingOwnerChannel
}>

export interface HostedFd3HandoffRunner {
  run(input: HostedFd3HandoffInput): Promise<void>
}

/** Root-owned, pinned helper. A zero exit is only one gate; the supervisor reattests independently. */
export class HostedOpenCodeFd3Handoff implements HostedFd3HandoffRunner {
  constructor(private readonly options: Readonly<{
    helperPath: string
    helperSha256: string
    pythonSha256: string
    ownerSocketDirectory: string
    ownerUid: number
  }>) {}

  async verify(): Promise<void> {
    const { helperPath, helperSha256, pythonSha256, ownerSocketDirectory, ownerUid } = this.options
    if (!path.isAbsolute(helperPath) || !SHA.test(helperSha256) || !SHA.test(pythonSha256) ||
      !path.isAbsolute(ownerSocketDirectory) || !Number.isSafeInteger(ownerUid) || ownerUid < 1) {
      throw new Error('hosted-fd3-policy-invalid')
    }
    const [helper, helperParent, ownerParent] = await Promise.all([
      lstat(helperPath), lstat(path.dirname(helperPath)), lstat(ownerSocketDirectory),
    ])
    if (!helper.isFile() || helper.isSymbolicLink() || helper.nlink !== 1 || helper.uid !== 0 ||
      (helper.mode & 0o022) !== 0 || !helperParent.isDirectory() || helperParent.isSymbolicLink() ||
      helperParent.uid !== 0 || (helperParent.mode & 0o022) !== 0 ||
      !ownerParent.isDirectory() || ownerParent.isSymbolicLink() || ownerParent.uid !== ownerUid ||
      (ownerParent.mode & 0o777) !== 0o700 ||
      await realpath(helperPath) !== helperPath || await realpath(ownerSocketDirectory) !== ownerSocketDirectory) {
      throw new Error('hosted-fd3-file-policy-invalid')
    }
    const file = await open(helperPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await file.stat()
      if (!before.isFile() || before.size < 1 || before.size > 65_536 || before.uid !== 0 ||
        before.dev !== helper.dev || before.ino !== helper.ino ||
        createHash('sha256').update(await file.readFile()).digest('hex') !== helperSha256) {
        throw new Error('hosted-fd3-helper-digest-invalid')
      }
      const after = await file.stat()
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error('hosted-fd3-helper-substituted')
      }
    } finally { await file.close() }
    // The script's shebang selects this interpreter. Pin its resolved executable bytes too.
    const pythonPath = await realpath('/usr/bin/python3')
    const python = await lstat(pythonPath)
    if (!python.isFile() || python.isSymbolicLink() || python.uid !== 0 ||
      (python.mode & 0o022) !== 0 || python.size < 1 || python.size > 64 * 1024 * 1024) {
      throw new Error('hosted-fd3-python-policy-invalid')
    }
    const interpreter = await open(pythonPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await interpreter.stat()
      if (before.dev !== python.dev || before.ino !== python.ino ||
        createHash('sha256').update(await interpreter.readFile()).digest('hex') !== pythonSha256) {
        throw new Error('hosted-fd3-python-digest-invalid')
      }
      const after = await interpreter.stat()
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error('hosted-fd3-python-substituted')
      }
    } finally { await interpreter.close() }
  }

  async run(input: HostedFd3HandoffInput): Promise<void> {
    await this.verify()
    const { socketPath, challenge } = input.ownerChannel
    if (!CHALLENGE.test(challenge) || path.dirname(socketPath) !== this.options.ownerSocketDirectory ||
      !SOCKET_NAME.test(path.basename(socketPath))) throw new Error('hosted-fd3-owner-channel-invalid')
    const socketStat = await lstat(socketPath)
    if (!socketStat.isSocket() || socketStat.isSymbolicLink() || socketStat.uid !== this.options.ownerUid ||
      (socketStat.mode & 0o777) !== 0o600) throw new Error('hosted-fd3-owner-socket-invalid')
    const socket = await this.connectPending(socketPath, input)
    try {
      // The helper is the only process receiving this endpoint as FD3. Never retry after spawn.
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.options.helperPath, [
          '--container-id', input.containerId, '--handle', input.handle,
          '--generation', input.generation, '--network-id', input.networkId,
          '--pid', String(input.pid), '--start-ticks', input.startTicks,
          '--netns', input.netns, '--binary-sha256',
          '513f500a1a5ea1dc7d865547ac87b32a8936334e8d5abd5b3ff585c45a170080',
        ], {
          stdio: ['ignore', 'ignore', 'ignore', socket],
          env: { PATH: '/usr/bin:/bin', HOME: '/root' },
          timeout: 20_000,
          windowsHide: true,
        })
        // The child inherits a duplicate. Retaining this copy would undermine EOF/revocation.
        socket.destroy()
        child.once('error', () => reject(new Error('hosted-fd3-helper-uncertain')))
        child.once('close', (code, signal) => code === 0 && signal === null
          ? resolve() : reject(new Error('hosted-fd3-helper-uncertain')))
      })
    } finally { socket.destroy() }
  }

  private async connectPending(socketPath: string, input: HostedFd3HandoffInput): Promise<Socket> {
    const socket = connect(socketPath)
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('hosted-fd3-owner-handshake-timeout')), DEADLINE_MS)
        const cleanup = () => { clearTimeout(timer); socket.off('connect', connected); socket.off('error', failed) }
        const connected = () => { cleanup(); resolve() }
        const failed = () => { cleanup(); reject(new Error('hosted-fd3-owner-connect-failed')) }
        socket.once('connect', connected); socket.once('error', failed)
      })
      const hello = JSON.stringify({ version: 1, operationId: input.operationId,
        containerGeneration: input.generation, challenge: input.ownerChannel.challenge }) + '\n'
      await new Promise<void>((resolve, reject) => socket.write(hello, error => error ? reject(error) : resolve()))
      await new Promise<void>((resolve, reject) => {
        let bytes = ''
        const timer = setTimeout(() => fail(), DEADLINE_MS)
        const cleanup = () => { clearTimeout(timer); socket.off('data', data); socket.off('end', fail); socket.off('error', fail) }
        const fail = () => { cleanup(); reject(new Error('hosted-fd3-owner-handshake-invalid')) }
        const data = (part: Buffer) => {
          bytes += part.toString('utf8')
          if (bytes.length > ACCEPTED.length || !ACCEPTED.startsWith(bytes)) return fail()
          if (bytes === ACCEPTED) { cleanup(); socket.pause(); resolve() }
        }
        socket.on('data', data); socket.once('end', fail); socket.once('error', fail)
      })
      return socket
    } catch (error) { socket.destroy(); throw error }
  }
}
