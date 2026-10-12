import { createHash } from 'node:crypto'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'

export type NativeAttachmentDeliveryV1 = {
  version: 1
  recipientRuntimeInstanceId: string
}

export type NativeAttachmentMetaV1 = {
  id: string
  filename: string
  mimeType: string
  size: number
  filePath: string
  sha256: string
}

export type NativeAttachmentMessageMetadata = {
  attachments?: readonly NativeAttachmentMetaV1[]
  nativeAttachmentDelivery?: NativeAttachmentDeliveryV1
}

export type NativeAttachmentProvider = 'anthropic' | 'codex'

export type NativeAttachmentFailureReason =
  | 'attachment_digest_mismatch'
  | 'attachment_missing'
  | 'attachment_path_invalid'
  | 'attachment_root_missing'
  | 'attachment_size_mismatch'
  | 'attachment_type_unsupported'
  | 'duplicate_attachment_id'
  | 'recipient_runtime_mismatch'

export class NativeAttachmentPreparationError extends Error {
  readonly reasonCode: NativeAttachmentFailureReason

  constructor(reasonCode: NativeAttachmentFailureReason, message: string) {
    super(message)
    this.name = 'NativeAttachmentPreparationError'
    this.reasonCode = reasonCode
  }
}

const MAX_NATIVE_ATTACHMENT_FILE_BYTES = 4 * 1024 * 1024
const MAX_NATIVE_ATTACHMENT_BATCH_BYTES = 8 * 1024 * 1024
const CLAUDE_IMAGE_MIME_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])
const CODEX_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
])
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

type AttachmentMessageInput = NativeAttachmentMessageMetadata & {
  messageId?: string
  teamName?: string
}

export function isNativeAttachmentMailboxMessage(
  message: NativeAttachmentMessageMetadata,
): boolean {
  return (
    message.nativeAttachmentDelivery !== undefined ||
    (Array.isArray(message.attachments) && message.attachments.length > 0)
  )
}

export async function isNativeAttachmentRootReady(): Promise<boolean> {
  const configuredRoot = process.env.CLAUDE_AGENT_TEAMS_ATTACHMENT_ROOT?.trim()
  if (!configuredRoot || !isAbsolute(configuredRoot)) {
    return false
  }
  try {
    const canonicalRoot = await realpath(configuredRoot)
    return (await stat(canonicalRoot)).isDirectory()
  } catch {
    return false
  }
}

function assertSafeSegment(value: string, label: string): void {
  if (!SAFE_SEGMENT_PATTERN.test(value)) {
    throw new NativeAttachmentPreparationError(
      'attachment_path_invalid',
      `native attachment ${label} is not a safe storage segment`,
    )
  }
}

