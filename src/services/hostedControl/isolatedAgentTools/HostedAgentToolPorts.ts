import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import { writeFileAtomic } from '../../../utils/atomicWrite.js'
import * as lockfile from '../../../utils/lockfile.js'
import { writeToMailboxAtCanonicalTeamRootVerified } from '../../../utils/teammateMailbox.js'
import { fsyncDirectoryPath, fsyncFileAndParent } from '../HostedTaskMutationWal.js'
import type { HostedTaskMutationService } from '../HostedTaskMutationService.js'
import { HOSTED_AGENT_TOOL_MAX_FRAME_BYTES } from '../agentTools/HostedAgentToolContract.js'
import type { HostedMemberAttempt, HostedMemberSessionBridge } from '../hostedLaneSession/HostedMemberSessionBridge.js'
import type { HostedAgentTaskCommentWriter, HostedAgentTaskReader, HostedAgentTeamMessageSender } from '../agentTools/HostedAgentToolExecutors.js'
import type { HostedAgentToolBinding } from '../agentTools/HostedAgentToolWal.js'

const LOCK = { realpath: false, retries: { retries: 20, minTimeout: 5, maxTimeout: 100 } } as const

export class HostedAgentTaskReaderPort implements HostedAgentTaskReader {
  constructor(private readonly service: Pick<HostedTaskMutationService, 'readTaskForMember'>,
    private readonly comments?: Pick<HostedAgentTaskCommentFilePort, 'listComments'>) {}

  async getTask(input: Parameters<HostedAgentTaskReader['getTask']>[0]) {
    if (input.signal.aborted) throw new Error('Hosted task read aborted')
    const result = await this.service.readTaskForMember({
      teamId: input.binding.teamId, taskId: input.taskId, memberId: input.binding.memberId,
    })
    if (input.signal.aborted) throw new Error('Hosted task read aborted')
    if (!result || !this.comments) return result
    const withComments = (items: readonly CommentRecord[], totalCount: number | null, truncated: boolean) =>
      ({ ...result, task: { ...result.task, hostedComments: items,
        hostedCommentTotalCount: totalCount, hostedCommentsTruncated: truncated } })
    const fitsFrame = (items: readonly CommentRecord[]) => encodedFd3ResponseBytes(
      withComments(items, 999_999_999, false)) <= HOSTED_AGENT_TOOL_MAX_FRAME_BYTES
    if (!fitsFrame([])) throw new Error('Hosted task exceeds FD3 response budget')
    const page = await this.comments.listComments({ binding: input.binding, taskId: input.taskId,
      sourceGeneration: result.sourceGeneration, canInclude: fitsFrame,
      signal: input.signal })
    if (input.signal.aborted) throw new Error('Hosted task read aborted')
    const final = await this.service.readTaskForMember({ teamId: input.binding.teamId,
      taskId: input.taskId, memberId: input.binding.memberId })
    if (!final || final.sourceGeneration !== result.sourceGeneration || final.revision !== result.revision ||
      input.signal.aborted) throw new Error('Hosted task changed during comment read')
    const answer = withComments(page.items, page.totalCount, page.truncated)
    if (encodedFd3ResponseBytes(answer) > HOSTED_AGENT_TOOL_MAX_FRAME_BYTES) {
      throw new Error('Hosted task comment response exceeds FD3 frame')
    }
    return answer
  }
}

type CommentRecord = Readonly<{
  schemaVersion: 1; commentId: string; teamId: string; taskId: string; authorId: string
  runId: string; sessionID: string; callID: string; sourceGeneration: string
  boardRevisionAtAppend: string; text: string; createdAt: string
}>

/** Append-only sidecar. A call ID owns one immutable comment; no task JSON is rewritten. */
export class HostedAgentTaskCommentFilePort implements HostedAgentTaskCommentWriter {
  constructor(private readonly directory: string, private readonly teamId: string,
    private readonly reader: HostedAgentTaskReader) {
    if (!isAbsolute(directory) || !/^team_[0-9a-f]{32}$/.test(teamId)) throw new TypeError('Invalid hosted comment scope')
  }

