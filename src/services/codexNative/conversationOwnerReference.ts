import { createReadStream } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'

const OWNER_REFERENCE_TYPE = 'codex-conversation-owner'
const OWNER_REFERENCE_PREFIX = /^\s*\{\s*"type"\s*:\s*"codex-conversation-owner/

export type CodexConversationOwnerReference = {
  schemaVersion: 1
  sessionId: string
  ownerKey: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseReference(value: unknown): CodexConversationOwnerReference {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.sessionId !== 'string' ||
    !value.sessionId.trim() ||
    typeof value.ownerKey !== 'string' ||
    !value.ownerKey.trim()
  ) {
    throw new Error('Invalid Codex conversation owner reference in host transcript.')
  }
  return {
    schemaVersion: 1,
    sessionId: value.sessionId,
    ownerKey: value.ownerKey,
  }
}

function sameReference(
  left: CodexConversationOwnerReference,
  right: CodexConversationOwnerReference,
): boolean {
  return left.sessionId === right.sessionId && left.ownerKey === right.ownerKey
}

/**
 * Read host-owned metadata from the complete physical transcript. The normal
 * transcript loader can omit pre-compaction rows and tolerate read failures;
 * neither behavior can establish that an upgraded conversation has no owner.
 * Text inside a user/tool message is never conversation ownership authority.
 */
export async function readCodexConversationOwnerReference(
  transcriptPath: string,
  expectedHostTurnId?: string | null,
): Promise<CodexConversationOwnerReference | null> {
  const stream = createReadStream(transcriptPath, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let reference: CodexConversationOwnerReference | null = null
  const matchingTurnSessions = new Set<string>()
  try {
    for await (const line of lines) {
      if (
        !line.includes(OWNER_REFERENCE_TYPE) &&
        (!expectedHostTurnId || !line.includes(expectedHostTurnId))
      ) {
        continue
      }
      let entry: unknown
      try {
        entry = JSON.parse(line)
      } catch {
        if (OWNER_REFERENCE_PREFIX.test(line)) {
          throw new Error('Malformed Codex conversation owner reference in host transcript.')
        }
        // Match the existing transcript reader's tolerance of unrelated partial
        // rows. A malformed row cannot satisfy the host-turn check below.
        continue
      }
      if (!isObject(entry)) continue
      if (entry.type === OWNER_REFERENCE_TYPE) {
        const next = parseReference(entry)
        if (reference && !sameReference(reference, next)) {
          throw new Error('Conflicting Codex conversation owner references in host transcript.')
        }
        reference = next
      }
      if (
        expectedHostTurnId &&
        entry.type === 'user' &&
        entry.uuid === expectedHostTurnId &&
        typeof entry.sessionId === 'string'
      ) {
        matchingTurnSessions.add(entry.sessionId)
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  } finally {
    lines.close()
    stream.destroy()
  }
  if (
    expectedHostTurnId &&
    (!reference || !matchingTurnSessions.has(reference.sessionId))
  ) {
    throw new Error('Codex conversation no longer matches its recorded host turn. Start a new session.')
  }
  return reference
}

/**
 * The caller captures transcriptPath at admission, verifies persistence is
 * enabled, and holds the conversation lock. Commit the host reference before
 * submitting native input so a lost binding can never look like legacy history.
 * This is metadata, not a model message or a new parent in the host message chain.
 */
export async function writeCodexConversationOwnerReference(
  transcriptPath: string,
  reference: CodexConversationOwnerReference,
  options: { flush?: () => Promise<void> } = {},
): Promise<void> {
  const validated = parseReference(reference)
  const flush = options.flush ?? (await import('../../utils/sessionStorage.js')).flushSessionStorage
  await flush()

  const existing = await readCodexConversationOwnerReference(transcriptPath)
  if (existing) {
    if (!sameReference(existing, validated)) {
      throw new Error('Cannot replace the Codex conversation owner of an existing host session.')
    }
    return
  }

  await mkdir(dirname(transcriptPath), { recursive: true, mode: 0o700 })
  const file = await open(transcriptPath, 'a+', 0o600)
  try {
    const { size } = await file.stat()
    let separator = ''
    if (size > 0) {
      const lastByte = Buffer.alloc(1)
      await file.read(lastByte, 0, 1, size - 1)
      if (lastByte[0] !== 0x0a) separator = '\n'
    }
    await file.writeFile(
      separator + JSON.stringify({ type: OWNER_REFERENCE_TYPE, ...validated }) + '\n',
      'utf8',
    )
    await file.sync()
  } finally {
    await file.close()
  }
}
