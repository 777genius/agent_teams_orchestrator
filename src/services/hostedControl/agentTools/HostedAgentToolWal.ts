import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { writeFileAtomic } from '../../../utils/atomicWrite.js'
import * as lockfile from '../../../utils/lockfile.js'
import { fsyncFileAndParent } from '../HostedTaskMutationWal.js'
import { validateHostedAgentToolResult, type HostedAgentToolRequest } from './HostedAgentToolContract.js'

// JSON can expand each result byte to a six-byte Unicode escape.
const MAX_RECORD_BYTES = 512 * 1024
const LOCK_OPTIONS = { realpath: false, retries: { retries: 50, minTimeout: 5, maxTimeout: 100 } } as const

/** All fields come from a current Owner admission, never from the tool frame. */
export type HostedAgentToolBinding = {
  workspaceId: string
  teamId: string
  workspaceRoot: string
  planGeneration: string
  runId: string
  laneId: string
  memberName: string
  sessionID: string
}

type Intent = {
  schemaVersion: 1
  status: 'intent'
  callID: string
  binding: HostedAgentToolBinding
  fingerprint: string
}
type Terminal = Omit<Intent, 'status'> & { status: 'terminal'; result: string }
type RecordState = Intent | Terminal

export type HostedAgentToolBeginDecision =
  | { kind: 'admitted' }
  | { kind: 'replay'; result: string }
  | { kind: 'operator_required' | 'conflict' }

/** An unresolved durable intent is ambiguous and is never automatically reissued. */
export class HostedAgentToolWal {
  readonly #anchorPath: string
  #directoryIdentity: { dev: string; ino: string } | null = null
  #initialization: Promise<void> | null = null

  constructor(private readonly directory: string) {
    if (!isAbsolute(directory) || directory.includes('\0')) {
      throw new TypeError('Hosted agent tool WAL directory must be absolute')
    }
    this.#anchorPath = join(dirname(directory), `${basename(directory)}.anchor.v1.json`)
  }

