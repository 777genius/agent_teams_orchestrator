import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

import { assertPrivateWindowsAcl, assertSafeDarwinMcpAcl, assertWindowsMcpAncestry } from './OpenCodePrivateMcpAcl.js'

// Storage boundary v1. ACL policy is ported from agent-teams-ai local-http-auth
// windowsPrivateAcl.ts at d2f7f3df79db71b3f3718b99636f352d46d2402d;
// source SHA256 838135a52e8fe58fe7aaa7c0560a55d583f91113a79540ac525dc231f4fba7e9.
// No credentials reach an ACL subprocess. Existing paths are rejected, never repaired.
const unsafe = () => new Error('Cursor MCP credential storage is not private and owner controlled')
const sameFile = (left: Stats, right: Stats) => left.dev === right.dev && left.ino === right.ino

async function validateAncestry(root: string): Promise<void> {
  if (!path.isAbsolute(root) || path.resolve(root) !== root) throw unsafe()
  const ancestors: string[] = []
  let cursor = root
  while (true) {
    const entry = await lstat(cursor)
    ancestors.push(cursor)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw unsafe()
    if (process.platform === 'darwin') assertSafeDarwinMcpAcl(cursor, false)
    if (process.getuid) {
      const owner = process.getuid()
      // Root-owned sticky system temp directories cannot rename another user's child.
      const systemTemporary = cursor !== root && entry.uid === 0 && (entry.mode & 0o1000) !== 0
      if ((cursor === root && entry.uid !== owner)
        || (entry.uid !== owner && entry.uid !== 0)
        || ((entry.mode & 0o022) !== 0 && !systemTemporary)) throw unsafe()
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  if (await realpath(root) !== root) throw unsafe()
  if (process.platform === 'win32') assertWindowsMcpAncestry(ancestors)
}

async function validatePrivate(target: string, directory = false): Promise<Stats> {
  const entry = await lstat(target)
  if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile())
    || (!directory && entry.nlink !== 1)
    || (process.getuid && (entry.uid !== process.getuid()
      || (entry.mode & 0o777) !== (directory ? 0o700 : 0o600)))) throw unsafe()
  if (process.platform === 'win32') assertPrivateWindowsAcl(target)
  if (process.platform === 'darwin') assertSafeDarwinMcpAcl(target, true)
  return entry
}

/** Private generation-local config for both the plugin reader and its mcptool shim. */
export async function publishPrivateCursorMcpConfig(stateRoot: string, config: unknown): Promise<string> {
  // The generation state already exists. Validate it before creating even an empty child.
  await validateAncestry(stateRoot)
  const directory = path.join(stateRoot, 'mcp-credentials')
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  const inspectDirectory = async () => {
    await validateAncestry(directory)
    await validatePrivate(directory, true)
  }
  await inspectDirectory()
  const file = path.join(directory, 'opencode.json')
  const inspectFile = async (): Promise<Stats | null> => {
    try { await lstat(file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    return validatePrivate(file)
  }
  const previous = await inspectFile()
  const temporary = path.join(directory, `${randomUUID()}.tmp`)
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
    | (constants.O_NOFOLLOW ?? 0), 0o600)
  const opened = await handle.stat()
  let closed = false
  try {
    // Verify actual inherited Windows ACLs and owner/mode before writing any secret bytes.
    const empty = await validatePrivate(temporary)
    if (!sameFile(opened, empty) || !opened.isFile() || opened.nlink !== 1) throw unsafe()
    await inspectDirectory()
    await handle.writeFile(`${JSON.stringify(config)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    closed = true
    await inspectDirectory()
    const current = await inspectFile()
    if ((previous === null) !== (current === null)
      || (previous && current && !sameFile(previous, current))) throw unsafe()
    if (!sameFile(opened, await validatePrivate(temporary))) throw unsafe()
    await rename(temporary, file)
    if (!sameFile(opened, await validatePrivate(file))) throw unsafe()
    return file
  } finally {
    if (!closed) await handle.close()
    // Delete only our own remaining empty/staged inode, never a replacement object.
    try {
      if (sameFile(opened, await lstat(temporary))) await unlink(temporary)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
