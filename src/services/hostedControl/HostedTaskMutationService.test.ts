import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAgentStatuses, getTask, listTasks } from '../../utils/tasks.js'
import { fingerprintHostedTaskCommand, type HostedTaskMutationCommand, type HostedTaskMutationRequest } from './protocol.js'
import { HostedTaskMutationService } from './HostedTaskMutationService.js'
import { HostedTaskMutationWal } from './HostedTaskMutationWal.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

type Authority = HostedTaskMutationRequest['authority']
function requestFor(authority: Authority, command: HostedTaskMutationCommand): HostedTaskMutationRequest {
  return { schemaVersion: 2, exchangeId: `task-request_${'e'.repeat(32)}`, operation: 'task_mutate', ownerBinding: { ownerAuthority: 'owner_authority1', ownerGeneration: 1, ownerSessionId: `owner_session_${'d'.repeat(32)}`, socketIdentity: socketIdentity() }, authority, payload: { command, payloadFingerprint: fingerprintHostedTaskCommand(command) }, ownerProof: '0'.repeat(64) }
}
function socketIdentity() { return { device: '1', inode: '2', uid: 501, gid: 20, mode: 0o600 } }
async function runCommand(service: HostedTaskMutationService, authority: Authority, initial: HostedTaskMutationCommand) {
  let command = initial
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await service.mutate(requestFor(authority, command))
    if (result.kind === 'stale_generation') { command = { ...command, expectedSourceGeneration: result.currentSourceGeneration }; continue }
    if (result.kind === 'stale_revision') { command = { ...command, expectedRevision: result.currentRevision }; continue }
    return { command, result }
  }
  throw new Error('command admission did not converge')
}
function authorityFor(teamId: string, patch: Partial<Authority> = {}): Authority {
  return { actorId: 'actor', deploymentId: 'deployment', bootId: 'boot', restoreGeneration: 1, workspaceId: 'workspace', mountBinding: { mountGeneration: 1, declaredRootHash: 'a'.repeat(64) }, teamId, ...patch }
}
function publicId(teamId: string, rawId: string): string { return `task_${createHash('sha256').update(JSON.stringify({ domain: 'hosted-task-board-task/v1', teamId, rawTaskId: rawId })).digest('hex').slice(0, 32)}` }

