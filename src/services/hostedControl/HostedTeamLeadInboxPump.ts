import { createHash } from 'node:crypto'
import { statSync, watch, type FSWatcher } from 'node:fs'
import { constants, lstat, mkdir, open, realpath } from 'node:fs/promises'
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
import type { HostedMessageAuthorityGuard } from './HostedTeamMessageService.js'
import { fsyncFileAndParent } from './HostedTaskMutationWal.js'
import { isHostedMessageRecipientName } from './HostedTeamRecipientRoster.js'
import {
  hostedInboxRelayMessageId,
  relayPromptFields,
  selectDeliverableInboxRows,
  type DeliverableInboxRow,
} from './HostedInboxRelayRows.js'

const DIRECTORY = 'hosted-team-lead-inbox-pump'
/** Intents carry the prompt text; relayed teammate rows may be up to MAX_RELAY_TEXT_BYTES. */
const MAX_FILE_BYTES = 256 * 1024
/** Larger teammate rows stay in the inbox for the recipient's own reads. */
const MAX_RELAY_TEXT_BYTES = 64 * 1024
/** Actor recorded on intents: the inbox row, not a browser request, is what the pump delivers. */
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
/** The inbox row a prompt stands for, and whom its recipient answers, as in desktop's inbox relay. */
type RelayOrigin = {
  sourceMessageId: string
  from: string
  replyRecipient: string
} & ReturnType<typeof relayPromptFields>
/**
 * One inbox row, operator or teammate, as the pump prompts it. The row itself is
 * the durable source; `messageId` is the bridge id derived from its id.
 */
