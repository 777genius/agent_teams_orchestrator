import { createHash } from 'node:crypto'

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