  async begin(input: {
    binding: HostedAgentToolBinding
    request: HostedAgentToolRequest
  }): Promise<HostedAgentToolBeginDecision> {
    const fingerprint = fingerprintHostedAgentToolCall(input.binding, input.request)
    const file = await this.#recordPath(input.binding.teamId, input.request.context.callID)
    const release = await lockfile.lock(file, LOCK_OPTIONS)
    try {
      await this.#assertDirectory()
      const prior = await this.#read(file)
      await this.#assertDirectory()
      if (prior) {
        if (prior.callID !== input.request.context.callID || prior.fingerprint !== fingerprint ||
          !sameBinding(prior.binding, input.binding)) return { kind: 'conflict' }
        return prior.status === 'terminal'
          ? { kind: 'replay', result: prior.result }
          : { kind: 'operator_required' }
      }
      await this.#write(file, { schemaVersion: 1, status: 'intent',
        callID: input.request.context.callID, binding: input.binding, fingerprint })
      await this.#assertDirectory()
      return { kind: 'admitted' }
    } finally {
      await release()
    }
  }

  async complete(input: {
    binding: HostedAgentToolBinding
    request: HostedAgentToolRequest
    result: string
  }): Promise<'completed' | 'replay' | 'conflict'> {
    const result = validateHostedAgentToolResult(input.result)
    const fingerprint = fingerprintHostedAgentToolCall(input.binding, input.request)
    const file = await this.#recordPath(input.binding.teamId, input.request.context.callID)
    const release = await lockfile.lock(file, LOCK_OPTIONS)
    try {
      await this.#assertDirectory()
      const prior = await this.#read(file)
      await this.#assertDirectory()
      if (!prior || prior.callID !== input.request.context.callID ||
        prior.fingerprint !== fingerprint || !sameBinding(prior.binding, input.binding)) return 'conflict'
      if (prior.status === 'terminal') return prior.result === result ? 'replay' : 'conflict'
      await this.#write(file, { ...prior, status: 'terminal', result })
      await this.#assertDirectory()
      return 'completed'
    } finally {
      await release()
    }
  }

  async #recordPath(teamId: string, callID: string): Promise<string> {
    await this.#assertDirectory()
    const key = sha(JSON.stringify(['agent-teams.hosted-agent-tool-call/v1', teamId, callID]))
    return join(this.directory, `${key}.json`)
  }

  async #assertDirectory(): Promise<void> {
    this.#initialization ??= this.#initializeDirectory()
    await this.#initialization
    await this.#verifyDirectory()
  }

  async #assertParent(): Promise<void> {
    const parent = dirname(this.directory)
    const parentStat = await lstat(parent)
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() ||
      await realpath(parent) !== parent || (parentStat.mode & 0o077) !== 0 ||
      (process.getuid?.() !== undefined && parentStat.uid !== process.getuid())) {
      throw new Error('Unsafe hosted agent tool WAL parent')
    }
  }

  async #initializeDirectory(): Promise<void> {
    await this.#assertParent()
    // All instances and Owner processes share this parent lock until both
    // mkdir and anchor publication have been synced to the parent directory.
    const release = await lockfile.lock(this.#anchorPath, LOCK_OPTIONS)
    try {
      await this.#assertParent()
      const parent = dirname(this.directory)
      const anchor = await this.#readAnchor()
      if (!anchor) {
        try {
          await mkdir(this.directory, { mode: 0o700 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error('Hosted agent tool WAL directory exists without its durable anchor')
          }
          throw error
        }
        // The leaf directory must survive a crash before an intent can be admitted.
        await syncDirectory(parent)
        const identity = await this.#readDirectoryIdentity()
        const handle = await open(this.#anchorPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)
        try {
          await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, ...identity })}\n`)
          await handle.sync()
        } finally {
          await handle.close()
        }
        await syncDirectory(parent)
      }
      await this.#verifyDirectory()
    } finally {
      await release()
    }
  }

  async #readDirectoryIdentity(): Promise<{ dev: string; ino: string }> {
    const [stat, canonical] = await Promise.all([lstat(this.directory), realpath(this.directory)])
    if (!stat.isDirectory() || stat.isSymbolicLink() || canonical !== this.directory ||
      (stat.mode & 0o777) !== 0o700 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid())) {
      throw new Error('Unsafe hosted agent tool WAL directory')
    }
    return { dev: String(stat.dev), ino: String(stat.ino) }
  }

  async #verifyDirectory(): Promise<void> {
    await this.#assertParent()
    const anchor = await this.#readAnchor()
    if (!anchor) throw new Error('Hosted agent tool WAL durable anchor is missing')
    const identity = await this.#readDirectoryIdentity()
    if (anchor.dev !== identity.dev || anchor.ino !== identity.ino ||
      this.#directoryIdentity &&
      (this.#directoryIdentity.dev !== identity.dev || this.#directoryIdentity.ino !== identity.ino)) {
      throw new Error('Hosted agent tool WAL directory was replaced')
    }
    this.#directoryIdentity = identity
  }

  async #readAnchor(): Promise<{ dev: string; ino: string } | null> {
    const handle = await open(this.#anchorPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!handle) return null
    try {
      const [stat, current, canonical] = await Promise.all([
        handle.stat(), lstat(this.#anchorPath), realpath(this.#anchorPath),
      ])
      if (!stat.isFile() || !current.isFile() || current.isSymbolicLink() ||
        stat.dev !== current.dev || stat.ino !== current.ino || canonical !== this.#anchorPath ||
        (stat.mode & 0o777) !== 0o600 || stat.size < 2 || stat.size > 256 ||
        (process.getuid?.() !== undefined && stat.uid !== process.getuid())) {
        throw new Error('Unsafe hosted agent tool WAL anchor')
      }
      const value: unknown = JSON.parse(await handle.readFile('utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid hosted agent tool WAL anchor')
      const record = value as Record<string, unknown>
      if (Object.keys(record).length !== 3 || record.schemaVersion !== 1 ||
        typeof record.dev !== 'string' || !/^\d+$/.test(record.dev) ||
        typeof record.ino !== 'string' || !/^\d+$/.test(record.ino)) {
        throw new Error('Invalid hosted agent tool WAL anchor')
      }
      return { dev: record.dev, ino: record.ino }
    } finally {
      await handle.close()
    }
  }

  async #read(file: string): Promise<RecordState | null> {
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!handle) return null
    try {
      const [stat, current, canonical] = await Promise.all([handle.stat(), lstat(file), realpath(file)])
      if (!stat.isFile() || !current.isFile() || current.isSymbolicLink() ||
        stat.dev !== current.dev || stat.ino !== current.ino || canonical !== file ||
        (stat.mode & 0o777) !== 0o600 || stat.size < 2 || stat.size > MAX_RECORD_BYTES ||
        (process.getuid?.() !== undefined && stat.uid !== process.getuid())) {
        throw new Error('Unsafe hosted agent tool WAL record')
      }
      const raw = await handle.readFile('utf8')
      if (Buffer.byteLength(raw, 'utf8') > MAX_RECORD_BYTES) throw new Error('Oversize hosted agent tool WAL record')
      return decodeRecord(JSON.parse(raw))
    } finally {
      await handle.close()
    }
  }

  async #write(file: string, record: RecordState): Promise<void> {
    const text = `${JSON.stringify(record)}\n`
    if (Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) throw new Error('Oversize hosted agent tool WAL record')
    await this.#assertDirectory()
    await writeFileAtomic(file, text, { mode: 0o600 })
    await fsyncFileAndParent(file)
    await this.#assertDirectory()
  }
}

export function fingerprintHostedAgentToolCall(
  binding: HostedAgentToolBinding,
  request: HostedAgentToolRequest,
): string {
  if (request.context.sessionID !== binding.sessionID) {
    throw new TypeError('Hosted agent tool session does not match Owner binding')
  }
  return sha(JSON.stringify([
    'agent-teams.hosted-agent-tool-fingerprint/v1',
    binding.workspaceId, binding.teamId, binding.workspaceRoot, binding.planGeneration,
    binding.runId, binding.laneId, binding.memberName, binding.sessionID,
    request.context.messageID,
    request.context.callID, request.tool, request.args,
  ]))
}

function decodeRecord(value: unknown): RecordState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid hosted agent tool WAL record')
  const record = value as Record<string, unknown>
  const terminal = record.status === 'terminal'
  const keys = ['schemaVersion', 'status', 'callID', 'binding', 'fingerprint', ...(terminal ? ['result'] : [])]
  if (Object.keys(record).length !== keys.length || Object.keys(record).some(key => !keys.includes(key)) ||
    record.schemaVersion !== 1 || (record.status !== 'intent' && record.status !== 'terminal') ||
    typeof record.callID !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(record.callID) ||
    typeof record.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(record.fingerprint)) {
    throw new Error('Invalid hosted agent tool WAL record')
  }
  if (terminal) validateHostedAgentToolResult(record.result)
  const binding = record.binding
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new Error('Invalid hosted agent tool WAL binding')
  const b = binding as Record<string, unknown>
  const bindingKeys = ['workspaceId', 'teamId', 'workspaceRoot', 'planGeneration', 'runId', 'laneId', 'memberName', 'sessionID']
  if (Object.keys(b).length !== bindingKeys.length || Object.keys(b).some(key => !bindingKeys.includes(key)) ||
    bindingKeys.some(key => typeof b[key] !== 'string') || !isAbsolute(b.workspaceRoot as string) ||
    !/^plan-generation_[0-9a-f]{64}$/.test(b.planGeneration as string)) {
    throw new Error('Invalid hosted agent tool WAL binding')
  }
  return record as RecordState
}

function sameBinding(left: HostedAgentToolBinding, right: HostedAgentToolBinding): boolean {
  return left.workspaceId === right.workspaceId && left.teamId === right.teamId &&
    left.workspaceRoot === right.workspaceRoot && left.planGeneration === right.planGeneration &&
    left.runId === right.runId && left.laneId === right.laneId &&
    left.memberName === right.memberName && left.sessionID === right.sessionID
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
  try { await handle.sync() } finally { await handle.close() }
}
