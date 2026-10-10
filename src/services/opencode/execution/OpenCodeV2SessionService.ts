import type { ExecutionClient, ExecutionSession } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import { assertExecutionSelectedModel, executionAssert, executionHash, type SessionAuthority } from './OpenCodeV2ExecutionContracts.js'
import { executionSessionIsMissing, executionWasNotSubmitted } from '../transport/OpenCodeV2ExecutionFetch.js'
import { OpenCodeV2AdmissionStore } from './OpenCodeV2AdmissionStore.js'

export function verifyExecutionSession(authority: SessionAuthority, session: ExecutionSession): void {
  assertExecutionSelectedModel(session.model)
  executionAssert(session.id === authority.sessionID && session.directory === authority.host.directory &&
    session.agent === authority.agent && executionHash(session.model) === executionHash(authority.model), 'session_selection_changed')
  executionAssert(Number.isFinite(session.timeCreated) && session.timeCreated > 0, 'session_invalid')
}
export class OpenCodeV2SessionService {
  constructor(private readonly client: ExecutionClient, private readonly store: OpenCodeV2AdmissionStore,
    private readonly authority: SessionAuthority) {
    store.assertAuthority(authority)
    this.authority = structuredClone(authority)
    executionAssert(executionHash(client.authority) === executionHash(authority.host), 'authority_conflict')
  }
  reserveSession() { return this.store.reserveSession() }
  async createSession(title?: string): Promise<{ disposition: 'accepted' | 'unknown' | 'rejected'; session?: ExecutionSession }> {
    const reservation = await this.store.reserveSession()
    if (reservation.state !== 'reserved') return this.readSession()
    // A durable reservation is not proof that the native ID is unused. Require
    // the exact declared missing-session response before our first submission;
    // a foreign existing row or uncertain read cannot authorize its adoption.
    try {
      await this.client.getSession(this.authority.sessionID)
      return { disposition: 'rejected' }
    } catch (failure) {
      if (!executionSessionIsMissing(failure, this.authority.sessionID)) return { disposition: 'unknown' }
    }
    // No mutation has started yet. Tombstone/revision and durable submitting
    // marker are checked atomically. A crash here is conservative UNKNOWN.
    let sent
    try { sent = await this.store.markCreation(reservation.revision, 'submitting') }
    catch { return { disposition: 'rejected' } }
    try {
      const session = await this.client.createSession({ sessionID: this.authority.sessionID, agent: this.authority.agent,
        model: this.authority.model, ...(title === undefined ? {} : { title }) })
      verifyExecutionSession(this.authority, session)
      await this.store.markCreation(sent.revision, 'accepted')
      return { disposition: 'accepted', session }
    } catch (failure) {
      if (executionWasNotSubmitted(failure)) {
        await this.store.markCreation(sent.revision, 'not_submitted')
        return { disposition: 'rejected' }
      }
      await this.store.markCreation(sent.revision, 'unknown').catch(() => undefined)
      return { disposition: 'unknown' }
    }
  }
  async readSession(): Promise<{ disposition: 'accepted' | 'unknown'; session?: ExecutionSession }> {
    // Recovery reads the one reserved ID; absence is not permission to create
    // another session, even if the original request timed out.
    const snapshot = await this.store.snapshot()
    try {
      const session = await this.client.getSession(this.authority.sessionID)
      verifyExecutionSession(this.authority, session)
      // A reservation or a proved-unsubmitted attempt has no native ownership
      // evidence. Matching selection alone must not adopt a pre-existing session.
      // Keep that original ID readable without granting admission authority.
      if (snapshot.creation.state === 'reserved' || snapshot.creation.state === 'not_submitted')
        return { disposition: 'unknown', session }
      if (snapshot.creation.state !== 'accepted') await this.store.markCreation(snapshot.creation.revision, 'accepted')
      return { disposition: 'accepted', session }
    } catch { return { disposition: 'unknown' } }
  }
}
