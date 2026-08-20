import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'

import type { OpenCodeLaunchOwnedResources } from './OpenCodeLaunchAttempt.js'
import type { OpenCodeOpaqueIdentity } from './OpenCodeBridgeContractV2.js'
import type { OpenCodeSessionSummary } from './types.js'

function sessionIdentity(id: string): OpenCodeOpaqueIdentity {
  return `sha256:${createHash('sha256').update(JSON.stringify({ kind: 'opencode-session', id })).digest('hex')}`
}

function isAbsent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
    || (error instanceof Error && error.message.includes('(404 '))
}

export type OpenCodeOwnedSessionReconciliation = 'absent' | 'deleted' | 'foreign' | 'unresolved'

export type OpenCodeProofSessionCleanupRecord = {
  version: 1
  attemptId: string
  hostKeyIdentity: OpenCodeOpaqueIdentity
  authoritativeSessionId: string
  ownershipTitle: string
  state: 'registered' | 'owned' | OpenCodeOwnedSessionReconciliation
  updatedAt: string
}

/** Attempt-owned durable proof cleanup metadata; it is written before session POST. */
export class OpenCodeProofSessionCleanupLedger {
  constructor(private readonly filePath: string) {}

  async read(): Promise<OpenCodeProofSessionCleanupRecord | null> {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as OpenCodeProofSessionCleanupRecord
      if (value.version !== 1 || typeof value.attemptId !== 'string'
        || typeof value.authoritativeSessionId !== 'string' || typeof value.ownershipTitle !== 'string'
        || typeof value.hostKeyIdentity !== 'string'
        || !['registered', 'owned', 'absent', 'deleted', 'foreign', 'unresolved'].includes(value.state)) {
        throw new Error('OpenCode proof cleanup ledger is invalid')
      }
      return value
    } catch (error) {
      if (isAbsent(error)) return null
      throw error
    }
  }

  async register(input: Omit<OpenCodeProofSessionCleanupRecord, 'version' | 'state' | 'updatedAt'>):
  Promise<{ record: OpenCodeProofSessionCleanupRecord; created: boolean }> {
    const existing = await this.read()
    if (existing) {
      if (existing.attemptId !== input.attemptId
        || existing.hostKeyIdentity !== input.hostKeyIdentity
        || existing.authoritativeSessionId !== input.authoritativeSessionId
        || existing.ownershipTitle !== input.ownershipTitle) {
        throw new Error('OpenCode proof cleanup ledger ownership mismatch')
      }
      return { record: existing, created: false }
    }
    const record: OpenCodeProofSessionCleanupRecord = {
      version: 1, ...input, state: 'registered', updatedAt: new Date().toISOString(),
    }
    await this.write(record)
    return { record, created: true }
  }

  async recordState(
    expected: Pick<OpenCodeProofSessionCleanupRecord,
      'attemptId' | 'hostKeyIdentity' | 'authoritativeSessionId' | 'ownershipTitle'>,
    state: Exclude<OpenCodeProofSessionCleanupRecord['state'], 'registered'>,
  ): Promise<OpenCodeProofSessionCleanupRecord> {
    const current = await this.read()
    if (!current || current.attemptId !== expected.attemptId
      || current.hostKeyIdentity !== expected.hostKeyIdentity
      || current.authoritativeSessionId !== expected.authoritativeSessionId
      || current.ownershipTitle !== expected.ownershipTitle) {
      throw new Error('OpenCode proof cleanup ledger ownership mismatch')
    }
    const next = { ...current, state, updatedAt: new Date().toISOString() }
    await this.write(next)
    return next
  }

  private async write(record: OpenCodeProofSessionCleanupRecord): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`
    const temporary = await open(temporaryPath, 'wx', 0o600)
    try {
      try {
        await temporary.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
        await temporary.sync()
      } finally {
        await temporary.close()
      }
      await rename(temporaryPath, this.filePath)
    } catch (error) {
      await temporary.close().catch(() => undefined)
      await unlink(temporaryPath).catch(() => undefined)
      throw error
    }
    let directory: Awaited<ReturnType<typeof open>> | undefined
    try {
      directory = await open(path.dirname(this.filePath), 'r')
      await directory.sync()
    } catch (error) {
      if (!['EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM']
        .includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    } finally {
      await directory?.close().catch(() => undefined)
    }
  }
}

/**
 * Reconciles exactly one deterministic attempt-owned session.  A failed
 * create transport is never retried: cleanup observes the authoritative id,
 * deletes only a matching ownership marker, then proves physical absence.
 */
export async function reconcileOpenCodeOwnedMemberSession(input: {
  authoritativeSessionId: string
  ownershipTitle: string
  getSession(id: string): Promise<OpenCodeSessionSummary>
  deleteSession(id: string): Promise<boolean>
}): Promise<OpenCodeOwnedSessionReconciliation> {
  let observed: OpenCodeSessionSummary
  try {
    observed = await input.getSession(input.authoritativeSessionId)
  } catch (error) {
    return isAbsent(error) ? 'absent' : 'unresolved'
  }
  if (observed.id !== input.authoritativeSessionId || observed.title !== input.ownershipTitle) {
    return 'foreign'
  }
  try {
    await input.deleteSession(input.authoritativeSessionId)
  } catch {
    // DELETE itself may commit ambiguously.  Only a fresh exact GET can settle
    // cleanup; never issue a second mutation automatically.
  }
  try {
    await input.getSession(input.authoritativeSessionId)
    return 'unresolved'
  } catch (error) {
    return isAbsent(error) ? 'deleted' : 'unresolved'
  }
}

export async function createOpenCodeOwnedMemberSession<T>(input: {
  memberIdentity: OpenCodeOpaqueIdentity
  authoritativeSessionId: string
  registerRecord(): void
  registerOwned(resources: OpenCodeLaunchOwnedResources): void
  createSession(): Promise<T>
}): Promise<{ session: T; owned: OpenCodeLaunchOwnedResources }> {
  const owned: OpenCodeLaunchOwnedResources = {
    memberIdentity: input.memberIdentity,
    sessionIdentity: sessionIdentity(input.authoritativeSessionId),
  }
  // Both cleanup metadata and port ownership precede the first transport
  // mutation. This ordering is part of the production adapter contract.
  input.registerRecord()
  input.registerOwned(owned)
  return { session: await input.createSession(), owned }
}