  async addComment(input: Parameters<HostedAgentTaskCommentWriter['addComment']>[0]): Promise<string> {
    const { binding, taskId, text, callID, signal } = input
    if (signal.aborted || binding.teamId !== this.teamId || !/^task_[0-9a-f]{32}$/.test(taskId) ||
      typeof text !== 'string' || text.length === 0 || Buffer.byteLength(text) > 20_000) {
      throw new Error('Invalid hosted comment authority')
    }
    const snapshot = await this.reader.getTask({ binding, taskId, signal })
    if (!snapshot || snapshot.ownerId !== binding.memberId || snapshot.teamId !== binding.teamId ||
      snapshot.taskId !== taskId || signal.aborted) throw new Error('Hosted comment task unavailable')
    await privateDirectory(this.directory)
    const taskDirectory = join(this.directory, taskId)
    await privateDirectory(taskDirectory)
    const digest = sha(JSON.stringify(['hosted-agent-task-comment/v1', binding.teamId, binding.runId,
      binding.memberId, binding.sessionID, callID]))
    const commentId = `comment_${digest.slice(0, 32)}`
    const path = join(taskDirectory, `${digest}.comment.v1.json`)
    const release = await lockfile.lock(path, LOCK)
    try {
      const existing = await privateJson<CommentRecord>(path)
      if (existing) {
        if (!validCommentRecord(existing, `${digest}.comment.v1.json`) ||
          existing.commentId !== commentId || existing.teamId !== binding.teamId ||
          existing.taskId !== taskId || existing.authorId !== binding.memberId || existing.runId !== binding.runId ||
          existing.sessionID !== binding.sessionID || existing.callID !== callID || existing.text !== text ||
          existing.sourceGeneration !== snapshot.sourceGeneration) {
          throw new Error('Hosted comment call ID conflict')
        }
        return JSON.stringify(existing)
      }
      if (signal.aborted) throw new Error('Hosted comment authority revoked')
      const record: CommentRecord = { schemaVersion: 1, commentId, teamId: binding.teamId, taskId,
        authorId: binding.memberId, runId: binding.runId, sessionID: binding.sessionID, callID,
        sourceGeneration: snapshot.sourceGeneration, boardRevisionAtAppend: snapshot.revision,
        text, createdAt: new Date().toISOString() }
      const serialized = `${JSON.stringify(record)}\n`
      if (Buffer.byteLength(serialized, 'utf8') > 32_768) {
        throw new Error('Hosted comment exceeds durable record budget')
      }
      await writeFileAtomic(path, serialized, { mode: 0o600 })
      await fsyncFileAndParent(path)
      return JSON.stringify(record)
    } finally { await release() }
  }