describe('HostedTaskMutationService', () => {
  test('production task writer denies assignment before any Owner-local durable write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-service-product-deny-')); roots.push(root)
    const teamRoot = join(root, 'teams', 'legacy')
    const taskRoot = join(root, 'tasks', 'legacy')
    await mkdir(teamRoot, { recursive: true }); await mkdir(taskRoot, { recursive: true })
    const teamId = `team_${'9'.repeat(32)}`
    const authority = authorityFor(teamId)
    const rawId = 'sandbox-task'
    const taskPath = join(taskRoot, `${rawId}.json`)
    const original = JSON.stringify({ id: rawId, subject: 'Sandbox task', status: 'pending',
      owner: `member_${'a'.repeat(32)}`, blocks: [], blockedBy: [] })
    await writeFile(taskPath, original)
    const command: HostedTaskMutationCommand = { schemaVersion: 1, kind: 'update_owner',
      commandId: 'command_assignment_denied', idempotencyKey: 'assignment-denied', teamId,
      expectedSourceGeneration: 'generation_stale', expectedRevision: 'revision_stale',
      taskId: publicId(teamId, rawId), ownerId: `member_${'b'.repeat(32)}` }
    const service = new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy', authority,
      wal: new HostedTaskMutationWal(teamRoot, teamId), denyOwnerLocalWrites: true })
    expect(await service.recover()).toBe(true)
    expect(await service.mutate(requestFor(authority, command))).toEqual({ kind: 'unavailable' })
    expect(await readFile(taskPath, 'utf8')).toBe(original)
  })

  test('reports exactly the task files published by a fresh commit as self-write effects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-service-effects-')); roots.push(root)
    const taskRoot = join(root, 'tasks', 'legacy')
    await mkdir(join(root, 'teams', 'legacy'), { recursive: true }); await mkdir(taskRoot, { recursive: true })
    const teamId = `team_${'a'.repeat(32)}`; const authority = authorityFor(teamId)
    const service = new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy', authority, wal: new HostedTaskMutationWal(join(root, 'teams', 'legacy'), teamId) })
    const converge = async (initial: HostedTaskMutationCommand) => {
      let command = initial
      for (let attempt = 0; attempt < 3; attempt++) {
        const outcome = await service.mutateWithSelfWriteEffects(requestFor(authority, command))
        if (outcome.result.kind === 'stale_generation') { command = { ...command, expectedSourceGeneration: outcome.result.currentSourceGeneration }; continue }
        if (outcome.result.kind === 'stale_revision') { command = { ...command, expectedRevision: outcome.result.currentRevision }; continue }
        return { command, outcome }
      }
      throw new Error('command admission did not converge')
    }
    const effectsOnDisk = async (fileKeys: string[]) => Promise.all(fileKeys.map(async fileKey => ({ fileKey,
      expectedChecksum: createHash('sha256').update(await readFile(join(taskRoot, `${fileKey}.json`))).digest('hex') })))

    const created = await converge({ schemaVersion: 1, kind: 'create_task', commandId: 'command_effects', idempotencyKey: 'idem:effects', teamId, expectedSourceGeneration: 'generation_stale', expectedRevision: 'revision_stale', subject: 'Effects', description: null, status: 'pending', ownerId: null, column: 'todo', order: 0 })
    expect(created.outcome.result.kind).toBe('committed')
    const fileKeys = (await readdir(taskRoot)).filter(name => name.endsWith('.json')).map(name => name.slice(0, -'.json'.length))
    expect(fileKeys).toHaveLength(1)
    expect(created.outcome.selfWriteEffects).toEqual(await effectsOnDisk(fileKeys))

    const replay = await service.mutateWithSelfWriteEffects(requestFor(authority, created.command))
    expect(replay).toEqual({ result: expect.objectContaining({ kind: 'idempotent_replay' }), selfWriteEffects: [] })
    if (created.outcome.result.kind !== 'committed') return
    const updated = await converge({ schemaVersion: 1, kind: 'update_details', commandId: 'command_effects_update', idempotencyKey: 'idem:effects-update', teamId, expectedSourceGeneration: created.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId: created.outcome.result.receipt.affectedTaskIds[0]!, subject: 'Effects updated' })
    expect(updated.outcome.result.kind).toBe('committed')
    expect(updated.outcome.selfWriteEffects).toEqual(await effectsOnDisk(fileKeys))

    const denied = new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy', authority, wal: new HostedTaskMutationWal(join(root, 'teams', 'legacy'), teamId), denyOwnerLocalWrites: true })
    expect(await denied.mutateWithSelfWriteEffects(requestFor(authority, { ...updated.command, commandId: 'command_denied', idempotencyKey: 'idem:denied' }))).toEqual({ result: { kind: 'unavailable' }, selfWriteEffects: [] })
  })

  test('keeps its WAL and fence off the Product task-board transaction files and adopts a legacy Owner WAL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-service-owner-wal-')); roots.push(root)
    const teamRoot = join(root, 'teams', 'legacy')
    await mkdir(teamRoot, { recursive: true, mode: 0o700 }); await mkdir(join(root, 'tasks', 'legacy'), { recursive: true, mode: 0o700 })
    const teamId = `team_${'b'.repeat(32)}`; const authority = authorityFor(teamId)
    let crash = false
    const service = () => new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy', authority, wal: new HostedTaskMutationWal(teamRoot, teamId),
      crashHook: stage => { if (crash && stage === 'after_task_write') { crash = false; throw new Error('cut') } } })
    const created = await runCommand(service(), authority, { schemaVersion: 1, kind: 'create_task', commandId: 'command_owner_wal', idempotencyKey: 'idem:owner-wal', teamId, expectedSourceGeneration: 'generation_stale', expectedRevision: 'revision_stale', subject: 'Owner WAL', description: null, status: 'pending', ownerId: null, column: 'todo', order: 0 })
    expect(created.result.kind).toBe('committed')
    // Product reads hosted-task-board-mutation.wal.v1.json as its own transaction; it must stay Product's.
    expect((await readdir(teamRoot)).sort()).toEqual(['hosted-task-board-mutation-ledger.v2.json', 'hosted-task-board-owner-mutation.wal.v1.json', 'kanban-state.json'])

    // An earlier Owner left a crashed WAL under Product's name: recovery adopts and completes it.
    crash = true
    const next = { ...created.command, commandId: 'command_owner_wal_2', idempotencyKey: 'idem:owner-wal-2', subject: 'Owner WAL recovered', expectedRevision: 'revision_stale' }
    const stale = await service().mutate(requestFor(authority, next)); if (stale.kind !== 'stale_revision') throw new Error('expected stale revision')
    const second = { ...next, expectedRevision: stale.currentRevision }
    expect((await service().mutate(requestFor(authority, second))).kind).toBe('unavailable')
    await rename(join(teamRoot, 'hosted-task-board-owner-mutation.wal.v1.json'), join(teamRoot, 'hosted-task-board-mutation.wal.v1.json'))
    expect(await service().recover()).toBe(true)
    expect((await readdir(teamRoot)).sort()).toEqual(['hosted-task-board-mutation-ledger.v2.json', 'hosted-task-board-owner-mutation.wal.v1.json', 'kanban-state.json'])
    expect((await service().mutate(requestFor(authority, second))).kind).toBe('idempotent_replay')

    // A Product WAL under that name is not the Owner's and is left exactly as it is.
    const productWal = JSON.stringify({ schemaVersion: 3, phase: 'terminal', transactionId: 'transaction_product' })
    await writeFile(join(teamRoot, 'hosted-task-board-mutation.wal.v1.json'), productWal, { mode: 0o600 })
    expect(await service().recover()).toBe(true)
    expect(await readFile(join(teamRoot, 'hosted-task-board-mutation.wal.v1.json'), 'utf8')).toBe(productWal)
  })

  test('never loses an MCP controller task write made under the board-state lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-service-board-lock-')); roots.push(root)
    const teamRoot = join(root, 'teams', 'legacy'); const taskRoot = join(root, 'tasks', 'legacy')
    await mkdir(teamRoot, { recursive: true, mode: 0o700 }); await mkdir(taskRoot, { recursive: true, mode: 0o700 })
    const teamId = `team_${'c'.repeat(32)}`; const authority = authorityFor(teamId)
    let onTaskWritten: (() => Promise<void>) | null = null
    const service = () => new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy', authority, wal: new HostedTaskMutationWal(teamRoot, teamId),
      crashHook: async stage => { if (stage === 'after_task_write' && onTaskWritten) { const pause = onTaskWritten; onTaskWritten = null; await pause() } } })
    const created = await runCommand(service(), authority, { schemaVersion: 1, kind: 'create_task', commandId: 'command_board_lock', idempotencyKey: 'idem:board-lock', teamId, expectedSourceGeneration: 'generation_stale', expectedRevision: 'revision_stale', subject: 'Original', description: null, status: 'pending', ownerId: null, column: 'todo', order: 0 })
    if (created.result.kind !== 'committed') throw new Error('expected committed create')
    const taskFile = join(taskRoot, (await readdir(taskRoot)).find(name => name.endsWith('.json'))!)
    const writer = new URL('./fixtures/agentTeamsController/controllerBoardWriter.cjs', import.meta.url).pathname
    const agent = (pauseMs: number) => {
      const child = spawn(process.execPath, [writer, teamRoot, taskFile, String(pauseMs)], { stdio: ['ignore', 'pipe', 'inherit'] })
      const locked = new Promise<number>(resolve => child.stdout.on('data', chunk => resolve(Number(/locked (\d+)/.exec(String(chunk))?.[1]))))
      const exited = new Promise<number | null>(resolve => child.once('exit', resolve))
      return { locked, exited }
    }

    // The agent read the task under board-state and writes it after a pause. The Owner edit waits
    // for that lock and then sees the agent's write instead of publishing over it.
    const holding = agent(400); await holding.locked
    const edit: HostedTaskMutationCommand = { schemaVersion: 1, kind: 'update_details', commandId: 'command_board_lock_edit', idempotencyKey: 'idem:board-lock-edit', teamId, expectedSourceGeneration: created.command.expectedSourceGeneration, expectedRevision: created.result.receipt.revision, taskId: created.result.receipt.affectedTaskIds[0]!, subject: 'Owner edit' }
    const first = await service().mutate(requestFor(authority, edit))
    expect(await holding.exited).toBe(0)
    expect(first.kind).toBe('stale_revision')
    if (first.kind !== 'stale_revision') return
    expect((await service().mutate(requestFor(authority, { ...edit, expectedRevision: first.currentRevision }))).kind).toBe('committed')
    expect(JSON.parse(await readFile(taskFile, 'utf8'))).toMatchObject({ subject: 'Owner edit', status: 'in_progress' })

    // The controller honours the Owner's lock record the same way: an agent that starts while the
    // Owner is publishing gets the lock only after the Owner has finished.
    const second = { ...edit, commandId: 'command_board_lock_edit_2', idempotencyKey: 'idem:board-lock-edit-2', subject: 'Owner edit 2', expectedRevision: 'revision_stale' }
    const current = await service().mutate(requestFor(authority, second))
    if (current.kind !== 'stale_revision') throw new Error('expected stale revision')
    let waiting: ReturnType<typeof agent> | null = null; let pauseEndedAt = 0
    onTaskWritten = async () => { waiting = agent(0); await new Promise(resolve => setTimeout(resolve, 300)); pauseEndedAt = Date.now() }
    expect((await service().mutate(requestFor(authority, { ...second, expectedRevision: current.currentRevision }))).kind).toBe('committed')
    const lockedAt = await waiting!.locked
    expect(await waiting!.exited).toBe(0)
    expect(lockedAt).toBeGreaterThanOrEqual(pauseEndedAt)
    expect(JSON.parse(await readFile(taskFile, 'utf8'))).toMatchObject({ subject: 'Owner edit 2', status: 'in_progress' })
  })

  test('derives source generation from the board directory authority before revision admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-service-test-')); roots.push(root)
    await mkdir(join(root, 'teams', 'legacy'), { recursive: true }); await mkdir(join(root, 'tasks', 'legacy'), { recursive: true })
    await writeFile(join(root, 'teams', 'legacy', 'hosted-task-board-mutation-ledger.v2.json'), '{corrupt-after-generation')
    const teamId = `team_${'1'.repeat(32)}`
    const authority = { actorId: 'actor', deploymentId: 'deployment', bootId: 'boot', restoreGeneration: 1, workspaceId: 'workspace', mountBinding: { mountGeneration: 1, declaredRootHash: 'a'.repeat(64) }, teamId }
    const command: HostedTaskMutationCommand = { schemaVersion: 1, kind: 'create_task', commandId: 'command_test', idempotencyKey: 'idem:test', teamId, expectedSourceGeneration: 'generation_stale', expectedRevision: 'revision_stale', subject: 'Subject', description: null, status: 'pending', ownerId: null, column: 'todo', order: 0 }
    const request = { schemaVersion: 2, exchangeId: `task-request_${'2'.repeat(32)}`, operation: 'task_mutate', ownerBinding: { ownerAuthority: 'owner_authority1', ownerGeneration: 1, ownerSessionId: `owner_session_${'3'.repeat(32)}`, socketIdentity: socketIdentity() }, authority, payload: { command, payloadFingerprint: fingerprintHostedTaskCommand(command) }, ownerProof: '0'.repeat(64) } as HostedTaskMutationRequest
    const service = new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy', authority, wal: new HostedTaskMutationWal(join(root, 'teams', 'legacy'), teamId) })
    const result = await service.mutate(request)
    expect(result.kind).toBe('stale_generation')
    if (result.kind === 'stale_generation') {
      const [teamStat, tasksStat] = await Promise.all([lstat(join(root, 'teams', 'legacy'), { bigint: true }), lstat(join(root, 'tasks', 'legacy'), { bigint: true })])
      // Byte-identical to Product hostedTaskBoardSourceGeneration, which issues expectedSourceGeneration.
      const expected = `generation_${createHash('sha256').update(JSON.stringify({ domain: 'hosted-task-board-source/v2', deploymentId: authority.deploymentId, bootId: authority.bootId, workspaceId: authority.workspaceId, mountGeneration: authority.mountBinding.mountGeneration, teamId, teamDirectory: [teamStat.dev.toString(), teamStat.ino.toString()], tasksDirectory: [tasksStat.dev.toString(), tasksStat.ino.toString()] })).digest('hex')}`
      expect(result.currentSourceGeneration).toBe(expected)
    }
  })

  test('forward-recovers a crash after task publication and replays the durable receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-service-recovery-')); roots.push(root)
    await mkdir(join(root, 'teams', 'legacy'), { recursive: true }); await mkdir(join(root, 'tasks', 'legacy'), { recursive: true })
    const teamId = `team_${'4'.repeat(32)}`
    const authority = { actorId: 'actor', deploymentId: 'deployment', bootId: 'boot', restoreGeneration: 1, workspaceId: 'workspace', mountBinding: { mountGeneration: 1, declaredRootHash: 'b'.repeat(64) }, teamId }
    const wal = new HostedTaskMutationWal(join(root, 'teams', 'legacy'), teamId)
    let crashed = false
    const makeService = (crashStage?: 'after_task_detach' | 'after_task_write' | 'before_terminal') => new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy', authority, wal, crashHook: crashStage ? stage => { if (stage === crashStage && !crashed) { crashed = true; throw new Error('controlled crash') } } : undefined })
    let command: HostedTaskMutationCommand = { schemaVersion: 1, kind: 'create_task', commandId: 'command_recovery', idempotencyKey: 'idem:recovery', teamId, expectedSourceGeneration: 'generation_stale', expectedRevision: 'revision_stale', subject: 'Recover me', description: null, status: 'pending', ownerId: null, column: 'todo', order: 0 }
    const request = (): HostedTaskMutationRequest => ({ schemaVersion: 2, exchangeId: `task-request_${'5'.repeat(32)}`, operation: 'task_mutate', ownerBinding: { ownerAuthority: 'owner_authority1', ownerGeneration: 1, ownerSessionId: `owner_session_${'6'.repeat(32)}`, socketIdentity: socketIdentity() }, authority, payload: { command, payloadFingerprint: fingerprintHostedTaskCommand(command) }, ownerProof: '0'.repeat(64) })
    const generationResult = await makeService().mutate(request()); expect(generationResult.kind).toBe('stale_generation')
    if (generationResult.kind !== 'stale_generation') return
    command = { ...command, expectedSourceGeneration: generationResult.currentSourceGeneration }
    const revisionResult = await makeService().mutate(request()); expect(revisionResult.kind).toBe('stale_revision')
    if (revisionResult.kind !== 'stale_revision') return
    command = { ...command, expectedRevision: revisionResult.currentRevision }
    expect((await makeService('after_task_write').mutate(request())).kind).toBe('unavailable')
    const deniedRecovery = new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy',
      authority, wal, denyOwnerLocalWrites: true })
    expect(await deniedRecovery.recover()).toBe(false)
    expect((await deniedRecovery.mutate(request())).kind).toBe('unavailable')
    expect(await makeService().recover()).toBe(true)
    const firstReplay = await makeService().mutate(request()); expect(firstReplay.kind).toBe('idempotent_replay')
    const durableKey = createHash('sha256').update(JSON.stringify({ domain: 'hosted-task-board-idempotency-ledger/v3', teamId, sourceGeneration: command.expectedSourceGeneration, idempotencyKey: command.idempotencyKey })).digest('hex')
    const ledger = JSON.parse(await readFile(join(root, 'teams', 'legacy', 'hosted-task-board-mutation-ledger.v2.json'), 'utf8')) as { entries: Record<string, unknown> }
    expect(Object.keys(ledger.entries)).toEqual([durableKey])
    const committedCommand = command; command = { ...command, subject: 'Fingerprint mismatch' }
    expect(await makeService().mutate(request())).toEqual({ kind: 'conflict', reason: 'idempotency_mismatch', currentSourceGeneration: command.expectedSourceGeneration })
    command = committedCommand

    crashed = false
    command = { ...command, commandId: 'command_terminal', idempotencyKey: 'idem:terminal', expectedRevision: 'revision_stale', subject: 'Terminal crash' }
    const currentRevision = await makeService().mutate(request()); expect(currentRevision.kind).toBe('stale_revision')
    if (currentRevision.kind !== 'stale_revision') return
    command = { ...command, expectedRevision: currentRevision.currentRevision }
    expect((await makeService('before_terminal').mutate(request())).kind).toBe('unavailable')
    expect(await makeService().recover()).toBe(true)
    expect((await makeService().mutate(request())).kind).toBe('idempotent_replay')

    if (firstReplay.kind !== 'idempotent_replay') return
    crashed = false
    command = { schemaVersion: 1, kind: 'update_details', commandId: 'command_detach', idempotencyKey: 'idem:detach', teamId, expectedSourceGeneration: firstReplay.currentSourceGeneration, expectedRevision: 'revision_stale', taskId: firstReplay.receipt.affectedTaskIds[0]!, subject: 'Updated after detach' }
    const detachRevision = await makeService().mutate(request()); if (detachRevision.kind !== 'stale_revision') throw new Error('expected detach revision')
    command = { ...command, expectedRevision: detachRevision.currentRevision }
    expect((await makeService('after_task_detach').mutate(request())).kind).toBe('unavailable')
    expect(await makeService().recover()).toBe(true)
    expect((await makeService().mutate(request())).kind).toBe('idempotent_replay')

    command = { ...command, commandId: 'command_missing', idempotencyKey: 'idem:missing', taskId: `task_${'f'.repeat(32)}`, expectedRevision: 'revision_stale' }
    const missingRevision = await makeService().mutate(request()); if (missingRevision.kind !== 'stale_revision') throw new Error('expected missing revision')
    command = { ...command, expectedRevision: missingRevision.currentRevision }
    expect(await makeService().mutate(request())).toEqual({ kind: 'not_found' })
  })

  test('fails closed when a prepared target is substituted before recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-service-substitution-')); roots.push(root)
    await mkdir(join(root, 'teams', 'legacy'), { recursive: true }); await mkdir(join(root, 'tasks', 'legacy'), { recursive: true })
    const teamId = `team_${'7'.repeat(32)}`; const authority = { actorId: 'actor', deploymentId: 'deployment', bootId: 'boot', restoreGeneration: 1, workspaceId: 'workspace', mountBinding: { mountGeneration: 1, declaredRootHash: 'c'.repeat(64) }, teamId }
    const wal = new HostedTaskMutationWal(join(root, 'teams', 'legacy'), teamId); let crash = true
    const service = (hook = false) => new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy', authority, wal, crashHook: hook ? stage => { if (stage === 'after_task_write' && crash) { crash = false; throw new Error('cut') } } : undefined })
    let command: HostedTaskMutationCommand = { schemaVersion: 1, kind: 'create_task', commandId: 'command_substitute', idempotencyKey: 'idem:substitute', teamId, expectedSourceGeneration: 'generation_stale', expectedRevision: 'revision_stale', subject: 'Subject', description: null, status: 'pending', ownerId: null, column: 'todo', order: 0 }
    const request = (): HostedTaskMutationRequest => ({ schemaVersion: 2, exchangeId: `task-request_${'8'.repeat(32)}`, operation: 'task_mutate', ownerBinding: { ownerAuthority: 'owner_authority1', ownerGeneration: 1, ownerSessionId: `owner_session_${'9'.repeat(32)}`, socketIdentity: socketIdentity() }, authority, payload: { command, payloadFingerprint: fingerprintHostedTaskCommand(command) }, ownerProof: '0'.repeat(64) })
    const generation = await service().mutate(request()); if (generation.kind !== 'stale_generation') throw new Error('expected generation')
    command = { ...command, expectedSourceGeneration: generation.currentSourceGeneration }
    const revision = await service().mutate(request()); if (revision.kind !== 'stale_revision') throw new Error('expected revision')
    command = { ...command, expectedRevision: revision.currentRevision }
    expect((await service(true).mutate(request())).kind).toBe('unavailable')
    await writeFile(join(root, 'teams', 'legacy', 'kanban-state.json'), '{"substituted":true}')
    expect(await service().recover()).toBe(false)
  })

  test('preserves kanban metadata and placement for task-only mutations and applies description tombstones canonically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-service-semantics-')); roots.push(root)
    await mkdir(join(root, 'teams', 'legacy'), { recursive: true }); await mkdir(join(root, 'tasks', 'legacy'), { recursive: true })
    const teamId = `team_${'a'.repeat(32)}`; const authority = authorityFor(teamId); const rawId = '7'; const taskId = publicId(teamId, rawId)
    await writeFile(join(root, 'tasks', 'legacy', `${rawId}.json`), JSON.stringify({ id: rawId, subject: 'Before', description: 'remove me', status: 'pending', blocks: [], blockedBy: [] }, null, 2))
    const originalKanban = JSON.stringify({ teamName: 'display-name', reviewers: ['reviewer'], futureRoot: { keep: true }, tasks: { [rawId]: { column: 'review', movedAt: 'old', futureEntry: 1 } }, columnOrder: { review: [rawId], futureColumn: ['opaque'] } }, null, 2)
    await writeFile(join(root, 'teams', 'legacy', 'kanban-state.json'), originalKanban)
    const service = new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy', authority, wal: new HostedTaskMutationWal(join(root, 'teams', 'legacy'), teamId) })
    const details = await runCommand(service, authority, { schemaVersion: 1, kind: 'update_details', commandId: 'command_details', idempotencyKey: 'details', teamId, expectedSourceGeneration: 'generation_stale', expectedRevision: 'revision_stale', taskId, subject: 'After', description: 'Line one\nLine two' })
    expect(details.result.kind).toBe('committed')
    expect(await readFile(join(root, 'teams', 'legacy', 'kanban-state.json'), 'utf8')).toBe(originalKanban)
    const withNewline = await readFile(join(root, 'tasks', 'legacy', `${rawId}.json`), 'utf8'); expect(withNewline.endsWith('\n')).toBe(true); expect(JSON.parse(withNewline).description).toBe('Line one\nLine two')
    const tombstone = await runCommand(service, authority, { schemaVersion: 1, kind: 'update_details', commandId: 'command_tombstone', idempotencyKey: 'tombstone', teamId, expectedSourceGeneration: details.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId, description: null })
    expect(tombstone.result.kind).toBe('committed')
    const taskText = await readFile(join(root, 'tasks', 'legacy', `${rawId}.json`), 'utf8'); expect(JSON.parse(taskText)).toEqual({ id: rawId, subject: 'After', status: 'pending', blocks: [], blockedBy: [] })
    const status = await runCommand(service, authority, { schemaVersion: 1, kind: 'update_status', commandId: 'command_status', idempotencyKey: 'status', teamId, expectedSourceGeneration: details.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId, status: 'completed' })
    expect(status.result.kind).toBe('committed'); expect(await readFile(join(root, 'teams', 'legacy', 'kanban-state.json'), 'utf8')).toBe(originalKanban)
    const moved = await runCommand(service, authority, { schemaVersion: 1, kind: 'move_task', commandId: 'command_preserve_placement', idempotencyKey: 'preserve-placement', teamId, expectedSourceGeneration: details.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId, column: 'todo', order: 0 })
    expect(moved.result.kind).toBe('committed')
    const movedKanban = JSON.parse(await readFile(join(root, 'teams', 'legacy', 'kanban-state.json'), 'utf8'))
    // Like desktop, todo is the pending status, not a kanban entry; only the target order is written.
    expect(Object.hasOwn(movedKanban.tasks, rawId)).toBe(false)
    expect(JSON.parse(await readFile(join(root, 'tasks', 'legacy', `${rawId}.json`), 'utf8'))).toMatchObject({ status: 'pending', reviewState: 'none' })
    expect(Object.keys(movedKanban.columnOrder).sort()).toEqual(['futureColumn', 'review', 'todo'])
    expect(movedKanban.columnOrder.todo).toEqual([rawId]); expect(movedKanban.columnOrder.review).toEqual([])
  })

  test('a hosted move survives the controller rewriting kanban for an agent task_start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-service-kanban-controller-')); roots.push(root)
    const teamRoot = join(root, 'teams', 'legacy'); const kanbanPath = join(teamRoot, 'kanban-state.json')
    await mkdir(teamRoot, { recursive: true }); await mkdir(join(root, 'tasks', 'legacy'), { recursive: true })
    const teamId = `team_${'d'.repeat(32)}`; const authority = authorityFor(teamId)
    const service = new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy', authority, wal: new HostedTaskMutationWal(teamRoot, teamId) })
    const task = (id: string) => JSON.stringify({ id, subject: id, status: 'pending', blocks: [], blockedBy: [] }, null, 2)
    await writeFile(join(root, 'tasks', 'legacy', 'a.json'), task('a')); await writeFile(join(root, 'tasks', 'legacy', 'b.json'), task('b'))
    const moved = await runCommand(service, authority, { schemaVersion: 1, kind: 'move_task', commandId: 'command_move_done', idempotencyKey: 'move-done', teamId, expectedSourceGeneration: 'generation_stale', expectedRevision: 'revision_stale', taskId: publicId(teamId, 'a'), column: 'done', order: 0 })
    expect(moved.result.kind).toBe('committed')
    expect(JSON.parse(await readFile(join(root, 'tasks', 'legacy', 'a.json'), 'utf8')).status).toBe('completed')

    // An agent task_start on b: the controller sets its status and rewrites kanban through its
    // sanitizeState (agent-teams-controller/src/internal/kanbanStore.js), which keeps only
    // review/approved entries with movedAt and the column order as is.
    await writeFile(join(root, 'tasks', 'legacy', 'b.json'), JSON.stringify({ ...JSON.parse(task('b')), status: 'in_progress' }, null, 2))
    const kanban = JSON.parse(await readFile(kanbanPath, 'utf8'))
    const kept = Object.fromEntries(Object.entries(kanban.tasks as Record<string, { column: string; movedAt?: unknown }>)
      .filter(([, entry]) => (entry.column === 'review' || entry.column === 'approved') && typeof entry.movedAt === 'string'))
    // The controller's column reorder can also leave an id in two columns.
    await writeFile(kanbanPath, JSON.stringify({ teamName: 'legacy', reviewers: [], tasks: kept, columnOrder: { ...kanban.columnOrder, todo: ['a', 'b'] } }))

    // a is still done by its status, and the Owner keeps accepting board writes.
    expect(JSON.parse(await readFile(join(root, 'tasks', 'legacy', 'a.json'), 'utf8')).status).toBe('completed')
    const back = await runCommand(service, authority, { schemaVersion: 1, kind: 'move_task', commandId: 'command_move_back', idempotencyKey: 'move-back', teamId, expectedSourceGeneration: moved.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId: publicId(teamId, 'a'), column: 'in_progress', order: 0 })
    expect(back.result.kind).toBe('committed')
    expect(JSON.parse(await readFile(join(root, 'tasks', 'legacy', 'a.json'), 'utf8')).status).toBe('in_progress')
    const after = JSON.parse(await readFile(kanbanPath, 'utf8'))
    expect(after.tasks).toEqual({}); expect(after.columnOrder.todo).toEqual(['b']); expect(after.columnOrder.done).toEqual([])
    expect(after.columnOrder.in_progress).toEqual(['a', 'b'])
  })

  test('omits null create descriptions, rejects clamped move no-ops, and reorders against actual placement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-service-order-')); roots.push(root)
    await mkdir(join(root, 'teams', 'legacy'), { recursive: true }); await mkdir(join(root, 'tasks', 'legacy'), { recursive: true })
    const teamId = `team_${'b'.repeat(32)}`; const authority = authorityFor(teamId); const service = new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy', authority, wal: new HostedTaskMutationWal(join(root, 'teams', 'legacy'), teamId), now: () => 1 })
    const created = await runCommand(service, authority, { schemaVersion: 1, kind: 'create_task', commandId: 'command_create_null', idempotencyKey: 'create-null', teamId, expectedSourceGeneration: 'generation_stale', expectedRevision: 'revision_stale', subject: 'Created', description: null, status: 'pending', ownerId: null, column: 'todo', order: 999 })
    expect(created.result.kind).toBe('committed'); if (created.result.kind !== 'committed') return
    const createdRawId = `hosted-${createHash('sha256').update(JSON.stringify({ commandId: 'command_create_null' })).digest('hex').slice(0, 40)}`
    const createdText = await readFile(join(root, 'tasks', 'legacy', `${createdRawId}.json`), 'utf8'); expect(createdText.endsWith('\n')).toBe(true); expect(Object.hasOwn(JSON.parse(createdText), 'description')).toBe(false)
    const noOp = await runCommand(service, authority, { schemaVersion: 1, kind: 'move_task', commandId: 'command_move_clamped', idempotencyKey: 'move-clamped', teamId, expectedSourceGeneration: created.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId: created.result.receipt.affectedTaskIds[0]!, column: 'todo', order: 1_000_000 })
    expect(noOp.result.kind).toBe('conflict')
    await writeFile(join(root, 'tasks', 'legacy', 'second.json'), `${JSON.stringify({ id: 'second', subject: 'Second', status: 'pending', blocks: [], blockedBy: [] }, null, 2)}\n`)
    const incomplete = await runCommand(service, authority, { schemaVersion: 1, kind: 'reorder_column', commandId: 'command_reorder_partial', idempotencyKey: 'reorder-partial', teamId, expectedSourceGeneration: created.command.expectedSourceGeneration, expectedRevision: 'revision_stale', column: 'todo', orderedTaskIds: [created.result.receipt.affectedTaskIds[0]!] })
    expect(incomplete.result.kind).toBe('conflict')
  })

  test('excludes malformed task identities and rejects malformed ledger and roster metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-service-strict-')); roots.push(root)
    await mkdir(join(root, 'teams', 'legacy'), { recursive: true }); await mkdir(join(root, 'tasks', 'legacy'), { recursive: true })
    const teamId = `team_${'c'.repeat(32)}`; const authority = authorityFor(teamId)
    await writeFile(join(root, 'tasks', 'legacy', 'wrong.json'), JSON.stringify({ id: 'different', subject: 'Bad', status: 'pending', blocks: [], blockedBy: [] }))
    const service = new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy', authority, wal: new HostedTaskMutationWal(join(root, 'teams', 'legacy'), teamId) })
    const missing = await runCommand(service, authority, { schemaVersion: 1, kind: 'update_details', commandId: 'command_bad_identity', idempotencyKey: 'bad-identity', teamId, expectedSourceGeneration: 'generation_stale', expectedRevision: 'revision_stale', taskId: publicId(teamId, 'different'), subject: 'Nope' })
    expect(missing.result.kind).toBe('not_found')
    await writeFile(join(root, 'teams', 'legacy', 'hosted-task-board-mutation-ledger.v2.json'), JSON.stringify({ schemaVersion: 2, entries: { bad: {} } }))
    expect((await service.mutate(requestFor(authority, { ...missing.command, commandId: 'command_bad_ledger', idempotencyKey: 'bad-ledger' }))).kind).toBe('unsafe_active')
    await rm(join(root, 'teams', 'legacy', 'hosted-task-board-mutation-ledger.v2.json'))
    await writeFile(join(root, 'teams', 'legacy', 'members.meta.json'), JSON.stringify({ version: 2, members: [] }))
    const ownerCreate = await runCommand(service, authority, { schemaVersion: 1, kind: 'create_task', commandId: 'command_bad_roster', idempotencyKey: 'bad-roster', teamId, expectedSourceGeneration: missing.command.expectedSourceGeneration, expectedRevision: 'revision_stale', subject: 'Owner', description: null, status: 'pending', ownerId: `member_${'1'.repeat(32)}`, column: 'todo', order: 0 })
    expect(ownerCreate.result.kind).toBe('unsafe_active')
  })

  test('uses authoritative member v1 metadata, exact immutable identities, and config only when metadata is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-service-roster-')); roots.push(root)
    await mkdir(join(root, 'teams', 'legacy'), { recursive: true }); await mkdir(join(root, 'tasks', 'legacy'), { recursive: true })
    const teamId = `team_${'2'.repeat(32)}`; const authority = authorityFor(teamId); const memberName = 'worker'
    const memberId = `member_${createHash('sha256').update(JSON.stringify({ domain: 'hosted-task-board-member/v1', teamId, rawMemberName: memberName })).digest('hex').slice(0, 32)}`
    const explicitId = `member_${'9'.repeat(32)}`
    await writeFile(join(root, 'teams', 'legacy', 'config.json'), JSON.stringify({ name: 'legacy', members: [{ name: memberName }] }))
    const service = new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy', authority, wal: new HostedTaskMutationWal(join(root, 'teams', 'legacy'), teamId) })
    const created = await runCommand(service, authority, { schemaVersion: 1, kind: 'create_task', commandId: 'command_config_owner', idempotencyKey: 'config-owner', teamId, expectedSourceGeneration: 'generation_stale', expectedRevision: 'revision_stale', subject: 'Owned', description: null, status: 'pending', ownerId: memberId, column: 'todo', order: 0 })
    expect(created.result.kind).toBe('committed'); if (created.result.kind !== 'committed') return
    const createdRawId = `hosted-${createHash('sha256').update(JSON.stringify({ commandId: 'command_config_owner' })).digest('hex').slice(0, 40)}`; const createdPath = join(root, 'tasks', 'legacy', `${createdRawId}.json`)
    expect(JSON.parse(await readFile(createdPath, 'utf8')).owner).toBe(memberName)
    await writeFile(join(root, 'teams', 'legacy', 'members.meta.json'), JSON.stringify({ version: 1, members: [{ name: 'canonical', memberId: explicitId }] }))
    const explicit = await runCommand(service, authority, { schemaVersion: 1, kind: 'update_owner', commandId: 'command_explicit_owner', idempotencyKey: 'explicit-owner', teamId, expectedSourceGeneration: created.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId: created.result.receipt.affectedTaskIds[0]!, ownerId: explicitId })
    expect(explicit.result.kind).toBe('committed'); expect(JSON.parse(await readFile(createdPath, 'utf8')).owner).toBe('canonical')
    await writeFile(join(root, 'teams', 'legacy', 'members.meta.json'), JSON.stringify({ version: 1, members: [] }))
    const ignoredConfig = await runCommand(service, authority, { schemaVersion: 1, kind: 'update_owner', commandId: 'command_ignored_config', idempotencyKey: 'ignored-config', teamId, expectedSourceGeneration: created.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId: created.result.receipt.affectedTaskIds[0]!, ownerId: memberId })
    expect(ignoredConfig.result.kind).toBe('conflict')
    const joinedIdentity = `joined\0${0}`
    const joinedId = `member_${createHash('sha256').update(JSON.stringify({ domain: 'hosted-task-board-member/v1', teamId, rawMemberName: joinedIdentity })).digest('hex').slice(0, 32)}`
    await writeFile(join(root, 'teams', 'legacy', 'members.meta.json'), JSON.stringify({ version: 1, members: [{ name: 'joined', joinedAt: 0 }] }))
    const joined = await runCommand(service, authority, { schemaVersion: 1, kind: 'update_owner', commandId: 'command_joined_owner', idempotencyKey: 'joined-owner', teamId, expectedSourceGeneration: created.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId: created.result.receipt.affectedTaskIds[0]!, ownerId: joinedId })
    expect(joined.result.kind).toBe('committed'); expect(JSON.parse(await readFile(createdPath, 'utf8')).owner).toBe('joined')
    const agentId = `member_${createHash('sha256').update(JSON.stringify({ domain: 'hosted-task-board-member/v1', teamId, rawMemberName: 'agent-immutable' })).digest('hex').slice(0, 32)}`
    await writeFile(join(root, 'teams', 'legacy', 'members.meta.json'), JSON.stringify({ version: 1, members: [{ name: 'agent-backed', agentId: 'agent-immutable' }] }))
    const agent = await runCommand(service, authority, { schemaVersion: 1, kind: 'update_owner', commandId: 'command_agent_owner', idempotencyKey: 'agent-owner', teamId, expectedSourceGeneration: created.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId: created.result.receipt.affectedTaskIds[0]!, ownerId: agentId })
    expect(agent.result.kind).toBe('committed'); expect(JSON.parse(await readFile(createdPath, 'utf8')).owner).toBe('agent-backed')
    await writeFile(join(root, 'teams', 'legacy', 'members.meta.json'), JSON.stringify({ version: 1, members: [{ name: 'canonical', memberId: explicitId, removedAt: 0 }] }))
    const cleared = await runCommand(service, authority, { schemaVersion: 1, kind: 'update_owner', commandId: 'command_clear_owner', idempotencyKey: 'clear-owner', teamId, expectedSourceGeneration: created.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId: created.result.receipt.affectedTaskIds[0]!, ownerId: null })
    expect(cleared.result.kind).toBe('committed'); expect(Object.hasOwn(JSON.parse(await readFile(createdPath, 'utf8')), 'owner')).toBe(false)
    const rejected = await runCommand(service, authority, { schemaVersion: 1, kind: 'update_owner', commandId: 'command_removed_owner', idempotencyKey: 'removed-owner', teamId, expectedSourceGeneration: created.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId: created.result.receipt.affectedTaskIds[0]!, ownerId: explicitId })
    expect(rejected.result.kind).toBe('conflict')
    const replacementId = `member_${createHash('sha256').update(JSON.stringify({ domain: 'hosted-task-board-member/v1', teamId, rawMemberName: `canonical\0${2}` })).digest('hex').slice(0, 32)}`
    await writeFile(join(root, 'teams', 'legacy', 'members.meta.json'), JSON.stringify({ version: 1, members: [{ name: 'canonical', memberId: explicitId, joinedAt: 1, removedAt: 2 }, { name: 'canonical', memberId: replacementId, joinedAt: 2 }] }))
    const replacement = await runCommand(service, authority, { schemaVersion: 1, kind: 'update_owner', commandId: 'command_replacement_owner', idempotencyKey: 'replacement-owner', teamId, expectedSourceGeneration: created.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId: created.result.receipt.affectedTaskIds[0]!, ownerId: replacementId })
    expect(replacement.result.kind).toBe('committed'); expect(JSON.parse(await readFile(createdPath, 'utf8')).owner).toBe('canonical')
    const oldOwner = await runCommand(service, authority, { schemaVersion: 1, kind: 'update_owner', commandId: 'command_old_owner', idempotencyKey: 'old-owner', teamId, expectedSourceGeneration: created.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId: created.result.receipt.affectedTaskIds[0]!, ownerId: explicitId })
    expect(oldOwner.result.kind).toBe('conflict'); expect(JSON.parse(await readFile(createdPath, 'utf8')).owner).toBe('canonical')
  })

  test('assigns tasks by member name so the MCP controller lets that member start them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-service-owner-name-')); roots.push(root)
    await mkdir(join(root, 'teams', 'legacy'), { recursive: true }); await mkdir(join(root, 'tasks', 'legacy'), { recursive: true })
    const teamId = `team_${'5'.repeat(32)}`; const authority = authorityFor(teamId)
    const idFor = (identity: string) => `member_${createHash('sha256').update(JSON.stringify({ domain: 'hosted-task-board-member/v1', teamId, rawMemberName: identity })).digest('hex').slice(0, 32)}`
    await writeFile(join(root, 'teams', 'legacy', 'config.json'), JSON.stringify({ name: 'legacy', members: [
      { name: 'team-lead', agentType: 'team-lead', joinedAt: 1 }, { name: 'worker', joinedAt: 2 },
    ] }))
    const workerId = idFor('worker\u00002'); const leadId = idFor('team-lead\u00001')
    const { isSameTaskMember } = createRequire(import.meta.url)('./fixtures/agentTeamsController/taskOwnership.cjs') as { isSameTaskMember(left: unknown, right: unknown, lead: unknown): boolean }
    const service = new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy', authority, wal: new HostedTaskMutationWal(join(root, 'teams', 'legacy'), teamId) })
    const created = await runCommand(service, authority, { schemaVersion: 1, kind: 'create_task', commandId: 'command_named_owner', idempotencyKey: 'named-owner', teamId, expectedSourceGeneration: 'generation_stale', expectedRevision: 'revision_stale', subject: 'Named', description: null, status: 'pending', ownerId: null, column: 'todo', order: 0 })
    if (created.result.kind !== 'committed') throw new Error('expected committed create')
    const taskId = created.result.receipt.affectedTaskIds[0]!
    const rawId = `hosted-${createHash('sha256').update(JSON.stringify({ commandId: 'command_named_owner' })).digest('hex').slice(0, 40)}`
    const taskPath = join(root, 'tasks', 'legacy', `${rawId}.json`)

    // The browser assigns by memberId; the task file names the member, as on desktop.
    const assigned = await runCommand(service, authority, { schemaVersion: 1, kind: 'update_owner', commandId: 'command_named_assign', idempotencyKey: 'named-assign', teamId, expectedSourceGeneration: created.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId, ownerId: workerId })
    expect(assigned.result.kind).toBe('committed')
    const owner = JSON.parse(await readFile(taskPath, 'utf8')).owner
    expect(owner).toBe('worker')
    expect(isSameTaskMember(owner, 'worker', 'team-lead')).toBe(true)
    expect(isSameTaskMember(owner, 'team-lead', 'team-lead')).toBe(false)
    expect(await service.readTaskForMember({ teamId, taskId, memberId: workerId })).toMatchObject({ ownerId: workerId, task: { owner: 'worker' } })
    expect(await service.readTaskForMember({ teamId, taskId, memberId: leadId })).toBeNull()

    // A document an earlier Owner wrote with the memberId still reads for that member.
    await writeFile(taskPath, JSON.stringify({ ...JSON.parse(await readFile(taskPath, 'utf8')), owner: workerId }))
    expect(await service.readTaskForMember({ teamId, taskId, memberId: workerId })).toMatchObject({ ownerId: workerId })

    const reassigned = await runCommand(service, authority, { schemaVersion: 1, kind: 'update_owner', commandId: 'command_named_lead', idempotencyKey: 'named-lead', teamId, expectedSourceGeneration: created.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId, ownerId: leadId })
    expect(reassigned.result.kind).toBe('committed')
    expect(JSON.parse(await readFile(taskPath, 'utf8')).owner).toBe('team-lead')
    const unknown = await runCommand(service, authority, { schemaVersion: 1, kind: 'update_owner', commandId: 'command_named_unknown', idempotencyKey: 'named-unknown', teamId, expectedSourceGeneration: created.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId, ownerId: `member_${'0'.repeat(32)}` })
    expect(unknown.result.kind).toBe('conflict')
  })

  test('lets the team lead own tasks like any runtime member', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-service-lead-')); roots.push(root)
    await mkdir(join(root, 'teams', 'legacy'), { recursive: true }); await mkdir(join(root, 'tasks', 'legacy'), { recursive: true })
    const teamId = `team_${'3'.repeat(32)}`; const authority = authorityFor(teamId)
    const leadId = `member_${createHash('sha256').update(JSON.stringify({ domain: 'hosted-task-board-member/v1', teamId, rawMemberName: `team-lead\0${5}` })).digest('hex').slice(0, 32)}`
    await writeFile(join(root, 'teams', 'legacy', 'config.json'), JSON.stringify({ name: 'legacy', members: [
      { name: 'team-lead', agentType: 'team-lead', agentId: 'team-lead@legacy', joinedAt: 5 }, { name: 'user', agentType: 'user' },
    ] }))
    const service = new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy', authority, wal: new HostedTaskMutationWal(join(root, 'teams', 'legacy'), teamId) })
    const created = await runCommand(service, authority, { schemaVersion: 1, kind: 'create_task', commandId: 'command_lead_owner', idempotencyKey: 'lead-owner', teamId, expectedSourceGeneration: 'generation_stale', expectedRevision: 'revision_stale', subject: 'Lead task', description: null, status: 'pending', ownerId: leadId, column: 'todo', order: 0 })
    expect(created.result.kind).toBe('committed'); if (created.result.kind !== 'committed') return
    const rawId = `hosted-${createHash('sha256').update(JSON.stringify({ commandId: 'command_lead_owner' })).digest('hex').slice(0, 40)}`
    expect(JSON.parse(await readFile(join(root, 'tasks', 'legacy', `${rawId}.json`), 'utf8')).owner).toBe('team-lead')
  })

  test('persists member-name owners while legacy readers and recovery preserve the exact postimage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-service-owner-compatibility-')); roots.push(root)
    await mkdir(join(root, 'teams', 'legacy'), { recursive: true }); await mkdir(join(root, 'tasks', 'legacy'), { recursive: true })
    const teamId = `team_${'6'.repeat(32)}`; const authority = authorityFor(teamId); const agentId = 'agent-worker'; const memberName = 'worker'
    const memberId = `member_${createHash('sha256').update(JSON.stringify({ domain: 'hosted-task-board-member/v1', teamId, rawMemberName: agentId })).digest('hex').slice(0, 32)}`
    await writeFile(join(root, 'teams', 'legacy', 'config.json'), JSON.stringify({ name: 'legacy', leadAgentId: 'lead', members: [{ name: memberName, agentId }] }))
    await writeFile(join(root, 'teams', 'legacy', 'team.identity.json'), JSON.stringify({ schemaVersion: 1, teamId, createdAt: '2026-01-01T00:00:00.000Z' }))
    const wal = new HostedTaskMutationWal(join(root, 'teams', 'legacy'), teamId); let crash = true
    const crashing = new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy', authority, wal, crashHook: stage => { if (stage === 'after_task_write' && crash) { crash = false; throw new Error('cut') } } })
    const prepared = await runCommand(crashing, authority, { schemaVersion: 1, kind: 'create_task', commandId: 'command_owner_compatibility', idempotencyKey: 'owner-compatibility', teamId, expectedSourceGeneration: 'generation_stale', expectedRevision: 'revision_stale', subject: 'Owned task', description: null, status: 'pending', ownerId: memberId, column: 'todo', order: 0 })
    expect(prepared.result.kind).toBe('unavailable')
    const rawId = `hosted-${createHash('sha256').update(JSON.stringify({ commandId: 'command_owner_compatibility' })).digest('hex').slice(0, 40)}`
    expect(JSON.parse(await readFile(join(root, 'tasks', 'legacy', `${rawId}.json`), 'utf8')).owner).toBe(memberName)
    const scope = { teamId, sourceGeneration: prepared.command.expectedSourceGeneration, idempotencyKey: prepared.command.idempotencyKey }
    const ambiguous = await wal.lookup(scope); expect(ambiguous.kind).toBe('ambiguous'); if (ambiguous.kind !== 'ambiguous') return
    const taskWrite = ambiguous.intent.writes.find(write => write.target === `task:${rawId}.json`); expect(taskWrite).toBeDefined()
    expect(JSON.parse(Buffer.from(taskWrite!.after.contentBase64!, 'base64').toString('utf8')).owner).toBe(memberName)
    const service = new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy', authority, wal })
    expect(await service.recover()).toBe(true)
    const replay = await service.mutate(requestFor(authority, prepared.command)); expect(replay.kind).toBe('idempotent_replay')
    if (replay.kind !== 'idempotent_replay') return
    expect(replay.receipt).toEqual({ ...ambiguous.intent.committedResult.receipt, outcome: 'idempotent_replay' })
    expect(JSON.stringify(replay)).not.toContain(memberName); expect(JSON.stringify(replay)).not.toContain(agentId)
    const terminal = await wal.lookup(scope); expect(terminal.kind).toBe('terminal')
    if (terminal.kind === 'terminal') expect(terminal.result).toEqual(ambiguous.intent.committedResult)

    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = root
    try {
      expect((await getTask('legacy', rawId))?.owner).toBe(memberName)
      expect((await listTasks('legacy')).find(task => task.id === rawId)?.owner).toBe(memberName)
      expect(await getAgentStatuses('legacy')).toEqual([{ agentId, name: memberName, agentType: undefined, status: 'busy', currentTasks: [rawId] }])
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    }
  })

  test('bounds roster files and member counts before owner resolution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-service-roster-bounds-')); roots.push(root)
    await mkdir(join(root, 'teams', 'legacy'), { recursive: true }); await mkdir(join(root, 'tasks', 'legacy'), { recursive: true })
    const teamId = `team_${'8'.repeat(32)}`; const authority = authorityFor(teamId)
    const service = new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy', authority, wal: new HostedTaskMutationWal(join(root, 'teams', 'legacy'), teamId) })
    const command = { schemaVersion: 1 as const, kind: 'create_task' as const, commandId: 'command_roster_budget', idempotencyKey: 'roster-budget', teamId, expectedSourceGeneration: 'generation_stale', expectedRevision: 'revision_stale', subject: 'Bounded', description: null, status: 'pending' as const, ownerId: `member_${'1'.repeat(32)}`, column: 'todo' as const, order: 0 }
    const generation = await service.mutate(requestFor(authority, command)); if (generation.kind !== 'stale_generation') throw new Error('expected generation')
    const withGeneration = { ...command, expectedSourceGeneration: generation.currentSourceGeneration }
    const revision = await service.mutate(requestFor(authority, withGeneration)); if (revision.kind !== 'stale_revision') throw new Error('expected revision')
    await writeFile(join(root, 'teams', 'legacy', 'members.meta.json'), JSON.stringify({ version: 1, members: Array.from({ length: 513 }, (_, index) => ({ name: `worker-${index}`, memberId: `member_${index.toString(16).padStart(32, '0')}` })) }))
    expect((await runCommand(service, authority, { ...withGeneration, expectedRevision: revision.currentRevision })).result.kind).toBe('unsafe_active')
    await writeFile(join(root, 'teams', 'legacy', 'members.meta.json'), `${' '.repeat(256 * 1024)}\n`)
    expect((await runCommand(service, authority, { ...withGeneration, expectedRevision: revision.currentRevision })).result.kind).toBe('unsafe_active')
  })

  test('includes filtered task file bytes in the revision guard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-service-filtered-revision-')); roots.push(root)
    await mkdir(join(root, 'teams', 'legacy'), { recursive: true }); await mkdir(join(root, 'tasks', 'legacy'), { recursive: true })
    const teamId = `team_${'3'.repeat(32)}`; const authority = authorityFor(teamId); const wal = new HostedTaskMutationWal(join(root, 'teams', 'legacy'), teamId); const service = new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy', authority, wal })
    await writeFile(join(root, 'tasks', 'legacy', '_internal-note.json'), JSON.stringify({ id: '_internal-note', subject: 'Internal', status: 'pending', blocks: [], blockedBy: [] }))
    const command: HostedTaskMutationCommand = { schemaVersion: 1, kind: 'create_task', commandId: 'command_revision_filtered', idempotencyKey: 'revision-filtered', teamId, expectedSourceGeneration: 'generation_stale', expectedRevision: 'revision_stale', subject: 'Visible', description: null, status: 'pending', ownerId: null, column: 'todo', order: 0 }
    const generation = await service.mutate(requestFor(authority, command)); if (generation.kind !== 'stale_generation') throw new Error('expected generation')
    const withGeneration = { ...command, expectedSourceGeneration: generation.currentSourceGeneration }
    const revision = await service.mutate(requestFor(authority, withGeneration)); if (revision.kind !== 'stale_revision') throw new Error('expected revision')
    await writeFile(join(root, 'tasks', 'legacy', '_internal-note.json'), JSON.stringify({ id: '_internal-note', subject: 'Changed', status: 'pending', blocks: [], blockedBy: [] }))
    const stale = await service.mutate(requestFor(authority, { ...withGeneration, expectedRevision: revision.currentRevision }))
    expect(stale.kind).toBe('stale_revision'); if (stale.kind === 'stale_revision') expect(stale.currentRevision).not.toBe(revision.currentRevision)
    if (stale.kind !== 'stale_revision') return
    let crashed = false
    const crashing = new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy', authority, wal, crashHook: stage => { if (stage === 'after_task_write' && !crashed) { crashed = true; throw new Error('cut') } } })
    expect((await crashing.mutate(requestFor(authority, { ...withGeneration, expectedRevision: stale.currentRevision }))).kind).toBe('unavailable')
    await writeFile(join(root, 'tasks', 'legacy', '_internal-note.json'), JSON.stringify({ id: '_internal-note', subject: 'Changed again', status: 'pending', blocks: [], blockedBy: [] }))
    expect(await service.recover()).toBe(false)
  })

  test('recovers prepared writes under a fresh boot but rejects stable authority drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-service-fresh-boot-')); roots.push(root)
    await mkdir(join(root, 'teams', 'legacy'), { recursive: true }); await mkdir(join(root, 'tasks', 'legacy'), { recursive: true })
    const teamId = `team_${'f'.repeat(32)}`; const authority = authorityFor(teamId); const wal = new HostedTaskMutationWal(join(root, 'teams', 'legacy'), teamId); let crash = true
    const crashing = new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy', authority, wal, crashHook: stage => { if (stage === 'before_terminal' && crash) { crash = false; throw new Error('cut') } } })
    const prepared = await runCommand(crashing, authority, { schemaVersion: 1, kind: 'create_task', commandId: 'command_fresh_boot', idempotencyKey: 'fresh-boot', teamId, expectedSourceGeneration: 'generation_stale', expectedRevision: 'revision_stale', subject: 'Recover', description: null, status: 'pending', ownerId: null, column: 'todo', order: 0 })
    expect(prepared.result.kind).toBe('unavailable')
    const driftedAuthority = authorityFor(teamId, { actorId: 'actor-2', bootId: 'boot-2', workspaceId: 'other-workspace' })
    expect(await new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy', authority: driftedAuthority, wal }).recover()).toBe(false)
    const freshAuthority = authorityFor(teamId, { actorId: 'actor-2', bootId: 'boot-2' })
    expect(await new HostedTaskMutationService({ claudeRoot: root, legacyKey: 'legacy', authority: freshAuthority, wal }).recover()).toBe(true)
  })
})
