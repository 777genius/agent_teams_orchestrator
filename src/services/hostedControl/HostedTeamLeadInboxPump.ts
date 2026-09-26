import { createHash } from 'node:crypto'
import { statSync, watch, type FSWatcher } from 'node:fs'
import { constants, lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { writeFileAtomic } from '../../utils/atomicWrite.js'
import * as lockfile from '../../utils/lockfile.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import { markMailboxMessageReadAtCanonicalTeamRoot } from '../../utils/teammateMailbox.js'
import { createOwnedOpenCodeHostedInboxExecutor } from '../opencode/OpenCodeBridgeCommandHandler.js'
import { readOpenCodeLegacyStopCapability } from '../opencode/OpenCodeLegacyStopAuthority.js'
import { buildOpenCodeRuntimeMessageText } from '../opencode/OpenCodeRuntimeMessageText.js'
import { isOpenCodeSessionStopped, openCodeSessionStore } from '../opencode/OpenCodeSessionStore.js'
import type { OpenCodeSessionRecord } from '../opencode/types.js'
import type { TeamLifecycleExecutionPort } from '../teamLifecycleOwner/TeamLifecycleOwnerService.js'
import type { TeamLifecycleLaunchPlan, TeamLifecycleLaunchPlanStore } from '../teamLifecycleOwner/TeamLifecycleLaunchPlan.js'
import type { HostedControlAuthority, HostedControlStableAuthority } from './protocol.js'
import type { HostedMessageAuthorityGuard, HostedPersistedMessage } from './HostedTeamMessageService.js'
import { fsyncFileAndParent } from './HostedTaskMutationWal.js'
import { isHostedMessageRecipientName } from './HostedTeamRecipientRoster.js'
import {
  hostedInboxRelayMessageId,
  relayPromptFields,
  selectDeliverableInboxRows,
  type DeliverableInboxRow,
} from './HostedInboxRelayRows.js'

const DIRECTORY = 'hosted-team-lead-inbox-pump'
const DELIVERY_DIRECTORY = 'hosted-message-delivery-operations'
/** Intents carry the prompt text; relayed teammate rows may be up to MAX_RELAY_TEXT_BYTES. */
const MAX_FILE_BYTES = 256 * 1024
/** Larger teammate rows stay in the inbox for the recipient's own reads. */
const MAX_RELAY_TEXT_BYTES = 64 * 1024
/** Actor recorded on intents for teammate rows, which no browser request authorized. */
const RELAY_ACTOR_ID = 'hosted-inbox-relay'
const MAX_INBOX_BYTES = 8 * 1024 * 1024
const MAX_AMBIGUOUS_RECONCILIATIONS = 12
/** A prompt the runtime provably never accepted may be sent this many times in total. */
const MAX_SEND_ATTEMPTS = 3
const LOCK_OPTIONS = { realpath: false, retries: { retries: 50, minTimeout: 5, maxTimeout: 100 } } as const
/** Coalesces the burst of events one atomic inbox write produces (temp file, rename). */
const INBOX_WATCH_DEBOUNCE_MS = 150

type Selected = {
  planGeneration: string
  runId: string
  laneId: string
  sessionId: string
  capabilitySnapshotId: string
  projectPath: string
}
/**
 * A teammate- or app-written inbox row carries `relay`: the row itself is the
 * durable source (no Product delivery marker), `messageId` is the bridge id
 * derived from it, and replies go to its sender, as in desktop's inbox relay.
 */
type RelayOrigin = {
  sourceMessageId: string
  from: string
  replyRecipient: string
} & ReturnType<typeof relayPromptFields>
type PumpMessage = HostedPersistedMessage & { relay?: RelayOrigin }
type Intent = {
  schemaVersion: 1
  authority: HostedControlAuthority
  message: PumpMessage
  textSha256: string
  selected: Selected
  requestId: string
  status: 'intent' | 'accepted' | 'observed' | 'operator_required'
  reconcileChecks?: number
  runtimePromptMessageId?: string
  /** Set once the recipient's inbox row is marked read after the runtime accepted the prompt. */
  inboxReadCommitted?: true
  /**
   * Durably set right before the bridge call. An intent without it never reached
   * the runtime, so it is sent again instead of being reconciled as ambiguous.
   */
  sendIssued?: true
  /** Zero-based send attempt; only a proven failed_before_accept advances it. */
  attempt?: number
}
/** Terminal for the pump: a native process reads its own inbox, so the append is the delivery. */
type NativeInboxRecord = {
  schemaVersion: 1
  authority: HostedControlAuthority
  message: PumpMessage
  textSha256: string
  status: 'native_inbox'
}
type BridgeInput = {
  command: 'send' | 'status' | 'observe'
  requestId: string
  teamId: string
  laneId: string
  memberName: string
  runId: string
  projectPath: string
  sessionId: string
  capabilitySnapshotId: string
  messageId: string
  payloadHash: string
  text?: string
  runtimePromptMessageId?: string
}
type BridgeResponse = { ok: boolean; data?: Record<string, unknown>; error?: { message?: string } }
export type InboxPumpDecision = {
  kind: 'observed' | 'accepted' | 'pending' | 'operator_required' | 'unavailable' | 'native_inbox'
}
/** Why the pump could not prompt a session; ids and names only, never text or paths. */
export type InboxPumpReport = Readonly<{
  messageId: string
  recipient: string
  decision: InboxPumpDecision['kind']
  reason: string | null
}>
type SelectMiss = { miss: string }

export type HostedTeamLeadInboxPumpOptions = {
  canonicalTeamRoot: string
  legacyKey: string
  authority: Readonly<HostedControlStableAuthority>
  guard: HostedMessageAuthorityGuard
  planStore: TeamLifecycleLaunchPlanStore
  execution: Pick<TeamLifecycleExecutionPort, 'inspect'>
  /** Read only view used inside the OpenCode prompt host operation. */
  readActiveRun?: (plan: TeamLifecycleLaunchPlan) => Promise<{ phase: string; runId: string | null } | null>
  getSession?: (teamId: string, laneId: string, memberName: string) => Promise<OpenCodeSessionRecord | null>
  getCapability?: (input: { teamId: string; laneId: string; runId: string }) => Promise<string>
  executeBridge?: (input: BridgeInput, effectGuard: () => Promise<boolean>, signal: AbortSignal) => Promise<BridgeResponse>
  /** Called when a message's decision or reason changes, so a stuck delivery is visible once. */
  reportDecision?: (report: InboxPumpReport) => void
}

/**
 * Consumes only a verified, durable hosted inbox row for its admitted OpenCode run.
 * The recipient is the message's persisted recipient, team-lead when it has none;
 * it prompts that member's session and marks the row read once the prompt is accepted.
 */
export class HostedTeamLeadInboxPump {
  readonly #root: string
  readonly #legacyKey: string
  readonly #authority: Readonly<HostedControlStableAuthority>
  readonly #guard: HostedMessageAuthorityGuard
  readonly #planStore: TeamLifecycleLaunchPlanStore
  readonly #execution: Pick<TeamLifecycleExecutionPort, 'inspect'>
  readonly #readActiveRun: NonNullable<HostedTeamLeadInboxPumpOptions['readActiveRun']>
  readonly #getSession: NonNullable<HostedTeamLeadInboxPumpOptions['getSession']>
  readonly #getCapability: NonNullable<HostedTeamLeadInboxPumpOptions['getCapability']>
  readonly #executeBridge: NonNullable<HostedTeamLeadInboxPumpOptions['executeBridge']>
  readonly #reportDecision: HostedTeamLeadInboxPumpOptions['reportDecision']
  readonly #lastReports = new Map<string, string>()
  readonly #abort = new AbortController()
  readonly #pending = new Set<Promise<void>>()
  #poller: ReturnType<typeof setInterval> | null = null
  #recovery: Promise<InboxPumpDecision[]> | null = null
  /** Set when a change arrives during a pass; that pass is followed by exactly one more. */
  #recoverAgain = false
  #watcher: FSWatcher | null = null
  /** Identity of the watched inboxes/ directory; a recreated directory is watched anew. */
  #watchedInbox: string | null = null
  #watchDebounce: ReturnType<typeof setTimeout> | null = null
  #accepting = true

  constructor(options: HostedTeamLeadInboxPumpOptions) {
    if (!isAbsolute(options.canonicalTeamRoot) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(options.legacyKey) ||
      join(dirname(options.canonicalTeamRoot), options.legacyKey) !== options.canonicalTeamRoot) {
      throw new TypeError('Hosted inbox pump requires the explicit canonical team root')
    }
    this.#root = options.canonicalTeamRoot
    this.#legacyKey = options.legacyKey
    this.#authority = Object.freeze({ ...options.authority, mountBinding: Object.freeze({ ...options.authority.mountBinding }) })
    this.#guard = options.guard
    this.#planStore = options.planStore
    this.#execution = options.execution
    this.#readActiveRun = options.readActiveRun ?? (plan => this.#readPersistedActiveRun(plan))
    this.#getSession = options.getSession ?? ((teamId, laneId, memberName) => openCodeSessionStore.get(teamId, laneId, memberName))
    // The canonical teams directory of this admission, never the ambient config root.
    this.#getCapability = options.getCapability ?? (input => readOpenCodeLegacyStopCapability({
      teamsPath: dirname(this.#root), ...input,
    }))
    this.#executeBridge = options.executeBridge ?? createOwnedOpenCodeHostedInboxExecutor()
    this.#reportDecision = options.reportDecision
  }

  async wake(message: PumpMessage, authority: HostedControlAuthority): Promise<InboxPumpDecision> {
    if (!this.#accepting) return { kind: 'unavailable' }
    const work = this.#wake(message, authority).then(({ decision, reason }) => {
      this.#report(message, decision, reason)
      return decision
    })
    const tracked = work.then(() => undefined, () => undefined)
    this.#pending.add(tracked)
    void tracked.finally(() => this.#pending.delete(tracked))
    return work
  }

  /**
   * Install once during composition; the first active owner lease admits recovery.
   * A watch on inboxes/ prompts a new row within the debounce, like desktop's file
   * watcher; the poll stays the fallback for missed events and re-arms the watch.
   */
  start(pollIntervalMs = 5_000): void {
    if (!this.#accepting || this.#poller) return
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100) {
      throw new TypeError('Invalid hosted inbox pump polling interval')
    }
    this.#poller = setInterval(() => {
      this.#armInboxWatch()
      void this.recover().catch(() => undefined)
    }, pollIntervalMs)
    this.#poller.unref?.()
    this.#armInboxWatch()
    setTimeout(() => { void this.recover().catch(() => undefined) }, 0).unref?.()
  }

  /** Startup recovery scans the durable append receipts; a missed wake loses no message. */
  recover(): Promise<InboxPumpDecision[]> {
    if (this.#recovery) return this.#recovery
    const recovery = this.#recover()
    this.#recovery = recovery
    void recovery.finally(() => { if (this.#recovery === recovery) this.#recovery = null }).catch(() => undefined)
    return recovery
  }

  /** A change seen during a pass must not be lost to the pass already reading the old inbox. */
  #requestRecovery(): void {
    if (!this.#accepting) return
    if (this.#recovery) {
      if (this.#recoverAgain) return
      this.#recoverAgain = true
      void this.#recovery.catch(() => undefined).finally(() => {
        this.#recoverAgain = false
        void this.recover().catch(() => undefined)
      })
      return
    }
    void this.recover().catch(() => undefined)
  }

  /** Watches inboxes/; a missing or recreated directory is re-armed by the next poll. */
  #armInboxWatch(): void {
    if (!this.#accepting) return
    const directory = join(this.#root, 'inboxes')
    let identity: string
    try {
      const stat = statSync(directory)
      if (!stat.isDirectory()) return
      identity = `${stat.dev}:${stat.ino}`
    } catch { return }
    if (this.#watcher && this.#watchedInbox === identity) return
    this.#watcher?.close()
    this.#watcher = null
    let watcher: FSWatcher
    try {
      watcher = watch(directory, { persistent: false }, (_event, name) => {
        if (name !== null && !String(name).endsWith('.json')) return
        if (this.#watchDebounce) clearTimeout(this.#watchDebounce)
        this.#watchDebounce = setTimeout(() => {
          this.#watchDebounce = null
          this.#requestRecovery()
        }, INBOX_WATCH_DEBOUNCE_MS)
        this.#watchDebounce.unref?.()
      })
    } catch { return }
    const drop = (): void => {
      if (this.#watcher === watcher) this.#watcher = null
      watcher.close()
    }
    watcher.on('error', drop)
    watcher.on('close', () => { if (this.#watcher === watcher) this.#watcher = null })
    this.#watcher = watcher
    this.#watchedInbox = identity
    // Rows written before the watch existed are picked up by this pass.
    this.#requestRecovery()
  }

  async #recover(): Promise<InboxPumpDecision[]> {
    if (!this.#accepting) return [{ kind: 'unavailable' }]
    await this.#assertPrivateRoot()
    return [...await this.#recoverOperatorMessages(), ...await this.#recoverRelayRows()]
  }

  /** Operator messages: Product's delivery markers name each appended `from: user` row. */
  async #recoverOperatorMessages(): Promise<InboxPumpDecision[]> {
    let names: string[]
    try { names = await readdir(join(this.#root, DELIVERY_DIRECTORY)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const results: InboxPumpDecision[] = []
    for (const name of names.sort()) {
      if (!/^[0-9a-f]{64}\.delivery\.v1\.json$/.test(name)) continue
      try {
        const receipt = await readPrivateJson(join(this.#root, DELIVERY_DIRECTORY, name))
        const record = asRecord(receipt)
        const message = asRecord(record?.binding)
        const authority = asRecord(record?.authority)
        const recipient = record?.recipient
        if (record?.status !== 'delivered' || !message || !authority ||
          !sameAuthority(authority as HostedControlAuthority, this.#authority) ||
          record.canonicalTeamRoot !== this.#root || record.legacyKey !== this.#legacyKey) continue
        if (!isInboxRecipient(recipient)) {
          results.push({ kind: 'operator_required' })
          continue
        }
        const terminal = await this.#terminalDecision(recipient, message, authority as HostedControlAuthority)
        if (terminal) {
          results.push(terminal)
          continue
        }
        const inbox = await this.#readInbox(recipient)
        const row = inbox.find(candidate => candidate.messageId === message.messageId && candidate.from === 'user')
        if (!row || typeof row.text !== 'string' || typeof row.timestamp !== 'string' ||
          sha256(row.text) !== message.textSha256) {
          results.push({ kind: 'operator_required' })
          continue
        }
        results.push(await this.wake({
          teamId: String(message.teamId), messageId: String(message.messageId),
          clientMessageId: String(message.clientMessageId), text: row.text, createdAt: row.timestamp,
          ...(recipient === TEAM_LEAD_NAME ? {} : { recipient }),
        }, authority as HostedControlAuthority))
      } catch { results.push({ kind: 'operator_required' }) }
    }
    return results
  }

  /**
   * Teammate and app rows: every row desktop's OpenCode member inbox relay prompts,
   * read from the inbox of every OpenCode lane member of the current plan. Native
   * members read their own inbox and are not touched. The queue is FIFO per
   * recipient in desktop order: a row that cannot be prompted yet holds the rows
   * behind it, and so does an operator row still in flight on its own path.
   */
  async #recoverRelayRows(): Promise<InboxPumpDecision[]> {
    const admission = await this.#planStore.load({
      workspaceId: this.#authority.workspaceId, teamId: this.#authority.teamId,
    })
    if (!admission || !(await admission.isCurrent())) return []
    const members = [...new Set(admission.plan.lanes
      .filter(lane => lane.kind === 'opencode')
      .flatMap(lane => lane.members.map(member => member.name))
      .filter(isInboxRecipient))]
    const authority: HostedControlAuthority = { actorId: RELAY_ACTOR_ID, ...this.#authority }
    const results: InboxPumpDecision[] = []
    for (const recipient of members) {
      let rows: Array<Record<string, unknown>>
      try { rows = await this.#readInbox(recipient) } catch { continue }
      for (const deliverable of selectDeliverableInboxRows(rows, recipient)) {
        if (!this.#accepting) return results
        // TODO(hosted-dedupe-plan M1): operator rows still arrive through Product's
        // message_deliver markers. Once message_send replaces persist+deliver, this
        // branch, the markers and #hasDurableDeliveryReceipt go away.
        if (deliverable.from.toLowerCase() === 'user') {
          if (await this.#operatorRowInFlight(recipient, deliverable.sourceMessageId)) break
          continue
        }
        const message = relayMessage(authority.teamId, recipient, deliverable)
        if (!message) continue
        const decision = await this.wake(message, authority)
        results.push(decision)
        if (decision.kind === 'pending' || decision.kind === 'unavailable') break
      }
    }
    return results
  }

  /** An operator row the pump claimed but has not settled yet keeps the recipient's order. */
  async #operatorRowInFlight(recipient: string, messageId: string): Promise<boolean> {
    try {
      const stored = await readPrivateJson(join(this.#root, DIRECTORY,
        `${intentDigest(this.#authority.teamId, recipient, messageId)}.json`)) as Intent | NativeInboxRecord | null
      if (!stored || stored.status === 'native_inbox' || stored.status === 'operator_required') return false
      return !(stored.status === 'observed' && stored.inboxReadCommitted === true)
    } catch { return false }
  }

  /**
   * A native append, an operator_required intent and an observed prompt whose inbox row is marked
   * read never change again, so recovery answers them without rereading the inbox or waking the
   * message. Anything else, or any doubt about the stored record, takes the full wake path.
   */
  async #terminalDecision(
    recipient: string,
    binding: Record<string, unknown>,
    authority: HostedControlAuthority,
  ): Promise<InboxPumpDecision | null> {
    try {
      const messageId = String(binding.messageId)
      const stored = await readPrivateJson(join(this.#root, DIRECTORY,
        `${intentDigest(authority.teamId, recipient, messageId)}.json`)) as Intent | NativeInboxRecord | null
      if (!stored || !sameAuthority(stored.authority, authority) ||
        stored.authority.actorId !== authority.actorId ||
        stored.message?.messageId !== messageId || stored.textSha256 !== binding.textSha256) return null
      if (stored.status === 'native_inbox') return validNativeInboxRecord(stored) ? { kind: 'native_inbox' } : null
      if (!validIntent(stored)) return null
      if (stored.status === 'operator_required') return { kind: 'operator_required' }
      // An accepted prompt whose row is read is delivered; re-reconciling it every pass
      // spent bridge calls and stretched the poll well past its interval.
      if (stored.inboxReadCommitted !== true) return null
      return stored.status === 'observed' || stored.status === 'accepted' ? { kind: stored.status } : null
    } catch { return null }
  }

  async close(): Promise<void> {
    this.#accepting = false
    this.#abort.abort(new Error('Hosted inbox pump is closing'))
    if (this.#poller) clearInterval(this.#poller)
    this.#poller = null
    if (this.#watchDebounce) clearTimeout(this.#watchDebounce)
    this.#watchDebounce = null
    this.#watcher?.close()
    this.#watcher = null
    await this.#recovery?.catch(() => undefined)
    await Promise.all([...this.#pending])
  }

  #report(message: PumpMessage, decision: InboxPumpDecision, reason: string | null): void {
    if (!this.#reportDecision) return
    const key = `${decision.kind}\0${reason ?? ''}`
    if (this.#lastReports.get(message.messageId) === key) return
    this.#lastReports.set(message.messageId, key)
    try {
      this.#reportDecision(Object.freeze({ messageId: message.messageId,
        recipient: message.recipient ?? TEAM_LEAD_NAME, decision: decision.kind, reason }))
    } catch { /* Diagnostics never change delivery. */ }
  }

  async #wake(message: PumpMessage, authority: HostedControlAuthority): Promise<WakeOutcome> {
    if (!sameAuthority(authority, this.#authority) || message.teamId !== authority.teamId ||
      !/^message_[0-9a-f]{32}$/.test(message.messageId) ||
      !/^client_message_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(message.clientMessageId)) {
      return outcome('operator_required', 'message_binding_invalid')
    }
    const recipient = message.recipient ?? TEAM_LEAD_NAME
    if (message.recipient !== undefined && !isHostedMessageRecipientName(message.recipient)) {
      return outcome('operator_required', 'recipient_invalid')
    }
    if (!(await this.#guard.isCurrent(authority))) return outcome('unavailable', 'authority_not_current')
    try {
      await this.#assertPrivateRoot()
      if (!(await this.#hasDurableInboxRow(message, recipient))) return outcome('operator_required', 'inbox_row_mismatch')
      if (!message.relay && !(await this.#hasDurableDeliveryReceipt(message, recipient, authority))) {
        return outcome('operator_required', 'delivery_marker_mismatch')
      }
      await this.#prepareDirectory()
      const path = join(this.#root, DIRECTORY,
        `${intentDigest(authority.teamId, recipient, inboxRowOf(message).messageId)}.json`)
      const release = await lockfile.lock(path, LOCK_OPTIONS)
      try {
        const stored = await readPrivateJson(path) as Intent | NativeInboxRecord | null
        if (stored?.status === 'native_inbox') {
          return validNativeInboxRecord(stored) && sameAuthority(stored.authority, authority) &&
            stored.authority.actorId === authority.actorId && isDeepStrictEqual(stored.message, message) &&
            stored.textSha256 === sha256(message.text)
            ? outcome('native_inbox')
            : outcome('operator_required', 'native_record_mismatch')
        }
        const intent = stored
        if (intent) {
          if (!validIntent(intent) || !sameAuthority(intent.authority, authority) ||
            intent.authority.actorId !== authority.actorId ||
            !isDeepStrictEqual(intent.message, message) || intent.textSha256 !== sha256(message.text)) {
            return outcome('operator_required', 'intent_mismatch')
          }
          if (intent.status === 'operator_required') return outcome('operator_required', 'intent_terminal')
          // Never sent (a fence failed before the bridge call, or a proven
          // failed_before_accept was reset for retry): sending is safe. Intents
          // written before attempts were tracked have no attempt and stay ambiguous.
          if (intent.status === 'intent' && intent.attempt !== undefined && !intent.sendIssued) {
            return await this.#send(path, intent)
          }
          const decision = intent.status === 'observed' ? { kind: 'observed' as const } : await this.#reconcile(path, intent)
          return outcome((await this.#commitInboxRead(path, decision)).kind)
        }
        if (await this.#isNativeRecipient(authority, recipient)) {
          const record: NativeInboxRecord = { schemaVersion: 1, authority, message,
            textSha256: sha256(message.text), status: 'native_inbox' }
          await writeIntent(path, record)
          return outcome('native_inbox')
        }
        const selected = await this.#select(authority, recipient)
        if ('miss' in selected) return outcome('unavailable', selected.miss)
        const created: Intent = { schemaVersion: 1, authority, message, textSha256: sha256(message.text),
          selected, requestId: requestIdFor(authority.teamId, message.messageId, selected, 0),
          status: 'intent', attempt: 0 }
        await writeIntent(path, created)
        // Awaited so the send, reconcile and read commit finish while this intent lock is held.
        return await this.#send(path, created, selected)
      } finally { await release() }
    } catch { return outcome('operator_required', 'pump_error') }
  }

  /** Sends one not-yet-issued intent; the intent must be durable and its lock held. */
  async #send(path: string, pending: Intent, preselected?: Selected): Promise<WakeOutcome> {
    const recipient = pending.message.recipient ?? TEAM_LEAD_NAME
    const selected = preselected ?? await this.#select(pending.authority, recipient)
    if ('miss' in selected) return outcome('unavailable', selected.miss)
    const attempt = pending.attempt ?? 0
    let intent: Intent = isDeepStrictEqual(selected, pending.selected)
      ? pending
      : { ...pending, selected,
        requestId: requestIdFor(pending.authority.teamId, pending.message.messageId, selected, attempt) }
    const miss = await this.#selectionMiss(intent)
    if (miss !== null) {
      if (intent !== pending) await writeIntent(path, intent)
      return outcome('unavailable', miss)
    }
    intent = { ...intent, sendIssued: true }
    await writeIntent(path, intent)
    let result: BridgeResponse
    try {
      result = await this.#executeBridge(this.#bridgeInput(intent, 'send'),
        () => this.#stillSelected(intent), this.#abort.signal)
    } catch {
      return outcome((await this.#commitInboxRead(path, await this.#reconcile(path, intent))).kind,
        'send_response_lost')
    }
    if (result.ok && result.data?.accepted === true && result.data.sessionId === selected.sessionId) {
      const promptId = result.data.runtimePromptMessageId
      intent = { ...intent, status: 'accepted', reconcileChecks: 0,
        ...(typeof promptId === 'string' ? { runtimePromptMessageId: promptId } : {}) }
      await writeIntent(path, intent)
      return outcome((await this.#commitInboxRead(path, { kind: 'accepted' })).kind)
    }
    const decision = await this.#commitInboxRead(path, await this.#reconcile(path, intent))
    return outcome(decision.kind, decision.kind === 'accepted' || decision.kind === 'observed'
      ? null
      : `send_not_accepted:${bridgeFailure(result)}`)
  }

  async #reconcile(path: string, intent: Intent): Promise<InboxPumpDecision> {
    if (!(await this.#stillSelected(intent))) return { kind: 'unavailable' }
    let result: BridgeResponse
    try { result = await this.#executeBridge(this.#bridgeInput(intent, 'status'),
      () => this.#stillSelected(intent), this.#abort.signal) }
    catch { return this.#deferOrEscalate(path, intent) }
    const data = result.ok ? result.data : undefined
    if (!data) return this.#deferOrEscalate(path, intent)
    if (data.status === 'unknown') {
      await writeIntent(path, { ...intent, status: 'operator_required' })
      return { kind: 'operator_required' }
    }
    if (data.status === 'precondition_mismatch' ||
      (data.sessionId !== undefined && data.sessionId !== intent.selected.sessionId) ||
      (data.accepted === true && data.sessionId !== intent.selected.sessionId)) {
      await writeIntent(path, { ...intent, status: 'operator_required' })
      return { kind: 'operator_required' }
    }
    if (data.accepted !== true) {
      if (data.status === 'failed_before_accept' && data.safeToRetry === true) {
        // The runtime proved it never accepted this attempt. A bounded number of
        // fresh attempts (new requestId) is safe; after that an operator decides.
        const attempt = (intent.attempt ?? 0) + 1
        if (attempt >= MAX_SEND_ATTEMPTS) {
          await writeIntent(path, { ...intent, status: 'operator_required' })
          return { kind: 'operator_required' }
        }
        const { sendIssued: _issued, runtimePromptMessageId: _prompt, ...rest } = intent
        await writeIntent(path, { ...rest, status: 'intent', attempt, reconcileChecks: 0,
          requestId: requestIdFor(intent.authority.teamId, intent.message.messageId, intent.selected, attempt) })
        return { kind: 'pending' }
      }
      return this.#deferOrEscalate(path, intent)
    }
    const promptId = typeof data.runtimePromptMessageId === 'string' ? data.runtimePromptMessageId : intent.runtimePromptMessageId
    const accepted: Intent = { ...intent, status: 'accepted', reconcileChecks: 0,
      ...(promptId ? { runtimePromptMessageId: promptId } : {}) }
    await writeIntent(path, accepted)
    if (!promptId || !(await this.#stillSelected(accepted))) return { kind: 'accepted' }
    try {
      const observed = await this.#executeBridge(this.#bridgeInput(accepted, 'observe'),
        () => this.#stillSelected(accepted), this.#abort.signal)
      if (observed.ok && observed.data?.observed === true &&
        observed.data.sessionId === intent.selected.sessionId &&
        isTerminalResponseObservation(observed.data.responseObservation, promptId)) {
        await writeIntent(path, { ...accepted, status: 'observed' })
        return { kind: 'observed' }
      }
    } catch { /* Accepted prompt remains durable; next recovery may observe. */ }
    return { kind: 'accepted' }
  }

  async #deferOrEscalate(path: string, intent: Intent): Promise<InboxPumpDecision> {
    const reconcileChecks = (intent.reconcileChecks ?? 0) + 1
    if (reconcileChecks >= MAX_AMBIGUOUS_RECONCILIATIONS) {
      await writeIntent(path, { ...intent, reconcileChecks, status: 'operator_required' })
      return { kind: 'operator_required' }
    }
    await writeIntent(path, { ...intent, reconcileChecks })
    return { kind: 'pending' }
  }

  #bridgeInput(intent: Intent, command: BridgeInput['command']): BridgeInput {
    const memberName = intent.message.recipient ?? TEAM_LEAD_NAME
    return { command, requestId: intent.requestId, teamId: this.#legacyKey,
      laneId: intent.selected.laneId, memberName,
      runId: intent.selected.runId, projectPath: intent.selected.projectPath,
      sessionId: intent.selected.sessionId, capabilitySnapshotId: intent.selected.capabilitySnapshotId,
      // The hash names the durable inbox row; the prompt wrapper is derived from it.
      messageId: intent.message.messageId, payloadHash: intent.textSha256,
      ...(command === 'send'
        ? {
          // Same delivery contract as desktop: the recipient learns who wrote it
          // and answers through message_send with relayOfMessageId.
          text: buildOpenCodeRuntimeMessageText({
            runId: intent.selected.runId,
            // Agents address their team by the admitted directory name, as the bridge does.
            teamName: this.#legacyKey,
            laneId: intent.selected.laneId,
            memberName,
            text: intent.message.text,
            messageId: inboxRowOf(intent.message).messageId,
            replyRecipient: intent.message.relay?.replyRecipient ?? 'user',
            ...(intent.message.relay?.taskRefs ? { taskRefs: intent.message.relay.taskRefs } : {}),
            ...(intent.message.relay?.messageKind ? { messageKind: intent.message.relay.messageKind } : {}),
            ...(intent.message.relay?.actionMode ? { actionMode: intent.message.relay.actionMode } : {}),
          }),
        }
        : {}),
      ...(intent.runtimePromptMessageId ? { runtimePromptMessageId: intent.runtimePromptMessageId } : {}) }
  }

  /**
   * A native lane member (Claude Code or Codex lead or process teammate) reads its
   * inbox file itself; prompting it through OpenCode would be wrong and retrying
   * would poll forever.
   */
  async #isNativeRecipient(authority: HostedControlAuthority, recipient: string): Promise<boolean> {
    const admission = await this.#planStore.load({ workspaceId: authority.workspaceId, teamId: authority.teamId })
    if (!admission || !(await admission.isCurrent())) return false
    const lanes = admission.plan.lanes.filter(lane => lane.members.some(member => member.name === recipient))
    return lanes.length === 1 && lanes[0]!.kind === 'native' && await admission.isCurrent()
  }

  async #select(
    authority: HostedControlAuthority,
    recipient: string,
    readOnly = false,
  ): Promise<Selected | SelectMiss> {
    const admission = await this.#planStore.load({ workspaceId: authority.workspaceId, teamId: authority.teamId })
    if (!admission) return { miss: 'plan_missing' }
    if (!(await admission.isCurrent())) return { miss: 'plan_not_current' }
    const lanes = admission.plan.lanes.filter(lane =>
      lane.members.some(member => member.name === recipient))
    if (lanes.length !== 1) return { miss: lanes.length === 0 ? 'recipient_not_in_plan' : 'recipient_lane_ambiguous' }
    if (admission.plan.workspaceRoot !== await realpath(admission.plan.workspaceRoot)) {
      return { miss: 'workspace_not_canonical' }
    }
    const state = readOnly
      ? await this.#readActiveRun(admission.plan)
      : await this.#execution.inspect(admission.plan)
    if (!state || state.phase !== 'running' || !state.runId) return { miss: `run_not_running:${state?.phase ?? 'none'}` }
    if (!(await admission.isCurrent())) return { miss: 'plan_not_current' }
    const lane = lanes[0]!
    if (lane.kind !== 'opencode') return { miss: 'lane_not_opencode' }
    // Host-local lanes register the runtime team under the admitted legacy key,
    // which is also the canonical team directory name.
    const session = await this.#getSession(this.#legacyKey, lane.laneId, recipient)
    const sessionMiss = !session ? 'session_missing'
      : isOpenCodeSessionStopped(session) ? 'session_stopped'
        : session.staleReason ? 'session_stale'
          : session.teamId !== this.#legacyKey ? 'session_team_mismatch'
            : session.runId !== state.runId ? 'session_run_mismatch'
              : session.laneId !== lane.laneId ? 'session_lane_mismatch'
                : session.memberName !== recipient ? 'session_member_mismatch'
                  : session.projectPath !== admission.plan.workspaceRoot ? 'session_project_mismatch'
                    : session.profileScope?.purpose !== 'launch_runtime' ? 'session_scope_mismatch'
                      : session.selectedModel !== lane.selectedModel ? 'session_model_mismatch'
                        : !session.opencodeSessionId ? 'session_id_missing'
                          : null
    if (sessionMiss || !session?.opencodeSessionId) return { miss: sessionMiss ?? 'session_id_missing' }
    const capabilitySnapshotId = session.stopAuthority?.runtime.capabilitySnapshotId ??
      await this.#getCapability({ teamId: this.#legacyKey, laneId: lane.laneId, runId: state.runId }).catch(() => null)
    if (!capabilitySnapshotId || !/^opencode:[a-f0-9]{32}$/.test(capabilitySnapshotId)) {
      return { miss: 'capability_missing' }
    }
    if (readOnly) {
      const latest = await this.#readActiveRun(admission.plan)
      if (!latest || latest.phase !== 'running' || latest.runId !== state.runId) return { miss: 'run_changed' }
    }
    if (!(await admission.isCurrent())) return { miss: 'plan_not_current' }
    return { planGeneration: admission.planGeneration, runId: state.runId,
      laneId: lane.laneId, sessionId: session.opencodeSessionId,
      capabilitySnapshotId,
      projectPath: admission.plan.workspaceRoot }
  }

  async #stillSelected(intent: Intent): Promise<boolean> {
    return (await this.#selectionMiss(intent)) === null
  }

  /** The read-only fence behind every effect; returns why it failed, or null. */
  async #selectionMiss(intent: Intent): Promise<string | null> {
    if (!this.#accepting) return 'pump_closing'
    if (!(await this.#guard.isCurrent(intent.authority))) return 'authority_not_current'
    const selected = await this.#select(intent.authority, intent.message.recipient ?? TEAM_LEAD_NAME, true)
    if (!this.#accepting || this.#abort.signal.aborted) return 'pump_closing'
    if ('miss' in selected) return `fence:${selected.miss}`
    if (!isDeepStrictEqual(selected, intent.selected)) return 'fence:selection_changed'
    const leaseCurrent = await this.#guard.isCurrent(intent.authority)
    if (!this.#accepting || this.#abort.signal.aborted) return 'pump_closing'
    return leaseCurrent ? null : 'authority_not_current'
  }

  async #readPersistedActiveRun(plan: TeamLifecycleLaunchPlan): Promise<{
    phase: string; runId: string | null
  } | null> {
    const state = asRecord(await readPrivateJson(join(this.#root,
      'hosted-lifecycle-execution-state.v1.json')))
    if (state?.schemaVersion !== 2 || state.phase !== 'running' ||
      typeof state.runId !== 'string' ||
      state.planFingerprint !== sha256(JSON.stringify(plan))) return null
    return { phase: state.phase, runId: state.runId }
  }

  /** Desktop parity: once the runtime accepted the prompt, the inbox row is read. */
  async #commitInboxRead(path: string, decision: InboxPumpDecision): Promise<InboxPumpDecision> {
    if (decision.kind !== 'accepted' && decision.kind !== 'observed') return decision
    try {
      const intent = await readPrivateJson(path) as Intent | null
      if (!intent || !validIntent(intent) || intent.inboxReadCommitted ||
        (intent.status !== 'accepted' && intent.status !== 'observed')) return decision
      const marked = await markMailboxMessageReadAtCanonicalTeamRoot({
        canonicalTeamRoot: this.#root,
        recipientName: intent.message.recipient ?? TEAM_LEAD_NAME,
        message: { ...inboxRowOf(intent.message),
          text: intent.message.text, timestamp: intent.message.createdAt },
      })
      if (marked === 'marked' || marked === 'already_read') {
        await writeIntent(path, { ...intent, inboxReadCommitted: true })
      }
    } catch { /* The prompt is accepted; recovery retries the read commit. */ }
    return decision
  }

  async #hasDurableInboxRow(message: PumpMessage, recipient: string): Promise<boolean> {
    const rows = await this.#readInbox(recipient)
    const row = inboxRowOf(message)
    const matches = rows.filter(candidate => candidate.messageId === row.messageId)
    return matches.length === 1 && matches[0]?.from === row.from &&
      matches[0].text === message.text && matches[0].timestamp === message.createdAt
  }

  async #hasDurableDeliveryReceipt(
    message: HostedPersistedMessage,
    recipient: string,
    authority: HostedControlAuthority,
  ): Promise<boolean> {
    const key = { actorId: authority.actorId, workspaceId: authority.workspaceId,
      teamId: authority.teamId, clientMessageId: message.clientMessageId }
    const digest = createHash('sha256')
      .update('agent-teams.hosted-message.delivery-operation/v1').update('\0')
      .update(JSON.stringify(key)).digest('hex')
    const record = asRecord(await readPrivateJson(join(this.#root, DELIVERY_DIRECTORY,
      `${digest}.delivery.v1.json`)))
    const binding = asRecord(record?.binding)
    return record?.schemaVersion === 1 && record.canonicalTeamRoot === this.#root &&
      record.legacyKey === this.#legacyKey && record.recipient === recipient &&
      record.status === 'delivered' && sameAuthority(record.authority as HostedControlAuthority, authority) &&
      binding?.actorId === authority.actorId && binding.workspaceId === authority.workspaceId &&
      binding.teamId === authority.teamId && binding.clientMessageId === message.clientMessageId &&
      binding.messageId === message.messageId && binding.textSha256 === sha256(message.text)
  }

  async #readInbox(recipient: string): Promise<Array<Record<string, unknown>>> {
    if (!isInboxRecipient(recipient)) throw new Error('Invalid hosted inbox recipient')
    const value = await readPrivateJson(join(this.#root, 'inboxes', `${recipient}.json`), MAX_INBOX_BYTES, 0o022)
    if (!Array.isArray(value) || value.length > 10_000 || value.some(row => !asRecord(row))) {
      throw new Error('Invalid hosted inbox')
    }
    return value as Array<Record<string, unknown>>
  }

  async #assertPrivateRoot(): Promise<void> {
    const stat = await lstat(this.#root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid()) ||
      await realpath(this.#root) !== this.#root ||
      join(dirname(this.#root), this.#legacyKey) !== this.#root) {
      throw new Error('Hosted inbox pump root is not private')
    }
  }

  async #prepareDirectory(): Promise<void> {
    const directory = join(this.#root, DIRECTORY)
    await mkdir(directory, { mode: 0o700 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    })
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid()) ||
      await realpath(directory) !== directory) throw new Error('Hosted inbox pump directory is unsafe')
  }
}

function sha256(text: string): string { return createHash('sha256').update(text).digest('hex') }
type WakeOutcome = { decision: InboxPumpDecision; reason: string | null }
function outcome(kind: InboxPumpDecision['kind'], reason: string | null = null): WakeOutcome {
  return { decision: { kind }, reason }
}
/** Attempt 0 keeps the original request id, so pre-retry intents reconcile unchanged. */
function requestIdFor(teamId: string, messageId: string, selected: Selected, attempt: number): string {
  const base = `${teamId}\0${messageId}\0${selected.planGeneration}\0${selected.runId}\0${selected.sessionId}`
  return `hosted-inbox-${sha256(attempt === 0 ? base : `${base}\0attempt-${attempt}`)}`
}
/** A bounded, text-free code for a bridge refusal. */
function bridgeFailure(result: BridgeResponse): string {
  if (result.ok) return typeof result.data?.status === 'string' ? result.data.status.slice(0, 48) : 'not_accepted'
  return 'bridge_error'
}
/** The inbox row a pump message stands for: its own id for operator rows, the source row otherwise. */
function inboxRowOf(message: PumpMessage): { messageId: string; from: string } {
  return message.relay
    ? { messageId: message.relay.sourceMessageId, from: message.relay.from }
    : { messageId: message.messageId, from: 'user' }
}
/** Hosted-only exclusions on top of the desktop selection; null leaves the row in the inbox. */
function relayMessage(teamId: string, recipient: string, deliverable: DeliverableInboxRow): PumpMessage | null {
  const { row } = deliverable
  // A member never gets its own rows; the read commit needs the raw sender and timestamp.
  if (deliverable.from.toLowerCase() === recipient.toLowerCase() || typeof row.from !== 'string' ||
    typeof row.timestamp !== 'string' || Buffer.byteLength(String(row.text)) > MAX_RELAY_TEXT_BYTES) {
    return null
  }
  const messageId = hostedInboxRelayMessageId(teamId, recipient, deliverable.sourceMessageId)
  return {
    teamId, messageId,
    // Unused by relay rows; the pattern only keeps one message shape across both paths.
    clientMessageId: `client_message_relay-${messageId.slice('message_'.length)}`,
    text: String(row.text), createdAt: row.timestamp,
    ...(recipient === TEAM_LEAD_NAME ? {} : { recipient }),
    relay: {
      sourceMessageId: deliverable.sourceMessageId,
      from: row.from,
      replyRecipient: deliverable.replyRecipient,
      ...relayPromptFields(row),
    },
  }
}
function isInboxRecipient(value: unknown): value is string {
  return value === TEAM_LEAD_NAME || isHostedMessageRecipientName(value)
}
/** The lead keeps its original key so intents written before recipients existed still resolve. */
function intentDigest(teamId: string, recipient: string, messageId: string): string {
  return recipient === TEAM_LEAD_NAME
    ? sha256(`agent-teams.hosted-inbox/v1\0${teamId}\0${messageId}`)
    : sha256(`agent-teams.hosted-inbox/v2\0${teamId}\0${recipient}\0${messageId}`)
}
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function sameAuthority(value: HostedControlAuthority, stable: Readonly<HostedControlStableAuthority>): boolean {
  return value?.workspaceId === stable.workspaceId && value.teamId === stable.teamId &&
    value.deploymentId === stable.deploymentId && value.bootId === stable.bootId &&
    value.restoreGeneration === stable.restoreGeneration &&
    value.mountBinding?.mountGeneration === stable.mountBinding.mountGeneration &&
    value.mountBinding?.declaredRootHash === stable.mountBinding.declaredRootHash
}
function validIntent(value: Intent): boolean {
  return value?.schemaVersion === 1 && asRecord(value.authority) !== null &&
    asRecord(value.message) !== null && asRecord(value.selected) !== null &&
    typeof value.requestId === 'string' && /^[0-9a-f]{64}$/.test(value.textSha256) &&
    (value.attempt === undefined || Number.isSafeInteger(value.attempt) &&
      value.attempt >= 0 && value.attempt < MAX_SEND_ATTEMPTS) &&
    (value.sendIssued === undefined || value.sendIssued === true) &&
    (value.reconcileChecks === undefined || Number.isSafeInteger(value.reconcileChecks) &&
      value.reconcileChecks >= 0 && value.reconcileChecks <= MAX_AMBIGUOUS_RECONCILIATIONS) &&
    ['intent', 'accepted', 'observed', 'operator_required'].includes(value.status)
}
function isTerminalResponseObservation(value: unknown, promptId: string): boolean {
  const observation = asRecord(value)
  return !!observation &&
    observation.deliveredUserMessageId === promptId &&
    typeof observation.assistantMessageId === 'string' && observation.assistantMessageId.length > 0 &&
    (observation.state === 'responded_visible_message' ||
      observation.state === 'responded_plain_text' ||
      observation.state === 'responded_tool_call' ||
      observation.state === 'responded_non_visible_tool')
}
function validNativeInboxRecord(value: NativeInboxRecord): boolean {
  return value.schemaVersion === 1 && asRecord(value.authority) !== null &&
    asRecord(value.message) !== null && /^[0-9a-f]{64}$/.test(value.textSha256)
}
async function writeIntent(path: string, intent: Intent | NativeInboxRecord): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(intent)}\n`, { mode: 0o600 })
  await fsyncFileAndParent(path)
}
/**
 * Pump state is 0600. Inboxes are shared with the agent-teams MCP writer, which
 * creates them under its umask, so for them only foreign write bits are refused.
 */
async function readPrivateJson(
  path: string,
  maxBytes = MAX_FILE_BYTES,
  forbiddenModeBits = 0o077,
): Promise<unknown | null> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (!handle) return null
  try {
    const [stat, linked] = await Promise.all([handle.stat(), lstat(path)])
    if (!stat.isFile() || !linked.isFile() || linked.isSymbolicLink() ||
      stat.dev !== linked.dev || stat.ino !== linked.ino || stat.size > maxBytes ||
      (stat.mode & forbiddenModeBits) !== 0 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid()) ||
      await realpath(path) !== path) throw new Error('Unsafe hosted inbox pump file')
    return JSON.parse(await handle.readFile('utf8')) as unknown
  } finally { await handle.close() }
}