  async listComments(input: Readonly<{ binding: Readonly<HostedAgentToolBinding>; taskId: string;
    sourceGeneration: string; canInclude: (items: readonly CommentRecord[]) => boolean; signal: AbortSignal }>): Promise<Readonly<{
      items: readonly CommentRecord[]; totalCount: number | null; truncated: boolean
    }>> {
    if (input.signal.aborted || input.binding.teamId !== this.teamId ||
      !/^task_[0-9a-f]{32}$/.test(input.taskId) ||
      !/^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/.test(input.sourceGeneration) ||
      typeof input.canInclude !== 'function') {
      throw new Error('Invalid hosted comment read authority')
    }
    await privateDirectory(this.directory)
    const taskDirectory = join(this.directory, input.taskId)
    await privateDirectory(taskDirectory)
    const names = (await readdir(taskDirectory)).filter(name => name.endsWith('.comment.v1.json')).sort()
    const scanLimited = names.length > 4_096
    const comments: CommentRecord[] = []
    let totalCount = 0
    for (const name of names.slice(0, 4_096)) {
      if (!/^[0-9a-f]{64}\.comment\.v1\.json$/.test(name)) throw new Error('Invalid hosted comment filename')
      const record = await privateJson<CommentRecord>(join(taskDirectory, name))
      if (!validCommentRecord(record, name)) throw new Error('Invalid hosted comment record')
      if (record.teamId === this.teamId && record.taskId === input.taskId &&
        record.authorId === input.binding.memberId && record.runId === input.binding.runId &&
        record.sourceGeneration === input.sourceGeneration) {
        totalCount++
        if (input.canInclude([...comments, record])) comments.push(record)
      }
    }
    if (input.signal.aborted) throw new Error('Hosted comment read aborted')
    comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.commentId.localeCompare(b.commentId))
    return { items: comments, totalCount: scanLimited ? null : totalCount,
      truncated: scanLimited || comments.length < totalCount }
  }
}

export interface HostedAgentRecipientWakePort {
  /** A real, idempotent recipient delivery wake; throw on uncertain or missing delivery. */
  wake(input: Readonly<{ binding: Readonly<HostedAgentToolBinding>; recipient: HostedAgentPeerRecipient;
    envelope: HostedAgentVerifiedMessageEnvelope }>): Promise<void>
}

export type HostedAgentPeerRecipient = Readonly<{ teamId: string; runId: string; memberId: string;
  memberName: string; laneId: string }>
export type HostedAgentVerifiedMessageEnvelope = Readonly<{
  messageId: string; teamId: string; runId: string; senderId: string; senderName: string
  recipientId: string; recipientName: string; recipientLaneId: string; text: string; timestamp: string
  fingerprint: string
}>

/** Wakes the exact admitted recipient session with a durable delivery claim. */
export class HostedAgentSessionRecipientWakePort implements HostedAgentRecipientWakePort {
  constructor(
    private readonly sessions: Pick<HostedMemberSessionBridge, 'deliver'>,
    private readonly attemptForRecipient: (recipient: HostedAgentPeerRecipient, binding: Readonly<HostedAgentToolBinding>) =>
      HostedMemberAttempt | null | Promise<HostedMemberAttempt | null>,
  ) {}

  async wake(input: Parameters<HostedAgentRecipientWakePort['wake']>[0]): Promise<void> {
    const { envelope, recipient, binding } = input
    if (envelope.teamId !== binding.teamId || envelope.runId !== binding.runId ||
      envelope.senderId !== binding.memberId || envelope.senderName !== binding.memberName ||
      envelope.recipientId !== recipient.memberId || envelope.recipientName !== recipient.memberName ||
      envelope.recipientLaneId !== recipient.laneId || envelope.fingerprint !== envelopeFingerprint(envelope)) {
      throw new Error('Hosted recipient envelope mismatch')
    }
    const attempt = await this.attemptForRecipient(recipient, binding)
    if (!attempt || attempt.teamId !== input.binding.teamId || attempt.runId !== input.binding.runId ||
      attempt.memberName !== recipient.memberName || attempt.memberId !== recipient.memberId ||
      attempt.laneId !== recipient.laneId || attempt.memberId === input.binding.memberId) {
      throw new Error('Hosted recipient session is unavailable')
    }
    const status = await this.sessions.deliver({ attempt, deliveryId: `wake_${envelope.messageId}`,
      kind: 'message', text: wakeDeliveryText(envelope),
      taskId: null, taskRevision: null })
    if (status !== 'delivered') throw new Error(`Hosted recipient wake is ${status}`)
  }
}

