import { createHash, randomUUID } from 'node:crypto'
import { constants, lstat, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import * as lockfile from '../../utils/lockfile.js'
import { writeFileAtomic } from '../../utils/atomicWrite.js'
import { fsyncFileAndParent } from './HostedTaskMutationWal.js'
import { isHostedMessageRecipientName } from './HostedTeamRecipientRoster.js'
import type { HostedControlAuthority } from './protocol.js'
import type {
  HostedMessageDurablePersistencePort,
  HostedMessagePersistenceDecision,
  HostedPersistedMessage,
} from './HostedTeamMessageService.js'

const MAX_RECORD_BYTES = 16 * 1024
const IDEMPOTENCY_KEY_DOMAIN = 'agent-teams.hosted-message.idempotency/v1'
const LOCK_OPTIONS = {
  realpath: false,
  retries: { retries: 10, minTimeout: 5, maxTimeout: 100 },
} as const

type PersistCommand = {
  schemaVersion: 1
  teamId: string
  clientMessageId: string
  text: string
  recipient?: string
}
type DeliveryRequest = {
  teamId: string
  messageId: string
  clientMessageId: string
  text: string
}
type PersistenceReceipt = {
  schemaVersion: 1
  teamId: string
  messageId: string
  clientMessageId: string
  persistence: 'durable'
  recipient?: string
}
type StoredRecord = {
  schemaVersion: 1
  scope: {
    actorId: string; deploymentId: string; bootId: string; restoreGeneration: number
    workspaceId: string; mountBinding: { mountGeneration: number; declaredRootHash: string }; teamId: string
  }
  message: HostedPersistedMessage
  receipt: PersistenceReceipt
}

/**
 * A restart-safe, team-scoped idempotency store. Each client id owns one private,
 * atomically replaced record and one cooperative lock shared by all orchestrator processes.
 */
export class HostedMessageFileStore implements HostedMessageDurablePersistencePort {
  constructor(
    private readonly directory: string,
    private readonly teamId: string,
    private readonly now: () => Date = () => new Date(),
    private readonly createMessageId: () => string = () => `message_${randomUUID().replaceAll('-', '')}`,
  ) {
    if (!/^team_[0-9a-f]{32}$/.test(teamId)) throw new TypeError('Invalid hosted message store team')
    if (directory.length === 0) throw new TypeError('Hosted message store directory is required')
  }

  async persist(
    command: PersistCommand,
    authority: HostedControlAuthority,
  ): Promise<HostedMessagePersistenceDecision> {
    this.#assertScope(command.teamId, authority)
    await this.#prepareDirectory()
    const scope = this.#scope(authority)
    const path = this.#recordPath(scope, command.clientMessageId)
    const release = await lockfile.lock(path, LOCK_OPTIONS)
    try {
      const existing = await this.#read(path)
      if (existing) {
        if (!isDeepStrictEqual(existing.scope, scope) ||
          existing.message.clientMessageId !== command.clientMessageId ||
          existing.message.teamId !== command.teamId || existing.message.text !== command.text ||
          existing.message.recipient !== command.recipient) {
          return { kind: 'conflict', reason: 'idempotency_mismatch' }
        }
        return { kind: 'idempotent_replay', receipt: existing.receipt }
      }

      const messageId = this.createMessageId()
      if (!/^message_[0-9a-f]{32}$/.test(messageId)) throw new Error('Invalid generated hosted message id')
      const createdAt = this.now().toISOString()
      // Lead records keep their original shape: no recipient key at all.
      const recipient = command.recipient === undefined ? {} : { recipient: command.recipient }
      const message: HostedPersistedMessage = {
        teamId: command.teamId,
        messageId,
        clientMessageId: command.clientMessageId,
        text: command.text,
        createdAt,
        ...recipient,
      }
      const receipt: PersistenceReceipt = {
        schemaVersion: 1,
        teamId: command.teamId,
        messageId,
        clientMessageId: command.clientMessageId,
        persistence: 'durable',
        ...recipient,
      }
      const record: StoredRecord = { schemaVersion: 1, scope, message, receipt }
      await writeFileAtomic(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      await fsyncFileAndParent(path)
      return { kind: 'persisted', receipt }
    } finally {
      await release()
    }
  }

  async find(
    request: DeliveryRequest,
    authority: HostedControlAuthority,
  ): Promise<{ kind: 'found'; message: HostedPersistedMessage } | { kind: 'not_found' | 'conflict' | 'unavailable' }> {
    this.#assertScope(request.teamId, authority)
    await this.#prepareDirectory()
    const scope = this.#scope(authority)
    const path = this.#recordPath(scope, request.clientMessageId)
    const release = await lockfile.lock(path, LOCK_OPTIONS)
    try {
      const existing = await this.#read(path)
      if (!existing) return { kind: 'not_found' }
      return isDeepStrictEqual(existing.scope, scope) && sameDeliveryIdentity(request, existing.message)
        ? { kind: 'found', message: existing.message }
        : { kind: 'conflict' }
    } finally {
      await release()
    }
  }

  #assertScope(teamId: string, authority: HostedControlAuthority): void {
    if (teamId !== this.teamId || authority.teamId !== this.teamId) {
      throw new TypeError('Hosted message store authority mismatch')
    }
  }

  #scope(authority: HostedControlAuthority): StoredRecord['scope'] {
    return {
      actorId: authority.actorId, deploymentId: authority.deploymentId, bootId: authority.bootId,
      restoreGeneration: authority.restoreGeneration, workspaceId: authority.workspaceId,
      mountBinding: { ...authority.mountBinding }, teamId: authority.teamId,
    }
  }

  #recordPath(scope: StoredRecord['scope'], clientMessageId: string): string {
    const digest = createHash('sha256')
      .update(IDEMPOTENCY_KEY_DOMAIN)
      .update('\0')
      .update(JSON.stringify({ ...scope, clientMessageId }))
      .digest('hex')
    return join(this.directory, `${digest}.message.v1.json`)
  }

  async #prepareDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const handle = await open(
      this.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
    )
    try {
      const stat = await handle.stat()
      const current = await lstat(this.directory)
      if (!stat.isDirectory() || !current.isDirectory() || current.isSymbolicLink() ||
        stat.dev !== current.dev || stat.ino !== current.ino || (stat.mode & 0o022) !== 0 ||
        (process.getuid?.() !== undefined && stat.uid !== process.getuid())) {
        throw new Error('Unsafe hosted message store directory')
      }
    } finally {
      await handle.close()
    }
  }

  async #read(path: string): Promise<StoredRecord | null> {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!handle) return null
    try {
      const stat = await handle.stat()
      const current = await lstat(path)
      if (!stat.isFile() || !current.isFile() || current.isSymbolicLink() ||
        stat.dev !== current.dev || stat.ino !== current.ino || (stat.mode & 0o077) !== 0 ||
        (process.getuid?.() !== undefined && stat.uid !== process.getuid())) {
        throw new Error('Unsafe hosted message record')
      }
      if (stat.size > MAX_RECORD_BYTES) throw new Error('Hosted message record exceeds 16KiB')
      const text = await handle.readFile('utf8')
      if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new Error('Hosted message record exceeds 16KiB')
      return decodeRecord(JSON.parse(text), this.teamId)
    } finally {
      await handle.close()
    }
  }
}