function assertMetadata(
  message: AttachmentMessageInput,
  runtimeInstanceId: string,
): readonly NativeAttachmentMetaV1[] {
  const delivery = message.nativeAttachmentDelivery
  if (
    !delivery ||
    delivery.version !== 1 ||
    delivery.recipientRuntimeInstanceId !== runtimeInstanceId
  ) {
    throw new NativeAttachmentPreparationError(
      'recipient_runtime_mismatch',
      'native attachment delivery is not addressed to this runtime instance',
    )
  }
  if (
    typeof message.messageId !== 'string' ||
    typeof message.teamName !== 'string'
  ) {
    throw new NativeAttachmentPreparationError(
      'attachment_path_invalid',
      'native attachment message is missing canonical identity',
    )
  }
  assertSafeSegment(message.teamName, 'team')
  assertSafeSegment(message.messageId, 'message ID')
  if (!Array.isArray(message.attachments) || message.attachments.length === 0) {
    throw new NativeAttachmentPreparationError(
      'attachment_missing',
      'native attachment message has no attachment metadata',
    )
  }

  const ids = new Set<string>()
  let declaredBatchBytes = 0
  for (const attachment of message.attachments) {
    if (
      !attachment ||
      typeof attachment.id !== 'string' ||
      typeof attachment.filename !== 'string' ||
      typeof attachment.mimeType !== 'string' ||
      typeof attachment.filePath !== 'string' ||
      typeof attachment.sha256 !== 'string' ||
      !Number.isSafeInteger(attachment.size) ||
      attachment.size < 0
    ) {
      throw new NativeAttachmentPreparationError(
        'attachment_path_invalid',
        'native attachment metadata is incomplete',
      )
    }
    assertSafeSegment(attachment.id, 'attachment ID')
    if (ids.has(attachment.id)) {
      throw new NativeAttachmentPreparationError(
        'duplicate_attachment_id',
        'native attachment batch contains a duplicate attachment ID',
      )
    }
    ids.add(attachment.id)
    if (!SHA256_PATTERN.test(attachment.sha256)) {
      throw new NativeAttachmentPreparationError(
        'attachment_digest_mismatch',
        'native attachment digest is invalid',
      )
    }
    if (
      attachment.size > MAX_NATIVE_ATTACHMENT_FILE_BYTES ||
      declaredBatchBytes + attachment.size > MAX_NATIVE_ATTACHMENT_BATCH_BYTES
    ) {
      throw new NativeAttachmentPreparationError(
        'attachment_size_mismatch',
        'native attachment batch exceeds the bounded file size',
      )
    }
    declaredBatchBytes += attachment.size
  }
  return message.attachments
}

async function resolveExpectedAttachmentPath(input: {
  attachment: NativeAttachmentMetaV1
  messageId: string
  teamName: string
}): Promise<string> {
  const configuredRoot = process.env.CLAUDE_AGENT_TEAMS_ATTACHMENT_ROOT?.trim()
  if (!configuredRoot || !isAbsolute(configuredRoot)) {
    throw new NativeAttachmentPreparationError(
      'attachment_root_missing',
      'native attachment root is unavailable',
    )
  }
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(configuredRoot)
  } catch {
    throw new NativeAttachmentPreparationError(
      'attachment_root_missing',
      'native attachment root is unavailable',
    )
  }
  // Keep this storage contract aligned with TeamAttachmentStore.sanitizeStoredFilename.
  const raw = input.attachment.filename.trim()
  const base = raw ? (raw.split(/[\\/]/).pop() ?? raw) : ''
  const cleaned = base
    .replace(/\0/g, '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\\/]/g, '_')
    .trim()
  const storedFilename = cleaned ? cleaned.slice(0, 180) : 'attachment'
  const artifactName = `${input.attachment.id}--${storedFilename}`

  const expectedPath = join(
    canonicalRoot,
    input.teamName,
    input.messageId,
    artifactName,
  )
  if (
    !isAbsolute(input.attachment.filePath) ||
    resolve(input.attachment.filePath) !== expectedPath ||
    input.attachment.filePath !== expectedPath
  ) {
    throw new NativeAttachmentPreparationError(
      'attachment_path_invalid',
      'native attachment path does not match the trusted storage layout',
    )
  }
  return expectedPath
}