/** Verified peer mailbox append, followed by an actual recipient wake acknowledgement. */
export class HostedAgentPeerMailboxPort implements HostedAgentTeamMessageSender {
  readonly #recipients: readonly HostedAgentPeerRecipient[]
  constructor(private readonly canonicalTeamRoot: string, private readonly wake: HostedAgentRecipientWakePort,
    recipients: readonly HostedAgentPeerRecipient[]) {
    if (!isAbsolute(canonicalTeamRoot)) throw new TypeError('Hosted mailbox root must be absolute')
    if (!Array.isArray(recipients) || recipients.length > 512) throw new TypeError('Invalid hosted peer roster')
    this.#recipients = Object.freeze(recipients.map(member => Object.freeze({ ...member })))
  }

  async send(input: Parameters<HostedAgentTeamMessageSender['send']>[0]): Promise<string> {
    const { binding, to, text, taskRefs, callID, signal } = input
    if (signal.aborted || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(to) ||
      to === binding.memberName || !Array.isArray(taskRefs)) throw new Error('Invalid hosted peer message')
    const candidates = this.#recipients.filter(recipient => recipient.teamId === binding.teamId &&
      recipient.runId === binding.runId && recipient.memberName === to && recipient.memberId !== binding.memberId)
    if (candidates.length !== 1) throw new Error('Hosted peer recipient is unavailable')
    const recipient = candidates[0]!
    const digest = sha(JSON.stringify(['hosted-agent-peer-message/v1', binding.teamId, binding.runId,
      binding.memberId, binding.sessionID, callID]))
    const messageId = `message_${digest.slice(0, 32)}`
    const messageText = taskRefs.length === 0 ? text : `${text}\n\nTask refs: ${taskRefs.map(ref => `#${ref.taskId}`).join(', ')}`
    if (Buffer.byteLength(messageText) > 3_500) throw new Error('Hosted peer message exceeds wake budget')
    const intentDirectory = join(this.canonicalTeamRoot, 'hosted-agent-peer-message-intents')
    await privateDirectory(intentDirectory)
    const intentPath = join(intentDirectory, `${digest}.message.v1.json`)
    const release = await lockfile.lock(intentPath, LOCK)
    let timestamp: string
    try {
      const existing = await privateJson<{ messageId: string; from: string; to: string; text: string; timestamp: string }>(intentPath)
      if (existing) {
        if (existing.messageId !== messageId || existing.from !== binding.memberName ||
          existing.to !== to || existing.text !== messageText || !Number.isFinite(Date.parse(existing.timestamp))) {
          throw new Error('Hosted peer message call ID conflict')
        }
        timestamp = existing.timestamp
      } else {
        if (signal.aborted) throw new Error('Hosted peer message authority revoked')
        timestamp = new Date().toISOString()
        await writeFileAtomic(intentPath, `${JSON.stringify({ messageId, from: binding.memberName,
          to, text: messageText, timestamp })}\n`, { mode: 0o600 })
        await fsyncFileAndParent(intentPath)
      }
    } finally { await release() }
    if (signal.aborted) throw new Error('Hosted peer message authority revoked before append')
    const result = await writeToMailboxAtCanonicalTeamRootVerified({
      canonicalTeamRoot: this.canonicalTeamRoot, recipientName: to,
      message: { messageId, from: binding.memberName, text: messageText, timestamp },
    })
    if (result.kind === 'conflict') throw new Error('Hosted peer mailbox conflict')
    if (signal.aborted) throw new Error('Hosted peer message authority revoked after append')
    const unsigned = { messageId, teamId: binding.teamId, runId: binding.runId,
      senderId: binding.memberId, senderName: binding.memberName,
      recipientId: recipient.memberId, recipientName: recipient.memberName,
      recipientLaneId: recipient.laneId, text: messageText, timestamp }
    const envelope: HostedAgentVerifiedMessageEnvelope = { ...unsigned, fingerprint: envelopeFingerprint(unsigned) }
    await this.wake.wake({ binding, recipient, envelope })
    if (signal.aborted) throw new Error('Hosted peer message authority revoked after wake')
    return JSON.stringify({ messageId, recipient: to, mailbox: result.kind, wake: 'acknowledged' })
  }
}