function sameDeliveryIdentity(request: DeliveryRequest, message: HostedPersistedMessage): boolean {
  return request.teamId === message.teamId && request.messageId === message.messageId &&
    request.clientMessageId === message.clientMessageId && request.text === message.text
}

function decodeRecord(value: unknown, teamId: string): StoredRecord {
  const record = exactRecord(value, ['schemaVersion', 'scope', 'message', 'receipt'], 'record')
  if (record.schemaVersion !== 1) throw new Error('Invalid hosted message record schema')
  const scopeRecord = exactRecord(record.scope, ['actorId', 'deploymentId', 'bootId', 'restoreGeneration', 'workspaceId', 'mountBinding', 'teamId'], 'scope')
  const mountRecord = exactRecord(scopeRecord.mountBinding, ['mountGeneration', 'declaredRootHash'], 'scope.mountBinding')
  const scope = {
    actorId: exactString(scopeRecord.actorId, undefined, 'scope.actorId'),
    deploymentId: exactString(scopeRecord.deploymentId, undefined, 'scope.deploymentId'),
    bootId: exactString(scopeRecord.bootId, undefined, 'scope.bootId'),
    restoreGeneration: exactInteger(scopeRecord.restoreGeneration, 'scope.restoreGeneration'),
    workspaceId: exactString(scopeRecord.workspaceId, undefined, 'scope.workspaceId'),
    mountBinding: {
      mountGeneration: exactInteger(mountRecord.mountGeneration, 'scope.mountGeneration', 1),
      declaredRootHash: exactString(mountRecord.declaredRootHash, /^[0-9a-f]{64}$/, 'scope.declaredRootHash'),
    },
    teamId: exactString(scopeRecord.teamId, /^team_[0-9a-f]{32}$/, 'scope.teamId'),
  }
  if (scope.actorId.length === 0 || scope.deploymentId.length === 0 || scope.bootId.length === 0 || scope.workspaceId.length === 0 || scope.teamId !== teamId) {
    throw new Error('Invalid hosted message record scope')
  }
  const hasRecipient = isRecordWithKey(record.message, 'recipient')
  const optionalRecipient = hasRecipient ? ['recipient'] : []
  const messageRecord = exactRecord(
    record.message,
    ['teamId', 'messageId', 'clientMessageId', 'text', 'createdAt', ...optionalRecipient],
    'message',
  )
  const receiptRecord = exactRecord(
    record.receipt,
    ['schemaVersion', 'teamId', 'messageId', 'clientMessageId', 'persistence', ...optionalRecipient],
    'receipt',
  )
  if (hasRecipient && !isHostedMessageRecipientName(messageRecord.recipient)) {
    throw new Error('Invalid hosted message recipient')
  }
  const recipient = hasRecipient ? { recipient: messageRecord.recipient as string } : {}
  const message: HostedPersistedMessage = {
    teamId: exactString(messageRecord.teamId, /^team_[0-9a-f]{32}$/, 'teamId'),
    messageId: exactString(messageRecord.messageId, /^message_[0-9a-f]{32}$/, 'messageId'),
    clientMessageId: exactString(
      messageRecord.clientMessageId,
      /^client_message_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/,
      'clientMessageId',
    ),
    text: exactString(messageRecord.text, undefined, 'text'),
    createdAt: exactString(messageRecord.createdAt, undefined, 'createdAt'),
    ...recipient,
  }
  if (message.teamId !== teamId || message.text.length < 1 || message.text.length > 4_000 ||
    !Number.isFinite(Date.parse(message.createdAt))) throw new Error('Invalid hosted message record value')
  const receipt: PersistenceReceipt = {
    schemaVersion: 1,
    teamId: exactString(receiptRecord.teamId, /^team_[0-9a-f]{32}$/, 'receipt.teamId'),
    messageId: exactString(receiptRecord.messageId, /^message_[0-9a-f]{32}$/, 'receipt.messageId'),
    clientMessageId: exactString(
      receiptRecord.clientMessageId,
      /^client_message_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/,
      'receipt.clientMessageId',
    ),
    persistence: receiptRecord.persistence === 'durable'
      ? 'durable'
      : (() => { throw new Error('Invalid hosted message persistence') })(),
    ...(hasRecipient ? { recipient: exactString(receiptRecord.recipient, undefined, 'receipt.recipient') } : {}),
  }
  if (!isDeepStrictEqual(receipt, {
    schemaVersion: 1,
    teamId: message.teamId,
    messageId: message.messageId,
    clientMessageId: message.clientMessageId,
    persistence: 'durable',
    ...recipient,
  })) throw new Error('Hosted message receipt mismatch')
  return { schemaVersion: 1, scope, message, receipt }
}

function isRecordWithKey(value: unknown, key: string): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key)
}

function exactRecord(value: unknown, keys: string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid hosted message ${name}`)
  const record = value as Record<string, unknown>
  const actual = Reflect.ownKeys(record)
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) {
    throw new Error(`Invalid hosted message ${name} keys`)
  }
  return record
}

function exactString(value: unknown, pattern: RegExp | undefined, name: string): string {
  if (typeof value !== 'string' || (pattern && !pattern.test(value))) {
    throw new Error(`Invalid hosted message ${name}`)
  }
  return value
}
function exactInteger(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`Invalid hosted message ${name}`)
  return value as number
}