type PumpMessage = {
  teamId: string
  messageId: string
  text: string
  createdAt: string
  /** Absent for team-lead. */
  recipient?: string
  relay: RelayOrigin
}
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
 * The hosted counterpart of desktop's OpenCode member inbox relay: it prompts every
 * deliverable inbox row, operator or teammate, into its OpenCode recipient's
 * session and marks the row read once the session accepted it.
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
  /** One drain per recipient at a time keeps each queue FIFO across wakes and recovery. */
  readonly #drains = new Map<string, Promise<Map<string, InboxPumpDecision>>>()
  /** The one drain waiting behind a running one; later requests join it instead of queueing more. */
  readonly #queuedDrains = new Map<string, Promise<Map<string, InboxPumpDecision>>>()
  readonly #watchDebounces = new Map<string, ReturnType<typeof setTimeout>>()
  #watcher: FSWatcher | null = null
  /** Identity of the watched inboxes/ directory; a recreated directory is watched anew. */
  #watchedInbox: string | null = null
  #poller: ReturnType<typeof setInterval> | null = null
  #recovery: Promise<InboxPumpDecision[]> | null = null
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

  /**
   * Prompts the recipient's queue now and answers for one row of it: its decision
   * when this drain reached it, otherwise the state its intent settled in.
   */
  async wakeRecipient(recipient: string, sourceMessageId: string): Promise<InboxPumpDecision> {
    if (!this.#accepting || !isInboxRecipient(recipient)) return { kind: 'unavailable' }
    try {
      const lane = await this.#recipientLaneKind(recipient)
      // A native member reads its own inbox: the appended row is the delivery.
      if (lane === 'native') return { kind: 'native_inbox' }
      if (lane !== 'opencode') return { kind: 'unavailable' }
      const decisions = await this.#drainRecipient(recipient)
      return decisions.get(sourceMessageId) ?? await this.#settledDecision(recipient, sourceMessageId)
    } catch { return { kind: 'unavailable' } }
  }

  /**
   * Install once during composition; the first active owner lease admits recovery.
   * A watch on inboxes/ drains the changed member's queue within the debounce, like
   * desktop's file watcher; the poll stays the fallback and re-arms the watch.
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
        const file = name === null ? null : String(name)
        if (file !== null && !file.endsWith('.json')) return
        // A nameless event cannot be attributed to one member: drain them all.
        this.#debounceWake(file === null ? null : file.slice(0, -'.json'.length))
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
  }

  #debounceWake(recipient: string | null): void {
    const key = recipient ?? ''
    const previous = this.#watchDebounces.get(key)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.#watchDebounces.delete(key)
      if (!this.#accepting) return
      if (recipient === null || !isInboxRecipient(recipient)) {
        void this.recover().catch(() => undefined)
        return
      }
      void this.#recipientLaneKind(recipient)
        .then(lane => { if (lane === 'opencode') return this.#drainRecipient(recipient) })
        .catch(() => undefined)
    }, INBOX_WATCH_DEBOUNCE_MS)
    timer.unref?.()
    this.#watchDebounces.set(key, timer)
  }

  /** Drains every OpenCode member's inbox; a missed wake loses no message. */
  recover(): Promise<InboxPumpDecision[]> {
    if (this.#recovery) return this.#recovery
    const recovery = this.#recover()
    this.#recovery = recovery
    void recovery.finally(() => { if (this.#recovery === recovery) this.#recovery = null }).catch(() => undefined)
    return recovery
  }

  async #recover(): Promise<InboxPumpDecision[]> {
    if (!this.#accepting) return [{ kind: 'unavailable' }]
    await this.#assertPrivateRoot()
    const admission = await this.#planStore.load({
      workspaceId: this.#authority.workspaceId, teamId: this.#authority.teamId,
    })
    if (!admission || !(await admission.isCurrent())) return []
    const members = [...new Set(admission.plan.lanes
      .filter(lane => lane.kind === 'opencode')
      .flatMap(lane => lane.members.map(member => member.name))
      .filter(isInboxRecipient))]
    const results: InboxPumpDecision[] = []
    for (const recipient of members) {
      if (!this.#accepting) break
      results.push(...(await this.#drainRecipient(recipient)).values())
    }
    return results
  }

  #drainRecipient(recipient: string): Promise<Map<string, InboxPumpDecision>> {
    // A drain not started yet reads the inbox as it will be then: joining it loses nothing.
    const queued = this.#queuedDrains.get(recipient)
    if (queued) return queued
    const previous = this.#drains.get(recipient) ?? Promise.resolve(new Map())
    const drain = previous.catch(() => undefined).then(() => {
      if (this.#queuedDrains.get(recipient) === drain) this.#queuedDrains.delete(recipient)
      return this.#drain(recipient)
    })
    this.#queuedDrains.set(recipient, drain)
    this.#drains.set(recipient, drain)
    const tracked = drain.then(() => undefined, () => undefined)
    this.#pending.add(tracked)
    void tracked.finally(() => {
      this.#pending.delete(tracked)
      if (this.#drains.get(recipient) === drain) this.#drains.delete(recipient)
    })
    return drain
  }

  /**
   * Every row desktop's OpenCode member inbox relay prompts, in its order: FIFO
   * per recipient, so a row that cannot be prompted yet holds the rows behind it.
   */
  async #drain(recipient: string): Promise<Map<string, InboxPumpDecision>> {
    const decisions = new Map<string, InboxPumpDecision>()
    let rows: Array<Record<string, unknown>>
    try { rows = await this.#readInbox(recipient) } catch { return decisions }
    const authority: HostedControlAuthority = { actorId: RELAY_ACTOR_ID, ...this.#authority }
    for (const deliverable of selectDeliverableInboxRows(rows, recipient)) {
      if (!this.#accepting) break
      const message = relayMessage(authority.teamId, recipient, deliverable)
      if (!message) continue
      const { decision, reason } = await this.#wake(message, authority)
      this.#report(message, decision, reason)
      decisions.set(deliverable.sourceMessageId, decision)
      if (decision.kind === 'pending' || decision.kind === 'unavailable') break
    }
    return decisions
  }

  /** The state a row's intent settled in when this drain did not reach it. */
  async #settledDecision(recipient: string, sourceMessageId: string): Promise<InboxPumpDecision> {
    const intent = await readPrivateJson(join(this.#root, DIRECTORY,
      `${intentDigest(this.#authority.teamId, recipient, sourceMessageId)}.json`)).catch(() => null) as Intent | null
    if (!intent || !validIntent(intent)) return { kind: 'pending' }
    if (intent.status === 'observed' || intent.status === 'accepted' || intent.status === 'operator_required') {
      return { kind: intent.status }
    }
    return { kind: 'pending' }
  }

  async #recipientLaneKind(recipient: string): Promise<'opencode' | 'native' | null> {
    const admission = await this.#planStore.load({
      workspaceId: this.#authority.workspaceId, teamId: this.#authority.teamId,
    })
    if (!admission || !(await admission.isCurrent())) return null
    const lanes = admission.plan.lanes.filter(lane => lane.members.some(member => member.name === recipient))
    return lanes.length === 1 ? lanes[0]!.kind : null
  }

  async close(): Promise<void> {
    this.#accepting = false
    this.#abort.abort(new Error('Hosted inbox pump is closing'))
    if (this.#poller) clearInterval(this.#poller)
    this.#poller = null
    for (const timer of this.#watchDebounces.values()) clearTimeout(timer)
    this.#watchDebounces.clear()
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
      this.#reportDecision(Object.freeze({ messageId: message.relay.sourceMessageId,
        recipient: message.recipient ?? TEAM_LEAD_NAME, decision: decision.kind, reason }))
    } catch { /* Diagnostics never change delivery. */ }
  }

  async #wake(message: PumpMessage, authority: HostedControlAuthority): Promise<WakeOutcome> {
    if (!sameAuthority(authority, this.#authority) || message.teamId !== authority.teamId ||
      !/^message_[0-9a-f]{32}$/.test(message.messageId)) {
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
      await this.#prepareDirectory()
      const path = join(this.#root, DIRECTORY,
        `${intentDigest(authority.teamId, recipient, inboxRowOf(message).messageId)}.json`)
      const release = await lockfile.lock(path, LOCK_OPTIONS)
      try {
        const intent = await readPrivateJson(path) as Intent | null
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
/** The inbox row a pump message stands for. */
function inboxRowOf(message: PumpMessage): { messageId: string; from: string } {
  return { messageId: message.relay.sourceMessageId, from: message.relay.from }
}
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
async function writeIntent(path: string, intent: Intent): Promise<void> {
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