function envelopeFingerprint(envelope: Omit<HostedAgentVerifiedMessageEnvelope, 'fingerprint'>): string {
  return sha(JSON.stringify(['hosted-agent-verified-mailbox-envelope/v1', envelope.messageId,
    envelope.teamId, envelope.runId, envelope.senderId, envelope.senderName,
    envelope.recipientId, envelope.recipientName, envelope.recipientLaneId,
    envelope.text, envelope.timestamp]))
}

function wakeDeliveryText(envelope: HostedAgentVerifiedMessageEnvelope): string {
  const text = `Team message ${envelope.messageId} from ${envelope.senderName} (${envelope.senderId}), sha256:${envelope.fingerprint}\n\n${envelope.text}`
  if (Buffer.byteLength(text) > 4_000) throw new Error('Hosted recipient wake exceeds delivery budget')
  return text
}

async function privateDirectory(path: string): Promise<void> {
  const parent = dirname(path)
  const parentStat = await lstat(parent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() ||
    (parentStat.mode & 0o077) !== 0 || await realpath(parent) !== parent ||
    (process.getuid?.() !== undefined && parentStat.uid !== process.getuid())) {
    throw new Error('Unsafe hosted tool directory parent')
  }
  try { await mkdir(path, { mode: 0o700 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
    (process.getuid?.() !== undefined && stat.uid !== process.getuid()) || await realpath(path) !== path) {
    throw new Error('Unsafe hosted tool directory')
  }
  await fsyncDirectoryPath(parent)
}

async function privateJson<T>(path: string): Promise<T | null> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (!handle) return null
  try {
    const stat = await handle.stat()
    const pathStat = await lstat(path)
    if (!stat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink() || stat.dev !== pathStat.dev ||
      stat.ino !== pathStat.ino || stat.nlink !== 1 || stat.size > 32_768 || (stat.mode & 0o077) !== 0 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid())) throw new Error('Unsafe hosted tool record')
    return JSON.parse(await handle.readFile('utf8')) as T
  } finally { await handle.close() }
}

function sha(value: string): string { return createHash('sha256').update(value).digest('hex') }

function encodedFd3ResponseBytes(value: unknown): number {
  const result = JSON.stringify(value)
  return Buffer.byteLength(JSON.stringify({ version: 1, type: 'response',
    requestId: '00000000-0000-4000-8000-000000000000', ok: true, result }), 'utf8')
}

function validCommentRecord(record: CommentRecord | null, name: string): record is CommentRecord {
  if (!record || Object.keys(record).sort().join(',') !== [
    'schemaVersion', 'commentId', 'teamId', 'taskId', 'authorId', 'runId', 'sessionID',
    'callID', 'sourceGeneration', 'boardRevisionAtAppend', 'text', 'createdAt',
  ].sort().join(',') || record.schemaVersion !== 1 ||
    !/^comment_[0-9a-f]{32}$/.test(record.commentId) || !/^team_[0-9a-f]{32}$/.test(record.teamId) ||
    !/^task_[0-9a-f]{32}$/.test(record.taskId) || !/^member_[0-9a-f]{32}$/.test(record.authorId) ||
    !/^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/.test(record.sourceGeneration) ||
    !/^revision_[A-Za-z0-9][A-Za-z0-9._-]{0,246}$/.test(record.boardRevisionAtAppend) ||
    typeof record.text !== 'string' || Buffer.byteLength(record.text) > 20_000 ||
    !Number.isFinite(Date.parse(record.createdAt))) return false
  const digest = sha(JSON.stringify(['hosted-agent-task-comment/v1', record.teamId, record.runId,
    record.authorId, record.sessionID, record.callID]))
  return name === `${digest}.comment.v1.json` && record.commentId === `comment_${digest.slice(0, 32)}`
}
