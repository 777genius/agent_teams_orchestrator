import path from 'node:path'

import { OpenCodeSafePublicationDirectory } from './OpenCodeSafePublication.js'

type PublishAuth = (
  directoryPath: string,
  fileName: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
) => Promise<void>

const publishAuth: PublishAuth = async (directoryPath, fileName, bytes, signal) => {
  const directory = await OpenCodeSafePublicationDirectory.open(directoryPath)
  try {
    await directory.writeFileAtomic(fileName, bytes, 0o600, signal)
  } catch (error) {
    await directory.close().catch(() => undefined)
    throw error
  }
  // Visibility is committed. Descriptor-close failure cannot turn that commit
  // into a rejected preparation with a stranded visible artifact.
  await directory.close().catch(() => undefined)
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
  await (input.publish ?? publishAuth)(
    path.dirname(input.managedAuthPath),
    path.basename(input.managedAuthPath),
    input.managedAuthBytes,
    input.abortSignal,
  )
  // Deliberately no post-write abort check or fallible identity/path phase.
  return input.preparedProfile
}
