import { constants, type Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const OWNER_FILE = '.agent-teams-bootstrap-owner.json'
const SPEC_FILE = 'bootstrap.json'
const MAX_OWNER_BYTES = 4096

function sameFile(expected: Stats, actual: Stats): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino
}

function isPrivate(stat: Stats): boolean {
  return (
    (typeof process.getuid !== 'function' || stat.uid === process.getuid()) &&
    (stat.mode & 0o077) === 0
  )
}

type OwnedSpec = {
  directory: string
  directoryStat: Stats
  specStat: Stats
  ownerPath: string
  ownerStat: Stats
}

async function leaseOwnedSpec(specPath: string): Promise<OwnedSpec | null> {
  const directory = dirname(resolve(specPath))
  if (
    basename(specPath) !== SPEC_FILE ||
    !basename(directory).startsWith('agent-teams-bootstrap-')
  ) {
    return null
  }
  try {
    if (await fs.realpath(dirname(directory)) !== await fs.realpath(tmpdir())) {
      return null
    }
    const directoryStat = await fs.lstat(directory)
    if (!directoryStat.isDirectory() || !isPrivate(directoryStat)) {
      return null
    }
    const specStat = await fs.lstat(specPath)
    if (!specStat.isFile() || !isPrivate(specStat)) {
      return null
    }
    const ownerPath = join(directory, OWNER_FILE)
    const ownerStat = await fs.lstat(ownerPath)
    if (!ownerStat.isFile() || !isPrivate(ownerStat) || ownerStat.size > MAX_OWNER_BYTES) {
      return null
    }
    const handle = await fs.open(ownerPath, constants.O_RDWR | constants.O_NOFOLLOW)
    try {
      if (!sameFile(ownerStat, await handle.stat())) {
        return null
      }
      const marker = JSON.parse(await handle.readFile('utf8'))
      if (
        marker?.version !== 1 ||
        marker.kind !== 'agent-teams-bootstrap' ||
        marker.specFile !== SPEC_FILE ||
        !Number.isSafeInteger(marker.ownerPid) || marker.ownerPid <= 0 ||
        (marker.consumerPid !== undefined &&
          (!Number.isSafeInteger(marker.consumerPid) || marker.consumerPid <= 0))
      ) {
        return null
      }
      // Publish the live consumer before the first secret read. Startup cleanup
      // preserves this directory if the desktop owner exits during bootstrap.
      const lease = JSON.stringify({ ...marker, consumerPid: process.pid })
      await handle.write(lease, 0, 'utf8')
      await handle.truncate(Buffer.byteLength(lease))
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (
      !sameFile(directoryStat, await fs.lstat(directory)) ||
      !sameFile(specStat, await fs.lstat(specPath)) ||
      !sameFile(ownerStat, await fs.lstat(ownerPath))
    ) {
      throw new Error('owned team bootstrap files changed before consumption')
    }
    return { directory, directoryStat, specStat, ownerPath, ownerStat }
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function removeSameFile(filePath: string, expected: Stats): Promise<void> {
  try {
    const actual = await fs.lstat(filePath)
    if (!actual.isFile() || !sameFile(expected, actual)) {
      throw new Error('owned team bootstrap file changed during consumption')
    }
    await fs.unlink(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}

/** Consume only the private one-shot file created by the desktop writer. */
export async function withOwnedTeamBootstrapSpec<T>(
  specPath: string,
  read: () => Promise<T>,
): Promise<T> {
  const owned = await leaseOwnedSpec(specPath)
  try {
    return await read()
  } finally {
    if (owned) {
      try {
        const currentDirectory = await fs.lstat(owned.directory)
        if (!currentDirectory.isDirectory() || !sameFile(owned.directoryStat, currentDirectory)) {
          throw new Error('owned team bootstrap directory changed during consumption')
        }
        await removeSameFile(specPath, owned.specStat)
        await removeSameFile(owned.ownerPath, owned.ownerStat)
        await fs.rmdir(owned.directory)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    }
  }
}
