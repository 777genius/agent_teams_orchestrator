import { afterEach, describe, expect, test } from 'bun:test'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readCodexConversationOwnerReference,
  writeCodexConversationOwnerReference,
  type CodexConversationOwnerReference,
} from './conversationOwnerReference.js'

const roots: string[] = []
const reference: CodexConversationOwnerReference = {
  schemaVersion: 1,
  sessionId: 'TEST-session',
  ownerKey: 'TEST-owner',
}
const flushed = { flush: async () => {} }
const ownerRow = (value: unknown = reference) =>
  JSON.stringify({ type: 'codex-conversation-owner', ...(value as object) }) + '\n'
const userRow = (uuid: string, sessionId = reference.sessionId) =>
  JSON.stringify({ type: 'user', uuid, sessionId, message: { content: 'TEST input' } }) + '\n'

async function transcriptPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'TEST-codex-owner-'))
  roots.push(root)
  return join(root, 'session.jsonl')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Codex host conversation owner reference', () => {
  test('flushes prior host writes before committing the owner to the captured file', async () => {
    const path = await transcriptPath()
    let releaseFlush!: () => void
    let flushStarted!: () => void
    const started = new Promise<void>(resolve => { flushStarted = resolve })
    const barrier = new Promise<void>(resolve => { releaseFlush = resolve })
    const write = writeCodexConversationOwnerReference(path, reference, {
      flush: async () => {
        flushStarted()
        await barrier
        await writeFile(path, userRow('turn-1'))
      },
    })
    await started
    expect(await readCodexConversationOwnerReference(path)).toBeNull()
    releaseFlush()
    await write
    expect(await readFile(path, 'utf8')).toBe(userRow('turn-1') + ownerRow())
    expect(await readCodexConversationOwnerReference(path, 'turn-1')).toEqual(reference)
  })

  test('does not write an owner when flushing the host transcript fails', async () => {
    const path = await transcriptPath()
    await expect(writeCodexConversationOwnerReference(path, reference, {
      flush: async () => { throw new Error('TEST disk write failed') },
    })).rejects.toThrow('TEST disk write failed')
    expect(await readCodexConversationOwnerReference(path)).toBeNull()
  })

  test('keeps identical writes idempotent and refuses owner replacement', async () => {
    const path = await transcriptPath()
    await writeCodexConversationOwnerReference(path, reference, flushed)
    await writeCodexConversationOwnerReference(path, reference, flushed)
    expect(await readFile(path, 'utf8')).toBe(ownerRow())
    await expect(writeCodexConversationOwnerReference(path, {
      ...reference, ownerKey: 'OTHER-owner',
    }, flushed)).rejects.toThrow('Cannot replace')
    expect(await readCodexConversationOwnerReference(path)).toEqual(reference)
  })

  test('separates a prior complete row without a trailing newline', async () => {
    const path = await transcriptPath()
    await writeFile(path, userRow('turn-1').trimEnd())
    await writeCodexConversationOwnerReference(path, reference, flushed)
    expect(await readFile(path, 'utf8')).toBe(userRow('turn-1') + ownerRow())
  })

  test('retains owner and host-turn authority before a large compacted history', async () => {
    const path = await transcriptPath()
    const filler = JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(1024) } }) + '\n'
    await writeFile(path, userRow('turn-1') + ownerRow() + filler.repeat(5200))
    await appendFile(path, JSON.stringify({ type: 'system', subtype: 'compact_boundary' }) + '\n')
    expect(await readCodexConversationOwnerReference(path, 'turn-1')).toEqual(reference)
  })

  test('never treats quoted or nested owner metadata as ownership authority', async () => {
    const path = await transcriptPath()
    const nested = { type: 'codex-conversation-owner', ...reference }
    await writeFile(path, [
      JSON.stringify({ type: 'user', message: { content: JSON.stringify(nested) } }),
      JSON.stringify({ type: 'assistant', tool: nested }),
      // Unrelated interrupted text can also mention the marker without being metadata.
      '{"type":"user","message":{"content":"codex-conversation-owner',
    ].join('\n'))
    expect(await readCodexConversationOwnerReference(path)).toBeNull()
  })

  test.each([
    '{"type":"codex-conversation-owner","schemaVersion":1,',
    ownerRow({ ...reference, schemaVersion: 2 }),
    ownerRow({ ...reference, ownerKey: '' }),
    ownerRow({ ...reference, sessionId: null }),
    ownerRow() + ownerRow({ ...reference, ownerKey: 'OTHER-owner' }),
  ])('refuses malformed, unsupported, or conflicting owner metadata', async raw => {
    const path = await transcriptPath()
    await writeFile(path, raw)
    await expect(readCodexConversationOwnerReference(path)).rejects.toThrow()
    await expect(writeCodexConversationOwnerReference(path, reference, flushed)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe(raw)
  })

  test.each([
    '',
    userRow('another-turn'),
    userRow('turn-1', 'OTHER-session'),
    JSON.stringify({ type: 'system', uuid: 'turn-1', sessionId: reference.sessionId }) + '\n',
    JSON.stringify({ type: 'user', uuid: 'another-turn', message: { content: userRow('turn-1') } }) + '\n',
  ])('requires an authoritative user turn from the same session', async history => {
    const path = await transcriptPath()
    await writeFile(path, ownerRow() + history)
    await expect(readCodexConversationOwnerReference(path, 'turn-1')).rejects.toThrow('recorded host turn')
  })

  test('a missing transcript is fresh only when no recorded host turn is expected', async () => {
    const path = await transcriptPath()
    expect(await readCodexConversationOwnerReference(path)).toBeNull()
    await expect(readCodexConversationOwnerReference(path, 'turn-1')).rejects.toThrow('recorded host turn')
    // Read failures other than absence must not select the legacy/fresh path.
    await expect(readCodexConversationOwnerReference(roots.at(-1)!)).rejects.toThrow()
  })
})
