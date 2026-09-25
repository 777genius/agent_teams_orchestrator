import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
    expect(movedKanban.tasks[rawId]).toEqual({ column: 'todo', futureEntry: 1 })
    expect(Object.keys(movedKanban.columnOrder).sort()).toEqual(['approved', 'done', 'futureColumn', 'in_progress', 'review', 'todo'])
    expect(movedKanban.columnOrder.todo).toEqual([rawId]); expect(movedKanban.columnOrder.review).toEqual([])
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
    expect(JSON.parse(await readFile(createdPath, 'utf8')).owner).toBe(memberId)
    await writeFile(join(root, 'teams', 'legacy', 'members.meta.json'), JSON.stringify({ version: 1, members: [{ name: 'canonical', memberId: explicitId }] }))
    const explicit = await runCommand(service, authority, { schemaVersion: 1, kind: 'update_owner', commandId: 'command_explicit_owner', idempotencyKey: 'explicit-owner', teamId, expectedSourceGeneration: created.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId: created.result.receipt.affectedTaskIds[0]!, ownerId: explicitId })
    expect(explicit.result.kind).toBe('committed'); expect(JSON.parse(await readFile(createdPath, 'utf8')).owner).toBe(explicitId)
    await writeFile(join(root, 'teams', 'legacy', 'members.meta.json'), JSON.stringify({ version: 1, members: [] }))
    const ignoredConfig = await runCommand(service, authority, { schemaVersion: 1, kind: 'update_owner', commandId: 'command_ignored_config', idempotencyKey: 'ignored-config', teamId, expectedSourceGeneration: created.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId: created.result.receipt.affectedTaskIds[0]!, ownerId: memberId })
    expect(ignoredConfig.result.kind).toBe('conflict')
    const joinedIdentity = `joined\0${0}`
    const joinedId = `member_${createHash('sha256').update(JSON.stringify({ domain: 'hosted-task-board-member/v1', teamId, rawMemberName: joinedIdentity })).digest('hex').slice(0, 32)}`
    await writeFile(join(root, 'teams', 'legacy', 'members.meta.json'), JSON.stringify({ version: 1, members: [{ name: 'joined', joinedAt: 0 }] }))
    const joined = await runCommand(service, authority, { schemaVersion: 1, kind: 'update_owner', commandId: 'command_joined_owner', idempotencyKey: 'joined-owner', teamId, expectedSourceGeneration: created.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId: created.result.receipt.affectedTaskIds[0]!, ownerId: joinedId })
    expect(joined.result.kind).toBe('committed'); expect(JSON.parse(await readFile(createdPath, 'utf8')).owner).toBe(joinedId)
    const agentId = `member_${createHash('sha256').update(JSON.stringify({ domain: 'hosted-task-board-member/v1', teamId, rawMemberName: 'agent-immutable' })).digest('hex').slice(0, 32)}`
    await writeFile(join(root, 'teams', 'legacy', 'members.meta.json'), JSON.stringify({ version: 1, members: [{ name: 'agent-backed', agentId: 'agent-immutable' }] }))
    const agent = await runCommand(service, authority, { schemaVersion: 1, kind: 'update_owner', commandId: 'command_agent_owner', idempotencyKey: 'agent-owner', teamId, expectedSourceGeneration: created.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId: created.result.receipt.affectedTaskIds[0]!, ownerId: agentId })
    expect(agent.result.kind).toBe('committed'); expect(JSON.parse(await readFile(createdPath, 'utf8')).owner).toBe(agentId)
    await writeFile(join(root, 'teams', 'legacy', 'members.meta.json'), JSON.stringify({ version: 1, members: [{ name: 'canonical', memberId: explicitId, removedAt: 0 }] }))
    const cleared = await runCommand(service, authority, { schemaVersion: 1, kind: 'update_owner', commandId: 'command_clear_owner', idempotencyKey: 'clear-owner', teamId, expectedSourceGeneration: created.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId: created.result.receipt.affectedTaskIds[0]!, ownerId: null })
    expect(cleared.result.kind).toBe('committed'); expect(Object.hasOwn(JSON.parse(await readFile(createdPath, 'utf8')), 'owner')).toBe(false)
    const rejected = await runCommand(service, authority, { schemaVersion: 1, kind: 'update_owner', commandId: 'command_removed_owner', idempotencyKey: 'removed-owner', teamId, expectedSourceGeneration: created.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId: created.result.receipt.affectedTaskIds[0]!, ownerId: explicitId })
    expect(rejected.result.kind).toBe('conflict')
    const replacementId = `member_${createHash('sha256').update(JSON.stringify({ domain: 'hosted-task-board-member/v1', teamId, rawMemberName: `canonical\0${2}` })).digest('hex').slice(0, 32)}`
    await writeFile(join(root, 'teams', 'legacy', 'members.meta.json'), JSON.stringify({ version: 1, members: [{ name: 'canonical', memberId: explicitId, joinedAt: 1, removedAt: 2 }, { name: 'canonical', memberId: replacementId, joinedAt: 2 }] }))
    const replacement = await runCommand(service, authority, { schemaVersion: 1, kind: 'update_owner', commandId: 'command_replacement_owner', idempotencyKey: 'replacement-owner', teamId, expectedSourceGeneration: created.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId: created.result.receipt.affectedTaskIds[0]!, ownerId: replacementId })
    expect(replacement.result.kind).toBe('committed'); expect(JSON.parse(await readFile(createdPath, 'utf8')).owner).toBe(replacementId)
    const oldOwner = await runCommand(service, authority, { schemaVersion: 1, kind: 'update_owner', commandId: 'command_old_owner', idempotencyKey: 'old-owner', teamId, expectedSourceGeneration: created.command.expectedSourceGeneration, expectedRevision: 'revision_stale', taskId: created.result.receipt.affectedTaskIds[0]!, ownerId: explicitId })
    expect(oldOwner.result.kind).toBe('conflict'); expect(JSON.parse(await readFile(createdPath, 'utf8')).owner).toBe(replacementId)
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
    expect(JSON.parse(await readFile(join(root, 'tasks', 'legacy', `${rawId}.json`), 'utf8')).owner).toBe(leadId)
  })

  test('persists immutable member owners while legacy readers and recovery preserve the exact postimage', async () => {
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
    expect(JSON.parse(await readFile(join(root, 'tasks', 'legacy', `${rawId}.json`), 'utf8')).owner).toBe(memberId)
    const scope = { teamId, sourceGeneration: prepared.command.expectedSourceGeneration, idempotencyKey: prepared.command.idempotencyKey }
    const ambiguous = await wal.lookup(scope); expect(ambiguous.kind).toBe('ambiguous'); if (ambiguous.kind !== 'ambiguous') return
    const taskWrite = ambiguous.intent.writes.find(write => write.target === `task:${rawId}.json`); expect(taskWrite).toBeDefined()
    expect(JSON.parse(Buffer.from(taskWrite!.after.contentBase64!, 'base64').toString('utf8')).owner).toBe(memberId)
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
      expect((await getTask('legacy', rawId))?.owner).toBe(memberId)
      expect((await listTasks('legacy')).find(task => task.id === rawId)?.owner).toBe(memberId)
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
