import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NativeAttachmentPreparationError,
  prepareNativeAttachmentPromptContent,
  type NativeAttachmentMetaV1,
} from './nativeTeammateAttachments.js'

describe('native teammate attachment content', () => {
  const originalRoot = process.env.CLAUDE_AGENT_TEAMS_ATTACHMENT_ROOT
  let root: string
  let messageDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'native-teammate-attachments-'))
    messageDir = join(root, 'team-a', 'message-1')
    await mkdir(messageDir, { recursive: true })
    process.env.CLAUDE_AGENT_TEAMS_ATTACHMENT_ROOT = root
  })

  afterEach(async () => {
    if (originalRoot === undefined) {
      delete process.env.CLAUDE_AGENT_TEAMS_ATTACHMENT_ROOT
    } else {
      process.env.CLAUDE_AGENT_TEAMS_ATTACHMENT_ROOT = originalRoot
    }
    await rm(root, { recursive: true, force: true })
  })

  async function writeAttachment(
    name: string,
    bytes: Buffer,
    overrides: Partial<NativeAttachmentMetaV1> = {},
  ): Promise<NativeAttachmentMetaV1> {
    const filePath = join(messageDir, name)
    await writeFile(filePath, bytes)
    return {
      id: 'attachment-1',
      filename: 'image.png',
      mimeType: 'image/png',
      size: bytes.length,
      filePath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...overrides,
    }
  }

  const message = {
    messageId: 'message-1',
    teamName: 'team-a',
    nativeAttachmentDelivery: {
      version: 1 as const,
      recipientRuntimeInstanceId: 'runtime-1',
    },
  }

  it('builds genuine Claude and Codex provider blocks while retaining reply text', async () => {
    const attachment = await writeAttachment(
      'attachment-1--image.png',
      Buffer.from('image-bytes'),
    )
    const input = {
      message: { ...message, attachments: [attachment] },
      replyProtocolText: '<teammate_message>inspect this</teammate_message>',
      runtimeInstanceId: 'runtime-1',
    }

    expect(
      await prepareNativeAttachmentPromptContent({
        ...input,
        provider: 'anthropic',
      }),
    ).toEqual([
      { type: 'text', text: input.replyProtocolText },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: Buffer.from('image-bytes').toString('base64'),
        },
      },
    ])
    // The native Codex file-source extension is outside the Claude SDK union.
    const codexContent: unknown = await prepareNativeAttachmentPromptContent({
      ...input,
      provider: 'codex',
    })
    expect(codexContent).toEqual([
      { type: 'text', text: input.replyProtocolText },
      {
        type: 'image',
        source: {
          type: 'file',
          path: attachment.filePath,
          media_type: 'image/png',
        },
      },
    ])
  })

  it('prepares Codex Unicode text and images in order, including BOM and empty text', async () => {
    const text = await writeAttachment('attachment-1--note.md', Buffer.from('\uFEFFПривіт 世界'), {
      filename: 'note.md',
      mimeType: 'text/plain',
    })
    const image = await writeAttachment('attachment-2--image.png', Buffer.from('image-bytes'), {
      id: 'attachment-2',
    })
    const empty = await writeAttachment('attachment-3--empty.txt', Buffer.alloc(0), {
      id: 'attachment-3',
      filename: 'empty.txt',
      mimeType: 'text/plain',
    })
    const content: unknown = await prepareNativeAttachmentPromptContent({
      message: { ...message, attachments: [text, image, empty] },
      provider: 'codex',
      replyProtocolText: 'protocol',
      runtimeInstanceId: 'runtime-1',
    })
    expect(content).toEqual([
      { type: 'text', text: 'protocol' },
      { type: 'text', text: 'Attached file: note.md\n\nПривіт 世界' },
      { type: 'image', source: { type: 'file', path: image.filePath, media_type: 'image/png' } },
      { type: 'text', text: 'Attached file: empty.txt\n\n' },
    ])
  })

  it('rejects a mixed Codex batch with malformed UTF-8, changed bytes, or non-exact text MIME', async () => {
    const image = await writeAttachment('attachment-1--image.png', Buffer.from('image-bytes'))
    const text = await writeAttachment('attachment-2--note.txt', Buffer.from([0xc3]), {
      id: 'attachment-2',
      filename: 'note.txt',
      mimeType: 'text/plain',
    })
    const input = {
      message: { ...message, attachments: [image, text] },
      provider: 'codex' as const,
      replyProtocolText: 'protocol',
      runtimeInstanceId: 'runtime-1',
    }
    await expect(prepareNativeAttachmentPromptContent(input)).rejects.toMatchObject({
      reasonCode: 'attachment_text_invalid_utf8',
    })
    await writeFile(text.filePath, Buffer.from('x'))
    await expect(prepareNativeAttachmentPromptContent(input)).rejects.toMatchObject({
      reasonCode: 'attachment_digest_mismatch',
    })
    const unsupported = { ...text, sha256: createHash('sha256').update('x').digest('hex'),
      mimeType: 'text/plain;charset=utf-8' }
    await expect(prepareNativeAttachmentPromptContent({
      ...input, message: { ...message, attachments: [image, unsupported] },
    })).rejects.toMatchObject({ reasonCode: 'attachment_type_unsupported' })
  })

  it('keeps Claude text and PDF content structured', async () => {
    const text = await writeAttachment('attachment-1--note.txt', Buffer.from('hello'), {
      filename: 'note.txt',
      mimeType: 'text/plain',
    })
    const pdf = await writeAttachment('attachment-2--doc.pdf', Buffer.from('%PDF'), {
      id: 'attachment-2',
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
    })
    expect(
      await prepareNativeAttachmentPromptContent({
        message: { ...message, attachments: [text, pdf] },
        provider: 'anthropic',
        replyProtocolText: 'protocol',
        runtimeInstanceId: 'runtime-1',
      }),
    ).toEqual([
      { type: 'text', text: 'protocol' },
      {
        type: 'document',
        title: 'note.txt',
        source: { type: 'text', media_type: 'text/plain', data: 'hello' },
      },
      {
        type: 'document',
        title: 'doc.pdf',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: Buffer.from('%PDF').toString('base64'),
        },
      },
    ])
  })

  it('derives the exact app artifact name while preserving Unicode document titles and UTF-8 content', async () => {
    const filename = '  folder\\ré sumé\t資料.txt  '
    const attachment = await writeAttachment('attachment-1--ré sumé 資料.txt', Buffer.from('Привіт 世界'), {
      filename, mimeType: 'text/plain',
    })
    const content = await prepareNativeAttachmentPromptContent({
      message: { ...message, attachments: [attachment] }, provider: 'anthropic',
      replyProtocolText: 'protocol', runtimeInstanceId: 'runtime-1',
    })
    expect(content[1]).toEqual({
      type: 'document', title: filename,
      source: { type: 'text', media_type: 'text/plain', data: 'Привіт 世界' },
    })
    const otherFile = await writeAttachment('attachment-1--other.txt', Buffer.from('Привіт 世界'), {
      filename, mimeType: 'text/plain',
    })
    await expect(prepareNativeAttachmentPromptContent({
      message: { ...message, attachments: [otherFile] }, provider: 'anthropic',
      replyProtocolText: 'protocol', runtimeInstanceId: 'runtime-1',
    })).rejects.toMatchObject({ reasonCode: 'attachment_path_invalid' })
  })

  it('rejects missing, oversized, and same-size changed artifacts for the whole batch', async () => {
    const attachment = await writeAttachment('attachment-1--image.png', Buffer.from('image-bytes'))
    const input = { message: { ...message, attachments: [attachment] },
      provider: 'codex' as const, replyProtocolText: 'protocol', runtimeInstanceId: 'runtime-1' }
    await writeFile(attachment.filePath, Buffer.from('other-bytes'))
    await expect(prepareNativeAttachmentPromptContent(input)).rejects.toMatchObject({ reasonCode: 'attachment_digest_mismatch' })
    await writeFile(attachment.filePath, Buffer.alloc(4 * 1024 * 1024 + 1))
    await expect(prepareNativeAttachmentPromptContent(input)).rejects.toMatchObject({ reasonCode: 'attachment_size_mismatch' })
    await rm(attachment.filePath)
    await expect(prepareNativeAttachmentPromptContent(input)).rejects.toMatchObject({ reasonCode: 'attachment_missing' })
    const good = await writeAttachment('attachment-2--image.png', Buffer.from('image-bytes'), { id: 'attachment-2' })
    await expect(prepareNativeAttachmentPromptContent({ ...input,
      message: { ...message, attachments: [good, attachment] },
    })).rejects.toMatchObject({ reasonCode: 'attachment_missing' })
  })

  it('rejects stale instances, duplicate IDs, changed bytes, and unsupported Codex documents', async () => {
    const attachment = await writeAttachment(
      'attachment-1--image.png',
      Buffer.from('image-bytes'),
    )
    const baseInput = {
      message: { ...message, attachments: [attachment] },
      provider: 'codex' as const,
      replyProtocolText: 'protocol',
      runtimeInstanceId: 'runtime-1',
    }
    await expect(
      prepareNativeAttachmentPromptContent({
        ...baseInput,
        runtimeInstanceId: 'other-runtime',
      }),
    ).rejects.toMatchObject({ reasonCode: 'recipient_runtime_mismatch' })
    await expect(
      prepareNativeAttachmentPromptContent({
        ...baseInput,
        message: { ...baseInput.message, attachments: [attachment, attachment] },
      }),
    ).rejects.toMatchObject({ reasonCode: 'duplicate_attachment_id' })
    await writeFile(attachment.filePath, Buffer.from('changed'))
    await expect(
      prepareNativeAttachmentPromptContent(baseInput),
    ).rejects.toMatchObject({ reasonCode: 'attachment_size_mismatch' })

    const document = await writeAttachment('attachment-2--doc.pdf', Buffer.from('%PDF'), {
      id: 'attachment-2',
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
    })
    await expect(
      prepareNativeAttachmentPromptContent({
        ...baseInput,
        message: { ...message, attachments: [document] },
      }),
    ).rejects.toMatchObject({ reasonCode: 'attachment_type_unsupported' })
  })

  it('rejects path traversal and child symlink redirection', async () => {
    const attachment = await writeAttachment(
      'attachment-1--image.png',
      Buffer.from('image-bytes'),
    )
    const outside = join(root, 'outside.png')
    await writeFile(outside, Buffer.from('image-bytes'))
    await expect(
      prepareNativeAttachmentPromptContent({
        message: {
          ...message,
          attachments: [{
            ...attachment,
            filePath: join(root, 'team-a', '..', 'outside.png'),
          }],
        },
        provider: 'codex',
        replyProtocolText: 'protocol',
        runtimeInstanceId: 'runtime-1',
      }),
    ).rejects.toBeInstanceOf(NativeAttachmentPreparationError)

    await rm(attachment.filePath)
    await symlink(outside, attachment.filePath)
    await expect(
      prepareNativeAttachmentPromptContent({
        message: { ...message, attachments: [attachment] },
        provider: 'codex',
        replyProtocolText: 'protocol',
        runtimeInstanceId: 'runtime-1',
      }),
    ).rejects.toMatchObject({ reasonCode: 'attachment_path_invalid' })
  })
})