async function readValidatedAttachment(
  attachment: NativeAttachmentMetaV1,
  expectedPath: string,
): Promise<Buffer> {
  try {
    const linkStat = await lstat(expectedPath)
    if (!linkStat.isFile()) {
      throw new NativeAttachmentPreparationError(
        'attachment_path_invalid',
        'native attachment is not a regular file',
      )
    }
    const canonicalPath = await realpath(expectedPath)
    if (canonicalPath !== expectedPath) {
      throw new NativeAttachmentPreparationError(
        'attachment_path_invalid',
        'native attachment path crosses a symlink boundary',
      )
    }
    const handle = await open(expectedPath, 'r')
    try {
      const fileStat = await handle.stat()
      if (
        !fileStat.isFile() ||
        fileStat.size > MAX_NATIVE_ATTACHMENT_FILE_BYTES
      ) {
        throw new NativeAttachmentPreparationError(
          'attachment_size_mismatch',
          'native attachment file exceeds the bounded file size',
        )
      }
      const bytes = Buffer.alloc(fileStat.size)
      let offset = 0
      while (offset < bytes.length) {
        const result = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        )
        if (result.bytesRead === 0) break
        offset += result.bytesRead
      }
      const extraByte = Buffer.alloc(1)
      const extra = await handle.read(extraByte, 0, 1, fileStat.size)
      if (offset !== bytes.length || extra.bytesRead !== 0) {
        throw new NativeAttachmentPreparationError(
          'attachment_size_mismatch',
          'native attachment changed while it was being validated',
        )
      }
      if (bytes.length !== attachment.size) {
        throw new NativeAttachmentPreparationError(
          'attachment_size_mismatch',
          'native attachment size does not match the saved artifact',
        )
      }
      const digest = createHash('sha256').update(bytes).digest('hex')
      if (digest !== attachment.sha256) {
        throw new NativeAttachmentPreparationError(
          'attachment_digest_mismatch',
          'native attachment digest does not match the saved artifact',
        )
      }
      return bytes
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error instanceof NativeAttachmentPreparationError) throw error
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new NativeAttachmentPreparationError(
        'attachment_missing',
        'native attachment artifact is missing',
      )
    }
    throw new NativeAttachmentPreparationError(
      'attachment_path_invalid',
      'native attachment artifact could not be validated',
    )
  }
}

function assertProviderMime(
  attachment: NativeAttachmentMetaV1,
  provider: NativeAttachmentProvider,
): void {
  const supported =
    provider === 'codex'
      ? CODEX_IMAGE_MIME_TYPES.has(attachment.mimeType)
      : CLAUDE_IMAGE_MIME_TYPES.has(attachment.mimeType) ||
        attachment.mimeType === 'application/pdf' ||
        attachment.mimeType === 'text/plain'
  if (!supported) {
    throw new NativeAttachmentPreparationError(
      'attachment_type_unsupported',
      'native attachment type is unsupported by the selected provider',
    )
  }
}

function buildProviderContentBlock(
  attachment: NativeAttachmentMetaV1,
  bytes: Buffer,
  provider: NativeAttachmentProvider,
): ContentBlockParam {
  assertProviderMime(attachment, provider)
  if (provider === 'codex') {
    return {
      type: 'image',
      source: {
        type: 'file',
        path: attachment.filePath,
        media_type: attachment.mimeType,
      },
    } as unknown as ContentBlockParam
  }
  if (attachment.mimeType.startsWith('image/')) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: attachment.mimeType,
        data: bytes.toString('base64'),
      },
    } as unknown as ContentBlockParam
  }
  return {
    type: 'document',
    title: attachment.filename,
    source:
      attachment.mimeType === 'application/pdf'
        ? {
            type: 'base64',
            media_type: 'application/pdf',
            data: bytes.toString('base64'),
          }
        : {
            type: 'text',
            media_type: 'text/plain',
            data: bytes.toString('utf8'),
          },
  } as unknown as ContentBlockParam
}

export async function prepareNativeAttachmentPromptContent(input: {
  message: AttachmentMessageInput
  provider: NativeAttachmentProvider
  replyProtocolText: string
  runtimeInstanceId: string
}): Promise<ContentBlockParam[]> {
  const attachments = assertMetadata(input.message, input.runtimeInstanceId)
  const content: ContentBlockParam[] = []
  if (input.replyProtocolText.trim().length > 0) {
    content.push({ type: 'text', text: input.replyProtocolText })
  }

  for (const attachment of attachments) {
    const expectedPath = await resolveExpectedAttachmentPath({
      attachment,
      messageId: input.message.messageId!,
      teamName: input.message.teamName!,
    })
    const bytes = await readValidatedAttachment(attachment, expectedPath)
    content.push(
      buildProviderContentBlock(attachment, bytes, input.provider),
    )
  }
  return content
}
