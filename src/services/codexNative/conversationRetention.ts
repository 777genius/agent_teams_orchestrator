import type { Stats } from 'node:fs'
import { lstat, readFile, realpath, rm } from 'node:fs/promises'
import path from 'node:path'

import { lock } from '../../utils/lockfile.js'
import { codexConversationOwnerKey, type CodexConversationOwner } from './conversationBinding.js'
import { readCodexConversationOwnerReference } from './conversationOwnerReference.js'

type TranscriptFs = {
  stat: (file: string) => Promise<Stats>
  unlink: (file: string) => Promise<void>
}

type RetentionDeps = {
  lock?: typeof lock
  removeOwnedDirectory?: (directory: string) => Promise<void>
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

async function statIfPresent(file: string): Promise<Stats | null> {
  try { return await lstat(file) } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

function isOwner(value: unknown): value is CodexConversationOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const owner = value as Record<string, unknown>
  return typeof owner.sessionId === 'string' &&
    typeof owner.transcriptPath === 'string' && path.isAbsolute(owner.transcriptPath) &&
    typeof owner.cwd === 'string' && path.isAbsolute(owner.cwd) &&
    typeof owner.sourceProfile === 'string' && path.isAbsolute(owner.sourceProfile) &&
    (owner.agentId === null || typeof owner.agentId === 'string') &&
    (owner.teamName === null || typeof owner.teamName === 'string')
}

function assertDirectory(stats: Stats, label: string): void {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Codex retention refuses a non-directory or linked ${label}.`)
  }
}

/**
 * Retain the existing transcript cutoff, but expire its owned Codex rollout at
 * the same boundary. No orphan sweep and no path taken directly from metadata.
 */
export async function unlinkExpiredCodexAwareTranscript(
  transcriptPath: string,
  cutoffDate: Date,
  fsImpl: TranscriptFs,
  deps: RetentionDeps = {},
): Promise<boolean> {
  const candidate = await statIfPresent(transcriptPath)
  if (!candidate) return false
  if (!candidate.isFile() || candidate.isSymbolicLink()) {
    throw new Error('Codex retention requires a regular owning transcript.')
  }
  if (!(candidate.mtime < cutoffDate)) return false
  const transcript = await realpath(transcriptPath)
  let compromised = false
  const assertOwned = (): void => {
    if (compromised) throw new Error('Codex retention lost conversation ownership.')
  }
  let unlock: () => Promise<void>
  try {
    unlock = await (deps.lock ?? lock)(transcript, {
      lockfilePath: `${transcript}.codex-native.lock`, realpath: false, retries: 0,
      onCompromised: () => { compromised = true },
    })
  } catch (error) {
    if (errorCode(error) === 'ELOCKED') return false
    throw error
  }

  try {
    assertOwned()
    const lockedStats = await statIfPresent(transcript)
    if (!lockedStats) return false
    if (!lockedStats.isFile() || lockedStats.isSymbolicLink()) {
      throw new Error('Codex retention transcript changed to a non-regular file.')
    }
    if (!(lockedStats.mtime < cutoffDate)) return false
    const reference = await readCodexConversationOwnerReference(transcript)
    let ownedDirectory: string | null = null

    if (reference) {
      if (!/^[0-9a-f]{64}$/.test(reference.ownerKey)) {
        throw new Error('Codex retention refuses an invalid native owner key.')
      }
      const nativeRoot = path.join(path.dirname(transcript), 'codex-native')
      const rootStats = await statIfPresent(nativeRoot)
      if (rootStats) {
        assertDirectory(rootStats, 'native storage root')
        const directory = path.join(nativeRoot, reference.ownerKey)
        const directoryStats = await statIfPresent(directory)
        if (directoryStats) {
          assertDirectory(directoryStats, 'native owner directory')
          const bindingPath = path.join(directory, 'binding.json')
          const bindingStats = await statIfPresent(bindingPath)
          if (!bindingStats?.isFile() || bindingStats.isSymbolicLink() || bindingStats.size > 64 * 1024) {
            throw new Error('Codex retention requires a regular owned native binding.')
          }
          const binding = JSON.parse(await readFile(bindingPath, 'utf8'))
          if (!binding || binding.schemaVersion !== 1 || binding.ownerKey !== reference.ownerKey ||
              !isOwner(binding.owner) || binding.owner.sessionId !== reference.sessionId ||
              binding.owner.transcriptPath !== transcript ||
              codexConversationOwnerKey(binding.owner) !== reference.ownerKey ||
              !['creating', 'active', 'ready'].includes(binding.state)) {
            throw new Error('Codex retention refuses mismatched native ownership.')
          }
          // An unconfirmed native child can outlive its runtime and lock. Keep
          // both records until recovery establishes a safe terminal boundary.
          if (binding.state !== 'ready') return false
          const sessionsStats = await statIfPresent(path.join(directory, 'sessions'))
          if (sessionsStats) assertDirectory(sessionsStats, 'sessions directory')
          ownedDirectory = directory
        }
      }
    }

    // Metadata reads can take time. Re-check the actual file immediately before
    // deletion; a turn admitted before this lock must not lose refreshed history.
    const finalStats = await fsImpl.stat(transcript)
    assertOwned()
    if (!(finalStats.mtime < cutoffDate) ||
        finalStats.dev !== lockedStats.dev || finalStats.ino !== lockedStats.ino) return false
    if (ownedDirectory) {
      await (deps.removeOwnedDirectory ?? (directory => rm(directory, { recursive: true, force: true })))(ownedDirectory)
    }
    // Native data first: if removal fails, the transcript still carries the
    // owner marker and a later retention pass can retry the same exact target.
    assertOwned()
    await fsImpl.unlink(transcript)
    return true
  } finally {
    await unlock()
  }
}
