import { createHash } from 'node:crypto'
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

const DIRECTORY = 'hosted-team-lead-inbox-pump'
const DELIVERY_DIRECTORY = 'hosted-message-delivery-operations'
const MAX_FILE_BYTES = 32 * 1024
const MAX_INBOX_BYTES = 8 * 1024 * 1024
const MAX_AMBIGUOUS_RECONCILIATIONS = 12
const LOCK_OPTIONS = { realpath: false, retries: { retries: 50, minTimeout: 5, maxTimeout: 100 } } as const

type Selected = {
  planGeneration: string
  runId: string
  laneId: string
  sessionId: string
  capabilitySnapshotId: string
  projectPath: string
}
type Intent = {
  schemaVersion: 1
  authority: HostedControlAuthority
  message: HostedPersistedMessage
  textSha256: string
  selected: Selected
  requestId: string
  status: 'intent' | 'accepted' | 'observed' | 'operator_required'
  reconcileChecks?: number
  runtimePromptMessageId?: string
  /** Set once the recipient's inbox row is marked read after the runtime accepted the prompt. */
  inboxReadCommitted?: true
}
/** Terminal for the pump: a native process reads its own inbox, so the append is the delivery. */
type NativeInboxRecord = {
  schemaVersion: 1
  authority: HostedControlAuthority
  message: HostedPersistedMessage
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
  readonly #abort = new AbortController()
  readonly #pending = new Set<Promise<void>>()
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
  }

  async wake(message: HostedPersistedMessage, authority: HostedControlAuthority): Promise<InboxPumpDecision> {
    if (!this.#accepting) return { kind: 'unavailable' }
    const work = this.#wake(message, authority)
    const tracked = work.then(() => undefined, () => undefined)
    this.#pending.add(tracked)
    void tracked.finally(() => this.#pending.delete(tracked))
    return work
  }

  /** Install once during composition; the first active owner lease admits recovery. */
  start(pollIntervalMs = 5_000): void {
    if (!this.#accepting || this.#poller) return
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100) {
      throw new TypeError('Invalid hosted inbox pump polling interval')
    }
    this.#poller = setInterval(() => { void this.recover().catch(() => undefined) }, pollIntervalMs)
    this.#poller.unref?.()
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

  async #recover(): Promise<InboxPumpDecision[]> {
    if (!this.#accepting) return [{ kind: 'unavailable' }]
    await this.#assertPrivateRoot()
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

  async close(): Promise<void> {
    this.#accepting = false
    this.#abort.abort(new Error('Hosted inbox pump is closing'))
    if (this.#poller) clearInterval(this.#poller)
    this.#poller = null
    await this.#recovery?.catch(() => undefined)
    await Promise.all([...this.#pending])
  }

  async #wake(message: HostedPersistedMessage, authority: HostedControlAuthority): Promise<InboxPumpDecision> {
    if (!sameAuthority(authority, this.#authority) || message.teamId !== authority.teamId ||
      !/^message_[0-9a-f]{32}$/.test(message.messageId) ||
      !/^client_message_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(message.clientMessageId)) {
      return { kind: 'operator_required' }
    }
    const recipient = message.recipient ?? TEAM_LEAD_NAME
    if (message.recipient !== undefined && !isHostedMessageRecipientName(message.recipient)) {
      return { kind: 'operator_required' }
    }
    if (!(await this.#guard.isCurrent(authority))) return { kind: 'unavailable' }
    try {
      await this.#assertPrivateRoot()
      if (!(await this.#hasDurableInboxRow(message, recipient)) ||
        !(await this.#hasDurableDeliveryReceipt(message, recipient, authority))) return { kind: 'operator_required' }
      await this.#prepareDirectory()
      const path = join(this.#root, DIRECTORY, `${intentDigest(authority.teamId, recipient, message.messageId)}.json`)
      const release = await lockfile.lock(path, LOCK_OPTIONS)
      try {
        const stored = await readPrivateJson(path) as Intent | NativeInboxRecord | null
        if (stored?.status === 'native_inbox') {
          return validNativeInboxRecord(stored) && sameAuthority(stored.authority, authority) &&
            stored.authority.actorId === authority.actorId && isDeepStrictEqual(stored.message, message) &&
            stored.textSha256 === sha256(message.text)
            ? { kind: 'native_inbox' }
            : { kind: 'operator_required' }
        }
        let intent = stored
        if (intent) {
          if (!validIntent(intent) || !sameAuthority(intent.authority, authority) ||
            intent.authority.actorId !== authority.actorId ||
            !isDeepStrictEqual(intent.message, message) || intent.textSha256 !== sha256(message.text)) {
            return { kind: 'operator_required' }
          }
          if (intent.status === 'operator_required') return { kind: 'operator_required' }
          const decision = intent.status === 'observed' ? { kind: 'observed' as const } : await this.#reconcile(path, intent)
          return await this.#commitInboxRead(path, decision)
        }
        if (await this.#isNativeRecipient(authority, recipient)) {
          const record: NativeInboxRecord = { schemaVersion: 1, authority, message,
            textSha256: sha256(message.text), status: 'native_inbox' }
          await writeIntent(path, record)
          return { kind: 'native_inbox' }
        }
        const selected = await this.#select(authority, recipient)
        if (!selected) return { kind: 'unavailable' }
        const requestId = `hosted-inbox-${sha256(`${authority.teamId}\0${message.messageId}\0${selected.planGeneration}\0${selected.runId}\0${selected.sessionId}`)}`
        intent = { schemaVersion: 1, authority, message, textSha256: sha256(message.text),
          selected, requestId, status: 'intent' }
        await writeIntent(path, intent)
        if (!(await this.#stillSelected(intent)) || !this.#accepting) return { kind: 'unavailable' }
        let result: BridgeResponse
        try { result = await this.#executeBridge(this.#bridgeInput(intent, 'send'),
          () => this.#stillSelected(intent), this.#abort.signal) }
        catch { return await this.#reconcile(path, intent) }
        if (result.ok && result.data?.accepted === true && result.data.sessionId === selected.sessionId) {
          const promptId = result.data.runtimePromptMessageId
          intent = { ...intent, status: 'accepted', reconcileChecks: 0,
            ...(typeof promptId === 'string' ? { runtimePromptMessageId: promptId } : {}) }
          await writeIntent(path, intent)
          return await this.#commitInboxRead(path, { kind: 'accepted' })
        }
        // Awaited so the reconcile and read commit finish while this intent lock is held.
        return await this.#commitInboxRead(path, await this.#reconcile(path, intent))
      } finally { await release() }
    } catch { return { kind: 'operator_required' } }
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
        // The owner never reissues a prompt from an existing intent. Operator can
        // explicitly decide whether to abandon or recreate the hosted message.
        await writeIntent(path, { ...intent, status: 'operator_required' })
        return { kind: 'operator_required' }
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
          // Same delivery contract as desktop: the recipient learns it was the
          // user and answers through message_send with relayOfMessageId.
          text: buildOpenCodeRuntimeMessageText({
            runId: intent.selected.runId,
            // Agents address their team by the admitted directory name, as the bridge does.
            teamName: this.#legacyKey,
            laneId: intent.selected.laneId,
            memberName,
            text: intent.message.text,
            messageId: intent.message.messageId,
            replyRecipient: 'user',
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
  ): Promise<Selected | null> {
    const admission = await this.#planStore.load({ workspaceId: authority.workspaceId, teamId: authority.teamId })
    if (!admission || !(await admission.isCurrent())) return null
    const lanes = admission.plan.lanes.filter(lane =>
      lane.members.some(member => member.name === recipient))
    if (lanes.length !== 1 || admission.plan.workspaceRoot !== await realpath(admission.plan.workspaceRoot)) return null
    const state = readOnly
      ? await this.#readActiveRun(admission.plan)
      : await this.#execution.inspect(admission.plan)
    if (!state || state.phase !== 'running' || !state.runId || !(await admission.isCurrent())) return null
    const lane = lanes[0]!
    if (lane.kind !== 'opencode') return null
    // Host-local lanes register the runtime team under the admitted legacy key,
    // which is also the canonical team directory name.
    const session = await this.#getSession(this.#legacyKey, lane.laneId, recipient)
    if (!session || isOpenCodeSessionStopped(session) || session.staleReason ||
      session.teamId !== this.#legacyKey || session.runId !== state.runId || session.laneId !== lane.laneId ||
      session.memberName !== recipient || session.projectPath !== admission.plan.workspaceRoot ||
      session.profileScope?.purpose !== 'launch_runtime' ||
      session.selectedModel !== lane.selectedModel ||
      !session.opencodeSessionId) return null
    const capabilitySnapshotId = session.stopAuthority?.runtime.capabilitySnapshotId ??
      await this.#getCapability({ teamId: this.#legacyKey, laneId: lane.laneId, runId: state.runId }).catch(() => null)
    if (!capabilitySnapshotId || !/^opencode:[a-f0-9]{32}$/.test(capabilitySnapshotId)) return null
    if (readOnly) {
      const latest = await this.#readActiveRun(admission.plan)
      if (!latest || latest.phase !== 'running' || latest.runId !== state.runId) return null
    }
    if (!(await admission.isCurrent())) return null
    return { planGeneration: admission.planGeneration, runId: state.runId,
      laneId: lane.laneId, sessionId: session.opencodeSessionId,
      capabilitySnapshotId,
      projectPath: admission.plan.workspaceRoot }
  }

  async #stillSelected(intent: Intent): Promise<boolean> {
    if (!this.#accepting || !(await this.#guard.isCurrent(intent.authority))) return false
    const selected = await this.#select(intent.authority, intent.message.recipient ?? TEAM_LEAD_NAME, true)
    if (!this.#accepting || this.#abort.signal.aborted || !selected ||
      !isDeepStrictEqual(selected, intent.selected)) return false
    const leaseCurrent = await this.#guard.isCurrent(intent.authority)
    return this.#accepting && !this.#abort.signal.aborted && leaseCurrent
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
        message: { messageId: intent.message.messageId, from: 'user',
          text: intent.message.text, timestamp: intent.message.createdAt },
      })
      if (marked === 'marked' || marked === 'already_read') {
        await writeIntent(path, { ...intent, inboxReadCommitted: true })
      }
    } catch { /* The prompt is accepted; recovery retries the read commit. */ }
    return decision
  }

  async #hasDurableInboxRow(message: HostedPersistedMessage, recipient: string): Promise<boolean> {
    const rows = await this.#readInbox(recipient)
    const matches = rows.filter(row => row.messageId === message.messageId)
    return matches.length === 1 && matches[0]?.from === 'user' &&
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
    const value = await readPrivateJson(join(this.#root, 'inboxes', `${recipient}.json`), MAX_INBOX_BYTES)
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
async function readPrivateJson(path: string, maxBytes = MAX_FILE_BYTES): Promise<unknown | null> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (!handle) return null
  try {
    const [stat, linked] = await Promise.all([handle.stat(), lstat(path)])
    if (!stat.isFile() || !linked.isFile() || linked.isSymbolicLink() ||
      stat.dev !== linked.dev || stat.ino !== linked.ino || stat.size > maxBytes ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid?.() !== undefined && stat.uid !== process.getuid()) ||
      await realpath(path) !== path) throw new Error('Unsafe hosted inbox pump file')
    return JSON.parse(await handle.readFile('utf8')) as unknown
  } finally { await handle.close() }
}
