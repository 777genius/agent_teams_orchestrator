import { constants, lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { getErrnoCode } from './errors.js'
import { writeFileAtomic } from './atomicWrite.js'
import * as lockfile from './lockfile.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import { safeWindowsPathSegment } from './windowsReservedNames.js'
import { resolveTeammateMessageId, normalizeTeammateMessage, isRawMailboxMessage,
  hasVerifiedMailboxMessage, type RawTeammateMessage } from './teammateMailboxRecord.js'
import type { TeammateMessage, ExplicitRootVerifiedMailboxWriteResult } from './teammateMailbox.js'
export type { ExplicitRootVerifiedMailboxWriteResult } from './teammateMailbox.js'
const LOCK_OPTIONS = { retries: { retries: 10, minTimeout: 5, maxTimeout: 100 } }

/**
 * Hosted-control-only mailbox primitive. Unlike the compatibility helpers above,
 * this never consults process globals and never retries after attempting a write.
 */
export async function writeToMailboxAtCanonicalTeamRootVerified(input: {
  canonicalTeamRoot: string
  recipientName: string
  message: Omit<RawTeammateMessage, 'read'>
}): Promise<ExplicitRootVerifiedMailboxWriteResult> {
  if (
    !isAbsolute(input.canonicalTeamRoot) ||
    (await realpath(input.canonicalTeamRoot)) !== input.canonicalTeamRoot
  ) {
    throw new Error('Mailbox team root must be canonical and absolute')
  }
  await assertPrivateDirectory(input.canonicalTeamRoot)
  const safeRecipient = safeWindowsPathSegment(input.recipientName.replace(/[^a-zA-Z0-9_-]/g, '-'))
  if (safeRecipient !== input.recipientName)
    throw new Error('Unsafe mailbox recipient')
  const inboxDir = join(input.canonicalTeamRoot, 'inboxes')
  try {
    await mkdir(inboxDir, { mode: 0o700 })
  } catch (error) {
    if (getErrnoCode(error) !== 'EEXIST') throw error
  }
  const inboxDirIdentity = await assertPrivateDirectory(inboxDir)
  const inboxPath = join(inboxDir, `${safeRecipient}.json`)
  try {
    await writeFile(inboxPath, '[]', {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    if (getErrnoCode(error) !== 'EEXIST') throw error
  }
  await assertPrivateRegularFile(inboxPath)

  const messageId = resolveTeammateMessageId(input.message)
  const canonicalMessage = normalizeTeammateMessage({
    ...input.message,
    messageId,
    read: false,
  })
  const release = await lockfile.lock(inboxPath, {
    lockfilePath: `${inboxPath}.lock`,
    realpath: false,
    ...LOCK_OPTIONS,
  })
  try {
    await assertSamePrivateDirectory(inboxDir, inboxDirIdentity)
    await assertPrivateRegularFile(inboxPath)
    const messages = await readMailboxPathStrict(inboxPath)
    const existing = messages.filter(row => row.messageId === messageId)
    if (existing.length > 0) {
      return existing.length === 1 &&
        hasVerifiedMailboxMessage(existing, canonicalMessage)
        ? {
            kind: 'idempotent_replay',
            messageId,
            inboxPath,
            attempts: 0,
            totalMessages: messages.length,
          }
        : { kind: 'conflict' }
    }

    messages.push(canonicalMessage)
    await assertSamePrivateDirectory(inboxDir, inboxDirIdentity)
    await assertPrivateRegularFile(inboxPath)
    await writeFileAtomic(inboxPath, jsonStringify(messages, null, 2), {
      mode: 0o600,
    })
    await assertSamePrivateDirectory(inboxDir, inboxDirIdentity)
    await assertPrivateRegularFile(inboxPath)
    await fsyncFileAndParentDirectory(inboxPath)
    const readback = await readMailboxPathStrict(inboxPath)
    const writtenRows = readback.filter(row => row.messageId === messageId)
    if (
      writtenRows.length !== 1 ||
      !hasVerifiedMailboxMessage(writtenRows, canonicalMessage)
    ) {
      throw new Error(
        `Explicit-root mailbox write was not observed: ${messageId}`,
      )
    }
    return {
      kind: 'written',
      messageId,
      inboxPath,
      attempts: 1,
      totalMessages: readback.length,
    }
  } finally {
    await release()
  }
}

async function readMailboxPathStrict(
  inboxPath: string,
): Promise<TeammateMessage[]> {
  const handle = await open(
    inboxPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const [stat, current] = await Promise.all([handle.stat(), lstat(inboxPath)])
    if (
      !stat.isFile() ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      stat.dev !== current.dev ||
      stat.ino !== current.ino ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid())
    ) {
      throw new Error(`mailbox path was substituted: ${inboxPath}`)
    }
    const parsed = jsonParse(await handle.readFile('utf8'))
    if (
      !Array.isArray(parsed) ||
      parsed.some(row => !isRawMailboxMessage(row))
    ) {
      throw new Error(`mailbox file is not a valid message array: ${inboxPath}`)
    }
    return parsed.map(normalizeTeammateMessage)
  } finally {
    await handle.close()
  }
}

type PrivatePathIdentity = { dev: number; ino: number }

async function assertPrivateDirectory(
  path: string,
): Promise<PrivatePathIdentity> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const [stat, current, canonical] = await Promise.all([
      handle.stat(),
      lstat(path),
      realpath(path),
    ])
    if (
      !stat.isDirectory() ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      stat.dev !== current.dev ||
      stat.ino !== current.ino ||
      canonical !== path ||
      (stat.mode & 0o022) !== 0 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid())
    ) {
      throw new Error(`Unsafe explicit-root mailbox directory: ${path}`)
    }
    return { dev: stat.dev, ino: stat.ino }
  } finally {
    await handle.close()
  }
}

