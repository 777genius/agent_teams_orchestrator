import { createHash } from 'node:crypto'
import { constants, link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { TaskMutationLockUnavailableError, withTaskMutationCoordination } from '../../utils/taskMutationCoordinator.js'
import { fingerprintHostedTaskCommand } from './protocol.js'
import { hostedTaskBoardRevision, hostedTaskBoardSourceGeneration, hostedTaskBoardTaskId } from './HostedTaskBoardIdentity.js'
import { ControllerFileLockTimeoutError, withControllerFileLock } from './HostedControllerFileLock.js'
import type { HostedControlAuthority, HostedControlStableAuthority, HostedTaskMutationCommand, HostedTaskMutationCommittedResult, HostedTaskMutationReceipt, HostedTaskMutationRequest, HostedTaskMutationTerminalResult } from './protocol.js'
import { fsyncDirectoryPath, fsyncFileAndParent, HOSTED_MUTATION_RETRY_AFTER_MS, HostedTaskMutationWal, type HostedMutationFileImage, type HostedMutationIntent, type HostedMutationWrite } from './HostedTaskMutationWal.js'

type BoardState = { sourceGeneration: string; revision: string; directories: { team: [number, number]; tasks: [number, number] }; taskMembership: string[]; rosterGuard: string; roster: Array<[string, string | null]>; allTaskTexts: Map<string, string>; tasks: Map<string, { rawId: string; publicId: string; path: string; text: string; value: Record<string, unknown> }>; kanbanPath: string; kanbanText: string | null; kanban: Record<string, unknown>; ledgerPath: string; ledgerText: string | null; ledger: MutationLedger }
type SourceState = Pick<BoardState, 'sourceGeneration' | 'directories'>
type MutationLedger = { schemaVersion: 2; entries: Record<string, LedgerEntry> }
type LedgerEntry = { fingerprint: string; commandId: string; sourceGeneration: string; expectedRevision: string; receipt: HostedTaskMutationReceipt; committedAtMs: number }
export type HostedTaskSelfWriteEffect = { fileKey: string; expectedChecksum: string }
export type HostedTaskMutationOutcome = { result: HostedTaskMutationTerminalResult; selfWriteEffects: HostedTaskSelfWriteEffect[] }
type PlanResult = { writes: HostedMutationWrite[]; result: HostedTaskMutationCommittedResult } | { terminal: HostedTaskMutationTerminalResult }
type CrashStage = 'after_task_detach' | 'after_task_write' | 'before_kanban_write' | 'before_terminal'
class ControlledHostedMutationCrash extends Error {}
const TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const
const COLUMNS = ['todo', 'in_progress', 'review', 'approved', 'done'] as const
const MAX_ROSTER_FILE_BYTES = 256 * 1024
const MAX_ROSTER_MEMBERS = 512
type Column = typeof COLUMNS[number]

export type HostedTaskMutationServiceOptions = {
  claudeRoot: string
  legacyKey: string
  authority: HostedControlStableAuthority
  wal: HostedTaskMutationWal
  /** Production fence until Product provides an atomic final-write task port. */
  denyOwnerLocalWrites?: boolean
  validateOwner?: () => boolean | Promise<boolean>
  now?: () => number
  crashHook?: (stage: CrashStage) => void | Promise<void>
}

export class HostedTaskMutationService {
  readonly #now: () => number
  readonly #validateOwner: () => boolean | Promise<boolean>
  constructor(private readonly options: HostedTaskMutationServiceOptions) {
    this.#now = options.now ?? Date.now
    this.#validateOwner = options.validateOwner ?? (() => true)
  }

  /** Canonical, coordinated Owner board read for one immutable hosted member. */
  async readTaskForMember(input: Readonly<{ teamId: string; taskId: string; memberId: string }>): Promise<Readonly<{
    teamId: string; taskId: string; ownerId: string; status: 'pending' | 'in_progress' | 'completed'
    sourceGeneration: string; revision: string; task: Readonly<Record<string, unknown>>
  }> | null> {
    if (input.teamId !== this.options.authority.teamId || !/^task_[0-9a-f]{32}$/.test(input.taskId) ||
      !/^member_[0-9a-f]{32}$/.test(input.memberId)) return null
    try {
      return await withTaskMutationCoordination(this.options.legacyKey, async () => {
        if (!(await this.#validateOwner()) || (await this.options.wal.listAmbiguous()).length !== 0) return null
        const members = await this.#activeMembers()
        if (members.get(input.memberId) !== input.memberId) return null
        const state = await this.#readBoardState(await this.#readSourceState())
        const record = state.tasks.get(input.taskId)
        if (!record || record.value.owner !== input.memberId ||
          !TASK_STATUSES.includes(record.value.status as typeof TASK_STATUSES[number])) return null
        const revision = await this.#revision(state.sourceGeneration, state.allTaskTexts, state.kanbanText, state.roster)
        const final = await this.#readBoardState(await this.#readSourceState())
        if (final.sourceGeneration !== state.sourceGeneration ||
          (await this.#revision(final.sourceGeneration, final.allTaskTexts, final.kanbanText, final.roster)) !== revision ||
          final.tasks.get(input.taskId)?.text !== record.text ||
          (await this.#activeMembers()).get(input.memberId) !== input.memberId ||
          !(await this.#validateOwner())) return null
        return { teamId: input.teamId, taskId: input.taskId, ownerId: input.memberId,
          status: record.value.status as 'pending' | 'in_progress' | 'completed',
          sourceGeneration: state.sourceGeneration, revision, task: { ...record.value } }
      }, { claudeRoot: this.options.claudeRoot })
    } catch { return null }
  }

  async recover(): Promise<boolean> {
    try { await this.options.wal.adoptLegacyWal() } catch { return false }
    if (this.options.denyOwnerLocalWrites) {
      try { return (await this.options.wal.listAmbiguous()).length === 0 } catch { return false }
    }
    try { return await withTaskMutationCoordination(this.options.legacyKey, async () => {
      if (!(await this.#validateOwner())) return false
      try { const recovered = await this.options.wal.withFence(() => this.#withBoardLock(() => this.#recoverPrepared())); return recovered ?? false } catch { return false }
    }, { claudeRoot: this.options.claudeRoot }) } catch { return false }
  }

  async mutate(request: HostedTaskMutationRequest): Promise<HostedTaskMutationTerminalResult> {
    return (await this.mutateWithSelfWriteEffects(request)).result
  }

  /** Effects are the task files this exact call published; replays and recovered intents report none. */
  async mutateWithSelfWriteEffects(request: HostedTaskMutationRequest): Promise<HostedTaskMutationOutcome> {
    const outcome = (result: HostedTaskMutationTerminalResult): HostedTaskMutationOutcome => ({ result, selfWriteEffects: [] })
    if (this.options.denyOwnerLocalWrites) return outcome({ kind: 'unavailable' })
    if (!sameAuthority(request.authority, this.options.authority)) return outcome({ kind: 'unavailable' })
    try { return await withTaskMutationCoordination(this.options.legacyKey, async () => {
      if (!(await this.#validateOwner())) return outcome({ kind: 'unsafe_active' })
      let fenced: HostedTaskMutationOutcome | undefined
      try { fenced = await this.options.wal.withFence(() => this.#mutateFenced(request)) } catch { return outcome({ kind: 'unsafe_active' })
      }
      return fenced ?? outcome({ kind: 'unavailable', retryAfterMs: HOSTED_MUTATION_RETRY_AFTER_MS })
    }, { claudeRoot: this.options.claudeRoot }) } catch (error) { return outcome(error instanceof TaskMutationLockUnavailableError ? { kind: 'unavailable', retryAfterMs: HOSTED_MUTATION_RETRY_AFTER_MS } : { kind: 'unsafe_active' }) }
  }

  async #recoverPrepared(): Promise<boolean> {
    for (const intent of await this.options.wal.listAmbiguous()) if (!(await this.#recoverIntent(intent))) return false
    return true
  }

  async #mutateFenced(request: HostedTaskMutationRequest): Promise<HostedTaskMutationOutcome> {
    const published: HostedMutationWrite[] = []
    let result: HostedTaskMutationTerminalResult
    try {
      result = await this.#withBoardLock(() => this.#mutateFencedResult(request, published))
    } catch (error) {
      if (!(error instanceof ControllerFileLockTimeoutError)) throw error
      return { result: { kind: 'unavailable', retryAfterMs: HOSTED_MUTATION_RETRY_AFTER_MS }, selfWriteEffects: [] }
    }
    return { result, selfWriteEffects: result.kind === 'committed' ? taskSelfWriteEffects(published) : [] }
  }

  /**
   * Agents change the same task and kanban files through the MCP controller under
   * `<team>/board-state`. Hold that lock from the board read and recovery through publication and
   * the terminal WAL: a preimage an agent changed after the read would leave a prepared intent that
   * recovery refuses. Order: task coordination, then the WAL fence, then this lock; the controller
   * takes none of the Owner's locks while it holds the board lock.
   */
  #withBoardLock<T>(run: () => Promise<T>): Promise<T> {
    return withControllerFileLock(join(this.options.claudeRoot, 'teams', this.options.legacyKey, 'board-state'), run)
  }

  async #mutateFencedResult(request: HostedTaskMutationRequest, published: HostedMutationWrite[]): Promise<HostedTaskMutationTerminalResult> {
      if (!(await this.#recoverPrepared())) return { kind: 'unsafe_active' }
      const command = request.payload.command
      let source: SourceState
      try { source = await this.#readSourceState() } catch { return { kind: 'unsafe_active' } }
      if (command.expectedSourceGeneration !== source.sourceGeneration) return { kind: 'stale_generation', currentSourceGeneration: source.sourceGeneration }
      const scope = { teamId: command.teamId, sourceGeneration: command.expectedSourceGeneration, idempotencyKey: command.idempotencyKey }

      let state: BoardState
      try { state = await this.#readBoardState(source) } catch { return { kind: 'unsafe_active' } }

      const durableEntry = state.ledger.entries[ledgerKey(command)]
      if (durableEntry) {
        if (durableEntry.fingerprint !== request.payload.payloadFingerprint) return { kind: 'conflict', reason: 'idempotency_mismatch', currentSourceGeneration: state.sourceGeneration }
        return { kind: 'idempotent_replay', currentSourceGeneration: state.sourceGeneration, payloadFingerprint: durableEntry.fingerprint, receipt: { ...durableEntry.receipt, outcome: 'idempotent_replay' } }
      }
      state.revision = await this.#revision(state.sourceGeneration, state.allTaskTexts, state.kanbanText, state.roster)
      if (command.expectedRevision !== state.revision) return { kind: 'stale_revision', currentSourceGeneration: state.sourceGeneration, currentRevision: state.revision }

      const planned = await this.#plan(state, command, request.payload.payloadFingerprint)
      if ('terminal' in planned) return planned.terminal
      const intent = await this.options.wal.appendIntent({ scope, commandId: command.commandId, payloadFingerprint: request.payload.payloadFingerprint, expectedRevision: command.expectedRevision, committedResult: planned.result, writes: planned.writes, directories: state.directories, taskMembership: state.taskMembership, rosterGuard: state.rosterGuard, authority: request.authority, command, canonicalScope: { claudeRoot: await realpath(this.options.claudeRoot), teamDirectory: await realpath(join(this.options.claudeRoot, 'teams', this.options.legacyKey)), tasksDirectory: await realpath(join(this.options.claudeRoot, 'tasks', this.options.legacyKey)) } })
      try {
        await this.#applyWrites(intent)
        await this.#runCrashHook('before_terminal')
        if (!(await this.#validateIntentGuards(intent))) throw new Error('Hosted board guard changed before terminal receipt')
        await this.options.wal.appendTerminal(intent.walId, planned.result)
        published.push(...intent.writes)
        return planned.result
      } catch (error) {
        return error instanceof ControlledHostedMutationCrash ? { kind: 'unavailable', retryAfterMs: HOSTED_MUTATION_RETRY_AFTER_MS } : { kind: 'unsafe_active' }
      }
  }

  async #recoverIntent(intent: HostedMutationIntent): Promise<boolean> {
    const command = intent.command; const receipt = intent.committedResult.receipt
    if (fingerprintHostedTaskCommand(command) !== intent.payloadFingerprint || command.teamId !== intent.scope.teamId || command.expectedSourceGeneration !== intent.scope.sourceGeneration || command.idempotencyKey !== intent.scope.idempotencyKey || receipt.commandId !== command.commandId || receipt.teamId !== command.teamId || receipt.sourceGeneration !== command.expectedSourceGeneration) return false
    if (!(await this.#validateRecoveryScope(intent))) return false
    if (!(await this.#resumeDetachedPublications(intent))) return false
    if (!(await this.#validateIntentGuards(intent))) return false
    for (const write of intent.writes) {
      const current = await this.#readTarget(write.target)
      if (!matchesPreimage(current, write.before) && !sameImage(current, write.after)) return false
    }
    for (const write of intent.writes) {
      if (!(await this.#validateIntentGuards(intent))) return false
      const current = await this.#readTarget(write.target)
      if (sameImage(current, write.after)) { await this.#finishPublishedTarget(write.target); continue }
      if (!matchesPreimage(current, write.before)) return false
      await this.#publishTarget(intent, write)
    }
    if (!(await this.#validateIntentGuards(intent))) return false
    await this.options.wal.appendTerminal(intent.walId, intent.committedResult)
    return true
  }

  async #plan(state: BoardState, command: HostedTaskMutationCommand, fingerprint: string): Promise<PlanResult> {
    const taskTexts = new Map(state.allTaskTexts)
    const kanban = cloneKanban(state.kanban)
    const affected: string[] = []
    let taskTarget: string | null = null
    let taskAfter: string | null = null
    let kanbanChanged = false
    const existing = 'taskId' in command ? state.tasks.get(command.taskId) : undefined
    if ('taskId' in command && !existing) return { terminal: { kind: 'not_found' } }

    switch (command.kind) {
      case 'create_task': {
        const rawId = `hosted-${sha(JSON.stringify({ commandId: command.commandId })).slice(0, 40)}`
        const publicId = hostedTaskBoardTaskId(command.teamId, rawId)
        const name = `${rawId}.json`
        if (taskTexts.has(name)) return { terminal: stateConflict(state) }
        const owner = command.ownerId === null ? null : (await this.#activeMembers()).get(command.ownerId)
        if (command.ownerId && owner === undefined) return { terminal: stateConflict(state) }
        const task: Record<string, unknown> = { id: rawId, subject: command.subject, ...(command.description === null ? {} : { description: command.description }), status: command.status, blocks: [], blockedBy: [], ...(owner ? { owner } : {}) }
        taskAfter = taskText(task); taskTarget = `task:${name}`; taskTexts.set(name, taskAfter); affected.push(publicId)
        placeTask(kanban, rawId, command.column, command.order, new Date(this.#now()).toISOString(), state.tasks)
        kanbanChanged = true
        break
      }
      case 'update_details': {
        const next = { ...existing!.value }
        if (Object.hasOwn(command, 'subject')) next.subject = command.subject
        if (Object.hasOwn(command, 'description')) {
          if (command.description === null) delete next.description
          else next.description = command.description
        }
        taskAfter = taskText(next); if (taskAfter === existing!.text) return { terminal: stateConflict(state) }
        taskTarget = `task:${basename(existing!.path)}`; taskTexts.set(basename(existing!.path), taskAfter); affected.push(command.taskId); break
      }
      case 'update_owner': {
        const owner = command.ownerId === null ? null : (await this.#activeMembers()).get(command.ownerId)
        if (command.ownerId && owner === undefined) return { terminal: stateConflict(state) }
        const next = { ...existing!.value }; if (owner === null) delete next.owner; else next.owner = owner
        taskAfter = taskText(next); if (taskAfter === existing!.text) return { terminal: stateConflict(state) }
        taskTarget = `task:${basename(existing!.path)}`; taskTexts.set(basename(existing!.path), taskAfter); affected.push(command.taskId); break
      }
      case 'update_status': {
        if (existing!.value.status === command.status) return { terminal: stateConflict(state) }
        taskAfter = taskText({ ...existing!.value, status: command.status }); taskTarget = `task:${basename(existing!.path)}`; taskTexts.set(basename(existing!.path), taskAfter); affected.push(command.taskId); break
      }
      case 'move_task': {
        const current = currentColumn(kanban, existing!.rawId, existing!.value.status)
        const currentOrder = actualColumnOrder(kanban, current, state.tasks).indexOf(existing!.rawId)
        const targetWithoutTask = actualColumnOrder(kanban, command.column, state.tasks).filter(id => id !== existing!.rawId)
        const clampedOrder = Math.min(command.order, targetWithoutTask.length)
        if (current === command.column && currentOrder === clampedOrder) return { terminal: stateConflict(state) }
        placeTask(kanban, existing!.rawId, command.column, command.order, new Date(this.#now()).toISOString(), state.tasks); affected.push(command.taskId); kanbanChanged = true; break
      }
      case 'reorder_column': {
        const rawIds = command.orderedTaskIds.map(id => state.tasks.get(id)?.rawId)
        if (rawIds.some(id => !id)) return { terminal: stateConflict(state) }
        const current = actualColumnOrder(kanban, command.column, state.tasks)
        if (current.length !== rawIds.length || current.some(id => !rawIds.includes(id)) || current.every((id, i) => id === rawIds[i])) return { terminal: stateConflict(state) }
        setColumnOrder(kanban, command.column, rawIds as string[]); affected.push(...command.orderedTaskIds); kanbanChanged = true; break
      }
    }

    const kanbanAfter = kanbanChanged ? JSON.stringify(kanban, null, 2) : state.kanbanText
    const revision = await this.#revision(state.sourceGeneration, taskTexts, kanbanAfter, state.roster)
    const receipt: HostedTaskMutationReceipt = { schemaVersion: 1, outcome: 'committed', commandId: command.commandId, teamId: command.teamId, sourceGeneration: state.sourceGeneration, revision, affectedTaskIds: [...new Set(affected)].sort() }
    const ledger = compactLedger(state.ledger, state.sourceGeneration)
    const currentLedgerKey = ledgerKey(command)
    ledger.entries[currentLedgerKey] = { fingerprint, commandId: command.commandId, sourceGeneration: state.sourceGeneration, expectedRevision: command.expectedRevision, receipt, committedAtMs: this.#now() }
    const ledgerAfter = serializeLedgerBounded(ledger, currentLedgerKey)
    const writes: HostedMutationWrite[] = []
    if (taskTarget && taskAfter !== null) writes.push({ target: taskTarget, before: await this.#readTarget(taskTarget), after: image(taskAfter) })
    if (kanbanChanged) writes.push({ target: 'kanban', before: await this.#readTarget('kanban'), after: image(kanbanAfter!) })
    writes.push({ target: 'ledger', before: await this.#readTarget('ledger'), after: image(ledgerAfter) })
    return { writes, result: { kind: 'committed', currentSourceGeneration: state.sourceGeneration, payloadFingerprint: fingerprint, receipt } }
  }

  async #readSourceState(): Promise<SourceState> {
    const teamDir = join(this.options.claudeRoot, 'teams', this.options.legacyKey); const tasksDir = join(this.options.claudeRoot, 'tasks', this.options.legacyKey)
    const [teamStat, tasksStat] = await Promise.all([safeDirectoryStat(teamDir), safeDirectoryStat(tasksDir)])
    const a = this.options.authority
    // Product issues expectedSourceGeneration; restore generation and root hash stay fenced by sameAuthority.
    const sourceGeneration = hostedTaskBoardSourceGeneration({ deploymentId: a.deploymentId, bootId: a.bootId, workspaceId: a.workspaceId, mountGeneration: a.mountBinding.mountGeneration, teamId: a.teamId, teamDirectory: teamStat.identity, tasksDirectory: tasksStat.identity })
    return { sourceGeneration, directories: { team: [teamStat.dev, teamStat.ino], tasks: [tasksStat.dev, tasksStat.ino] } }
  }

  async #readBoardState(source: SourceState): Promise<BoardState> {
    const teamDir = join(this.options.claudeRoot, 'teams', this.options.legacyKey); const tasksDir = join(this.options.claudeRoot, 'tasks', this.options.legacyKey)
    const { sourceGeneration } = source
    const a = this.options.authority
    const tasks = new Map<string, BoardState['tasks'] extends Map<string, infer T> ? T : never>()
    const allTaskTexts = new Map<string, string>()
    const taskMembership = (await readdir(tasksDir)).filter(name => name.endsWith('.json')).sort()
    if (taskMembership.length > 512) throw new Error('Hosted board exceeds 512 task files')
    let aggregateTaskBytes = 0
    const candidates: Array<{ rawId: string; path: string; text: string; value: Record<string, unknown> }> = []
    for (const name of taskMembership) {
      const text = await optionalText(join(tasksDir, name)); if (text === null) throw new Error('Task membership changed during snapshot')
      const bytes = Buffer.byteLength(text); if (bytes > 256 * 1024 || (aggregateTaskBytes += bytes) > 8 * 1024 * 1024) throw new Error('Hosted task snapshot exceeds size limit')
      allTaskTexts.set(name, text)
      const value = parseTaskCandidate(text, name)
      if (value) candidates.push({ rawId: value.id as string, path: join(tasksDir, name), text, value })
    }
    let validCandidates = candidates
    while (true) {
      const candidateIds = new Set(validCandidates.map(task => task.rawId))
      const next = validCandidates.filter(task => hasValidRelationships(task.value, candidateIds))
      if (next.length === validCandidates.length) break
      validCandidates = next
    }
    for (const task of validCandidates) {
      const { rawId } = task; const publicId = hostedTaskBoardTaskId(a.teamId, rawId)
      if (tasks.has(publicId)) throw new Error('Duplicate hosted task identity')
      tasks.set(publicId, { rawId, publicId, path: task.path, text: task.text, value: task.value })
    }
    const kanbanPath = join(teamDir, 'kanban-state.json'); const ledgerPath = join(teamDir, 'hosted-task-board-mutation-ledger.v2.json')
    const kanbanText = await optionalText(kanbanPath); const ledgerText = await optionalText(ledgerPath)
    if ((kanbanText && Buffer.byteLength(kanbanText) > 512 * 1024) || (ledgerText && Buffer.byteLength(ledgerText) > 512 * 1024)) throw new Error('Hosted board metadata exceeds size limit')
    const kanban = parseKanban(kanbanText, this.options.legacyKey); const ledger = parseLedger(ledgerText, a.teamId)
    const roster = await this.#rosterSnapshot(); const rosterGuard = snapshotGuard(roster, allTaskTexts)
    const [finalTeamStat, finalTasksStat] = await Promise.all([safeDirectoryStat(teamDir), safeDirectoryStat(tasksDir)])
    if (JSON.stringify([[finalTeamStat.dev, finalTeamStat.ino], [finalTasksStat.dev, finalTasksStat.ino]]) !== JSON.stringify([source.directories.team, source.directories.tasks]) || JSON.stringify(taskMembership) !== JSON.stringify((await readdir(tasksDir)).filter(name => name.endsWith('.json')).sort())) throw new Error('Hosted board substituted during snapshot')
    return { sourceGeneration, revision: '', directories: source.directories, taskMembership, rosterGuard, roster, allTaskTexts, tasks, kanbanPath, kanbanText, kanban, ledgerPath, ledgerText, ledger }
  }

  async #revision(sourceGeneration: string, tasks: Map<string, string>, kanbanText: string | null, roster: Array<[string, string | null]>): Promise<string> {
    return hostedTaskBoardRevision({ sourceGeneration, taskTexts: tasks, kanbanText, rosterHashes: roster })
  }

  async #activeMembers(): Promise<Map<string, string>> {
    const teamDir = join(this.options.claudeRoot, 'teams', this.options.legacyKey); const meta = await optionalText(join(teamDir, 'members.meta.json'), MAX_ROSTER_FILE_BYTES); const config = await optionalText(join(teamDir, 'config.json'), MAX_ROSTER_FILE_BYTES)
    const parsed = parseRoster(meta, config); const result = new Map<string, string>(); const identities = new Set<string>(); const activeNames = new Set<string>()
    for (const member of parsed) {
      const name = member.name as string
      // The lead owns tasks like any member, as on desktop. Product's hosted task board roster
      // derives the same IDs from the same records; keep both rules identical.
      if (name.toLowerCase() === 'user') continue
      const immutableIdentity = typeof member.joinedAt === 'number' ? `${name}\0${member.joinedAt}` : typeof member.agentId === 'string' ? member.agentId : name
      const id = typeof member.memberId === 'string' ? member.memberId : `member_${sha(JSON.stringify({ domain: 'hosted-task-board-member/v1', teamId: this.options.authority.teamId, rawMemberName: immutableIdentity })).slice(0, 32)}`
      const identityKey = typeof member.memberId === 'string' ? `member:${id}` : `identity:${immutableIdentity}`
      const nameKey = name.toLowerCase()
      if (identities.has(identityKey) || (member.removedAt === undefined && activeNames.has(nameKey))) throw new Error('Ambiguous hosted roster identity')
      identities.add(identityKey)
      if (member.removedAt === undefined) {
        activeNames.add(nameKey)
        if (result.has(id)) throw new Error('Ambiguous hosted roster member id')
        // The task document owner is the immutable hosted identity. A display-name
        // postimage would let a same-name replacement inherit the prior owner's work.
        result.set(id, id)
      }
    }
    return result
  }

  async #rosterSnapshot(): Promise<Array<[string, string | null]>> { const teamDir = join(this.options.claudeRoot, 'teams', this.options.legacyKey); return Promise.all(['config.json', 'members.meta.json'].sort().map(async name => { const text = await optionalText(join(teamDir, name), MAX_ROSTER_FILE_BYTES); return [name, text === null ? null : sha(text)] as [string, string | null] })) }

  async #intentSnapshotGuard(intent: HostedMutationIntent): Promise<string> {
    const taskTexts = new Map<string, string>()
    for (const name of intent.taskMembership) {
      const write = intent.writes.find(candidate => candidate.target === `task:${name}`)
      const current = await this.#readTarget(`task:${name}`)
      if (!current.existed || current.sha256 === null) throw new Error('Hosted task guard membership changed')
      const guardedHash = write && sameImage(current, write.after) ? write.before.sha256 : current.sha256
      if (guardedHash === null) throw new Error('Hosted task guard preimage missing')
      taskTexts.set(name, guardedHash)
    }
    return snapshotGuardFromHashes(await this.#rosterSnapshot(), taskTexts)
  }

  async #validateIntentGuards(intent: HostedMutationIntent): Promise<boolean> {
    if (!(await this.#validateRecoveryScope(intent))) return false
    const teamDir = join(this.options.claudeRoot, 'teams', this.options.legacyKey); const tasksDir = join(this.options.claudeRoot, 'tasks', this.options.legacyKey)
    const expectedMembership = new Set(intent.taskMembership)
    for (const write of intent.writes.filter(item => item.target.startsWith('task:'))) {
      const current = await this.#readTarget(write.target); const name = write.target.slice(5)
      if (sameImage(current, write.after) && write.after.existed) expectedMembership.add(name)
      else if (matchesPreimage(current, write.before) && !write.before.existed) expectedMembership.delete(name)
      else if (!matchesPreimage(current, write.before) && !sameImage(current, write.after)) return false
    }
    const membership = (await readdir(tasksDir)).filter(name => name.endsWith('.json')).sort()
    if (JSON.stringify(membership) !== JSON.stringify([...expectedMembership].sort()) || await this.#intentSnapshotGuard(intent) !== intent.rosterGuard) return false
    for (const write of intent.writes) { const current = await this.#readTarget(write.target); if (!matchesPreimage(current, write.before) && !sameImage(current, write.after)) return false }
    return true
  }

  async #validateRecoveryScope(intent: HostedMutationIntent): Promise<boolean> {
    if (!(await this.#validateOwner()) || !(await this.options.wal.ownsActiveFence()) || !(await this.options.wal.matchesIntent(intent)) || !sameRecoveryAuthority(intent.authority, this.options.authority)) return false
    const teamDir = join(this.options.claudeRoot, 'teams', this.options.legacyKey); const tasksDir = join(this.options.claudeRoot, 'tasks', this.options.legacyKey)
    const canonical = await Promise.all([realpath(this.options.claudeRoot), realpath(teamDir), realpath(tasksDir)])
    if (JSON.stringify(canonical) !== JSON.stringify([intent.canonicalScope.claudeRoot, intent.canonicalScope.teamDirectory, intent.canonicalScope.tasksDirectory])) return false
    const [team, tasks] = await Promise.all([safeDirectoryStat(teamDir), safeDirectoryStat(tasksDir)])
    return JSON.stringify([[team.dev, team.ino], [tasks.dev, tasks.ino]]) === JSON.stringify([intent.directories.team, intent.directories.tasks])
  }

  async #applyWrites(intent: HostedMutationIntent): Promise<void> {
    for (const write of intent.writes) {
      if (!(await this.#validateIntentGuards(intent))) throw new Error('Hosted board guard changed')
      const current = await this.#readTarget(write.target)
      if (sameImage(current, write.after)) { await this.#finishPublishedTarget(write.target); continue }
      if (!matchesPreimage(current, write.before)) throw new Error('Hosted target preimage substituted')
      if (write.target === 'kanban') await this.#runCrashHook('before_kanban_write')
      await this.#publishTarget(intent, write)
      if (!(await this.#validateIntentGuards(intent))) throw new Error('Hosted board guard changed after publication')
      if (write.target.startsWith('task:')) await this.#runCrashHook('after_task_write')
    }
  }
  async #runCrashHook(stage: CrashStage): Promise<void> { try { await this.options.crashHook?.(stage) } catch { throw new ControlledHostedMutationCrash(stage) } }
  async #finishPublishedTarget(target: string): Promise<void> { await fsyncFileAndParent(this.#targetPath(target)) }
  #targetPath(target: string): string {
    if (target === 'kanban') return join(this.options.claudeRoot, 'teams', this.options.legacyKey, 'kanban-state.json')
    if (target === 'ledger') return join(this.options.claudeRoot, 'teams', this.options.legacyKey, 'hosted-task-board-mutation-ledger.v2.json')
    if (target.startsWith('task:') && /^[A-Za-z0-9_-]+\.json$/.test(target.slice(5))) return join(this.options.claudeRoot, 'tasks', this.options.legacyKey, target.slice(5))
    throw new Error('Unsafe hosted mutation target')
  }
  async #readTarget(target: string): Promise<HostedMutationFileImage> { return readPathImage(this.#targetPath(target)) }
  async #publishTarget(intent: HostedMutationIntent, write: HostedMutationWrite): Promise<void> {
    const path = this.#targetPath(write.target); const parent = dirname(path); const suffix = sha(`${intent.walId}\0${write.target}`).slice(0, 24)
    const staged = join(parent, `.hosted-stage-${suffix}`); const detached = join(parent, `.hosted-detach-${suffix}`)
    const text = Buffer.from(write.after.contentBase64!, 'base64').toString('utf8'); if (sha(text) !== write.after.sha256) throw new Error('Hosted WAL image hash mismatch')
    const existingStage = await readPathImage(staged)
    if (existingStage.existed && !sameImage(existingStage, write.after)) throw new Error('Hosted stage path substituted')
    if (!existingStage.existed) { const handle = await open(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600); try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() } }
    if (write.before.existed) {
      if ((await readPathImage(detached)).existed) throw new Error('Hosted detach path already exists')
      await link(path, detached)
      if (!matchesPreimage(await readPathImage(detached), write.before)) throw new Error('Hosted detached preimage mismatch')
      const [currentStat, detachedStat] = await Promise.all([lstat(path), lstat(detached)])
      if (currentStat.dev !== detachedStat.dev || currentStat.ino !== detachedStat.ino) throw new Error('Hosted target changed before detach')
      await unlink(path)
      if (write.target.startsWith('task:')) await this.#runCrashHook('after_task_detach')
    }
    try { await link(staged, path) } catch (error) {
      if (write.before.existed && (error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Hosted target substituted during publication')
      throw error
    }
    await fsyncDirectoryPath(parent)
    if (!sameImage(await this.#readTarget(write.target), write.after)) throw new Error('Hosted target publication mismatch')
    await Promise.all([unlink(staged).catch(() => {}), unlink(detached).catch(() => {})]); await fsyncDirectoryPath(parent)
  }

  async #resumeDetachedPublications(intent: HostedMutationIntent): Promise<boolean> {
    for (const write of intent.writes) {
      const path = this.#targetPath(write.target); const parent = dirname(path); const suffix = sha(`${intent.walId}\0${write.target}`).slice(0, 24)
      const staged = join(parent, `.hosted-stage-${suffix}`); const detached = join(parent, `.hosted-detach-${suffix}`)
      const detachedImage = await readPathImage(detached)
      if (!detachedImage.existed) continue
      if (!matchesPreimage(detachedImage, write.before)) return false
      const current = await this.#readTarget(write.target)
      if (matchesPreimage(current, write.before)) {
        const [currentStat, detachedStat] = await Promise.all([lstat(path), lstat(detached)])
        if (currentStat.dev !== detachedStat.dev || currentStat.ino !== detachedStat.ino) return false
        await unlink(path)
      } else if (current.existed && !sameImage(current, write.after)) return false
      if (!(await this.#readTarget(write.target)).existed) {
        let stagedImage = await readPathImage(staged)
        if (!sameImage(stagedImage, write.after)) {
          if (stagedImage.existed) return false
          const text = Buffer.from(write.after.contentBase64!, 'base64').toString('utf8'); const handle = await open(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
          try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }; stagedImage = await readPathImage(staged)
        }
        if (!sameImage(stagedImage, write.after)) return false
        try { await link(staged, path) } catch { return false }
      } else if (!sameImage(await this.#readTarget(write.target), write.after)) return false
      await fsyncDirectoryPath(parent); await Promise.all([unlink(staged).catch(() => {}), unlink(detached).catch(() => {})]); await fsyncDirectoryPath(parent)
    }
    return true
  }
}

function sha(value: string): string { return createHash('sha256').update(value).digest('hex') }
function snapshotGuard(roster: Array<[string, string | null]>, taskTexts: Map<string, string>): string { return snapshotGuardFromHashes(roster, new Map([...taskTexts].map(([name, text]) => [name, sha(text)]))) }
function snapshotGuardFromHashes(roster: Array<[string, string | null]>, taskHashes: Map<string, string>): string { return sha(JSON.stringify({ roster, taskFiles: [...taskHashes].sort(([a], [b]) => a.localeCompare(b)) })) }
function image(text: string, stat?: HostedMutationFileImage['stat']): HostedMutationFileImage { return { existed: true, sha256: sha(text), contentBase64: Buffer.from(text).toString('base64'), ...(stat ? { stat } : {}) } }
function missingImage(): HostedMutationFileImage { return { existed: false, sha256: null, contentBase64: null } }
function sameImage(a: HostedMutationFileImage, b: HostedMutationFileImage): boolean { return a.existed === b.existed && a.sha256 === b.sha256 }
function matchesPreimage(current: HostedMutationFileImage, before: HostedMutationFileImage): boolean { return sameImage(current, before) && (!before.stat || JSON.stringify(current.stat) === JSON.stringify(before.stat)) }
async function optionalText(path: string, maximumBytes?: number): Promise<string | null> { const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }); if (!handle) return null; try { const stat = await handle.stat(); if (!stat.isFile() || (maximumBytes !== undefined && stat.size > maximumBytes)) throw new Error('Unsafe hosted file'); const text = await handle.readFile('utf8'); if (maximumBytes !== undefined && Buffer.byteLength(text) > maximumBytes) throw new Error('Hosted file exceeds size limit'); return text } finally { await handle.close() } }
async function readPathImage(path: string): Promise<HostedMutationFileImage> { const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }); if (!handle) return missingImage(); try { const stat = await handle.stat(); if (!stat.isFile()) throw new Error('Unsafe hosted staged target'); const text = await handle.readFile('utf8'); return image(text, { device: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs }) } finally { await handle.close() } }
async function safeDirectoryStat(path: string): Promise<{ dev: number; ino: number; identity: [string, string] }> { const stat = await lstat(path, { bigint: true }); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe hosted board directory'); return { dev: Number(stat.dev), ino: Number(stat.ino), identity: [stat.dev.toString(), stat.ino.toString()] } }
function taskSelfWriteEffects(writes: HostedMutationWrite[]): HostedTaskSelfWriteEffect[] {
  return writes.flatMap(write => write.target.startsWith('task:') && write.after.existed && write.after.sha256
    ? [{ fileKey: write.target.slice('task:'.length, -'.json'.length), expectedChecksum: write.after.sha256 }] : [])
}
function sameAuthority(a: HostedControlAuthority, b: HostedControlStableAuthority): boolean {
  const { actorId: _, ...stable } = a
  const { actorId: _ignored, ...stableExpected } = b as HostedControlAuthority
  return JSON.stringify(stable) === JSON.stringify(stableExpected)
}
function sameRecoveryAuthority(a: HostedControlAuthority, b: HostedControlStableAuthority): boolean {
  return a.deploymentId === b.deploymentId && a.workspaceId === b.workspaceId && a.restoreGeneration === b.restoreGeneration && a.teamId === b.teamId && a.mountBinding.mountGeneration === b.mountBinding.mountGeneration && a.mountBinding.declaredRootHash === b.mountBinding.declaredRootHash
}
function stateConflict(state: BoardState): HostedTaskMutationTerminalResult { return { kind: 'conflict', reason: 'state_conflict', currentSourceGeneration: state.sourceGeneration, currentRevision: state.revision } }
function ledgerKey(command: HostedTaskMutationCommand): string { return sha(JSON.stringify({ domain: 'hosted-task-board-idempotency-ledger/v3', teamId: command.teamId, sourceGeneration: command.expectedSourceGeneration, idempotencyKey: command.idempotencyKey })) }
function parseLedger(text: string | null, teamId: string): MutationLedger {
  if (!text) return { schemaVersion: 2, entries: {} }
  const value = parseRecord(text, 'hosted mutation ledger')
  if (!hasExactKeys(value, ['schemaVersion', 'entries']) || value.schemaVersion !== 2 || !isRecord(value.entries)) throw new Error('Invalid hosted mutation ledger')
  const entries: Record<string, LedgerEntry> = {}
  for (const [key, raw] of Object.entries(value.entries)) {
    if (!/^[0-9a-f]{64}$/.test(key) || !isRecord(raw) || !hasExactKeys(raw, ['fingerprint', 'commandId', 'sourceGeneration', 'expectedRevision', 'receipt', 'committedAtMs'])) throw new Error('Invalid hosted mutation ledger entry')
    if (typeof raw.fingerprint !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw.fingerprint) || typeof raw.commandId !== 'string' || !/^command_[A-Za-z0-9][A-Za-z0-9._-]{0,118}$/.test(raw.commandId) || typeof raw.sourceGeneration !== 'string' || !/^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/.test(raw.sourceGeneration) || typeof raw.expectedRevision !== 'string' || !/^revision_[A-Za-z0-9][A-Za-z0-9._-]{0,246}$/.test(raw.expectedRevision) || !Number.isSafeInteger(raw.committedAtMs) || (raw.committedAtMs as number) < 0 || !isReceipt(raw.receipt)) throw new Error('Invalid hosted mutation ledger entry')
    const receipt = raw.receipt
    if (receipt.commandId !== raw.commandId || receipt.sourceGeneration !== raw.sourceGeneration || receipt.teamId !== teamId) throw new Error('Invalid hosted mutation ledger binding')
    entries[key] = { fingerprint: raw.fingerprint, commandId: raw.commandId, sourceGeneration: raw.sourceGeneration, expectedRevision: raw.expectedRevision, receipt, committedAtMs: raw.committedAtMs } as LedgerEntry
  }
  return { schemaVersion: 2, entries }
}
function compactLedger(ledger: MutationLedger, sourceGeneration: string): MutationLedger {
  const retained = Object.entries(ledger.entries)
    .filter(([, entry]) => entry.sourceGeneration === sourceGeneration)
    .sort(([keyA, a], [keyB, b]) => a.committedAtMs - b.committedAtMs || keyA.localeCompare(keyB))
    .slice(-255)
    .sort(([a], [b]) => a.localeCompare(b))
  return { schemaVersion: 2, entries: Object.fromEntries(retained) }
}
function serializeLedgerBounded(ledger: MutationLedger, currentKey: string): string {
  const entries = new Map(Object.entries(ledger.entries))
  while (true) {
    const ordered = [...entries.entries()].sort(([a], [b]) => a.localeCompare(b)); const text = JSON.stringify({ schemaVersion: 2, entries: Object.fromEntries(ordered) }, null, 2)
    if (Buffer.byteLength(text) <= 512 * 1024) return text
    const removable = [...entries.entries()].filter(([key]) => key !== currentKey).sort(([keyA, a], [keyB, b]) => a.committedAtMs - b.committedAtMs || keyA.localeCompare(keyB))[0]
    if (!removable) throw new Error('Hosted mutation ledger entry exceeds 512KiB')
    entries.delete(removable[0])
  }
}
function taskText(value: Record<string, unknown>): string { return `${JSON.stringify(value, null, 2)}\n` }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function parseRecord(text: string, label: string): Record<string, unknown> { const value = JSON.parse(text) as unknown; if (!isRecord(value)) throw new Error(`Invalid ${label}`); return value }
function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]) }
function isReceipt(value: unknown): value is HostedTaskMutationReceipt {
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'outcome', 'commandId', 'teamId', 'sourceGeneration', 'revision', 'affectedTaskIds'])) return false
  return value.schemaVersion === 1 && value.outcome === 'committed' && typeof value.commandId === 'string' && /^command_[A-Za-z0-9][A-Za-z0-9._-]{0,118}$/.test(value.commandId) && typeof value.teamId === 'string' && /^team_[0-9a-f]{32}$/.test(value.teamId) && typeof value.sourceGeneration === 'string' && /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/.test(value.sourceGeneration) && typeof value.revision === 'string' && /^revision_[A-Za-z0-9][A-Za-z0-9._-]{0,246}$/.test(value.revision) && Array.isArray(value.affectedTaskIds) && new Set(value.affectedTaskIds).size === value.affectedTaskIds.length && value.affectedTaskIds.every(id => typeof id === 'string' && /^task_[0-9a-f]{32}$/.test(id))
}
function parseTaskCandidate(text: string, name: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9_-]+\.json$/.test(name)) return null
  const value = parseRecord(text, 'hosted task')
  const rawId = name.slice(0, -5)
  if (value.id !== rawId || rawId.startsWith('_internal') || value.status === 'deleted' || value.deletedAt != null || !TASK_STATUSES.includes(value.status as typeof TASK_STATUSES[number])) return null
  if (typeof value.subject !== 'string' || (value.description !== undefined && typeof value.description !== 'string')) return null
  return value
}
function hasValidRelationships(value: Record<string, unknown>, ids: Set<string>): boolean {
  if (!Array.isArray(value.blocks) || !Array.isArray(value.blockedBy)) return false
  const self = value.id as string
  for (const relation of [value.blocks, value.blockedBy]) {
    if (!relation.every(id => typeof id === 'string' && id !== self && ids.has(id)) || new Set(relation).size !== relation.length) return false
  }
  return true
}
function parseKanban(text: string | null, teamName: string): Record<string, unknown> {
  if (text === null) return { teamName, reviewers: [], tasks: {}, columnOrder: {} }
  const value = parseRecord(text, 'hosted kanban')
  if (value.tasks !== undefined && !isRecord(value.tasks)) throw new Error('Invalid hosted kanban tasks')
  if (value.reviewers !== undefined && (!Array.isArray(value.reviewers) || !value.reviewers.every(item => typeof item === 'string'))) throw new Error('Invalid hosted kanban reviewers')
  if (value.columnOrder !== undefined && !isRecord(value.columnOrder)) throw new Error('Invalid hosted kanban column order')
  const seen = new Set<string>()
  for (const column of COLUMNS) {
    const ids = (value.columnOrder as Record<string, unknown> | undefined)?.[column]
    if (ids !== undefined && (!Array.isArray(ids) || !ids.every(id => typeof id === 'string') || ids.some(id => seen.has(id)))) throw new Error('Invalid hosted kanban column order')
    for (const id of (ids as string[] | undefined) ?? []) seen.add(id)
  }
  for (const entry of Object.values((value.tasks as Record<string, unknown> | undefined) ?? {})) {
    if (!isRecord(entry) || !COLUMNS.includes(entry.column as Column)) throw new Error('Invalid hosted kanban task placement')
  }
  return value
}
function cloneKanban(input: Record<string, unknown>): Record<string, unknown> {
  return { ...input, tasks: { ...((input.tasks as Record<string, unknown> | undefined) ?? {}) }, columnOrder: Object.fromEntries(Object.entries((input.columnOrder as Record<string, unknown> | undefined) ?? {}).map(([column, ids]) => [column, Array.isArray(ids) ? [...ids] : ids])) }
}
function currentColumn(kanban: Record<string, unknown>, rawId: string, status: unknown): Column { const entry = (kanban.tasks as Record<string, unknown>)[rawId] as Record<string, unknown> | undefined; if (COLUMNS.includes(entry?.column as Column)) return entry!.column as Column; return status === 'in_progress' ? 'in_progress' : status === 'completed' ? 'done' : 'todo' }
function columnOrder(kanban: Record<string, unknown>, column: string): string[] { const value = (kanban.columnOrder as Record<string, unknown>)[column]; return Array.isArray(value) ? value as string[] : [] }
function actualColumnOrder(kanban: Record<string, unknown>, column: Column, tasks: BoardState['tasks']): string[] {
  const explicit = columnOrder(kanban, column).filter(id => [...tasks.values()].some(task => task.rawId === id && currentColumn(kanban, id, task.value.status) === column))
  const placed = new Set(explicit)
  for (const task of tasks.values()) if (!placed.has(task.rawId) && currentColumn(kanban, task.rawId, task.value.status) === column) { explicit.push(task.rawId); placed.add(task.rawId) }
  return explicit
}
function setColumnOrder(kanban: Record<string, unknown>, column: string, ids: string[]): void { (kanban.columnOrder as Record<string, unknown>)[column] = ids }
function placeTask(kanban: Record<string, unknown>, rawId: string, column: Column, order: number, now: string, taskSnapshot: BoardState['tasks']): void {
  const materialized = Object.fromEntries(COLUMNS.map(col => [col, actualColumnOrder(kanban, col, taskSnapshot).filter(id => id !== rawId)])) as Record<Column, string[]>
  const target = materialized[column]
  target.splice(Math.min(order, target.length), 0, rawId)
  for (const col of COLUMNS) setColumnOrder(kanban, col, materialized[col])
  const tasks = kanban.tasks as Record<string, unknown>; const previous = tasks[rawId] && typeof tasks[rawId] === 'object' ? tasks[rawId] as Record<string, unknown> : {}
  if (column === 'review' || column === 'approved') tasks[rawId] = { ...previous, column, movedAt: now }
  else { const next: Record<string, unknown> = { ...previous, column }; delete next.movedAt; tasks[rawId] = next }
}
function parseRoster(metaText: string | null, configText: string | null): Record<string, unknown>[] {
  const meta = metaText === null ? null : parseRecord(metaText, 'members metadata')
  if (meta && meta.version !== 1) throw new Error('Invalid members metadata version')
  if (meta) return parseRosterMembers(meta)
  return configText === null ? [] : parseRosterMembers(parseRecord(configText, 'team config'))
}
function parseRosterMembers(source: Record<string, unknown>): Record<string, unknown>[] {
  if (source.members !== undefined && !Array.isArray(source.members)) throw new Error('Invalid hosted roster')
  const members = (source.members as unknown[] | undefined) ?? []
  if (members.length > MAX_ROSTER_MEMBERS) throw new Error('Hosted roster exceeds member budget')
  return members.map(raw => {
    if (!isRecord(raw) || typeof raw.name !== 'string' || raw.name.length === 0 || raw.name.trim() !== raw.name || (raw.removedAt !== undefined && (typeof raw.removedAt !== 'number' || !Number.isFinite(raw.removedAt))) || (raw.joinedAt !== undefined && (!Number.isSafeInteger(raw.joinedAt) || (raw.joinedAt as number) < 0)) || (raw.agentId !== undefined && (typeof raw.agentId !== 'string' || raw.agentId.length === 0 || raw.agentId.length > 256 || raw.agentId.trim() !== raw.agentId)) || (raw.memberId !== undefined && (typeof raw.memberId !== 'string' || !/^member_[0-9a-f]{32}$/.test(raw.memberId)))) throw new Error('Invalid hosted roster member')
    return raw
  })
}
