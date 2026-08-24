import path from 'node:path'

import {
  OpenCodeAtomicPublicationSettlementError,
  OpenCodeSafePublicationDirectory,
  settleOpenCodeAtomicPublicationCommit,
  type OpenCodeSafePublicationTransaction,
} from './OpenCodeSafePublication.js'

export { OpenCodeAtomicPublicationSettlementError }

type PublishAuth = (
  directoryPath: string,
  fileName: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
  deadlineAtMs?: number,
) => Promise<ProfileAuthPublicationTransaction | null | void>

type ProfileAuthPublicationTransaction = OpenCodeSafePublicationTransaction & Readonly<{
  /** Closes the exact directory/authority which owns commit and rollback. */
  close?(): Promise<void>
}>

type ProfileAuthTransactionRecord = Readonly<{
  transaction: ProfileAuthPublicationTransaction
  profile: object
  signal?: AbortSignal
}>
const profileAuthTransactions = new WeakMap<object, ProfileAuthTransactionRecord>()
const signalAuthTransactions = new WeakMap<AbortSignal, ProfileAuthTransactionRecord>()
const settlementReaper = new Set<ProfileAuthTransactionRecord>()

async function closeProfileAuthTransaction(transaction: ProfileAuthPublicationTransaction): Promise<void> {
  await transaction.close?.()
}

async function commitAndCloseProfileAuthTransaction(
  transaction: ProfileAuthPublicationTransaction,
): Promise<void> {
  let settlementError: unknown
  try { await settleOpenCodeAtomicPublicationCommit(transaction) }
  catch (error) { settlementError = error }
  try { await closeProfileAuthTransaction(transaction) }
  catch (closeError) {
    const state = settlementError instanceof OpenCodeAtomicPublicationSettlementError
      ? settlementError.publicationState
      : 'committed_with_cleanup_error'
    settlementError = new OpenCodeAtomicPublicationSettlementError(
      state,
      settlementError === undefined
        ? closeError
        : new AggregateError([settlementError, closeError], 'OpenCode scoped auth close failure'),
    )
  }
  if (settlementError !== undefined) throw settlementError
}

async function rollbackProfileAuthTransaction(transaction: ProfileAuthPublicationTransaction): Promise<void> {
  await transaction.rollback()
  await closeProfileAuthTransaction(transaction)
}

function reapRollback(record: ProfileAuthTransactionRecord): void {
  if (settlementReaper.has(record)) return
  settlementReaper.add(record)
  let attempts = 0
  const retry = (): void => {
    attempts += 1
    void rollbackProfileAuthTransaction(record.transaction).then(() => {
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
    commit: () => transaction!.commit(),
    // The retained directory is part of the retryable transaction. Releasing
    // it after a failed rollback would let the root or backup object be
    // replaced before the exact same settlement is retried.
    rollback: () => transaction!.rollback(),
    close: () => directory.close(),
  })
}

export async function finalizeOpenCodeScopedProfileAuth(preparedProfile: object): Promise<void> {
  const record = profileAuthTransactions.get(preparedProfile)
  if (!record) return
  try { await commitAndCloseProfileAuthTransaction(record.transaction) }
  finally {
    profileAuthTransactions.delete(preparedProfile)
    if (record.signal) signalAuthTransactions.delete(record.signal)
  }
}

export async function rollbackOpenCodeScopedProfileAuth(preparedProfile: object): Promise<void> {
  const record = profileAuthTransactions.get(preparedProfile)
  if (!record) return
  try { await rollbackProfileAuthTransaction(record.transaction) } catch (error) { reapRollback(record); throw error }
  profileAuthTransactions.delete(preparedProfile)
  if (record.signal) signalAuthTransactions.delete(record.signal)
}

export async function rollbackOpenCodeScopedProfileAuthSignal(signal: AbortSignal): Promise<void> {
  const record = signalAuthTransactions.get(signal)
  if (!record) return
  try { await rollbackProfileAuthTransaction(record.transaction) } catch (error) { reapRollback(record); throw error }
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
    } else await commitAndCloseProfileAuthTransaction(transaction)
  }
  // Deliberately no post-write abort check or fallible identity/path phase.
  return input.preparedProfile
}
