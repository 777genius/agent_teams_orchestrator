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
) => Promise<OpenCodeSafePublicationTransaction | null | void>

type ProfileAuthTransactionRecord = Readonly<{
  transaction: OpenCodeSafePublicationTransaction
  profile: object
  signal?: AbortSignal
}>
const profileAuthTransactions = new WeakMap<object, ProfileAuthTransactionRecord>()
const signalAuthTransactions = new WeakMap<AbortSignal, ProfileAuthTransactionRecord>()

const publishAuth: PublishAuth = async (directoryPath, fileName, bytes, signal) => {
  const directory = await OpenCodeSafePublicationDirectory.open(directoryPath)
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
      await transaction!.commit().catch(() => undefined)
      await directory.close().catch(() => undefined)
    },
    rollback: async () => {
      try { await transaction!.rollback() }
      finally { await directory.close().catch(() => undefined) }
    },
  })
}

export async function finalizeOpenCodeScopedProfileAuth(preparedProfile: object): Promise<void> {
  const record = profileAuthTransactions.get(preparedProfile)
  if (!record) return
  profileAuthTransactions.delete(preparedProfile)
  if (record.signal) signalAuthTransactions.delete(record.signal)
  await record.transaction.commit()
}

export async function rollbackOpenCodeScopedProfileAuth(preparedProfile: object): Promise<void> {
  const record = profileAuthTransactions.get(preparedProfile)
  if (!record) return
  profileAuthTransactions.delete(preparedProfile)
  if (record.signal) signalAuthTransactions.delete(record.signal)
  await record.transaction.rollback()
}

export async function rollbackOpenCodeScopedProfileAuthSignal(signal: AbortSignal): Promise<void> {
  const record = signalAuthTransactions.get(signal)
  if (!record) return
  signalAuthTransactions.delete(signal)
  profileAuthTransactions.delete(record.profile)
  await record.transaction.rollback()
}

/** The auth write is the final awaited preparation phase. */
export async function commitOpenCodeScopedProfileAuth<T>(input: Readonly<{
  managedAuthPath: string
  managedAuthBytes: Uint8Array
  preparedProfile: T
  abortSignal?: AbortSignal
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
