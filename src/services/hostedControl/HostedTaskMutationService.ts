import { createHash } from 'node:crypto'
import { closeSync, constants as syncConstants, fstatSync, fsyncSync, readFileSync, writeSync } from 'node:fs'
import { constants, lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { TaskMutationLockUnavailableError, withTaskMutationCoordination } from '../../utils/taskMutationCoordinator.js'
import { fingerprintHostedTaskCommand } from './protocol.js'
import type { HostedControlAuthority, HostedControlStableAuthority, HostedTaskMutationCommand, HostedTaskMutationCommittedResult, HostedTaskMutationReceipt, HostedTaskMutationRequest, HostedTaskMutationTerminalResult } from './protocol.js'
import { HOSTED_MUTATION_RETRY_AFTER_MS, HostedTaskMutationWal, type HostedMutationFileImage, type HostedMutationIntent, type HostedMutationWrite } from './HostedTaskMutationWal.js'
import { PinnedPosixDirectory } from './PinnedPosixDirectory.internal.js'

type BoardState = { sourceGeneration: string; revision: string; directories: { team: [number, number]; tasks: [number, number] }; taskMembership: string[]; rosterGuard: string; roster: Array<[string, string | null]>; allTaskTexts: Map<string, string>; tasks: Map<string, { rawId: string; publicId: string; path: string; text: string; value: Record<string, unknown> }>; kanbanPath: string; kanbanText: string | null; kanban: Record<string, unknown>; ledgerPath: string; ledgerText: string | null; ledger: MutationLedger }
type SourceState = Pick<BoardState, 'sourceGeneration' | 'directories'>
type MutationLedger = { schemaVersion: 3; epoch: number; entries: Record<string, LedgerEntry> }
type LedgerEntry = { fingerprint: string; commandId: string; sourceGeneration: string; expectedRevision: string; receipt: HostedTaskMutationReceipt; committedAtMs: number }
type PlanResult = { writes: HostedMutationWrite[]; result: HostedTaskMutationCommittedResult } | { terminal: HostedTaskMutationTerminalResult }
type CrashStage = 'after_task_stage' | 'after_task_detach' | 'after_task_write' | 'before_kanban_write' | 'before_terminal'
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

  async recover(): Promise<boolean> {
    try { return await withTaskMutationCoordination(this.options.legacyKey, async () => {
      if (!(await this.#validateOwner())) return false
      try { const recovered = await this.options.wal.withFence(() => this.#recoverPrepared()); return recovered ?? false } catch { return false }
    }, { claudeRoot: this.options.claudeRoot }) } catch { return false }
  }

  async mutate(request: HostedTaskMutationRequest): Promise<HostedTaskMutationTerminalResult> {
    if (!sameAuthority(request.authority, this.options.authority)) return { kind: 'unavailable' }
    try { return await withTaskMutationCoordination(this.options.legacyKey, async () => {
      if (!(await this.#validateOwner())) return { kind: 'unsafe_active' }
      let fenced: HostedTaskMutationTerminalResult | undefined
      try { fenced = await this.options.wal.withFence(() => this.#mutateFenced(request)) } catch { return { kind: 'unsafe_active' }
      }
      return fenced ?? { kind: 'unavailable', retryAfterMs: HOSTED_MUTATION_RETRY_AFTER_MS }
    }, { claudeRoot: this.options.claudeRoot }) } catch (error) { return error instanceof TaskMutationLockUnavailableError ? { kind: 'unavailable', retryAfterMs: HOSTED_MUTATION_RETRY_AFTER_MS } : { kind: 'unsafe_active' } }
  }

  async #recoverPrepared(): Promise<boolean> {
    for (const intent of await this.options.wal.listAmbiguous()) if (!(await this.#recoverIntent(intent))) return false
    return true
  }

  async #mutateFenced(request: HostedTaskMutationRequest): Promise<HostedTaskMutationTerminalResult> {
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
      state.revision = await this.#revision(
        state.sourceGeneration,
        state.allTaskTexts,
        state.kanbanText,
        state.roster,
        state.ledger.epoch,
      )
      if (command.expectedRevision !== state.revision) return { kind: 'stale_revision', currentSourceGeneration: state.sourceGeneration, currentRevision: state.revision }

      const planned = await this.#plan(state, command, request.payload.payloadFingerprint)
      if ('terminal' in planned) return planned.terminal
      const intent = await this.options.wal.appendIntent({ scope, commandId: command.commandId, payloadFingerprint: request.payload.payloadFingerprint, expectedRevision: command.expectedRevision, committedResult: planned.result, writes: planned.writes, directories: state.directories, taskMembership: state.taskMembership, rosterGuard: state.rosterGuard, authority: request.authority, command, canonicalScope: { claudeRoot: await realpath(this.options.claudeRoot), teamDirectory: await realpath(join(this.options.claudeRoot, 'teams', this.options.legacyKey)), tasksDirectory: await realpath(join(this.options.claudeRoot, 'tasks', this.options.legacyKey)) } })
      try {
        await this.#applyWrites(intent)
        await this.#runCrashHook('before_terminal')
        if (!(await this.#validateIntentGuards(intent))) throw new Error('Hosted board guard changed before terminal receipt')
        await this.options.wal.appendTerminal(intent.walId, planned.result)
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
      if (sameImage(current, write.after)) { await this.#finishPublishedTarget(intent, write.target); continue }
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
        const publicId = publicTaskId(command.teamId, rawId)
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
    const ledger = compactLedger(state.ledger, state.sourceGeneration)
    if (ledger.epoch >= Number.MAX_SAFE_INTEGER) throw new Error('Hosted mutation ledger epoch exhausted')
    ledger.epoch += 1
    const revision = await this.#revision(
      state.sourceGeneration,
      taskTexts,
      kanbanAfter,
      state.roster,
      ledger.epoch,
    )
    const receipt: HostedTaskMutationReceipt = { schemaVersion: 1, outcome: 'committed', commandId: command.commandId, teamId: command.teamId, sourceGeneration: state.sourceGeneration, revision, affectedTaskIds: [...new Set(affected)].sort() }
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
    const sourceGeneration = `generation_${sha(JSON.stringify({ domain: 'hosted-task-board-source/v3', deploymentId: a.deploymentId, bootId: a.bootId, restoreGeneration: a.restoreGeneration, workspaceId: a.workspaceId, mountGeneration: a.mountBinding.mountGeneration, declaredRootHash: a.mountBinding.declaredRootHash, teamId: a.teamId, teamDirectory: [String(teamStat.dev), String(teamStat.ino)], tasksDirectory: [String(tasksStat.dev), String(tasksStat.ino)] }))}`
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
      const { rawId } = task; const publicId = publicTaskId(a.teamId, rawId)
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

  async #revision(
    sourceGeneration: string,
    tasks: Map<string, string>,
    kanbanText: string | null,
    roster: Array<[string, string | null]>,
    ledgerEpoch: number,
  ): Promise<string> {
    const taskFiles = [...tasks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, text]) => [name, sha(text)])
    return `revision_${sha(JSON.stringify({ domain: 'hosted-task-board-revision/v4', sourceGeneration, taskFiles, kanban: kanbanText === null ? null : sha(kanbanText), roster, ledgerEpoch }))}`
  }

  async #activeMembers(): Promise<Map<string, string>> {
    const teamDir = join(this.options.claudeRoot, 'teams', this.options.legacyKey); const meta = await optionalText(join(teamDir, 'members.meta.json'), MAX_ROSTER_FILE_BYTES); const config = await optionalText(join(teamDir, 'config.json'), MAX_ROSTER_FILE_BYTES)
    const parsed = parseRoster(meta, config); const result = new Map<string, string>(); const identities = new Set<string>(); const activeNames = new Set<string>()
    for (const member of parsed) {
      const name = member.name as string
      if (['team-lead', 'user'].includes(name.toLowerCase()) || ['lead', 'orchestrator', 'team-lead'].includes(String(member.agentType ?? ''))) continue
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
      if (sameImage(current, write.after)) { await this.#finishPublishedTarget(intent, write.target); continue }
      if (!matchesPreimage(current, write.before)) throw new Error('Hosted target preimage substituted')
      if (write.target === 'kanban') await this.#runCrashHook('before_kanban_write')
      await this.#publishTarget(intent, write)
      if (!(await this.#validateIntentGuards(intent))) throw new Error('Hosted board guard changed after publication')
      if (write.target.startsWith('task:')) await this.#runCrashHook('after_task_write')
    }
  }
  async #runCrashHook(stage: CrashStage): Promise<void> { try { await this.options.crashHook?.(stage) } catch { throw new ControlledHostedMutationCrash(stage) } }
  async #finishPublishedTarget(intent: HostedMutationIntent, target: string): Promise<void> {
    const { directory, name } = await this.#openPinnedTarget(intent, target)
    let fd = -1
    try {
      directory.assertLinked()
      fd = directory.openChild(name, syncConstants.O_RDONLY)
      fsyncSync(fd)
      await directory.sync()
      directory.assertLinked()
    } finally { if (fd >= 0) closeSync(fd); await directory.close() }
  }
  #targetPath(target: string): string {
    if (target === 'kanban') return join(this.options.claudeRoot, 'teams', this.options.legacyKey, 'kanban-state.json')
    if (target === 'ledger') return join(this.options.claudeRoot, 'teams', this.options.legacyKey, 'hosted-task-board-mutation-ledger.v2.json')
    if (target.startsWith('task:') && /^[A-Za-z0-9_-]+\.json$/.test(target.slice(5))) return join(this.options.claudeRoot, 'tasks', this.options.legacyKey, target.slice(5))
    throw new Error('Unsafe hosted mutation target')
  }
  async #readTarget(target: string): Promise<HostedMutationFileImage> { return readPathImage(this.#targetPath(target)) }
  async #publishTarget(intent: HostedMutationIntent, write: HostedMutationWrite): Promise<void> {
    const { directory, name: targetName } = await this.#openPinnedTarget(intent, write.target)
    const suffix = sha(`${intent.walId}\0${write.target}`).slice(0, 24)
    const staged = `.hosted-stage-${suffix}`; const detached = `.hosted-detach-${suffix}`
    const text = Buffer.from(write.after.contentBase64!, 'base64').toString('utf8'); if (sha(text) !== write.after.sha256) throw new Error('Hosted WAL image hash mismatch')
    try {
      directory.assertLinked()
      const existingStage = readPinnedImage(directory, staged)
      if (existingStage.existed && !sameImage(existingStage, write.after)) throw new Error('Hosted stage path substituted')
      if (!existingStage.existed) writePinnedImage(directory, staged, Buffer.from(text))
      // The deterministic stage is a recovery anchor. Publish its directory
      // entry before any preimage can be unlinked, otherwise a power loss may
      // retain neither the target nor a discoverable postimage.
      await directory.sync(); directory.assertLinked()
      if (write.target.startsWith('task:')) await this.#runCrashHook('after_task_stage')
      if (write.before.existed) {
        if (readPinnedImage(directory, detached).existed) throw new Error('Hosted detach path already exists')
        directory.link(targetName, detached)
        if (!matchesPreimage(readPinnedImage(directory, detached), write.before)) throw new Error('Hosted detached preimage mismatch')
        const current = readPinnedImage(directory, targetName); const detachedImage = readPinnedImage(directory, detached)
        if (current.stat?.device !== detachedImage.stat?.device || current.stat?.inode !== detachedImage.stat?.inode) throw new Error('Hosted target changed before detach')
        // Make the hard-link recovery anchor durable before destructive unlink.
        await directory.sync(); directory.assertLinked()
        directory.unlink(targetName)
        if (write.target.startsWith('task:')) await this.#runCrashHook('after_task_detach')
      }
      directory.link(staged, targetName)
      await directory.sync(); directory.assertLinked()
      if (!sameImage(readPinnedImage(directory, targetName), write.after)) throw new Error('Hosted target publication mismatch')
      directory.unlinkIfExists(staged); directory.unlinkIfExists(detached); await directory.sync(); directory.assertLinked()
    } finally { await directory.close() }
  }

  async #resumeDetachedPublications(intent: HostedMutationIntent): Promise<boolean> {
    for (const write of intent.writes) {
      const { directory, name: targetName } = await this.#openPinnedTarget(intent, write.target)
      const suffix = sha(`${intent.walId}\0${write.target}`).slice(0, 24)
      const staged = `.hosted-stage-${suffix}`; const detached = `.hosted-detach-${suffix}`
      try {
        directory.assertLinked()
        const detachedImage = readPinnedImage(directory, detached)
        if (!detachedImage.existed) {
          const stagedImage = readPinnedImage(directory, staged)
          if (!stagedImage.existed) continue
          const current = readPinnedImage(directory, targetName)
          // A crash may leave the deterministic stage after its file fsync but
          // before the detached anchor. Trust neither its pathname nor inode:
          // only an exact WAL postimage beside the exact target preimage is
          // repairable, and recreate it under the active writer fence.
          if (!sameImage(stagedImage, write.after) || !matchesPreimage(current, write.before)) return false
          directory.unlink(staged)
          await directory.sync(); directory.assertLinked()
          writePinnedImage(directory, staged, Buffer.from(write.after.contentBase64!, 'base64'))
          await directory.sync(); directory.assertLinked()
          if (!sameImage(readPinnedImage(directory, staged), write.after)) return false
          if (write.before.existed) {
            directory.link(targetName, detached)
            const repairedDetached = readPinnedImage(directory, detached)
            const repairedTarget = readPinnedImage(directory, targetName)
            if (!matchesPreimage(repairedDetached, write.before)
              || repairedTarget.stat?.device !== repairedDetached.stat?.device
              || repairedTarget.stat?.inode !== repairedDetached.stat?.inode) return false
            await directory.sync(); directory.assertLinked()
            directory.unlink(targetName)
          }
          directory.link(staged, targetName)
          await directory.sync(); directory.assertLinked()
          if (!sameImage(readPinnedImage(directory, targetName), write.after)) return false
          directory.unlinkIfExists(staged); directory.unlinkIfExists(detached)
          await directory.sync(); directory.assertLinked()
          continue
        }
        if (!matchesPreimage(detachedImage, write.before)) return false
        const current = readPinnedImage(directory, targetName)
        if (matchesPreimage(current, write.before)) {
          if (current.stat?.device !== detachedImage.stat?.device || current.stat?.inode !== detachedImage.stat?.inode) return false
          directory.unlink(targetName)
        } else if (current.existed && !sameImage(current, write.after)) return false
        if (!readPinnedImage(directory, targetName).existed) {
          let stagedImage = readPinnedImage(directory, staged)
          if (!sameImage(stagedImage, write.after)) {
            if (stagedImage.existed) return false
            writePinnedImage(directory, staged, Buffer.from(write.after.contentBase64!, 'base64'))
            stagedImage = readPinnedImage(directory, staged)
          }
          if (!sameImage(stagedImage, write.after)) return false
          directory.link(staged, targetName)
        } else if (!sameImage(readPinnedImage(directory, targetName), write.after)) return false
        await directory.sync(); directory.assertLinked()
        directory.unlinkIfExists(staged); directory.unlinkIfExists(detached); await directory.sync(); directory.assertLinked()
      } finally { await directory.close() }
    }
    return true
  }

  async #openPinnedTarget(intent: HostedMutationIntent, target: string): Promise<{ directory: PinnedPosixDirectory; name: string }> {
    const task = target.startsWith('task:')
    const path = task
      ? join(this.options.claudeRoot, 'tasks', this.options.legacyKey)
      : join(this.options.claudeRoot, 'teams', this.options.legacyKey)
    const name = task ? target.slice(5) : target === 'kanban' ? 'kanban-state.json' : 'hosted-task-board-mutation-ledger.v2.json'
    const directory = await PinnedPosixDirectory.open(path)
    const expected = task ? intent.directories.tasks : intent.directories.team
    if (String(directory.identity.dev) !== String(expected[0]) || String(directory.identity.ino) !== String(expected[1])) {
      await directory.close(); throw new Error('Hosted mutation target directory generation changed')
    }
    return { directory, name }
  }
}

function readPinnedImage(directory: PinnedPosixDirectory, name: string): HostedMutationFileImage {
  if (!directory.exists(name)) return missingImage()
  let fd = -1
  try {
    fd = directory.openChild(name, syncConstants.O_RDONLY)
    const stat = fstatSync(fd)
    if (!stat.isFile() || (stat.mode & 0o022) !== 0 || stat.size > 1024 * 1024) throw new Error('Unsafe hosted pinned target')
    const content = readFileSync(fd)
    return image(content.toString('utf8'), { device: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs })
  } finally { if (fd >= 0) closeSync(fd) }
}

function writePinnedImage(directory: PinnedPosixDirectory, name: string, bytes: Buffer): void {
  const fd = directory.createExclusive(name)
  try {
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, offset)
      if (written <= 0) throw new Error('Hosted pinned target short write')
      offset += written
    }
    fsyncSync(fd)
  } finally { closeSync(fd) }
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
async function safeDirectoryStat(path: string): Promise<{ dev: number; ino: number }> { const stat = await lstat(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe hosted board directory'); return { dev: stat.dev, ino: stat.ino } }
function publicTaskId(teamId: string, rawTaskId: string): string { return `task_${sha(JSON.stringify({ domain: 'hosted-task-board-task/v1', teamId, rawTaskId })).slice(0, 32)}` }
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
  if (!text) return { schemaVersion: 3, epoch: 0, entries: {} }
  const value = parseRecord(text, 'hosted mutation ledger')
  const legacy = value.schemaVersion === 2 && hasExactKeys(value, ['schemaVersion', 'entries'])
  const current = value.schemaVersion === 3 && hasExactKeys(value, ['schemaVersion', 'epoch', 'entries'])
  if ((!legacy && !current) || !isRecord(value.entries) ||
    (current && (!Number.isSafeInteger(value.epoch) || (value.epoch as number) < 0))) {
    throw new Error('Invalid hosted mutation ledger')
  }
  const entries: Record<string, LedgerEntry> = {}
  for (const [key, raw] of Object.entries(value.entries)) {
    if (!/^[0-9a-f]{64}$/.test(key) || !isRecord(raw) || !hasExactKeys(raw, ['fingerprint', 'commandId', 'sourceGeneration', 'expectedRevision', 'receipt', 'committedAtMs'])) throw new Error('Invalid hosted mutation ledger entry')
    if (typeof raw.fingerprint !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw.fingerprint) || typeof raw.commandId !== 'string' || !/^command_[A-Za-z0-9][A-Za-z0-9._-]{0,118}$/.test(raw.commandId) || typeof raw.sourceGeneration !== 'string' || !/^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/.test(raw.sourceGeneration) || typeof raw.expectedRevision !== 'string' || !/^revision_[A-Za-z0-9][A-Za-z0-9._-]{0,246}$/.test(raw.expectedRevision) || !Number.isSafeInteger(raw.committedAtMs) || (raw.committedAtMs as number) < 0 || !isReceipt(raw.receipt)) throw new Error('Invalid hosted mutation ledger entry')
    const receipt = raw.receipt
    if (receipt.commandId !== raw.commandId || receipt.sourceGeneration !== raw.sourceGeneration || receipt.teamId !== teamId) throw new Error('Invalid hosted mutation ledger binding')
    entries[key] = { fingerprint: raw.fingerprint, commandId: raw.commandId, sourceGeneration: raw.sourceGeneration, expectedRevision: raw.expectedRevision, receipt, committedAtMs: raw.committedAtMs } as LedgerEntry
  }
  return { schemaVersion: 3, epoch: current ? value.epoch as number : 0, entries }
}
function compactLedger(ledger: MutationLedger, sourceGeneration: string): MutationLedger {
  const retained = Object.entries(ledger.entries)
    .filter(([, entry]) => entry.sourceGeneration === sourceGeneration)
    .sort(([keyA, a], [keyB, b]) => a.committedAtMs - b.committedAtMs || keyA.localeCompare(keyB))
    .slice(-255)
    .sort(([a], [b]) => a.localeCompare(b))
  return { schemaVersion: 3, epoch: ledger.epoch, entries: Object.fromEntries(retained) }
}
function serializeLedgerBounded(ledger: MutationLedger, currentKey: string): string {
  const entries = new Map(Object.entries(ledger.entries))
  while (true) {
    const ordered = [...entries.entries()].sort(([a], [b]) => a.localeCompare(b)); const text = JSON.stringify({ schemaVersion: 3, epoch: ledger.epoch, entries: Object.fromEntries(ordered) }, null, 2)
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
