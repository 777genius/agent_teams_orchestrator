import path from 'node:path'

import {
  OpenCodeSafePublicationDirectory,
  type OpenCodeSafePublicationTransaction,
} from './OpenCodeSafePublication.js'

type PublishAuth = (
  directoryPath: string,
  fileName: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
  deadlineAtMs?: number,
) => Promise<OpenCodeSafePublicationTransaction | null | void>

type ProfileAuthTransactionRecord = Readonly<{
  transaction: OpenCodeSafePublicationTransaction
  profile: object
  signal?: AbortSignal
}>
const profileAuthTransactions = new WeakMap<object, ProfileAuthTransactionRecord>()
const signalAuthTransactions = new WeakMap<AbortSignal, ProfileAuthTransactionRecord>()
const settlementReaper = new Set<ProfileAuthTransactionRecord>()

function reapRollback(record: ProfileAuthTransactionRecord): void {
  if (settlementReaper.has(record)) return
  settlementReaper.add(record)
  let attempts = 0
  const retry = (): void => {
    attempts += 1
    void record.transaction.rollback().then(() => {
      settlementReaper.delete(record)
      profileAuthTransactions.delete(record.profile)
      if (record.signal) signalAuthTransactions.delete(record.signal)
    }, () => {
      // Bounded owner-side settlement. The native client's independent
      // retained-root deadline is the final conservative lease reaper.
      if (attempts < 8) {
        const timer = setTimeout(retry, Math.min(4_000, 100 * 2 ** attempts))
        timer.unref?.()
      } else {
        // The native owner deadline has conservatively closed every retained
        // NTFS handle by this point and left recovery-required evidence. Do
        // not retain an otherwise unreachable profile record indefinitely.
        const timer = setTimeout(() => {
          settlementReaper.delete(record)
          profileAuthTransactions.delete(record.profile)
          if (record.signal) signalAuthTransactions.delete(record.signal)
        }, 125_000)
        timer.unref?.()
      }
    })
  }
  retry()
}

const publishAuth: PublishAuth = async (directoryPath, fileName, bytes, signal, deadlineAtMs) => {
  const directory = await OpenCodeSafePublicationDirectory.open(directoryPath, {
    abortSignal: signal, deadline: deadlineAtMs,
  })
  let transaction: OpenCodeSafePublicationTransaction | null = null
  try {
    await directory.writeFileAtomic(fileName, bytes, 0o600, signal, {
      retainTransaction: retained => { transaction = retained },
    })
  } catch (error) {
    await directory.close().catch(() => undefined)
    throw error
  }
  if (!transaction) {
    await directory.close().catch(() => undefined)
    throw new Error('OpenCode scoped profile auth transaction unavailable')
  }
  return Object.freeze({
    commit: async () => {
      await transaction!.commit()
      await directory.close()
    },
    rollback: async () => {
      // The retained directory is part of the retryable transaction. Releasing
      // it after a failed rollback would let the root or backup object be
      // replaced before the exact same settlement is retried.
      await transaction!.rollback()
      await directory.close()
    },
  })
}

export async function finalizeOpenCodeScopedProfileAuth(preparedProfile: object): Promise<void> {
  const record = profileAuthTransactions.get(preparedProfile)
  if (!record) return
  await record.transaction.commit()
  profileAuthTransactions.delete(preparedProfile)
  if (record.signal) signalAuthTransactions.delete(record.signal)
}

export async function rollbackOpenCodeScopedProfileAuth(preparedProfile: object): Promise<void> {
  const record = profileAuthTransactions.get(preparedProfile)
  if (!record) return
  try { await record.transaction.rollback() } catch (error) { reapRollback(record); throw error }
  profileAuthTransactions.delete(preparedProfile)
  if (record.signal) signalAuthTransactions.delete(record.signal)
}

export async function rollbackOpenCodeScopedProfileAuthSignal(signal: AbortSignal): Promise<void> {
  const record = signalAuthTransactions.get(signal)
  if (!record) return
  try { await record.transaction.rollback() } catch (error) { reapRollback(record); throw error }
  signalAuthTransactions.delete(signal)
  profileAuthTransactions.delete(record.profile)
}

/** The auth write is the final awaited preparation phase. */
export async function commitOpenCodeScopedProfileAuth<T>(input: Readonly<{
  managedAuthPath: string
  managedAuthBytes: Uint8Array
  preparedProfile: T
  abortSignal?: AbortSignal
  deadlineAtMs?: number
  /** Deterministic fake-only publisher seam. */
  publish?: PublishAuth
}>): Promise<T> {
  if (input.abortSignal?.aborted) {
    throw input.abortSignal.reason instanceof Error
      ? input.abortSignal.reason
      : new Error('OpenCode scoped profile preparation cancelled')
  }
  const transaction = await (input.publish ?? publishAuth)(
    path.dirname(input.managedAuthPath),
    path.basename(input.managedAuthPath),
    input.managedAuthBytes,
    input.abortSignal,
    input.deadlineAtMs,
  )
  if (transaction && input.preparedProfile && typeof input.preparedProfile === 'object') {
    const purpose = Object.getOwnPropertyDescriptor(input.preparedProfile, 'purpose')?.value
    if (purpose === 'provider-catalog') {
      const record = Object.freeze({ transaction, profile: input.preparedProfile,
        ...(input.abortSignal ? { signal: input.abortSignal } : {}) })
      profileAuthTransactions.set(input.preparedProfile, record)
      if (input.abortSignal) signalAuthTransactions.set(input.abortSignal, record)
    } else await transaction.commit()
  }
  // Deliberately no post-write abort check or fallible identity/path phase.
  return input.preparedProfile
}