async function assertSamePrivateDirectory(
  path: string,
  expected: PrivatePathIdentity,
): Promise<void> {
  const actual = await assertPrivateDirectory(path)
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(`Explicit-root mailbox directory was substituted: ${path}`)
  }
}

async function assertPrivateRegularFile(
  path: string,
): Promise<PrivatePathIdentity> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const [stat, current] = await Promise.all([handle.stat(), lstat(path)])
    if (
      !stat.isFile() ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      stat.dev !== current.dev ||
      stat.ino !== current.ino ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid())
    ) {
      throw new Error(`Unsafe explicit-root mailbox file: ${path}`)
    }
    return { dev: stat.dev, ino: stat.ino }
  } finally {
    await handle.close()
  }
}

async function fsyncFileAndParentDirectory(path: string): Promise<void> {
  const parentPath = dirname(path)
  const parent = await open(
    parentPath,
    constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const file = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    )
    try {
      const [fileStat, currentFile, parentStat, currentParent] =
        await Promise.all([
          file.stat(),
          lstat(path),
          parent.stat(),
          lstat(parentPath),
        ])
      if (
        !fileStat.isFile() ||
        !currentFile.isFile() ||
        currentFile.isSymbolicLink() ||
        fileStat.dev !== currentFile.dev ||
        fileStat.ino !== currentFile.ino ||
        (fileStat.mode & 0o077) !== 0 ||
        (process.getuid?.() !== undefined &&
          fileStat.uid !== process.getuid()) ||
        !parentStat.isDirectory() ||
        !currentParent.isDirectory() ||
        currentParent.isSymbolicLink() ||
        parentStat.dev !== currentParent.dev ||
        parentStat.ino !== currentParent.ino ||
        (parentStat.mode & 0o022) !== 0 ||
        (process.getuid?.() !== undefined &&
          parentStat.uid !== process.getuid())
      ) {
        throw new Error(
          'Explicit-root mailbox path was substituted before fsync',
        )
      }
      await file.sync()
      await parent.sync()
    } finally {
      await file.close()
    }
  } finally {
    await parent.close()
  }
}
